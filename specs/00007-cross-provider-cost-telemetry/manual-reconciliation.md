# Manual Out-of-Band Cost Reconciliation (E007 / FR-012)

**Status**: MANUAL — out-of-band. **NOT a CI gate.** No live provider keys or bills run in CI.

## Purpose

Validate the ≤5% cost-attribution accuracy gate (FR-012 / SC-003) for non-Claude providers by comparing the seam-computed cost — `Σ(tokens × dated registry row)` — against a **real provider bill**. This is the live half of the gate; the reproducible half (token × dated-row math) is covered in CI by golden vectors.

## What CI already covers (no keys)

- `src/main/__tests__/costVectors.test.ts` — golden-vector cost: known token counts × dated rows give the expected USD within ≤5% for DeepSeek (cache read/write split), Minimax (context tier below + above threshold), and Claude; unknown model → `usd=null` + parity warning; missing field → zero-not-price.
- `src/main/__tests__/telemetryNormalize.test.ts` — `claude_code.*` delta + `gen_ai.*` native bodies normalize to one cumulative-monotonic `AgentUsageSample` + `ToolSpan`; secret non-leak on every channel (T024).

CI therefore proves the **computation** is correct against the dated rows. It cannot prove the **dated rows themselves** match each provider's live price — that is what this manual step reconciles.

## Procedure (run with real keys, off CI)

1. Configure real DeepSeek and Minimax credentials (per E004 credential management); assign one desk to each provider.
2. Run a bounded, representative workload per desk (a multi-step tool-use task), exercising:
   - DeepSeek: a run with cache hits (so cache read/write split is priced).
   - Minimax: one run below and one run above the context-length tier threshold (whole-call repricing).
3. From the seam, capture per-agent cumulative `AgentUsageSample`: token counts (input/output/cache-read/cache-write), model id, and computed `usd`.
4. From each provider's billing/usage console, capture the real billed amount for the same window/requests.
5. Compute the error per provider: `|computed_usd − billed_usd| / billed_usd`.

## Acceptance

- **PASS** when, for each non-Claude provider, the error ≤ **5%**.
- On a miss, reconcile the cause (cache-field semantics, tier boundary, rounding, or a stale/promo dated row in the E002 registry), correct the registry row as a static source edit, and re-run the golden vectors.

## Recording results

Record each reconciliation run (date, provider, model, token counts, computed USD, billed USD, % error, verdict) in the **PR description** for this feature (and/or append a dated row to the table below). This note is the canonical location for the manual gate; it does not block CI.

| Date | Provider | Model | Computed USD | Billed USD | % error | Verdict |
|------|----------|-------|--------------|------------|---------|---------|
| _pending_ | DeepSeek | | | | | |
| _pending_ | Minimax | | | | | |
