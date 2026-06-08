/**
 * T022 / SC-006 — the normalized `stop` event carries the stop_hook_active-equivalent
 * guard, in 100% of end-of-turn cases across the OBJ3 scenario, so the existing
 * hive inbox-drain autonomy (drainForStop, in hooks.ts) stays drivable unchanged.
 */
import { describe, it, expect } from 'vitest';
import { makeAdapter } from './_harness';
import { preToolUseEdit, postToolUseEdit, stopActive, stopGenuine, userPromptSubmit } from './fixtures/hookSignals';

describe('stop event → drain autonomy guard', () => {
  it('maps a genuine Stop to stop{stopActive:false}', () => {
    const h = makeAdapter();
    h.adapter.ingestHook(stopGenuine);
    const stop = h.events.find((e) => e.kind === 'stop');
    expect(stop).toMatchObject({ kind: 'stop', reason: 'done', stopActive: false });
  });

  it('maps a stop_hook_active Stop to stop{stopActive:true} (loop guard preserved)', () => {
    const h = makeAdapter();
    h.adapter.ingestHook(stopActive);
    const stop = h.events.find((e) => e.kind === 'stop');
    expect(stop).toMatchObject({ kind: 'stop', stopActive: true });
  });

  it('emits exactly one stop per end-of-turn across the full OBJ3 scenario, every run', () => {
    for (let run = 0; run < 25; run++) {
      const h = makeAdapter();
      h.adapter.ingestHook(userPromptSubmit); // turn
      h.adapter.ingestHook(preToolUseEdit);   // file edit
      h.adapter.ingestHook(postToolUseEdit);  // command/tool end
      h.adapter.ingestHook(stopGenuine);      // turn end
      const stops = h.events.filter((e) => e.kind === 'stop');
      expect(stops, `run ${run}`).toHaveLength(1);
      expect(stops[0]).toMatchObject({ stopActive: false });
    }
  });
});
