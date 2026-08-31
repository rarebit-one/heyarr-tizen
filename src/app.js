// Heyarr TV shell — the glue that turns three modules into a working TV app:
//
//   voidbind-web  → QR sign-in against heyarr's weblogin.Broker (ADR-0053)
//   subsonic.js   → browse the library + resolve a streamable URL (§70)
//   <audio>/<video> → play the authenticated stream
//
// It owns all the DOM and the remote-navigable focus model; the wire contracts
// live in the imported modules. Kept framework-free (like voidbind-web itself)
// so the .wgt runs offline with no bundler.
//
// voidbind-web is VENDORED into the .wgt at build time (scripts/build-wgt.mjs
// copies node_modules/@rarebit-one/voidbind-web/src → ./vendor/voidbind-web),
// so this relative import resolves inside the webview with no CDN (ADR-0001).

import { signIn } from './vendor/voidbind-web/index.js';
import { makeClient } from './subsonic.js';
import { loadBaseUrl, saveBaseUrl } from './config.js';

const $ = (id) => document.getElementById(id);
const show = (el) => { if (el) el.hidden = false; };
const hide = (el) => { if (el) el.hidden = true; };

const state = {
  baseUrl: loadBaseUrl(),
  token: null,
  user: null,
  client: null,
};

// ---- sign-in view ----------------------------------------------------------

async function startLogin() {
  const baseUrl = ($('base-url') && $('base-url').value.trim()) || state.baseUrl;
  state.baseUrl = baseUrl;
  saveBaseUrl(baseUrl);

  setStatus('Contacting ' + baseUrl + ' …');
  hide($('login-error'));

  try {
    // The one call the TV needs: POST /login, render the QR, poll to approval.
    const { token, user } = await signIn({
      baseUrl,
      qrElement: $('qr'),
      onStatus: (s) => {
        if (s.phase === 'starting') setStatus('Requesting a login code …');
        else if (s.phase === 'awaiting-approval') setStatus('Scan the code with your phone to sign in.');
        else if (s.phase === 'approved') setStatus('Approved — loading your library …');
      },
    });

    state.token = token;
    state.user = user && (user.name || user.id || user) || 'heyarr';
    state.client = makeClient({ baseUrl, creds: { user: state.user, token } });

    await enterLibrary();
  } catch (err) {
    showLoginError(err && err.message ? err.message : String(err));
  }
}

function setStatus(text) {
  const el = $('login-status');
  if (el) el.textContent = text;
}

function showLoginError(msg) {
  const el = $('login-error');
  if (el) { el.textContent = 'Sign-in failed: ' + msg; el.hidden = false; }
  setStatus('Ready to sign in.');
}

// ---- library browse view ---------------------------------------------------

async function enterLibrary() {
  hide($('view-login'));
  show($('view-library'));
  $('who') && ($('who').textContent = state.user ? ('Signed in as ' + state.user) : 'Signed in');
  await loadAlbums();
}

async function loadAlbums() {
  const list = $('album-list');
  if (list) list.innerHTML = '<li class="loading">Loading library …</li>';
  try {
    const albums = await state.client.getAlbumList({ type: 'alphabeticalByName', size: 200 });
    renderAlbums(albums);
  } catch (err) {
    if (list) list.innerHTML = '<li class="error">Could not load library: ' + esc(err.message) + '</li>';
  }
}

function renderAlbums(albums) {
  const list = $('album-list');
  if (!list) return;
  list.innerHTML = '';
  if (!albums.length) {
    list.innerHTML = '<li class="empty">The library is empty.</li>';
    return;
  }
  albums.forEach((a, i) => {
    const li = document.createElement('li');
    li.className = 'album';
    li.tabIndex = i === 0 ? 0 : -1; // roving tabindex for TV remote focus
    li.dataset.albumId = a.id;
    const sub = [a.artist, a.year].filter(Boolean).join(' · ');
    li.innerHTML = '<span class="album-name">' + esc(a.name) + '</span>' +
      (sub ? '<span class="album-sub">' + esc(sub) + '</span>' : '');
    li.addEventListener('click', () => openAlbum(a.id, a.name));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') openAlbum(a.id, a.name); });
    list.appendChild(li);
  });
  const first = list.querySelector('.album');
  if (first) first.focus();
}

async function openAlbum(id, name) {
  const panel = $('album-detail');
  const songs = $('song-list');
  if (panel) panel.hidden = false;
  $('album-title') && ($('album-title').textContent = name || 'Album');
  if (songs) songs.innerHTML = '<li class="loading">Loading tracks …</li>';
  try {
    const album = await state.client.getAlbum(id);
    renderSongs(album.song || []);
  } catch (err) {
    if (songs) songs.innerHTML = '<li class="error">Could not load tracks: ' + esc(err.message) + '</li>';
  }
}

function renderSongs(songs) {
  const list = $('song-list');
  if (!list) return;
  list.innerHTML = '';
  if (!songs.length) { list.innerHTML = '<li class="empty">No tracks.</li>'; return; }
  songs.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'song';
    li.tabIndex = i === 0 ? 0 : -1;
    const meta = [s.artist, fmtDuration(s.duration)].filter(Boolean).join(' · ');
    li.innerHTML = '<span class="song-title">' + esc(s.title || '(untitled)') + '</span>' +
      (meta ? '<span class="song-sub">' + esc(meta) + '</span>' : '');
    li.addEventListener('click', () => play(s));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') play(s); });
    list.appendChild(li);
  });
}

// ---- player ----------------------------------------------------------------

function play(song) {
  const url = state.client.streamUrl(song.id);
  // Video content types get the <video> element; everything else is audio.
  const isVideo = (song.contentType || '').startsWith('video/') || (song.type === 'video');
  const audio = $('audio-player');
  const video = $('video-player');
  const player = isVideo ? video : audio;
  const other = isVideo ? audio : video;

  if (other) { other.pause && other.pause(); other.hidden = true; other.removeAttribute('src'); }
  show($('now-playing'));
  $('np-title') && ($('np-title').textContent = song.title || '');
  if (player) {
    player.hidden = false;
    player.src = url; // the authenticated, range-capable /rest/stream URL
    const p = player.play && player.play();
    if (p && p.catch) p.catch(() => { /* autoplay may be gated; the controls remain */ });
  }
}

// ---- utilities -------------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return m + ':' + String(s).padStart(2, '0');
}

// ---- boot ------------------------------------------------------------------

function boot() {
  const input = $('base-url');
  if (input) input.value = state.baseUrl;
  const btn = $('sign-in');
  if (btn) btn.addEventListener('click', startLogin);

  // TV remote: the Return/back key (Tizen) closes the album detail / player.
  document.addEventListener('keydown', (e) => {
    const back = e.key === 'XF86Back' || e.key === 'Backspace' || e.keyCode === 10009;
    if (!back) return;
    if ($('now-playing') && !$('now-playing').hidden) { closeNowPlaying(); e.preventDefault(); }
    else if ($('album-detail') && !$('album-detail').hidden) { $('album-detail').hidden = true; e.preventDefault(); }
  });
  const npClose = $('np-close');
  if (npClose) npClose.addEventListener('click', closeNowPlaying);

  setStatus('Ready to sign in.');
}

function closeNowPlaying() {
  ['audio-player', 'video-player'].forEach((id) => {
    const el = $(id);
    if (el) { el.pause && el.pause(); el.hidden = true; el.removeAttribute('src'); }
  });
  hide($('now-playing'));
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
