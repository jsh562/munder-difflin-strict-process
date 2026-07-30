/**
 * Electron utilityProcess transport (E003 / ADR-0003) — the real `WorkerTransport`
 * backing a NativeAgentWorker. This is the only native-runtime file that imports
 * electron; it forks the built `agentWorker.js` as an isolated OS process with a
 * bounded heap (`--max-old-space-size`). Not unit-tested (Electron-only API);
 * exercised by the app smoke (SC-001/SC-006).
 */
import { utilityProcess } from 'electron';
import { join } from 'node:path';
import type { WorkerCommand, WorkerMessage } from '../../shared/workerProtocol';
import type { WorkerTransport } from './nativeAgentWorker';

export function makeElectronWorkerTransport(opts: {
  agentId: string;
  maxOldSpaceMb?: number;
  /** E004 — the provider credential env injected at spawn (e.g. NATIVE_PROVIDER_API_KEY). */
  env?: Record<string, string>;
}): WorkerTransport {
  // The worker entry is built beside index.js by electron-vite (out/main/agentWorker.js).
  const workerPath = join(__dirname, 'agentWorker.js');
  const child = utilityProcess.fork(workerPath, [], {
    serviceName: `native-agent-${opts.agentId}`,
    execArgv: opts.maxOldSpaceMb ? [`--max-old-space-size=${opts.maxOldSpaceMb}`] : [],
    // Inject the credential over the normal env; absent ⇒ inherit (no key env).
    env: opts.env ? ({ ...process.env, ...opts.env } as NodeJS.ProcessEnv) : undefined
  });
  return {
    post: (cmd: WorkerCommand) => { child.postMessage(cmd); },
    onMessage: (cb) => { child.on('message', (msg: WorkerMessage) => cb(msg)); },
    onExit: (cb) => { child.on('exit', (code: number) => cb(code)); },
    kill: () => { child.kill(); }
  };
}
