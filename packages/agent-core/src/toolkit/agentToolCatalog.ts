/**
 * Native-desk coding toolkit — the ADVERTISED catalog + the system preamble.
 *
 * This is the WORKER-SAFE half of the toolkit: it carries only the `ToolSpec[]`
 * the native worker advertises to the model (so the worker bundle stays free of
 * `node:fs`/`node:child_process`). The matching EXECUTOR lives in `agentTools.ts`
 * (main-only — it does the real I/O + sandbox + governance). A conformance test
 * asserts the two never drift (every advertised tool is dispatchable and vice
 * versa), exactly like the hive-catalog conformance check.
 *
 * The catalog folds in the four core hive tools (`HIVE_TOOL_CATALOG`) and adds the
 * coding tools that bring a DeepSeek/Minimax desk to parity with a Claude desk:
 * filesystem (read/write/edit/list), search (grep), shell (bash), and durable
 * memory (write_memory). The schemas are deliberately minimal JSON Schema — the
 * executor fails closed on bad input (it returns an error tool-result the loop
 * feeds back for self-correction, never a crash).
 */
import type { ToolSpec } from '../contracts/providerCall';
import { HIVE_TOOL_CATALOG } from './hiveTools';

/** The coding tools added on top of the hive tools (filesystem/search/shell/memory). */
const CODING_TOOL_CATALOG: readonly ToolSpec[] = [
  {
    name: 'read_file',
    description:
      'Read a UTF-8 text file from your working directory. `path` is relative to your working directory (an absolute path inside it also works). Returns the file contents.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to your working directory.' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a text file in your working directory with `content` (parent directories are created as needed). Use `edit_file` for a targeted change to an existing file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to your working directory.' },
        content: { type: 'string', description: 'Full file contents to write.' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact string in an existing file. `old_string` must appear EXACTLY once (include surrounding context to make it unique) unless `replace_all` is true. Fails if `old_string` is absent or ambiguous — read the file first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to your working directory.' },
        old_string: { type: 'string', description: 'The exact text to replace.' },
        new_string: { type: 'string', description: 'The replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' }
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false
    }
  },
  {
    name: 'list_dir',
    description:
      'List the entries of a directory in your working directory (directories are suffixed with `/`). Omit `path` to list the working directory root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path, relative to your working directory; omit for the root.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'grep',
    description:
      'Search file contents under your working directory for a regular expression and return matching `path:line: text` rows. Optionally scope to a subdirectory with `path`. Skips node_modules/.git and binary files.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'Subdirectory to scope the search to; omit for the whole working directory.' }
      },
      required: ['pattern'],
      additionalProperties: false
    }
  },
  {
    name: 'bash',
    description:
      'Run a shell command in your working directory and return its combined stdout/stderr. Use for builds, tests, linters, and git. May be disabled by the operator (you will get a clear error if so).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' }
      },
      required: ['command'],
      additionalProperties: false
    }
  },
  {
    name: 'write_memory',
    description:
      'Append a durable fact, decision, or piece of context to your persistent memory.md (timestamped). Survives reloads and is shared into the team memory. Read it back with hive_read_memory.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The durable note to record.' }
      },
      required: ['text'],
      additionalProperties: false
    }
  }
] as const;

/**
 * The full toolkit catalog advertised to a native desk — the four hive tools plus
 * the coding tools. Supersedes `HIVE_TOOL_CATALOG` on the native worker path.
 */
export const AGENT_TOOL_CATALOG: readonly ToolSpec[] = [
  ...HIVE_TOOL_CATALOG,
  ...CODING_TOOL_CATALOG
] as const;

/** Every advertised tool name (for the catalog↔executor conformance check). */
export const AGENT_TOOL_NAMES: readonly string[] = AGENT_TOOL_CATALOG.map((t) => t.name);

/**
 * The system preamble prepended to a native desk's conversation — the hive protocol
 * + toolkit briefing that a Claude desk receives via `--append-system-prompt`. Kept
 * VOLATILE-FREE (no dates/ids/counters) so it is stable for the desk's lifetime and
 * does not defeat prompt caching. It names the tools generically (they operate on
 * your own workspace) so it stays correct for every native desk without per-spawn
 * interpolation.
 */
export const NATIVE_AGENT_PREAMBLE = [
  'You are an autonomous agent collaborating in a hive of agents. You work inside your own working directory and have a toolkit:',
  '- Filesystem (scoped to your working directory): read_file, write_file, edit_file, list_dir.',
  '- Search: grep (regex over your files).',
  '- Shell: bash (build/test/lint/git in your working directory; may be disabled by the operator).',
  '- Memory: write_memory records durable facts to your memory.md; hive_read_memory reads it (or a peer\'s) back.',
  '- Coordination: hive_send_message reaches a peer, the orchestrator ("god"), or "broadcast"; hive_list_tasks / hive_add_task manage the shared task board.',
  'Protocol: at the START of a task, read your memory (hive_read_memory) and act on it. Make focused changes with edit_file/write_file and verify them with bash when available. Record durable facts, decisions, and gotchas with write_memory so future-you remembers. For anything ambiguous, cross-cutting, or needing sign-off, hive_send_message "god". Be token-frugal and avoid repeating an identical tool call — a circuit breaker watches the floor.'
].join('\n');
