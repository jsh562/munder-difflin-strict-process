import { useStore, type Agent, type AgentRole } from '@/store/store';

/**
 * Toggle a desk's capability roles (worker / integrator). `worker` = takes delegated
 * implementation; `integrator` = may review+merge (hive_integrate) + sign tasks off.
 * Writes both the renderer record AND the registry (the gate's source of truth) — the gate
 * applies at once; the role's PROMPT re-injects on the desk's next restart. Hand integration
 * off by un-toggling it on the god and toggling it on a dedicated desk. The send-only
 * assistant has no such roles. Shared by the Command Center roster + a desk's own panel.
 */
export function AgentRoleControl({ agent }: { agent: Agent }) {
  const setAgentRoles = useStore((s) => s.setAgentRoles);
  if (agent.isAssistant) return null;
  const roles: AgentRole[] = agent.roles ?? (agent.isGod ? ['integrator'] : ['worker']);
  const has = (r: AgentRole) => roles.includes(r);
  const toggle = (r: AgentRole) => {
    const next = has(r) ? roles.filter((x) => x !== r) : [...roles, r];
    setAgentRoles(agent.id, next);
    void window.cth.hiveSetRoles(agent.id, next).catch(() => { /* registry best-effort */ });
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>ROLES</span>
      {(['worker', 'integrator'] as AgentRole[]).map((r) => (
        <button
          key={r}
          onClick={() => toggle(r)}
          title={r === 'integrator'
            ? "Integrator: review + merge other desks' branches (hive_integrate) and sign tasks off"
            : 'Worker: takes delegated implementation'}
          style={{
            padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
            background: has(r) ? 'var(--cth-sky)' : 'var(--cth-cream-200)',
            boxShadow: `inset 0 0 0 1px ${has(r) ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
            fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
          }}
        >{r}</button>
      ))}
      <span style={{ fontSize: 10, color: 'var(--cth-ink-300)' }}>restart to apply prompt</span>
    </div>
  );
}
