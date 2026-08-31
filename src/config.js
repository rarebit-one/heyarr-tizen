// Heyarr TV configuration.
//
// The one knob a deployment sets: the base URL of the heyarr node this TV
// talks to. It is BOTH the Voidbind relying party (the /login broker,
// ADR-0053) and the OpenSubsonic host (the /rest surface, §70) — heyarr serves
// both from the same origin, so one base URL drives the whole app.
//
// On a real TV there is no address bar, so this is the sign-in-screen default;
// the shell also lets the viewer edit it (and remembers the last-used value in
// localStorage) so a household can point the wall at its own node without a
// rebuild. Mirrors allthing-tizen's config.js.

export const DEFAULT_BASE_URL = 'https://heyarr.local';

// A stable client name + protocol version sent on every Subsonic request
// (the `c` and `v` params). `v` is the OpenSubsonic floor heyarr answers as.
export const SUBSONIC_CLIENT = 'heyarr-tizen';
export const SUBSONIC_API_VERSION = '1.16.1';

const STORAGE_KEY = 'heyarr.baseUrl';

// Read the configured base URL: a previously saved value wins, else the default.
// Wrapped so a webview with storage disabled still yields the default.
export function loadBaseUrl() {
  try {
    const saved = globalThis.localStorage && globalThis.localStorage.getItem(STORAGE_KEY);
    if (saved) return saved;
  } catch (_) { /* storage unavailable — fall through to the default */ }
  return DEFAULT_BASE_URL;
}

// Persist the base URL the viewer typed, so the next launch remembers the node.
export function saveBaseUrl(baseUrl) {
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(STORAGE_KEY, String(baseUrl));
  } catch (_) { /* best-effort — a private webview may refuse */ }
}
