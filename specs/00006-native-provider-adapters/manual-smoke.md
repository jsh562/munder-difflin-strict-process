# Manual App-Smoke: Native Provider Adapters (E006)

**Feature**: E006 — Native Provider Adapters
**Task**: T031 (manual gate)
**Why manual**: live DeepSeek + Minimax M3 behavior needs real provider API keys, which are not present in CI (plan Risk "No live API keys in CI" / Testing Strategy). All adapter logic — stream assembly, usage normalization, degradation, reliability, key non-leak — is fully fixture-tested in vitest; this procedure confirms ONLY the live-provider behaviors that automation cannot exercise.

This is the human gate. Run it against a build with real keys before treating E006 as release-ready. It does NOT block the automated `.qc-passed` gate (T032), which covers the fixture-tested logic.

## Prerequisites

- [ ] A DeepSeek API key and a Minimax M3 API key on hand.
- [ ] In **Settings → Provider Keys**, add the **DeepSeek** key and the **Minimax** key (both should show as present, value never displayed).
- [ ] Assign **one desk to a DeepSeek model** (e.g. `deepseek-v4-flash` or `deepseek-v4-pro`).
- [ ] Assign **one desk to Minimax M3** (`minimax-m3`).
- [ ] Keep a **Claude desk** running alongside for the peer-parity comparison (step 4).
- [ ] Have a **multi-step tool-use task** ready that forces at least one tool call → tool result → continue → final answer (e.g. "list the files in the workspace, then read one and summarize it").

## Confirmations

Tie each box to the success criterion / requirement it confirms. Check only after observing the behavior live.

- [ ] **(1) [SC-001]** The **DeepSeek** desk completes the multi-step tool-use task **end-to-end** — it calls the tool, reads the result, continues, and produces a final answer (tool calls correctly assembled from the streamed response).
- [ ] **(2) [SC-002]** On the DeepSeek desk, **reasoning shows as thinking**, visibly separate from the final answer — and the reasoning is **not echoed into the final answer** (and not replayed back to the provider on the next turn).
- [ ] **(3) [SC-003]** The **Minimax M3** desk completes the multi-step tool-use task **end-to-end** with its **thinking blocks surfaced** (tool input assembled from partial JSON; the desk continues after a tool-use stop).
- [ ] **(4) [SC-006]** Both native desks appear as **full peers** alongside the Claude desk — **avatar** is live, **telemetry** updates, **memory** and **mailbox** work, **autonomy/drain** is obeyed, and the **circuit breaker** behaves the same — with no visible provider-specific difference.
- [ ] **(5) [SC-005]** Per-agent **telemetry shows monotonic token/cost** for each native desk — the token and cost counters only ever increase across the run (never decrease, never double-count).
- [ ] **(6) [FR-008 guard]** Assigning a desk to a provider with **NO stored key** surfaces a clear **"needs credentials"** state — the desk does NOT start a broken/erroring loop.
- [ ] **(7) [SC-008]** A task needing an **unsupported capability** (e.g. an image input on a text-only native model) shows **one clear notice** and the agent **continues** to a result — the notice is not repeated every turn, and nothing errors out.
- [ ] **(8) [FR-013]** The **API key is never visible** anywhere operator-facing — not in the **transcript**, not in **telemetry**, not in the **logs** — on the success path or any error path.

## Notes / Result

- Build / commit under test: ______________________
- Date run: ______________________
- Outcome: ☐ all confirmed ☐ issues (record below)
- Issues observed: ______________________________________________
