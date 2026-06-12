/** T007 / SC-005 — the shared port + contract leak no provider-specific type. The
 *  canonical contracts now live in the extracted @munder/agent-core package (the app's
 *  `src/shared/*` are thin re-export shims), so the guard reads them at their source. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const CONTRACTS = resolve(process.cwd(), 'packages/agent-core/src/contracts');
// Vendor names only — substring checks like "pty"/"hook" would false-positive on
// benign identifiers (e.g. "EMPTY"_CAPABILITY contains "pty"). Provider-specific
// IMPORTS are covered by the separate import-line check below.
const VENDOR = /(claude|deepseek|minimax|anthropic)/i;

describe('shared boundary', () => {
  for (const file of ['agentEvent.ts', 'providerRuntime.ts']) {
    const src = readFileSync(resolve(CONTRACTS, file), 'utf8');

    it(`${file} imports nothing provider-specific`, () => {
      const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l));
      for (const line of imports) {
        expect(line, line).not.toMatch(/(\.\.\/main|node-pty|electron|claude|deepseek|minimax)/i);
      }
    });

    it(`${file} exports no provider-named symbol`, () => {
      const names = [...src.matchAll(/export\s+(?:interface|type|const|class|function)\s+(\w+)/g)].map(
        (m) => m[1]
      );
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name, name).not.toMatch(VENDOR);
    });
  }
});
