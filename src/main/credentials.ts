/**
 * Provider credential management (E004 / ADR-0007). PURE — `HarnessConfig` is a
 * TYPE-only import so this module never loads electron and runs under vitest; it
 * imports NO hive / telemetry / transcript module (the non-leakage boundary the
 * SC-004 source-scan asserts). Keys are plaintext-at-rest in the harness config
 * (accepted MVP risk, ADR-0007); the value flows only to config.json and a native
 * worker's spawn env — never to the renderer (`redactConfig`), hive, transcripts,
 * or telemetry. The injection seam is the single swap point for a future
 * OS-keychain (`safeStorage`) backend.
 */
import type { HarnessConfig } from './config';

/** Env var names a native worker / E006 adapter reads at spawn. */
export const NATIVE_PROVIDER_KEY_ENV = 'NATIVE_PROVIDER_API_KEY';
export const NATIVE_PROVIDER_ID_ENV = 'NATIVE_PROVIDER_ID';
/** E006 {FR-008} — the desk's ASSIGNED model id, threaded to the worker so
 *  `selectAdapter` can build the adapter for the right model (endpoint + tier).
 *  Set by the spawn router alongside the key/id env; carries no secret. */
export const NATIVE_PROVIDER_MODEL_ENV = 'NATIVE_PROVIDER_MODEL';

/** Reserved `providerKeys` id for the web-search API key (Tavily etc.). It is NOT a
 *  model provider — stored in `providerKeys` purely so `redactConfig` strips it like
 *  any other key (presence-only crosses to the renderer). Read with
 *  `getKeyFromConfig(cfg, WEB_SEARCH_KEY_ID)`. */
export const WEB_SEARCH_KEY_ID = 'web-search';

/** HarnessConfig with all secret VALUES removed — the only shape sent to the renderer (TR-008).
 *  Provider-key presence (has-key per provider) and the secret-vault NAMES (never values) are exposed
 *  instead. */
export type SafeConfig = Omit<HarnessConfig, 'providerKeys' | 'secrets'> & {
  providerKeyPresence: Record<string, boolean>;
  secretNames: string[];
};

/** Set a provider's key. Rejects an unknown provider id (TR-002). Pure: returns a
 *  new config; the caller persists via writeConfig. */
export function setKeyInConfig(
  cfg: HarnessConfig,
  providerId: string,
  key: string,
  knownProviderIds: readonly string[]
): HarnessConfig {
  if (!knownProviderIds.includes(providerId)) {
    throw new Error(`unknown provider id: ${providerId}`);
  }
  return { ...cfg, providerKeys: { ...(cfg.providerKeys ?? {}), [providerId]: key } };
}

export function getKeyFromConfig(cfg: HarnessConfig, providerId: string): string | null {
  return cfg.providerKeys?.[providerId] ?? null;
}

export function clearKeyInConfig(cfg: HarnessConfig, providerId: string): HarnessConfig {
  if (!cfg.providerKeys || !(providerId in cfg.providerKeys)) return cfg;
  const next = { ...cfg.providerKeys };
  delete next[providerId];
  return { ...cfg, providerKeys: next };
}

/** Presence-only map (no values) for the known providers — for the renderer/UI. */
export function keyPresence(cfg: HarnessConfig, knownProviderIds: readonly string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of knownProviderIds) out[id] = Boolean(cfg.providerKeys?.[id]);
  return out;
}

/**
 * The key-injection-at-spawn seam (TR-003/TR-006). Returns the spawn env for a
 * provider, or null when no key is set (TR-007 — never an empty/garbage env, no
 * throw). The single point a future keychain backend swaps behind.
 */
export function injectionEnvForProvider(cfg: HarnessConfig, providerId: string): Record<string, string> | null {
  const key = getKeyFromConfig(cfg, providerId);
  if (!key) return null;
  return { [NATIVE_PROVIDER_KEY_ENV]: key, [NATIVE_PROVIDER_ID_ENV]: providerId };
}

/** Strip all secret VALUES from a config before it crosses to the renderer (TR-008): provider keys
 *  → presence only; the secret vault → NAMES only (never the encrypted blobs). */
export function redactConfig(cfg: HarnessConfig): SafeConfig {
  const providerKeyPresence: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(cfg.providerKeys ?? {})) {
    providerKeyPresence[id] = Boolean(value);
  }
  const secretNames = Object.keys(cfg.secrets ?? {});
  const rest: Omit<HarnessConfig, 'providerKeys' | 'secrets'> & { providerKeys?: Record<string, string>; secrets?: Record<string, string> } = { ...cfg };
  delete rest.providerKeys;
  delete rest.secrets;
  return { ...rest, providerKeyPresence, secretNames };
}
