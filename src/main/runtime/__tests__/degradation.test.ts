/** E006 T028 {FR-010,FR-014} [COMPLETES FR-010] — runtime graceful degradation
 *  applied INSIDE each adapter (US4 / SC-008). Drives each adapter with an injected
 *  `fetch` returning a minimal valid SSE stream and a request that WOULD invoke an
 *  unsupported capability, asserting:
 *    (a) the unsupported field is STRIPPED from the outgoing wire body and the round
 *        still succeeds (the gate never throws — AD-005 / HINT-004),
 *    (b) exactly ONE `notification` per capability across multiple turns in the same
 *        session (no per-turn repeat — the dedupe scope is the adapter instance),
 *    (c) caching-off ⇒ cache usage fields report 0 (not an error),
 *    (d) the notice payload is bounded to the capability label + model id (FR-010 —
 *        never the request content that triggered it).
 *  Covers the NO_CAPS path (minimax-m3, all four gated) and the partially-capable
 *  path (deepseek, caching supported / images+MCP+web-search gated). Electron-free,
 *  `fetch` injected (HINT-001); no live network. */
import { describe, it, expect } from 'vitest';
import { makeDeepseekAdapter, type FetchLike, type FetchResponseLike } from '@jsh562/won-agent-core';
import { makeMinimaxAdapter } from '@jsh562/won-agent-core';
import type { ByteStream } from '@jsh562/won-agent-core';
import type { AgentEvent, NotificationEvent } from '../../../shared/agentEvent';
import type { ProviderCall, ProviderRequest } from '../../../shared/providerCall';

/** A ByteStream yielding the given UTF-8 chunks then done. */
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

/** A minimal valid DeepSeek/OpenAI SSE round: a content delta + stop + terminal usage. */
function deepseekRound(usage: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 4 }): ByteStream {
  return streamOf([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage })}\n\n`,
    'data: [DONE]\n\n'
  ]);
}

/** A minimal valid Minimax/Anthropic SSE round: a text block + end_turn + cumulative usage. */
function minimaxRound(
  startUsage: Record<string, unknown> = { input_tokens: 10, output_tokens: 1 },
  deltaUsage: Record<string, unknown> = { output_tokens: 4 }
): ByteStream {
  const ev = (name: string, obj: Record<string, unknown>): string =>
    `event: ${name}\ndata: ${JSON.stringify({ type: name, ...obj })}\n\n`;
  return streamOf([
    ev('message_start', { message: { usage: startUsage } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: deltaUsage }),
    ev('message_stop', {})
  ]);
}

/** A successful streaming response wrapping a fabricated SSE body. */
function okResponse(body: ByteStream): FetchResponseLike {
  return { ok: true, status: 200, body, headers: { get: () => null }, text: async () => '' };
}

/** Drive an adapter over a fresh body per round, capturing the wire bodies sent. */
function driver(makeBody: () => ByteStream): {
  fetch: FetchLike;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return okResponse(makeBody());
  };
  return { fetch, bodies };
}

/** Run one round, collecting emitted events; never lets the gate's emit be undefined. */
async function runRound(
  call: ProviderCall,
  req: ProviderRequest
): Promise<{ turn: Awaited<ReturnType<ProviderCall>>; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  const turn = await call(req, (e) => events.push(e));
  return { turn, events };
}

const notices = (events: AgentEvent[]): NotificationEvent[] =>
  events.filter((e): e is NotificationEvent => e.kind === 'notification');

// A request that WOULD invoke every gated capability (bounded, opaque payloads). The
// inner shapes must NEVER appear in a notice (FR-010) and must NOT reach an
// unsupported provider's wire body.
const FULL_CAP_REQ: ProviderRequest = {
  messages: [{ role: 'user', content: 'describe this image and search the web' }],
  tools: [],
  images: [{ b64: 'SECRET_IMAGE_BYTES' }],
  mcpTools: [{ server: 'SECRET_MCP_SERVER' }],
  webSearch: { enabled: true, query: 'SECRET_QUERY' },
  caching: { mode: 'ephemeral' }
};

describe('T028 {FR-010} — Minimax (NO_CAPS): all four capabilities degrade gracefully', () => {
  it('strips every unsupported field from the wire body yet the round still succeeds', async () => {
    const { fetch, bodies } = driver(() => minimaxRound());
    const call = makeMinimaxAdapter({ fetch, apiKey: 'mm-secret', endpoint: 'https://api.minimax.io', model: 'minimax-m3' });

    const { turn } = await runRound(call, FULL_CAP_REQ);

    // (a) the round resolved (no throw) and produced a normalized turn.
    expect(turn.text).toBe('ok');
    expect(turn.endOfTurn).toBe(true);
    // Every gated field is absent from the outgoing body — never reaches the provider.
    const wire = JSON.stringify(bodies[0]);
    expect(bodies[0].images).toBeUndefined();
    expect(bodies[0].mcp_tools).toBeUndefined();
    expect(bodies[0].web_search).toBeUndefined();
    expect(wire).not.toContain('SECRET_IMAGE_BYTES');
    expect(wire).not.toContain('SECRET_MCP_SERVER');
    expect(wire).not.toContain('SECRET_QUERY');
  });

  it('emits exactly ONE notice per capability across multiple turns in the same session', async () => {
    const { fetch } = driver(() => minimaxRound());
    const call = makeMinimaxAdapter({ fetch, apiKey: 'mm-secret', endpoint: 'https://api.minimax.io', model: 'minimax-m3' });

    const r1 = await runRound(call, FULL_CAP_REQ);
    const r2 = await runRound(call, FULL_CAP_REQ); // same session (same adapter instance)
    const r3 = await runRound(call, FULL_CAP_REQ);

    // Turn 1 notices all four (images, MCP, web search, caching); turns 2 & 3 add none.
    expect(notices(r1.events)).toHaveLength(4);
    expect(notices(r2.events)).toHaveLength(0);
    expect(notices(r3.events)).toHaveLength(0);

    // Each notice is bounded to the capability label + model id, never the trigger
    // content (FR-010) — no request payload leaks into the operator-visible message.
    for (const n of notices(r1.events)) {
      expect(n.message).toContain('minimax-m3');
      expect(n.message).not.toMatch(/SECRET_IMAGE_BYTES|SECRET_MCP_SERVER|SECRET_QUERY|b64|ephemeral/);
    }
    const labels = notices(r1.events).map((n) => n.message);
    expect(labels.some((m) => m.includes('image input'))).toBe(true);
    expect(labels.some((m) => m.includes('MCP tools'))).toBe(true);
    expect(labels.some((m) => m.includes('web search'))).toBe(true);
    expect(labels.some((m) => m.includes('prompt caching'))).toBe(true);
  });

  it('caching-off ⇒ cache usage fields report 0 (not an error), even when the provider reports cache tokens', async () => {
    // The fabricated stream REPORTS cache tokens; the NO_CAPS gate must zero them.
    const round = () =>
      minimaxRound({ input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 40 }, { output_tokens: 8, cache_read_input_tokens: 40 });
    const { fetch } = driver(round);
    const call = makeMinimaxAdapter({ fetch, apiKey: 'mm-secret', endpoint: 'https://api.minimax.io', model: 'minimax-m3' });

    const { turn } = await runRound(call, FULL_CAP_REQ);
    expect(turn.usage.cacheRead).toBe(0);
    expect(turn.usage.cacheCreation).toBe(0);
    // Token in/out usage is untouched by caching degradation.
    expect(turn.usage.input).toBe(100);
    expect(turn.usage.output).toBe(8);
  });

  it('never throws when a gated capability is requested (degrade, do not error)', async () => {
    const { fetch } = driver(() => minimaxRound());
    const call = makeMinimaxAdapter({ fetch, apiKey: 'mm-secret', endpoint: 'https://api.minimax.io', model: 'minimax-m3' });
    // No emit at all — the gate must still degrade silently-but-safely, never throw.
    await expect(call(FULL_CAP_REQ)).resolves.toBeDefined();
  });
});

describe('T028 {FR-010} — DeepSeek (partially capable): caching supported, images/MCP/web-search gated', () => {
  const makeCall = (fetch: FetchLike): ProviderCall =>
    makeDeepseekAdapter({ fetch, apiKey: 'sk-secret', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' });

  it('strips the unsupported fields but keeps the request succeeding; notices only the gated ones', async () => {
    const { fetch, bodies } = driver(() => deepseekRound());
    const call = makeCall(fetch);

    const { turn, events } = await runRound(call, FULL_CAP_REQ);

    expect(turn.text).toBe('ok'); // (a) succeeds
    // images / MCP / web-search are unsupported ⇒ stripped from the wire body.
    expect(bodies[0].images).toBeUndefined();
    expect(bodies[0].mcp_tools).toBeUndefined();
    expect(bodies[0].web_search).toBeUndefined();
    expect(JSON.stringify(bodies[0])).not.toContain('SECRET_IMAGE_BYTES');

    // Exactly THREE notices: images, MCP, web search. Caching is SUPPORTED ⇒ no notice.
    const msgs = notices(events).map((n) => n.message);
    expect(msgs).toHaveLength(3);
    expect(msgs.some((m) => m.includes('prompt caching'))).toBe(false);
    expect(msgs.some((m) => m.includes('image input'))).toBe(true);
    expect(msgs.some((m) => m.includes('MCP tools'))).toBe(true);
    expect(msgs.some((m) => m.includes('web search'))).toBe(true);
    for (const m of msgs) expect(m).toContain('deepseek-v4-flash');
  });

  it('does NOT repeat the gated notices on a second turn in the same session', async () => {
    const { fetch } = driver(() => deepseekRound());
    const call = makeCall(fetch);

    const r1 = await runRound(call, FULL_CAP_REQ);
    const r2 = await runRound(call, FULL_CAP_REQ);
    expect(notices(r1.events)).toHaveLength(3);
    expect(notices(r2.events)).toHaveLength(0); // deduped across turns within the session
  });

  it('caching SUPPORTED ⇒ provider cache usage is passed through (not zeroed)', async () => {
    const { fetch } = driver(() =>
      deepseekRound({ prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 30 } })
    );
    const call = makeCall(fetch);
    const { turn } = await runRound(call, FULL_CAP_REQ);
    // DeepSeek supports caching, so the reported cache-read survives (FR-006 passthrough).
    expect(turn.usage.cacheRead).toBe(30);
    expect(turn.usage.input).toBe(100);
  });

  it('never throws when a gated capability is requested', async () => {
    const { fetch } = driver(() => deepseekRound());
    await expect(makeCall(fetch)(FULL_CAP_REQ)).resolves.toBeDefined();
  });

  it('a request that needs NO gated capability emits no notice at all', async () => {
    const { fetch } = driver(() => deepseekRound());
    const call = makeCall(fetch);
    const { events } = await runRound(call, { messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(notices(events)).toHaveLength(0);
  });
});
