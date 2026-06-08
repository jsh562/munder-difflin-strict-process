/**
 * Native agent worker ENTRY (E003 / ADR-0003) — runs INSIDE the Electron
 * utilityProcess. It bridges the worker IPC protocol to the pure agent-loop:
 * receives WorkerCommands on `process.parentPort`, runs `runAgentLoop`, and posts
 * AgentEvents / drain requests back. No electron import — `process.parentPort` is
 * provided by the utilityProcess runtime. The provider call is the stub here;
 * E006 swaps in the real DeepSeek/Minimax adapter.
 */
import { runAgentLoop } from './agentLoop';
import { makeStubProvider, stubExecuteTool } from './stubProvider';
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
  const pendingDrains = new Map<number, (r: { block: boolean; reason?: string }) => void>();

  const post = (msg: WorkerMessage): void => parentPort.postMessage(msg);

  const requestDrain = (): Promise<{ block: boolean; reason?: string }> => {
    const turnId = ++turnSeq;
    return new Promise((resolve) => {
      pendingDrains.set(turnId, resolve);
      post({ type: 'drainRequest', turnId });
    });
  };

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
              providerCall: makeStubProvider(), // E006 injects the real adapter
              executeTool: stubExecuteTool,
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
    }
  };

  parentPort.on('message', (e) => { void onCommand(e.data); });
  parentPort.start?.();
}
