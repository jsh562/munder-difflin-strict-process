# Research: Native Agent Panel Rendering (E008)

**Context**: Best-practice guidance to inform a PRODUCT spec for rendering non-Claude (DeepSeek/Minimax) agent activity from a normalized AgentEvent stream as a synthesized terminal-style transcript plus an optional structured tab, with inline degradation notices. WHAT/WHY only; no implementation chosen.

## 1. Synthesized transcript vs raw PTY: separating text, tools, reasoning

Give assistant text, tool call/result, and reasoning each a distinct visual treatment (label, glyph, or indent). Render reasoning/"thinking" as a labeled, collapsible block kept out of the main answer flow; show tool activity inline as compact "tool start / result" entries so the run reads as a transcript, not a debug dump. Avoid dumping thinking into the answer, hiding tool steps, or mimicking raw ANSI the source never emits. Edge cases: thinking-only turn (no visible text); no-op/empty turn; tool result far larger than its call; reasoning with no final answer.

## 2. Streaming / incremental rendering UX

Append text deltas to a stable, growing container; show an in-progress indicator before the first token; render an in-progress tool call as a pending entry that resolves in place to its result. Batch high-frequency deltas so layout does not thrash. Avoid re-parsing on every token, reflowing siblings each chunk, or leaving a pending tool call with no terminal state. Edge cases: out-of-order or interrupted streams; stream aborted mid-tool; final token-usage arriving after streamed text; interim-vs-final state for the same entry.

## 3. Structured "inspector" view (turns → tool calls → token usage)

Offer the structured tab as progressive disclosure over the same run: turns expand to tool calls; each tool call shows name, args, output, duration, status; surface token usage per turn and per run. Provide a clear raw-vs-structured toggle so operators pick narrative or inspectable detail. Avoid forcing megabyte payloads inline, duplicating the transcript without added structure, or burying token totals. Edge cases: streaming run where final token counts lag; failed tool call (error + state); empty turn; very large args/output needing truncation.

## 4. Performance for long-running transcripts and many panels

Virtualize/window the transcript so only visible entries (plus small overscan) render; cap retained scrollback per panel and signal truncation; release off-screen detail to bound memory across many concurrent panels. Avoid mounting every entry, unbounded scrollback, or per-token diffing of the full list. Edge cases: a single huge tool output; thousands of entries in one run; several busy panels streaming at once; scroll-position and "stick to bottom" during virtualization.

## 5. Inline degradation and error notices

Render capability-unsupported notices and api-errors as inline, persistent, dismissible feed entries at the point they occur, visually distinct from assistant content but not modal. Keep wording specific (what degraded, what still works) so the transcript keeps flowing. Avoid blocking popups for recoverable issues, silent drops, or errors styled like assistant text. Edge cases: notice with no following content; duplicate errors; error mid-stream then recovery; provider that emits no thinking events.

## Sources

- OpenWebUI reasoning-models UX; agent-UI observability conventions (topic 1).
- Streaming-UI guide; React high-frequency render control (topic 2).
- Braintrust agent observability + token-usage tracking (topic 3).
- React windowing/virtualization; xterm.js scrollback memory (topic 4).
- Error-message UX guidelines; activity-feed vs notification patterns (topic 5).
