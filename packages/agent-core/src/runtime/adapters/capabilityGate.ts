/**
 * Capability degradation gate (E006 / AD-005, FR-010 — runtime half of ADR-0008).
 *
 * Given a model's `CapabilityDescriptor` (from the E002 registry), this gate lets
 * an adapter degrade gracefully when work would invoke a capability the provider
 * lacks (images, MCP tools, web search, prompt caching):
 *  - it NEVER throws — it strips/omits the unsupported field and continues,
 *  - it emits EXACTLY ONE `notification` per capability per SESSION (deduped),
 *  - the notification payload is BOUNDED to the capability name + model id and
 *    NEVER echoes the request content that triggered it (FR-010 — no dropped image
 *    bytes, raw tool inputs, or any sensitive payload).
 *
 * Electron-free and emit-injected so vitest exercises it in Node (HINT-001). The
 * gate is per-runtime (one instance per desk session) so the dedupe scope is the
 * session (desk lifetime), per the spec Glossary.
 */
import type { AgentEvent } from '../../contracts/agentEvent';
import { AGENT_EVENT_VERSION } from '../../contracts/agentEvent';
import type { CapabilityDescriptor } from '../../contracts/providerRuntime';

/** The four gated capabilities — one per `CapabilityDescriptor` flag. */
export type GatedCapability = 'images' | 'mcpTools' | 'webSearch' | 'caching';

/** Map a gated capability to its descriptor flag. */
const FLAG_OF: Record<GatedCapability, keyof CapabilityDescriptor> = {
  images: 'supportsImages',
  mcpTools: 'supportsMcpTools',
  webSearch: 'supportsWebSearch',
  caching: 'supportsCaching'
};

/** Human-facing capability label for the (bounded) notice text. */
const LABEL_OF: Record<GatedCapability, string> = {
  images: 'image input',
  mcpTools: 'MCP tools',
  webSearch: 'web search',
  caching: 'prompt caching'
};

/** Minimal envelope fields the gate needs to stamp a notification event. */
export interface GateEnvelope {
  agentId: string;
  sessionId: string | null;
  /** Canonical model id for the bounded notice (never the request content). */
  modelId: string | null;
  /** Epoch-ms clock; injectable for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

/** What `gate(...)` returns so the caller can branch on the decision. */
export interface GateDecision {
  /** True when the capability is supported and the path may proceed unchanged. */
  supported: boolean;
  /** True when a notice was emitted on THIS call (i.e. first time this session). */
  noticed: boolean;
}

export interface CapabilityGate {
  /**
   * Check one capability. When unsupported, emits one notice (first time only this
   * session) and returns `{ supported:false }`; the caller then strips/omits the
   * field and continues — the gate itself never throws.
   */
  gate(cap: GatedCapability): GateDecision;
  /** Convenience: `true` when the capability may proceed (no side effect beyond the notice). */
  allows(cap: GatedCapability): boolean;
  /**
   * Strip unsupported fields from a per-request options bag (e.g. drop
   * `cache_control` when caching is unsupported), emitting one notice per stripped
   * capability per session. Returns a shallow copy; never mutates the input.
   */
  applyTo<T extends Partial<Record<GatedCapability, unknown>>>(opts: T): Partial<T>;
}

/**
 * Build a session-scoped capability gate over a descriptor. `emit` is injected
 * (the loop's scoped emit in the worker; a fake in tests).
 */
export function makeCapabilityGate(
  descriptor: CapabilityDescriptor,
  emit: (event: AgentEvent) => void,
  env: GateEnvelope
): CapabilityGate {
  const now = env.now ?? Date.now;
  // Dedupe scope = this gate instance = this session (desk lifetime).
  const notified = new Set<GatedCapability>();

  const supports = (cap: GatedCapability): boolean => descriptor[FLAG_OF[cap]] === true;

  const notifyOnce = (cap: GatedCapability): boolean => {
    if (notified.has(cap)) return false;
    notified.add(cap);
    // Bounded payload: capability label + model id ONLY — never the trigger content.
    const model = env.modelId ?? 'unknown model';
    emit({
      v: AGENT_EVENT_VERSION,
      agentId: env.agentId,
      sessionId: env.sessionId,
      ts: now(),
      kind: 'notification',
      message: `${LABEL_OF[cap]} is not supported by ${model}; skipping that capability for this session.`
    });
    return true;
  };

  const gate = (cap: GatedCapability): GateDecision => {
    if (supports(cap)) return { supported: true, noticed: false };
    const noticed = notifyOnce(cap);
    return { supported: false, noticed };
  };

  return {
    gate,
    allows: (cap) => gate(cap).supported,
    applyTo<T extends Partial<Record<GatedCapability, unknown>>>(opts: T): Partial<T> {
      const out: Partial<T> = { ...opts };
      for (const cap of Object.keys(FLAG_OF) as GatedCapability[]) {
        if (cap in out && !supports(cap)) {
          notifyOnce(cap);
          delete out[cap];
        }
      }
      return out;
    }
  };
}
