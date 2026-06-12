/**
 * Host-side web search for native desks (the `web_search` toolkit dep).
 *
 * The package's `executeAgentTool` is host-agnostic and never touches the network —
 * it calls the injected `searchWeb(query, opts)`. This module is that injection: it
 * owns the PROVIDER (Brave Search API), the API key, and the formatting. Keeping it
 * here (not in `@jsh562/agent-core`) preserves the package boundary.
 *
 * Why a search API (and a key) at all: real keyword search queries a web index —
 * the index IS the product, so it bills per query. A keyless "simple request" only
 * FETCHES a known URL, which is a different capability. Brave's free tier (~2k
 * queries/mo) covers personal use.
 *
 * It returns COMPACT text — the model reads the result back into its context, so we
 * cap result count and snippet length to keep that token cost bounded (the whole
 * reason the tool description tells the model to search narrowly).
 *
 * Failure modes throw a clear, self-correcting message (disabled / no key / provider
 * error); the executor turns a throw into a `success:false` tool-result the loop can
 * recover from. No secret is ever included in the returned text or the error.
 */
import type { HarnessConfig } from './config';
import { getKeyFromConfig, WEB_SEARCH_KEY_ID } from './credentials';

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10; // Brave allows up to 20; we cap lower to bound token cost
const SNIPPET_CHARS = 500; // per-result description cap (token-conscious)
const REQUEST_TIMEOUT_MS = 15_000;

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}
interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

/** Clamp the model-requested result count into a sane, token-bounded range. */
function clampResults(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_RESULTS;
  return Math.min(Math.max(v, 1), MAX_RESULTS);
}

/** Strip Brave's <strong> highlight markup that wraps matched terms in snippets. */
function stripTags(s: string): string {
  return s.replace(/<\/?[^>]+>/g, '');
}

/** Format a Brave payload into compact, numbered text the model reads back. */
function format(data: BraveResponse): string {
  const results = Array.isArray(data.web?.results) ? data.web!.results! : [];
  if (results.length === 0) return '(no results)';
  const lines: string[] = [];
  results.forEach((r, i) => {
    const title = stripTags((r.title ?? '').trim()) || '(untitled)';
    const url = (r.url ?? '').trim();
    const snippet = stripTags((r.description ?? '').trim()).slice(0, SNIPPET_CHARS);
    lines.push(`${i + 1}. ${title}${url ? ` — ${url}` : ''}`);
    if (snippet) lines.push(`   ${snippet}`);
  });
  return lines.join('\n');
}

/**
 * Run a web search via the Brave Search API and return compact text. Throws (with a
 * clear, secret-free message) when web search is disabled, no key is set, or the
 * provider errors. `cfg` is passed in so the caller reads config once per call (live
 * gate — the operator's enable/disable + key changes take effect immediately).
 */
export async function searchWebBrave(
  query: string,
  opts: { maxResults?: number } | undefined,
  cfg: HarnessConfig
): Promise<string> {
  if (cfg.webSearchEnabled !== true) {
    throw new Error('web search is disabled — enable it in Settings → web search');
  }
  const key = getKeyFromConfig(cfg, WEB_SEARCH_KEY_ID);
  if (!key) {
    throw new Error('no web-search API key is set — add a Brave Search API key in Settings → web search');
  }
  const count = clampResults(opts?.maxResults);
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': key
      },
      signal: controller.signal
    });
  } catch (e) {
    const msg = e instanceof Error && e.name === 'AbortError' ? 'search timed out' : 'search request failed';
    throw new Error(msg, { cause: e });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    // Don't echo the provider body (could be verbose / contain the echoed key).
    const hint = resp.status === 401 || resp.status === 403 ? ' (check the Brave Search API key)' : '';
    throw new Error(`search provider returned HTTP ${resp.status}${hint}`);
  }
  const data = (await resp.json()) as BraveResponse;
  return format(data);
}
