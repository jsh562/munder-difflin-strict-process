/**
 * Deterministic stub ProviderCall (E003) — drives the agent-loop end-to-end
 * without a real model: first call requests a tool, second ends the turn.
 * Electron-free so vitest exercises the loop. E006 replaces this with the real
 * DeepSeek/Minimax adapters implementing the same `ProviderCall` contract.
 */
import type { ProviderCall, ProviderTurn } from '../../../shared/providerCall';

export function makeStubProvider(): ProviderCall {
  let call = 0;
  return async (): Promise<ProviderTurn> => {
    call += 1;
    if (call === 1) {
      return {
        text: 'using a tool',
        toolUses: [{ toolName: 'echo', toolInput: { value: 'hi' }, toolCallId: 'call-1' }],
        usage: { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 },
        endOfTurn: false
      };
    }
    return {
      text: 'done',
      toolUses: [],
      usage: { input: 50, output: 10, cacheRead: 0, cacheCreation: 0 },
      endOfTurn: true
    };
  };
}

/** A trivial tool executor for the stub (echoes the input). */
export async function stubExecuteTool(use: { toolCallId: string; toolInput: unknown }): Promise<{ toolCallId: string; content: string; success: boolean }> {
  return { toolCallId: use.toolCallId, content: JSON.stringify(use.toolInput), success: true };
}
