import { describe, it, expect } from 'vitest';
import { restartSigOf, deskStaleKeys, RESTART_SIG_LABELS, type RestartSig } from '../restartSig';

describe('restartSigOf — normalize any config-ish source into the restart-required subset', () => {
  it('coerces presence/defaults (sddp/auto default false, theme defaults light)', () => {
    expect(restartSigOf({})).toEqual({ sddpMode: false, autoMode: false, terminalTheme: 'light' });
    expect(restartSigOf({ sddpMode: true, autoMode: true, terminalTheme: 'dark' }))
      .toEqual({ sddpMode: true, autoMode: true, terminalTheme: 'dark' });
    // a bogus theme falls back to light
    expect(restartSigOf({ terminalTheme: 'neon' as unknown as 'light' }).terminalTheme).toBe('light');
  });
});

describe('deskStaleKeys — which baked-at-spawn settings changed since the desk spawned', () => {
  const live: RestartSig = { sddpMode: true, autoMode: false, terminalTheme: 'light' };

  it('a desk with no snapshot is never flagged (pre-feature desk)', () => {
    expect(deskStaleKeys(undefined, live)).toEqual([]);
  });

  it('a desk spawned under the same settings is fresh', () => {
    expect(deskStaleKeys({ sddpMode: true, autoMode: false, terminalTheme: 'light' }, live)).toEqual([]);
  });

  it('reports exactly the changed keys', () => {
    expect(deskStaleKeys({ sddpMode: false, autoMode: false, terminalTheme: 'light' }, live)).toEqual(['sddpMode']);
    expect(deskStaleKeys({ sddpMode: false, autoMode: true, terminalTheme: 'dark' }, live).sort())
      .toEqual(['autoMode', 'sddpMode', 'terminalTheme']);
  });

  it('toggling a value back to its original clears the flag', () => {
    // spawned under sddp=false; flip live on → stale; flip live back off → fresh again
    expect(deskStaleKeys({ sddpMode: false, autoMode: false, terminalTheme: 'light' }, { ...live, sddpMode: true })).toEqual(['sddpMode']);
    expect(deskStaleKeys({ sddpMode: false, autoMode: false, terminalTheme: 'light' }, { ...live, sddpMode: false })).toEqual([]);
  });

  it('every key has a human label for the banner', () => {
    for (const k of Object.keys(live) as (keyof RestartSig)[]) {
      expect(typeof RESTART_SIG_LABELS[k]).toBe('string');
      expect(RESTART_SIG_LABELS[k].length).toBeGreaterThan(0);
    }
  });
});
