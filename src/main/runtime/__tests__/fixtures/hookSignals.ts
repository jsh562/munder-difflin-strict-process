/**
 * Recorded Claude Code hook-payload fixtures (T003) used by the adapter/contract/
 * parity tests. These mirror the real HookPayload shapes hooks.ts receives.
 */
import type { ClaudeHookSignal } from '../../claudeAdapter';

export const AGENT = 'agent.test';

export const userPromptSubmit: ClaudeHookSignal = {
  hook_event_name: 'UserPromptSubmit',
  agent_id: AGENT,
  session_id: 'sess-1'
};

export const preToolUseEdit: ClaudeHookSignal = {
  hook_event_name: 'PreToolUse',
  agent_id: AGENT,
  session_id: 'sess-1',
  tool_name: 'Edit',
  tool_input: { file_path: 'a.ts' }
};

export const postToolUseEdit: ClaudeHookSignal = {
  hook_event_name: 'PostToolUse',
  agent_id: AGENT,
  session_id: 'sess-1',
  tool_name: 'Edit'
};

export const preToolUseBash: ClaudeHookSignal = {
  hook_event_name: 'PreToolUse',
  agent_id: AGENT,
  session_id: 'sess-1',
  tool_name: 'Bash',
  tool_input: { command: 'ls' }
};

export const notificationIdle: ClaudeHookSignal = {
  hook_event_name: 'Notification',
  agent_id: AGENT,
  session_id: 'sess-1',
  notification_type: 'idle',
  message: 'Claude is waiting for your input'
};

export const stopGenuine: ClaudeHookSignal = {
  hook_event_name: 'Stop',
  agent_id: AGENT,
  session_id: 'sess-1',
  stop_hook_active: false,
  message: 'done'
};

export const stopActive: ClaudeHookSignal = {
  hook_event_name: 'Stop',
  agent_id: AGENT,
  session_id: 'sess-1',
  stop_hook_active: true,
  message: 'continue'
};

/** Reproduces the exact payload hooks.ts `emit()` sends on `hive:hookEvent`. */
export function referenceHiveHookEvent(p: ClaudeHookSignal, blocked = false) {
  return {
    agentId: p.agent_id ?? undefined,
    event: p.hook_event_name ?? 'Unknown',
    tool: p.tool_name,
    notificationType: p.notification_type,
    source: p.source,
    message: p.message,
    blocked
  };
}
