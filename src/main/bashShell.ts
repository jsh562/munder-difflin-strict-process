/**
 * Host-side shell detection for the native `bash` tool.
 *
 * The package's `bash` tool runs `child_process.exec(command, { cwd, shell })`. With no
 * `shell`, Node defaults to cmd.exe on Windows — so the model's Unix commands
 * (ls/head/find/pipes) fail. This module finds a REAL bash so the tool honors its name,
 * and produces a one-line environment briefing for the agent preamble so each desk uses
 * the right command style on the first try.
 *
 * On Windows we prefer **Git Bash** (Windows-path aware, ships coreutils) and
 * deliberately AVOID `C:\Windows\System32\bash.exe` (that's WSL — it remaps the cwd into
 * `/mnt/...`, which would break the cwd sandbox). Fallback order: Git Bash → PowerShell →
 * cmd. On unix: /bin/bash → $SHELL → /bin/sh.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

export type BashShellKind = 'bash' | 'powershell' | 'cmd' | 'sh';
export interface BashEnv {
  /** Absolute shell path to pass to `exec({ shell })`, or undefined for the OS default. */
  shell: string | undefined;
  kind: BashShellKind;
}

let cached: BashEnv | undefined;

/** Detect the best shell for the `bash` tool (cached — shells don't change at runtime). */
export function resolveBashEnv(): BashEnv {
  if (!cached) cached = process.platform === 'win32' ? resolveWindows() : resolveUnix();
  return cached;
}

function resolveWindows(): BashEnv {
  const candidates: string[] = [];
  // Derive Git Bash from the git executable (handles non-standard install dirs):
  // <git>\cmd\git.exe → <git>\bin\bash.exe. `where` runs via cmd.exe (shell:true).
  try {
    const r = spawnSync('where', ['git'], { encoding: 'utf8', timeout: 3000, shell: true });
    const gitPath = (r.stdout ?? '').trim().split(/\r?\n/)[0];
    if (gitPath && existsSync(gitPath)) candidates.push(join(dirname(dirname(gitPath)), 'bin', 'bash.exe'));
  } catch {
    /* fall through to static candidates */
  }
  candidates.push(
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Git\\bin\\bash.exe`
  );
  for (const c of candidates) if (c && existsSync(c)) return { shell: c, kind: 'bash' };
  // No Git Bash — prefer PowerShell over cmd (the model has stronger PowerShell recall).
  const ps = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  if (existsSync(ps)) return { shell: ps, kind: 'powershell' };
  return { shell: undefined, kind: 'cmd' };
}

function resolveUnix(): BashEnv {
  for (const p of ['/bin/bash', '/usr/bin/bash', process.env.SHELL]) {
    if (p && existsSync(p)) return { shell: p, kind: 'bash' };
  }
  return { shell: undefined, kind: 'sh' };
}

/** A one-line environment briefing appended to the native preamble so the desk uses the
 *  right command style for its shell on the first try. Stable per machine (does not bust
 *  the prompt cache). */
export function describeBashEnv(env: BashEnv = resolveBashEnv()): string {
  const os = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  switch (env.kind) {
    case 'bash':
      return (
        `Environment: your \`bash\` tool runs in a real Bash shell on ${os}. Use standard Unix ` +
        `commands (ls, cat, grep, find, head, sed, awk, pipes)` +
        (process.platform === 'win32' ? '; Windows drives appear as /c, /d, etc.' : '.')
      );
    case 'powershell':
      return (
        `Environment: your \`bash\` tool runs in PowerShell on ${os} (no Bash installed). Use ` +
        `PowerShell cmdlets — Get-ChildItem (not ls), Select-String (not grep), Get-Content (not ` +
        `cat), Select-Object -First N (not head). Unix coreutils are NOT available.`
      );
    case 'cmd':
      return (
        `Environment: your \`bash\` tool runs in cmd.exe on ${os} (no Bash/PowerShell found). Use ` +
        `Windows commands — dir (not ls), type (not cat), findstr (not grep). Unix coreutils are NOT available.`
      );
    case 'sh':
      return `Environment: your \`bash\` tool runs in /bin/sh on ${os}. Standard POSIX/Unix commands work.`;
  }
}
