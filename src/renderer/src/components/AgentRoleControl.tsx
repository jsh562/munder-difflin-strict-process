import { useStore, type Agent, type AgentRole } from '@/store/store';
import { scheduleDeskRestart } from '@/lib/restartDesk';

/** Per-role hover blurb + the chip's "on" tint. */
const ROLE_META: Record<AgentRole, { tip: string; on: string }> = {
  worker: { tip: 'Worker: writes the code — takes delegated implementation', on: 'var(--cth-sky)' },
  reviewer: { tip: "Reviewer: reads a 'review' card and COMMENTS only (read-only — cannot edit code); approves to 'integrate' or sends it back", on: 'var(--cth-lilac)' },
  integrator: { tip: "Integrator: merges other desks' branches (hive_integrate) + signs tasks off; may edit only to resolve a conflict", on: 'var(--cth-peach)' },
  planner: { tip: 'Planner (SDDP): authors the spec / plan / tasks artifacts for a feature (Specify→Clarify→Plan→Tasks)', on: 'var(--cth-mint)' },
  qc: { tip: 'QC (SDDP): runs the automated QC phase — tests / lint / security + verifies stories vs spec; files bug tasks or signs .qc-passed', on: 'var(--cth-coral)' }
};
/** Standard roles always shown; planner/qc only when the floor is in SDDP mode. */
const STANDARD_ROLES: AgentRole[] = ['worker', 'reviewer', 'integrator'];
const SDDP_ROLES: AgentRole[] = ['planner', 'worker', 'reviewer', 'qc', 'integrator'];

/**
 * Toggle a desk's capability roles (worker / reviewer / integrator). `worker` = writes code;
 * `reviewer` = read-only comments; `integrator` = merges (hive_integrate) + signs tasks off.
 * Writes both the renderer record AND the registry (the gate's source of truth) — the gate
 * applies at once, and we **auto-restart the desk** (debounced) so the role's PROMPT re-injects
 * with no manual step (the desk, not the app). Hand a role off by un-toggling it on the god and
 * toggling it on a dedicated desk. The send-only assistant has no such roles. Shared by the
 * Command Center roster + a desk's own panel.
 */
export function AgentRoleControl({ agent }: { agent: Agent }) {
  const setAgentRoles = useStore((s) => s.setAgentRoles);
  const sddpMode = useStore((s) => s.sddpMode);
  if (agent.isAssistant) return null;
  const roles: AgentRole[] = agent.roles ?? (agent.isGod ? ['integrator', 'reviewer'] : ['worker']);
  const has = (r: AgentRole) => roles.includes(r);
  // planner/qc chips appear only in SDDP mode (so they don't clutter the standard flow).
  const chips = sddpMode ? SDDP_ROLES : STANDARD_ROLES;
  const toggle = (r: AgentRole) => {
    const next = has(r) ? roles.filter((x) => x !== r) : [...roles, r];
    setAgentRoles(agent.id, next);
    void window.cth.hiveSetRoles(agent.id, next).catch(() => { /* registry best-effort */ });
    // Capability applies live; auto-restart (debounced) re-injects the role prompt — no
    // manual "restart to apply" step.
    scheduleDeskRestart(agent.id);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>ROLES</span>
        {chips.map((r) => (
          <button
            key={r}
            onClick={() => toggle(r)}
            title={ROLE_META[r].tip}
            style={{
              padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
              background: has(r) ? ROLE_META[r].on : 'var(--cth-cream-200)',
              boxShadow: `inset 0 0 0 1px ${has(r) ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
              fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
            }}
          >{r}</button>
        ))}
      </div>
      {/* Derived write-state, so the desk's edit capability is unmistakable at a glance:
          worker OR integrator ⇒ can edit code; otherwise read-only (comments + delegates). */}
      {(() => {
        const canEdit = has('worker') || has('integrator') || has('planner') || has('qc');
        return (
          <span style={{ fontSize: 10, color: canEdit ? 'var(--cth-ink-700)' : 'var(--cth-mint)', lineHeight: '13px' }}>
            {canEdit ? '✎ can edit code' : '👁 read-only — delegates, cannot write_file/edit_file/bash'}
          </span>
        );
      })()}
      {/* The god is an orchestrator: worker + integrator both grant code-editing, so leave
          both OFF for a pure delegator. Surfaced here because it's non-obvious. */}
      {agent.isGod && (
        <span style={{ fontSize: 10, color: 'var(--cth-ink-500)', lineHeight: '13px' }}>
          worker + integrator both let Michael edit code — leave both OFF (reviewer-only) for a pure orchestrator that only delegates.
        </span>
      )}
    </div>
  );
}
