/** E006 T030 {FR-013} [COMPLETES FR-013] — the API key (and ANY substring of it,
 *  or the `Authorization`/`Bearer` header value carrying it) MUST appear in NONE of
 *  the adapter sinks: emitted AgentEvents, the returned ProviderTurn (text/thinking/
 *  tool inputs), the usage payload, OR any error/`api-error`/diagnostic message — on
 *  the success path AND a forced error path (a 401). The key may appear ONLY in the
 *  outgoing request header passed to the injected `fetch` (the fetch boundary).
 *
 *  This drives BOTH native adapters (DeepSeek OpenAI-compat + Minimax M3
 *  Anthropic-compat) with a sentinel key over a minimal valid SSE fixture that
 *  includes content, a tool call, thinking, and usage — so the absence assertions
 *  cover the full FR-013 surface set (events / turn / usage / error). Electron-free,
 *  `fetch` injected (HINT-001); no live network. */
import { describe, it, expect } from 'vitest';
import {
  makeDeepseekAdapter,
  type FetchLike as DsFetch,
  type FetchResponseLike as DsResponse
} from '@jsh562/agent-core';
import {
  makeMinimaxAdapter,
  type FetchLike as MmFetch,
  type FetchResponseLike as MmResponse
} from '@jsh562/agent-core';
import type { ByteStream } from '@jsh562/agent-core';
import type { AgentEvent } from '../../../shared/agentEvent';
import type { ProviderCall, ProviderRequest, ProviderTurn } from '../../../shared/providerCall';

// A sentinel key whose presence in any sink is unmistakable. The leak assertions
// check the WHOLE key AND a load-bearing substring of it — so a redacted/truncated
// partial-key exposure (also forbidden by FR-013) is caught, not just the full key.
const SENTINEL_KEY = 'sk-LEAKCANARY-DO-NOT-EMIT-12345';
const KEY_SUBSTRING = 'LEAKCANARY'; // ≥ a few chars; any substring exposure fails FR-013
// The exact header value the adapters construct at the fetch boundary — the Authorization
// bearer string must ALSO never appear in a sink (it carries the key verbatim).
const BEARER_VALUE = `Bearer ${SENTINEL_KEY}`;

/** Build a ByteStream that yields the given UTF-8 chunks (split exactly as passed). */
function streamOf(chunks: string[]): ByteStream {
  const enc = new TextEncoder();
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i < chunks.length) return { done: false, value: enc.encode(chunks[i++]) };
          return { done: true };
        }
      };
    }
  };
}

/** Assert the key, its substring, and the bearer header value are absent from `blob`. */
function assertKeyFree(blob: string, where: string): void {
  expect(blob, `${where} must not contain the full key`).not.toContain(SENTINEL_KEY);
  expect(blob, `${where} must not contain a key substring`).not.toContain(KEY_SUBSTRING);
  expect(blob, `${where} must not contain the Authorization bearer value`).not.toContain(BEARER_VALUE);
}

/** Drive a `ProviderCall`, capturing every emitted event + the returned turn. */
async function capture(
  call: ProviderCall,
  req: ProviderRequest
): Promise<{ turn: ProviderTurn; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  const turn = await call(req, (e) => events.push(e));
  return { turn, events };
}

const TOOL_REQ: ProviderRequest = {
  messages: [{ role: 'user', content: 'use the tool then answer' }],
  tools: [{ name: 'list_dir', description: 'list', inputSchema: { type: 'object' } }]
};

// ── DeepSeek (OpenAI-compatible) ──────────────────────────────────────────────

/** One OpenAI-style streaming `data:` chunk. */
function dsSse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** A minimal-but-complete DeepSeek SSE body: reasoning + text + a tool call + usage. */
function deepseekFixture(): ByteStream {
  return streamOf([
    dsSse({ choices: [{ index: 0, delta: { reasoning_content: 'plan: list files' } }] }),
    dsSse({ choices: [{ index: 0, delta: { content: 'on it' } }] }),
    dsSse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'list_dir', arguments: '{"path":"/tmp"}' } }] } }] }),
    dsSse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    dsSse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 6, usd: 0.0001 } }),
    'data: [DONE]\n\n'
  ]);
}

function deepseekFetch(response: DsResponse): { fetch: DsFetch; seen: { headers: Record<string, string>; body: string }[] } {
  const seen: { headers: Record<string, string>; body: string }[] = [];
  const fetch: DsFetch = async (_url, init) => {
    seen.push({ headers: init.headers, body: init.body });
    return response;
  };
  return { fetch, seen };
}

// ── Minimax (Anthropic-compatible) ────────────────────────────────────────────

/** One named Anthropic-style SSE event carrying a JSON `data:` payload. */
function mmSse(eventName: string, obj: Record<string, unknown>): string {
  return `event: ${eventName}\ndata: ${JSON.stringify({ type: eventName, ...obj })}\n\n`;
}

/** A minimal-but-complete Minimax SSE body: thinking + text + a tool_use + usage. */
function minimaxFixture(): ByteStream {
  return streamOf([
    mmSse('message_start', { message: { usage: { input_tokens: 14, output_tokens: 1 } } }),
    mmSse('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
    mmSse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'plan: list files' } }),
    mmSse('content_block_stop', { index: 0 }),
    mmSse('content_block_start', { index: 1, content_block: { type: 'text' } }),
    mmSse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'on it' } }),
    mmSse('content_block_stop', { index: 1 }),
    mmSse('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_a', name: 'list_dir' } }),
    mmSse('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"/tmp"}' } }),
    mmSse('content_block_stop', { index: 2 }),
    mmSse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7, usd: 0.0002 } }),
    mmSse('message_stop', {})
  ]);
}

function minimaxFetch(response: MmResponse): { fetch: MmFetch; seen: { headers: Record<string, string>; body: string }[] } {
  const seen: { headers: Record<string, string>; body: string }[] = [];
  const fetch: MmFetch = async (_url, init) => {
    seen.push({ headers: init.headers, body: init.body });
    return response;
  };
  return { fetch, seen };
}

/** A successful streaming response wrapping a fabricated SSE body. */
function okResponse(body: ByteStream): DsResponse & MmResponse {
  return { ok: true, status: 200, body, headers: { get: () => null }, text: async () => '' };
}

/** A 401 error response — the forced terminal error path (auth failure). */
function unauthorizedResponse(): DsResponse & MmResponse {
  return {
    ok: false,
    status: 401,
    body: null,
    headers: { get: () => null },
    // A hostile body that ECHOES the key — proving the adapter never copies the
    // response body (or the request key) into the surfaced error message.
    text: async () => `unauthorized: provided key ${SENTINEL_KEY} is invalid`
  };
}

describe('T030 {FR-013} — the API key never leaks to any adapter sink (both adapters)', () => {
  it('DeepSeek: key absent from events, turn, usage — present ONLY in the request Authorization header', async () => {
    const { fetch, seen } = deepseekFetch(okResponse(deepseekFixture()));
    const call = makeDeepseekAdapter({
      fetch,
      apiKey: SENTINEL_KEY,
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash'
    });
    const { turn, events } = await capture(call, TOOL_REQ);

    // Sanity: the fixture actually exercised content/tool/thinking/usage (so the
    // absence assertions below are meaningful, not vacuous over an empty turn).
    expect(turn.toolUses).toHaveLength(1);
    expect(turn.thinking).toContain('plan');
    expect(turn.text).toContain('on it');
    expect(turn.usage.input).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);

    // The full FR-013 sink set: emitted events, the returned turn (text/thinking/
    // tool inputs/stop), and the usage payload — none may carry the key.
    assertKeyFree(JSON.stringify(events), 'DeepSeek emitted events');
    assertKeyFree(JSON.stringify(turn), 'DeepSeek ProviderTurn');
    assertKeyFree(JSON.stringify(turn.usage), 'DeepSeek usage payload');
    assertKeyFree(JSON.stringify(turn.toolUses), 'DeepSeek tool uses');

    // The request BODY the adapter assembled must also be key-free…
    assertKeyFree(seen[0].body, 'DeepSeek request body');
    // …and the key is present ONLY in the Authorization header at the fetch boundary.
    expect(seen[0].headers.authorization).toBe(BEARER_VALUE);
  });

  it('Minimax: key absent from events, turn, usage — present ONLY in the request auth headers', async () => {
    const { fetch, seen } = minimaxFetch(okResponse(minimaxFixture()));
    const call = makeMinimaxAdapter({
      fetch,
      apiKey: SENTINEL_KEY,
      endpoint: 'https://api.minimax.io',
      model: 'minimax-m3'
    });
    const { turn, events } = await capture(call, TOOL_REQ);

    expect(turn.toolUses).toHaveLength(1);
    expect(turn.thinking).toContain('plan');
    expect(turn.text).toContain('on it');
    expect(turn.usage.input).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);

    assertKeyFree(JSON.stringify(events), 'Minimax emitted events');
    assertKeyFree(JSON.stringify(turn), 'Minimax ProviderTurn');
    assertKeyFree(JSON.stringify(turn.usage), 'Minimax usage payload');
    assertKeyFree(JSON.stringify(turn.toolUses), 'Minimax tool uses');

    assertKeyFree(seen[0].body, 'Minimax request body');
    // The key lives ONLY in the auth headers at the fetch boundary (x-api-key + bearer).
    expect(seen[0].headers['x-api-key']).toBe(SENTINEL_KEY);
    expect(seen[0].headers.authorization).toBe(BEARER_VALUE);
  });

  it('DeepSeek: a forced 401 surfaces a key-free error (the key/Authorization value is absent from the message)', async () => {
    const { fetch } = deepseekFetch(unauthorizedResponse());
    const call = makeDeepseekAdapter({
      fetch,
      apiKey: SENTINEL_KEY,
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash'
    });
    const events: AgentEvent[] = [];
    const err = await call(TOOL_REQ, (e) => events.push(e)).catch((e) => e);

    // The adapter throws a classifiable, key-free error — the loop maps it to api-error.
    expect(err).toBeTruthy();
    expect((err as { status?: number }).status).toBe(401);
    // Neither the error (message + full serialized error) nor any event leaked the key,
    // even though the 401 response body itself echoed the key (it is never copied out).
    assertKeyFree(String((err as Error).message ?? ''), 'DeepSeek 401 error message');
    assertKeyFree(JSON.stringify(err, Object.getOwnPropertyNames(err as object)), 'DeepSeek 401 error object');
    assertKeyFree(JSON.stringify(events), 'DeepSeek 401 emitted events');
  });

  it('Minimax: a forced 401 surfaces a key-free error (the key/Authorization value is absent from the message)', async () => {
    const { fetch } = minimaxFetch(unauthorizedResponse());
    const call = makeMinimaxAdapter({
      fetch,
      apiKey: SENTINEL_KEY,
      endpoint: 'https://api.minimax.io',
      model: 'minimax-m3'
    });
    const events: AgentEvent[] = [];
    const err = await call(TOOL_REQ, (e) => events.push(e)).catch((e) => e);

    expect(err).toBeTruthy();
    expect((err as { status?: number }).status).toBe(401);
    assertKeyFree(String((err as Error).message ?? ''), 'Minimax 401 error message');
    assertKeyFree(JSON.stringify(err, Object.getOwnPropertyNames(err as object)), 'Minimax 401 error object');
    assertKeyFree(JSON.stringify(events), 'Minimax 401 emitted events');
  });
});
