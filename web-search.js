'use strict';

// Proxies /api/search against a local SearXNG instance (see docker-compose.yaml).
//
// Keeping the URL builder and response shaper here (rather than inline in
// index.js) lets us unit-test both without a running SearXNG or Express app.
//
// The JSON response from SearXNG is verbose and varies between engine backends;
// we keep the subset that the SpatialFin voice AI actually uses as research
// context: title, a short snippet, and the source URL. Everything else
// (favicons, engine names, thumbnails, infoboxes) is discarded.

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESULTS = 8;
const SNIPPET_CHAR_CAP = 320;

/** @param {{ query: string, searxngUrl: string }} opts */
function buildSearxngUrl({ query, searxngUrl }) {
  const base = String(searxngUrl || '').trim();
  if (!base) throw new Error('Missing SEARXNG url');
  const url = new URL(base);
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/search';
  }
  url.searchParams.set('q', String(query || ''));
  url.searchParams.set('format', 'json');
  url.searchParams.set('safesearch', '0');
  return url.toString();
}

/**
 * Trim a SearXNG JSON payload to the compact shape the headset consumes.
 * Accepts the full parsed object or a partial with a `results` array.
 *
 * @param {unknown} payload
 * @returns {{ results: Array<{ title: string, snippet: string, url: string }> }}
 */
function shapeSearchResults(payload) {
  const list = payload && Array.isArray(payload.results) ? payload.results : [];
  const shaped = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!title || !url) continue;
    const rawSnippet =
      (typeof entry.content === 'string' && entry.content) ||
      (typeof entry.pretty_url === 'string' && entry.pretty_url) ||
      '';
    const snippet = String(rawSnippet).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHAR_CAP);
    shaped.push({ title, snippet, url });
    if (shaped.length >= MAX_RESULTS) break;
  }
  return { results: shaped };
}

/** Is the query acceptable? Rejects empty / overly long values early. */
function validateQuery(query) {
  if (typeof query !== 'string') return { ok: false, reason: 'query must be a string' };
  const trimmed = query.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'query is empty' };
  if (trimmed.length > 256) return { ok: false, reason: 'query too long' };
  return { ok: true, query: trimmed };
}

/**
 * @param {{
 *   query: string,
 *   searxngUrl: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} opts
 */
async function performSearch({ query, searxngUrl, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const validation = validateQuery(query);
  if (!validation.ok) {
    const err = new Error(validation.reason);
    err.status = 400;
    throw err;
  }
  const url = buildSearxngUrl({ query: validation.query, searxngUrl });
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const err = new Error(`SearXNG responded ${response.status}`);
      err.status = 502;
      throw err;
    }
    const payload = await response.json();
    return shapeSearchResults(payload);
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('SearXNG request timed out');
      err.status = 504;
      throw err;
    }
    if (e.status) throw e;
    const wrapped = new Error(`SearXNG request failed: ${e.message || e}`);
    wrapped.status = 502;
    throw wrapped;
  } finally {
    clearTimeout(abortTimer);
  }
}

module.exports = {
  buildSearxngUrl,
  shapeSearchResults,
  validateQuery,
  performSearch,
  MAX_RESULTS,
  SNIPPET_CHAR_CAP,
};
