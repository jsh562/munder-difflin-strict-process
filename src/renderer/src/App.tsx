import { useEffect, useState } from 'react';
import { useStore, selectedAgent } from '@/store/store';
import { restartSigOf, deskStaleKeys } from '@/lib/restartSig';
import { FleetControls } from '@/components/FleetControls';
import { startMockLoop, stopMockLoop } from '@/store/mockEvents';
import type { HarnessConfig } from '@/store/config';
import { OfficeFloor } from '@/scene/office/OfficeFloor';
import { useHive } from '@/hooks/useHive';
import { MemoryPanel } from '@/components/MemoryPanel';
import { TaskBoardOverlay } from '@/components/TaskBoardOverlay';
import { AgentDetailPanel } from '@/components/AgentDetailPanel';
import { AgentStrip } from '@/components/AgentStrip';
import { AddAgentModal } from '@/components/AddAgentModal';
import { MichaelBooting } from '@/components/MichaelBooting';
import { OnboardingWizard } from '@/components/OnboardingWizard';
import { QuitWarningModal } from '@/components/QuitWarningModal';
import { SettingsModal } from '@/components/SettingsModal';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { Icon } from '@/components/Icon';
import { SidebarSplitter } from '@/components/SidebarSplitter';
import { acquireTerminal } from '@/components/terminalPool';
import { FullscreenTerminal } from '@/components/FullscreenTerminal';
import { FullscreenFileEditor } from '@/components/FullscreenFileEditor';
import brandLogo from '@brand/logo.png?url';

export function App() {
  const agent = useStore(selectedAgent);
  const agents = useStore(s => s.agents);
  const agentCount = agents.length;
  const addAgentOpen = useStore(s => s.addAgentOpen);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const godStatus = useStore(s => s.godStatus);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const fullscreenFilePath = useStore(s => s.fullscreenFilePath);
  const tasksBoardOpen = useStore(s => s.tasksBoardOpen);
  const sidebarWidth = useStore(s => s.sidebarWidth);
  const setSidebarWidth = useStore(s => s.setSidebarWidth);
  // How many live desks are running with outdated restart-required settings (e.g. SDDP toggled
  // after they spawned) — drives the badge on the settings gear. The assistant is exempt.
  const staleDeskCount = useStore((s) => {
    const live = restartSigOf({ sddpMode: s.sddpMode, autoMode: s.autoMode, terminalTheme: s.terminalTheme });
    return s.agents.filter((a) => !a.isAssistant && deskStaleKeys(a.spawnSig, live).length > 0).length;
  });

  const [config, setConfig] = useState<HarnessConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quitWarn, setQuitWarn] = useState<{ ptyCount: number } | null>(null);
  const [vpWidth, setVpWidth] = useState<number>(window.innerWidth);

  // Initial config load
  useEffect(() => {
    let cancelled = false;
    window.cth.getConfig().then(c => {
      if (cancelled) return;
      setConfig(c);
      // Mirror the fleet-default model into the store so the runtime-kind check can
      // apply the same fallback the main spawn router uses for model-less desks (god).
      useStore.getState().setFleetDefaultModel((c as { defaultModel?: string }).defaultModel ?? null);
      // Mirror the restart-required settings (restartSig) so the renderer can flag desks running
      // with outdated settings. sddpMode + autoMode + terminalTheme are baked into a desk at spawn.
      useStore.getState().setSddpMode((c as { sddpMode?: boolean }).sddpMode === true);
      useStore.getState().setAutoMode(c.autoMode === true);
      useStore.getState().setTerminalTheme((c as { terminalTheme?: 'light' | 'dark' }).terminalTheme === 'dark' ? 'dark' : 'light');
    });
    return () => { cancelled = true; };
  }, []);

  // Quit warning subscription
  useEffect(() => window.cth.onCloseRequested((info) => setQuitWarn(info)), []);

  // The hive: god-agent bootstrap, hook-driven avatars, idle-agent waking.
  useHive(config);

  // Pre-warm a persistent terminal for every live agent so its output is
  // buffered from spawn. Switching agents then re-attaches an already-rendered
  // terminal instantly (with full history) instead of building a blank one.
  useEffect(() => {
    for (const a of agents) if (a.ptyId) acquireTerminal(a.ptyId);
  }, [agents]);

  // Synthetic demo loop — CAGED (#5B). It must never animate alongside a live
  // hive (it would fire fake envelope handoffs and step seeded agents). Run it
  // only as an explicit showcase (VITE_CTH_DEMO=1 in dev) or on a genuinely
  // empty floor, and stop it the instant the first real PTY agent appears
  // (Michael always spawns, so in normal operation it effectively never runs).
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const DEMO = import.meta.env.DEV && import.meta.env.VITE_CTH_DEMO === '1';
    const evaluate = () => {
      const hasLive = useStore.getState().agents.some((a) => a.ptyId);
      if (DEMO || !hasLive) startMockLoop();
      else stopMockLoop();
    };
    evaluate();
    const unsub = useStore.subscribe(evaluate);
    return () => { unsub(); stopMockLoop(); };
  }, [config?.onboardingComplete]);

  // Reconcile restored agents against the PTYs still alive in the main process.
  // After a renderer reload (e.g. the laptop slept and Vite reloaded the page),
  // this keeps agents whose process survived and drops any that truly died.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    let cancelled = false;
    window.cth.listPtys().then((list) => {
      if (cancelled) return;
      useStore.getState().reconcileWithLivePtys(list.map((p) => p.id));
    }).catch(() => { /* ignore — keep restored agents as-is */ });
    return () => { cancelled = true; };
  }, [config?.onboardingComplete]);

  // Track viewport width for splitter clamping
  useEffect(() => {
    const onResize = () => setVpWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!config) {
    return <div style={{ width: '100vw', height: '100vh', background: 'var(--cth-cream-100)' }} />;
  }

  if (!config.onboardingComplete) {
    return <OnboardingWizard onComplete={(next) => setConfig(next)} />;
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      width: '100vw', height: '100vh',
      overflow: 'hidden'
    }}>
      {/* Title bar */}
      <div
        className="cth-titlebar-drag"
        style={{
          height: 36, minHeight: 36,
          background: 'linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%)',
          borderBottom: '2px solid var(--cth-ink-900)',
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 96,
          paddingRight: 12,
          gap: 12,
          userSelect: 'none'
        }}
      >
        <img
          src={brandLogo}
          alt="Munder Difflin"
          style={{ height: 20, width: 'auto', display: 'block' }}
        />
        <span style={{
          fontFamily: 'var(--cth-font-ui)',
          fontSize: 14,
          color: 'var(--cth-ink-500)'
        }}>
          v0.1 · {config.autoMode ? 'auto mode on' : 'auto mode off'}
        </span>
        {/* Right cluster: fleet-wide pause/stop controls, then the settings gear. */}
        <div className="cth-titlebar-nodrag" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <FleetControls />
        </div>
        <button
          className="cth-titlebar-nodrag cth-settings-btn"
          onClick={() => setSettingsOpen(true)}
          title={staleDeskCount > 0
            ? `${staleDeskCount} desk${staleDeskCount === 1 ? '' : 's'} running with outdated settings — open Settings to restart`
            : 'Settings'}
          aria-label="Settings"
          style={{
            position: 'relative',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-900)',
            border: 'none', borderRadius: 2, cursor: 'pointer',
            color: 'var(--cth-ink-900)'
          }}
        >
          <Icon name="gear" size={1} style={{ width: 18, height: 18 }} />
          {/* "Restart required" badge: a desk is running with settings that changed since it
              spawned (applies only on respawn). Coral dot + count, like an unread badge. */}
          {staleDeskCount > 0 && (
            <span
              style={{
                position: 'absolute', top: -5, right: -5, minWidth: 14, height: 14, padding: '0 3px',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--cth-coral)', color: 'var(--cth-ink-900)',
                boxShadow: '0 0 0 1.5px var(--cth-ink-900)', borderRadius: 7,
                fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '14px'
              }}
            >{staleDeskCount}</span>
          )}
        </button>
      </div>

      <div style={{
        flex: 1, minHeight: 0,
        display: 'flex',
        padding: 16,
        gap: 0
      }}>
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
          <OfficeFloor />
          <MemoryPanel />
          {tasksBoardOpen && <TaskBoardOverlay />}
          {agentCount === 0 && godStatus === 'booting' && <MichaelBooting />}
          {agentCount === 0 && godStatus !== 'booting' && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none'
            }}>
              <div style={{ pointerEvents: 'auto', width: 360 }}>
                <PixelPanel variant="dialog" title="EMPTY FLOOR" noPadding>
                  <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <p style={{ margin: 0, fontSize: 14, lineHeight: '20px' }}>
                      No agents on the floor yet. Spawn one to see real claude output stream in here.
                    </p>
                    <PixelButton variant="primary" size="md" onClick={() => setAddAgentOpen(true)}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="plus" /> add agent
                      </span>
                    </PixelButton>
                  </div>
                </PixelPanel>
              </div>
            </div>
          )}
        </div>

        <SidebarSplitter
          width={sidebarWidth}
          onChange={setSidebarWidth}
          viewportWidth={vpWidth}
        />

        <div style={{
          width: sidebarWidth, flexShrink: 0,
          minHeight: 0, display: 'flex', flexDirection: 'column'
        }}>
          {agent ? (
            <AgentDetailPanel agent={agent} />
          ) : godStatus === 'booting' ? (
            <PixelPanel variant="default" noPadding style={{
              padding: 16, height: '100%',
              display: 'flex', flexDirection: 'column',
              justifyContent: 'center', alignItems: 'center', gap: 12
            }}>
              <div style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                color: 'var(--cth-ink-500)'
              }}>WAKING THE FLOOR</div>
              <p style={{ margin: 0, fontSize: 14, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                Michael is clocking in.<br />
                The terminal will land here once he's seated.
              </p>
            </PixelPanel>
          ) : (
            <PixelPanel variant="default" noPadding style={{
              padding: 16, height: '100%',
              display: 'flex', flexDirection: 'column',
              justifyContent: 'center', alignItems: 'center', gap: 12
            }}>
              <div style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                color: 'var(--cth-ink-500)'
              }}>NO AGENT SELECTED</div>
              <p style={{ margin: 0, fontSize: 14, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                Spawn an agent from the strip below.<br />
                The terminal and command bar will land here.
              </p>
              <PixelButton variant="secondary" size="md" onClick={() => setAddAgentOpen(true)}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Icon name="plus" /> add agent
                </span>
              </PixelButton>
            </PixelPanel>
          )}
        </div>
      </div>

      <AgentStrip config={config} onConfigChange={setConfig} />

      {addAgentOpen && (
        <AddAgentModal onClose={() => setAddAgentOpen(false)} config={config} />
      )}

      {settingsOpen && (
        <SettingsModal
          config={config}
          onClose={() => {
            setSettingsOpen(false);
            // Settings writes config to disk but holds local copies; re-pull so the matrix +
            // project-repo rows (and anything else reading App.config) reflect the changes.
            window.cth.getConfig().then((c) => setConfig(c)).catch(() => { /* keep current */ });
          }}
        />
      )}

      {quitWarn && (
        <QuitWarningModal
          ptyCount={quitWarn.ptyCount}
          onCancel={() => { window.cth.cancelClose(); setQuitWarn(null); }}
          onConfirm={async () => { await window.cth.confirmClose(); }}
        />
      )}

      {fullscreenAgentId && <FullscreenTerminal />}
      {fullscreenFilePath && <FullscreenFileEditor />}
    </div>
  );
}
