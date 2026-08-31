#!/usr/bin/env node
// Package the Tizen web app into a .wgt.
//
// A .wgt is just a ZIP of the app directory with config.xml at its ROOT. This
// script stages a clean tree in dist/, VENDORS the voidbind-web ESM module into
// it (so the webview resolves `./vendor/voidbind-web/index.js` with no bundler
// and no CDN — ADR-0001 self-hosted), and zips it.
//
// It does NOT sign. A real device install / store submission signs the .wgt
// with a Tizen author+distributor certificate via the Tizen CLI
// (`tizen package -t wgt -s <profile>`); see README "Deploy". CI only needs to
// prove the tree assembles and packages, which this does.

import { cp, mkdir, rm, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const stage = join(dist, 'app');
const wgt = join(dist, 'heyarr-tizen.wgt');

const exists = (p) => access(p).then(() => true, () => false);

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  // App sources + the manifest and icon at the widget root.
  await cp(join(root, 'src'), stage, { recursive: true });
  await cp(join(root, 'config.xml'), join(stage, 'config.xml'));
  if (await exists(join(root, 'icon.png'))) {
    await cp(join(root, 'icon.png'), join(stage, 'icon.png'));
  } else {
    console.warn('! icon.png missing — Tizen requires an icon; the .wgt will still zip.');
  }

  // Vendor voidbind-web (the login module app.js imports at ./vendor/voidbind-web).
  const vbSrc = join(root, 'node_modules', '@rarebit-one', 'voidbind-web', 'src');
  const vbDst = join(stage, 'vendor', 'voidbind-web');
  if (await exists(vbSrc)) {
    await mkdir(dirname(vbDst), { recursive: true });
    await cp(vbSrc, vbDst, { recursive: true });
    console.log('· vendored voidbind-web from node_modules');
  } else {
    console.warn('! @rarebit-one/voidbind-web not installed — run `npm install` first.');
    console.warn('  The .wgt will package without the login module (dev-only build).');
  }

  // Zip the staged tree with config.xml at the archive root.
  const zip = spawnSync('zip', ['-r', '-X', '-q', wgt, '.'], { cwd: stage, stdio: 'inherit' });
  if (zip.error || zip.status !== 0) {
    console.warn('! `zip` unavailable or failed — staged tree is at ' + stage + ' (not packaged).');
    console.warn('  Package it with any zip tool (config.xml must be at the archive root).');
    process.exit(zip.error ? 1 : (zip.status || 1));
  }

  const files = await readdir(stage);
  console.log('Built ' + wgt);
  console.log('  root entries: ' + files.join(', '));
}

main().catch((err) => { console.error(err); process.exit(1); });
