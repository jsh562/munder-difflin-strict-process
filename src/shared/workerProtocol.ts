/**
 * Native worker IPC protocol (E003 / ADR-0003, ADR-0004) — the typed messages
 * between the main process and a native agent's utilityProcess. Pure types, no
 * electron. The worker NEVER touches the hive git: end-of-turn sends a
 * `drainRequest`; main runs `drainForStop` and replies `drainResult`.
 */
import type { AgentEvent } from './agentEvent';
import type { AgentInput, UsageSnapshot } from './providerRuntime';

/** Main → worker. */
export type WorkerCommand =
  | { type: 'start'; agentId: string; sessionId?: string | null }
  | { type: 'send'; input: AgentInput }
  | { type: 'stop'; graceful: boolean }
  | { type: 'kill' }
  | { type: 'drainResult'; turnId: number; block: boolean; reason?: string };

/** Worker → main. */
export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'event'; event: AgentEvent }
  | { type: 'usage'; usage: UsageSnapshot }
  | { type: 'drainRequest'; turnId: number }
  | { type: 'idle' }
  | { type: 'exit'; reason: string };
