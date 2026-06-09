/** E004 — provider credential store, injection seam, and non-leakage
 *  (SC-001/002/003/004/005/006). Pure Node — credentials.ts is electron-free. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  setKeyInConfig,
  getKeyFromConfig,
  clearKeyInConfig,
  keyPresence,
  injectionEnvForProvider,
  redactConfig,
  NATIVE_PROVIDER_KEY_ENV,
  NATIVE_PROVIDER_ID_ENV
} from '../credentials';
import type { HarnessConfig } from '../config';

const KNOWN = ['anthropic', 'deepseek', 'minimax'] as const;
const SECRET = 'sk-deepseek-SUPER-SECRET-123';

function cfg(providerKeys?: Record<string, string>): HarnessConfig {
  return {
    onboardingComplete: true,
    harnessHome: null,
    registeredRepos: [],
    autoMode: true,
    defaultCommand: 'claude',
    semanticMemory: true,
    embeddingModel: 'minilm',
    providerKeys
  } as HarnessConfig;
}

describe('SC-001 — store CRUD persists over a config object', () => {
  it('set → get → clear round-trips', () => {
    const c1 = setKeyInConfig(cfg(), 'deepseek', SECRET, KNOWN);
    expect(getKeyFromConfig(c1, 'deepseek')).toBe(SECRET);
    // simulate persist + reload (writeConfig/readConfig keep the field)
    const reloaded = cfg(c1.providerKeys);
    expect(getKeyFromConfig(reloaded, 'deepseek')).toBe(SECRET);
    const c2 = clearKeyInConfig(reloaded, 'deepseek');
    expect(getKeyFromConfig(c2, 'deepseek')).toBeNull();
  });
});

describe('SC-002 — only known providers', () => {
  it('rejects an unknown provider id', () => {
    expect(() => setKeyInConfig(cfg(), 'openai', SECRET, KNOWN)).toThrow(/unknown provider/i);
  });
  it('keyPresence is keyed only by known providers, values absent', () => {
    const c = setKeyInConfig(cfg(), 'minimax', SECRET, KNOWN);
    const presence = keyPresence(c, KNOWN);
    expect(presence).toEqual({ anthropic: false, deepseek: false, minimax: true });
    expect(JSON.stringify(presence)).not.toContain(SECRET);
  });
});

describe('SC-003 — injection seam returns the spawn env', () => {
  it('returns the generic key→env map for a stored key', () => {
    const c = setKeyInConfig(cfg(), 'deepseek', SECRET, KNOWN);
    expect(injectionEnvForProvider(c, 'deepseek')).toEqual({
      [NATIVE_PROVIDER_KEY_ENV]: SECRET,
      [NATIVE_PROVIDER_ID_ENV]: 'deepseek'
    });
  });
});

describe('SC-006 — missing key yields a clean null', () => {
  it('returns null (not empty/garbage env, no throw) when no key', () => {
    expect(injectionEnvForProvider(cfg(), 'deepseek')).toBeNull();
    expect(injectionEnvForProvider(cfg({ minimax: SECRET }), 'deepseek')).toBeNull();
  });
});

describe('SC-004 — non-leakage', () => {
  it('redactConfig strips key values; the value appears nowhere in the renderer-facing config', () => {
    const c = setKeyInConfig(cfg(), 'deepseek', SECRET, KNOWN);
    const safe = redactConfig(c);
    expect('providerKeys' in safe).toBe(false);
    expect(safe.providerKeyPresence).toEqual({ deepseek: true });
    expect(JSON.stringify(safe)).not.toContain(SECRET);
  });

  it('credentials.ts imports no hive/telemetry/transcript/electron module (boundary)', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/main/credentials.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l));
    for (const line of imports) {
      expect(line, line).not.toMatch(/(hive|telemetry|transcript|electron)/i);
    }
  });
});

describe('SC-005 — store lives outside any repo (OS app-data dir)', () => {
  it('config.ts persists to config.json under app.getPath(userData)', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/main/config.ts'), 'utf8');
    expect(src).toMatch(/getPath\(\s*['"]userData['"]\s*\)/);
    expect(src).toContain("'config.json'");
  });
});
