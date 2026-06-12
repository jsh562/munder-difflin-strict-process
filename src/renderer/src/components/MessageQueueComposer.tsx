import { KeyboardEvent, useRef, useState } from 'react';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore, type Agent, type QueuedMessage } from '@/store/store';
import { deriveProviderId } from '@shared/assignment';

const EMPTY_QUEUE: QueuedMessage[] = [];

export interface MessageQueueComposerProps {
  agent: Agent;
}

/** E008 T024 {FR-015/021} — does this desk submit through the native send seam
 *  (`cth.nativeSend`) rather than the Claude queue→`writePty` flush path? Gated on
 *  the runtime KIND derived from the assigned model (Principle I), never a scattered
 *  vendor string: a non-Anthropic provider is a native (DeepSeek/Minimax) desk. */
function isNativeRuntimeDesk(agent: Agent): boolean {
  const providerId = deriveProviderId(agent.model);
  return providerId !== null && providerId !== 'anthropic';
}

/** A leading `/steer ` marks the input as a mid-run STEER (FR-021) rather than a
 *  plain prompt, so the composer routes each through the correct `AgentInput.kind`
 *  seam. Returns the kind + the text with the marker stripped. */
function parseNativeInput(raw: string): { kind: 'operator' | 'steer'; text: string } {
  const m = /^\/steer\s+([\s\S]+)$/i.exec(raw.trim());
  if (m) return { kind: 'steer', text: m[1].trim() };
  return { kind: 'operator', text: raw.trim() };
}

/**
 * Lets the user keep messaging an agent whose terminal is mid-run. Typed
 * messages park in a per-agent queue and are submitted to the agent's Claude
 * TUI one-by-one as soon as it goes idle (see useHive's flush loop).
 *
 * For Michael, a global "enrich" toggle decides routing: OFF → messages type
 * straight into Michael; ON → they're routed through the assistant ("Dwight"),
 * which gathers repo context and forwards an improved prompt to Michael.
 */
export function MessageQueueComposer({ agent }: MessageQueueComposerProps) {
  const queue = useStore((s) => s.messageQueues[agent.id]) ?? EMPTY_QUEUE;
  const enqueueMessage = useStore((s) => s.enqueueMessage);
  const removeQueuedMessage = useStore((s) => s.removeQueuedMessage);
  const clearQueue = useStore((s) => s.clearQueue);
  const enrichEnabled = useStore((s) => s.enrichEnabled);
  const setEnrichEnabled = useStore((s) => s.setEnrichEnabled);

  // Draft lives in the store, keyed by agent — switching agents remounts this
  // component, and component-local state would silently eat the typed text.
  const text = useStore((s) => s.drafts[agent.id] ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const setText = (t: string) => setDraft(agent.id, t);

  // The enrich toggle governs Michael's queue (it routes through the assistant).
  const showEnrichToggle = !!agent.isGod;

  // E008 T024 {FR-015/021} — a native (DeepSeek/Minimax) desk has no Claude PTY for
  // the queue→`writePty` flush loop to dispatch into, so its composer submits
  // straight through the `cth.nativeSend` seam. Claude desks keep the unchanged
  // queue path below (Principle V / FR-009).
  const isNative = isNativeRuntimeDesk(agent);

  const idle = agent.status === 'idle';

  // E008 T024/T025 {FR-021/022} — a transient, non-blocking send-result indication
  // for the native seam: `sent` confirms delivery (queued/sent parity with a Claude
  // send), `failed` surfaces DISTINCT not-delivered feedback when `native:send`
  // returned `{ok:false}` (e.g. the worker is missing). Never throws/blocks.
  const [sendState, setSendState] = useState<{ kind: 'sent' | 'failed'; msg: string } | null>(null);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashSend = (kind: 'sent' | 'failed', msg: string) => {
    setSendState({ kind, msg });
    if (sendTimer.current) clearTimeout(sendTimer.current);
    // A delivered send clears quickly; a not-delivered notice lingers so the
    // operator can't miss that the input never reached the agent (FR-022).
    sendTimer.current = setTimeout(() => setSendState(null), kind === 'sent' ? 2200 : 6000);
  };

  const queueIt = () => {
    if (!text.trim()) return;
    enqueueMessage(agent.id, text);
    setText('');
  };

  // Native submit: route a steer vs a plain prompt through the correct seam
  // (FR-021) and acknowledge delivery the same way a Claude send is (FR-021), with
  // distinct not-delivered feedback on a failed ack (FR-022). Fail-soft: a thrown
  // bridge error is treated as not-delivered, never surfaced as an unhandled throw.
  const nativeSubmit = async () => {
    const raw = text;
    if (!raw.trim()) return;
    const input = parseNativeInput(raw);
    if (!input.text) return;
    setText(''); // clear optimistically — the ack decides sent vs not-delivered
    try {
      const ack = await window.cth.nativeSend(agent.id, input);
      if (ack?.ok) {
        flashSend('sent', input.kind === 'steer' ? 'steer sent' : 'sent');
      } else {
        flashSend('failed', `not delivered — ${ack?.error ?? 'native agent unavailable'}`);
        setText(raw); // restore so the operator can retry the un-sent input
      }
    } catch (e) {
      flashSend('failed', `not delivered — ${e instanceof Error ? e.message : 'send failed'}`);
      setText(raw);
    }
  };

  const submit = isNative ? nativeSubmit : queueIt;

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const statusHint = queue.length === 0
    ? null
    : showEnrichToggle && enrichEnabled
    ? `→ Dwight (enrich) → Michael · ${queue.length} queued`
    : idle
    ? `sending to ${agent.name} one-by-one…`
    : `${agent.name} is busy — ${queue.length} queued`;

  return (
    <div style={{
      flexShrink: 0,
      borderTop: '1px solid var(--cth-ink-700)',
      background: 'var(--cth-cream-100)',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      padding: 8
    }}>
      {/* Header: label, count, status, enrich toggle (Michael only), clear-all */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)',
          fontSize: 9, lineHeight: '12px',
          color: 'var(--cth-ink-700)'
        }}>QUEUE</span>
        {queue.length > 0 && (
          <span style={{
            fontSize: 11, padding: '1px 6px 0',
            background: 'var(--cth-cream-200)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
            fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)'
          }}>{queue.length}</span>
        )}
        {statusHint && (
          <span style={{
            fontSize: 12,
            color: showEnrichToggle && enrichEnabled ? 'var(--cth-ink-900)' : idle ? 'var(--cth-ink-700)' : 'var(--cth-ink-500)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
          }}>{statusHint}</span>
        )}
        {queue.length > 1 && (
          <button
            onClick={() => clearQueue(agent.id)}
            title="Clear all queued messages"
            style={{
              marginLeft: 'auto',
              border: 'none', background: 'transparent', cursor: 'pointer',
              fontFamily: 'var(--cth-font-ui)', fontSize: 12,
              color: 'var(--cth-ink-500)'
            }}
          >clear all</button>
        )}
      </div>

      {/* Pending list */}
      {queue.length > 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 4,
          maxHeight: 132, overflowY: 'auto'
        }}>
          {queue.map((m, i) => (
            <div key={m.id} style={{
              display: 'flex', alignItems: 'flex-start', gap: 6,
              padding: '4px 6px',
              background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
            }}>
              <span style={{
                fontFamily: 'var(--cth-font-mono)', fontSize: 12,
                color: 'var(--cth-ink-500)', lineHeight: '18px', flexShrink: 0
              }}>{i + 1}.</span>
              <div
                title={m.text}
                style={{
                  flex: 1, minWidth: 0,
                  fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)',
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  overflow: 'hidden', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
                }}
              >{m.text}</div>
              <button
                onClick={() => removeQueuedMessage(agent.id, m.id)}
                title="Remove from queue"
                style={{
                  flexShrink: 0, border: 'none', background: 'transparent',
                  cursor: 'pointer', color: 'var(--cth-ink-500)', padding: 0,
                  display: 'inline-flex', alignItems: 'center'
                }}
              >
                <Icon name="x" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Composer. Michael gets a right-hand control column with the enrich
          toggle stacked directly above send; other agents get a plain send. */}
      <div style={{ display: 'flex', gap: 6, alignItems: showEnrichToggle ? 'stretch' : 'flex-end' }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          placeholder={
            isNative
              ? `Message ${agent.name} (prefix /steer to steer)`
              : idle
              ? `Message ${agent.name}`
              : `${agent.name} is busy — queue a message`
          }
          style={{
            flex: 1,
            resize: 'none',
            padding: '6px 8px',
            background: 'var(--cth-paper-100)',
            border: 'none',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
            fontFamily: 'var(--cth-font-mono)',
            fontSize: 14, lineHeight: '18px',
            color: 'var(--cth-ink-900)',
            outline: 'none'
          }}
        />
        {showEnrichToggle ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, width: 120, flexShrink: 0 }}>
            <button
              onClick={() => setEnrichEnabled(!enrichEnabled)}
              title={enrichEnabled
                ? 'Enrich ON — messages route through Dwight (adds repo context) before Michael'
                : 'Enrich OFF — messages go straight to Michael'}
              style={{
                height: 30, width: '100%',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                border: 'none', cursor: 'pointer',
                background: enrichEnabled ? 'var(--cth-lemon)' : 'var(--cth-cream-100)',
                color: 'var(--cth-ink-900)',
                boxShadow: enrichEnabled
                  ? 'inset 0 0 0 2px var(--cth-ink-900), 0 2px 0 var(--cth-ink-900)'
                  : 'inset 0 0 0 2px var(--cth-ink-700), 0 2px 0 var(--cth-ink-700)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 13
              }}
            >
              <Icon name="sparkle" /> enrich {enrichEnabled ? 'on' : 'off'}
            </button>
            <PixelButton variant="primary" size="md" fullWidth onClick={() => void submit()} disabled={!text.trim()}>
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
                send <Icon name="arrow-right" />
              </span>
            </PixelButton>
          </div>
        ) : (
          <PixelButton variant="primary" size="md" onClick={() => void submit()} disabled={!text.trim()}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              send <Icon name="arrow-right" />
            </span>
          </PixelButton>
        )}
      </div>

      {/* E008 T025 {FR-022} — native send-result indication: a delivered send reads
          like a Claude send ack (queued/sent), while a NOT-delivered send shows a
          DISTINCT, non-blocking notice (different colour + role=alert) so the
          operator can tell an un-routed input from a successful one. */}
      {isNative && sendState && (
        <span
          role={sendState.kind === 'failed' ? 'alert' : 'status'}
          style={{
            fontSize: 12,
            color: sendState.kind === 'failed' ? 'var(--cth-coral)' : 'var(--cth-ink-700)',
            display: 'inline-flex', alignItems: 'center', gap: 5
          }}
        >
          <Icon name={sendState.kind === 'failed' ? 'bell' : 'check'} />
          {sendState.msg}
        </span>
      )}
    </div>
  );
}
