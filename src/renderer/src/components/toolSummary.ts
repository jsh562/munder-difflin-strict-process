/**
 * Human-readable summaries for a native agent's tool calls.
 *
 * The folded transcript ([foldEvents.ts]) carries each tool call as a raw
 * `toolName` + raw `toolInput` JSON. Rendering that verbatim ("read_file
 * {\"path\":\"CLAUDE.md\"}") is mechanical and hard to scan. `summarizeTool` maps a
 * (name, input) pair to a short verb + detail ("Read" + "CLAUDE.md") so the trace reads
 * like a narrative — the way Claude Code / Cursor present agent activity. Pure +
 * presentation-only; both the transcript and the structured view use it so they speak
 * the same language. The raw payloads remain available (shown in the collapsible body).
 */

export interface ToolSummary {
  /** Short action verb, e.g. "Read", "Ran", "Searched the web". */
  verb: string;
  /** The most relevant argument, e.g. a path / command / query. May be empty. */
  detail: string;
}

/** A plain object from arbitrary tool input (non-objects degrade to `{}`). */
function obj(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

/** A trimmed string field, or '' when absent/non-string. */
function field(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Map a tool call to a readable summary. Unknown tools fall back to the raw name (so a
 * new/MCP tool still shows something sensible) with no detail.
 */
export function summarizeTool(toolName: string, toolInput: unknown): ToolSummary {
  const o = obj(toolInput);
  switch (toolName) {
    case 'read_file':
      return { verb: 'Read', detail: field(o, 'path') };
    case 'write_file':
      return { verb: 'Wrote', detail: field(o, 'path') };
    case 'edit_file':
      return { verb: 'Edited', detail: field(o, 'path') };
    case 'list_dir':
      return { verb: 'Listed', detail: field(o, 'path') || 'working directory' };
    case 'grep':
      return { verb: 'Searched for', detail: field(o, 'pattern') };
    case 'bash':
      return { verb: 'Ran', detail: field(o, 'command') };
    case 'web_search':
      return { verb: 'Searched the web', detail: field(o, 'query') };
    case 'write_memory':
      return { verb: 'Recorded a memory note', detail: '' };
    case 'hive_read_memory': {
      const id = field(o, 'agentId');
      return { verb: 'Read memory', detail: id ? `of ${id}` : '' };
    }
    case 'hive_send_message':
      return { verb: 'Messaged', detail: field(o, 'to') };
    case 'hive_list_tasks':
      return { verb: 'Listed tasks', detail: '' };
    case 'hive_add_task':
      return { verb: 'Added task', detail: field(o, 'title') };
    default: {
      // MCP tools arrive as `mcp__<server>__<tool>` — show "MCP <server> / <tool>".
      const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
      if (mcp) return { verb: 'MCP', detail: `${mcp[1]} / ${mcp[2]}` };
      return { verb: toolName, detail: '' };
    }
  }
}

/** One-line label "Verb detail" (detail omitted when empty). Convenience for views
 *  that want a single string rather than the structured `{ verb, detail }`. */
export function toolSummaryLine(toolName: string, toolInput: unknown): string {
  const { verb, detail } = summarizeTool(toolName, toolInput);
  return detail ? `${verb} ${detail}` : verb;
}
