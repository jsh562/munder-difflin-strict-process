import { spawn } from 'node:child_process';

/** Run git in `cwd` with `args`. Returns stdout text or an error. */
function runGit(cwd: string, args: string[], timeoutMs = 8000): Promise<{
  ok: true; stdout: string;
} | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
    }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', e => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, stdout });
      else resolve({ ok: false, error: stderr.trim() || `git exited ${code}` });
    });
  });
}

export interface GitBranchInfo {
  current: string | null;
  detached: boolean;
}
export interface GitStatusEntry {
  path: string;
  index: string;   // staged status char
  worktree: string; // unstaged status char
}
export interface GitStatus {
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: string[];
}
export interface GitCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  subject: string;
  author: string;
  time: number; // unix seconds
  refs: string[]; // branch/tag refs
}
export interface GitAheadBehind {
  ahead: number;
  behind: number;
  upstream: string | null;
}

export async function getBranch(cwd: string): Promise<GitBranchInfo | { error: string }> {
  const head = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!head.ok) return { error: head.error };
  const name = head.stdout.trim();
  if (name === 'HEAD') return { current: null, detached: true };
  return { current: name, detached: false };
}

export async function getStatus(cwd: string): Promise<GitStatus | { error: string }> {
  const res = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!res.ok) return { error: res.error };
  const entries: GitStatusEntry[] = [];
  const untracked: string[] = [];
  const tokens = res.stdout.split('\0').filter(Boolean);
  for (const token of tokens) {
    if (token.length < 3) continue;
    const index = token[0];
    const worktree = token[1];
    const path = token.slice(3);
    if (index === '?' && worktree === '?') untracked.push(path);
    else entries.push({ path, index, worktree });
  }
  return {
    staged: entries.filter(e => e.index !== ' ' && e.index !== '?'),
    unstaged: entries.filter(e => e.worktree !== ' ' && e.worktree !== '?'),
    untracked
  };
}

export async function getLog(cwd: string, n: number): Promise<GitCommit[] | { error: string }> {
  const sep = '\x1e';   // record separator
  const fsep = '\x1f';  // field separator
  const fmt = ['%H', '%P', '%s', '%an', '%at', '%D'].join(fsep) + sep;
  const res = await runGit(cwd, ['log', '--all', `--max-count=${n}`, `--pretty=format:${fmt}`]);
  if (!res.ok) return { error: res.error };
  const out: GitCommit[] = [];
  for (const rec of res.stdout.split(sep)) {
    if (!rec.trim()) continue;
    const [sha, parents, subject, author, atime, refs] = rec.split(fsep);
    if (!sha) continue;
    out.push({
      sha,
      shortSha: sha.slice(0, 7),
      parents: parents.split(' ').filter(Boolean),
      subject: subject ?? '',
      author: author ?? '',
      time: parseInt(atime, 10) || 0,
      refs: (refs ?? '').split(', ').map(s => s.trim()).filter(Boolean)
    });
  }
  return out;
}

export async function getBranches(cwd: string): Promise<{
  local: string[]; remote: string[]; current: string | null;
} | { error: string }> {
  const res = await runGit(cwd, ['branch', '-a', '--format=%(HEAD)\x1f%(refname:short)']);
  if (!res.ok) return { error: res.error };
  let current: string | null = null;
  const local: string[] = [];
  const remote: string[] = [];
  for (const line of res.stdout.split('\n')) {
    if (!line) continue;
    const [head, name] = line.split('\x1f');
    if (!name) continue;
    if (head.trim() === '*') current = name;
    if (name.startsWith('remotes/')) remote.push(name.replace(/^remotes\//, ''));
    else local.push(name);
  }
  return { local, remote, current };
}

export async function getAheadBehind(cwd: string): Promise<GitAheadBehind | { error: string }> {
  const up = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!up.ok) return { ahead: 0, behind: 0, upstream: null };
  const upstream = up.stdout.trim();
  const ab = await runGit(cwd, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
  if (!ab.ok) return { error: ab.error };
  const [ahead, behind] = ab.stdout.trim().split('\t').map(n => parseInt(n, 10) || 0);
  return { ahead, behind, upstream };
}

/** Best-effort detect: is `cwd` actually a git repo? */
export async function isRepo(cwd: string): Promise<boolean> {
  const res = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return res.ok && res.stdout.trim() === 'true';
}

export interface GitWorktree {
  path: string;
  branch: string | null;
  head: string;     // short sha
  isMain: boolean;  // the repo's primary tree — never offered for deletion
  locked: boolean;
}

/** Enumerate a repo's worktrees (the primary tree + every `git worktree add`). Parses
 *  `git worktree list --porcelain`. The FIRST entry is the main worktree (isMain). */
export async function listWorktrees(cwd: string): Promise<GitWorktree[] | { error: string }> {
  const res = await runGit(cwd, ['worktree', 'list', '--porcelain']);
  if (!res.ok) return { error: res.error };
  const out: GitWorktree[] = [];
  let cur: { path?: string; branch?: string | null; head?: string; locked?: boolean } | null = null;
  const flush = () => {
    if (cur?.path) {
      out.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? '', isMain: out.length === 0, locked: cur.locked === true });
    }
    cur = null;
  };
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) { flush(); cur = { path: line.slice(9).trim() }; }
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5).trim().slice(0, 7);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (cur && line.startsWith('locked')) cur.locked = true;
    else if (cur && line.trim() === '') flush();
  }
  flush();
  return out;
}

/** Preview what merging `branch` into the repo's current branch would bring: the commits
 *  not yet in base + a diffstat. Read-only — for the god's review before integrating. */
export async function previewMerge(
  repo: string, branch: string
): Promise<{ ok: true; base: string; commits: string; diffstat: string } | { ok: false; error: string }> {
  const br = await getBranch(repo);
  const base = 'current' in br && br.current ? br.current : 'HEAD';
  const log = await runGit(repo, ['log', '--oneline', `${base}..${branch}`]);
  if (!log.ok) return { ok: false, error: log.error };
  const stat = await runGit(repo, ['diff', '--stat', `${base}...${branch}`]);
  if (!stat.ok) return { ok: false, error: stat.error };
  return { ok: true, base, commits: log.stdout.trim(), diffstat: stat.stdout.trim() };
}

/** Merge `branch` into the repo's CURRENT branch (the main tree's base). On conflict (or
 *  any failure) the merge is ABORTED so the tree is left clean, and `conflict` is set so
 *  the caller can route the work back to the author instead of leaving a half-merge. */
export async function mergeBranch(
  repo: string, branch: string
): Promise<{ ok: true; base: string } | { ok: false; error: string; conflict?: boolean }> {
  const br = await getBranch(repo);
  const base = 'current' in br && br.current ? br.current : null;
  if (!base) return { ok: false, error: 'repo is in detached HEAD — cannot merge' };
  const res = await runGit(repo, ['merge', '--no-ff', '--no-edit', branch]);
  if (res.ok) return { ok: true, base };
  await runGit(repo, ['merge', '--abort']); // leave the tree clean on failure
  return { ok: false, error: res.error, conflict: /conflict/i.test(res.error) };
}

/** Derive a safe `agent/<id>` branch name from a worktree path's basename. Exported so
 *  the roster can report each isolated desk's branch for the god to integrate. */
export function agentBranchFor(wtPath: string): string {
  const base = wtPath.split(/[\\/]/).filter(Boolean).pop() ?? 'agent';
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
  return `agent/${slug}`;
}

/** Provision an isolated git worktree for an agent at `wtPath`, branching off
 *  `baseBranch`. Tries to create a fresh `agent/<id>` branch first; if that
 *  branch already exists, falls back to checking out `baseBranch` directly. */
export async function addWorktree(
  cwd: string, wtPath: string, baseBranch: string
): Promise<{ ok: boolean; error?: string }> {
  const branch = agentBranchFor(wtPath);
  const fresh = await runGit(cwd, ['worktree', 'add', wtPath, '-b', branch, baseBranch]);
  if (fresh.ok) return { ok: true };
  // Branch likely already exists (or the path is taken) — retry without -b.
  const fallback = await runGit(cwd, ['worktree', 'add', wtPath, baseBranch]);
  if (fallback.ok) return { ok: true };
  return { ok: false, error: fallback.error };
}

/** Best-effort removal of an agent's worktree. Forced so a dirty tree doesn't
 *  block teardown; failures are surfaced but callers may ignore them. */
export async function removeWorktree(
  cwd: string, wtPath: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await runGit(cwd, ['worktree', 'remove', '--force', wtPath]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.error };
}
