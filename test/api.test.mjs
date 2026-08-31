// Tests for src/api.js — heyarr's native `/api/v1` wire contract (search +
// follow), the seam beside the Subsonic `/rest` browse client.
//
// These pin the exact shapes heyarr-core's internal/api/resources serves and
// expects: Bearer-header auth (the SAME QR session token, NOT the `p=` query
// password `/rest` uses), the JSON request bodies, the `{ works }` and
// `{ followed_sources }` response keys, 201/204 statuses, and the crucial
// SCOPE finding — a read-scoped TV session gets a 403 (not a 401) on the write
// routes (follow / unfollow), which the client surfaces as a readable error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiUrl, problemMessage, ApiError, makeApiClient, API_PREFIX,
} from '../src/api.js';

const BASE = 'https://heyarr.example';
const TOKEN = 'sess-abc123';

// A stub fetch that records the last request and returns a scripted response.
// `script(req)` returns { status, body } (body an object → JSON, or a string).
function stubFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const req = { url, method: (init.method || 'GET'), headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(req);
    const { status = 200, body } = script(req) || {};
    const text = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    };
  };
  return { fetchImpl, calls };
}

// --- url + message helpers --------------------------------------------------

test('apiUrl mounts a path under /api/v1 and trims a trailing base slash', () => {
  assert.equal(apiUrl(BASE, '/search'), 'https://heyarr.example/api/v1/search');
  assert.equal(apiUrl(BASE + '/', 'search'), 'https://heyarr.example/api/v1/search');
  assert.equal(API_PREFIX, '/api/v1');
});

test('problemMessage prefers problem+json detail, then title, then a status line', () => {
  assert.equal(problemMessage({ detail: 'this token does not carry the write scope', title: 'Forbidden' }, 403),
    'this token does not carry the write scope');
  assert.equal(problemMessage({ title: 'Not Found' }, 404), 'Not Found');
  assert.equal(problemMessage(null, 500), 'HTTP 500');
});

// --- auth wiring ------------------------------------------------------------

test('every call carries the QR session token as an Authorization: Bearer header (not a p= query param)', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: { works: [] } }));
  const client = makeApiClient({ baseUrl: BASE, token: TOKEN, fetchImpl });
  await client.search({ query: 'x' });
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(new URL(calls[0].url).searchParams.get('p'), null); // never the Subsonic scheme
});

// --- search (read floor — WORKS from the TV) --------------------------------

test('search POSTs the source-agnostic body and returns the works array', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: { works: [
    { work_id: 'w1', content_type: 'series', title: 'The Conversation', year: 1974 },
    { work_id: 'w2', content_type: 'series', title: 'Conversations' },
  ] } }));
  const client = makeApiClient({ baseUrl: BASE, token: TOKEN, fetchImpl });
  const works = await client.search({ query: 'conversation', contentType: 'series', limit: 10 });

  assert.equal(calls[0].method, 'POST');
  assert.equal(new URL(calls[0].url).pathname, '/api/v1/search');
  assert.deepEqual(calls[0].body, { query: 'conversation', content_type: 'series', limit: 10 });
  assert.equal(works.length, 2);
  assert.equal(works[0].title, 'The Conversation');
  assert.equal(works[1].year, undefined); // year is optional in a WorkSummary
});

test('search omits an empty query and defaults works to [] when the body has none', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: {} }));
  const client = makeApiClient({ baseUrl: BASE, token: TOKEN, fetchImpl });
  const works = await client.search({ query: '   ', contentType: 'series' });
  assert.deepEqual(calls[0].body, { content_type: 'series' }); // blank query dropped
  assert.deepEqual(works, []);
});

test('search surfaces a 400 "give a query or a content_type" as a readable ApiError', async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 400, body: {
    type: 'about:blank', title: 'Bad Request', status: 400,
    detail: 'give a query or a content_type to search on',
  } }));
  const client = makeApiClient({ baseUrl: BASE, token: TOKEN, fetchImpl });
  await assert.rejects(() => client.search({}), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 400);
    assert.match(err.message, /give a query or a content_type/);
    return true;
  });
});

// --- follow (WRITE scope — 403 from a read-scoped TV session) ---------------

test('follow POSTs the follow intent and returns the created FollowedSource (201)', async () => {
  const created = { id: 'fs1', work_id: 'w1', type: 'tv_series', feed_ref: '12345', monitor: true };
  const { fetchImpl, calls } = stubFetch(() => ({ status: 201, body: created }));
  const client = makeApiClient({ baseUrl: BASE, token: TOKEN, fetchImpl });
  const fs = await client.follow({ tvdbId: '12345', title: 'Some Series', backfill: 'from_now' });

  assert.equal(calls[0].method, 'POST');
  assert.equal(new URL(calls[0].url).pathname, '/api/v1/followed-sources');
  assert.deepEqual(calls[0].body, { tvdb_id: '12345', title: 'Some Series', backfill: 'from_now' });
  assert.equal(fs.id, 'fs1');
});

test('follow surfaces the read-scope 403 as an ApiError carrying status 403 (the load-bearing finding)', async () => {
  // heyarr-core RequireScope(write) rejects a read-scoped web-login session here.
  const { fetchImpl } = stubFetch(() => ({ status: 403, body: {
    type: 'about:blank', title: 'Forbidden', status: 403,
    detail: 'this token does not carry the write scope',
  } }));
  const client = makeApiClient({ baseUrl: BASE, token: TOKEN, fetchImpl });
  await assert.rejects(() => client.follow({ tvdbId: '1', title: 'X' }), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 403); // NOT 401 — the token is valid, it just lacks write
    assert.match(err.message, /does not carry the write scope/);
    return true;
  });
});

test('follow surfaces the Phase-1 "tv_series only" refusal as a readable 400', async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 400, body: {
    title: 'Bad Request', status: 400,
    detail: 'following this source is not implemented yet — Phase 1 follows tv_series only (give a TVDB series id or URL)',
  } }));
  const client = makeApiClient({ baseUrl: BASE, token: TOKEN, fetchImpl });
  await assert.rejects(() => client.follow({ url: 'https://example.com/feed', title: 'X' }),
    /Phase 1 follows tv_series only/);
});

// --- followed list (read floor — WORKS) -------------------------------------

test('listFollowed returns the followed_sources array', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: { followed_sources: [
    { id: 'fs1', work_id: 'w1', type: 'tv_series', feed_ref: '12345', items_known: 3, items_archived: 2, health: 'healthy' },
  ] } }));
  const client = makeApiClient({ baseUrl: BASE, token: TOKEN, fetchImpl });
  const list = await client.listFollowed();
  assert.equal(calls[0].method, 'GET');
  assert.equal(new URL(calls[0].url).pathname, '/api/v1/followed-sources');
  assert.equal(list.length, 1);
  assert.equal(list[0].items_archived, 2);
});

test('listFollowed defaults to [] when the body omits the key', async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 200, body: {} }));
  const client = makeApiClient({ baseUrl: BASE, token: TOKEN, fetchImpl });
  assert.deepEqual(await client.listFollowed(), []);
});

// --- unfollow (WRITE scope — 204 on success, 403 from a TV) -----------------

test('unfollow DELETEs the id with keep_archive=true and resolves on 204', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 204 }));
  const client = makeApiClient({ baseUrl: BASE, token: TOKEN, fetchImpl });
  const out = await client.unfollow('fs 1');
  assert.equal(calls[0].method, 'DELETE');
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, '/api/v1/followed-sources/fs%201'); // id is URL-encoded
  assert.equal(u.searchParams.get('keep_archive'), 'true');
  assert.equal(out, null);
});

test('unfollow surfaces a 404 (no such source) as an ApiError with status 404', async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 404, body: {
    title: 'Not Found', status: 404, detail: 'there is no followed source with that id',
  } }));
  const client = makeApiClient({ baseUrl: BASE, token: TOKEN, fetchImpl });
  await assert.rejects(() => client.unfollow('nope'), (err) => {
    assert.equal(err.status, 404);
    assert.match(err.message, /no followed source with that id/);
    return true;
  });
});

test('an HTML error page (not problem+json) still surfaces a readable status-line error', async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 502, body: '<html>bad gateway</html>' }));
  const client = makeApiClient({ baseUrl: BASE, token: TOKEN, fetchImpl });
  await assert.rejects(() => client.listFollowed(), /HTTP 502/);
});

test('a missing token yields no Authorization header (loopback dev with auth disabled)', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: { works: [] } }));
  const client = makeApiClient({ baseUrl: BASE, token: '', fetchImpl });
  await client.search({ query: 'x' });
  assert.equal(calls[0].headers.Authorization, undefined);
});
