/**
 * AgentEventBus (E001 / ADR-0002) — a typed in-main emit/subscribe bus for the
 * normalized AgentEvent stream. Provider adapters emit; consumers (the IPC
 * translator today, native consumers later) subscribe. Listener errors are
 * isolated so one bad consumer cannot break the stream.
 */
import type { AgentEvent } from '../../shared/agentEvent';
import type { AgentEventListener, Unsubscribe } from '../../shared/providerRuntime';

export class AgentEventBus {
  private listeners = new Set<AgentEventListener>();

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a consumer threw — isolate it, never break the stream */
      }
    }
  }

  subscribe(listener: AgentEventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Active listener count (diagnostics/tests). */
  size(): number {
    return this.listeners.size;
  }
}
