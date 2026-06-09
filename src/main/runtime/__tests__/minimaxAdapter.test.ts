/** E006 T016/T017 {FR-004/005/006/011} — Minimax M3 adapter over a fabricated
 *  Anthropic-compatible SSE stream: index-keyed content-block assembly with
 *  `tool_use` input parsed from `partial_json` at `content_block_stop`, thinking
 *  distinct from text, `stop_reason:tool_use` ⇒ continue, cumulative-monotonic usage
 *  (latest message_delta, no double-count), and the context-length pricing-tier pair
 *  derived from the E002 registry `contextTierThreshold`. Electron-free, `fetch`
 *  injected (HINT-001); no live network. */
import { describe, it, expect } from 'vitest';
import {
  makeMinimaxAdapter,
  selectContextTier,
  contextTierThreshold,
  type FetchLike,
  type FetchResponseLike
} from '../worker/adapters/minimaxAdapter';
import type { ByteStream } from '../worker/adapters/sseParser';
import type { AgentEvent } from '../../../shared/agentEvent';
import type { ProviderRequest } from '../../../shared/providerCall';
import { lookupModel } from '../../../shared/providerRegistry';

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

/** One named Anthropic-style SSE event carrying a JSON `data:` payload. */
function sse(eventName: string, obj: Record<string, unknown>): string {
  return `event: ${eventName}\ndata: ${JSON.stringify({ type: eventName, ...obj })}\n\n`;
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
  call: ReturnType<typeof makeMinimaxAdapter>;
  requests: { url: string; body: unknown; headers: Record<string, string> }[];
} {
  const requests: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  let n = 0;
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const res = responses[Math.min(n, responses.length - 1)];
    n++;
    return res;
  };
  const call = makeMinimaxAdapter({
    fetch,
    apiKey: 'mm-test-secret-key',
    endpoint: 'https://api.minimax.io',
    model: 'minimax-m3'
  });
  return { call, requests };
}

/** Collect emitted events while invoking one round. */
async function runRound(
  call: ReturnType<typeof makeMinimaxAdapter>,
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

describe('T016 {FR-004,FR-005} — content-block assembly, thinking vs text, tool-use stop ⇒ continue', () => {
  it('assembles a tool_use input from partial_json fragments at content_block_stop (never mid-stream)', async () => {
    // The `input` arrives as partial-JSON fragments that are only valid once joined.
    // If parsed per-fragment, `{"path"` would throw mid-stream; it must not.
    const body = streamOf([
      sse('message_start', { message: { usage: { input_tokens: 12, output_tokens: 1 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'list_dir' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"path"' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: ':"/tmp"}' } }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }),
      sse('message_stop', {})
    ]);
    const { call } = adapterOver([okResponse(body)]);
    const { turn } = await runRound(call, TOOL_REQ);

    expect(turn.toolUses).toHaveLength(1);
    expect(turn.toolUses[0]).toMatchObject({ toolName: 'list_dir', toolCallId: 'toolu_a', toolInput: { path: '/tmp' } });
    // A tool_use stop is NOT end-of-turn — the loop runs the tool + re-calls.
    expect(turn.endOfTurn).toBe(false);
    expect(turn.stopReason).toBe('tool-use');
  });

  it('assembles two concurrent tool_use blocks keyed by index, each parsed at its own stop', async () => {
    const body = streamOf([
      sse('message_start', { message: { usage: { input_tokens: 20, output_tokens: 1 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'list_dir' } }),
      sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_b', name: 'stat' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
      sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"f":' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"/tmp"}' } }),
      sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } }),
      sse('content_block_stop', { index: 1 }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 11 } }),
      sse('message_stop', {})
    ]);
    const { call } = adapterOver([okResponse(body)]);
    const { turn } = await runRound(call, TOOL_REQ);

    expect(turn.toolUses).toHaveLength(2);
    const byId = Object.fromEntries(turn.toolUses.map((t) => [t.toolCallId, t]));
    expect(byId['toolu_a']).toMatchObject({ toolName: 'list_dir', toolInput: { path: '/tmp' } });
    expect(byId['toolu_b']).toMatchObject({ toolName: 'stat', toolInput: { f: 'a.txt' } });
    expect(turn.endOfTurn).toBe(false);
  });

  it('surfaces thinking distinct from text, with thinking-start + thinking-delta events', async () => {
    const body = streamOf([
      sse('message_start', { message: { usage: { input_tokens: 10, output_tokens: 1 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'I should ' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'list files.' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig==' } }),
      sse('content_block_stop', { index: 0 }),
      sse('content_block_start', { index: 1, content_block: { type: 'text' } }),
      sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Found ' } }),
      sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'a.txt.' } }),
      sse('content_block_stop', { index: 1 }),
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
      sse('message_stop', {})
    ]);
    const { call } = adapterOver([okResponse(body)]);
    const { turn, events } = await runRound(call, { messages: [{ role: 'user', content: 'go' }], tools: [] });

    expect(turn.thinking).toBe('I should list files.');
    expect(turn.text).toBe('Found a.txt.');
    expect(events.some((e) => e.kind === 'thinking-start')).toBe(true);
    expect(events.filter((e) => e.kind === 'thinking-delta')).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'text-delta')).toHaveLength(2);
    // A no-tool stop ends the turn.
    expect(turn.endOfTurn).toBe(true);
    expect(turn.stopReason).toBe('end-of-turn');
  });

  it('never parses tool input from partial JSON mid-stream (only the joined result at stop)', async () => {
    const body = streamOf([
      sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'c', name: 't' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"k":' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '42}' } }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }),
      sse('message_stop', {})
    ]);
    const { call } = adapterOver([okResponse(body)]);
    const { turn } = await runRound(call, TOOL_REQ);
    expect(turn.toolUses[0].toolInput).toEqual({ k: 42 });
  });

  it('runs a multi-round tool loop end-to-end (tool_use round then a no-tool stop)', async () => {
    const round1 = streamOf([
      sse('message_start', { message: { usage: { input_tokens: 10, output_tokens: 1 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'c1', name: 'list_dir' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }),
      sse('message_stop', {})
    ]);
    const round2 = streamOf([
      sse('message_start', { message: { usage: { input_tokens: 22, output_tokens: 1 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'text' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Done.' } }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } }),
      sse('message_stop', {})
    ]);
    const { call } = adapterOver([okResponse(round1), okResponse(round2)]);

    const r1 = await runRound(call, TOOL_REQ);
    expect(r1.turn.toolUses).toHaveLength(1);
    expect(r1.turn.endOfTurn).toBe(false);

    // The loop runs the tool and re-calls with the tool result appended.
    const replay: ProviderRequest = {
      messages: [
        { role: 'user', content: 'list the files then read one' },
        { role: 'assistant', content: r1.turn.text ?? '' },
        { role: 'tool', content: 'a.txt', toolCallId: 'c1' }
      ],
      tools: TOOL_REQ.tools
    };
    const r2 = await runRound(call, replay);
    expect(r2.turn.text).toBe('Done.');
    expect(r2.turn.toolUses).toHaveLength(0);
    expect(r2.turn.endOfTurn).toBe(true);
  });

  it('ignores unknown event/block types and never drops the stream (forward-compat)', async () => {
    const body = streamOf([
      sse('message_start', { message: { usage: { input_tokens: 3, output_tokens: 1 } } }),
      sse('ping', {}),
      sse('content_block_start', { index: 0, content_block: { type: 'redacted_thinking' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'some_future_delta', blob: 'x' } }),
      sse('content_block_stop', { index: 0 }),
      sse('content_block_start', { index: 1, content_block: { type: 'text' } }),
      sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'ok' } }),
      sse('content_block_stop', { index: 1 }),
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      sse('message_stop', {})
    ]);
    const { call } = adapterOver([okResponse(body)]);
    const { turn } = await runRound(call, { messages: [{ role: 'user', content: 'go' }], tools: [] });
    expect(turn.text).toBe('ok');
    expect(turn.toolUses).toHaveLength(0);
    expect(turn.endOfTurn).toBe(true);
  });

  it('a completed tool_use block with unparseable input surfaces an error and yields NO tool use (FR-011)', async () => {
    const body = streamOf([
      sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'c', name: 't' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"k": ' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: 'oops' } }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }),
      sse('message_stop', {})
    ]);
    const { call } = adapterOver([okResponse(body)]);
    await expect(call(TOOL_REQ)).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('a stream interrupted mid-tool-call discards the incomplete block and throws a retryable-shaped error', async () => {
    const body = interruptedStreamOf([
      sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'c', name: 't' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"par' } })
      // reader throws on the next read — no content_block_stop, no message_stop.
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
      sse('message_start', { message: { usage: { input_tokens: 1, output_tokens: 1 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'mull' } }),
      sse('content_block_stop', { index: 0 }),
      sse('content_block_start', { index: 1, content_block: { type: 'text' } }),
      sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'done' } }),
      sse('content_block_stop', { index: 1 }),
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      sse('message_stop', {})
    ]);
    const { call, requests } = adapterOver([okResponse(body)]);
    const { turn, events } = await runRound(call, { messages: [{ role: 'user', content: 'go' }], tools: [] });

    const key = 'mm-test-secret-key';
    expect(JSON.stringify(turn)).not.toContain(key);
    expect(JSON.stringify(events)).not.toContain(key);
    // The key is carried only in the request headers at the fetch boundary, never in
    // the request body the adapter assembles.
    expect(JSON.stringify(requests[0].body)).not.toContain(key);
  });
});

describe('T017 {FR-006} — cumulative-monotonic usage (latest message_delta, no double-count) + context tier', () => {
  it('takes the LATEST message_delta.usage as the round total without adding message_start (no double-count)', async () => {
    // message_start seeds input=100 + first output=1; message_delta carries the
    // cumulative output total (40). The round total must be {input:100, output:40},
    // NOT output = 1 + 40 (that would be double-counting message_start's output).
    const body = streamOf([
      sse('message_start', { message: { usage: { input_tokens: 100, output_tokens: 1 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'text' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } }),
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } }),
      sse('message_stop', {})
    ]);
    const { call } = adapterOver([okResponse(body)]);
    const { turn } = await runRound(call, { messages: [{ role: 'user', content: 'hi' }], tools: [] });

    // input preserved from message_start; output = latest delta (40), not 1+40 or 25+40.
    expect(turn.usage).toEqual({ input: 100, output: 40, cacheRead: 0, cacheCreation: 0 });
  });

  it('keeps the latest-delta output mapping and passes usd through; cache fields are 0 for NO_CAPS minimax-m3 (FR-010)', async () => {
    const body = streamOf([
      sse('message_start', { message: { usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 30 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'text' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'k' } }),
      sse('content_block_stop', { index: 0 }),
      // The delta omits cache fields — the mapping holds them at the seeded value
      // (never reset mid-stream); output is the LATEST delta (12), not 1+12.
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12, usd: 0.0031 } }),
      sse('message_stop', {})
    ]);
    const { call } = adapterOver([okResponse(body)]);
    const turn = await call({ messages: [{ role: 'user', content: 'k' }], tools: [] });

    // input preserved from message_start; output = the latest cumulative delta (no
    // double-count). cacheRead/cacheCreation are 0 because `minimax-m3` is NO_CAPS —
    // a provider that lacks prompt caching reports cache usage as 0 (FR-010 / SC-008),
    // applied AFTER the mapping preserved the seeded 30 up to the capability gate.
    expect(turn.usage).toEqual({ input: 50, output: 12, cacheRead: 0, cacheCreation: 0 });
    expect(Object.values(turn.usage).every((v) => v >= 0)).toBe(true);
    expect(turn.usd).toBe(0.0031);
  });

  it('cumulative across rounds forms a non-decreasing series (loop accumulation)', async () => {
    const round = (input: number, output: number): ByteStream =>
      streamOf([
        sse('message_start', { message: { usage: { input_tokens: input, output_tokens: 1 } } }),
        sse('content_block_start', { index: 0, content_block: { type: 'text' } }),
        sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'x' } }),
        sse('content_block_stop', { index: 0 }),
        sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } }),
        sse('message_stop', {})
      ]);
    const { call } = adapterOver([okResponse(round(50, 10)), okResponse(round(70, 25))]);

    const r1 = await runRound(call, { messages: [{ role: 'user', content: 'a' }], tools: [] });
    const r2 = await runRound(call, { messages: [{ role: 'user', content: 'b' }], tools: [] });

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

  it('reports the prompt-size input that selects the context-length tier, derived from the registry threshold (SC-004)', async () => {
    // Derive the boundary from the E002 registry row — NOT a magic number.
    const threshold = contextTierThreshold('minimax-m3');
    expect(threshold).toBe(512_000);
    // The tier boundary must also be visible on the registry row itself.
    const tieredRow = lookupModel('minimax-m3')!.priceRows.find((r) => r.contextTierThreshold != null);
    expect(tieredRow?.contextTierThreshold).toBe(threshold!);

    const below = (threshold as number) - 1; // just below ⇒ base tier
    const above = (threshold as number) + 1; // just above ⇒ long tier

    const roundWithInput = (input: number): ByteStream =>
      streamOf([
        sse('message_start', { message: { usage: { input_tokens: input, output_tokens: 1 } } }),
        sse('content_block_start', { index: 0, content_block: { type: 'text' } }),
        sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }),
        sse('content_block_stop', { index: 0 }),
        sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
        sse('message_stop', {})
      ]);
    const { call } = adapterOver([okResponse(roundWithInput(below)), okResponse(roundWithInput(above))]);

    const rBelow = await runRound(call, { messages: [{ role: 'user', content: 'small' }], tools: [] });
    const rAbove = await runRound(call, { messages: [{ role: 'user', content: 'huge' }], tools: [] });

    // The adapter reports the prompt-size input verbatim — it is what selects the tier.
    expect(rBelow.turn.usage.input).toBe(below);
    expect(rAbove.turn.usage.input).toBe(above);

    // The reported prompt size selects the correct tier on either side of the boundary.
    expect(selectContextTier(rBelow.turn.usage.input, 'minimax-m3')).toBe('base');
    expect(selectContextTier(rAbove.turn.usage.input, 'minimax-m3')).toBe('long');
    // Exactly at the threshold stays in the base tier (boundary is strict `>`).
    expect(selectContextTier(threshold as number, 'minimax-m3')).toBe('base');
  });

  it('a flat-priced model (DeepSeek) has only a base tier (null threshold)', () => {
    expect(contextTierThreshold('deepseek-v4-flash')).toBeNull();
    expect(selectContextTier(10_000_000, 'deepseek-v4-flash')).toBe('base');
  });
});
