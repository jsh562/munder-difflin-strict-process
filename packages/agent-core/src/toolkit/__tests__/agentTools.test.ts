/**
 * Coding toolkit executor tests (pure Node, no host/electron). Covers filesystem
 * (read/write/edit/list) + grep + write_memory round-trips against a temp cwd; the
 * cwd SANDBOX (a `..` or absolute escape is rejected, never executed); bash OPT-IN
 * (off by default) + the destructive-command guard; and the catalog↔executor
 * conformance. The governance wiring (host gate/breaker order) is exercised by the
 * host's own test, since it composes this executor with the host's control modules.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeAgentTool, resolveInsideCwd, dangerousCommand, type AgentToolDeps } from '../agentTools';
import { AGENT_TOOL_CATALOG, AGENT_TOOL_NAMES } from '../agentToolCatalog';
import type { HiveMessage } from '../../coordination/types';

/** A fake hive + cwd that satisfies AgentToolDeps, backed by an on-disk temp cwd. */
function makeFixture(cwd: string, over: Partial<AgentToolDeps> = {}): {
  deps: AgentToolDeps;
  mem: Map<string, string>;
  sent: { to: string; from: string }[];
} {
  const mem = new Map<string, string>();
  const sent: { to: string; from: string }[] = [];
  let ledger: { tasks: unknown[] } = { tasks: [] };
  const deps: AgentToolDeps = {
    enabled: () => true,
    memory: (id) => mem.get(id) ?? '',
    send: (partial, from = 'system') => {
      sent.push({ to: String(partial.to), from });
      return { id: 'm1', from, to: String(partial.to), act: 'inform' } as unknown as HiveMessage;
    },
    tasks: () => ledger,
    writeTasks: (t) => { ledger = { tasks: t }; },
    appendMemory: (id, text) => mem.set(id, (mem.get(id) ?? '') + '\n' + text),
    resolveCwd: () => cwd,
    bashEnabled: () => false,
    ...over
  };
  return { deps, mem, sent };
}

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'agenttools-')); });
afterEach(() => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* noop */ } });

describe('filesystem tools — round-trips inside the working directory', () => {
  it('read_file reads a seeded file', async () => {
    writeFileSync(join(cwd, 'a.txt'), 'hello world', 'utf8');
    const { deps } = makeFixture(cwd);
    const r = await executeAgentTool(deps, 'a', { toolName: 'read_file', toolInput: { path: 'a.txt' } });
    expect(r).toEqual({ content: 'hello world', success: true });
  });

  it('write_file creates a file (and nested dirs), read_file reads it back', async () => {
    const { deps } = makeFixture(cwd);
    const w = await executeAgentTool(deps, 'a', { toolName: 'write_file', toolInput: { path: 'sub/dir/new.txt', content: 'fresh' } });
    expect(w.success).toBe(true);
    expect(readFileSync(join(cwd, 'sub', 'dir', 'new.txt'), 'utf8')).toBe('fresh');
    const r = await executeAgentTool(deps, 'a', { toolName: 'read_file', toolInput: { path: 'sub/dir/new.txt' } });
    expect(r.content).toBe('fresh');
  });

  it('edit_file replaces a unique string; fails on missing or ambiguous; replace_all works', async () => {
    const { deps } = makeFixture(cwd);
    writeFileSync(join(cwd, 'f.txt'), 'one two two three', 'utf8');

    const miss = await executeAgentTool(deps, 'a', { toolName: 'edit_file', toolInput: { path: 'f.txt', old_string: 'zzz', new_string: 'x' } });
    expect(miss.success).toBe(false);
    expect(miss.content).toMatch(/not found/);

    const ambiguous = await executeAgentTool(deps, 'a', { toolName: 'edit_file', toolInput: { path: 'f.txt', old_string: 'two', new_string: 'X' } });
    expect(ambiguous.success).toBe(false);
    expect(ambiguous.content).toMatch(/not unique/);

    const unique = await executeAgentTool(deps, 'a', { toolName: 'edit_file', toolInput: { path: 'f.txt', old_string: 'one', new_string: 'ONE' } });
    expect(unique.success).toBe(true);
    expect(readFileSync(join(cwd, 'f.txt'), 'utf8')).toBe('ONE two two three');

    const all = await executeAgentTool(deps, 'a', { toolName: 'edit_file', toolInput: { path: 'f.txt', old_string: 'two', new_string: '2', replace_all: true } });
    expect(all.success).toBe(true);
    expect(readFileSync(join(cwd, 'f.txt'), 'utf8')).toBe('ONE 2 2 three');
  });

  it('edit_file treats `$` in new_string literally (no regex-style substitution)', async () => {
    const { deps } = makeFixture(cwd);
    writeFileSync(join(cwd, 'p.txt'), 'price = HERE', 'utf8');
    const r = await executeAgentTool(deps, 'a', { toolName: 'edit_file', toolInput: { path: 'p.txt', old_string: 'HERE', new_string: '$5 ($&)' } });
    expect(r.success).toBe(true);
    expect(readFileSync(join(cwd, 'p.txt'), 'utf8')).toBe('price = $5 ($&)');
  });

  it('list_dir lists entries with a trailing / on directories', async () => {
    writeFileSync(join(cwd, 'file.txt'), 'x', 'utf8');
    mkdirSync(join(cwd, 'folder'));
    const { deps } = makeFixture(cwd);
    const r = await executeAgentTool(deps, 'a', { toolName: 'list_dir', toolInput: {} });
    expect(r.success).toBe(true);
    expect(r.content.split('\n')).toEqual(['file.txt', 'folder/']);
  });

  it('grep finds matches as path:line rows and skips node_modules', async () => {
    writeFileSync(join(cwd, 'a.txt'), 'hello world\nfoo bar', 'utf8');
    mkdirSync(join(cwd, 'node_modules'));
    writeFileSync(join(cwd, 'node_modules', 'skip.txt'), 'hello from a dep', 'utf8');
    const { deps } = makeFixture(cwd);
    const r = await executeAgentTool(deps, 'a', { toolName: 'grep', toolInput: { pattern: 'hello' } });
    expect(r.success).toBe(true);
    expect(r.content).toMatch(/a\.txt:1:/);
    expect(r.content).not.toMatch(/skip\.txt/);
  });
});

describe('write_memory — durable note via the single-committer appendMemory', () => {
  it('records text and is readable back through hive_read_memory', async () => {
    const { deps, mem } = makeFixture(cwd);
    const w = await executeAgentTool(deps, 'a', { toolName: 'write_memory', toolInput: { text: 'remember: use forks pool' } });
    expect(w.success).toBe(true);
    expect(mem.get('a')).toMatch(/use forks pool/);
    const r = await executeAgentTool(deps, 'a', { toolName: 'hive_read_memory', toolInput: {} });
    expect(r.content).toMatch(/use forks pool/);
  });

  it('a blank note fails closed', async () => {
    const { deps } = makeFixture(cwd);
    const w = await executeAgentTool(deps, 'a', { toolName: 'write_memory', toolInput: { text: '   ' } });
    expect(w.success).toBe(false);
  });
});

describe('cwd sandbox — escapes are rejected, never executed', () => {
  it('rejects a `..` escape on read and write', async () => {
    const { deps } = makeFixture(cwd);
    const rd = await executeAgentTool(deps, 'a', { toolName: 'read_file', toolInput: { path: '../escape.txt' } });
    expect(rd.success).toBe(false);
    expect(rd.content).toMatch(/outside your working directory/);

    const wr = await executeAgentTool(deps, 'a', { toolName: 'write_file', toolInput: { path: '../../evil.txt', content: 'nope' } });
    expect(wr.success).toBe(false);
    expect(existsSync(join(cwd, '..', '..', 'evil.txt'))).toBe(false);
  });

  it('rejects an absolute path outside cwd', async () => {
    const other = mkdtempSync(join(tmpdir(), 'agenttools-other-'));
    try {
      const target = join(other, 'secret.txt');
      writeFileSync(target, 'top secret', 'utf8');
      const { deps } = makeFixture(cwd);
      const r = await executeAgentTool(deps, 'a', { toolName: 'read_file', toolInput: { path: target } });
      expect(r.success).toBe(false);
      expect(r.content).toMatch(/outside your working directory/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('allows an absolute path that is INSIDE cwd', async () => {
    writeFileSync(join(cwd, 'inside.txt'), 'ok', 'utf8');
    const { deps } = makeFixture(cwd);
    const r = await executeAgentTool(deps, 'a', { toolName: 'read_file', toolInput: { path: join(cwd, 'inside.txt') } });
    expect(r).toEqual({ content: 'ok', success: true });
  });

  it('resolveInsideCwd: rejects .. / cross-root, accepts inside + cwd-relative', () => {
    expect(resolveInsideCwd(cwd, '../x')).toBeNull();
    expect(resolveInsideCwd(cwd, '')).toBeNull();
    expect(resolveInsideCwd(cwd, 'a/b.txt')).toBe(join(cwd, 'a', 'b.txt'));
    expect(resolveInsideCwd(cwd, '.')).toBe(cwd);
  });

  it('returns a clear error when the desk has no working directory', async () => {
    const { deps } = makeFixture(cwd, { resolveCwd: () => null });
    const r = await executeAgentTool(deps, 'a', { toolName: 'list_dir', toolInput: {} });
    expect(r.success).toBe(false);
    expect(r.content).toMatch(/no working directory/);
  });
});

describe('bash — opt-in + destructive-command guard + cwd scope', () => {
  it('is disabled by default (operator opt-in)', async () => {
    const { deps } = makeFixture(cwd);
    const r = await executeAgentTool(deps, 'a', { toolName: 'bash', toolInput: { command: 'echo hi' } });
    expect(r.success).toBe(false);
    expect(r.content).toMatch(/disabled/);
  });

  it('runs in the working directory when enabled', async () => {
    const { deps } = makeFixture(cwd, { bashEnabled: () => true });
    const r = await executeAgentTool(deps, 'a', {
      toolName: 'bash',
      toolInput: { command: `node -e "process.stdout.write('toolkit-ok')"` }
    });
    expect(r.success).toBe(true);
    expect(r.content).toMatch(/toolkit-ok/);
  });

  it('refuses an obviously destructive command even when enabled', async () => {
    const { deps } = makeFixture(cwd, { bashEnabled: () => true });
    const r = await executeAgentTool(deps, 'a', { toolName: 'bash', toolInput: { command: 'rm -rf /' } });
    expect(r.success).toBe(false);
    expect(r.content).toMatch(/refused/);
  });

  it('dangerousCommand flags catastrophic patterns and passes ordinary ones', () => {
    expect(dangerousCommand('rm -rf /')).not.toBeNull();
    expect(dangerousCommand('sudo apt install x')).not.toBeNull();
    expect(dangerousCommand('mkfs.ext4 /dev/sda')).not.toBeNull();
    expect(dangerousCommand('npm test')).toBeNull();
    expect(dangerousCommand('git status && rm -rf node_modules')).toBeNull();
  });
});

describe('catalog ↔ executor conformance (no drift)', () => {
  it('every advertised tool is dispatchable; an unknown tool fails closed', async () => {
    const { deps } = makeFixture(cwd, { bashEnabled: () => true });
    for (const name of AGENT_TOOL_NAMES) {
      const r = await executeAgentTool(deps, 'a', { toolName: name, toolInput: {} });
      // It may succeed or fail-closed on empty input, but it must be RECOGNIZED.
      expect(r.content).not.toMatch(/^unknown tool/);
    }
    const unknown = await executeAgentTool(deps, 'a', { toolName: 'does_not_exist', toolInput: {} });
    expect(unknown.success).toBe(false);
    expect(unknown.content).toMatch(/^unknown tool/);
  });

  it('every catalog entry carries a description + object inputSchema', () => {
    expect(AGENT_TOOL_CATALOG.length).toBe(AGENT_TOOL_NAMES.length);
    for (const spec of AGENT_TOOL_CATALOG) {
      expect((spec.description ?? '').length).toBeGreaterThan(0);
      expect((spec.inputSchema as { type?: string } | undefined)?.type).toBe('object');
    }
    // The toolkit is a strict SUPERSET of the four hive tools (parity additions).
    for (const hiveTool of ['hive_read_memory', 'hive_send_message', 'hive_list_tasks', 'hive_add_task']) {
      expect(AGENT_TOOL_NAMES).toContain(hiveTool);
    }
    for (const codingTool of ['read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'bash', 'write_memory']) {
      expect(AGENT_TOOL_NAMES).toContain(codingTool);
    }
  });
});
