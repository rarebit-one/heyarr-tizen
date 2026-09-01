// The heyarr NATIVE `/api/v1` client — search + follow, source-agnostic.
//
// This is the second wire seam of the TV shell, sitting beside subsonic.js.
// Where subsonic.js speaks the READ-ONLY OpenSubsonic `/rest` compat surface
// (browse + stream), this module speaks heyarr's own JSON API (heyarr-core
// internal/api/resources, §55/M12) for the two things `/rest` deliberately does
// NOT carry: content-intent SEARCH and FOLLOWING a source.
//
// AUTH (heyarr-core internal/api/http/auth.go, ADR-0053): unlike `/rest` (which
// takes the token as the `p=` query password), `/api/v1` takes the SAME session
// token minted by the Voidbind QR login as an `Authorization: Bearer <token>`
// header. heyarr's `authenticate` middleware tries the primary token verifier
// first and then offers an otherwise-unrecognised bearer value to the web-login
// broker; on a hit the TV acts as the pinned user its phone approved for.
//
// ⚠️ SCOPE — the load-bearing finding (heyarr-core session.go `sessionIdentity`):
// a web-login session token is minted READ-SCOPED. The `/api/v1` router applies
// `RequireScope(read)` to everything, so:
//   • POST /api/v1/search           → read floor  → WORKS from the TV.
//   • GET  /api/v1/followed-sources → read floor  → WORKS from the TV.
//   • POST /api/v1/followed-sources → RequireScope(WRITE) → 403 from the TV.
//   • DELETE /api/v1/followed-sources/{id} → RequireScope(WRITE) → 403.
// The token is ACCEPTED as a bearer (no 401 — it is a valid credential); it just
// lacks the write scope, so follow/unfollow return 403 Forbidden BY DESIGN. We
// wire all four to the real routes and surface the 403 honestly rather than
// hiding a button that cannot work — see README "Auth integration finding".
//
// ERRORS: `/api/v1` reports failure as RFC-7807 problem+json
//   { type, title, status, detail?, instance?, request_id? }
// with the real HTTP status (unlike Subsonic's always-200 envelope). We surface
// `detail` (the human sentence heyarr wrote) and fall back to `title`.

import { API_CLIENT } from './config.js';

// Trim a trailing slash so path joining is unambiguous (mirrors subsonic.js).
function trimBase(baseUrl) {
  return String(baseUrl == null ? '' : baseUrl).replace(/\/+$/, '');
}

// The API prefix heyarr mounts its JSON surface at (heyarr-core routes.go
// `APIPrefix`, spec §77). One constant so every path is built from it.
export const API_PREFIX = '/api/v1';

// Build a full `/api/v1/...` URL from the base and a sub-path.
export function apiUrl(baseUrl, path) {
  const p = String(path).charAt(0) === '/' ? String(path) : '/' + String(path);
  return trimBase(baseUrl) + API_PREFIX + p;
}

// Pull the most human message out of an error body. `/api/v1` uses problem+json
// (detail is the sentence heyarr wrote for a person; title is the short label);
// anything else falls back to a status line so a caller always gets something
// readable rather than "[object Object]".
export function problemMessage(body, status) {
  if (body && typeof body === 'object') {
    if (body.detail) return String(body.detail);
    if (body.title) return String(body.title);
  }
  return 'HTTP ' + status;
}

// A distinguishable error for an HTTP failure, carrying the status so the UI can
// treat a 403 (scope) differently from a 404 (gone) or a 400 (bad input).
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

// A tiny `/api/v1` client bound to a base URL + the QR session token + a fetch.
// `fetchImpl` defaults to the ambient global fetch (Tizen webview / Node 18+),
// injectable for tests. Self-contained (no vendored import) so it unit-tests in
// plain Node exactly like subsonic.js; app.js passes the real fetch.
export function makeApiClient({ baseUrl, token, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;

  // Every call carries the session token as a Bearer header and asks for JSON.
  function headers(extra) {
    const h = Object.assign({ Accept: 'application/json' }, extra);
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
  }

  // Parse a JSON body defensively — an empty 204, or a proxy's HTML error page,
  // must not throw a parse error over the real HTTP status.
  async function readJson(res) {
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  async function request(method, path, { body } = {}) {
    const init = { method, headers: headers(body ? { 'Content-Type': 'application/json' } : {}) };
    if (body) init.body = JSON.stringify(body);
    const res = await doFetch(apiUrl(baseUrl, path), init);
    if (res.status === 204) return null;
    const parsed = await readJson(res);
    if (!res.ok) throw new ApiError(problemMessage(parsed, res.status), res.status, parsed);
    return parsed;
  }

  return {
    // Content-intent search (POST /api/v1/search). Source-agnostic: the caller
    // gives what a work IS (a query and/or a content_type), never which service
    // to ask. Returns the `works` array ([] when the body omits it).
    async search({ query, contentType, limit } = {}) {
      const payload = {};
      if (query != null && String(query).trim() !== '') payload.query = String(query).trim();
      if (contentType) payload.content_type = contentType;
      if (limit != null) payload.limit = limit;
      const r = await request('POST', '/search', { body: payload });
      return (r && r.works) || [];
    },

    // Follow a source (POST /api/v1/followed-sources) — a STANDING subscription.
    // Phase 1 follows tv_series only; the server infers the type from the
    // identity (tvdb_id or a TVDB url) and refuses the rest with a message. Give
    // the work by `workId` or by `title` (+ optional `year`). Returns the
    // created FollowedSource (HTTP 201). ⚠️ 403s under a read-scoped TV session.
    async follow({ url, tvdbId, workId, title, year, qualityProfile, monitor, backfill, reason } = {}) {
      const payload = {};
      if (url) payload.url = url;
      if (tvdbId) payload.tvdb_id = tvdbId;
      if (workId) payload.work_id = workId;
      if (title) payload.title = title;
      if (year != null) payload.year = year;
      if (qualityProfile) payload.quality_profile = qualityProfile;
      if (monitor != null) payload.monitor = monitor;
      if (backfill) payload.backfill = backfill;
      if (reason) payload.reason = reason;
      return request('POST', '/followed-sources', { body: payload });
    },

    // List every followed source (GET /api/v1/followed-sources) with its derived
    // counts + health. Returns the `followed_sources` array. Read-scoped: WORKS.
    async listFollowed() {
      const r = await request('GET', '/followed-sources');
      return (r && r.followed_sources) || [];
    },

    // Stop following (DELETE /api/v1/followed-sources/{id}). keep_archive
    // defaults to true (Phase 1 keeps what was archived; false is refused
    // server-side). Resolves to nothing on 204. ⚠️ 403s under a read-scoped TV.
    async unfollow(id, { keepArchive = true } = {}) {
      const q = keepArchive ? '?keep_archive=true' : '?keep_archive=false';
      return request('DELETE', '/followed-sources/' + encodeURIComponent(id) + q);
    },

    // This caller's own authority (GET /api/v1/session, heyarr-core session.go
    // SessionView, ADR-0061). Read-floor, so it WORKS from the TV. Returns
    // { kind, principal_id?, device_key?, scopes, can_write, management_authorized }.
    // The TV reads can_write to tell the operator up front that this is a
    // read-only surface, rather than only discovering it on a 403 after a Follow
    // attempt. A shared TV stays read-only BY DESIGN — this reports the state, it
    // is not a path to authorise the TV itself (that is the phone's job).
    async session() {
      return request('GET', '/session');
    },
  };
}

// A stable client name (unused on the wire today, but the sibling of
// SUBSONIC_CLIENT — kept so a future `User-Agent`/telemetry seam has one name).
export { API_CLIENT };
