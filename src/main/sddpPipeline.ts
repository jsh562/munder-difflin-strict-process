/**
 * Host-driven SDDP phase pipeline — the engine that RUNS the sub-agents per phase, so the SDDP
 * workflow is deterministic host code rather than "trust a desk LLM to follow a prompt."
 *
 * The feature EPIC card's `milestones[]` is the *program*; this engine is the *interpreter*: for the
 * epic's `active` milestone, if it's host-driven (a single author/transform specialist — research /
 * data-model / contracts / adrs / checklist / tasks), it runs that sub-agent (as the epic's owner
 * desk, for creds/model/feature-scope), gates on the real artifact, advances the milestone, and the
 * advance re-triggers the engine to chain to the next step. Desk/human steps (spec / clarify / plan /
 * implement / qc) are left to the existing notifier pings — the engine waits at them.
 *
 * All host concerns are injected (`SddpPipelineDeps`) so this is electron-free + unit-testable with
 * fakes. Guards: a per-feature+step in-flight lock (no double-run), a debounced `schedule`, and a
 * de-duped escalation when there's no usable owner desk or a step's artifact never lands. Never
 * throws into the caller (the hive write path is fire-and-forget into `schedule`).
 */
import { milestoneDriver, templateForStep, type HiveTask, type FeatureMilestone } from '@jsh562/won-agent-core';

export interface SddpPipelineDeps {
  /** Is the floor in SDDP mode? (read live) — the engine is inert when off. */
  enabled(): boolean;
  /** SDDP autopilot (read live): when ON, human-gated steps (Clarify) auto-resolve instead of
   *  pausing for the operator. See the Human-Gates Registry. */
  autopilot(): boolean;
  /** The current task ledger (the engine finds the feature epic card in it). */
  listTasks(): HiveTask[];
  /** The repo a feature's artifacts live under (`epic.project` ?? the owner's repo). */
  repoForEpic(epic: HiveTask): string | null;
  /** Can the host run sub-agents AS this desk? (a spawned native desk: non-anthropic provider + a
   *  recorded model). If not, the engine can't run the phase specialists → it escalates. */
  ownerUsable(ownerId: string): boolean;
  /** Does the step's gate artifact exist under `<repo>/specs/<feature>/`? */
  featureArtifactExists(repo: string | null, feature: string, relPath: string): boolean;
  /** Run a sub-agent ONCE as `callerId` (the one-shot runtime). Returns its final text. */
  spawnSubAgent(callerId: string, name: string, input: string): Promise<{ content: string; success: boolean }>;
  /** Advance the epic's milestone checklist (mark `key` done + activate next) via the hive. */
  advanceMilestone(epicId: string, key: string): void;
  /** Seed the implement cards for a feature from its `tasks.md` (parse → one feature-tagged card
   *  per task). Returns the count created (0 ⇒ no tasks). The host owns the parse + card creation;
   *  the engine calls this once when the implement step starts so the work exists deterministically. */
  seedImplementCards(epic: HiveTask): number;
  /** Surface a blocker to the god/operator (no usable owner, or a step's artifact never landed). */
  escalate(feature: string, message: string): void;
  /** Relay a human-gated step's prompt to the operator (e.g. Clarify questions) — `needs_human`.
   *  Distinct from `escalate` (which is for blockers). */
  askHuman(feature: string, questions: string): void;
  /** Optional diagnostic log. */
  log?(message: string): void;
  /** Debounce window for `schedule` (ms); default 1500. */
  debounceMs?: number;
}

/** Build the input handed to a host step's sub-agent — the deterministic `specs/<feature>/…` paths
 *  each specialist prompt expects, PLUS the step's structure template (when it has one — the engine
 *  supplies templates as data rather than baking them into prompts). `ctx.request` carries the
 *  feature request for the `spec` step. */
export function buildStepInput(key: string, feature: string, ctx?: { request?: string }): string {
  const dir = `specs/${feature}`;
  let task: string;
  switch (key) {
    case 'spec':
      task = `Feature folder ${dir}/. Draft ${dir}/spec.md for this FEATURE REQUEST: "${(ctx?.request ?? '').trim() || '(see the epic card)'}". Mark genuine unknowns [NEEDS CLARIFICATION: <question>].`;
      break;
    case 'clarify':
      task = `Feature folder ${dir}/. Read ${dir}/spec.md and return the highest-impact clarification questions (its [NEEDS CLARIFICATION] markers + any material gaps), ranked.`;
      break;
    case 'research':
      task = `Feature folder ${dir}/. Read ${dir}/spec.md. Research the open technical questions and write ${dir}/research.md.`;
      break;
    case 'data-model':
      task = `Feature folder ${dir}/. Read ${dir}/spec.md (and ${dir}/research.md if present). Design the data model and write ${dir}/data-model.md.`;
      break;
    case 'contracts':
      task = `Feature folder ${dir}/. Read ${dir}/spec.md and ${dir}/data-model.md if present. Generate the API contract under ${dir}/contracts/.`;
      break;
    case 'adrs':
      task = `Feature folder ${dir}/. Read ${dir}/spec.md and the design so far. Record any significant architecture decisions under ${dir}/adrs/.`;
      break;
    case 'plan':
      task = `Feature folder ${dir}/. Read ${dir}/spec.md and the design artifacts (${dir}/data-model.md, ${dir}/contracts/, ${dir}/adrs/, ${dir}/research.md) as available. Assemble ${dir}/plan.md.`;
      break;
    case 'checklist':
      task = `Feature folder ${dir}/. Read ${dir}/spec.md and ${dir}/plan.md. Generate a quality checklist under ${dir}/checklists/.`;
      break;
    case 'tasks':
      task = `Feature folder ${dir}/. Read ${dir}/spec.md and ${dir}/plan.md. Generate the implement task list and write ${dir}/tasks.md.`;
      break;
    default:
      task = `Feature folder ${dir}/.`;
  }
  const template = templateForStep(key);
  return template ? `${task}\n\nAuthor into THIS structure (fill each section; replace inapplicable sections with "N/A — <reason>"):\n${template}` : task;
}

export class SddpPipeline {
  private readonly debounce = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inflight = new Set<string>();   // `${feature}::${key}` currently running
  private readonly escalated = new Set<string>();  // features already escalated (dedupe)
  private readonly asked = new Set<string>();      // human-gated steps already relayed to the operator

  constructor(private readonly deps: SddpPipelineDeps) {}

  /** Debounced entry the hive calls on every board change for a feature. */
  schedule(repo: string | null, feature: string): void {
    if (!this.deps.enabled()) return;
    const key = `${repo ?? ''}::${feature}`;
    const prior = this.debounce.get(key);
    if (prior) clearTimeout(prior);
    const ms = this.deps.debounceMs ?? 1500;
    this.debounce.set(key, setTimeout(() => {
      this.debounce.delete(key);
      void this.advanceFeature(repo, feature);
    }, ms));
  }

  /** Drive the feature's active host milestone one notch (run its sub-agent → gate → advance).
   *  Public so tests can await it deterministically (bypassing the debounce). Never throws. */
  async advanceFeature(repo: string | null, feature: string): Promise<void> {
    if (!this.deps.enabled()) return;
    try {
      const epic = this.deps.listTasks().find(
        (t) => t.feature === feature && Array.isArray(t.milestones) && t.milestones.length > 0
      );
      if (!epic || !epic.milestones) return;
      const r = this.deps.repoForEpic(epic);

      const ownerId = epic.assignee;
      if (!ownerId || !this.deps.ownerUsable(ownerId)) {
        this.escalateOnce(feature, `SDDP pipeline can't run feature '${feature}': its epic card (${epic.id}) has no usable native owner desk. Assign it to a SPAWNED DeepSeek (non-Claude) desk with a model, so the host can run the phase specialists as it.`);
        return;
      }

      const active = epic.milestones.find((m) => m.status === 'active');
      if (!active) return;                                  // all done / none active

      // HUMAN-GATED step (Clarify): a registry gate the operator can flip via `sddpAutopilot`.
      if (active.humanGated && active.subAgent) {
        await this.runHumanGated(epic, active, ownerId);
        return;
      }

      if (milestoneDriver(active) !== 'host' || !active.subAgent) {
        // DESK/DISTRIBUTED step (implement/qc): the engine FEEDS (seeds implement cards) + TRACKS
        // (advances the pill when the distributed flow's marker lands) — it does not run the work.
        this.trackDistributed(epic, active, r);
        return;
      }

      const lockKey = `${feature}::${active.key}`;
      if (this.inflight.has(lockKey)) return;               // already running this step

      // Artifact already present (authored out-of-band, or a re-trigger after we advanced) → advance.
      if (this.deps.featureArtifactExists(r, feature, active.gateArtifact)) {
        this.deps.advanceMilestone(epic.id, active.key);
        return;
      }

      this.inflight.add(lockKey);
      try {
        const input = buildStepInput(active.key, feature, { request: epic.description ?? epic.title });
        const res = await this.deps.spawnSubAgent(ownerId, active.subAgent, input);
        if (this.deps.featureArtifactExists(r, feature, active.gateArtifact)) {
          this.escalated.delete(feature);                   // made progress — clear any stale escalation
          this.deps.advanceMilestone(epic.id, active.key);  // re-triggers the engine → chains to next step
        } else if (active.optional) {
          this.deps.advanceMilestone(epic.id, active.key);  // optional + nothing produced → N/A, skip on
        } else {
          this.escalateOnce(feature, `SDDP pipeline: ran '${active.subAgent}' for feature '${feature}' but specs/${feature}/${active.gateArtifact} did not appear.${res.success ? '' : ` Sub-agent error: ${res.content}`} Check the owner desk's provider/key, or produce that artifact manually.`);
        }
      } finally {
        this.inflight.delete(lockKey);
      }
    } catch (e) {
      this.deps.log?.(`[sddp-pipeline] advanceFeature(${feature}) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Run a HUMAN-GATED milestone (Clarify). Under autopilot: `spec-author` resolves the
   *  clarifications with documented defaults + advance (no human). Otherwise: run the gate's
   *  sub-agent (`requirements-scanner`) ONCE for the questions, relay them to the operator, and
   *  WAIT — the operator answers + advances the milestone, which re-triggers the chain. */
  private async runHumanGated(epic: HiveTask, active: FeatureMilestone, ownerId: string): Promise<void> {
    const feature = epic.feature!;
    const lockKey = `${feature}::${active.key}`;
    if (this.inflight.has(lockKey)) return;

    if (this.deps.autopilot()) {
      this.inflight.add(lockKey);
      try {
        await this.deps.spawnSubAgent(ownerId, 'spec-author',
          `Feature folder specs/${feature}/. Read specs/${feature}/spec.md, RESOLVE each [NEEDS CLARIFICATION] with a reasonable default, and add a ## Clarifications section documenting each assumption (what + why). Rewrite specs/${feature}/spec.md.`);
        this.deps.advanceMilestone(epic.id, active.key); // optional + best-effort → advance regardless
      } finally {
        this.inflight.delete(lockKey);
      }
      return;
    }

    // Human-gated (default): relay the questions ONCE + wait for the operator to answer + advance.
    if (this.asked.has(lockKey)) return;
    this.inflight.add(lockKey);
    try {
      const res = await this.deps.spawnSubAgent(ownerId, active.subAgent!, buildStepInput(active.key, feature));
      this.asked.add(lockKey);
      this.deps.askHuman(feature, res.content);
    } finally {
      this.inflight.delete(lockKey);
    }
  }

  /** FEED + TRACK a distributed step (implement/qc). The engine does not run the work — workers /
   *  the qc desk / the integrator do (the existing notifier flow). It (1) seeds the implement cards
   *  from tasks.md once, so the work exists deterministically, and (2) advances the milestone pill
   *  when the distributed flow's real marker (`.completed` / `.qc-passed`) appears. */
  private trackDistributed(epic: HiveTask, active: FeatureMilestone, repo: string | null): void {
    const feature = epic.feature!;
    const markerPresent = !!active.gateArtifact && this.deps.featureArtifactExists(repo, feature, active.gateArtifact);

    if (active.key === 'implement' && !markerPresent) {
      const hasCards = this.deps.listTasks().some(
        (t) => t.feature === feature && t.id !== epic.id && !(t.milestones && t.milestones.length)
      );
      if (!hasCards) {
        const n = this.deps.seedImplementCards(epic);
        if (n === 0) this.escalateOnce(feature, `SDDP pipeline: implement step for '${feature}' but specs/${feature}/tasks.md has no tasks to import.`);
      }
      // else: cards exist + still being worked — wait for the distributed flow.
    }

    // Pill tracking: advance when the distributed flow produced this step's marker.
    if (markerPresent) {
      this.escalated.delete(feature);
      this.deps.advanceMilestone(epic.id, active.key);
    }
  }

  private escalateOnce(feature: string, message: string): void {
    if (this.escalated.has(feature)) return;
    this.escalated.add(feature);
    try { this.deps.escalate(feature, message); } catch { /* best-effort */ }
  }
}
