/**
 * Native agent worker ENTRY (E003 / ADR-0003 — E006 / FR-008/009) — runs INSIDE
 * the Electron utilityProcess. It bridges the worker IPC protocol to the pure
 * agent-loop: receives WorkerCommands on `process.parentPort`, runs `runAgentLoop`,
 * and posts AgentEvents / drain + tool requests back. No electron import —
 * `process.parentPort` is provided by the utilityProcess runtime.
 *
 * E006 wires the real provider + the hive seam:
 *  - the ProviderCall is selected from the INJECTED provider env via `selectAdapter`
 *    (the ONLY place that reads `process.env` for provider selection, AD-002),
 *    falling back to the stub when no native provider is assigned (FR-008);
 *  - the desk's assigned model is threaded into the loop deps (`model`) so usage
 *    events carry it;
 *  - `executeTool` routes each tool call to MAIN over IPC (`toolRequest` →
 *    `toolResult`); MAIN executes against the hive tool handlers (single-committer
 *    preserved, FR-009). The stub's local echo is used only on the stub fallback.
 */
import { runAgentLoop } from './agentLoop';
import { makeStubProvider, stubExecuteTool } from './stubProvider';
import { selectAdapter } from './adapters/selectAdapter';
import { NATIVE_PROVIDER_MODEL_ENV } from './adapters/selectAdapterEnv';
import { HIVE_TOOL_CATALOG } from '../hiveTools';
import type { ToolSpec, ToolUseRequest } from '../../../shared/providerCall';
import type { WorkerCommand, WorkerMessage } from '../../../shared/workerProtocol';

interface ParentPortLike {
  on(ev: 'message', cb: (e: { data: WorkerCommand }) => void): void;
  postMessage(msg: WorkerMessage): void;
  start?(): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

if (parentPort) {
  let agentId = 'native';
  let sessionId: string | null = null;
  let running = false;
  let turnSeq = 0;
  let toolSeq = 0;
  const pendingDrains = new Map<number, (r: { block: boolean; reason?: string }) => void>();
  const pendingTools = new Map<number, (r: { content: string; success: boolean }) => void>();

  const post = (msg: WorkerMessage): void => parentPort.postMessage(msg);

  // Select the real provider from the injected env (AD-002 / FR-008). This is the
  // single place provider selection reads `process.env`; null ⇒ no native provider
  // assigned, so the stub keeps existing behavior/tests working unchanged.
  const adapter = selectAdapter(process.env);
  const providerCall = adapter ?? makeStubProvider();
  const isNative = adapter !== null;
  const model = (process.env[NATIVE_PROVIDER_MODEL_ENV] ?? '').trim() || null;

  const requestDrain = (): Promise<{ block: boolean; reason?: string }> => {
    const turnId = ++turnSeq;
    return new Promise((resolve) => {
      pendingDrains.set(turnId, resolve);
      post({ type: 'drainRequest', turnId });
    });
  };

  // E006 {FR-009} — route a tool call to MAIN and await its result. MAIN executes
  // it against the hive (single-committer); the worker is never the writer. On the
  // stub fallback there is no native hive seam, so the stub's local echo is used.
  const executeTool = isNative
    ? (use: ToolUseRequest): Promise<{ toolCallId: string; content: string; success: boolean }> => {
        const callId = ++toolSeq;
        return new Promise((resolve) => {
          pendingTools.set(callId, (r) =>
            resolve({ toolCallId: use.toolCallId, content: r.content, success: r.success })
          );
          post({
            type: 'toolRequest',
            callId,
            toolCallId: use.toolCallId,
            toolName: use.toolName,
            toolInput: use.toolInput
          });
        });
      }
    : stubExecuteTool;

  // E006 {FR-009} — advertise the core hive-tool catalog to the model ON THE NATIVE
  // PATH so it can actually USE memory/mailbox/tasks (the execution seam above is
  // already wired). The stub fallback keeps prior behavior (no catalog), so existing
  // stub tests are unchanged. The catalog names match `executeHiveTool` exactly.
  const tools: ToolSpec[] | undefined = isNative ? [...HIVE_TOOL_CATALOG] : undefined;

  const onCommand = async (cmd: WorkerCommand): Promise<void> => {
    switch (cmd.type) {
      case 'start':
        agentId = cmd.agentId;
        sessionId = cmd.sessionId ?? null;
        post({ type: 'ready' });
        break;
      case 'send':
        if (running) return; // one loop at a time
        running = true;
        try {
          await runAgentLoop(
            {
              agentId,
              sessionId,
              model,
              providerCall,
              executeTool,
              tools,
              emit: (event) => post({ type: 'event', event }),
              requestDrain,
              caps: { maxTurns: 50, maxHops: 50 }
            },
            cmd.input.text
          );
        } finally {
          running = false;
          post({ type: 'idle' });
        }
        break;
      case 'stop':
        post({ type: 'exit', reason: 'stopped' });
        process.exit(0);
        break;
      case 'kill':
        process.exit(0);
        break;
      case 'drainResult': {
        const resolve = pendingDrains.get(cmd.turnId);
        if (resolve) {
          pendingDrains.delete(cmd.turnId);
          resolve({ block: cmd.block, reason: cmd.reason });
        }
        break;
      }
      case 'toolResult': {
        const resolve = pendingTools.get(cmd.callId);
        if (resolve) {
          pendingTools.delete(cmd.callId);
          resolve({ content: cmd.content, success: cmd.success });
        }
        break;
      }
    }
  };

  parentPort.on('message', (e) => { void onCommand(e.data); });
  parentPort.start?.();
}
