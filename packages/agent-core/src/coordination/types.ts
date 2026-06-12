/**
 * Coordination types — the minimal multi-agent vocabulary the toolkit's hive tools
 * speak (mailbox messages + the shared task ledger). Extracted from the host's hive
 * so the toolkit is host-agnostic; the Munder Difflin `HiveManager` re-exports these
 * from `hive.ts`, and any other host implements the same shapes behind `HiveToolDeps`.
 */

/** Speech act on a mailbox message (FIPA-ish). Drives `requires_reply` defaults. */
export type MessageAct = 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';

/** A mailbox message between agents (or to 'god' / 'broadcast'). */
export interface HiveMessage {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string; // an agentId, 'god', or 'broadcast'
  act: MessageAct;
  subject: string;
  body: string;
  hops: number;
  requires_reply: boolean;
  needs_human: boolean;
  created_at: string;
}

/** A row in the shared task ledger (kanban). */
export interface HiveTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
}
