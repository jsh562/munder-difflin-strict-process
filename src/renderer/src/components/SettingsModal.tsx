import { useState, useEffect, type CSSProperties } from 'react';
import type { HarnessConfig } from '@/store/config';
import { ModalOverlay } from './ModalOverlay';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { ProviderModelPicker } from './ProviderModelPicker';
import { isAssignmentStale } from '@shared/assignment';

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
      const cc = c as BreakerCfgView & SlackConfig & { notifications?: boolean; webSearchEnabled?: boolean; nativeBashEnabled?: boolean };
      setNotifications(cc.notifications === true);
      setWebSearchEnabled(cc.webSearchEnabled === true);
      setNativeBashEnabled(cc.nativeBashEnabled === true);
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
              {/* Home folder — a dedicated row so it can carry a Change… action. */}
              <div style={{ display: 'flex', gap: 12, fontSize: 14, lineHeight: '20px', alignItems: 'center' }}>
                <span style={{ width: 140, flexShrink: 0, color: 'var(--cth-ink-500)' }}>Home folder</span>
                <span style={{
                  flex: 1, color: 'var(--cth-ink-900)', wordBreak: 'break-all',
                  fontFamily: 'var(--cth-font-mono, monospace)'
                }}>{config.harnessHome ?? '—'}</span>
                <PixelButton variant="secondary" size="sm" onClick={pickNewHome}>change…</PixelButton>
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

              {/* Web search (native desks) — Brave Search API */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                      Web search (native desks)
                    </span>
                    <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                      Lets DeepSeek/Minimax desks use the <code>web_search</code> tool via the Brave
                      Search API. Results are read into the agent&rsquo;s context (they cost tokens), so
                      it searches narrowly. Claude desks are unaffected.
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
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                    <span style={slackLabelStyle}>
                      Brave Search API key{keyPresence[WEB_SEARCH_KEY_ID] ? ' — key set' : ' — no key'}
                    </span>
                    <input
                      type="password"
                      value={keyDraft[WEB_SEARCH_KEY_ID] ?? ''}
                      onChange={(e) => setKeyDraft((d) => ({ ...d, [WEB_SEARCH_KEY_ID]: e.target.value }))}
                      placeholder={keyPresence[WEB_SEARCH_KEY_ID] ? '•••••• (enter to replace)' : 'Brave Search API key'}
                      style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                    />
                  </label>
                  <PixelButton
                    variant="primary"
                    size="sm"
                    onClick={() => saveKey(WEB_SEARCH_KEY_ID)}
                    disabled={keyBusy === WEB_SEARCH_KEY_ID || !(keyDraft[WEB_SEARCH_KEY_ID] ?? '').trim()}
                  >
                    {keyBusy === WEB_SEARCH_KEY_ID ? '…' : 'save'}
                  </PixelButton>
                  <PixelButton
                    variant="secondary"
                    size="sm"
                    onClick={() => removeKey(WEB_SEARCH_KEY_ID)}
                    disabled={keyBusy === WEB_SEARCH_KEY_ID || !keyPresence[WEB_SEARCH_KEY_ID]}
                  >
                    clear
                  </PixelButton>
                </div>
                <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                  Get a free key at <code>brave.com/search/api</code> (the free tier covers personal use).
                  The key is stored locally and never shown back or sent to git.
                </span>
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
