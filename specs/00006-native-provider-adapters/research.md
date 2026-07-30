# Research: Native Provider Adapters (DeepSeek, Minimax M3)

Product-spec research for two native adapters running full agentic tool-use loops behind the `ProviderRuntime` port (the `ProviderCall` seam) inside the E003 worker, normalizing provider divergences in-adapter and degrading unsupported capabilities gracefully. Findings map onto existing contracts: `src/shared/agentEvent.ts` (normalized stream; cumulative-monotonic `token-usage`; `notification`; `api-error.retryable`), `src/shared/providerRuntime.ts` (`CapabilityDescriptor`), `src/main/runtime/worker/agentLoop.ts` (pure loop with `maxTurns`/`maxHops` caps).

## 1. DeepSeek streamed tool-call assembly (OpenAI-compatible)

Streamed `tool_calls` arrive as `delta.tool_calls[]` fragments each carrying an `index`; `id`/`type`/`function.name` appear only on the FIRST delta for an index, later deltas append `function.arguments` partial-JSON. Accumulate per index, parse arguments only at `finish_reason: "tool_calls"`. The reasoner emits `reasoning_content` as a separate field fully before `content` — route it to thinking, never replay it into history (400 on replay).

- **Recommended**: key the accumulator on delta `index`; parse args only when the call is complete; route `reasoning_content`→thinking, `content`→text; support multiple concurrent indices + repeated tool rounds.
- **Avoid**: assuming `id`/`name` repeat per delta; parsing args early; replaying `reasoning_content`.
- **Sources**: developers.openai.com function-calling guide; api-docs.deepseek.com reasoning model.

## 2. Minimax M3 streamed loop (Anthropic-compatible)

SSE flow: `message_start` → per-block (`content_block_start`, `content_block_delta`*, `content_block_stop`) → `message_delta`* → `message_stop`. Blocks carry an `index` and a type (text / thinking / tool_use). `tool_use` opens with `id`+`name`; `input` arrives as `input_json_delta.partial_json` fragments concatenated and parsed at `content_block_stop`. Thinking streams `thinking_delta` + trailing `signature_delta`. Tool-wanting turns end with `message_delta.stop_reason: "tool_use"`.

- **Recommended**: index-keyed block map; dispatch on `content_block_start` type; buffer `partial_json`, parse at block stop; map tool_use→tool, thinking→thinking, text→text; ignore unknown event/block types (forward-compat).
- **Avoid**: parsing `partial_json` mid-stream; assuming text is index 0; dropping the stream on an unexpected event.
- **Sources**: platform.claude.com streaming docs.

## 3. Usage accounting divergence

Anthropic-style reports `usage` in `message_start` then CUMULATIVE `usage` in each `message_delta`. OpenAI-style omits per-chunk usage unless `stream_options.include_usage` is set, then returns one final `usage` on a terminal chunk. One path is incremental-cumulative, the other single-final; context-length pricing tiers mean price varies by prompt size.

- **Recommended**: normalize both into the internal cumulative-monotonic `token-usage` (`isMonotonicTokenUsage`). DeepSeek: set `include_usage`, emit once at the final chunk, sum across rounds. Minimax: take the latest `message_delta.usage` as the round total, add to running cumulative. Never let a counter decrease; absent `cacheRead`/`cacheCreation`=0 (not reset). `usd` passthrough (recompute is E002/E007).
- **Avoid**: adding `message_start`+`message_delta` outputs (double count); treating a missing field as a decrease; resetting between rounds.
- **Sources**: platform.claude.com streaming; developers.openai.com function-calling.

## 4. Graceful runtime degradation of unsupported capabilities

When a provider lacks images / MCP tools / web search / prompt caching, the durable pattern is no-op-with-notice: skip the path, surface one clear notice, keep running — never hard-error or silently drop. Capability source of truth is the registry `CapabilityDescriptor` (E002); enforcement belongs INSIDE the adapter at the seam where the missing feature would be invoked. The internal `notification` event is the operator-visible notice channel.

- **Recommended**: gate each optional path on its capability flag at adapter ingress; emit exactly one `notification` per capability per session ("web search unsupported by <model>; skipped"), strip the unsupported field, proceed; unsupported images → text placeholder, not a failed turn; caching off → omit cache controls, report cache fields as 0.
- **Avoid**: throwing on missing capability; degrading silently; enforcing in shared consumers; re-emitting the same notice every turn.
- **Sources**: platform.claude.com (forward-compatible "handle unknown types gracefully").

## 5. Agentic loop robustness / failure modes

Failure modes: malformed/partial tool-call JSON at finalize; runaway loops; transient errors (429/5xx/timeout) vs non-retryable (400/401/403, context overflow); empty/refused turns; stream interruption mid-tool-call. Standard for transient errors is bounded retry with exponential backoff + jitter, honoring `Retry-After`, with a bounded attempt count and a cap (this feature uses ADR-0009's authoritative 3–5 attempts, cap ~30–60s, not the broader ~3–7 industry range). `tool_use`/`thinking` blocks are not partially recoverable — never execute a partial call.

- **Recommended**: on arg-JSON parse failure emit `api-error` + a failed tool result so the model self-corrects (don't crash); keep `maxTurns`/`maxHops` caps as runaway bounds with a terminal `stop reason:"max-turns"`; classify errors → set `api-error.retryable`; retry only retryable with jittered backoff (respect `Retry-After`); empty/refused turns end the turn; on mid-tool-call interruption discard the incomplete block and surface a retryable error.
- **Avoid**: executing a tool from un-parsed JSON; unbounded/unjittered retries; retrying 4xx except 429; resuming a partial `tool_use` block; looping on a refusal.
- **Sources**: platform.claude.com streaming (in-stream errors; non-recoverable blocks); AI agent retry-pattern guidance (backoff+jitter, retryable classification).

## Summary

Both adapters share one shape (text/thinking → indexed tool calls → tool results → repeat until a no-tool stop) but diverge in three places the spec must pin: tool-argument assembly (OpenAI index-keyed delta concatenation vs Anthropic per-block `partial_json`), usage reporting (OpenAI single-final via `include_usage` vs Anthropic cumulative `message_delta`), and stop signalling (`finish_reason:"tool_calls"` vs `stop_reason:"tool_use"`). All divergence and all capability gating resolve INSIDE the adapter and normalize onto the existing `agentEvent` / `token-usage` / `notification` / `api-error` contract. Robustness rests on parse-on-complete-only, hard `maxTurns`/`maxHops` caps, jittered bounded backoff for transient errors only, and never executing a tool from partial JSON.
