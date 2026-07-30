/**
 * Native worker IPC protocol (E003 / ADR-0003, ADR-0004) — the typed messages
 * between the main process and a native agent's utilityProcess. Pure types, no
 * electron. The worker NEVER touches the hive git: end-of-turn sends a
 * `drainRequest`; main runs `drainForStop` and replies `drainResult`.
 *
 * E006 {FR-009} extends this ADDITIVELY with a TOOL-EXECUTION seam so a native
 * desk participates in the hive as a full peer (single-committer preserved): the
 * worker REQUESTS a tool (`toolRequest`); MAIN executes it against the hive tool
 * handlers and replies (`toolResult`). The worker is never the writer of shared
 * hive state — it only asks, exactly like the existing drain round-trip.
 */
import type { AgentEvent } from './agentEvent';
import type { AgentInput, UsageSnapshot } from './providerRuntime';

/** Main → worker. */
export type WorkerCommand =
  | { type: 'start'; agentId: string; sessionId?: string | null }
  | { type: 'send'; input: AgentInput }
  | { type: 'stop'; graceful: boolean }
  | { type: 'kill' }
  | { type: 'drainResult'; turnId: number; block: boolean; reason?: string }
  | {
      /** Reply to a worker `toolRequest` (E006 / FR-009). `success:false` carries an
       *  error string the loop feeds back as a failed tool result for self-correction. */
      type: 'toolResult';
      callId: number;
      toolCallId: string;
      content: string;
      success: boolean;
    };

/** Worker → main. */
export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'event'; event: AgentEvent }
  | { type: 'usage'; usage: UsageSnapshot }
  | { type: 'drainRequest'; turnId: number }
  | {
      /** Ask MAIN to execute one tool against the hive (E006 / FR-009). `callId`
       *  correlates the `toolResult` reply; `toolCallId` is the provider's id. */
      type: 'toolRequest';
      callId: number;
      toolCallId: string;
      toolName: string;
      toolInput: unknown;
    }
  | { type: 'idle' }
  | { type: 'exit'; reason: string };
