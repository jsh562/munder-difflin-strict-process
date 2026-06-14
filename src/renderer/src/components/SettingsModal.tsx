import { useState, useEffect, type CSSProperties } from 'react';
import type { HarnessConfig } from '@/store/config';
import { useStore } from '@/store/store';
import { ModalOverlay } from './ModalOverlay';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { ProviderModelPicker } from './ProviderModelPicker';
import { isAssignmentStale } from '@shared/assignment';
import { scheduleDeskRestart } from '@/lib/restartDesk';
import { restartSigOf, deskStaleKeys, RESTART_SIG_LABELS, type RestartSig } from '@/lib/restartSig';

export interface SettingsModalProps {
  config: HarnessConfig;
  onClose: () => void;
}

/** Slack fields live on the main-process config; the renderer mirror type doesn't
 *  declare them yet (same as `notifications`), so read them off a widened view. */
type SlackConfig = HarnessConfig & {
  slackEnabled?: boolean;
  slackSigningSecret?: string;
  slackChannelId?: string;
  slackPort?: number;
};

/** A small helper line under a settings row (indented to align past the 140px label column). */
const subLabelStyle: CSSProperties = {
  paddingLeft: 152,
  marginTop: -2,
  fontSize: 12,
  lineHeight: '16px',
  color: 'var(--cth-ink-500)'
};

/** Pixel-aesthetic text input, mirroring AddAgentModal's inputStyle. */
const slackInputStyle: CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 14,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};

const slackLabelStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 8,
  lineHeight: '12px',
  color: 'var(--cth-ink-700)',
  textTransform: 'uppercase'
};

/** Clear every renderer-side persisted key so a relaunch starts truly empty. */
function clearLocalState(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith('cth.')) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
  } catch { /* noop */ }
}

export function SettingsModal({ config, onClose }: SettingsModalProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // Change-home flow: null until the user picks a new folder, then the sub-modal
  // confirms move-vs-fresh. Pre-selects 'move' (recommended — keeps the data).
  const [changeHome, setChangeHome] = useState<string | null>(null);
  const [changeMode, setChangeMode] = useState<'move' | 'fresh'>('move');
  const [changeBusy, setChangeBusy] = useState(false);
  const [changeErr, setChangeErr] = useState('');
  // `notifications` is an optional field on the main-process config; the renderer
  // mirror type may not declare it yet, so read it defensively.
  const [notifications, setNotifications] = useState<boolean>(
    (config as HarnessConfig & { notifications?: boolean }).notifications === true
  );
  // Optional override for the native god's working directory; unset ⇒ auto
  // (`<harnessHome>/workspace`). Persisted to config; takes effect on the god's
  // next (re)spawn (useHive effect #1 re-runs on the change).
  const [godWorkspace, setGodWorkspace] = useState<string | undefined>(config.godWorkspace);

  const pickGodWorkspace = async () => {
    const res = await window.cth.chooseFolder();
    if (!res.ok) return; // cancelled
    setGodWorkspace(res.path);
    await window.cth.updateConfig({ godWorkspace: res.path });
  };
  const resetGodWorkspace = async () => {
    setGodWorkspace(undefined);
    await window.cth.updateConfig({ godWorkspace: undefined });
  };

  // Worktrees — isolated agents' worktrees are kept on exit; let the operator review +
  // bulk-delete stale ones. Loaded when the modal opens.
  type Worktree = { repo: string; path: string; branch: string | null; head: string; isMain: boolean; locked: boolean };
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [wtSelected, setWtSelected] = useState<Set<string>>(new Set());
  const [wtBusy, setWtBusy] = useState(false);
  // Armed when a delete press found unmerged work in the selection — requires a second
  // (confirm) press so committed-but-unintegrated work isn't lost by accident.
  const [wtConfirm, setWtConfirm] = useState<{ unmerged: number } | null>(null);
  const loadWorktrees = async () => {
    try { setWorktrees(await window.cth.listWorktrees()); } catch { setWorktrees([]); }
  };
  useEffect(() => { void loadWorktrees(); }, []);
  const toggleWt = (path: string) =>
    setWtSelected((s) => { const n = new Set(s); if (n.has(path)) n.delete(path); else n.add(path); return n; });
  // Changing the selection invalidates a pending confirm.
  useEffect(() => { setWtConfirm(null); }, [wtSelected]);
  const deleteSelectedWorktrees = async () => {
    const selected = worktrees.filter((w) => wtSelected.has(w.path));
    if (selected.length === 0) return;
    setWtBusy(true);
    try {
      // First press: warn if any selected worktree's branch has commits not merged into base.
      if (!wtConfirm) {
        let unmerged = 0;
        for (const wt of selected) {
          if (wt.branch && (await window.cth.gitBranchAhead(wt.repo, wt.branch)) > 0) unmerged++;
        }
        if (unmerged > 0) { setWtConfirm({ unmerged }); return; } // arm — require a confirm press
      }
      // Armed (confirmed) or nothing unmerged → delete.
      for (const wt of selected) {
        await window.cth.removeWorktree(wt.repo, wt.path).catch(() => { /* best-effort; keep going */ });
      }
      setWtSelected(new Set());
      setWtConfirm(null);
      await loadWorktrees();
    } finally { setWtBusy(false); }
  };

  // Project repos — the registered code repos the fleet works in (Add-Agent quick-picks,
  // read-roots, integrate allow-list). This is the post-onboarding manager (onboarding seeds
  // them once; there was no UI to add/remove afterward). Integration also auto-follows where
  // desks actually work, so a repo a desk sits in is integratable even without this list —
  // but registering one makes it a quick-pick + readable fleet-wide. Local state mirrors the
  // config so changes reflect immediately.
  const [projectRepos, setProjectRepos] = useState<string[]>(config.registeredRepos ?? []);
  const addProjectRepo = async () => {
    const res = await window.cth.chooseFolder();
    if (!res.ok || projectRepos.includes(res.path)) return;
    const next = [...projectRepos, res.path];
    setProjectRepos(next);
    await window.cth.updateConfig({ registeredRepos: next });
  };
  const removeProjectRepo = async (path: string) => {
    const next = projectRepos.filter((r) => r !== path);
    setProjectRepos(next);
    await window.cth.updateConfig({ registeredRepos: next });
  };

  const toggleNotifications = async () => {
    const next = !notifications;
    setNotifications(next); // optimistic
    try { await window.cth.setNotifications(next); }
    catch { setNotifications(!next); /* revert on failure */ }
  };

  // ─── Web search (native desks, Brave Search API) ────────────────────────────
  // `webSearchEnabled` is the operator gate (a config boolean); the API key rides the
  // credentials store under the reserved 'web-search' id (presence-only to the
  // renderer, redacted like any provider key). Reuses saveKey/removeKey/keyDraft.
  const WEB_SEARCH_KEY_ID = 'web-search';
  const [webSearchEnabled, setWebSearchEnabled] = useState<boolean>(
    (config as HarnessConfig & { webSearchEnabled?: boolean }).webSearchEnabled === true
  );
  const toggleWebSearch = async () => {
    const next = !webSearchEnabled;
    setWebSearchEnabled(next); // optimistic
    try { await window.cth.updateConfig({ webSearchEnabled: next }); }
    catch { setWebSearchEnabled(!next); /* revert on failure */ }
  };

  // ─── Native bash (native desks' shell tool) ─────────────────────────────────
  // Opt-in gate for the `bash` tool on DeepSeek/Minimax desks. OFF by default; even
  // when on, every call stays cwd-sandboxed + breaker-watched + destructive-guarded.
  const [nativeBashEnabled, setNativeBashEnabled] = useState<boolean>(
    (config as HarnessConfig & { nativeBashEnabled?: boolean }).nativeBashEnabled === true
  );
  const toggleNativeBash = async () => {
    const next = !nativeBashEnabled;
    setNativeBashEnabled(next); // optimistic
    try { await window.cth.updateConfig({ nativeBashEnabled: next }); }
    catch { setNativeBashEnabled(!next); /* revert on failure */ }
  };

  // SDDP (spec-driven) mode — a per-floor wholesale switch (prompts + roles + gates +
  // feature-phase banner). OFF by default; standard behaviour is unchanged when off.
  const [sddpMode, setSddpMode] = useState<boolean>(
    (config as HarnessConfig & { sddpMode?: boolean }).sddpMode === true
  );
  const toggleSddpMode = async () => {
    const next = !sddpMode;
    setSddpMode(next); // optimistic
    useStore.getState().setSddpMode(next); // mirror live so chips/banner/stale-detect update this session
    try { await window.cth.updateConfig({ sddpMode: next }); }
    catch { setSddpMode(!next); useStore.getState().setSddpMode(!next); /* revert on failure */ }
  };

  // ─── "Restart required" detection ────────────────────────────────────────────
  // The restart-required settings ([[restartSig]]) are baked into a desk at spawn, so a change
  // only applies on RESPAWN (not on resume/un-pause). Compare each live desk's spawn snapshot to
  // the live config and surface the desks owed a restart, with a one-click restart for them.
  const storeAgents = useStore((s) => s.agents);
  const liveSddp = useStore((s) => s.sddpMode);
  const liveAuto = useStore((s) => s.autoMode);
  const liveTheme = useStore((s) => s.terminalTheme);
  const liveSig: RestartSig = restartSigOf({ sddpMode: liveSddp, autoMode: liveAuto, terminalTheme: liveTheme });
  const staleDesks = storeAgents
    .map((a) => ({ a, keys: a.isAssistant ? [] : deskStaleKeys(a.spawnSig, liveSig) }))
    .filter((x) => x.keys.length > 0);
  const staleChangedKeys = Array.from(new Set(staleDesks.flatMap((x) => x.keys)));
  const restartStaleDesks = () => { for (const { a } of staleDesks) scheduleDeskRestart(a.id); };

  // ─── circuit-breaker config (Lane A #6 canonical fields, widened view) ───────
  // Drives Jim's real breaker: floor-wide TOKEN budget (costCapTokens) + output-
  // token velocity ceiling (circuitBreaker.tokenVelocityPerMin). The token cap
  // replaced the old dollar cap as the user-facing budget.
  type BreakerCfgView = HarnessConfig & {
    costCapTokens?: number;
    circuitBreaker?: { tokenVelocityPerMin?: number; enabled?: boolean; hardStop?: boolean; repeatedToolLimit?: number; errorStormLimit?: number };
  };
  const breakerCfg = config as BreakerCfgView;
  const [agentBudget, setAgentBudget] = useState(breakerCfg.costCapTokens != null ? String(breakerCfg.costCapTokens) : '');
  const [velocityCeiling, setVelocityCeiling] = useState(breakerCfg.circuitBreaker?.tokenVelocityPerMin != null ? String(breakerCfg.circuitBreaker.tokenVelocityPerMin) : '');
  const [budgetNote, setBudgetNote] = useState('');
  const saveBudget = async () => {
    // Empty input clears the cap (undefined = off).
    const tokens = agentBudget.trim() === '' ? undefined : Number(agentBudget);
    const vel = velocityCeiling.trim() === '' ? undefined : Number(velocityCeiling);
    await window.cth.updateConfig({
      costCapTokens: Number.isFinite(tokens as number) ? (tokens as number) : undefined,
      circuitBreaker: {
        ...(breakerCfg.circuitBreaker ?? {}),
        tokenVelocityPerMin: Number.isFinite(vel as number) ? (vel as number) : undefined
      }
    } as Partial<HarnessConfig>);
    setBudgetNote('saved');
    setTimeout(() => setBudgetNote(''), 1500);
  };
  // Live token-count formatting for the budget input hint (1K / 1M / 1B).
  const fmtBudgetTokens = (raw: string): string => {
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n <= 0) return '';
    if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
    return String(n);
  };

  // ─── Slack integration ─────────────────────────────────────────────────────
  const slackCfg = config as SlackConfig;
  const [slackEnabled, setSlackEnabled] = useState(slackCfg.slackEnabled ?? false);
  const [slackSecret, setSlackSecret] = useState(slackCfg.slackSigningSecret ?? '');
  const [slackChannel, setSlackChannel] = useState(slackCfg.slackChannelId ?? '');
  const [slackPort, setSlackPort] = useState(String(slackCfg.slackPort ?? 3847));
  const [tunnelUrl, setTunnelUrl] = useState('');
  const [slackBusy, setSlackBusy] = useState(false);
  const [slackNote, setSlackNote] = useState('');

  // Provider API keys (E004). The renderer only ever learns *presence* (true ⇒ a
  // key is stored) — raw key values never cross the bridge. Drafts are write-only.
  const [keyPresence, setKeyPresence] = useState<Record<string, boolean>>({});
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const [keyBusy, setKeyBusy] = useState<string | null>(null);
  const [keyNote, setKeyNote] = useState('');
  const refreshPresence = () =>
    window.cth.credentials.presence().then(setKeyPresence).catch(() => { /* keep last */ });

  const saveKey = async (providerId: string) => {
    const key = (keyDraft[providerId] ?? '').trim();
    if (!key) return;
    setKeyBusy(providerId); setKeyNote('');
    try {
      const res = await window.cth.credentials.set(providerId, key);
      if (res.ok) {
        setKeyDraft((d) => ({ ...d, [providerId]: '' }));
        setKeyNote(`${providerId} key saved`);
        await refreshPresence();
      } else {
        setKeyNote(res.error ?? 'failed to save');
      }
    } catch (e) {
      setKeyNote(e instanceof Error ? e.message : String(e));
    } finally { setKeyBusy(null); }
  };

  const removeKey = async (providerId: string) => {
    setKeyBusy(providerId); setKeyNote('');
    try {
      await window.cth.credentials.clear(providerId);
      setKeyNote(`${providerId} key cleared`);
      await refreshPresence();
    } catch (e) {
      setKeyNote(e instanceof Error ? e.message : String(e));
    } finally { setKeyBusy(null); }
  };

  // ─── Fleet default model (E005 / FR-005, FR-014) ─────────────────────────────
  // The house-wide default MODEL id (HarnessConfig.defaultModel). Reuses the same
  // ProviderModelPicker as the Add-Agent drawer; the provider is DERIVED from the
  // id (DR-1), never stored. Persisted via the existing config:update IPC (no new
  // secret path). Seeded from current config on open. Changing it is
  // NON-RETROACTIVE — only agents created afterward inherit it (DR-4/FR-006), which
  // the scope note below makes legible at the point of change (FR-014).
  const [fleetDefault, setFleetDefault] = useState<string | undefined>(config.defaultModel);
  const [fleetBusy, setFleetBusy] = useState(false);
  const [fleetNote, setFleetNote] = useState('');
  // A present-but-unresolvable stored default is STALE — preserve + flag it for
  // re-selection, never auto-remap (DR-5/DR-11).
  const fleetStale = isAssignmentStale(fleetDefault);

  const saveFleetDefault = async () => {
    setFleetBusy(true); setFleetNote('');
    try {
      await window.cth.fleetDefault.set(fleetDefault);
      setFleetNote('saved');
      setTimeout(() => setFleetNote(''), 1500);
    } catch (e) {
      setFleetNote(e instanceof Error ? e.message : String(e));
    } finally { setFleetBusy(false); }
  };

  const clearFleetDefault = async () => {
    setFleetBusy(true); setFleetNote('');
    try {
      await window.cth.fleetDefault.set(undefined);
      setFleetDefault(undefined);
      setFleetNote('cleared');
      setTimeout(() => setFleetNote(''), 1500);
    } catch (e) {
      setFleetNote(e instanceof Error ? e.message : String(e));
    } finally { setFleetBusy(false); }
  };

  // Re-seed every editable field from the on-disk config when the modal opens.
  // App's `config` prop is loaded once and never refreshed after a save, so
  // without this the saved budget / velocity / slack values show blank on reopen.
  useEffect(() => {
    let alive = true;
    window.cth.getConfig().then((c) => {
      if (!alive) return;
      const cc = c as BreakerCfgView & SlackConfig & { notifications?: boolean; webSearchEnabled?: boolean; nativeBashEnabled?: boolean; sddpMode?: boolean; godWorkspace?: string };
      setNotifications(cc.notifications === true);
      setWebSearchEnabled(cc.webSearchEnabled === true);
      setNativeBashEnabled(cc.nativeBashEnabled === true);
      setSddpMode(cc.sddpMode === true);
      setGodWorkspace(cc.godWorkspace);
      setAgentBudget(cc.costCapTokens != null ? String(cc.costCapTokens) : '');
      setVelocityCeiling(cc.circuitBreaker?.tokenVelocityPerMin != null ? String(cc.circuitBreaker.tokenVelocityPerMin) : '');
      setSlackEnabled(cc.slackEnabled ?? false);
      setSlackSecret(cc.slackSigningSecret ?? '');
      setSlackChannel(cc.slackChannelId ?? '');
      setSlackPort(String(cc.slackPort ?? 3847));
      // E005 — seed the fleet default from the freshly-read config (the prop is
      // loaded once and never refreshed after a save).
      const dm = (cc.defaultModel ?? '').trim();
      setFleetDefault(dm.length ? dm : undefined);
    }).catch(() => { /* keep prop-seeded values */ });
    window.cth.credentials.presence().then((p) => { if (alive) setKeyPresence(p); }).catch(() => { /* none */ });
    return () => { alive = false; };
  }, []);

  /** Persist the current Slack inputs. Returns the resolved config patch. */
  const slackPatch = (enabled: boolean) => ({
    signingSecret: slackSecret,
    channelId: slackChannel,
    port: Number(slackPort) || 3847,
    enabled
  });

  const saveSlack = async () => {
    setSlackBusy(true); setSlackNote('');
    try {
      await window.cth.slackSetConfig(slackPatch(slackEnabled));
      setSlackNote('saved');
    } catch (e) {
      setSlackNote(e instanceof Error ? e.message : String(e));
    } finally { setSlackBusy(false); }
  };

  const startSlack = async () => {
    setSlackBusy(true); setSlackNote('');
    try {
      // Persist first so the server starts with the latest secret/port/channel.
      await window.cth.slackSetConfig(slackPatch(true));
      setSlackEnabled(true);
      const res = await window.cth.slackStart();
      if (res.ok) {
        setTunnelUrl(res.url ?? '');
        setSlackNote(res.url ? 'listening' : (res.error ?? 'started, but tunnel unavailable'));
      } else {
        setSlackNote(res.error ?? 'failed to start');
      }
    } catch (e) {
      setSlackNote(e instanceof Error ? e.message : String(e));
    } finally { setSlackBusy(false); }
  };

  const stopSlack = async () => {
    setSlackBusy(true); setSlackNote('');
    try { await window.cth.slackStop(); setTunnelUrl(''); setSlackNote('stopped'); }
    catch (e) { setSlackNote(e instanceof Error ? e.message : String(e)); }
    finally { setSlackBusy(false); }
  };

  const copyTunnel = () => { void window.cth.copyToClipboard(tunnelUrl); };

  const reset = async () => {
    setBusy(true);
    clearLocalState();
    // Wipes hive + palace, resets config, and relaunches into onboarding.
    // The app exits, so this never resolves — no need to clear `busy`.
    await window.cth.resetAll();
  };

  // ─── Change home folder ─────────────────────────────────────────────────────
  /** Pick a new folder, then open the move-vs-fresh sub-modal. */
  const pickNewHome = async () => {
    setChangeErr('');
    const res = await window.cth.chooseFolder();
    if (!res.ok) return; // cancelled — no-op
    setChangeMode('move'); // recommended default
    setChangeHome(res.path);
  };

  /** Apply the home-folder change. On success the app relaunches (never resolves);
   *  on failure we surface the error and the existing home keeps running. */
  const applyChangeHome = async () => {
    if (!changeHome) return;
    setChangeBusy(true); setChangeErr('');
    // Moving copies the hive (incl. its .git) + palace, so the new home owns the
    // same renderer-side roster — keep localStorage. A 'fresh' home starts empty,
    // so clear the renderer cache to match.
    if (changeMode === 'fresh') clearLocalState();
    try {
      const res = await window.cth.changeHome(changeHome, changeMode);
      if (!res.ok) { setChangeErr(res.error ?? 'Could not change the home folder.'); setChangeBusy(false); }
      // ok === true never returns (the process relaunches).
    } catch (e) {
      setChangeErr(e instanceof Error ? e.message : String(e));
      setChangeBusy(false);
    }
  };

  const rows: Array<[string, string]> = [
    ['Auto mode', config.autoMode ? 'on' : 'off'],
    ['Semantic memory', config.semanticMemory ? 'on' : 'off'],
    ['Command', config.defaultCommand]
  ];

  return (
    <ModalOverlay
      title={changeHome ? 'CHANGE HOME FOLDER' : confirming ? 'RESET EVERYTHING?' : 'SETTINGS'}
      width={520}
      zIndex={300}
      onClose={onClose}
      closeOnBackdrop={!busy}
      footer={
        changeHome ? (
          <>
            <PixelButton variant="secondary" size="md" onClick={() => { setChangeHome(null); setChangeErr(''); }} disabled={changeBusy}>
              cancel
            </PixelButton>
            <PixelButton variant="primary" size="md" onClick={applyChangeHome} disabled={changeBusy}>
              {changeBusy ? 'applying…' : (changeMode === 'move' ? 'move & restart' : 'switch & restart')}
            </PixelButton>
          </>
        ) : !confirming ? (
          <>
            <PixelButton variant="secondary" size="md" onClick={onClose}>close</PixelButton>
            <PixelButton variant="destructive" size="md" onClick={() => setConfirming(true)}>
              reset &amp; start over
            </PixelButton>
          </>
        ) : (
          <>
            <PixelButton variant="secondary" size="md" onClick={() => setConfirming(false)} disabled={busy}>
              cancel
            </PixelButton>
            <PixelButton variant="destructive" size="md" onClick={reset} disabled={busy}>
              {busy ? 'resetting…' : 'erase everything & restart'}
            </PixelButton>
          </>
        )
      }
    >
      {changeHome ? (
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>New home folder</span>
                <code style={{
                  fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 13,
                  color: 'var(--cth-ink-900)', wordBreak: 'break-all'
                }}>{changeHome}</code>
              </div>

              {/* Move vs. fresh — two selectable option rows; move is preselected. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {([
                  ['move', 'Move existing data (recommended)', 'Copy this harness’s hive (every agent, memory, task) and the semantic-memory palace into the new folder. The old folder is left untouched as a backup you can delete later.'],
                  ['fresh', 'Start fresh', 'Point the harness at the new (empty) folder. Your existing data stays in the old folder, simply unused.']
                ] as const).map(([value, title, desc]) => {
                  const selected = changeMode === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setChangeMode(value)}
                      disabled={changeBusy}
                      style={{
                        textAlign: 'left', cursor: changeBusy ? 'default' : 'pointer',
                        padding: '10px 12px', background: 'var(--cth-paper-100)', border: 'none',
                        boxShadow: `inset 0 0 0 ${selected ? 2 : 1}px ${selected ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`,
                        display: 'flex', flexDirection: 'column', gap: 3
                      }}
                    >
                      <span style={{
                        fontSize: 14, lineHeight: '20px',
                        color: 'var(--cth-ink-900)', fontWeight: selected ? 700 : 400
                      }}>
                        {selected ? '◉ ' : '○ '}{title}
                      </span>
                      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>{desc}</span>
                    </button>
                  );
                })}
              </div>

              {changeErr && (
                <div style={{ fontSize: 13, lineHeight: '18px', color: '#6E1423' }}>{changeErr}</div>
              )}

            </div>
          ) : !confirming ? (
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* "Restart required" banner — desks running with settings that changed since they
                  spawned (these only apply on respawn; resuming a paused desk is NOT enough). */}
              {staleDesks.length > 0 && (
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
                  background: 'var(--cth-coral-light)', boxShadow: 'inset 0 0 0 1px var(--cth-coral)'
                }}>
                  <Icon name="bell" style={{ width: 16, height: 16, marginTop: 1, flexShrink: 0, color: 'var(--cth-ink-900)' }} />
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontSize: 14, lineHeight: '19px', color: 'var(--cth-ink-900)' }}>
                      {staleDesks.length} desk{staleDesks.length === 1 ? '' : 's'} running with outdated settings
                    </span>
                    <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
                      Changed since {staleDesks.length === 1 ? 'it' : 'they'} spawned: {staleChangedKeys.map((k) => RESTART_SIG_LABELS[k]).join(', ')}.
                      These apply on desk <b>restart</b> — resuming a paused desk is not enough.
                    </span>
                  </div>
                  <PixelButton variant="primary" size="sm" onClick={restartStaleDesks}>
                    restart {staleDesks.length === 1 ? 'desk' : 'desks'}
                  </PixelButton>
                </div>
              )}
              {/* Home folder — a dedicated row so it can carry a Change… action. */}
              <div style={{ display: 'flex', gap: 12, fontSize: 14, lineHeight: '20px', alignItems: 'center' }}>
                <span style={{ width: 140, flexShrink: 0, color: 'var(--cth-ink-500)' }}>Home folder</span>
                <span style={{
                  flex: 1, color: 'var(--cth-ink-900)', wordBreak: 'break-all',
                  fontFamily: 'var(--cth-font-mono, monospace)'
                }}>{config.harnessHome ?? '—'}</span>
                <PixelButton variant="secondary" size="sm" onClick={pickNewHome}>change…</PixelButton>
              </div>
              <div style={subLabelStyle}>Shared by every desk — holds the hive bookkeeping (board, tasks, each desk's memory + inbox). Not project code.</div>

              {/* Project repos — the registered code repos the fleet works in. The post-onboarding
                  manager (add/remove); also feeds Add-Agent quick-picks + read-roots. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ width: 140, flexShrink: 0, color: 'var(--cth-ink-500)', fontSize: 14 }}>Project repos</span>
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--cth-ink-500)' }}>
                    {projectRepos.length === 0 ? 'none registered yet' : `${projectRepos.length} repo${projectRepos.length === 1 ? '' : 's'}`}
                  </span>
                  <PixelButton variant="secondary" size="sm" onClick={() => void addProjectRepo()}>
                    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><Icon name="plus" /> add</span>
                  </PixelButton>
                </div>
                {projectRepos.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto', paddingLeft: 152 }}>
                    {projectRepos.map((r) => (
                      <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                        <Icon name="folder" />
                        <span style={{ flex: 1, fontFamily: 'var(--cth-font-mono, monospace)', color: 'var(--cth-ink-900)', wordBreak: 'break-all' }}>{r}</span>
                        <PixelButton variant="ghost" size="sm" onClick={() => void removeProjectRepo(r)}><Icon name="x" /></PixelButton>
                      </div>
                    ))}
                  </div>
                )}
                <div style={subLabelStyle}>The code repos your team works in. A desk's own workspace is integrated/read automatically — add other repos here. (A repo must be a git repo.)</div>
              </div>

              {/* God workspace — Michael's own scratch dir (native god), kept separate
                  from the hive bookkeeping. Unset ⇒ auto `<harnessHome>/workspace`. */}
              <div style={{ display: 'flex', gap: 12, fontSize: 14, lineHeight: '20px', alignItems: 'center' }}>
                <span style={{ width: 140, flexShrink: 0, color: 'var(--cth-ink-500)' }}>God workspace</span>
                <span style={{
                  flex: 1, color: godWorkspace ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)', wordBreak: 'break-all',
                  fontFamily: 'var(--cth-font-mono, monospace)'
                }}>{godWorkspace ?? `auto · ${config.harnessHome ?? '<home>'}${(config.harnessHome ?? '').includes('\\') ? '\\' : '/'}workspace`}</span>
                <PixelButton variant="secondary" size="sm" onClick={pickGodWorkspace}>change…</PixelButton>
                {godWorkspace && (
                  <PixelButton variant="secondary" size="sm" onClick={resetGodWorkspace}>reset</PixelButton>
                )}
              </div>
              <div style={subLabelStyle}>The god's own neutral folder (native god) — not a project. The god reads the project repos and delegates; give it a role to have it edit/merge directly.</div>

              {/* Worktrees — isolated agents' worktrees are kept on exit so committed work
                  survives for integration/review; this is where you bulk-clean stale ones. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ width: 140, flexShrink: 0, color: 'var(--cth-ink-500)', fontSize: 14 }}>Worktrees</span>
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--cth-ink-500)' }}>
                    {worktrees.length === 0 ? 'none — isolated agents create these per repo' : `${worktrees.length} isolated worktree${worktrees.length === 1 ? '' : 's'}`}
                  </span>
                  <PixelButton variant="secondary" size="sm" onClick={() => void loadWorktrees()} disabled={wtBusy}>refresh</PixelButton>
                  {wtSelected.size > 0 && (
                    <span title={wtConfirm ? `${wtConfirm.unmerged} of these have commits not merged into base — click again to delete anyway` : undefined}>
                      <PixelButton variant="destructive" size="sm" onClick={() => void deleteSelectedWorktrees()} disabled={wtBusy}>
                        {wtBusy ? 'deleting…' : wtConfirm ? `confirm delete (${wtConfirm.unmerged} unmerged)` : `delete ${wtSelected.size}`}
                      </PixelButton>
                    </span>
                  )}
                </div>
                {worktrees.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto', paddingLeft: 152 }}>
                    {worktrees.map((w) => (
                      <label key={w.path} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
                        <input type="checkbox" checked={wtSelected.has(w.path)} onChange={() => toggleWt(w.path)} />
                        <span style={{ fontFamily: 'var(--cth-font-mono, monospace)', color: 'var(--cth-ink-900)' }}>{w.branch ?? '(detached)'}</span>
                        <span style={{ color: 'var(--cth-ink-500)', wordBreak: 'break-all' }}>{w.path}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {rows.map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', gap: 12, fontSize: 14, lineHeight: '20px' }}>
                    <span style={{ width: 140, flexShrink: 0, color: 'var(--cth-ink-500)' }}>{label}</span>
                    <span style={{
                      color: 'var(--cth-ink-900)', wordBreak: 'break-all',
                      fontFamily: label === 'Home folder' || label === 'Command' ? 'var(--cth-font-mono, monospace)' : undefined
                    }}>{value}</span>
                  </div>
                ))}
              </div>

              {/* Desktop notifications toggle */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                    Desktop notifications
                  </span>
                  <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                    Native toasts when an agent finishes or needs your input.
                  </span>
                </div>
                <PixelButton
                  variant={notifications ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={toggleNotifications}
                >
                  {notifications ? 'on' : 'off'}
                </PixelButton>
              </div>

              <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

              {/* #7C.4 — cost / runaway circuit breaker */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                    Circuit breaker
                  </span>
                  <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                    Guard against runaway spend. Blank = off. The breaker steers, then constrains, then stops an agent that crosses these.
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...slackLabelStyle }}>
                    floor token budget
                    <input
                      type="number" min="0" step="100000" value={agentBudget}
                      onChange={(e) => setAgentBudget(e.target.value)}
                      placeholder="e.g. 1000000"
                      style={{ ...slackInputStyle, width: 160 }}
                    />
                    <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                      {fmtBudgetTokens(agentBudget) ? `= ${fmtBudgetTokens(agentBudget)} tokens` : 'total tokens across the floor'}
                    </span>
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...slackLabelStyle }}>
                    token velocity (tok/min)
                    <input
                      type="number" min="0" step="1000" value={velocityCeiling}
                      onChange={(e) => setVelocityCeiling(e.target.value)}
                      placeholder="e.g. 200000"
                      style={{ ...slackInputStyle, width: 160 }}
                    />
                  </label>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <PixelButton variant="secondary" size="sm" onClick={saveBudget}>save</PixelButton>
                  {budgetNote && <span style={{ fontSize: 12, color: 'var(--cth-mint)' }}>{budgetNote}</span>}
                </div>
              </div>

              <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

              {/* Slack integration */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                      Slack integration
                    </span>
                    <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                      Pipe a Slack channel's messages straight into Michael's queue.
                    </span>
                  </div>
                  <PixelButton
                    variant={slackEnabled ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={() => setSlackEnabled((v) => !v)}
                  >
                    {slackEnabled ? 'on' : 'off'}
                  </PixelButton>
                </div>

                {slackEnabled && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={slackLabelStyle}>Signing secret</span>
                      <input
                        type="password"
                        value={slackSecret}
                        onChange={(e) => setSlackSecret(e.target.value)}
                        placeholder="Slack app → Basic Information → Signing Secret"
                        style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                      />
                    </label>

                    <div style={{ display: 'flex', gap: 10 }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                        <span style={slackLabelStyle}>Channel id (optional)</span>
                        <input
                          value={slackChannel}
                          onChange={(e) => setSlackChannel(e.target.value)}
                          placeholder="C0123… or blank for any"
                          style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                        />
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 92 }}>
                        <span style={slackLabelStyle}>Port</span>
                        <input
                          type="number"
                          value={slackPort}
                          onChange={(e) => setSlackPort(e.target.value)}
                          placeholder="3847"
                          style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                        />
                      </label>
                    </div>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <PixelButton variant="primary" size="sm" onClick={startSlack} disabled={slackBusy || !slackSecret.trim()}>
                        {slackBusy ? '…' : 'start'}
                      </PixelButton>
                      <PixelButton variant="secondary" size="sm" onClick={stopSlack} disabled={slackBusy}>
                        stop
                      </PixelButton>
                      <PixelButton variant="ghost" size="sm" onClick={saveSlack} disabled={slackBusy}>
                        save
                      </PixelButton>
                      {slackNote && (
                        <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{slackNote}</span>
                      )}
                    </div>

                    {tunnelUrl && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={slackLabelStyle}>Request URL — paste into Slack Event Subscriptions</span>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <input
                            readOnly
                            value={tunnelUrl}
                            onFocus={(e) => e.currentTarget.select()}
                            style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 12 }}
                          />
                          <PixelButton variant="secondary" size="sm" onClick={copyTunnel}>copy</PixelButton>
                        </div>
                      </div>
                    )}

                    <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                      In your Slack app: enable Event Subscriptions → add the{' '}
                      <code>message.channels</code> / <code>message.groups</code> bot event → set the
                      Request URL above → reinstall to your workspace. The tunnel URL changes on every
                      restart, so re-paste it after pressing Start again.
                    </span>
                  </div>
                )}
              </div>

              <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

              {/* Provider API keys (E004) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                    Provider API keys
                  </span>
                  <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                    Keys for native providers (DeepSeek, Minimax). Stored locally outside the
                    hive and injected only into an agent's worker — never shown back or sent to git.
                  </span>
                </div>
                {Object.keys(keyPresence).filter((id) => id !== WEB_SEARCH_KEY_ID).length === 0 ? (
                  <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>No native providers registered.</span>
                ) : (
                  Object.keys(keyPresence).filter((id) => id !== WEB_SEARCH_KEY_ID).sort().map((providerId) => (
                    <div key={providerId} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                        <span style={slackLabelStyle}>
                          {providerId}{keyPresence[providerId] ? ' — key set' : ' — no key'}
                        </span>
                        <input
                          type="password"
                          value={keyDraft[providerId] ?? ''}
                          onChange={(e) => setKeyDraft((d) => ({ ...d, [providerId]: e.target.value }))}
                          placeholder={keyPresence[providerId] ? '•••••• (enter to replace)' : `${providerId} API key`}
                          style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                        />
                      </label>
                      <PixelButton
                        variant="primary"
                        size="sm"
                        onClick={() => saveKey(providerId)}
                        disabled={keyBusy === providerId || !(keyDraft[providerId] ?? '').trim()}
                      >
                        {keyBusy === providerId ? '…' : 'save'}
                      </PixelButton>
                      <PixelButton
                        variant="secondary"
                        size="sm"
                        onClick={() => removeKey(providerId)}
                        disabled={keyBusy === providerId || !keyPresence[providerId]}
                      >
                        clear
                      </PixelButton>
                    </div>
                  ))
                )}
                {keyNote && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{keyNote}</span>}
              </div>

              <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

              {/* Web search (native desks) — free, keyless via DuckDuckGo */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                      Web search (native desks)
                    </span>
                    <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                      Lets DeepSeek/Minimax desks use the <code>web_search</code> tool. Free and
                      keyless (via DuckDuckGo). Results are read into the agent&rsquo;s context (they
                      cost tokens), so it searches narrowly. Best-effort — DuckDuckGo may occasionally
                      rate-limit. Claude desks are unaffected.
                    </span>
                  </div>
                  <PixelButton
                    variant={webSearchEnabled ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={toggleWebSearch}
                  >
                    {webSearchEnabled ? 'on' : 'off'}
                  </PixelButton>
                </div>
              </div>

              <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

              {/* Native shell (bash) — opt-in tool for native desks */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                    Native shell (bash)
                  </span>
                  <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                    Lets DeepSeek/Minimax desks run the <code>bash</code> tool (builds, tests, git).
                    Off by default; even when on, every command stays scoped to the desk&rsquo;s working
                    directory, is watched by the circuit breaker, and screened by a destructive-command
                    guard. Claude desks are unaffected.
                  </span>
                </div>
                <PixelButton
                  variant={nativeBashEnabled ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={toggleNativeBash}
                >
                  {nativeBashEnabled ? 'on' : 'off'}
                </PixelButton>
              </div>

              <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

              {/* Spec-driven (SDDP) mode — per-floor wholesale switch */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                    Spec-driven mode (SDDP)
                  </span>
                  <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                    Desks follow the spec-driven lifecycle (Specify&rarr;Clarify&rarr;Plan&rarr;Tasks&rarr;Implement&rarr;QC&rarr;Integrate):
                    the <code>planner</code> and <code>qc</code> roles activate, role prompts switch to the SDDP variants, the
                    board shows a feature-phase banner, and phase gates are enforced. Off by default; standard behaviour is
                    unchanged when off. Applies on desk <b>restart</b> — the banner above lets you restart affected desks
                    (resuming a paused desk is not enough).
                  </span>
                </div>
                <PixelButton
                  variant={sddpMode ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={toggleSddpMode}
                >
                  {sddpMode ? 'on' : 'off'}
                </PixelButton>
              </div>

              <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

              {/* Fleet default model (E005 / FR-005, FR-014) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                    Fleet default model
                  </span>
                  <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                    The house default every new agent inherits when it doesn&rsquo;t pick its own
                    model. The provider is derived from the model. Leave unset to fall back to the
                    role-based default.
                  </span>
                  {/* FR-014 — non-retroactive scope note, legible at the point of change. */}
                  <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
                    Changing this applies to agents created afterward only — existing agents keep
                    their current model and are not changed.
                  </span>
                </div>

                <ProviderModelPicker
                  selectedModelId={fleetDefault}
                  onChange={setFleetDefault}
                  accent="mint"
                />

                {fleetStale && (
                  <span style={{ fontSize: 12, lineHeight: '16px', color: '#6E1423' }}>
                    The saved default (<code>{fleetDefault}</code>) is no longer in the registry —
                    pick a current model. New agents fall back to the role-based default until you do.
                  </span>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <PixelButton variant="secondary" size="sm" onClick={saveFleetDefault} disabled={fleetBusy}>
                    {fleetBusy ? '…' : 'save'}
                  </PixelButton>
                  <PixelButton
                    variant="ghost"
                    size="sm"
                    onClick={clearFleetDefault}
                    disabled={fleetBusy || !fleetDefault}
                  >
                    clear
                  </PixelButton>
                  {fleetNote && <span style={{ fontSize: 12, color: 'var(--cth-mint)' }}>{fleetNote}</span>}
                </div>
              </div>

              <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{
                  fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                  color: '#6E1423'
                }}>DANGER ZONE</div>
                <p style={{ margin: 0, fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-700)' }}>
                  Reset wipes Michael's memories, the entire hive (every agent, message,
                  task, and the board), the semantic-memory palace, and all settings —
                  then takes you back to onboarding.
                </p>
              </div>

            </div>
          ) : (
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{
                  width: 32, height: 32,
                  background: 'var(--cth-coral-light)',
                  boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0
                }}>
                  <Icon name="bell" />
                </div>
                <div style={{ flex: 1, fontSize: 15, lineHeight: '22px', color: 'var(--cth-ink-700)' }}>
                  This permanently erases all of Michael's memories and the entire hive,
                  and cannot be undone. Any running sessions will be terminated and the app
                  will relaunch into onboarding. Are you sure?
                </div>
              </div>

            </div>
          )}
    </ModalOverlay>
  );
}
