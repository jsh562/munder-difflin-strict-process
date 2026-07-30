import { ModalOverlay } from './ModalOverlay';
import { PixelButton } from './PixelButton';
import { AgentRoleControl } from './AgentRoleControl';
import { AgentWorkspaceControl } from './AgentWorkspaceControl';
import { type Agent } from '@/store/store';

/**
 * Per-desk options dialog (opened from the desk header's gear). Houses the controls that
 * used to sit as inline rows above the terminal — capability ROLES and the WORKSPACE
 * (working directory) — so the terminal keeps its full height. Changing a role applies its
 * capability gate live and auto-restarts the desk (debounced) to re-inject the role prompt;
 * changing the workspace restarts the desk in the new folder. The send-only assistant has
 * neither, so the modal renders an empty-state note for it.
 */
export function DeskOptionsModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  return (
    <ModalOverlay
      title={`DESK OPTIONS — ${agent.name.toUpperCase()}`}
      width={460}
      zIndex={120}
      onClose={onClose}
      footer={<PixelButton variant="primary" size="md" onClick={onClose}>done</PixelButton>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 16 }}>
        {agent.isAssistant ? (
          <p style={{ margin: 0, fontSize: 14, color: 'var(--cth-ink-700)' }}>
            The assistant is send-only — it has no capability roles or workspace to configure.
          </p>
        ) : (
          <>
            <Section
              label="Roles"
              hint="Capability applies immediately; the desk auto-restarts (~1s) to pick up the role's prompt."
            >
              <AgentRoleControl agent={agent} />
            </Section>
            <Section
              label="Workspace"
              hint="Change the desk's working directory — this restarts it in the new folder."
            >
              <AgentWorkspaceControl agent={agent} />
            </Section>
          </>
        )}
      </div>
    </ModalOverlay>
  );
}

function Section({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '13px',
        color: 'var(--cth-ink-700)', textTransform: 'uppercase'
      }}>{label}</span>
      {children}
      <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{hint}</span>
    </div>
  );
}
