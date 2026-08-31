#!/usr/bin/env node
// Validate config.xml — the Tizen widget manifest — before a build/package.
//
// A .wgt with a malformed or incomplete config.xml installs but misbehaves in
// ways that only surface on the TV (a missing internet privilege = every fetch
// silently fails; a wrong content src = a blank app). This gate catches the
// structural mistakes at CI time instead. It is intentionally string/regex
// based (no XML dependency): the checks are presence assertions, not a schema.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(root, 'config.xml');

// Each check is [human label, predicate over the raw XML text].
const checks = [
  ['is a <widget> document', (x) => /<widget\b[^>]*xmlns="http:\/\/www\.w3\.org\/ns\/widgets"/.test(x)],
  ['declares the tizen widgets namespace', (x) => /xmlns:tizen="http:\/\/tizen\.org\/ns\/widgets"/.test(x)],
  ['has a widget id', (x) => /<widget\b[^>]*\bid="[^"]+"/.test(x)],
  ['has a <tizen:application> with id + package', (x) =>
    /<tizen:application\b[^>]*\bid="[^"]+"[^>]*\bpackage="[^"]+"/.test(x) ||
    /<tizen:application\b[^>]*\bpackage="[^"]+"[^>]*\bid="[^"]+"/.test(x)],
  ['targets the tv profile', (x) => /<tizen:profile\b[^>]*\bname="tv"/.test(x)],
  ['points <content> at index.html', (x) => /<content\b[^>]*\bsrc="index\.html"/.test(x)],
  ['references an <icon>', (x) => /<icon\b[^>]*\bsrc="[^"]+"/.test(x)],
  ['requests the internet privilege', (x) =>
    /<tizen:privilege\b[^>]*\bname="http:\/\/tizen\.org\/privilege\/internet"/.test(x)],
];

const xml = await readFile(configPath, 'utf8');
const failures = checks.filter(([, ok]) => !ok(xml)).map(([label]) => label);

if (failures.length) {
  console.error('config.xml validation FAILED:');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}

console.log('config.xml is valid (' + checks.length + ' checks passed).');
