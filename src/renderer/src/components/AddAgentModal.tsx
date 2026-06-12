import { useMemo, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { Icon } from './Icon';
import { ProviderModelPicker } from './ProviderModelPicker';
import { useStore, type Agent } from '@/store/store';
import { OFFICE_CAST, DEFAULT_CHARACTER, type OfficeCharacterName } from '@/scene/office/cast';
import { type AccentColorName } from '@/design/tokens';
import { type HarnessConfig, buildSpawnCommand } from '@/store/config';
import { listProviders } from '@shared/providerRegistry';
import { deriveProviderId, resolveEffectiveModel } from '@shared/assignment';

const ACCENTS: AccentColorName[] = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function uniqueId(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
}

export interface AddAgentModalProps {
  onClose: () => void;
  config: HarnessConfig;
}

export function AddAgentModal({ onClose, config }: AddAgentModalProps) {
  const addAgent = useStore(s => s.addAgent);

  const [name, setName] = useState('Jim');
  const [character, setCharacter] = useState<OfficeCharacterName>(DEFAULT_CHARACTER);
  const [accent, setAccent] = useState<AccentColorName>('sky');
  const [cwd, setCwd] = useState<string>(config.registeredRepos[0] ?? '');
  // The picker shows the fleet default pre-highlighted so the operator sees what a
  // new agent will inherit; `explicitlyPicked` tracks whether they actually CHOSE a
  // model (vs leaving the inherited default). This is what makes the
  // snapshot-at-creation provenance honest (DR-4/HINT-002): inheriting the default
  // is recorded as 'fleet-default', a deliberate pick as 'explicit' — even when the
  // picked id equals the current default.
  const [model, setModel] = useState<string | undefined>(config.defaultModel);
  const [explicitlyPicked, setExplicitlyPicked] = useState(false);
  const [command, setCommand] = useState(buildSpawnCommand(config, config.defaultModel));
  const [description, setDescription] = useState('a fresh harness');

  // E005 — whether the registry exposes any pickable model. When empty, the picker
  // shows its empty-state and agent creation falls back to the existing role-based
  // default (no explicit assignment recorded — DR-7/FR-012, T011).
  const hasModels = useMemo(() => listProviders().some((p) => p.models.length > 0), []);

  // A native (non-Claude) desk runs on the provider worker, NOT the `claude` CLI — so
  // the "Command" field's `claude --model …` carrier is never executed for it (main
  // routes it via nativeRuntime.spawn). When the picked model is native we show a
  // read-only runtime note instead of the misleading editable command. The hidden
  // `command` carrier is still built/sent unchanged, so spawn routing is unaffected.
  const nativeInfo = useMemo(() => {
    const providerId = deriveProviderId(model);
    if (!providerId || providerId === 'anthropic') return null;
    const provider = listProviders().find((p) => p.id === providerId);
    return { label: provider?.displayName ?? providerId };
  }, [model]);

  // Picking a model rebuilds the command and marks the choice EXPLICIT; the command
  // field stays editable for power users (it's the source of truth for the actual
  // spawn).
  const pickModel = (id?: string) => {
    setModel(id);
    setExplicitlyPicked(true);
    setCommand(buildSpawnCommand(config, id));
  };
  const [goal, setGoal] = useState('');
  const [isolate, setIsolate] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const pickFolder = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) setCwd(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  const submit = async () => {
    setError(undefined);
    if (!name.trim()) { setError('Name is required'); return; }
    if (!cwd) { setError('Pick a folder first'); return; }
    if (!command.trim()) { setError('Command is required'); return; }

    setBusy(true);
    const id = uniqueId(name);
    const ptyId = `pty-${id}`;
    // The command field contains `claude --permission-mode bypassPermissions`
    // for auto mode. Split into argv-style for node-pty.
    const [exe, ...args] = command.trim().split(/\s+/);
    const spawnRes = await window.cth.spawnPty({
      id: ptyId,
      cwd,
      command: exe,
      args,
      cols: 100,
      rows: 30,
      // When set, the main process spawns this agent in its own git worktree.
      isolate,
      // Provision this agent in the hive (memory + mailbox + identity/protocol).
      hive: {
        id,
        name: name.trim(),
        cwd,
        role: description.trim() || undefined
      }
    });
    if (!spawnRes.ok) {
      setBusy(false);
      setError(spawnRes.error ?? 'spawn failed');
      return;
    }

    // E005 {FR-006} — snapshot the effective model + provenance onto the record AT
    // CREATION (DR-4/HINT-002). An EXPLICIT pick wins; otherwise we inherit the
    // current fleet default (config.defaultModel) and FREEZE it as a value — we
    // store the resolved id, never a live reference, so a later change to the
    // default does NOT mutate this agent (non-retroactive). With an empty registry
    // (or nothing to resolve) the agent carries no assignment and falls through to
    // the existing role-based default behavior (T011/DR-7). Provider is derived
    // from `model`, not stored (DR-1).
    const resolved = hasModels
      ? resolveEffectiveModel({
          explicitModelId: explicitlyPicked ? model : undefined,
          fleetDefaultModelId: config.defaultModel
        })
      : { modelId: undefined, source: 'none' as const };
    const assignmentSource =
      resolved.source === 'explicit' || resolved.source === 'fleet-default'
        ? resolved.source
        : undefined;

    const agent: Agent = {
      id,
      name: name.trim(),
      character,
      accent,
      description: description.trim() || 'a fresh harness',
      project: basename(cwd),
      tmuxTarget: '',
      cwd,
      goal: goal.trim() || undefined,
      status: 'idle',
      action: 'starting up',
      progress: 0,
      currentStation: 'desk',
      ptyId,
      command: command.trim(),
      // The snapshotted effective model (explicit pick → fleet default), or the
      // operator's raw `model` when nothing resolved (empty registry → still feeds
      // the command they may have hand-edited).
      model: resolved.modelId ?? model,
      assignmentSource,
      recentTextTs: Date.now()
    };
    addAgent(agent);
    setBusy(false);
    onClose();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 600, maxWidth: '92vw' }}>
        <PixelPanel
          variant="dialog"
          title="ADD AGENT"
          style={{ padding: 16 }}
          noPadding
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
            <Row label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ada"
                style={inputStyle}
              />
            </Row>

            <Row label="Folder">
              {config.registeredRepos.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                  {config.registeredRepos.map((r) => (
                    <button
                      key={r}
                      onClick={() => setCwd(r)}
                      title={r}
                      style={{
                        padding: '3px 8px 1px',
                        background: cwd === r ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                        boxShadow: cwd === r
                          ? 'inset 0 0 0 2px var(--cth-ink-900)'
                          : 'inset 0 0 0 1px var(--cth-ink-700)',
                        fontFamily: 'var(--cth-font-ui)',
                        fontSize: 13,
                        cursor: 'pointer',
                        border: 'none'
                      }}
                    >
                      {basename(r)}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="/path/to/your/project"
                  style={{ ...inputStyle, flex: 1, fontFamily: 'var(--cth-font-mono)', fontSize: 14 }}
                />
                <PixelButton variant="secondary" size="md" onClick={pickFolder}>
                  <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                    <Icon name="folder" /> pick
                  </span>
                </PixelButton>
              </div>
            </Row>

            <Row label="Model">
              <ProviderModelPicker
                selectedModelId={model}
                onChange={pickModel}
                accent={accent}
              />
            </Row>

            {nativeInfo ? (
              <Row label="Runtime">
                <div style={nativeNoteStyle}>
                  Runs on the <strong>{nativeInfo.label}</strong> worker —{' '}
                  <span style={{ fontFamily: 'var(--cth-font-mono)' }}>{model}</span>. No{' '}
                  <span style={{ fontFamily: 'var(--cth-font-mono)' }}>claude</span> command is executed.
                  {' '}Set the {nativeInfo.label} API key in Settings → Provider API keys.
                </div>
              </Row>
            ) : (
              <Row label={config.autoMode ? 'Command (auto mode on)' : 'Command'}>
                <input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="claude"
                  style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}
                />
              </Row>
            )}

            <Row label="Description">
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="what is this agent for"
                style={inputStyle}
              />
            </Row>

            <Row label="Goal (optional)">
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="long-running directive injected on every prompt"
                rows={2}
                style={{ ...inputStyle, fontFamily: 'var(--cth-font-ui)', resize: 'none' }}
              />
            </Row>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={isolate}
                onChange={(e) => setIsolate(e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14, color: 'var(--cth-ink-900)' }}>
                Git isolation (own worktree)
              </span>
            </label>

            <Row label="Character">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {OFFICE_CAST.map(c => (
                  <button
                    key={c.name}
                    onClick={() => { setCharacter(c.name); setName(c.displayName); }}
                    title={c.blurb}
                    style={{
                      padding: 4,
                      background: character === c.name ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                      boxShadow: character === c.name
                        ? 'inset 0 0 0 2px var(--cth-ink-900)'
                        : 'inset 0 0 0 1px var(--cth-ink-700)',
                      cursor: 'pointer',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                      border: 'none', width: 56
                    }}
                  >
                    <div style={{ width: 44, height: 56, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden' }}>
                      <SpritePortrait character={c.name} scale={2} />
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>{c.displayName}</span>
                  </button>
                ))}
              </div>
            </Row>

            <Row label="Color">
              <div style={{ display: 'flex', gap: 6 }}>
                {ACCENTS.map(a => (
                  <button
                    key={a}
                    onClick={() => setAccent(a)}
                    style={{
                      width: 32, height: 32,
                      background: `var(--cth-${a})`,
                      boxShadow: accent === a
                        ? 'inset 0 0 0 2px var(--cth-ink-900), 0 0 0 2px var(--cth-ink-900)'
                        : 'inset 0 0 0 1px var(--cth-ink-900)',
                      cursor: 'pointer',
                      border: 'none'
                    }}
                    aria-label={a}
                  />
                ))}
              </div>
            </Row>

            {error && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                fontSize: 14,
                color: 'var(--cth-ink-900)'
              }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <PixelButton variant="ghost" size="md" onClick={onClose} disabled={busy}>cancel</PixelButton>
              <PixelButton variant="primary" size="md" onClick={submit} disabled={busy}>
                {busy ? 'spawning...' : 'spawn'}
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 16,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};

const nativeNoteStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  background: 'var(--cth-paper-100)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 13,
  lineHeight: '18px',
  color: 'var(--cth-ink-700)'
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontFamily: 'var(--cth-font-display)',
        fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-700)',
        textTransform: 'uppercase'
      }}>{label}</span>
      {children}
    </label>
  );
}
