// Tests for the api.session() read — GET /api/v1/session, the caller's own
// authority (heyarr-core session.go SessionView, ADR-0061). A shared TV reads
// this up front to say "read-only" before a Follow attempt 403s, rather than
// only after. Same Bearer-header contract as the rest of /api/v1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApiClient, ApiError } from '../src/api.js';

const BASE = 'https://heyarr.example';
const TOKEN = 'sess-abc123';

function stubFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const req = { url, method: (init.method || 'GET'), headers: init.headers || {} };
    calls.push(req);
    const { status = 200, body } = script(req) || {};
    const text = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return { fetchImpl, calls };
}

test('session() GETs /api/v1/session with the Bearer header and returns the authority', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({
    status: 200,
    body: {
      kind: 'session', device_key: 'ed25519:tv', scopes: ['read'],
      can_write: false, management_authorized: false,
    },
  }));
  const api = makeApiClient({ baseUrl: BASE, token: TOKEN, fetchImpl });

  const s = await api.session();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, BASE + '/api/v1/session');
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(s.can_write, false, 'a QR/TV session is read-scoped');
  assert.equal(s.device_key, 'ed25519:tv');
});

test('session() reports a writable session so the TV can enable Follow', async () => {
  const { fetchImpl } = stubFetch(() => ({
    status: 200,
    body: { kind: 'session', scopes: ['read', 'write'], can_write: true, management_authorized: true },
  }));
  const api = makeApiClient({ baseUrl: BASE, token: TOKEN, fetchImpl });
  const s = await api.session();
  assert.equal(s.can_write, true);
  assert.equal(s.management_authorized, true);
});

test('session() surfaces a non-2xx as an ApiError (read floor still applies)', async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 500, body: { title: 'boom' } }));
  const api = makeApiClient({ baseUrl: BASE, token: TOKEN, fetchImpl });
  await assert.rejects(() => api.session(), (err) => err instanceof ApiError && err.status === 500);
});
