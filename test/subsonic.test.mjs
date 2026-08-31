// Tests for src/subsonic.js — the heyarr OpenSubsonic (/rest) wire contract.
//
// These pin the exact shapes heyarr-core's internal/api/subsonic serves and
// expects: query-string auth (p = the heyarr bearer token, never a salted
// token), f=json, the { "subsonic-response": {...} } envelope, and the browse
// payload keys (artists.index[].artist, albumList2.album, album.song).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authParams, restUrl, streamUrl, unwrap, makeClient,
} from '../src/subsonic.js';

const CREDS = { user: 'kate', token: 'sess-abc123' };
const BASE = 'https://heyarr.example';

test('authParams carries the token as the Subsonic password (p), not a salted token', () => {
  const q = authParams(CREDS);
  assert.equal(q.get('p'), 'sess-abc123'); // the heyarr bearer token IS the password
  assert.equal(q.get('u'), 'kate');
  assert.equal(q.get('t'), null); // salted-token auth is refused by heyarr — never sent
  assert.equal(q.get('s'), null);
  assert.equal(q.get('f'), 'json');
  assert.equal(q.get('c'), 'heyarr-tizen');
  assert.equal(q.get('v'), '1.16.1');
});

test('authParams falls back to a default user but never a blank credential surprise', () => {
  const q = authParams({ token: 't' });
  assert.equal(q.get('u'), 'heyarr');
  assert.equal(q.get('p'), 't');
});

test('restUrl builds /rest/{method} with method params merged onto the auth params', () => {
  const u = new URL(restUrl(BASE, 'getAlbumList2', CREDS, { type: 'alphabeticalByName', size: 50 }));
  assert.equal(u.pathname, '/rest/getAlbumList2');
  assert.equal(u.searchParams.get('type'), 'alphabeticalByName');
  assert.equal(u.searchParams.get('size'), '50');
  assert.equal(u.searchParams.get('p'), 'sess-abc123');
  assert.equal(u.searchParams.get('f'), 'json');
});

test('restUrl trims a trailing slash on the base URL', () => {
  const u = new URL(restUrl('https://heyarr.example/', 'ping', CREDS));
  assert.equal(u.origin + u.pathname, 'https://heyarr.example/rest/ping');
});

test('streamUrl targets /rest/stream with the song id — the player src', () => {
  const u = new URL(streamUrl(BASE, 'tr-77', CREDS));
  assert.equal(u.pathname, '/rest/stream');
  assert.equal(u.searchParams.get('id'), 'tr-77');
  assert.equal(u.searchParams.get('p'), 'sess-abc123'); // authenticated stream
});

test('unwrap returns the inner response on status ok', () => {
  const inner = unwrap({ 'subsonic-response': { status: 'ok', albumList2: { album: [] } } });
  assert.deepEqual(inner.albumList2, { album: [] });
});

test('unwrap throws a readable error on status failed (HTTP is still 200)', () => {
  assert.throws(
    () => unwrap({ 'subsonic-response': { status: 'failed', error: { code: 40, message: 'wrong username or password' } } }),
    /subsonic error 40: wrong username or password/,
  );
});

test('unwrap rejects a non-envelope body', () => {
  assert.throws(() => unwrap({ nope: true }), /not a subsonic-response envelope/);
});

// --- client, against a stub fetch that asserts the wire and returns fixtures ---

function stubFetch(routes) {
  return async (url) => {
    const u = new URL(url);
    const method = u.pathname.replace('/rest/', '');
    const body = routes[method];
    if (!body) return { ok: false, status: 404, json: async () => ({}) };
    // Every call must carry the token as p and ask for json.
    assert.equal(u.searchParams.get('p'), CREDS.token, 'call to ' + method + ' must carry the token as p');
    assert.equal(u.searchParams.get('f'), 'json');
    return { ok: true, status: 200, json: async () => body };
  };
}

test('getArtists flattens the letter-bucket index into one artist array', async () => {
  const client = makeClient({
    baseUrl: BASE, creds: CREDS,
    fetchImpl: stubFetch({
      getArtists: { 'subsonic-response': { status: 'ok', artists: { index: [
        { name: 'A', artist: [{ id: 'ar1', name: 'Alpha', albumCount: 2 }] },
        { name: 'B', artist: [{ id: 'ar2', name: 'Bravo', albumCount: 1 }] },
      ] } } },
    }),
  });
  const artists = await client.getArtists();
  assert.equal(artists.length, 2);
  assert.deepEqual(artists.map((a) => a.name), ['Alpha', 'Bravo']);
});

test('getAlbumList returns albumList2.album and defaults to alphabeticalByName', async () => {
  let sawType;
  const client = makeClient({
    baseUrl: BASE, creds: CREDS,
    fetchImpl: async (url) => {
      sawType = new URL(url).searchParams.get('type');
      return { ok: true, status: 200, json: async () => ({
        'subsonic-response': { status: 'ok', albumList2: { album: [
          { id: 'al1', name: 'First', artist: 'Alpha', songCount: 3 },
        ] } },
      }) };
    },
  });
  const albums = await client.getAlbumList();
  assert.equal(sawType, 'alphabeticalByName');
  assert.equal(albums[0].name, 'First');
});

test('getAlbum returns the album with its inlined songs', async () => {
  const client = makeClient({
    baseUrl: BASE, creds: CREDS,
    fetchImpl: stubFetch({
      getAlbum: { 'subsonic-response': { status: 'ok', album: {
        id: 'al1', name: 'First', song: [
          { id: 'tr1', title: 'One', suffix: 'flac', duration: 200 },
          { id: 'tr2', title: 'Two', suffix: 'flac', duration: 180 },
        ],
      } } },
    }),
  });
  const album = await client.getAlbum('al1');
  assert.equal(album.song.length, 2);
  assert.equal(client.streamUrl('tr1').includes('/rest/stream'), true);
});

test('a failed envelope surfaces as a thrown error through the client', async () => {
  const client = makeClient({
    baseUrl: BASE, creds: CREDS,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      'subsonic-response': { status: 'failed', error: { code: 50, message: 'not allowed to read the library' } },
    }) }),
  });
  await assert.rejects(() => client.getAlbumList(), /subsonic error 50/);
});
