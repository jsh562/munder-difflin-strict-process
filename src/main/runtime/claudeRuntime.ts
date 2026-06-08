/**
 * ClaudeRuntime (E001) — the main-process registry that owns one ClaudeAdapter
 * per agent and routes the existing runtime's signals (hook payloads, PTY bytes)
 * into the normalized AgentEvent stream. An IpcTranslator observes every adapter
 * so the legacy `hive:hookEvent` payload can be reproduced; its live send is OFF
 * in E001 (hooks.ts stays the sole emitter → zero behavior change, TR-005).
 *
 * Wiring is additive: nothing here changes the existing IPC or autonomy paths.
 */
import type { ProviderRuntime, UsageSnapshot } from '../../shared/providerRuntime';
import { ClaudeAdapter, type ClaudeHookSignal, type UsageReader } from './claudeAdapter';
import { IpcTranslator, type HiveHookEventSink } from './ipcTranslator';

export interface ClaudeRuntimeDeps {
  usage: UsageReader;
  /** Write text into an agent's PTY (PtyManager.write). */
  ptyWrite: (agentId: string, text: string) => void;
  /** Force-terminate an agent's PTY (PtyManager.kill). */
  ptyKill: (agentId: string) => void;
  /** Current Claude session id for an agent, when known. */
  sessionIdFor?: (agentId: string) => string | null;
}

export class ClaudeRuntime {
  private readonly adapters = new Map<string, ClaudeAdapter>();
  private readonly translator = new IpcTranslator();

  constructor(private readonly deps: ClaudeRuntimeDeps) {}

  /** Wire (but do not yet enable) the live renderer re-emission path. */
  attachIpc(sink: HiveHookEventSink): void {
    this.translator.attach(sink);
  }

  /** Flip live re-emission on (consumer-migration switch; default OFF in E001). */
  setTranslatorLive(live: boolean): void {
    this.translator.setLive(live);
  }

  /** Feed a Claude Code hook payload into the matching agent's adapter. */
  ingestHook(p: ClaudeHookSignal): void {
    const agentId = p.agent_id ?? undefined;
    if (!agentId) return;
    const adapter = this.adapterFor(agentId);
    adapter.ingestHook(p);
    adapter.emitUsage();
  }

  /** Feed a chunk of PTY output into the matching agent's adapter. */
  ingestPtyData(agentId: string, data: string): void {
    this.adapterFor(agentId).ingestText(data);
  }

  /** The ProviderRuntime for an agent, if one has been created. */
  runtimeFor(agentId: string): ProviderRuntime | undefined {
    return this.adapters.get(agentId);
  }

  private adapterFor(agentId: string): ClaudeAdapter {
    let adapter = this.adapters.get(agentId);
    if (!adapter) {
      adapter = new ClaudeAdapter({
        agentId,
        usage: this.deps.usage,
        getSessionId: () => this.deps.sessionIdFor?.(agentId) ?? null,
        ptyWrite: (text: string) => this.deps.ptyWrite(agentId, text),
        ptyKill: () => this.deps.ptyKill(agentId)
      });
      // The translator observes every adapter's normalized stream.
      adapter.subscribe(this.translator.onEvent);
      this.adapters.set(agentId, adapter);
    }
    return adapter;
  }
}

// Re-export the usage shape so consumers can satisfy the registry without
// reaching into the shared module path directly.
export type { UsageSnapshot };
