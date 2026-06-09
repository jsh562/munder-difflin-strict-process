/**
 * Shared SSE (Server-Sent Events) line/event parser (E006 / AD-003, HINT-001).
 *
 * Both native adapters stream provider responses as `text/event-stream`. This
 * module turns a fetch `Response` body (a `ReadableStream<Uint8Array>`) into a
 * sequence of parsed SSE events, handling the wire details once:
 *  - CRLF/LF line endings and the blank-line event delimiter,
 *  - multi-line `data:` fields concatenated per the SSE spec,
 *  - the OpenAI/DeepSeek `data: [DONE]` sentinel,
 *  - `event:` field capture (Anthropic/Minimax name their events),
 *  - tolerant `data:` JSON parsing (a non-JSON `data` is surfaced as `raw`).
 *
 * It is electron-free and takes its stream as input (no global `fetch` side
 * effects), so vitest exercises it in Node over recorded fixtures (HINT-001).
 * No provider SDK/wire type crosses this boundary — the output is a plain shape.
 */

/** A single parsed SSE event. */
export interface SseEvent {
  /** The `event:` field value, when the stream named the event (e.g. Anthropic). */
  event?: string;
  /** Parsed JSON from the `data:` field(s), when the payload was valid JSON. */
  data?: unknown;
  /** The raw (joined) `data:` text when it was the `[DONE]` sentinel or non-JSON. */
  raw?: string;
  /** True for the terminal `data: [DONE]` sentinel (OpenAI/DeepSeek). */
  done: boolean;
}

/** Minimal shape of a fetch Response body's reader — keeps node/electron out. */
export interface ByteStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock?(): void;
}

/** Minimal shape of the readable body we accept (a fetch `Response.body`). */
export interface ByteStream {
  getReader(): ByteStreamReader;
}

const DONE_SENTINEL = '[DONE]';

/** Decode a Uint8Array chunk to a string. Injectable decoder keeps this Node-pure. */
function makeDecoder(): (chunk: Uint8Array, stream: boolean) => string {
  // TextDecoder is a Web/Node global available in both the worker and vitest.
  const decoder = new TextDecoder('utf-8');
  return (chunk: Uint8Array, stream: boolean) => decoder.decode(chunk, { stream });
}

/**
 * Parse one accumulated SSE event block (the text between blank-line delimiters)
 * into an `SseEvent`, or `null` when the block carries no `data` (e.g. a bare
 * comment/heartbeat line). Per the SSE spec, multiple `data:` lines are joined
 * with `\n`; a leading single space after the colon is stripped.
 */
function parseEventBlock(block: string): SseEvent | null {
  let eventName: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '' || line.startsWith(':')) continue; // blank or comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    // `id:` / `retry:` and unknown fields are ignored (not needed by adapters).
  }

  if (dataLines.length === 0) {
    // An event with a name but no data (rare) is still meaningful to adapters.
    return eventName ? { event: eventName, done: false } : null;
  }

  const dataText = dataLines.join('\n');
  if (dataText.trim() === DONE_SENTINEL) {
    return { event: eventName, raw: dataText, done: true };
  }

  try {
    return { event: eventName, data: JSON.parse(dataText), done: false };
  } catch {
    // Tolerate a non-JSON data payload rather than throwing mid-stream — the
    // adapter decides what to do with `raw` (parse-on-complete safety, FR-011).
    return { event: eventName, raw: dataText, done: false };
  }
}

/**
 * Async-iterate the parsed SSE events of a byte stream. Buffers across chunk
 * boundaries and flushes a trailing event with no terminating blank line. Stops
 * after yielding a `[DONE]` sentinel. Never throws on a malformed data line —
 * it yields it as `raw` so the caller stays in control (FR-011 parse-on-complete).
 *
 * @param stream  the fetch `Response.body` (or any `ByteStream`); injected so tests run in Node.
 * @param decode  optional decoder injection point (defaults to a UTF-8 TextDecoder).
 */
export async function* parseSseStream(
  stream: ByteStream,
  decode: (chunk: Uint8Array, stream: boolean) => string = makeDecoder()
): AsyncGenerator<SseEvent, void, unknown> {
  const reader = stream.getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value && value.byteLength > 0) {
        buffer += decode(value, true);
        // Events are delimited by a blank line; \n\n or \r\n\r\n. Normalize on \n.
        let sep = buffer.indexOf('\n\n');
        while (sep !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const ev = parseEventBlock(block);
          if (ev) {
            yield ev;
            if (ev.done) return;
          }
          sep = buffer.indexOf('\n\n');
        }
      }
      if (done) break;
    }
    // Flush any trailing event that lacked a final blank-line delimiter.
    const tail = buffer.replace(/\r\n/g, '\n').trim();
    if (tail !== '') {
      const ev = parseEventBlock(tail);
      if (ev) yield ev;
    }
  } finally {
    reader.releaseLock?.();
  }
}

/** Re-export the sentinel for adapters that want to special-case it explicitly. */
export const SSE_DONE = DONE_SENTINEL;
