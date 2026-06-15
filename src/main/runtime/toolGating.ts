import { roleCanEditCode, roleCanWriteFiles, canIntegrate, type AgentRole } from '@jsh562/won-agent-core';

/**
 * The native tool names a desk should NOT be advertised, given the capability roles it holds — so
 * the model never even SEES (and therefore never attempts) a tool the execution gate would deny.
 * The gates split write-vs-shell: a non-author (reviewer / integrator / pure-delegator god) loses
 * `write_file`/`edit_file` (only worker/planner/qc author files); a desk that can't run shell loses
 * `bash` (worker/planner/qc + the integrator — which keeps `bash` for its test/merge gate); a
 * non-integrator loses `hive_integrate`. So an INTEGRATOR is advertised `bash` + `hive_integrate`
 * but NOT `write_file`/`edit_file` (it merges host-side, it doesn't author the trunk). Execution
 * gates in the toolkit remain as a backstop; filtering the advertised catalog stops the
 * "calls a denied tool → rejected → re-verifies" loops.
 */
export function deniedNativeToolNames(roles: readonly AgentRole[]): string[] {
  const denied: string[] = [];
  if (!roleCanWriteFiles(roles)) denied.push('write_file', 'edit_file');
  if (!roleCanEditCode(roles)) denied.push('bash');
  if (!canIntegrate(roles)) denied.push('hive_integrate');
  return denied;
}
