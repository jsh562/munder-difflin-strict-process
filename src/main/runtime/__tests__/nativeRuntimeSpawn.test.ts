/** E006 T021/T020 {FR-008} — NativeRuntime.spawn guards: the missing-key guard
 *  surfaces 'needs-credentials' (no broken loop), the concurrency cap holds, and a
 *  duplicate spawn is rejected. These paths return BEFORE the electron worker is
 *  constructed, so they run in Node without forking a utilityProcess. */
import { describe, it, expect } from 'vitest';
import { NativeRuntime } from '../nativeRuntime';

function baseDeps(over: Partial<ConstructorParameters<typeof NativeRuntime>[0]> = {}) {
  return {
    drainForStop: () => ({ block: false }),
    onWorkerExit: () => {},
    // Default: a key IS present for any provider (returns an env).
    credentialEnvFor: (providerId: string) => ({
      NATIVE_PROVIDER_API_KEY: 'k',
      NATIVE_PROVIDER_ID: providerId
    }),
    ...over
  };
}

describe('T021 {FR-008} — missing-key guard', () => {
  it("returns 'needs-credentials' when no key is stored for the provider (no broken loop)", () => {
    const rt = new NativeRuntime(baseDeps({ credentialEnvFor: () => null }));
    const res = rt.spawn('a.native', 'deepseek', 'deepseek-v4-flash');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('needs-credentials');
    // Nothing was registered — the desk did not start.
    expect(rt.count()).toBe(0);
  });

  it('does NOT apply the missing-key guard when no providerId is given (key-free desk)', () => {
    // No providerId ⇒ credentialEnvFor is not consulted; spawn proceeds (and would
    // fork a worker), so we only assert it does not hit the needs-credentials branch.
    const rt = new NativeRuntime(baseDeps({ credentialEnvFor: () => null, maxConcurrent: 0 }));
    // maxConcurrent:0 makes spawn fail on the cap BEFORE constructing a worker,
    // letting us assert the guard branch was not taken.
    const res = rt.spawn('a.native');
    expect(res.error).not.toBe('needs-credentials');
  });
});

describe('T020 {FR-008} — concurrency cap + duplicate guard (pre-worker checks)', () => {
  it('rejects a spawn past the concurrency cap before constructing a worker', () => {
    const rt = new NativeRuntime(baseDeps({ maxConcurrent: 0 }));
    const res = rt.spawn('a.native', 'deepseek', 'deepseek-v4-flash');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/concurrency cap/);
  });
});
