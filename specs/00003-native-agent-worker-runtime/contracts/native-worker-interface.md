# Internal Interface Contract — Native Agent Worker Runtime (E003)

Internal TypeScript module interfaces (no network API). References: ADR-0003 (utilityProcess), ADR-0004 (native autonomy), E001 `ProviderRuntime`/`AgentEvent` (`src/shared/`). The worker runs in a separate OS process, so the agent loop is **pure** (no electron import) and the transport is thin.

## ProviderCall seam (`src/shared/providerCall.ts`) — implemented by E006

The pluggable model call the loop invokes. E003 ships a stub; E006 implements DeepSeek/Minimax.

- `ProviderCall = (req: ProviderRequest) => Promise<ProviderTurn>`
  - `ProviderRequest`: `{ messages: ChatMessage[]; tools: ToolSpec[] }`
  - `ProviderTurn`: `{ text?: string; toolUses: ToolUseRequest[]; usage: UsageDelta; endOfTurn: boolean }`
  - `UsageDelta`: `{ input; output; cacheRead; cacheCreation }` (per-call; the loop accumulates → cumulative `token-usage` AgentEvents).

## Agent-loop scaffold (`src/main/runtime/worker/agentLoop.ts`) — pure, Node-testable

`runAgentLoop(deps)` drives request → tool_use → execute → tool_result → repeat until `endOfTurn`, emitting `AgentEvent`s and handling autonomy:
- `deps.providerCall: ProviderCall` (stub in E003)
- `deps.executeTool(toolUse): Promise<ToolResult>`
- `deps.emit(e: AgentEvent): void` — turn-start/end, text-delta, tool-start/end, token-usage (cumulative-monotonic), api-error, stop
- `deps.requestDrain(): Promise<{ block: boolean; reason?: string }>` — end-of-turn autonomy (see below)
- `deps.caps: { maxTurns: number; maxHops: number }` — loop bound
- Autonomy: on `endOfTurn`, emit `stop{stopActive}`, call `requestDrain()`; if `block`, inject `reason` as the next user turn and continue; else idle. A `stopActive`-equivalent guard means a drain-created turn does not itself re-drain; `maxTurns`/`maxHops` cap the loop.

## Worker IPC protocol (`src/shared/workerProtocol.ts`)

Typed messages over `parentPort` / `MessagePortMain`:
- Main → worker `WorkerCommand`: `start` | `send(AgentInput)` | `stop(graceful)` | `kill` | `drainResult({block,reason})`.
- Worker → main `WorkerMessage`: `event(AgentEvent)` | `usage(UsageSnapshot)` | `drainRequest(turnId)` | `ready` | `exit(reason)`.
- The worker NEVER touches the hive git (single-committer). End-of-turn `drainRequest` → main runs `hive.drainForStop(agentId)` → replies `drainResult`.

## NativeAgentWorker (`src/main/runtime/nativeAgentWorker.ts`) — implements E001 `ProviderRuntime`

Main-process handle fronting one `utilityProcess`:
- `start()` → `utilityProcess.fork(<built agentWorker.js>, { execArgv: ['--max-old-space-size=…'] })`, wires IPC.
- `stop(graceful)` / `kill()` → `stop`/`kill` command / SIGTERM; `exit` runs the shared teardown/archive (mirrors `teardownPty`).
- `send(AgentInput)` → `send`; `getUsage()` → last `usage`; `subscribe(l)` → `event` stream; `capabilities()` → `EMPTY_CAPABILITY_DESCRIPTOR` (E002 fills real data later).

## NativeRuntime (`src/main/runtime/nativeRuntime.ts`) — registry

Manages native workers per agentId (peer to `ClaudeRuntime`): spawn/track, route `drainRequest` → `hive.drainForStop` → `drainResult`, run the shared exit teardown (archive + `breaker.forget`), and enforce a floor-wide concurrency cap.
