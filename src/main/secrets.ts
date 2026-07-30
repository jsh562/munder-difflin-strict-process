/**
 * Secret vault — named secret values referenced from env tables via `${secret:NAME}`. Encrypted at
 * REST with Electron `safeStorage` (OS-backed: DPAPI on Windows, Keychain on macOS) when available,
 * with a plaintext fallback (marked, so older/headless setups still work — matching the accepted
 * plaintext risk of provider keys, ADR-0007, but better when encryption is available). Values are
 * decrypted ONLY in main and flow only into a desk's spawn/bash env; they NEVER cross to the renderer
 * (`redactConfig` exposes `secretNames` only). Stored in `config.secrets` as `enc:<base64>` / `raw:<v>`.
 *
 * `safeStorage` is a main-process API, so this module imports electron — keep it off the pure/test
 * boundary (the pure config-shape parts live in `credentials.ts`'s `redactConfig`).
 */
import { safeStorage } from 'electron';
import type { HarnessConfig } from './config';

const ENC = 'enc:'; // safeStorage-encrypted, base64
const RAW = 'raw:'; // plaintext fallback (encryption unavailable)

/** Encode a secret for at-rest storage — encrypted when the OS backend is available, else marked raw. */
function encode(value: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC + safeStorage.encryptString(value).toString('base64');
    }
  } catch { /* fall through to raw */ }
  return RAW + value;
}

/** Decode a stored secret back to plaintext (main only). Returns null on a corrupt/undecryptable blob. */
function decode(stored: string): string | null {
  if (stored.startsWith(ENC)) {
    try { return safeStorage.decryptString(Buffer.from(stored.slice(ENC.length), 'base64')); }
    catch { return null; }
  }
  if (stored.startsWith(RAW)) return stored.slice(RAW.length);
  return stored; // legacy/unmarked → treat as plaintext
}

/** Set a named secret (encrypted at rest). Pure-ish: returns a new config; the caller persists. */
export function setSecretInConfig(cfg: HarnessConfig, name: string, value: string): HarnessConfig {
  return { ...cfg, secrets: { ...(cfg.secrets ?? {}), [name]: encode(value) } };
}

/** Remove a named secret. */
export function clearSecretInConfig(cfg: HarnessConfig, name: string): HarnessConfig {
  if (!cfg.secrets || !(name in cfg.secrets)) return cfg;
  const next = { ...cfg.secrets };
  delete next[name];
  return { ...cfg, secrets: next };
}

/** Decrypt a named secret to plaintext (main only), or null if absent/undecryptable. The seam the
 *  `${secret:NAME}` token resolves through at inject time. */
export function getSecretValue(cfg: HarnessConfig, name: string): string | null {
  const stored = cfg.secrets?.[name];
  return stored === undefined ? null : decode(stored);
}

/** The vault's names (no values) — for the renderer + reference validation. */
export function secretNames(cfg: HarnessConfig): string[] {
  return Object.keys(cfg.secrets ?? {});
}
