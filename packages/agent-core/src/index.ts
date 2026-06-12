/**
 * @munder/agent-core — provider-agnostic agent runtime (DeepSeek/Minimax) plus a
 * governed, sandboxed coding toolkit, extracted from the Munder Difflin harness so
 * it can host native agents in any system ("bring your own host"). This barrel is
 * the package's public API; it grows as modules migrate in (see the extraction plan).
 */

// — Provider-agnostic contracts (the seam every host implements/consumes) —
export * from './contracts/agentEvent';
export * from './contracts/providerRuntime';
export * from './contracts/providerCall';
export * from './contracts/providerRegistry';
export * from './contracts/assignment';

// — Multi-agent coordination vocabulary (mailbox messages + task ledger) —
export * from './coordination/types';

// — Governed, sandboxed coding toolkit (filesystem/search/shell/memory + hive tools) —
export * from './toolkit/hiveTools';
export * from './toolkit/agentToolCatalog';
export * from './toolkit/agentTools';

// — Provider runtime: the agentic loop + the streaming provider adapters —
export * from './runtime/agentLoop';
export * from './runtime/stubProvider';
export * from './runtime/adapters/reliability';
export * from './runtime/adapters/sseParser';
export * from './runtime/adapters/capabilityGate';
export * from './runtime/adapters/selectAdapterEnv';
export * from './runtime/adapters/deepseekAdapter';
export * from './runtime/adapters/minimaxAdapter';
export * from './runtime/adapters/selectAdapter';

/** Package wiring sentinel (kept for the workspace/alias smoke test). */
export const AGENT_CORE_PACKAGE = '@munder/agent-core' as const;
