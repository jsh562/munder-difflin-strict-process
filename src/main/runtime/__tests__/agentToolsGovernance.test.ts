/**
 * Native-toolkit governance wiring — the host's `executeToolFor` order (index.ts):
 * permission gate (pause / halt / gated) → circuit breaker → executor. Driven through
 * the ACTUAL ControlRegistry + CircuitBreaker so an operator gate/pause/halt denies and
 * the breaker is fed exactly as a Claude desk's would be. The pure executor behaviors
 * (filesystem/sandbox/bash/conformance) live in the package's own toolkit test; this is
 * the HOST-level integration that composes the extracted executor with the host's
 * control modules, so it stays in the app.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeAgentTool, type AgentToolDeps, type HiveMessage } from '@jsh562/agent-core';
import { ControlRegistry } from '../../control';
import { CircuitBreaker } from '../../breaker';

/** A fake hive + cwd that satisfies AgentToolDeps, backed by an on-disk temp cwd. */
function makeFixture(cwd: string, over: Partial<AgentToolDeps> = {}): { deps: AgentToolDeps } {
  const mem = new Map<string, string>();
  let ledger: { tasks: unknown[] } = { tasks: [] };
  const deps: AgentToolDeps = {
    enabled: () => true,
    memory: (id) => mem.get(id) ?? '',
    send: (partial, from = 'system') => ({ id: 'm1', from, to: String(partial.to), act: 'inform' } as unknown as HiveMessage),
    tasks: () => ledger,
    writeTasks: (t) => { ledger = { tasks: t }; },
    roster: () => [],
    isGod: () => false,
    canIntegrate: () => false,
    canReview: () => false,
    appendMemory: (id, text) => mem.set(id, (mem.get(id) ?? '') + '\n' + text),
    resolveCwd: () => cwd,
    bashEnabled: () => false,
    ...over
  };
  return { deps };
}

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'agenttools-gov-')); });
afterEach(() => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* noop */ } });

describe('governance wiring — the index.ts executeToolFor order (real Control + Breaker)', () => {
  /** Rebuild the exact governed dispatch the native runtime is wired with. */
  function governed(control: ControlRegistry, breaker: CircuitBreaker, deps: AgentToolDeps) {
    return async (id: string, req: { toolName: string; toolInput: unknown }) => {
      if (control.shouldHalt(id)) return { content: 'halted by operator', success: false };
      const decision = control.toolDecision(id, req.toolName);
      if (decision.deny) return { content: decision.reason ?? 'denied by operator', success: false };
      breaker.recordToolUse(id, req.toolName, req.toolInput);
      return executeAgentTool(deps, id, req);
    };
  }

  it('a gated tool is denied before the executor runs', async () => {
    const control = new ControlRegistry();
    const breaker = new CircuitBreaker(() => ({} as never));
    let ran = false;
    const { deps } = makeFixture(cwd, { resolveCwd: () => { ran = true; return cwd; } });
    const run = governed(control, breaker, deps);

    control.gateTool('a', 'write_file', true);
    const denied = await run('a', { toolName: 'write_file', toolInput: { path: 'x.txt', content: 'y' } });
    expect(denied.success).toBe(false);
    expect(denied.content).toMatch(/gated/);
    expect(ran).toBe(false); // executor never reached
  });

  it('a paused or halted desk is denied all tools', async () => {
    const control = new ControlRegistry();
    const breaker = new CircuitBreaker(() => ({} as never));
    const { deps } = makeFixture(cwd);
    const run = governed(control, breaker, deps);

    control.pause('a', true);
    expect((await run('a', { toolName: 'list_dir', toolInput: {} })).success).toBe(false);
    control.resume('a');
    control.halt('a');
    expect((await run('a', { toolName: 'list_dir', toolInput: {} })).content).toMatch(/halted/);
  });

  it('an allowed call feeds the breaker — repeated identical calls trip it', async () => {
    const control = new ControlRegistry();
    const breaker = new CircuitBreaker(() => ({} as never));
    writeFileSync(join(cwd, 'a.txt'), 'x', 'utf8');
    const { deps } = makeFixture(cwd);
    const run = governed(control, breaker, deps);

    // 8 identical tool calls = the default repeatedToolLimit → the breaker trips.
    for (let i = 0; i < 8; i++) {
      const r = await run('a', { toolName: 'read_file', toolInput: { path: 'a.txt' } });
      expect(r.success).toBe(true);
    }
    const decisions = breaker.tick([{ agentId: 'a', sample: null, progressing: true }], 0);
    expect(decisions[0].state.level).not.toBe('healthy');
  });
});
