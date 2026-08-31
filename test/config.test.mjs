// Tests for src/config.js — the one deployment knob (the heyarr base URL) and
// its localStorage persistence, which must degrade gracefully in a webview
// where storage is disabled or throws.

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('loadBaseUrl returns the saved value when storage has one', async () => {
  const store = new Map([['heyarr.baseUrl', 'https://wall.example']]);
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  const { loadBaseUrl } = await import('../src/config.js?case=saved');
  assert.equal(loadBaseUrl(), 'https://wall.example');
  delete globalThis.localStorage;
});

test('loadBaseUrl falls back to the default when storage is empty', async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const { loadBaseUrl, DEFAULT_BASE_URL } = await import('../src/config.js?case=empty');
  assert.equal(loadBaseUrl(), DEFAULT_BASE_URL);
  delete globalThis.localStorage;
});

test('loadBaseUrl survives a storage accessor that throws', async () => {
  globalThis.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => {} };
  const { loadBaseUrl, DEFAULT_BASE_URL } = await import('../src/config.js?case=throws');
  assert.equal(loadBaseUrl(), DEFAULT_BASE_URL);
  delete globalThis.localStorage;
});

test('saveBaseUrl never throws even when storage refuses', async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => { throw new Error('refused'); } };
  const { saveBaseUrl } = await import('../src/config.js?case=save');
  assert.doesNotThrow(() => saveBaseUrl('https://x.example'));
  delete globalThis.localStorage;
});
