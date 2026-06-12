/** E006 T023 {FR-008} — selectAdapter maps the injected NATIVE_PROVIDER_ID to the
 *  correct adapter, derives the endpoint from the E002 registry, and returns null on
 *  an unknown/absent id (caller falls back to the stub). Electron-free, fetch injected
 *  (HINT-001); no live network. */
import { describe, it, expect } from 'vitest';
import { selectAdapter, type EnvLike } from '@munder/agent-core';
import {
  NATIVE_PROVIDER_API_KEY_ENV,
  NATIVE_PROVIDER_ID_ENV,
  NATIVE_PROVIDER_MODEL_ENV
} from '@munder/agent-core';
import type { FetchLike, FetchResponseLike } from '@munder/agent-core';
import type { ByteStream } from '@munder/agent-core';
import { lookupModelInfo } from '../../../shared/providerRegistry';

/** A ByteStream yielding the given chunks then done. */
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

/** A capturing fake fetch — records the URL/headers it is called with, returns a
 *  minimal valid SSE response so the adapter resolves a turn. */
function captureFetch(): { fetch: FetchLike; calls: { url: string; headers: Record<string, string>; body: string }[] } {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetch: FetchLike = async (url, init): Promise<FetchResponseLike> => {
    calls.push({ url, headers: init.headers, body: init.body });
    return {
      ok: true,
      status: 200,
      body: streamOf(['data: [DONE]\n\n']),
      headers: { get: () => null },
      text: async () => ''
    };
  };
  return { fetch, calls };
}

const baseEnv = (over: EnvLike): EnvLike => ({
  [NATIVE_PROVIDER_API_KEY_ENV]: 'sk-secret-key',
  ...over
});

describe('T023 {FR-008} — selectAdapter dispatch from the injected provider env', () => {
  it('maps NATIVE_PROVIDER_ID=deepseek to a DeepSeek adapter hitting the registry endpoint', async () => {
    const cap = captureFetch();
    const env = baseEnv({
      [NATIVE_PROVIDER_ID_ENV]: 'deepseek',
      [NATIVE_PROVIDER_MODEL_ENV]: 'deepseek-v4-flash'
    });
    const adapter = selectAdapter(env, { fetch: cap.fetch });
    expect(adapter).not.toBeNull();

    await adapter!({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
    const endpoint = lookupModelInfo('deepseek-v4-flash')!.provider.defaultEndpoint;
    // DeepSeek adapter posts to `${endpoint}/chat/completions`.
    expect(cap.calls[0].url).toBe(`${endpoint.replace(/\/$/, '')}/chat/completions`);
  });

  it('maps NATIVE_PROVIDER_ID=minimax to a Minimax adapter hitting the registry endpoint', async () => {
    const cap = captureFetch();
    const env = baseEnv({
      [NATIVE_PROVIDER_ID_ENV]: 'minimax',
      [NATIVE_PROVIDER_MODEL_ENV]: 'minimax-m3'
    });
    const adapter = selectAdapter(env, { fetch: cap.fetch });
    expect(adapter).not.toBeNull();

    await adapter!({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
    const endpoint = lookupModelInfo('minimax-m3')!.provider.defaultEndpoint;
    // Minimax adapter posts to `${endpoint}/v1/messages`.
    expect(cap.calls[0].url).toBe(`${endpoint.replace(/\/$/, '')}/v1/messages`);
  });

  it('passes the injected key only at the fetch boundary (authorization header)', async () => {
    const cap = captureFetch();
    const env = baseEnv({
      [NATIVE_PROVIDER_ID_ENV]: 'deepseek',
      [NATIVE_PROVIDER_MODEL_ENV]: 'deepseek-v4-flash'
    });
    await selectAdapter(env, { fetch: cap.fetch })!({ messages: [{ role: 'user', content: 'x' }], tools: [] });
    expect(cap.calls[0].headers.authorization).toBe('Bearer sk-secret-key');
    // The key never appears in the request URL or body.
    expect(cap.calls[0].url).not.toContain('sk-secret-key');
    expect(cap.calls[0].body).not.toContain('sk-secret-key');
  });

  it('returns null when NATIVE_PROVIDER_ID is absent (Claude/stub desk)', () => {
    expect(selectAdapter(baseEnv({ [NATIVE_PROVIDER_MODEL_ENV]: 'deepseek-v4-flash' }))).toBeNull();
  });

  it('returns null for an unknown provider id', () => {
    const env = baseEnv({ [NATIVE_PROVIDER_ID_ENV]: 'acme', [NATIVE_PROVIDER_MODEL_ENV]: 'deepseek-v4-flash' });
    expect(selectAdapter(env)).toBeNull();
  });

  it('returns null when no API key is present (never builds a broken adapter)', () => {
    const env: EnvLike = {
      [NATIVE_PROVIDER_ID_ENV]: 'deepseek',
      [NATIVE_PROVIDER_MODEL_ENV]: 'deepseek-v4-flash'
    };
    expect(selectAdapter(env)).toBeNull();
  });

  it('returns null when the assigned model does not resolve (no endpoint)', () => {
    const env = baseEnv({ [NATIVE_PROVIDER_ID_ENV]: 'deepseek', [NATIVE_PROVIDER_MODEL_ENV]: 'no-such-model' });
    expect(selectAdapter(env)).toBeNull();
  });
});
