/**
 * Adapter selector (E006 / US3 — FR-008, AD-002).
 *
 * The worker's single dispatch point from the INJECTED provider env to a concrete
 * `ProviderCall`. It is the only provider-selection logic that reads the spawn env
 * (the worker entry passes `process.env`); everything provider-specific lives
 * behind the returned `ProviderCall`, so the loop and every downstream consumer
 * stay provider-agnostic (Principle I).
 *
 * It reads:
 *  - `NATIVE_PROVIDER_ID`  — which adapter (`'deepseek'` / `'minimax'`),
 *  - `NATIVE_PROVIDER_API_KEY` — the bearer key, used ONLY at the fetch boundary
 *    inside the adapter and NEVER emitted (FR-013),
 *  - `NATIVE_PROVIDER_MODEL` — the desk's assigned model id, threaded by the spawn
 *    router (T020) so the adapter targets the right model (and Minimax derives the
 *    context-length tier from its registry row).
 *
 * The provider HTTP endpoint is DERIVED from the E002 registry
 * (`lookupModelInfo(...).provider.defaultEndpoint`) — not from env — so model facts
 * stay in one place. An unknown/absent provider id, a missing key, or an
 * unresolvable model returns `null`; the caller (agentWorker) falls back to the
 * stub so existing stub-based behavior/tests survive.
 *
 * Electron-free + unit-testable (HINT-001): the model/env/fetch are injectable; the
 * real global `fetch` is the default. No SDK or wire type crosses this boundary.
 */
import { lookupModelInfo } from '../../contracts/providerRegistry';
import {
  NATIVE_PROVIDER_API_KEY_ENV,
  NATIVE_PROVIDER_ID_ENV,
  NATIVE_PROVIDER_MODEL_ENV
} from './selectAdapterEnv';
import { makeDeepseekAdapter, type FetchLike } from './deepseekAdapter';
import { makeMinimaxAdapter } from './minimaxAdapter';
import type { ProviderCall } from '../../contracts/providerCall';

/** The minimal env shape `selectAdapter` reads — a plain string map (injectable). */
export type EnvLike = Record<string, string | undefined>;

/** Optional overrides for tests; the real global `fetch` is the production default. */
export interface SelectAdapterOptions {
  /** Injected `fetch` (electron-free testing). Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/**
 * T018 {FR-008} — map the injected provider env to a concrete `ProviderCall`.
 *
 * Returns `null` (caller falls back to the stub) when:
 *  - no `NATIVE_PROVIDER_ID` is set (a Claude/stub desk),
 *  - the provider id is not a known native provider,
 *  - no API key is present (the missing-key guard is the spawn router's job, T021;
 *    here we simply decline to build a broken adapter),
 *  - the assigned model does not resolve in the registry (no endpoint).
 */
export function selectAdapter(env: EnvLike, opts: SelectAdapterOptions = {}): ProviderCall | null {
  const providerId = (env[NATIVE_PROVIDER_ID_ENV] ?? '').trim();
  if (!providerId) return null;

  const apiKey = env[NATIVE_PROVIDER_API_KEY_ENV] ?? '';
  if (!apiKey) return null; // no key ⇒ never build a broken adapter (T021 guards earlier)

  const model = (env[NATIVE_PROVIDER_MODEL_ENV] ?? '').trim();
  // Endpoint comes from the registry, never from env — model facts stay in one place.
  const info = lookupModelInfo(model);
  if (!info) return null; // unresolvable model ⇒ no endpoint ⇒ decline (caller falls back)
  const endpoint = info.provider.defaultEndpoint;

  // Default to the real global `fetch`; tests inject a fake. The cast narrows the
  // global `fetch` to the adapter's minimal `FetchLike` (no DOM/Node type leaks).
  const fetchImpl: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);

  switch (providerId) {
    case 'deepseek':
      return makeDeepseekAdapter({ fetch: fetchImpl, apiKey, endpoint, model });
    case 'minimax':
      return makeMinimaxAdapter({ fetch: fetchImpl, apiKey, endpoint, model });
    default:
      // Unknown/unsupported provider id — decline; the caller falls back to the stub.
      return null;
  }
}
