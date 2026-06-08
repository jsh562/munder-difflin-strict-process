# Internal Interface Contract — Provider Runtime & Event Bus (E001)

These are internal TypeScript module interfaces (no network API). Authoritative for tasks; signatures are illustrative, not final code. Lives under `src/shared/` so both the Electron main process and the renderer consume one definition. References: ADR-0001 (port boundary), ADR-0002 (event bus), `src/main/usage.ts` (locked `AgentUsageSample` seam).

## ProviderRuntime port (`src/shared/providerRuntime.ts`)

One running agent, provider-agnostic. No provider-specific type may appear in this interface.

- `start(): Promise<void>` — begin/attach the agent runtime.
- `stop(graceful: boolean): Promise<void>` — graceful end-of-work stop.
- `kill(): void` — force terminate (maps to PTY kill today).
- `send(input: AgentInput): void` — operator text, steer injection, or drain-continuation turn.
- `getUsage(): AgentUsageSample | null` — cumulative usage snapshot, shape-compatible with the locked `UsageProvider` seam.
- `subscribe(listener: (e: AgentEvent) => void): () => void` — normalized event stream; returns an unsubscribe.
- `capabilities(): CapabilityDescriptor` — accessor only; descriptor DATA is populated by the registry epic (E002).

`AgentInput` = `{ kind: 'operator' | 'steer' | 'drain'; text: string }`.
`CapabilityDescriptor` = `{ supportsImages: boolean; supportsMcpTools: boolean; supportsWebSearch: boolean; supportsCaching: boolean }` (accessor shape only in E001).

## AgentEvent contract (`src/shared/agentEvent.ts`)

Versioned, additively-extensible discriminated union. `AGENT_EVENT_VERSION` constant gates evolution; new event kinds/fields are additive only (no removal/rename) — enforced by a contract test (TR-006).

Common envelope: `{ v: number; agentId: string; sessionId: string | null; ts: number; kind: ... }`.

Event kinds and key fields:
- `turn-start` / `turn-end` — `{ }`
- `thinking-start` / `thinking-delta` — `{ text?: string }`
- `text-delta` — `{ text: string }`
- `tool-start` — `{ toolName: string; toolInput: unknown; toolCallId: string }`
- `tool-end` — `{ toolCallId: string; success: boolean; durationMs: number; error?: string }`
- `token-usage` — `{ input: number; output: number; cacheRead: number; cacheCreation: number; model: string | null; usd: number }` — **CUMULATIVE & MONOTONIC** per session; field set mirrors `AgentUsageSample` (usage.ts). `usd` is a passthrough, never recomputed here (ADR-0005 owns recompute).
- `api-error` — `{ retryable: boolean; message: string }`
- `stop` — `{ reason: string; stopActive: boolean }` — `stopActive` is the `stop_hook_active`-equivalent guard; triggers the hive inbox-drain (TR-008).
- `needs-input` / `notification` — `{ message: string }`

## Claude adapter (`src/main/runtime/claudeAdapter.ts`)

Implements `ProviderRuntime` over the existing runtime. Maps sources → events:
- HookServer payloads (PreToolUse → `tool-start`; PostToolUse → `tool-end`; Stop → `stop`; Notification → `needs-input`/`notification`; Status → `token-usage`/context) — see `src/main/hooks.ts`.
- PTY byte stream (`src/main/pty.ts`) → `text-delta`.
- `getUsage()` delegates to the existing `UsageProvider` (usage.ts) — unchanged source of truth.

## Parity translator (`src/main/runtime/ipcTranslator.ts`)

Subscribes to the normalized stream and re-emits the EXISTING `hive:*` IPC messages the renderer/avatars already consume, so downstream consumers stay unchanged in E001 (zero behavior change, TR-005). Native consumers migrate to read `AgentEvent` directly in later epics.
