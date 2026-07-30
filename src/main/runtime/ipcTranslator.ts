/**
 * IpcTranslator (E001 / ADR-0010, AD-002) — re-emits the EXISTING `hive:hookEvent`
 * IPC payload from the normalized AgentEvent stream, so renderer consumers
 * (avatars) need no change as runtimes migrate behind the port.
 *
 * Parity strategy: in E001 the live send is OFF by default — hooks.ts remains the
 * sole live emitter, guaranteeing zero behavior change (TR-005). The pure mapping
 * `toHiveHookEvent` is unit-proven to reproduce the exact payload hooks.ts sends
 * (parity at the contract level). Flipping `setLive(true)` and removing the
 * direct hooks.ts send is the consumer-migration step for a later epic.
 */
import type { AgentEvent } from '../../shared/agentEvent';

/** The exact shape hooks.ts sends on the `hive:hookEvent` channel. */
export interface HiveHookEventPayload {
  agentId: string | undefined;
  event: string;
  tool: string | undefined;
  notificationType: string | undefined;
  source: string | undefined;
  message: string | undefined;
  blocked: boolean;
}

export type HiveHookEventSink = (payload: HiveHookEventPayload) => void;

export class IpcTranslator {
  /** toolCallId → toolName, so tool-end can reproduce the tool name hooks.ts sends. */
  private readonly toolNames = new Map<string, string>();
  private live = false;
  private sink: HiveHookEventSink | null = null;

  /** Wire the live renderer send (used by index.ts). */
  attach(sink: HiveHookEventSink): void {
    this.sink = sink;
  }

  /** Enable/disable live re-emission. Default false in E001 (no double-send). */
  setLive(live: boolean): void {
    this.live = live;
  }

  /** Bus listener: translate and, when live, forward to the renderer. */
  onEvent = (event: AgentEvent): void => {
    const payload = this.toHiveHookEvent(event);
    if (payload && this.live) this.sink?.(payload);
  };

  /**
   * Pure mapping from a normalized event to the legacy `hive:hookEvent` payload.
   * Returns null for events with no legacy equivalent (text-delta, token-usage,
   * thinking-*, api-error, turn-end).
   */
  toHiveHookEvent(event: AgentEvent): HiveHookEventPayload | null {
    switch (event.kind) {
      case 'turn-start':
        return base(event.agentId, 'UserPromptSubmit');
      case 'tool-start':
        this.toolNames.set(event.toolCallId, event.toolName);
        return base(event.agentId, 'PreToolUse', { tool: event.toolName });
      case 'tool-end':
        return base(event.agentId, 'PostToolUse', { tool: this.toolNames.get(event.toolCallId) });
      case 'stop':
        // hooks.ts emit() always forwards p.message; the stop event carries it as `reason`.
        return base(event.agentId, 'Stop', { message: event.reason });
      case 'needs-input':
        return base(event.agentId, 'Notification', { notificationType: 'idle', message: event.message });
      case 'notification':
        return base(event.agentId, 'Notification', { message: event.message });
      default:
        return null;
    }
  }
}

function base(
  agentId: string | undefined,
  event: string,
  extra?: Partial<Pick<HiveHookEventPayload, 'tool' | 'notificationType' | 'source' | 'message'>>
): HiveHookEventPayload {
  return {
    agentId,
    event,
    tool: extra?.tool,
    notificationType: extra?.notificationType,
    source: extra?.source,
    message: extra?.message,
    blocked: false
  };
}
