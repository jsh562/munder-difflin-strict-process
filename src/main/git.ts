import { spawn } from 'node:child_process';
import { join, resolve, sep } from 'node:path';

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

/** Derive a safe `agent/<slug>` branch name from a raw segment (an agent id or a worktree path
 *  basename). The single slug rule shared by the path-based + id-based helpers below. */
export function agentBranchForId(seg: string): string {
  const slug = seg.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
  return `agent/${slug}`;
}

/** Derive a safe `agent/<id>` branch name from a worktree path's basename. Exported so
 *  the roster can report each isolated desk's branch for the god to integrate. */
export function agentBranchFor(wtPath: string): string {
  return agentBranchForId(wtPath.split(/[\\/]/).filter(Boolean).pop() ?? 'agent');
}

/** How many commits `branch` is AHEAD of the integration TRUNK — i.e. unmerged work that would be
 *  lost if the branch's worktree were deleted. `base` defaults to `repoTrunk(repo)` (NOT the base
 *  tree's possibly-stray current branch). 0 when merged, missing, or on error (best-effort: a
 *  failed/unknown branch never blocks the operator's delete). */
export async function branchCommitsAhead(repo: string, branch: string, base?: string): Promise<number> {
  const trunk = base ?? await repoTrunk(repo);
  if (!trunk || trunk === branch) return 0;
  const res = await runGit(repo, ['rev-list', '--count', `${trunk}..${branch}`]);
  if (!res.ok) return 0;
  return parseInt(res.stdout.trim(), 10) || 0;
}

/**
 * The repo's INTEGRATION TRUNK — the branch new agent worktrees should be based on, and the branch
 * the base tree should sit on. Prefer the base tree's current branch when it's a real trunk (NOT an
 * `agent/*` worktree branch — which would poison every new worktree); else a conventional `main`/
 * `master`, else the first non-`agent/*` local branch; fallback `main`. Read-only.
 */
export async function repoTrunk(repo: string): Promise<string> {
  const br = await getBranch(repo);
  const current = 'current' in br && br.current ? br.current : null;
  if (current && !current.startsWith('agent/')) return current;
  const branches = await getBranches(repo);
  if (!('error' in branches)) {
    for (const cand of ['main', 'master']) if (branches.local.includes(cand)) return cand;
    const firstNonAgent = branches.local.find((b) => !b.startsWith('agent/'));
    if (firstNonAgent) return firstNonAgent;
  }
  return current ?? 'main';
}

/** Small deterministic hash (djb2 → base36) — repo-discriminates a worktree path when a
 *  desk changes project, so its new worktree can't collide with an old repo's at the same id. */
export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export interface WorktreePlan {
  /** reattach = reuse an existing worktree (no git op); create = `addWorktree`; skip = run in
   *  the shared cwd (no isolation). */
  action: 'reattach' | 'create' | 'skip';
  path: string;
}

/**
 * Decide a worker desk's worktree WITHOUT touching git/fs (pure → unit-testable). A desk's
 * worktree path is keyed by its (slugified) agent id, so:
 *  - if a worktree for this agent is already REGISTERED to `origCwd` → **reattach** (a restart
 *    of an isolated desk must reuse it, not try to re-create it — independent of `forceNew`);
 *  - if the primary path is taken on disk by a DIFFERENT repo (a workspace change) → use a
 *    repo-hashed fallback path (reattach there if registered, else create) so the two repos'
 *    worktrees never collide;
 *  - otherwise **create** a fresh worktree, but only when isolation is wanted (`forceNew`);
 *  - an unsafe (escaping) path → **skip**.
 * `registered` = resolved paths git reports as worktrees of `origCwd`; `exists` = a disk check.
 */
export function planWorktree(args: {
  wtRoot: string; agentId: string; origCwd: string; forceNew: boolean;
  registered: string[]; exists: (p: string) => boolean;
}): WorktreePlan {
  const { wtRoot, agentId, origCwd, forceNew, registered, exists } = args;
  const seg = agentId.replace(/[^A-Za-z0-9._-]/g, '-');
  const under = (p: string) => resolve(p).startsWith(resolve(wtRoot) + sep);
  const reg = new Set(registered.map((p) => resolve(p)));
  const primary = join(wtRoot, seg);
  if (!under(primary)) return { action: 'skip', path: primary };
  if (reg.has(resolve(primary))) return { action: 'reattach', path: primary };
  const collision = exists(primary); // taken on disk but not a worktree of this repo
  const target = collision ? join(wtRoot, `${seg}-${shortHash(origCwd)}`) : primary;
  if (collision && !under(target)) return { action: 'skip', path: target };
  if (collision && reg.has(resolve(target))) return { action: 'reattach', path: target };
  if (!forceNew) return { action: 'skip', path: target };
  return { action: 'create', path: target };
}

/** Provision an isolated git worktree for an agent at `wtPath` on its `agent/<id>` branch. Creates
 *  the branch fresh off `baseBranch` (the trunk); if the branch already EXISTS, attaches THAT branch
 *  to the worktree (restart/reattach when only the branch survived). `inUse` is set when the branch
 *  is checked out elsewhere (e.g. the base tree holds it) so the caller can degrade + surface a
 *  migrate action instead of erroring. */
export async function addWorktree(
  cwd: string, wtPath: string, baseBranch: string
): Promise<{ ok: boolean; error?: string; inUse?: boolean }> {
  const branch = agentBranchFor(wtPath);
  const fresh = await runGit(cwd, ['worktree', 'add', wtPath, '-b', branch, baseBranch]);
  if (fresh.ok) return { ok: true };
  // Branch already exists → attach IT (not the trunk) to the new worktree.
  const attach = await runGit(cwd, ['worktree', 'add', wtPath, branch]);
  if (attach.ok) return { ok: true };
  const error = attach.error || fresh.error;
  const inUse = /already (used|checked out)|already used by worktree/i.test(error);
  return { ok: false, error, inUse };
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

/** Best-effort delete of a per-task branch AFTER it's been merged — `git branch -d` (safe: only
 *  deletes a branch fully merged into the current/trunk HEAD; refuses if it's still checked out in
 *  a worktree or not merged). Callers ignore failures (the merge already succeeded). */
export async function deleteMergedBranch(repo: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  const res = await runGit(repo, ['branch', '-d', branch]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.error };
}

/**
 * Provision a throwaway QC-INTEGRATION worktree: a detached worktree at `base` (the trunk) into which
 * each implement-card `branch` is merged, so the QC suite runs against the INTEGRATED result without
 * touching trunk. This is what resolves the `.qc-passed`↔integrate deadlock (QC needs merged code; the
 * merge can't happen on trunk until QC passes). Any stale tree at `wtPath` is removed first. A branch
 * that conflicts is `merge --abort`ed and reported in `conflicts` (the caller routes it back to its
 * author) — the rest still merge so QC can report on what it can. Best-effort; never throws.
 */
export async function prepareQcTree(
  repo: string, wtPath: string, base: string, branches: string[]
): Promise<{ ok: boolean; merged: string[]; conflicts: string[]; error?: string }> {
  await removeWorktree(repo, wtPath); // drop any stale tree (best-effort)
  const add = await runGit(repo, ['worktree', 'add', '--detach', wtPath, base]);
  if (!add.ok) return { ok: false, merged: [], conflicts: [], error: add.error };
  const merged: string[] = [];
  const conflicts: string[] = [];
  for (const br of branches) {
    if (!br) continue;
    const m = await runGit(wtPath, ['merge', '--no-ff', '--no-edit', br]);
    if (m.ok) merged.push(br);
    else { await runGit(wtPath, ['merge', '--abort']); conflicts.push(br); }
  }
  return { ok: true, merged, conflicts };
}

// ─── Worktree diagnostics + recovery (Settings → Worktrees) ──────────────────

/** A health flag for a worktree row in the operator diagnostics. */
export type WorktreeFlag = 'main' | 'not-isolated' | 'dirty' | 'unmerged' | 'detached' | 'locked';

export interface WorktreeHealthEntry {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  locked: boolean;
  /** changed + staged + untracked file count in the worktree (0 = clean). */
  dirty: number;
  /** commits ahead of the trunk (unmerged work). */
  ahead: number;
  /** the desk id, when the branch is `agent/<id>`. */
  agentId: string | null;
  flags: WorktreeFlag[];
}

export interface RepoWorktreeHealth {
  repo: string;
  trunk: string;
  /** the base tree's current branch (the integration target — should equal `trunk`). */
  baseBranch: string | null;
  /** true when the base tree is sitting on an `agent/*` branch (misconfigured integration target). */
  baseOnAgentBranch: boolean;
  worktrees: WorktreeHealthEntry[];
}

/** Pure flag classification (unit-tested) — keeps the diagnostics logic free of git I/O. */
export function classifyWorktree(w: {
  isMain: boolean; branch: string | null; dirty: number; ahead: number; locked: boolean;
}): WorktreeFlag[] {
  const flags: WorktreeFlag[] = [];
  if (w.isMain) flags.push('main');
  if (w.isMain && w.branch?.startsWith('agent/')) flags.push('not-isolated'); // an agent branch sits in the base tree
  if (!w.branch) flags.push('detached');
  if (w.dirty > 0) flags.push('dirty');
  if (w.ahead > 0) flags.push('unmerged');
  if (w.locked) flags.push('locked');
  return flags;
}

/** The desk id behind an `agent/<id>` branch (else null). */
function agentIdFromBranch(branch: string | null): string | null {
  return branch && branch.startsWith('agent/') ? branch.slice('agent/'.length) : null;
}

/** Read-only health of every worktree of `repo` (for the operator diagnostics table). */
export async function worktreeHealth(repo: string): Promise<RepoWorktreeHealth> {
  const trunk = await repoTrunk(repo);
  const br = await getBranch(repo);
  const baseBranch = 'current' in br && br.current ? br.current : null;
  const wts = await listWorktrees(repo);
  const list = Array.isArray(wts) ? wts : [];
  const worktrees: WorktreeHealthEntry[] = [];
  for (const w of list) {
    const st = await getStatus(w.path);
    const dirty = 'error' in st ? 0 : st.staged.length + st.unstaged.length + st.untracked.length;
    const ahead = w.branch && w.branch !== trunk ? await branchCommitsAhead(repo, w.branch, trunk) : 0;
    worktrees.push({
      path: w.path, branch: w.branch, head: w.head, isMain: w.isMain, locked: w.locked,
      dirty, ahead, agentId: agentIdFromBranch(w.branch),
      flags: classifyWorktree({ isMain: w.isMain, branch: w.branch, dirty, ahead, locked: w.locked })
    });
  }
  return { repo, trunk, baseBranch, baseOnAgentBranch: !!baseBranch?.startsWith('agent/'), worktrees };
}

/**
 * Put the base tree back on the trunk (the integration target). When the base tree sits on a stray
 * `agent/*` branch, this restores the proper model: any uncommitted base-tree state (incl. a
 * wiped/staged-deleted dir) is STASHED first (recoverable via `git stash` — nothing discarded),
 * then the base tree is checked out onto the trunk. The agent branch's COMMITS are untouched (they
 * stay on the branch); an author desk whose branch is freed re-isolates onto it on next spawn.
 * No-op when already on the trunk. Best-effort + reported.
 */
export async function resetBaseToTrunk(repo: string): Promise<{ ok: boolean; stashed: boolean; error?: string }> {
  const trunk = await repoTrunk(repo);
  const br = await getBranch(repo);
  const current = 'current' in br && br.current ? br.current : null;
  if (current === trunk) return { ok: true, stashed: false };
  if (!trunk || trunk === current) return { ok: false, stashed: false, error: `no distinct trunk to move onto (on ${current ?? 'detached HEAD'})` };
  const st = await getStatus(repo);
  const dirty = !('error' in st) && (st.staged.length + st.unstaged.length + st.untracked.length) > 0;
  let stashed = false;
  if (dirty) {
    const s = await runGit(repo, ['stash', 'push', '-u', '-m', `harness: reset base to ${trunk} (was ${current})`]);
    if (!s.ok) return { ok: false, stashed: false, error: `stash failed: ${s.error}` };
    stashed = true;
  }
  const co = await runGit(repo, ['checkout', trunk]);
  if (!co.ok) return { ok: false, stashed, error: `checkout ${trunk} failed: ${co.error}` };
  return { ok: true, stashed };
}
