/**
 * Sub-agent spawn glue — the host-agnostic body of the native Task-tool replica.
 *
 * `spawnSubAgentFor` (in `index.ts`) couples to exactly three host bits: the electron worker
 * transport, the caller-scoped tool executor, and the telemetry cost rollup. Everything else —
 * spec lookup, provider/model resolution, the deny-list, the spawn env, the one-shot runner — is
 * pure logic over already-electron-free modules. This factory captures that logic with those three
 * host bits INJECTED, so:
 *   - production wires the real electron transport + `executeNativeToolFor` + `telemetry` (index.ts), and
 *   - a test wires a SCRIPTED fake transport + the real toolkit (`executeAgentTool`) over a temp git
 *     repo, exercising the full engine→runner→toolkit→fs chain with only the MODEL faked.
 *
 * The returned function is behaviorally identical to the inlined original; the only change is that
 * the three host edges arrive as `deps` instead of closing over module state.
 */
import { runOneShotSubAgent, subAgentChildId, resolveSubAgentModel } from './subAgentRunner';
import type { WorkerTransport } from './nativeAgentWorker';
import { deniedNativeToolNames } from './toolGating';
import { subAgentSpec, SUB_AGENT_NAMES } from '@jsh562/won-agent-core';
import { deriveProviderId } from '../../shared/assignment';
import { NATIVE_PROVIDER_MODEL_ENV } from '../credentials';
import type { NativeUsageInput } from '../telemetry';

/** One tool a child sub-agent requested (mirrors the worker's toolRequest shape). */
export interface SubAgentToolRequest {
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
}

/** The injected host edges. Everything else `makeSpawnSubAgent` needs is electron-free + imported. */
export interface SpawnSubAgentDeps {
  /** The caller desk's provider id (e.g. 'deepseek'); undefined if unknown/unassigned. */
  providerOf: (callerId: string) => string | undefined;
  /** The caller desk's assigned model id; undefined if none. */
  modelOf: (callerId: string) => string | undefined;
  /** Provider credential env (key/id) to inject into the child worker; null/undefined when none stored. */
  credentialEnvFor: (providerId: string) => Record<string, string> | null | undefined;
  /** The operator's `sddpSubAgentModel` override (applied only when it maps to the caller's provider). */
  subAgentModelOverride: () => string | undefined;
  /** The bash-environment preamble note injected as NATIVE_AGENT_ENV_NOTE. */
  envNote: () => string;
  /** Build the worker transport for one child run. Host passes the electron transport; a test passes a
   *  scripted fake. `name` is forwarded so a test can script per sub-agent. */
  transportFactory: (childId: string, env: Record<string, string>, name: string) => WorkerTransport;
  /** Execute one tool the child requested — CALLER-SCOPED, with the optional QC cwd-override. */
  executeTool: (callerId: string, req: SubAgentToolRequest, cwdOverride?: string) => Promise<{ content: string; success: boolean }>;
  /** Roll the child's cumulative token usage up to the caller (best-effort). */
  onUsage: (usage: NativeUsageInput) => void;
}

/** The spawn function shape shared by the `spawn_subagent` tool and the SDDP engine. */
export type SpawnSubAgent = (
  callerId: string,
  name: string,
  input: string,
  signal?: AbortSignal,
  cwdOverride?: string
) => Promise<{ content: string; success: boolean }>;

/**
 * Build the `spawnSubAgentFor` function with its three host edges injected. Fork + run one ephemeral
 * sub-agent AS `callerId` (the native Task-tool replica). Inherits the caller's provider+model, runs
 * caller-scoped via the injected `executeTool(callerId)`, rolls the child's token cost up to the
 * caller. Never throws — returns `{ success:false }` on any guard/error.
 */
export function makeSpawnSubAgent(deps: SpawnSubAgentDeps): SpawnSubAgent {
  return async function spawnSubAgentFor(callerId, name, input, signal, cwdOverride) {
    const spec = subAgentSpec(name);
    if (!spec) return { content: `unknown sub-agent '${name}' (available: ${SUB_AGENT_NAMES.join(', ')})`, success: false };
    const providerId = deps.providerOf(callerId);
    const callerModel = deps.modelOf(callerId);
    if (!providerId || providerId === 'anthropic' || !callerModel) {
      return { content: 'spawn_subagent requires the calling desk to run on a native (non-Claude) provider with a model assigned', success: false };
    }
    const credEnv = deps.credentialEnvFor(providerId);
    if (!credEnv) return { content: `no stored credentials for provider '${providerId}' — the operator can add a key in Settings`, success: false };
    // Sub-agent model: the operator's `sddpSubAgentModel` override when it maps to the SAME provider as
    // the caller (so the caller's injected key still authenticates); otherwise the caller's own model.
    const model = resolveSubAgentModel(callerModel, deps.subAgentModelOverride(), providerId, deriveProviderId);
    // The child's denied tools: its role-derived denials PLUS the hard ones (no nesting, no merge, no
    // board mutation). Enforced by NOT advertising them + the executor wrapper below.
    const denySet = new Set<string>([...deniedNativeToolNames(spec.roles), 'spawn_subagent', 'hive_integrate', 'hive_update_task', 'hive_add_task']);
    const childId = subAgentChildId(callerId, name);
    const env: Record<string, string> = {
      ...credEnv,
      [NATIVE_PROVIDER_MODEL_ENV]: model,
      NATIVE_AGENT_SUBAGENT_PROMPT: spec.systemPrompt,
      NATIVE_AGENT_ENV_NOTE: deps.envNote(),
      NATIVE_AGENT_DENY_TOOLS: [...denySet].join(','),
      NATIVE_AGENT_MAX_TURNS: '2',
      NATIVE_AGENT_MAX_HOPS: '12',
      NATIVE_AGENT_TURN_BUDGET_MS: '120000'
    };
    return runOneShotSubAgent({
      callerId,
      childId,
      input,
      signal,
      transportFactory: () => deps.transportFactory(childId, env, name),
      executeTool: async (req) => {
        if (denySet.has(req.toolName)) return { content: `a sub-agent may not call ${req.toolName}`, success: false };
        return deps.executeTool(callerId, req, cwdOverride);
      },
      // Roll the child's token cost up to the caller (the sub-run is visible as the caller's
      // spawn_subagent tool call + result; we don't forward the raw child stream under a synthetic id).
      onEvent: (event) => {
        if (event.kind !== 'token-usage') return;
        try {
          deps.onUsage({
            agentId: callerId,
            sessionId: event.sessionId ?? '',
            providerName: deriveProviderId(event.model ?? undefined) ?? providerId,
            requestModel: event.model ?? model,
            responseModel: event.model ?? null,
            tokens: { input: event.input, output: event.output, cacheRead: event.cacheRead, cacheCreation: event.cacheCreation }
          });
        } catch { /* best-effort cost rollup */ }
      }
    });
  };
}
