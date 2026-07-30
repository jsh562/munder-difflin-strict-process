/** toolSummary — every native toolkit tool maps to a human-readable verb/detail;
 *  unknown tools fall back to the raw name; MCP tools get a server/tool label. */
import { describe, it, expect } from 'vitest';
import { summarizeTool, toolSummaryLine, summarizeResult } from '../toolSummary';

describe('summarizeTool — readable labels for the native toolkit', () => {
  it('maps each coding/hive tool to a friendly verb + detail', () => {
    expect(summarizeTool('read_file', { path: 'CLAUDE.md' })).toEqual({ verb: 'Read', detail: 'CLAUDE.md' });
    expect(summarizeTool('write_file', { path: 'a/b.ts' })).toEqual({ verb: 'Wrote', detail: 'a/b.ts' });
    expect(summarizeTool('edit_file', { path: 'x.ts' })).toEqual({ verb: 'Edited', detail: 'x.ts' });
    expect(summarizeTool('grep', { pattern: 'foo' })).toEqual({ verb: 'Searched for', detail: 'foo' });
    expect(summarizeTool('bash', { command: 'ls -la' })).toEqual({ verb: 'Ran', detail: 'ls -la' });
    expect(summarizeTool('web_search', { query: 'electron ipc' })).toEqual({ verb: 'Searched the web', detail: 'electron ipc' });
    expect(summarizeTool('hive_send_message', { to: 'god' })).toEqual({ verb: 'Messaged', detail: 'god' });
    expect(summarizeTool('hive_add_task', { title: 'do X' })).toEqual({ verb: 'Added task', detail: 'do X' });
  });

  it('list_dir without a path reads as the working directory', () => {
    expect(summarizeTool('list_dir', {})).toEqual({ verb: 'Listed', detail: 'working directory' });
    expect(summarizeTool('list_dir', { path: 'src' })).toEqual({ verb: 'Listed', detail: 'src' });
  });

  it('hive_read_memory notes a peer id when present', () => {
    expect(summarizeTool('hive_read_memory', {})).toEqual({ verb: 'Read memory', detail: '' });
    expect(summarizeTool('hive_read_memory', { agentId: 'a.native' })).toEqual({ verb: 'Read memory', detail: 'of a.native' });
  });

  it('MCP tools render as "MCP <server> / <tool>"', () => {
    expect(summarizeTool('mcp__github__create_pr', {})).toEqual({ verb: 'MCP', detail: 'github / create_pr' });
  });

  it('unknown tools fall back to the raw name (never crashes on junk input)', () => {
    expect(summarizeTool('totally_new_tool', null)).toEqual({ verb: 'totally_new_tool', detail: '' });
    expect(summarizeTool('read_file', 'not-an-object')).toEqual({ verb: 'Read', detail: '' });
  });

  it('toolSummaryLine joins verb + detail, omitting an empty detail', () => {
    expect(toolSummaryLine('bash', { command: 'npm test' })).toBe('Ran npm test');
    expect(toolSummaryLine('hive_list_tasks', {})).toBe('Listed tasks');
  });
});

describe('summarizeResult — scannable result previews for the card header', () => {
  it('counts lines per tool with correct pluralization', () => {
    expect(summarizeResult('read_file', 'a\nb\nc', true)).toBe('3 lines');
    expect(summarizeResult('read_file', 'only one', true)).toBe('1 line');
    expect(summarizeResult('grep', 'f.ts:1: x\nf.ts:2: y', true)).toBe('2 matches');
    expect(summarizeResult('list_dir', 'a\nb', true)).toBe('2 entries');
    expect(summarizeResult('hive_list_tasks', 't1', true)).toBe('1 task');
  });

  it('bash shows the first non-empty output line (clamped)', () => {
    expect(summarizeResult('bash', '\n  41 passed  \nmore', true)).toBe('41 passed');
    expect(summarizeResult('bash', '   \n  ', true)).toBe('no output');
    expect(summarizeResult('bash', 'x'.repeat(80), true)).toBe(`${'x'.repeat(60)}…`);
  });

  it('returns nothing for actions, failures, or empty non-bash results', () => {
    expect(summarizeResult('edit_file', 'ok', true)).toBe('');
    expect(summarizeResult('write_memory', 'noted', true)).toBe('');
    expect(summarizeResult('read_file', 'a\nb', false)).toBe(''); // failure → header shows "failed"
    expect(summarizeResult('read_file', '   ', true)).toBe('');
  });

  it('coerces non-string results without crashing', () => {
    expect(summarizeResult('read_file', { a: 1 }, true)).toBe('1 line');
    expect(summarizeResult('read_file', null, true)).toBe('');
  });
});
