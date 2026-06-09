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

/** HarnessConfig with provider key VALUES removed — the only shape sent to the
 *  renderer (TR-008). Presence (has-key per provider) is exposed instead. */
export type SafeConfig = Omit<HarnessConfig, 'providerKeys'> & {
  providerKeyPresence: Record<string, boolean>;
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

/** Strip provider key VALUES from a config before it crosses to the renderer
 *  (TR-008); expose presence only. */
export function redactConfig(cfg: HarnessConfig): SafeConfig {
  const providerKeyPresence: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(cfg.providerKeys ?? {})) {
    providerKeyPresence[id] = Boolean(value);
  }
  const rest: Omit<HarnessConfig, 'providerKeys'> & { providerKeys?: Record<string, string> } = { ...cfg };
  delete rest.providerKeys;
  return { ...rest, providerKeyPresence };
}
