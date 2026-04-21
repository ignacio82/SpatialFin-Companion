const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSearxngUrl,
  shapeSearchResults,
  validateQuery,
  performSearch,
  MAX_RESULTS,
} = require('../web-search');

test('buildSearxngUrl forces format=json and preserves path when provided', () => {
  const url = buildSearxngUrl({ query: 'arrival movie', searxngUrl: 'http://127.0.0.1:8898/search' });
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/search');
  assert.equal(parsed.searchParams.get('format'), 'json');
  assert.equal(parsed.searchParams.get('q'), 'arrival movie');
});

test('buildSearxngUrl appends /search when base URL omits a path', () => {
  const url = buildSearxngUrl({ query: 'hello', searxngUrl: 'http://searxng.internal' });
  assert.ok(url.endsWith('/search?q=hello&format=json&safesearch=0'), url);
});

test('validateQuery rejects empty strings', () => {
  assert.equal(validateQuery('   ').ok, false);
  assert.equal(validateQuery('').ok, false);
  assert.equal(validateQuery(42).ok, false);
});

test('validateQuery rejects absurdly long inputs', () => {
  const long = 'a'.repeat(300);
  const r = validateQuery(long);
  assert.equal(r.ok, false);
  assert.match(r.reason, /too long/i);
});

test('shapeSearchResults keeps title/url/snippet and drops the rest', () => {
  const raw = {
    results: [
      {
        title: 'Arrival (2016)',
        url: 'https://en.wikipedia.org/wiki/Arrival_(film)',
        content: 'Arrival is a 2016 American science fiction drama film...',
        engine: 'wikipedia',
        thumbnail: 'https://example.com/thumb.jpg',
      },
      {
        title: 'Some fan blog',
        url: 'http://example.com/fan',
        content: '   lots   of   whitespace   content   ',
      },
    ],
    query: 'arrival',
    answers: ['ignored'],
  };
  const shaped = shapeSearchResults(raw);
  assert.equal(shaped.results.length, 2);
  assert.deepEqual(Object.keys(shaped.results[0]).sort(), ['snippet', 'title', 'url']);
  // Whitespace is collapsed so the research notes stay compact.
  assert.equal(shaped.results[1].snippet, 'lots of whitespace content');
});

test('shapeSearchResults caps results at MAX_RESULTS', () => {
  const results = Array.from({ length: MAX_RESULTS + 5 }, (_, i) => ({
    title: `r${i}`,
    url: `http://x/${i}`,
    content: `c${i}`,
  }));
  const shaped = shapeSearchResults({ results });
  assert.equal(shaped.results.length, MAX_RESULTS);
});

test('shapeSearchResults drops entries missing title or url', () => {
  const shaped = shapeSearchResults({
    results: [
      { title: '', url: 'http://x' },
      { title: 'ok', url: '' },
      { title: 'kept', url: 'http://y', content: 'snip' },
      null,
      'garbage',
    ],
  });
  assert.equal(shaped.results.length, 1);
  assert.equal(shaped.results[0].title, 'kept');
});

test('shapeSearchResults handles empty or malformed payloads', () => {
  assert.deepEqual(shapeSearchResults(null), { results: [] });
  assert.deepEqual(shapeSearchResults({}), { results: [] });
  assert.deepEqual(shapeSearchResults({ results: 'oops' }), { results: [] });
});

test('performSearch returns shaped results on 200 from SearXNG', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /format=json/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { title: 'Hit', url: 'http://hit', content: 'context' },
        ],
      }),
    };
  };
  const payload = await performSearch({
    query: 'test',
    searxngUrl: 'http://127.0.0.1:8898/search',
    fetchImpl,
  });
  assert.equal(payload.results[0].title, 'Hit');
});

test('performSearch surfaces a 502 when SearXNG returns a non-2xx', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  });
  await assert.rejects(
    performSearch({ query: 'x', searxngUrl: 'http://127.0.0.1:8898/search', fetchImpl }),
    (err) => err.status === 502 && /500/.test(err.message),
  );
});

test('performSearch surfaces a 504 on fetch timeout', async () => {
  const fetchImpl = async (_url, init) => {
    await new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
    throw new Error('unreached');
  };
  await assert.rejects(
    performSearch({
      query: 'x',
      searxngUrl: 'http://127.0.0.1:8898/search',
      fetchImpl,
      timeoutMs: 10,
    }),
    (err) => err.status === 504 && /timed out/i.test(err.message),
  );
});

test('performSearch 400s on empty query before calling fetch', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  await assert.rejects(
    performSearch({ query: '   ', searxngUrl: 'http://127.0.0.1:8898/search', fetchImpl }),
    (err) => err.status === 400,
  );
  assert.equal(called, false, 'fetch should not be invoked for invalid query');
});
