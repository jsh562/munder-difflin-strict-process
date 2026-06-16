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

/** What the engine is doing for a feature's active step (the per-step monitor surfaced to the UI). */
export type StepState = 'running' | 'waiting' | 'paused' | 'stopped' | 'manual' | 'blocked' | 'done';
export interface FeatureEngineStatus {
  /** The active milestone key, or null when the pipeline is complete. */
  step: string | null;
  state: StepState;
  /** Optional detail (e.g. the blocker/escalation reason). */
  message?: string;
}

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
  /** Run a sub-agent ONCE as `callerId` (the one-shot runtime). Returns its final text. The optional
   *  `signal` lets the engine ABORT an in-flight run (operator `stopped` a step). */
  spawnSubAgent(callerId: string, name: string, input: string, signal?: AbortSignal): Promise<{ content: string; success: boolean }>;
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
  /** Find a usable native desk holding `role` (planner/worker) to assign work to, or null. (P5b) */
  findDeskForRole?(role: string): string | null;
  /** Assign a card to a desk (writeTasks the assignee). (P5b — epic→planner, implement→workers.) */
  assignCard?(cardId: string, deskId: string): void;
  /** ANALYZE mechanical coverage: requirement ids in spec.md with NO task in tasks.md (CRITICAL). The
   *  host reads the files; the pure check lives in `analyzeCoverage` (won-agent-core). */
  analyzeFeature?(repo: string | null, feature: string): { uncovered: string[] };
  /** Read a `specs/<feature>/` text artifact (e.g. the analysis report), or null when absent. */
  featureArtifactText?(repo: string | null, feature: string, relPath: string): string | null;
  /** Write a `specs/<feature>/` text artifact (the engine authors `analysis-report.md` from the
   *  mechanical findings + the validators' output). */
  writeFeatureArtifact?(repo: string | null, feature: string, relPath: string, content: string): void;
  /** Checklist completion (mechanical): `{ total, checked }` across `specs/<feature>/checklists/*.md`
   *  (`- [ ]` vs `- [X]`). `total === 0` ⇒ no checklists ⇒ the gate is N/A. (P2 checklist gate.) */
  checklistStatus?(repo: string | null, feature: string): { total: number; checked: number };
  /** HOST-DRIVEN QC (P4). Provision a throwaway QC-integration worktree: merge the feature's implement
   *  branches into a detached tree off trunk so the suite runs on the INTEGRATED code (resolves the
   *  `.qc-passed`↔integrate deadlock). Returns the tree `path` (for the QC sub-agents' cwd) + any
   *  `conflicts` (branches the host couldn't merge → route back to authors). */
  prepareQcTree?(epic: HiveTask): Promise<{ ok: boolean; path: string | null; conflicts: string[] }>;
  /** Tear down a QC tree provisioned by `prepareQcTree`. */
  removeQcTree?(path: string): void;
  /** Run a sub-agent ONCE as `callerId` but with its tools resolving cwd to `treePath` (the QC tree).
   *  Like `spawnSubAgent` + a cwd override — so qc-auditor/story-verifier act on the merged code. */
  spawnSubAgentInTree?(callerId: string, name: string, input: string, treePath: string, signal?: AbortSignal): Promise<{ content: string; success: boolean }>;
  /** SDDP policy knobs (`config.sddpConfig`, with defaults) — QC strictness + the bug-loop iteration cap. */
  sddpPolicy?(): { qcStrictness: 'minimal' | 'standard' | 'strict'; coverageTarget?: number; maxQcIterations: number };
  /** Seed bug-task cards from a failed QC report (P5), round-robin to workers, feature-tagged with the
   *  `[BUG:severity]` grammar. `attempt` drives the escalation tag (≥3 ⇒ `[ESCALATED]`,
   *  ≥maxQcIterations ⇒ `[DEFERRED]`). Always creates ≥1 card on a FAIL. Returns the count. */
  seedBugCards?(epic: HiveTask, report: string, attempt: number): number;
  /** Count of OPEN (not-done) bug cards for the feature (title carries `[BUG`). The QC loop WAITS while
   *  any are open (workers are fixing them) and only re-runs QC once they're all closed. (P5.) */
  openBugCards?(epic: HiveTask): number;
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
  private readonly aborters = new Map<string, AbortController>(); // `${feature}::${key}` → abort handle
  private readonly status = new Map<string, FeatureEngineStatus>(); // feature → engine status (monitor)
  private readonly qcAttempts = new Map<string, number>();         // feature → QC fail count (bug loop, P5)

  constructor(private readonly deps: SddpPipelineDeps) {}

  /** The engine's current status for a feature (for the UI monitor), or null if untracked. */
  statusFor(feature: string): FeatureEngineStatus | null {
    return this.status.get(feature) ?? null;
  }
  /** All per-feature engine statuses (for the `pipeline:status` IPC). */
  statusAll(): Record<string, FeatureEngineStatus> {
    return Object.fromEntries(this.status);
  }
  private setStatus(feature: string, step: string | null, state: StepState, message?: string): void {
    this.status.set(feature, { step, state, ...(message ? { message } : {}) });
  }
  /** Abort an in-flight sub-agent run for a step (operator `stopped` it). */
  private abortStep(feature: string, key: string): void {
    const ac = this.aborters.get(`${feature}::${key}`);
    if (ac) { try { ac.abort(); } catch { /* already gone */ } }
  }

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
      if (!epic || !epic.milestones) { this.status.delete(feature); return; }
      const r = this.deps.repoForEpic(epic);

      const active = epic.milestones.find((m) => m.status === 'active');
      if (!active) { this.setStatus(feature, null, 'done'); return; } // pipeline complete

      // PER-STEP OPERATOR CONTROL (read first — before any owner resolution / run). The operator
      // sets this on the board pill (rides tasks.json). `paused`/`stopped`/`manual` short-circuit.
      const control = active.control ?? 'auto';
      if (control === 'paused') { this.setStatus(feature, active.key, 'paused'); return; }
      if (control === 'stopped') { this.abortStep(feature, active.key); this.setStatus(feature, active.key, 'stopped'); return; }
      if (control === 'manual') {
        // Switched to manual: the engine doesn't run it — a desk/human authors the artifact; the
        // engine just advances when it appears (like a tracked desk step).
        this.setStatus(feature, active.key, 'manual');
        if (active.gateArtifact && this.deps.featureArtifactExists(r, feature, active.gateArtifact)) {
          this.deps.advanceMilestone(epic.id, active.key);
        }
        return;
      }

      // — control === 'auto' —
      // HUMAN-GATED step (Clarify): a registry gate the operator can flip via `sddpAutopilot`.
      if (active.humanGated && active.subAgent) {
        const ownerId = this.resolveOwner(epic, feature, active.key);
        if (ownerId) await this.runHumanGated(epic, active, ownerId);
        return;
      }

      // ANALYZE step: a host-run MULTI-agent path (mechanical coverage in code + policy-auditor +
      // spec-validator), gated on CRITICAL findings. Special-cased like Clarify (no single subAgent).
      if (active.key === 'analyze') {
        const ownerId = this.resolveOwner(epic, feature, active.key);
        if (ownerId) await this.runAnalyze(epic, active, ownerId);
        return;
      }

      // QC step: host-driven (P4) when the QC-tree deps are wired — the engine builds a QC-integration
      // worktree + runs qc-auditor/story-verifier itself. Falls back to feed-track (trackDistributed,
      // the qc-desk notifier flow) when the deps are absent.
      if (active.key === 'qc' && this.deps.prepareQcTree && this.deps.spawnSubAgentInTree) {
        const ownerId = this.resolveOwner(epic, feature, active.key);
        if (ownerId) await this.runQc(epic, active, ownerId);
        return;
      }

      if (milestoneDriver(active) !== 'host' || !active.subAgent) {
        // DESK/DISTRIBUTED step (implement/qc): the engine FEEDS (seeds implement cards) + TRACKS
        // (advances the pill when the distributed flow's marker lands) — it does not run the work.
        await this.trackDistributed(epic, active, r);
        return;
      }

      // HOST-DRIVEN author step — needs a usable owner desk to run the specialist as.
      const ownerId = this.resolveOwner(epic, feature, active.key);
      if (!ownerId) return;

      const lockKey = `${feature}::${active.key}`;
      if (this.inflight.has(lockKey)) return;               // already running this step

      // Artifact already present (authored out-of-band, or a re-trigger after we advanced) → advance.
      if (this.deps.featureArtifactExists(r, feature, active.gateArtifact)) {
        this.deps.advanceMilestone(epic.id, active.key);
        return;
      }

      this.inflight.add(lockKey);
      const ac = new AbortController();
      this.aborters.set(lockKey, ac);
      this.setStatus(feature, active.key, 'running');
      try {
        const input = buildStepInput(active.key, feature, { request: epic.description ?? epic.title });
        const res = await this.deps.spawnSubAgent(ownerId, active.subAgent, input, ac.signal);
        if (this.deps.featureArtifactExists(r, feature, active.gateArtifact)) {
          this.escalated.delete(feature);                   // made progress — clear any stale escalation
          this.deps.advanceMilestone(epic.id, active.key);  // re-triggers the engine → chains to next step
        } else if (ac.signal.aborted) {
          this.setStatus(feature, active.key, 'stopped');   // operator aborted mid-run
        } else if (active.optional) {
          this.deps.advanceMilestone(epic.id, active.key);  // optional + nothing produced → N/A, skip on
        } else {
          this.setStatus(feature, active.key, 'blocked', `${active.subAgent} produced no ${active.gateArtifact}`);
          this.escalateOnce(feature, `SDDP pipeline: ran '${active.subAgent}' for feature '${feature}' but specs/${feature}/${active.gateArtifact} did not appear.${res.success ? '' : ` Sub-agent error: ${res.content}`} Check the owner desk's provider/key, or produce that artifact manually.`);
        }
      } finally {
        this.inflight.delete(lockKey);
        this.aborters.delete(lockKey);
      }
    } catch (e) {
      this.deps.log?.(`[sddp-pipeline] advanceFeature(${feature}) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Resolve a usable native owner desk to run the feature's specialists AS (the epic's assignee).
   *  Returns null + escalates when there's none. (P5b extends this to AUTO-ASSIGN an available
   *  planner desk before giving up.) */
  private resolveOwner(epic: HiveTask, feature: string, stepKey: string): string | null {
    const ownerId = epic.assignee;
    if (ownerId && this.deps.ownerUsable(ownerId)) return ownerId;
    // P5b: auto-assign an available planner desk here before escalating.
    const planner = this.deps.findDeskForRole?.('planner') ?? null;
    if (planner && this.deps.assignCard) {
      this.deps.assignCard(epic.id, planner); // re-triggers the engine; next pass has a usable owner
      this.setStatus(feature, stepKey, 'waiting', `assigned to ${planner}`);
      return null;
    }
    this.setStatus(feature, stepKey, 'blocked', 'no usable native owner desk');
    this.escalateOnce(feature, `SDDP pipeline can't run feature '${feature}': its epic card (${epic.id}) has no usable native owner desk. Assign it to a SPAWNED DeepSeek (non-Claude) desk with a model, so the host can run the phase specialists as it.`);
    return null;
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
    if (this.asked.has(lockKey)) { this.setStatus(feature, active.key, 'waiting', 'awaiting clarification answers'); return; }
    this.inflight.add(lockKey);
    try {
      const res = await this.deps.spawnSubAgent(ownerId, active.subAgent!, buildStepInput(active.key, feature));
      this.asked.add(lockKey);
      this.deps.askHuman(feature, res.content);
      this.setStatus(feature, active.key, 'waiting', 'awaiting clarification answers');
    } finally {
      this.inflight.delete(lockKey);
    }
  }

  /** Run the ANALYZE milestone (host-driven, multi-agent). The MECHANICAL half (requirement→task
   *  coverage) is computed in code; the JUDGMENT half (policy compliance vs project-instructions.md,
   *  spec quality) is the `policy-auditor` + `spec-validator` sub-agents. The engine assembles
   *  `analysis-report.md` (frontmatter `critical: <n>`) and GATES: any CRITICAL (an uncovered
   *  requirement, or a policy FAIL) holds + escalates unless autopilot; else it advances. Re-run by
   *  deleting the report (or flipping the step to manual). */
  private async runAnalyze(epic: HiveTask, active: FeatureMilestone, ownerId: string): Promise<void> {
    const feature = epic.feature!;
    const repo = this.deps.repoForEpic(epic);
    const lockKey = `${feature}::${active.key}`;
    if (this.inflight.has(lockKey)) return;

    // If a report already exists, gate on its frontmatter `critical:` (don't re-spawn — re-run by
    // deleting the report). Otherwise produce one.
    const existing = this.deps.featureArtifactText?.(repo, feature, 'analysis-report.md') ?? null;
    if (existing !== null) { this.gateOnAnalysis(epic, active, existing); return; }

    this.inflight.add(lockKey);
    const ac = new AbortController();
    this.aborters.set(lockKey, ac);
    this.setStatus(feature, active.key, 'running');
    try {
      // (1) mechanical coverage (code, no LLM).
      const uncovered = this.deps.analyzeFeature?.(repo, feature).uncovered ?? [];
      // (2) judgment (the registered validators the engine now actually runs).
      const dir = `specs/${feature}`;
      const policy = await this.deps.spawnSubAgent(ownerId, 'policy-auditor',
        `Feature folder ${dir}/. Audit ${dir}/spec.md + ${dir}/plan.md against project-instructions.md. Return a verdict line "VERDICT: PASS" or "VERDICT: FAIL" then the violations.`, ac.signal);
      if (ac.signal.aborted) { this.setStatus(feature, active.key, 'stopped'); return; }
      const spec = await this.deps.spawnSubAgent(ownerId, 'spec-validator',
        `Feature folder ${dir}/. Score ${dir}/spec.md for quality/readiness. Return a verdict line "VERDICT: PASS" or "VERDICT: FAIL" then the findings.`, ac.signal);
      if (ac.signal.aborted) { this.setStatus(feature, active.key, 'stopped'); return; }

      const policyFail = /VERDICT:\s*FAIL/i.test(policy.content);
      const critical = uncovered.length + (policyFail ? 1 : 0);
      const report = this.renderAnalysis(critical, uncovered, policy.content, spec.content);
      this.deps.writeFeatureArtifact?.(repo, feature, 'analysis-report.md', report);
      this.gateOnAnalysis(epic, active, report);
    } finally {
      this.inflight.delete(lockKey);
      this.aborters.delete(lockKey);
    }
  }

  /** Assemble the analysis-report.md body from the mechanical + judgment findings. */
  private renderAnalysis(critical: number, uncovered: string[], policy: string, spec: string): string {
    const coverage = uncovered.length
      ? uncovered.map((r) => `| cov-${r} | coverage | CRITICAL | tasks.md | requirement ${r} has no task | add a task carrying ${r} |`).join('\n')
      : '| — | coverage | — | — | every requirement maps to a task | — |';
    return `---\ncritical: ${critical}\n---\n# Analysis Report\n\n## Coverage (mechanical)\n| ID | Category | Severity | Location | Summary | Recommendation |\n|----|----------|----------|----------|---------|----------------|\n${coverage}\n\n## Policy (project-instructions.md)\n${policy.trim() || '(no output)'}\n\n## Spec quality\n${spec.trim() || '(no output)'}\n`;
  }

  /** GATE on a (possibly pre-existing) analysis report: read its `critical:` frontmatter; >0 holds +
   *  escalates (unless autopilot, which advances with a note); 0 advances. */
  private gateOnAnalysis(epic: HiveTask, active: FeatureMilestone, report: string): void {
    const feature = epic.feature!;
    const m = report.match(/^\s*critical:\s*(\d+)/im);
    const critical = m ? parseInt(m[1], 10) : 0;
    if (critical > 0 && !this.deps.autopilot()) {
      this.setStatus(feature, active.key, 'blocked', `${critical} CRITICAL finding(s) in analysis-report.md`);
      this.escalateOnce(feature, `SDDP Analyze: ${critical} CRITICAL finding(s) for '${feature}' (see specs/${feature}/analysis-report.md — e.g. requirements with no task). Resolve them, then delete the report to re-analyze (or set Analyze to manual to skip).`);
      return;
    }
    this.escalated.delete(feature);
    this.deps.advanceMilestone(epic.id, active.key);
  }

  /** FEED + TRACK a distributed step (implement/qc). The engine does not run the work — workers /
   *  the qc desk / the integrator do (the existing notifier flow). It (1) seeds the implement cards
   *  from tasks.md once, so the work exists deterministically, and (2) advances the milestone pill
   *  when the distributed flow's real marker (`.completed` / `.qc-passed`) appears. */
  private async trackDistributed(epic: HiveTask, active: FeatureMilestone, repo: string | null): Promise<void> {
    const feature = epic.feature!;
    const markerPresent = !!active.gateArtifact && this.deps.featureArtifactExists(repo, feature, active.gateArtifact);

    if (active.key === 'implement' && !markerPresent) {
      // CHECKLIST-COMPLETION GATE (sddp27 / AGENTS.md): if checklists/ exists, all items must be
      // checked before Implement. Mechanical scan in code; one auto-resolve pass via test-evaluator;
      // then block (unless autopilot) until complete. No checklists ⇒ N/A.
      if (!(await this.checklistGate(epic, repo))) return; // held — don't seed/implement yet

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
    } else {
      this.setStatus(feature, active.key, 'waiting', active.key === 'implement' ? 'workers implementing' : 'awaiting QC');
    }
  }

  /** HOST-DRIVEN QC (P4). Builds a QC-integration worktree (merge the feature's implement branches off
   *  trunk), runs `qc-auditor` (build/lint/tests per strictness) + `story-verifier` (SC-###/US# vs the
   *  merged code) IN that tree, then gates: both PASS ⇒ the engine writes `.qc-passed` + advances (the
   *  hive integrate gate unblocks); a merge conflict or a FAIL ⇒ hold + escalate (P5 files bug cards +
   *  loops). The QC sub-agents' `qc-report.md` still lands in the SHARED specs/ (specs anchor to the
   *  base repo, not the tree). Idempotent: if `.qc-passed` already exists, just advance. */
  private async runQc(epic: HiveTask, active: FeatureMilestone, ownerId: string): Promise<void> {
    const feature = epic.feature!;
    const repo = this.deps.repoForEpic(epic);
    if (this.deps.featureArtifactExists(repo, feature, '.qc-passed')) { this.deps.advanceMilestone(epic.id, active.key); return; }
    const lockKey = `${feature}::qc`;
    if (this.inflight.has(lockKey)) return;

    // BUG LOOP (P5): if a prior QC run filed bug cards that are still open, WAIT for the workers to
    // close them before re-running QC — so a FAIL doesn't re-run the whole suite on every board tick.
    const openBugs = this.deps.openBugCards?.(epic) ?? 0;
    if (openBugs > 0) { this.setStatus(feature, 'qc', 'waiting', `awaiting ${openBugs} bug fix(es)`); return; }

    this.inflight.add(lockKey);
    const ac = new AbortController();
    this.aborters.set(lockKey, ac);
    this.setStatus(feature, 'qc', 'running', 'preparing QC tree');
    let treePath: string | null = null;
    try {
      const tree = await this.deps.prepareQcTree!(epic);
      treePath = tree.path;
      if (!tree.ok || !tree.path) {
        this.setStatus(feature, 'qc', 'blocked', 'could not prepare QC tree');
        this.escalateOnce(feature, `SDDP QC: couldn't build the integration tree for '${feature}' (no implement branches? a git error?). Check the worker branches.`);
        return;
      }
      if (tree.conflicts.length > 0) {
        this.setStatus(feature, 'qc', 'blocked', `merge conflicts: ${tree.conflicts.join(', ')}`);
        this.escalateOnce(feature, `SDDP QC: merge conflicts integrating '${feature}' (${tree.conflicts.join(', ')}). Route those branches back to their authors to rebase, then re-run QC.`);
        return;
      }
      const policy = this.deps.sddpPolicy?.() ?? { qcStrictness: 'standard' as const, maxQcIterations: 10 };
      const dir = `specs/${feature}`;
      this.setStatus(feature, 'qc', 'running', 'running QC');
      const qc = await this.deps.spawnSubAgentInTree!(ownerId, 'qc-auditor',
        `Feature folder ${dir}/. You are in the MERGED integration tree. Run the build + tests${policy.qcStrictness === 'minimal' ? '' : ' + lint'}${policy.qcStrictness === 'strict' ? ` + security scan + coverage (target ${policy.coverageTarget ?? 80}%)` : ''}. Write ${dir}/qc-report.md. List EACH failure as its own bug line: "[BUG:<CRITICAL|ERROR|WARNING>] {<req if known>} [<category>] <description> — <file:line>" (categories: test-failure, lint-error, security-vuln, coverage-gap, requirement-gap, pi-violation, runtime-error). End with a line "VERDICT: PASS" (all required checks pass) or "VERDICT: FAIL".`,
        tree.path, ac.signal);
      if (ac.signal.aborted) { this.setStatus(feature, 'qc', 'stopped'); return; }
      const story = await this.deps.spawnSubAgentInTree!(ownerId, 'story-verifier',
        `Feature folder ${dir}/. In the MERGED tree, verify each user story / SC-### in ${dir}/spec.md is actually implemented. End with "VERDICT: PASS" or "VERDICT: FAIL".`,
        tree.path, ac.signal);
      if (ac.signal.aborted) { this.setStatus(feature, 'qc', 'stopped'); return; }

      const pass = /VERDICT:\s*PASS/i.test(qc.content) && /VERDICT:\s*PASS/i.test(story.content);
      if (pass) {
        this.deps.writeFeatureArtifact?.(repo, feature, '.qc-passed', '');
        this.escalated.delete(feature);
        this.qcAttempts.delete(feature);
        this.deps.advanceMilestone(epic.id, active.key); // integrate now unblocks (.qc-passed present)
      } else {
        // P5 bug loop: file bug cards (attempt-tagged), then WAIT for them (via openBugCards) before
        // re-running. The attempt count drives [ESCALATED]/[DEFERRED] tags in seedBugCards.
        const attempt = (this.qcAttempts.get(feature) ?? 0) + 1;
        this.qcAttempts.set(feature, attempt);
        const max = this.deps.sddpPolicy?.().maxQcIterations ?? 10;
        const n = this.deps.seedBugCards?.(epic, `${qc.content}\n\n${story.content}`, attempt) ?? 0;
        this.setStatus(feature, 'qc', 'blocked', `QC failed (attempt ${attempt}) — ${n} bug task(s) filed`);
        this.escalateOnce(feature, `SDDP QC FAILED for '${feature}' (attempt ${attempt}/${max}) — see ${dir}/qc-report.md. ${n} bug task(s) filed back to workers${attempt >= max ? ' and tagged [DEFERRED] — manual review needed' : attempt >= 3 ? ' (some [ESCALATED])' : ''}.`);
      }
    } finally {
      if (treePath) { try { this.deps.removeQcTree?.(treePath); } catch { /* best-effort */ } }
      this.inflight.delete(lockKey);
      this.aborters.delete(lockKey);
    }
  }

  /** CHECKLIST-COMPLETION GATE before Implement. Returns true to PROCEED (no checklists, already
   *  complete, or autopilot), false to HOLD. Runs `test-evaluator` ONCE to auto-check satisfied items,
   *  re-scans, then blocks + escalates if still incomplete (the operator resolves the items, then a
   *  re-trigger passes). Mechanical scan in code (`checklistStatus`); the LLM only auto-resolves. */
  private async checklistGate(epic: HiveTask, repo: string | null): Promise<boolean> {
    const feature = epic.feature!;
    const status = this.deps.checklistStatus?.(repo, feature);
    if (!status || status.total === 0 || status.checked >= status.total) return true; // N/A or complete

    // One auto-resolve pass via test-evaluator (deduped per feature), then re-scan.
    const evalKey = `${feature}::checklist-eval`;
    if (!this.asked.has(evalKey)) {
      const owner = this.resolveOwner(epic, feature, 'implement');
      if (owner) {
        this.asked.add(evalKey);
        this.setStatus(feature, 'implement', 'running', 'evaluating checklist');
        await this.deps.spawnSubAgent(owner, 'test-evaluator',
          `Feature folder specs/${feature}/. Evaluate each checklist item in specs/${feature}/checklists/ against spec.md/plan.md/tasks.md + the code; mark items that are genuinely satisfied as [X] (never revert [X]→[ ]). Leave unmet items unchecked.`);
        const re = this.deps.checklistStatus?.(repo, feature);
        if (re && re.checked >= re.total) return true; // auto-resolve completed it
      }
    }

    const cur = this.deps.checklistStatus?.(repo, feature) ?? status;
    if (cur.checked >= cur.total) return true;
    if (this.deps.autopilot()) return true; // autopilot proceeds despite an incomplete checklist (logged)
    this.setStatus(feature, 'implement', 'blocked', `checklist ${cur.checked}/${cur.total} complete`);
    this.escalateOnce(feature, `SDDP: checklist not complete (${cur.checked}/${cur.total}) for '${feature}' — resolve the items in specs/${feature}/checklists/ before Implement (or enable autopilot, or set Implement to manual).`);
    return false;
  }

  private escalateOnce(feature: string, message: string): void {
    if (this.escalated.has(feature)) return;
    this.escalated.add(feature);
    try { this.deps.escalate(feature, message); } catch { /* best-effort */ }
  }
}
