/**
 * T023 / SC-003 — parity: the normalized stream, run back through the IPC
 * translator, reproduces the EXACT `hive:hookEvent` payload hooks.ts emits today,
 * so renderer consumers (avatars) behave identically. Also asserts the seam is
 * fast enough for the <250 ms avatar-reaction budget.
 */
import { describe, it, expect } from 'vitest';
import { makeAdapter } from './_harness';
import { IpcTranslator } from '../ipcTranslator';
import {
  notificationIdle,
  postToolUseEdit,
  preToolUseEdit,
  referenceHiveHookEvent,
  stopGenuine,
  userPromptSubmit
} from './fixtures/hookSignals';

describe('IPC parity (event → legacy hive:hookEvent)', () => {
  it('reproduces the exact payload hooks.ts sends, per signal', () => {
    const h = makeAdapter();
    const translator = new IpcTranslator();
    const out: unknown[] = [];
    h.adapter.subscribe((e) => {
      const p = translator.toHiveHookEvent(e);
      if (p) out.push(p);
    });

    h.adapter.ingestHook(userPromptSubmit);
    h.adapter.ingestHook(preToolUseEdit);
    h.adapter.ingestHook(postToolUseEdit);
    h.adapter.ingestHook(notificationIdle);
    h.adapter.ingestHook(stopGenuine);

    expect(out).toEqual([
      referenceHiveHookEvent(userPromptSubmit),
      referenceHiveHookEvent(preToolUseEdit),
      referenceHiveHookEvent(postToolUseEdit), // tool name recovered via toolCallId
      referenceHiveHookEvent(notificationIdle),
      referenceHiveHookEvent(stopGenuine)
    ]);
  });

  it('processes a busy stream well within the 250ms avatar-reaction budget', () => {
    const h = makeAdapter();
    const translator = new IpcTranslator();
    let mapped = 0;
    h.adapter.subscribe((e) => { if (translator.toHiveHookEvent(e)) mapped++; });

    const start = performance.now();
    for (let i = 0; i < 2000; i++) {
      h.adapter.ingestHook(preToolUseEdit);
      h.adapter.ingestHook(postToolUseEdit);
    }
    const elapsed = performance.now() - start;
    expect(mapped).toBe(4000);
    // SC-003: per-event reaction must sit well under the 250ms avatar-reaction
    // budget. Asserting per-event (not the 4000-event total) keeps this robust on
    // a loaded CI runner while still catching a catastrophic per-event regression.
    expect(elapsed / mapped).toBeLessThan(250);
  });
});
