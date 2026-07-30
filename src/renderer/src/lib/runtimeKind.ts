import { deriveProviderId } from '@shared/assignment';
import type { Agent } from '@/store/store';

/**
 * Does this desk run on the NATIVE runtime (DeepSeek/Minimax) rather than the Claude
 * CLI? Single source of truth for the renderer's runtime-kind decision — display
 * (native transcript vs Claude PTY) and the message composer (native send seam vs the
 * queue→writePty path) MUST agree, or a desk renders one way and accepts input another.
 *
 * It mirrors the MAIN spawn router's model resolution: an explicit per-agent model wins,
 * else the house fleet default (`config.defaultModel`). That fallback matters for a
 * model-less desk like the god — its registry entry carries no model, but the router
 * still launches it on the fleet default, so the UI must classify it the same way (else
 * a native god falls through to the blank Claude-PTY / "no live terminal" view).
 */
export function isNativeRuntimeDesk(agent: Agent, fleetDefaultModel?: string | null): boolean {
  const model = (agent.model ?? '').trim() || (fleetDefaultModel ?? undefined);
  const providerId = deriveProviderId(model);
  return providerId !== null && providerId !== 'anthropic';
}
