import { roleCanEditCode, type AgentRole } from '@jsh562/won-agent-core';

/**
 * The native tool names a desk should NOT be advertised, given the capability roles it holds — so
 * the model never even SEES (and therefore never attempts) a tool the execution gate would deny.
 * A desk that can't edit code (no worker/integrator/planner/qc — e.g. a reviewer or a pure-delegator
 * god) loses the code-editing tools; a non-integrator loses `hive_integrate`. The execution gates in
 * the toolkit remain as a backstop, but filtering the ADVERTISED catalog is what stops the
 * "calls a denied tool → gets rejected → re-verifies the denial" loops on a native desk.
 */
export function deniedNativeToolNames(roles: readonly AgentRole[]): string[] {
  const denied: string[] = [];
  if (!roleCanEditCode(roles)) denied.push('write_file', 'edit_file', 'bash');
  if (!roles.includes('integrator')) denied.push('hive_integrate');
  return denied;
}
