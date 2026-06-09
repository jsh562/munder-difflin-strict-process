/**
 * Native-desk hive tool dispatcher (E006 / US3 — FR-009).
 *
 * The MAIN-process executor for tools a native worker requests over IPC. The worker
 * is never the writer of shared hive state (single-committer, Principle III): it
 * sends a `toolRequest`; this dispatcher runs the tool against the injected hive
 * handlers and returns a `{ content, success }` result the loop feeds back as a
 * tool result. It mirrors what a Claude desk does through its CLI tools, so a
 * native desk participates in the hive — memory, mailbox, tasks — as a full peer.
 *
 * Electron-free: the hive surface is injected (`HiveToolDeps`), so this is unit-
 * testable in Node. `index.ts` wires the real `HiveManager` methods in.
 *
 * SCOPE NOTE (honest reporting, FR-009): this wires the CORE hive tools — read
 * memory, send a mailbox message, read/append the task ledger — and the worker→main
 * execution SEAM end-to-end. The broader Claude tool surface (filesystem edits, web,
 * MCP, etc.) is NOT introduced here (the spec adds no new tools and degrades absent
 * capabilities); a native desk's autonomy/drain, telemetry, avatars, and breaker all
 * flow through the existing AgentEvent stream regardless.
 */
import type { ToolSpec } from '../../shared/providerCall';
import type { HiveMessage, HiveTask } from '../hive';

/** The minimal hive surface the dispatcher needs (injected; the real HiveManager). */
export interface HiveToolDeps {
  enabled(): boolean;
  /** Read an agent's memory.md (empty string when none). */
  memory(id: string): string;
  /** Inject a mailbox message from `from` (the requesting agent). */
  send(partial: Partial<HiveMessage>, from?: string): HiveMessage;
  /** The current task ledger (shape: `{ tasks: HiveTask[] }`). */
  tasks(): unknown;
  /** Persist the task ledger (single-commit). */
  writeTasks(tasks: HiveTask[]): void;
}

/** Result shape the worker loop consumes (mirrors `ToolResult` minus the call id). */
export interface HiveToolResult {
  content: string;
  success: boolean;
}

/** The core hive tool names a native desk can call. Kept small + explicit. */
export const CORE_HIVE_TOOL_NAMES = [
  'hive_read_memory',
  'hive_send_message',
  'hive_list_tasks',
  'hive_add_task'
] as const;

export type CoreHiveToolName = (typeof CORE_HIVE_TOOL_NAMES)[number];

/**
 * The hive-tool catalog advertised to a native model (E006 / FR-009) — a `ToolSpec[]`
 * the worker passes into the loop deps so the provider request tells the model these
 * tools exist. The names + inputs MATCH the `executeHiveTool` dispatcher exactly so the
 * advertised catalog and the executor cannot drift (a test asserts this). Kept next to
 * the dispatcher for that reason. Schemas are intentionally minimal JSON Schema —
 * `executeHiveTool` already fails closed on bad input (FR-009/FR-011 alignment).
 */
export const HIVE_TOOL_CATALOG: readonly ToolSpec[] = [
  {
    name: 'hive_read_memory',
    description:
      "Read a desk's persistent memory.md. Reads your own memory by default; pass `agentId` to read another desk's.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: "The desk whose memory to read; omit to read your own."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'hive_send_message',
    description:
      "Send a mailbox message to another desk, 'god' (the operator), or 'broadcast'. Use this to coordinate with peers.",
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: "Recipient: a desk's agent id, 'god', or 'broadcast'."
        },
        subject: { type: 'string', description: 'Short subject line.' },
        body: { type: 'string', description: 'Message body.' },
        act: {
          type: 'string',
          description: "Speech act (e.g. 'inform', 'request'); defaults to 'inform'."
        }
      },
      required: ['to'],
      additionalProperties: false
    }
  },
  {
    name: 'hive_list_tasks',
    description: 'List the shared task ledger (all tasks and their status).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'hive_add_task',
    description: 'Append a new task to the shared task ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title (required).' },
        description: { type: 'string', description: 'Optional longer description.' },
        assignee: {
          type: 'string',
          description: "Desk to assign; defaults to yourself."
        },
        priority: { type: 'number', description: 'Optional numeric priority (default 0).' }
      },
      required: ['title'],
      additionalProperties: false
    }
  }
] as const;

/** A plain object from arbitrary tool input (non-objects degrade to `{}`). */
function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

/** A trimmed string field, or '' when absent/non-string. */
function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Execute one requested tool for `agentId` against the hive. Never throws — a bad
 * input or a disabled hive returns `{ success:false }` so the loop feeds an error
 * tool result back for self-correction (FR-009/FR-011 alignment).
 */
export function executeHiveTool(
  deps: HiveToolDeps,
  agentId: string,
  req: { toolName: string; toolInput: unknown }
): HiveToolResult {
  if (!deps.enabled()) {
    return { content: 'hive is not enabled for this desk', success: false };
  }
  const input = asObject(req.toolInput);

  switch (req.toolName) {
    case 'hive_read_memory': {
      // Read own memory by default; an explicit `agentId` reads another desk's.
      const target = str(input, 'agentId') || agentId;
      const mem = deps.memory(target);
      return { content: mem, success: true };
    }

    case 'hive_send_message': {
      const to = str(input, 'to');
      if (!to) return { content: "missing 'to' (recipient agent id, 'god', or 'broadcast')", success: false };
      const subject = str(input, 'subject');
      const body = str(input, 'body');
      const act = str(input, 'act') || 'inform';
      const msg = deps.send(
        { to, subject, body, act: act as HiveMessage['act'] },
        agentId
      );
      return { content: `sent message ${msg.id} to ${to}`, success: true };
    }

    case 'hive_list_tasks': {
      const ledger = deps.tasks();
      return { content: JSON.stringify(ledger), success: true };
    }

    case 'hive_add_task': {
      const title = str(input, 'title');
      if (!title) return { content: "missing 'title'", success: false };
      const ledger = deps.tasks() as { tasks?: HiveTask[] } | undefined;
      const existing = Array.isArray(ledger?.tasks) ? ledger!.tasks : [];
      const task: HiveTask = {
        id: `task-${Date.now()}-${existing.length}`,
        title,
        description: str(input, 'description') || undefined,
        assignee: str(input, 'assignee') || agentId,
        status: 'todo',
        dependsOn: [],
        priority: typeof input.priority === 'number' ? input.priority : 0,
        createdAt: new Date().toISOString()
      };
      deps.writeTasks([...existing, task]);
      return { content: `added task ${task.id}`, success: true };
    }

    default:
      return { content: `unknown hive tool '${req.toolName}'`, success: false };
  }
}
