/**
 * Native-desk coding toolkit — the EXECUTOR (main-process only).
 *
 * The MAIN-process dispatcher for the tools a native (DeepSeek/Minimax) worker
 * requests over IPC. It brings a native desk to parity with a Claude desk: the four
 * hive tools (delegated to `executeHiveTool`) PLUS filesystem (read/write/edit/list),
 * search (grep), shell (bash), and durable memory (write_memory). It is the single
 * committer of all of these (Principle III): the worker only asks; main does the I/O.
 *
 * Safety = parity. Every path tool is SANDBOXED to the desk's working directory
 * (`resolveCwd`) — a `..` escape or an absolute path outside cwd is rejected, never
 * executed. `bash` is OPT-IN (off until the operator enables it) and additionally
 * screened by a coarse destructive-command guard; it always runs cwd-scoped. The
 * permission gate (pause / gated tool) and the circuit breaker are layered OUTSIDE
 * this module at the wiring site (`index.ts`), so a gated or runaway native desk is
 * stopped exactly like a Claude one — see the call site for that order.
 *
 * Electron-free: the hive surface + cwd resolver + bash toggle are injected
 * (`AgentToolDeps`), and the real I/O uses `node:fs`/`node:child_process` against the
 * sandbox dir, so this is unit-testable in Node over a temp directory. Never throws —
 * a bad input or a failed op returns `{ success:false }` so the loop feeds an error
 * tool-result back for self-correction (FR-009/FR-011 alignment).
 */
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { resolve, relative, isAbsolute, join, dirname } from 'node:path';
import { executeHiveTool, CORE_HIVE_TOOL_NAMES, type HiveToolDeps } from './hiveTools';

/** Result shape the worker loop consumes (mirrors `ToolResult` minus the call id). */
export interface AgentToolResult {
  content: string;
  success: boolean;
}

/** The surface the executor needs — the hive tools PLUS cwd + memory-append + the
 *  bash toggle. Injected (the real `HiveManager` + config), so this stays testable. */
export interface AgentToolDeps extends HiveToolDeps {
  /** Append durable text to an agent's memory.md (single-committer). */
  appendMemory(id: string, text: string): void;
  /** The agent's working directory = the sandbox root; null when unknown. */
  resolveCwd(id: string): string | null;
  /** Whether the `bash` tool is permitted for native desks (operator opt-in). */
  bashEnabled(): boolean;
}

// — bounds (coarse, parity-grade; the breaker + cwd scope are the real guards) —
const MAX_READ_CHARS = 256 * 1024; // a read_file result is capped (then noted)
const MAX_OUTPUT_CHARS = 30_000; // a bash / grep result is capped
const GREP_MAX_MATCHES = 200; // matches surfaced to the model
const GREP_HARD_CAP = 1000; // absolute walk cutoff (never unbounded)
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024; // skip very large files when scanning
const BASH_TIMEOUT_MS = 60_000;
const BASH_MAX_BUFFER = 4 * 1024 * 1024;
const GREP_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage']);

/** A plain object from arbitrary tool input (non-objects degrade to `{}`). */
function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

/** A trimmed string field, or '' when absent/non-string. */
function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v.trim() : '';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Resolve `p` against the sandbox `cwd` and return the absolute path ONLY if it stays
 * inside cwd; otherwise null (the caller returns an error tool-result). Rejects a
 * leading `..` segment AND an absolute path that lands outside cwd (incl. a different
 * Windows drive, where `relative` returns an absolute path). Empty/non-string ⇒ null.
 */
export function resolveInsideCwd(cwd: string, p: unknown): string | null {
  if (typeof p !== 'string' || p.trim() === '') return null;
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (rel === '') return abs; // cwd itself
  const firstSegment = rel.split(/[\\/]/)[0];
  if (firstSegment === '..' || isAbsolute(rel)) return null;
  return abs;
}

/** A coarse destructive-command backstop for `bash` (NOT a sandbox — cwd scope +
 *  breaker + the opt-in toggle are). Returns a reason when the command is refused. */
export function dangerousCommand(cmd: string): string | null {
  const c = cmd.toLowerCase();
  if (/:\s*\(\s*\)\s*\{/.test(cmd)) return 'looks like a fork bomb';
  if (/\brm\b[^\n|;&]*-[a-z]*r[a-z]*f?[a-z]*\b[^\n|;&]*(\s|=)(\/|~|\$home)\b/.test(c)) return 'recursive delete of a root/home path';
  if (/\brm\s+-[a-z]*\s+(\/|~)\s*$/.test(c)) return 'recursive delete of a root/home path';
  if (/\bmkfs\b|\bdd\s+if=/.test(c)) return 'disk-format / raw-write command';
  if (/\bsudo\b|\brunas\b/.test(c)) return 'privilege escalation';
  if (/\b(shutdown|reboot|halt|poweroff)\b/.test(c)) return 'system power command';
  return null;
}

function outside(p: unknown): AgentToolResult {
  return { content: `path is outside your working directory: ${String(p)}`, success: false };
}

/**
 * Execute one requested tool for `agentId`. Hive tools delegate to `executeHiveTool`;
 * `write_memory` appends to the hive memory; the filesystem/search/shell tools run
 * cwd-sandboxed. Async (the dispatch lambda awaits it). Never throws.
 */
export async function executeAgentTool(
  deps: AgentToolDeps,
  agentId: string,
  req: { toolName: string; toolInput: unknown }
): Promise<AgentToolResult> {
  if (!deps.enabled()) return { content: 'hive is not enabled for this desk', success: false };

  const name = req.toolName;

  // The four core hive tools — reuse the synchronous hive executor verbatim.
  if ((CORE_HIVE_TOOL_NAMES as readonly string[]).includes(name)) {
    return executeHiveTool(deps, agentId, req);
  }

  const input = asObject(req.toolInput);

  // write_memory targets the hive (memory.md), not the cwd — handle before the
  // cwd resolution so a desk can record memory even without a working directory.
  if (name === 'write_memory') {
    const text = str(input, 'text');
    if (!text) return { content: "missing 'text'", success: false };
    deps.appendMemory(agentId, text);
    return { content: 'recorded to memory.md', success: true };
  }

  // Every remaining tool is cwd-scoped — resolve the sandbox root first.
  const cwd = deps.resolveCwd(agentId);
  if (!cwd) return { content: 'no working directory is set for this desk', success: false };

  switch (name) {
    case 'read_file': {
      const abs = resolveInsideCwd(cwd, input.path);
      if (!abs) return outside(input.path);
      try {
        const st = await stat(abs);
        if (st.isDirectory()) return { content: `${String(input.path)} is a directory (use list_dir)`, success: false };
        let text = (await readFile(abs)).toString('utf8');
        if (text.length > MAX_READ_CHARS) {
          text = text.slice(0, MAX_READ_CHARS) + `\n…(truncated at ${MAX_READ_CHARS} chars)`;
        }
        return { content: text, success: true };
      } catch (e) {
        return { content: `read failed: ${errMsg(e)}`, success: false };
      }
    }

    case 'write_file': {
      const abs = resolveInsideCwd(cwd, input.path);
      if (!abs) return outside(input.path);
      const content = typeof input.content === 'string' ? input.content : '';
      try {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, 'utf8');
        return { content: `wrote ${String(input.path)} (${content.length} bytes)`, success: true };
      } catch (e) {
        return { content: `write failed: ${errMsg(e)}`, success: false };
      }
    }

    case 'edit_file': {
      const abs = resolveInsideCwd(cwd, input.path);
      if (!abs) return outside(input.path);
      const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
      const newStr = typeof input.new_string === 'string' ? input.new_string : '';
      if (oldStr === '') return { content: "missing 'old_string'", success: false };
      let text: string;
      try {
        text = (await readFile(abs)).toString('utf8');
      } catch (e) {
        return { content: `read failed: ${errMsg(e)}`, success: false };
      }
      const count = text.split(oldStr).length - 1;
      if (count === 0) return { content: 'old_string not found in file', success: false };
      const replaceAll = input.replace_all === true;
      if (count > 1 && !replaceAll) {
        return { content: `old_string is not unique (${count} matches) — add surrounding context or set replace_all`, success: false };
      }
      // Splice by index (not String.replace) so `$`-sequences in new_string are literal.
      let updated: string;
      if (replaceAll) {
        updated = text.split(oldStr).join(newStr);
      } else {
        const i = text.indexOf(oldStr);
        updated = text.slice(0, i) + newStr + text.slice(i + oldStr.length);
      }
      try {
        await writeFile(abs, updated, 'utf8');
      } catch (e) {
        return { content: `write failed: ${errMsg(e)}`, success: false };
      }
      return { content: `edited ${String(input.path)} (${count} replacement${count === 1 ? '' : 's'})`, success: true };
    }

    case 'list_dir': {
      const hasPath = typeof input.path === 'string' && input.path.trim() !== '';
      const target = hasPath ? resolveInsideCwd(cwd, input.path) : cwd;
      if (!target) return outside(input.path);
      try {
        const entries = await readdir(target, { withFileTypes: true });
        const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
        return { content: lines.length ? lines.join('\n') : '(empty)', success: true };
      } catch (e) {
        return { content: `list failed: ${errMsg(e)}`, success: false };
      }
    }

    case 'grep': {
      const pattern = str(input, 'pattern');
      if (!pattern) return { content: "missing 'pattern'", success: false };
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (e) {
        return { content: `invalid regex: ${errMsg(e)}`, success: false };
      }
      const hasPath = typeof input.path === 'string' && input.path.trim() !== '';
      const root = hasPath ? resolveInsideCwd(cwd, input.path) : cwd;
      if (!root) return outside(input.path);
      const matches: string[] = [];
      await grepWalk(root, cwd, re, matches);
      if (matches.length === 0) return { content: 'no matches', success: true };
      const shown = matches.slice(0, GREP_MAX_MATCHES).join('\n');
      const more = matches.length > GREP_MAX_MATCHES ? `\n…(${matches.length - GREP_MAX_MATCHES} more matches omitted)` : '';
      return { content: (shown + more).slice(0, MAX_OUTPUT_CHARS), success: true };
    }

    case 'bash': {
      if (!deps.bashEnabled()) {
        return { content: 'bash is disabled for native desks — the operator can enable it (Settings → native bash).', success: false };
      }
      const command = str(input, 'command');
      if (!command) return { content: "missing 'command'", success: false };
      const danger = dangerousCommand(command);
      if (danger) return { content: `refused: ${danger}`, success: false };
      return runBash(command, cwd);
    }

    default:
      return { content: `unknown tool '${name}'`, success: false };
  }
}

/** Bounded, cwd-scoped recursive content search. Skips build/vcs dirs + binaries +
 *  oversized files; stops at the hard cap so it can never walk unbounded. */
async function grepWalk(dir: string, cwd: string, re: RegExp, out: string[]): Promise<void> {
  if (out.length >= GREP_HARD_CAP) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  for (const e of entries) {
    if (out.length >= GREP_HARD_CAP) return;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (GREP_SKIP_DIRS.has(e.name)) continue;
      await grepWalk(full, cwd, re, out);
    } else if (e.isFile()) {
      let buf: Buffer;
      try {
        buf = await readFile(full);
      } catch {
        continue;
      }
      if (buf.length > GREP_MAX_FILE_BYTES || buf.includes(0)) continue; // skip huge/binary
      const rel = relative(cwd, full);
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push(`${rel}:${i + 1}: ${lines[i].slice(0, 200).trim()}`);
          if (out.length >= GREP_HARD_CAP) return;
        }
      }
    }
  }
}

/** Run a shell command cwd-scoped with a timeout + output cap. Combined stdout/stderr
 *  is returned; a non-zero exit (or timeout) is `success:false` with the output + note. */
function runBash(command: string, cwd: string): Promise<AgentToolResult> {
  return new Promise((resolveResult) => {
    exec(
      command,
      { cwd, timeout: BASH_TIMEOUT_MS, maxBuffer: BASH_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        const combined = (String(stdout ?? '') + (stderr ? `\n${String(stderr)}` : '')).slice(0, MAX_OUTPUT_CHARS);
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string };
          const note = e.killed || e.signal ? ` (timed out after ${BASH_TIMEOUT_MS}ms)` : typeof e.code === 'number' ? ` (exit ${e.code})` : '';
          resolveResult({ content: (combined || errMsg(err)) + note, success: false });
        } else {
          resolveResult({ content: combined || '(no output)', success: true });
        }
      }
    );
  });
}
