/** E006 T010/T011/T012 {FR-001/002/003/006/011} — DeepSeek adapter over a
 *  fabricated OpenAI-compatible SSE stream: index-keyed multi-call + multi-round
 *  tool assembly, reasoning→thinking (and NOT replayed), cumulative-monotonic usage,
 *  and malformed/interrupted tool-call safety. Electron-free, `fetch` injected
 *  (HINT-001); no live network. */
import { describe, it, expect } from 'vitest';
import {
  makeDeepseekAdapter,
  type FetchLike,
  type FetchResponseLike
} from '@munder/agent-core';
import type { ByteStream } from '@munder/agent-core';
import type { AgentEvent } from '../../../shared/agentEvent';
import type { ProviderRequest } from '../../../shared/providerCall';

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

/** A ByteStream whose reader rejects partway through (mid-tool-call interruption). */
function interruptedStreamOf(chunks: string[]): ByteStream {
  const enc = new TextEncoder();
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i < chunks.length) return { done: false, value: enc.encode(chunks[i++]) };
          throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        }
      };
    }
  };
}

/** One SSE `data:` line carrying a JSON chunk (DeepSeek/OpenAI streaming shape). */
function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** A successful streaming response wrapping a fabricated SSE body. */
function okResponse(body: ByteStream): FetchResponseLike {
  return {
    ok: true,
    status: 200,
    body,
    headers: { get: () => null },
    text: async () => ''
  };
}

/** Drive the adapter with a queue of responses (one per provider round). */
function adapterOver(responses: FetchResponseLike[]): {
  call: ReturnType<typeof makeDeepseekAdapter>;
  requests: { url: string; body: unknown }[];
} {
  const requests: { url: string; body: unknown }[] = [];
  let n = 0;
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    const res = responses[Math.min(n, responses.length - 1)];
    n++;
    return res;
  };
  const call = makeDeepseekAdapter({
    fetch,
    apiKey: 'sk-test-secret-key',
    endpoint: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash'
  });
  return { call, requests };
}

/** Collect emitted events while invoking one round. */
async function runRound(
  call: ReturnType<typeof makeDeepseekAdapter>,
  req: ProviderRequest
): Promise<{ turn: Awaited<ReturnType<typeof call>>; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  const turn = await call(req, (e) => events.push(e));
  return { turn, events };
}

const TOOL_REQ: ProviderRequest = {
  messages: [{ role: 'user', content: 'list the files then read one' }],
  tools: [{ name: 'list_dir', description: 'list', inputSchema: { type: 'object' } }]
};

describe('multi-round tool history — assistant tool_calls preserved (provider-400 fix)', () => {
  // A second-round request: the assistant turn that called a tool, then the tool reply.
  // Without serialized `tool_calls`, DeepSeek 400s the orphaned tool message.
  const MULTI_ROUND_REQ: ProviderRequest = {
    messages: [
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: '', toolCalls: [{ toolName: 'read_file', toolInput: { path: '/tmp/a.txt' }, toolCallId: 'call_x' }] },
      { role: 'tool', content: 'file contents', toolCallId: 'call_x' }
    ],
    tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }]
  };

  it('serializes the assistant tool calls as OpenAI tool_calls whose id matches the tool reply', async () => {
    const { call, requests } = adapterOver([
      okResponse(streamOf([sse({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })]))
    ]);
    await runRound(call, MULTI_ROUND_REQ);

    const body = requests[0].body as { messages: Array<Record<string, unknown>> };
    const assistant = body.messages.find((m) => m.role === 'assistant');
    expect(assistant?.tool_calls).toEqual([
      { id: 'call_x', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/a.txt' }) } }
    ]);
    const toolMsg = body.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.tool_call_id).toBe('call_x'); // binds to the assistant tool-call id
  });

  it('surfaces the provider error body on a non-2xx (diagnosability)', async () => {
    const errResponse: FetchResponseLike = {
      ok: false,
      status: 400,
      body: null,
      headers: { get: () => null },
      text: async () => '{"error":{"message":"messages: tool_call_id not found"}}'
    };
    const { call } = adapterOver([errResponse]);
    await expect(runRound(call, TOOL_REQ)).rejects.toThrow(/HTTP 400.*tool_call_id not found/);
  });
});

describe('T010 {FR-001,FR-002,FR-003} — index-keyed multi-call + multi-round assembly; reasoning→thinking', () => {
  it('assembles two concurrent tool calls keyed by index, parsing args only at completion', async () => {
    // Two tool calls interleaved across deltas, ids/names on the first delta per index,
    // arguments arriving as partial-JSON fragments that are only valid once joined.
    const body = streamOf([
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'list_dir', arguments: '{"path"' } }] } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'stat', arguments: '{"f":' } }] } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"/tmp"}' } }] } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"a.txt"}' } }] } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } }),
      'data: [DONE]\n\n'
    ]);
    const { call } = adapterOver([okResponse(body)]);
    const { turn } = await runRound(call, TOOL_REQ);

    expect(turn.toolUses).toHaveLength(2);
    expect(turn.toolUses[0]).toMatchObject({ toolName: 'list_dir', toolCallId: 'call_a', toolInput: { path: '/tmp' } });
    expect(turn.toolUses[1]).toMatchObject({ toolName: 'stat', toolCallId: 'call_b', toolInput: { f: 'a.txt' } });
    // A tool-requesting round is NOT end-of-turn (the loop runs the tools + re-calls).
    expect(turn.endOfTurn).toBe(false);
    expect(turn.stopReason).toBe('tool-use');
  });

  it('routes reasoning_content to thinking and content to text, and NEVER replays reasoning in the next request', async () => {
    // Round 1: reasoning + a tool call. Round 2: final answer, no tools.
    const round1 = streamOf([
      sse({ choices: [{ index: 0, delta: { reasoning_content: 'I should ' } }] }),
      sse({ choices: [{ index: 0, delta: { reasoning_content: 'list files.' } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
      'data: [DONE]\n\n'
    ]);
    const round2 = streamOf([
      sse({ choices: [{ index: 0, delta: { content: 'Found ' } }] }),
      sse({ choices: [{ index: 0, delta: { content: 'a.txt.' } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      sse({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } }),
      'data: [DONE]\n\n'
    ]);
    const { call } = adapterOver([okResponse(round1), okResponse(round2)]);

    const r1 = await runRound(call, TOOL_REQ);
    expect(r1.turn.thinking).toBe('I should list files.');
    expect(r1.events.some((e) => e.kind === 'thinking-start')).toBe(true);
    expect(r1.events.filter((e) => e.kind === 'thinking-delta')).toHaveLength(2);
    expect(r1.turn.text).toBeUndefined();

    // The loop would now run the tool and re-call WITHOUT replaying reasoning_content:
    // the assistant message carries only the (empty) text, never the thinking.
    const replay: ProviderRequest = {
      messages: [
        { role: 'user', content: 'list the files then read one' },
        { role: 'assistant', content: r1.turn.text ?? '' },
        { role: 'tool', content: 'a.txt', toolCallId: 'c1' }
      ],
      tools: TOOL_REQ.tools
    };
    const { call: call2, requests } = adapterOver([okResponse(round2)]);
    const r2 = await runRound(call2, replay);

    expect(r2.turn.text).toBe('Found a.txt.');
    expect(r2.turn.endOfTurn).toBe(true);
    expect(r2.turn.stopReason).toBe('end-of-turn');

    // Assert reasoning is absent from the wire body sent on the replay request.
    const sentBody = JSON.stringify(requests[0].body);
    expect(sentBody).not.toContain('reasoning_content');
    expect(sentBody).not.toContain('I should list files.');
  });

  it('never parses tool arguments from partial JSON mid-stream (only the joined result)', async () => {
    // If args were parsed per-fragment, '{"k":' would throw mid-stream; it must not.
    const body = streamOf([
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 't', arguments: '{"k":' } }] } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '42}' } }] } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n'
    ]);
    const { call } = adapterOver([okResponse(body)]);
    const { turn } = await runRound(call, TOOL_REQ);
    expect(turn.toolUses[0].toolInput).toEqual({ k: 42 });
  });
});

describe('T011 {FR-006} — cumulative-monotonic usage; absent cache fields = 0', () => {
  it('reads usage from the terminal include_usage chunk and never reports negative/decreasing fields', async () => {
    const body = streamOf([
      sse({ choices: [{ index: 0, delta: { content: 'hi' } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      sse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 30 } } }),
      'data: [DONE]\n\n'
    ]);
    const { call } = adapterOver([okResponse(body)]);
    const { turn } = await runRound(call, { messages: [{ role: 'user', content: 'hi' }], tools: [] });

    expect(turn.usage).toEqual({ input: 100, output: 40, cacheRead: 30, cacheCreation: 0 });
    // No field is negative.
    expect(Object.values(turn.usage).every((v) => v >= 0)).toBe(true);
  });

  it('accumulated across rounds the per-round deltas form a non-decreasing series', async () => {
    const round = (input: number, output: number): ByteStream =>
      streamOf([
        sse({ choices: [{ index: 0, delta: { content: 'x' } }] }),
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        sse({ choices: [], usage: { prompt_tokens: input, completion_tokens: output } }),
        'data: [DONE]\n\n'
      ]);
    const { call } = adapterOver([okResponse(round(50, 10)), okResponse(round(70, 25))]);

    const r1 = await runRound(call, { messages: [{ role: 'user', content: 'a' }], tools: [] });
    const r2 = await runRound(call, { messages: [{ role: 'user', content: 'b' }], tools: [] });

    // Each round reports its OWN usage as a non-negative delta; the loop sums them.
    // Emulate the loop's accumulation and assert monotonic non-decrease.
    const cum1 = r1.turn.usage;
    const cum2 = {
      input: cum1.input + r2.turn.usage.input,
      output: cum1.output + r2.turn.usage.output,
      cacheRead: cum1.cacheRead + r2.turn.usage.cacheRead,
      cacheCreation: cum1.cacheCreation + r2.turn.usage.cacheCreation
    };
    expect(cum2.input).toBeGreaterThanOrEqual(cum1.input);
    expect(cum2.output).toBeGreaterThanOrEqual(cum1.output);
    expect(cum2).toEqual({ input: 120, output: 35, cacheRead: 0, cacheCreation: 0 });
  });

  it('passes provider-reported usd through when present without recomputing', async () => {
    const body = streamOf([
      sse({ choices: [{ index: 0, delta: { content: 'k' } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, usd: 0.0042 } }),
      'data: [DONE]\n\n'
    ]);
    const { call } = adapterOver([okResponse(body)]);
    const turn = await call({ messages: [{ role: 'user', content: 'k' }], tools: [] });
    expect(turn.usd).toBe(0.0042);
  });
});

describe('T012 {FR-011} — malformed/partial tool-call JSON ⇒ no tool executed; interrupted stream ⇒ retryable error', () => {
  it('a completed tool call with unparseable arguments surfaces an error and yields NO tool use', async () => {
    // The call "completes" (finish_reason:tool_calls) but the joined args are invalid.
    const body = streamOf([
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 't', arguments: '{"k": ' } }] } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'oops' } }] } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n'
    ]);
    const { call } = adapterOver([okResponse(body)]);
    // It throws (surfaced to the loop as api-error) rather than producing a tool call.
    await expect(call(TOOL_REQ)).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('a stream interrupted mid-tool-call discards the incomplete call and throws a retryable-shaped error', async () => {
    // The tool call started but the connection drops before completion.
    const body = interruptedStreamOf([
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 't', arguments: '{"par' } }] } }] })
      // reader throws on the next read — no finish_reason, no terminal usage chunk.
    ]);
    const { call } = adapterOver([okResponse(body)]);
    const err = await call(TOOL_REQ).catch((e) => e);
    // Reliability-shaped, classified retryable (network/stream-interrupted code).
    expect(err).toMatchObject({ code: 'stream-interrupted' });
  });

  it('a stream that ends before tool-call completion (no finish_reason) is treated as interrupted', async () => {
    // Clean stream end but the tool call never reached finish_reason:tool_calls and no
    // terminal usage chunk arrived → discard + retryable error.
    const body = streamOf([
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 't', arguments: '{"a"' } }] } }] })
      // no [DONE], no finish_reason, no usage — the generator just ends.
    ]);
    const { call } = adapterOver([okResponse(body)]);
    const err = await call(TOOL_REQ).catch((e) => e);
    expect(err).toMatchObject({ code: 'stream-interrupted' });
  });

  it('a non-OK HTTP response throws a status-shaped error the reliability layer can classify', async () => {
    const res: FetchResponseLike = {
      ok: false,
      status: 503,
      body: null,
      headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '2' : null) },
      text: async () => 'service unavailable'
    };
    const { call } = adapterOver([res]);
    const err = await call(TOOL_REQ).catch((e) => e);
    expect(err).toMatchObject({ status: 503, retryAfter: '2' });
  });

  it('never writes the API key into any emitted event, turn, or request body (FR-013)', async () => {
    const body = streamOf([
      sse({ choices: [{ index: 0, delta: { reasoning_content: 'think' } }] }),
      sse({ choices: [{ index: 0, delta: { content: 'done' } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      'data: [DONE]\n\n'
    ]);
    const { call, requests } = adapterOver([okResponse(body)]);
    const { turn, events } = await runRound(call, { messages: [{ role: 'user', content: 'go' }], tools: [] });

    const key = 'sk-test-secret-key';
    expect(JSON.stringify(turn)).not.toContain(key);
    expect(JSON.stringify(events)).not.toContain(key);
    // The key is carried only in the Authorization header at the fetch boundary, never
    // in the request body the adapter assembles.
    expect(JSON.stringify(requests[0].body)).not.toContain(key);
  });
});
