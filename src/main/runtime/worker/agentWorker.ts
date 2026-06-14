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
import {
  runAgentLoop,
  makeStubProvider,
  stubExecuteTool,
  selectAdapter,
  NATIVE_PROVIDER_MODEL_ENV,
  AGENT_TOOL_CATALOG,
  NATIVE_AGENT_PREAMBLE
} from '@jsh562/won-agent-core';
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

  // Host-supplied native system-prompt additions: the orchestrator ROLE for a god desk
  // (so Michael runs the floor on a native provider) + the shell/OS briefing. Both are
  // stable per machine/desk ⇒ no prompt-cache bust. Order: base toolkit preamble → god
  // role (if any) → shell note.
  const godPrompt = (process.env.NATIVE_AGENT_GOD_PROMPT ?? '').trim();
  const reviewerPrompt = (process.env.NATIVE_AGENT_REVIEWER_PROMPT ?? '').trim();
  const integratorPrompt = (process.env.NATIVE_AGENT_INTEGRATOR_PROMPT ?? '').trim();
  // SDDP mode: a single spec-driven preamble assembled host-side from the desk's roles
  // (replaces the standard reviewer/integrator prompts above when the floor is in SDDP mode).
  const sddpPrompt = (process.env.NATIVE_AGENT_SDDP_PROMPT ?? '').trim();
  // The board transitions this (non-god) desk may make — host-derived from its roles so the
  // model knows what it can do on hive_update_task before attempting a move it can't.
  const boardLine = (process.env.NATIVE_AGENT_BOARD_LINE ?? '').trim();
  const envNote = (process.env.NATIVE_AGENT_ENV_NOTE ?? '').trim();
  // Order: base toolkit preamble → role prompt(s) (god orchestrator; or a non-god desk's
  // reviewer and/or integrator preamble — a desk can hold both; or the SDDP preamble when
  // the floor is in spec-driven mode) → board-capability line → shell note.
  const nativePreamble = [NATIVE_AGENT_PREAMBLE, godPrompt, reviewerPrompt, integratorPrompt, sddpPrompt, boardLine, envNote]
    .filter(Boolean)
    .join('\n\n');

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

  // E006 {FR-009} — advertise the coding toolkit to the model ON THE NATIVE PATH so it can
  // actually USE filesystem/search/shell/memory + mailbox/tasks (the execution seam above is
  // already wired; MAIN governs + sandboxes each call). Per-desk gating: MAIN passes
  // NATIVE_AGENT_DENY_TOOLS (tools this desk's roles can't use — e.g. hive_integrate for a
  // non-integrator, write/edit/bash for a read-only desk) so the model never sees (or attempts)
  // a tool the gate would deny. The stub fallback keeps prior behavior (no catalog).
  const denyTools = new Set((process.env.NATIVE_AGENT_DENY_TOOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const tools: ToolSpec[] | undefined = isNative ? AGENT_TOOL_CATALOG.filter((t) => !denyTools.has(t.name)) : undefined;

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
              // E006 — brief a native desk on the hive protocol + toolkit (the system
              // preamble a Claude desk gets via --append-system-prompt), plus the
              // host's shell/OS environment note. Stub path: none.
              systemPrompt: isNative ? nativePreamble : undefined,
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
