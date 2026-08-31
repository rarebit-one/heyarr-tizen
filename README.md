# heyarr-tizen

The **Heyarr Tizen TV/wall client** — a Samsung Tizen `.wgt` web app that a
credential-less television uses to sign in to a heyarr node by **QR** and then
**browse and play** the library on the big screen.

Sibling of [`heyarr-mobile`](https://github.com/rarebit-one/heyarr-mobile) (the
Android first-party client). Where the phone holds a device key, a TV holds
neither a heyarr token nor a device key, so it authenticates the way a browser
does: it shows a Voidbind QR that an enrolled phone approves.

## How it works

```
┌─────────────┐   1. POST /login          ┌──────────────────────┐
│  Heyarr TV  │ ────────────────────────▶ │  heyarr node         │
│  (.wgt)     │   2. show voidbind QR      │  weblogin.Broker     │  ADR-0053
│             │      (phone approves)      │  (/login)            │
│  voidbind-  │ ◀──── 3. session token ─── │                      │
│  web        │                            │                      │
│             │   4. /rest browse + stream │  OpenSubsonic adapter│  §70
│  subsonic.js│ ◀────────────────────────▶ │  (/rest, token=pw)   │
└─────────────┘                            └──────────────────────┘
```

1. **QR login** — [`@rarebit-one/voidbind-web`](https://github.com/rarebit-one/voidbind-web)'s
   `signIn({ baseUrl })` POSTs `{{base}}/login`, renders the returned
   `voidbind:login?rp=&id=` payload as a QR, and polls `{{base}}/login/{id}`
   until an enrolled device approves — yielding a short-lived **session token**
   (heyarr's ADR-0053 `weblogin.Broker`). The broker is mounted at `/login` on
   the same origin.
2. **Browse** — [`src/subsonic.js`](src/subsonic.js) speaks heyarr's
   **OpenSubsonic** `/rest` compat surface (heyarr-core `internal/api/subsonic`,
   §70). The session token is carried as the Subsonic **password** on the query
   string (`p=<token>`) — heyarr verifies it as a bearer token and refuses the
   salted-token scheme, so this client always sends `p=`. Methods used:
   `getAlbumList2`, `getAlbum` (songs inlined), `getArtists`, `stream`.
3. **Play** — a selected track's `/rest/stream?id=…` URL (range-capable, 206,
   M10 progressive partial serving inherited from the blob handler) is set as
   an `<audio>`/`<video>` `src`.

The whole app is framework-free ESM with **no bundler and no CDN** (ADR-0001
self-hosted): `voidbind-web` is vendored into the `.wgt` at build time.

## Scope (Phase-1 shell)

This is a functional browse+play shell, **not** a full 10-foot UI. It gives you:
QR sign-in, a remote-navigable album list, an album's track list, and a player
pointed at the authenticated stream. A configurable server base URL
([`src/config.js`](src/config.js), remembered in `localStorage`) is the one knob.

### Deferred (deliberately)

- **The Follow button.** Following a source needs heyarr's native `/api/v1`
  REST route from **M12 Slice 5**, which is not merged yet. The Subsonic compat
  surface is read-only (no playlists/scrobbles/follows — those live in the
  device-side Personal MCP), so Follow is out of scope until that route lands.
- **Phone-as-controller cast / SSDP (#382).** The cast/second-screen model is
  being designed in heyarr-core's M12 track; building it here would race that
  work. This client is a direct player only. **We do not touch heyarr-core.**
- OPDS (`/opds`) and DLNA (`/dlna`) are alternative compat surfaces heyarr also
  serves; this shell picks **Subsonic `/rest`** as the simplest for a TV. The
  seam (`subsonic.js`) is swappable if a future view wants OPDS for books.

## Develop

```
npm install     # installs @rarebit-one/voidbind-web (public git dep, pinned by SHA)
npm test        # node --test — validates config.xml, then the subsonic contract
npm run build   # stage + vendor voidbind-web + zip → dist/heyarr-tizen.wgt
```

`npm test` is the CI merge gate. It runs `scripts/validate-config.mjs` (a
presence check over `config.xml`) then the unit tests, which pin the Subsonic
wire contract (query-string token auth, the `subsonic-response` envelope, the
browse payload shapes) with a stub `fetch`.

## Deploy (dev-cert sideload to a TV)

The `.wgt` `npm run build` produces is **unsigned**. To sideload onto a real
Samsung TV you sign it with a Tizen author + distributor certificate and push
it over the network with the Tizen CLI:

```
# one-time: create a dev certificate profile
tizen certificate -a heyarr -p <pw> -f heyarr-author -o certs/
tizen security-profiles add -n heyarr -a certs/heyarr-author.p12 -p <pw>

# put the TV in Developer Mode (Apps → 12345 → set host IP), then:
sdb connect <tv-ip>
tizen package -t wgt -s heyarr -- dist/app         # sign the staged tree
tizen install  -n heyarr-tizen.wgt -t <tv-name>    # sideload
```

Set the heyarr server URL on the sign-in screen (it is remembered per TV), or
change the default in `src/config.js` before building for a fixed wall.

The application `package` id in [`config.xml`](config.xml) (`heyarrTV0A`) is a
placeholder dev id; a store submission gets its own 10-char Tizen package id and
re-sign.

## License

[AGPL-3.0-or-later](./LICENSE), matching `heyarr-core`, `voidbind-web` and the
rest of the heyarr family.
