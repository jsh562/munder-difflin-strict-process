/** E006 T001 — shared SSE parser: multi-line data, [DONE], chunk-split, event
 *  names, tolerant non-JSON. Electron-free, stream injected (HINT-001). */
import { describe, it, expect } from 'vitest';
import { parseSseStream, type ByteStream, SSE_DONE } from '../worker/adapters/sseParser';

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

async function collect(stream: ByteStream) {
  const out = [] as Awaited<ReturnType<typeof parseSseStream>> extends AsyncGenerator<infer E> ? E[] : never;
  for await (const ev of parseSseStream(stream)) out.push(ev);
  return out;
}

describe('T001 — parseSseStream', () => {
  it('parses data: JSON events delimited by blank lines', async () => {
    const events = await collect(streamOf(['data: {"a":1}\n\n', 'data: {"a":2}\n\n']));
    expect(events.map((e) => e.data)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(events.every((e) => !e.done)).toBe(true);
  });

  it('stops at the [DONE] sentinel and marks it done', async () => {
    const events = await collect(streamOf(['data: {"x":1}\n\n', `data: ${SSE_DONE}\n\n`, 'data: {"never":1}\n\n']));
    expect(events).toHaveLength(2);
    expect(events[1].done).toBe(true);
    expect(events[1].raw).toBe(SSE_DONE);
  });

  it('joins multi-line data fields with newlines and parses the result', async () => {
    const events = await collect(streamOf(['data: {"a":\ndata: 1}\n\n']));
    expect(events[0].data).toEqual({ a: 1 });
  });

  it('reassembles an event split across chunk boundaries', async () => {
    const events = await collect(streamOf(['data: {"hel', 'lo":"wor', 'ld"}\n\n']));
    expect(events[0].data).toEqual({ hello: 'world' });
  });

  it('captures the event: field (Anthropic-style named events)', async () => {
    const events = await collect(streamOf(['event: message_start\ndata: {"type":"message_start"}\n\n']));
    expect(events[0].event).toBe('message_start');
    expect(events[0].data).toEqual({ type: 'message_start' });
  });

  it('handles CRLF line endings', async () => {
    const events = await collect(streamOf(['data: {"crlf":true}\r\n\r\n']));
    expect(events[0].data).toEqual({ crlf: true });
  });

  it('surfaces a non-JSON data payload as raw rather than throwing', async () => {
    const events = await collect(streamOf(['data: not-json\n\n']));
    expect(events[0].data).toBeUndefined();
    expect(events[0].raw).toBe('not-json');
  });

  it('flushes a trailing event that lacks a final blank line', async () => {
    const events = await collect(streamOf(['data: {"tail":1}']));
    expect(events[0].data).toEqual({ tail: 1 });
  });

  it('ignores comment (heartbeat) lines', async () => {
    const events = await collect(streamOf([': keep-alive\n\n', 'data: {"ok":1}\n\n']));
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ ok: 1 });
  });
});
