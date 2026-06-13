/**
 * Host-side web search for native desks (the `web_search` toolkit dep).
 *
 * The package's `executeAgentTool` is host-agnostic and never touches the network —
 * it calls the injected `searchWeb(query, opts)`. This module is that injection: it
 * owns the PROVIDER, the request, and the formatting. Keeping it here (not in
 * `@jsh562/agent-core`) preserves the package boundary.
 *
 * Provider = **DuckDuckGo's HTML endpoint** — completely FREE and KEYLESS. The cost of
 * keyless is that it's unofficial: it can rate-limit, occasionally return nothing, and
 * could break if DuckDuckGo changes its markup. (Keyed providers like Brave/Tavily are
 * a drop-in swap behind this same function if reliability ever matters more.)
 *
 * It returns COMPACT text — the model reads the result back into its context, so we
 * cap result count and snippet length to keep that token cost bounded.
 *
 * Failure modes throw a clear message (disabled / network error / empty); the executor
 * turns a throw into a `success:false` tool-result the loop can recover from.
 */
import type { HarnessConfig } from './config';

// DuckDuckGo's no-JS HTML results endpoint. Keyless. A browser-like UA avoids the
// "please enable JS" / challenge page DDG serves to obvious bots.
const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;
const SNIPPET_CHARS = 500; // per-result snippet cap (token-conscious)
const REQUEST_TIMEOUT_MS = 15_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Clamp the model-requested result count into a sane, token-bounded range. */
function clampResults(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_RESULTS;
  return Math.min(Math.max(v, 1), MAX_RESULTS);
}

/** Decode HTML entities + strip tags from a snippet/title fragment. */
function decodeText(s: string): string {
  return s
    .replace(/<\/?[^>]+>/g, '') // strip tags (DDG bolds matched terms with <b>)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolve a DDG result href to the real target URL. DDG wraps results in a redirect
 *  (`//duckduckgo.com/l/?uddg=<encoded-real-url>&rut=...`); unwrap the `uddg` param. */
function resolveUrl(href: string): string {
  let h = decodeText(href);
  if (h.startsWith('//')) h = `https:${h}`;
  try {
    const u = new URL(h);
    const uddg = u.searchParams.get('uddg');
    if (uddg) return uddg; // already decoded by URLSearchParams
  } catch {
    /* not a parseable URL — fall through */
  }
  return h;
}

/** Parse DDG's HTML results page into structured rows (regex, no DOM in Node). The
 *  no-JS page lists each result as an `<a class="result__a" href=...>title</a>` and a
 *  matching `<a class="result__snippet">snippet</a>`. Brittle by nature — best-effort. */
function parse(html: string, limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(decodeText(sm[1]));
  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) !== null && out.length < limit) {
    const url = resolveUrl(lm[1]);
    const title = decodeText(lm[2]) || '(untitled)';
    if (!url || url.startsWith('https://duckduckgo.com/')) {
      i++;
      continue; // skip DDG's own ad/related links
    }
    out.push({ title, url, snippet: (snippets[i] ?? '').slice(0, SNIPPET_CHARS) });
    i++;
  }
  return out;
}

/** Format rows into compact, numbered text the model reads back. */
function format(rows: SearchResult[]): string {
  if (rows.length === 0) return '(no results)';
  const lines: string[] = [];
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}${r.url ? ` — ${r.url}` : ''}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  });
  return lines.join('\n');
}

/**
 * Run a free, keyless web search via DuckDuckGo's HTML endpoint and return compact
 * text. Throws (with a clear message) when web search is disabled or the request
 * fails. `cfg` is passed in so the caller reads config once per call (live gate).
 */
export async function searchWebDuckDuckGo(
  query: string,
  opts: { maxResults?: number } | undefined,
  cfg: HarnessConfig
): Promise<string> {
  if (cfg.webSearchEnabled !== true) {
    throw new Error('web search is disabled — enable it in Settings → web search');
  }
  const limit = clampResults(opts?.maxResults);
  const url = `${DDG_ENDPOINT}?q=${encodeURIComponent(query)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: controller.signal
    });
  } catch (e) {
    const msg = e instanceof Error && e.name === 'AbortError' ? 'search timed out' : 'search request failed';
    throw new Error(msg, { cause: e });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const hint = resp.status === 429 ? ' (DuckDuckGo is rate-limiting — try again shortly)' : '';
    throw new Error(`search provider returned HTTP ${resp.status}${hint}`);
  }
  const html = await resp.text();
  return format(parse(html, limit));
}
