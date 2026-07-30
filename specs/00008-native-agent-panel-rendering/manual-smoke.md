# Manual App-Smoke (E008 / T039)

**Status**: MANUAL — live-app visual verification. **NOT a CI gate.** Requires a human running the Electron app with a real native (DeepSeek/Minimax) key.

All rendering logic below is already machine-verified by the 271-test suite (fold/coalesce/pairing/interrupted/monotonic, virtualization windowing math, truncation parity, notice dedup, persist→replay durable re-open, secret-free persistence). This smoke confirms the *live visual* experience that unit tests cannot observe. No P1 acceptance criterion or SC depends solely on this manual gate.

## Setup

1. Configure a real DeepSeek or Minimax key (E004 credential store) and assign a desk to that provider (E005). Launch: `npm run dev`.

## Procedure & expected results

| # | Action | Expect (SC) |
|---|--------|-------------|
| 1 | Open a native desk's panel, run a multi-step tool-use task | Default view is a synthesized terminal transcript that streams text incrementally with an in-progress indicator before the first token; text vs tool-call vs thinking are visually distinct; thinking is collapsed-by-default, expandable (SC-001/002, FR-002/003/017/018) |
| 2 | Watch a tool call | Pending entry resolves in place to success/failure + duration; no whole-list flash on each delta (SC-002, FR-004) |
| 3 | Open a Claude desk | Still authentic PTY/xterm bytes, no visual/behavioral change (SC-003, FR-009) |
| 4 | Toggle the Structured tab (native, then Claude) | Turns → tool calls (name/input/result/duration/status) + token usage; `usd:null` shows "unpriced", never $0; toggling preserves the other view's content + scroll (SC-004/005, FR-005/006/012) |
| 5 | Type a prompt into a native desk; type `/steer …` | Input routes to the agent (send ack like Claude); steer routed distinctly; resulting activity continues in the same transcript (SC-008, FR-015/021) |
| 6 | Stop the native worker, then submit input | Distinct, non-blocking "not delivered" notice; text restored (FR-022) |
| 7 | Drive a capability-degradation + an api-error | Inline notices in BOTH views, retryable vs terminal distinguished, transcript not aborted; repeated identical notices collapse with ×N (SC-006, FR-007/008/019/020) |
| 8 | Close & reopen the panel; restart the app; reopen the desk | Transcript + structured view rebuild from the persisted stream, identical to before (SC-009, FR-016) |
| 9 | Run a long task (hundreds–thousands of entries) across several native panels | Panels stay responsive; only visible rows mount (DOM node count bounded); scroll stick-to-bottom only when at bottom (SC-007/016/017, FR-010/024/027/028) |
| 10 | Keyboard-only: Tab to the thinking toggle and the tab bar; screen reader on notices | Thinking toggle + structured tab keyboard-operable; notices announced (role=status/alert) (SC-014, FR-025) |

## Recording

Record pass/fail per row (date, provider, build) in the PR description when run. This file is the canonical manual-gate procedure; it does not block CI.
