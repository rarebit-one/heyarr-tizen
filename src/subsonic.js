// The heyarr OpenSubsonic (/rest) client — the browse + stream contract.
//
// This is the pure, tested core of the TV shell. It knows exactly one thing:
// how to speak heyarr's `/rest/{method}` compatibility surface (heyarr-core
// internal/api/subsonic, §70). Everything DOM lives in app.js; everything wire
// lives here, so the contract can be unit-tested without a browser.
//
// AUTH (heyarr-core subsonic/handler.go authenticate): a Subsonic client sends
// its credential on the QUERY STRING, not a header — the /rest group is
// unauthenticated at the HTTP layer and does its own auth. heyarr's rule:
//   - `p=<password>` where the password IS a heyarr bearer token (the session
//     token the Voidbind login minted). Optionally hex as `p=enc:<hex>`.
//   - salted-token auth (t=/s=) is DELIBERATELY refused — heyarr keeps tokens
//     argon2id-hashed and never holds the plaintext, so it cannot recompute the
//     md5. We therefore always send `p=`.
//   - `u=` (username) is echoed but not verified; we pass the login's `user`.
//
// ENVELOPE (heyarr-core subsonic/response.go): JSON replies are wrapped as
//   { "subsonic-response": { status, version, type, serverVersion,
//                            openSubsonic, <one payload key>, error? } }
// status is "ok" or "failed"; a failure carries { error: { code, message } }
// and HTTP is ALWAYS 200 (the protocol carries its own status inside).

import { SUBSONIC_CLIENT, SUBSONIC_API_VERSION } from './config.js';

// Trim a trailing slash so joining is unambiguous.
function trimBase(baseUrl) {
  return String(baseUrl == null ? '' : baseUrl).replace(/\/+$/, '');
}

// Build the common Subsonic auth/format query params. `token` is the heyarr
// session token minted by the Voidbind login; it rides as the Subsonic
// password. `user` is echoed as `u` (not verified server-side, but a
// well-formed request carries it).
export function authParams({ user, token }) {
  const q = new URLSearchParams();
  q.set('u', user || 'heyarr');
  q.set('p', token || '');
  q.set('c', SUBSONIC_CLIENT);
  q.set('v', SUBSONIC_API_VERSION);
  q.set('f', 'json');
  return q;
}

// Compose a full /rest URL for `method` with the auth params plus any extras.
// `extra` is a plain object of method params (e.g. { id }, { type, size }).
export function restUrl(baseUrl, method, creds, extra = {}) {
  const q = authParams(creds);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  return trimBase(baseUrl) + '/rest/' + encodeURIComponent(method) + '?' + q.toString();
}

// The range-capable stream URL for a song id — what an <audio>/<video> `src`
// points at. Byte-serving (Range, 206, M10 progressive partial) is inherited
// from the blob handler (ADR-0013), so the element just plays it.
export function streamUrl(baseUrl, id, creds) {
  return restUrl(baseUrl, 'stream', creds, { id });
}

// Unwrap the `subsonic-response` envelope, throwing a readable Error on a
// `status: "failed"` reply (which still arrives as HTTP 200). Returns the inner
// response object so callers read `.albumList2`, `.album`, `.artists`, etc.
export function unwrap(json) {
  const r = json && json['subsonic-response'];
  if (!r) throw new Error('not a subsonic-response envelope');
  if (r.status === 'failed') {
    const e = r.error || {};
    throw new Error('subsonic error ' + (e.code ?? '?') + ': ' + (e.message || 'unknown'));
  }
  return r;
}

// A tiny client bound to a base URL + credentials + a fetch implementation.
// `fetchImpl` defaults to the ambient global fetch (Tizen webview / Node 18+),
// injectable for tests. This is the only object app.js needs.
export function makeClient({ baseUrl, creds, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;

  async function call(method, extra) {
    const res = await doFetch(restUrl(baseUrl, method, creds, extra));
    if (!res.ok) throw new Error('subsonic HTTP ' + res.status + ' for ' + method);
    return unwrap(await res.json());
  }

  return {
    // Liveness / credential check. Throws if the token is not accepted.
    ping: () => call('ping'),

    // The top-level browse index: artists grouped into letter buckets.
    // Flattened to a single artist array for a simple TV list.
    async getArtists() {
      const r = await call('getArtists');
      const index = (r.artists && r.artists.index) || [];
      return index.flatMap((bucket) => bucket.artist || []);
    },

    // One artist with its albums inlined.
    async getArtist(id) {
      const r = await call('getArtist', { id });
      return r.artist || { id, name: '', album: [] };
    },

    // A flat album list. `type` defaults to alphabeticalByName (heyarr's
    // default when the param is empty); `size`/`offset` page it.
    async getAlbumList({ type = 'alphabeticalByName', size = 100, offset = 0 } = {}) {
      const r = await call('getAlbumList2', { type, size, offset });
      return (r.albumList2 && r.albumList2.album) || [];
    },

    // One album with its songs inlined — each song is streamable via streamUrl.
    async getAlbum(id) {
      const r = await call('getAlbum', { id });
      return r.album || { id, name: '', song: [] };
    },

    // The stream URL for a song id (for an <audio>/<video> element).
    streamUrl: (id) => streamUrl(baseUrl, id, creds),
  };
}
