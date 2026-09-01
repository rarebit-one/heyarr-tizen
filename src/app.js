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
import { makeApiClient } from './api.js';
import { loadBaseUrl, saveBaseUrl } from './config.js';

const $ = (id) => document.getElementById(id);
const show = (el) => { if (el) el.hidden = false; };
const hide = (el) => { if (el) el.hidden = true; };

const state = {
  baseUrl: loadBaseUrl(),
  token: null,
  user: null,
  client: null,     // Subsonic /rest browse+stream client
  api: null,        // heyarr native /api/v1 client (search + follow)
  activeTab: 'library',
  followTarget: null, // the search result a pending Follow is about
  canWrite: null,   // GET /session ⇒ can_write; null until read, false = read-only TV
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
    // The native /api/v1 client carries the SAME session token as a Bearer
    // header (heyarr-core auth.go accepts a web-login session as a bearer).
    state.api = makeApiClient({ baseUrl, token });
    // Read this session's authority up front (best-effort) so the search/followed
    // tabs can say "read-only" before a Follow attempt 403s, rather than only
    // after. A shared TV is read-only by design (decision 1) — we report it.
    state.api.session()
      .then((s) => { state.canWrite = !!(s && s.can_write); })
      .catch(() => { /* unknown authority → leave null, no proactive notice */ });

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

// ---- tabs ------------------------------------------------------------------

const TABS = ['library', 'search', 'followed'];

function switchTab(name) {
  if (!TABS.includes(name)) return;
  state.activeTab = name;
  TABS.forEach((t) => {
    const btn = $('tab-' + t);
    const panel = $('panel-' + t);
    if (btn) btn.setAttribute('aria-selected', String(t === name));
    if (panel) panel.hidden = t !== name;
  });
  if (name === 'search') {
    const i = $('search-input'); if (i) i.focus();
    // Heads-up: a shared TV is signed in read-only, so Follow will be refused.
    // Say so up front (decision 1: the TV stays read-only; follow from a phone).
    if (state.canWrite === false) {
      setSearchStatus('This TV is read-only — search works, but following needs an authorized device (your phone).');
    }
  }
  if (name === 'followed') { loadFollowed(); const b = $('followed-refresh'); if (b) b.focus(); }
}

// ---- search + follow (/api/v1) ---------------------------------------------

async function doSearch() {
  const input = $('search-input');
  const query = (input && input.value.trim()) || '';
  hideFollowForm();
  if (!query) { setSearchStatus('Type something to search for.'); return; }
  setSearchStatus('Searching …');
  const list = $('search-results');
  if (list) list.innerHTML = '';
  try {
    const works = await state.api.search({ query });
    renderResults(works);
  } catch (err) {
    setSearchStatus('Search failed: ' + (err && err.message ? err.message : String(err)));
  }
}

function renderResults(works) {
  const list = $('search-results');
  if (!list) return;
  list.innerHTML = '';
  if (!works.length) { setSearchStatus('No matches.'); return; }
  setSearchStatus(works.length + (works.length === 1 ? ' result.' : ' results.'));
  works.forEach((w, i) => {
    const li = document.createElement('li');
    li.className = 'result';
    const sub = [w.content_type, w.year].filter(Boolean).join(' · ');
    const title = document.createElement('div');
    title.className = 'result-main';
    title.innerHTML = '<span class="result-title">' + esc(w.title || '(untitled)') + '</span>' +
      (sub ? '<span class="result-sub">' + esc(sub) + '</span>' : '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'follow-btn';
    btn.textContent = 'Follow';
    btn.tabIndex = i === 0 ? 0 : -1;
    btn.addEventListener('click', () => openFollowForm(w));
    li.appendChild(title);
    li.appendChild(btn);
    list.appendChild(li);
  });
  const first = list.querySelector('.follow-btn');
  if (first) first.focus();
}

function openFollowForm(work) {
  state.followTarget = work;
  const form = $('follow-form');
  if (!form) return;
  $('follow-form-title') && ($('follow-form-title').textContent = 'Follow: ' + (work.title || 'series'));
  const quality = $('follow-quality'); if (quality) quality.value = '';
  // Pre-fill the feed identity from the search hit when the server already knows
  // it (WorkSummary.tvdb_id, heyarr-core PR #412) — a followed source needs a
  // feed identity, and threading the one search already returned turns a follow
  // from "type the TVDB id yourself" into a one-press confirm. Still editable, and
  // still empty (prompting manual entry) for a hit the library has no stored id for.
  const tvdbEl = $('follow-tvdb'); if (tvdbEl) tvdbEl.value = work.tvdb_id || '';
  setFollowStatus(work.tvdb_id ? '' : 'No stored feed id for this result — enter a TVDB id or URL to follow.');
  form.hidden = false;
  const tvdb = $('follow-tvdb');
  if (tvdb) tvdb.focus();
}

function hideFollowForm() {
  const form = $('follow-form');
  if (form) form.hidden = true;
  state.followTarget = null;
}

async function confirmFollow() {
  const work = state.followTarget;
  if (!work) return;
  const feed = ($('follow-tvdb') && $('follow-tvdb').value.trim()) || '';
  const quality = ($('follow-quality') && $('follow-quality').value.trim()) || '';
  if (!feed) { setFollowStatus('A TVDB series id or URL is required to follow.'); return; }

  // A followed source names the WORK (by id if the search gave one, else by
  // title+year) and the FEED identity (a numeric TVDB id, or a TVDB URL). The
  // server infers the type and, in Phase 1, follows tv_series only.
  const req = {};
  if (work.work_id) req.workId = work.work_id;
  else { req.title = work.title; if (work.year) req.year = work.year; }
  if (/^\d+$/.test(feed)) req.tvdbId = feed; else req.url = feed;
  if (quality) req.qualityProfile = quality;

  setFollowStatus('Following …');
  try {
    const src = await state.api.follow(req);
    setFollowStatus('Now following — ' + (src && src.feed_ref ? 'feed ' + src.feed_ref : 'subscription created') + '.');
    if (state.activeTab === 'followed') loadFollowed();
  } catch (err) {
    setFollowStatus(followErrorMessage(err));
  }
}

// Turn a follow failure into a 10-foot sentence. The load-bearing case is the
// 403: a TV's QR sign-in is READ-scoped (heyarr-core mints web-login sessions
// read-only), so the write route is refused — not because the token is bad, but
// because the TV is a consumption surface. We say exactly that rather than a
// bare "Forbidden".
function followErrorMessage(err) {
  const status = err && err.status;
  const msg = (err && err.message) || String(err);
  if (status === 403) {
    return 'This TV is signed in read-only, so it cannot follow from here. ' +
      'Following needs a write-scoped credential (heyarr read-scopes QR sign-ins) — ' +
      'follow from the phone app or an operator console. (' + msg + ')';
  }
  return 'Could not follow: ' + msg;
}

// ---- followed list (/api/v1) -----------------------------------------------

function loadFollowed() { return refreshFollowed(); }

async function refreshFollowed() {
  const list = $('followed-list');
  setFollowedStatus('Loading your follows …');
  if (list) list.innerHTML = '';
  try {
    const sources = await state.api.listFollowed();
    renderFollowed(sources);
  } catch (err) {
    setFollowedStatus('Could not load follows: ' + (err && err.message ? err.message : String(err)));
  }
}

function renderFollowed(sources) {
  const list = $('followed-list');
  if (!list) return;
  list.innerHTML = '';
  if (!sources.length) { setFollowedStatus('You are not following anything yet.'); return; }
  setFollowedStatus(sources.length + (sources.length === 1 ? ' followed source.' : ' followed sources.'));
  sources.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'result';
    const bits = [s.type, s.feed_ref ? 'feed ' + s.feed_ref : '', s.health,
      (s.items_archived != null ? s.items_archived + '/' + s.items_known + ' archived' : '')]
      .filter(Boolean).join(' · ');
    const main = document.createElement('div');
    main.className = 'result-main';
    main.innerHTML = '<span class="result-title">' + esc(s.work_id || s.id) + '</span>' +
      '<span class="result-sub">' + esc(bits) + '</span>';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'follow-btn unfollow';
    btn.textContent = 'Unfollow';
    btn.tabIndex = i === 0 ? 0 : -1;
    btn.addEventListener('click', () => doUnfollow(s.id, btn));
    li.appendChild(main);
    li.appendChild(btn);
    list.appendChild(li);
  });
  const first = list.querySelector('.follow-btn');
  if (first) first.focus();
}

async function doUnfollow(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Unfollowing …'; }
  try {
    await state.api.unfollow(id);
    setFollowedStatus('Unfollowed.');
    refreshFollowed();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Unfollow'; }
    setFollowedStatus(err && err.status === 403
      ? 'This TV is signed in read-only and cannot unfollow from here (' + err.message + ').'
      : 'Could not unfollow: ' + (err && err.message ? err.message : String(err)));
  }
}

// ---- small status setters --------------------------------------------------

function setPanelStatus(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}
const setSearchStatus = (t) => setPanelStatus('search-status', t);
const setFollowStatus = (t) => setPanelStatus('follow-status', t);
const setFollowedStatus = (t) => setPanelStatus('followed-status', t);

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

  // Tabs.
  $('tab-library') && $('tab-library').addEventListener('click', () => switchTab('library'));
  $('tab-search') && $('tab-search').addEventListener('click', () => switchTab('search'));
  $('tab-followed') && $('tab-followed').addEventListener('click', () => switchTab('followed'));

  // Search + follow.
  $('search-go') && $('search-go').addEventListener('click', doSearch);
  const si = $('search-input');
  if (si) si.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  $('follow-confirm') && $('follow-confirm').addEventListener('click', confirmFollow);
  $('follow-cancel') && $('follow-cancel').addEventListener('click', () => { hideFollowForm(); const r = $('search-results').querySelector('.follow-btn'); if (r) r.focus(); });

  // Followed.
  $('followed-refresh') && $('followed-refresh').addEventListener('click', refreshFollowed);

  // TV remote: the Return/back key (Tizen) unwinds the deepest open layer.
  document.addEventListener('keydown', (e) => {
    const back = e.key === 'XF86Back' || e.key === 'Backspace' || e.keyCode === 10009;
    if (!back) return;
    if ($('now-playing') && !$('now-playing').hidden) { closeNowPlaying(); e.preventDefault(); }
    else if ($('follow-form') && !$('follow-form').hidden) { hideFollowForm(); e.preventDefault(); }
    else if ($('album-detail') && !$('album-detail').hidden) { $('album-detail').hidden = true; e.preventDefault(); }
    else if (state.activeTab !== 'library') { switchTab('library'); e.preventDefault(); }
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
