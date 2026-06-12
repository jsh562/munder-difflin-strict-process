import { useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelBadge } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { PtyTerminalView } from './PtyTerminalView';
import { NativeTranscriptView } from './NativeTranscriptView';
import { StructuredRunTab } from './StructuredRunTab';
import { useNativeAgentEvents } from '@/hooks/useNativeAgentEvents';
import { MessageQueueComposer } from './MessageQueueComposer';
import { AssistantRoleNote } from './AssistantRoleNote';
import { CommandCenterPanel } from './CommandCenterPanel';
import { disposeTerminal } from './terminalPool';
import { SidebarTabs } from './SidebarTabs';
import { FilesTab } from './FilesTab';
import { ThreadsPanel } from './ThreadsPanel';
import { ToolWaterfall } from './ToolWaterfall';
import { AgentControlStrip } from './AgentControlStrip';
import { Icon } from './Icon';
import { useStore, type Agent } from '@/store/store';
import { usePtyParser } from '@/hooks/usePtyParser';
import { deriveProviderId } from '@shared/assignment';

export interface AgentDetailPanelProps {
  agent: Agent;
}

/**
 * E008 / T020 (FR-001/FR-023) — the panel-local render-path decision: does this desk
 * run on a NATIVE runtime (DeepSeek/Minimax), so its terminal slot shows the
 * synthesized `NativeTranscriptView` instead of the Claude `PtyTerminalView`?
 *
 * The signal is the desk's RUNTIME KIND, derived locally from its assigned model via
 * the shared, electron-free registry — the SAME decision the main spawn router makes
 * (`src/main/index.ts`: a desk whose derived provider is present and not Claude
 * launches on the native worker, bypassing the Claude PTY; a Claude/`anthropic` or
 * unresolvable/unassigned desk takes the PTY path). Mirroring that one seam keeps the
 * renderer and main in lockstep:
 *   - native provider (deepseek/minimax) → derived id is present and `!== 'anthropic'`
 *     → native runtime → synthesized transcript.
 *   - Claude desk → derives `'anthropic'` → PTY path (never misrouted).
 *   - empty/unstarted/role-based desk (no/unresolvable model) → derives `null` → PTY
 *     path / no-PTY empty state (never misrouted as native).
 *
 * This is NOT vendor-string branching leaking into a downstream consumer (Principle I):
 * it is the panel choosing which render surface to mount for the desk's runtime kind,
 * and the decision stays local to this component. `agent.ptyId` is NOT a reliable
 * discriminator on its own — the renderer stamps a `ptyId` onto every spawned record
 * (`AddAgentModal`), even though the main process never creates a real PTY for a native
 * desk — so the runtime-kind derivation is what positively identifies "native-running".
 */
function isNativeRuntimeDesk(agent: Agent): boolean {
  const providerId = deriveProviderId(agent.model);
  return providerId !== null && providerId !== 'anthropic';
}

export function AgentDetailPanel({ agent }: AgentDetailPanelProps) {
  const [openTerminalState, setOpenTerminalState] = useState<'idle' | 'opening' | 'ok' | 'error'>('idle');
  const [openTerminalError, setOpenTerminalError] = useState<string | undefined>();
  const archiveAgent = useStore(s => s.archiveAgent);
  const updateAgent = useStore(s => s.updateAgent);
  const setFullscreen = useStore(s => s.setFullscreen);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const sidebarTab = useStore(s => s.sidebarTab);
  const setSidebarTab = useStore(s => s.setSidebarTab);
  const isReal = !!agent.ptyId;
  // E008 / T020 — does this desk render the synthesized native transcript (vs the
  // Claude PTY)? Derived from the runtime kind (see `isNativeRuntimeDesk`); evaluated
  // FIRST in the terminal tab so a native desk never falls into the Claude PTY branch.
  const isNative = isNativeRuntimeDesk(agent);
  // While this agent is shown in the fullscreen overlay, the fullscreen view
  // owns the pty (it sizes it to fill the screen). Keeping the embedded terminal
  // mounted too means two xterms fight over the pty's cols/rows — which corrupts
  // the display and breaks scrolling. So we unmount the embedded one here; it
  // re-mounts and re-fits when fullscreen closes.
  const isFullscreenedHere = fullscreenAgentId === agent.id;

  const onPtyStream = usePtyParser(agent.id);

  // E008 / T030 (FR-005/FR-034) — the SINGLE native fold for this desk. The structured
  // tab consumes THIS already-folded `{ structured, loading }` (it never re-folds), so
  // toggling the terminal ↔ structured tab reuses the folded view-models (FR-034). For a
  // Claude/empty desk the channel never fires, so this is an idle empty fold — the
  // structured tab there is sourced from telemetry (`source='claude'`), not this. The
  // hook is called unconditionally (React rules) BEFORE the early `isGod` return below;
  // a god/command-center desk simply never reads it.
  const nativeRun = useNativeAgentEvents(agent.id);

  // Michael gets the full command-center dashboard instead of the plain panel.
  if (agent.isGod) return <CommandCenterPanel agent={agent} />;

  const openTerminal = async () => {
    setOpenTerminalState('opening');
    setOpenTerminalError(undefined);
    try {
      const result = await window.cth.openTerminalAt(agent.cwd);
      if (result.ok) {
        setOpenTerminalState('ok');
        setTimeout(() => setOpenTerminalState('idle'), 1500);
      } else {
        setOpenTerminalState('error');
        setOpenTerminalError(result.error ?? 'unknown error');
        setTimeout(() => setOpenTerminalState('idle'), 4000);
      }
    } catch (e) {
      setOpenTerminalState('error');
      setOpenTerminalError(e instanceof Error ? e.message : String(e));
      setTimeout(() => setOpenTerminalState('idle'), 4000);
    }
  };

  const onKill = async () => {
    if (!agent.ptyId) return;
    if (!confirm(`Close ${agent.name}? The PTY process will terminate and the agent is archived (kept in history, off the floor).`)) return;
    await window.cth.killPty(agent.ptyId);
    disposeTerminal(agent.ptyId);
    archiveAgent(agent.id);
  };

  return (
    <PixelPanel
      variant="default"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: 0,
        overflow: 'hidden'
      }}
      noPadding
    >
      {/* Thin header strip */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px',
        background: 'var(--cth-cream-100)',
        borderBottom: '1px solid var(--cth-ink-700)',
        flexShrink: 0
      }}>
        <div style={{
          width: 32, height: 32,
          background: `var(--cth-${agent.accent}-light)`,
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden',
          flexShrink: 0
        }}>
          <SpritePortrait character={agent.character} scale={1} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--cth-font-display)',
            fontSize: 10, lineHeight: '14px',
            color: 'var(--cth-ink-900)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
          }}>{agent.name.toUpperCase()}</div>
          <div style={{
            display: 'flex', gap: 6, alignItems: 'center', marginTop: 1
          }}>
            <PixelBadge status={agent.status} />
            <span style={{
              fontSize: 12, color: 'var(--cth-ink-500)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }}>{agent.project}</span>
          </div>
        </div>
        <PixelButton variant="secondary" size="sm" onClick={openTerminal} disabled={openTerminalState === 'opening'}>
          <span title={`open Terminal.app at ${agent.cwd}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name="terminal" />
            {openTerminalState === 'opening' ? '...' : openTerminalState === 'ok' ? 'ok' : openTerminalState === 'error' ? 'err' : 'open'}
          </span>
        </PixelButton>
        {isReal && (
          <PixelButton variant="destructive" size="sm" onClick={onKill}>
            <Icon name="x" />
          </PixelButton>
        )}
      </div>

      {openTerminalError && (
        <div style={{
          fontSize: 12, color: 'var(--cth-coral)',
          padding: '2px 8px',
          background: 'var(--cth-coral-light)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
        }}>{openTerminalError}</div>
      )}

      {/* #7C — operator control (pause / halt / steer) for live agents */}
      {isReal && <AgentControlStrip agentId={agent.id} />}

      {/* Tabs */}
      <SidebarTabs current={sidebarTab} accent={agent.accent} onChange={setSidebarTab} />

      {/* Active tab body — fills remaining space */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* E008 / T030 (FR-005/FR-006/FR-034) — the terminal slot hosts BOTH the
            default view (native transcript / Claude PTY) AND the opt-in structured tab.
            When `structured` is selected the default view stays MOUNTED but hidden
            (`display:none`) and the structured tab is shown on top — so toggling
            terminal ↔ structured preserves the default view's content + scroll (FR-006:
            no unmount = the transcript's scroll/virtualization state and the pooled
            xterm's buffer survive the switch) and re-folds nothing (FR-034: the native
            structured tab reuses THIS panel's single `nativeRun` fold; the Claude
            structured tab reuses the renderer telemetry it already receives). The
            default view is rendered EXACTLY as before — the Claude PTY path is untouched. */}
        {(sidebarTab === 'terminal' || sidebarTab === 'structured') && (
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
            {/* Default view (kept mounted; hidden while the structured tab is active). */}
            <div
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                display: sidebarTab === 'terminal' ? 'flex' : 'none'
              }}
            >
              {isNative ? (
                // E008 / T020 (FR-001/FR-014/FR-023) — native desk: the synthesized
                // transcript replaces the PTY view in the SAME terminal-tab slot, framed
                // by the SAME flex-column wrapper + composer the Claude branch uses, so
                // placement/framing match (FR-023). ADDITIVE; never touches the PTY path.
                <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                    <NativeTranscriptView agentId={agent.id} embedded />
                  </div>
                  {agent.isAssistant ? <AssistantRoleNote /> : <MessageQueueComposer agent={agent} />}
                </div>
              ) : isReal && agent.ptyId ? (
                isFullscreenedHere ? (
                  <EmptyTab title="In fullscreen">
                    This terminal is open in fullscreen. Press Esc or exit fullscreen to bring it back here.
                  </EmptyTab>
                ) : (
                  <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                      <PtyTerminalView
                        key={agent.ptyId}
                        ptyId={agent.ptyId}
                        onStreamData={onPtyStream}
                        onUserPrompt={(t) => {
                          updateAgent(agent.id, { lastPrompt: t });
                          if (t.trim().toLowerCase() === '/clear') {
                            updateAgent(agent.id, { contextTokens: 0, contextLimit: undefined, progress: 0 });
                          }
                          void window.cth.historyAdd({ agentId: agent.id, cwd: agent.cwd, text: t });
                        }}
                        onToggleFullscreen={() => setFullscreen(agent.id)}
                        fullscreen={false}
                        embedded
                      />
                    </div>
                    {agent.isAssistant ? <AssistantRoleNote /> : <MessageQueueComposer agent={agent} />}
                  </div>
                )
              ) : (
                <EmptyTab title="No PTY">
                  This agent has no live terminal. Spawn an agent through "add agent" to use the terminal tab.
                </EmptyTab>
              )}
            </div>

            {/* Opt-in structured tab (shown only when selected). For a native desk it
                reuses THIS panel's single fold (`nativeRun`, no re-fold — FR-034); for a
                Claude desk it is derived from the existing renderer telemetry (AD-005
                Option B), so the Claude PTY path stays byte-for-byte unchanged (FR-009). */}
            {sidebarTab === 'structured' && (
              <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
                {isNative ? (
                  <StructuredRunTab
                    agentId={agent.id}
                    source="native"
                    structured={nativeRun.structured}
                    loading={nativeRun.loading}
                    embedded
                  />
                ) : (
                  <StructuredRunTab agentId={agent.id} source="claude" embedded />
                )}
              </div>
            )}
          </div>
        )}

        {sidebarTab === 'files' && (
          <FilesTab cwd={agent.cwd} />
        )}

        {sidebarTab === 'messages' && (
          <ThreadsPanel agentId={agent.id} />
        )}

        {sidebarTab === 'traces' && (
          <ToolWaterfall agentId={agent.id} />
        )}
      </div>
    </PixelPanel>
  );
}

function EmptyTab({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: 16, gap: 8,
      background: 'var(--cth-paper-200)'
    }}>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
        color: 'var(--cth-ink-500)'
      }}>{title.toUpperCase()}</div>
      <p style={{
        margin: 0, fontSize: 14, textAlign: 'center', color: 'var(--cth-ink-700)',
        maxWidth: 280
      }}>{children}</p>
    </div>
  );
}
