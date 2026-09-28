// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Stages hls.js into apps/server/public/vendor/hls/.
 *
 *   node scripts/vendor-hls.mjs           # stage
 *   node scripts/vendor-hls.mjs --check   # verify staged, exit 1 if not
 *
 * A media layer playing an HLS stream (CYCLE.md, Wave 8) needs hls.js in every
 * engine a graphic plays in except Safari — OBS, vMix and Chrome among them.
 * It is not bundled: the player loads it by a script tag the first time an HLS
 * source is shown, so a graphic with no HLS in it never downloads a byte of it.
 * The same arrangement as GSAP (`vendor-gsap.mjs`), for the same reasons: the
 * pinned version from the lockfile, copied unmodified, offline-capable, and
 * replaceable by swapping one file.
 *
 * The light build — no subtitles, alternate audio or DRM, none of which a
 * camera feed carries — and hls.js's own LICENSE beside it, which Apache-2.0
 * asks to travel with the code.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Declared by apps/server, so resolved from there — pnpm links it nowhere else.
const require = createRequire(path.join(repoRoot, 'apps', 'server', 'package.json'));
const outDir = path.join(repoRoot, 'apps', 'server', 'public', 'vendor', 'hls');
const check = process.argv.includes('--check');

const FILES = [
  ['dist/hls.light.min.js', 'hls.light.min.js'],
  ['dist/hls.light.min.js.map', 'hls.light.min.js.map'],
  ['LICENSE', 'LICENSE'],
];

function hlsRoot() {
  try {
    return path.dirname(require.resolve('hls.js/package.json'));
  } catch {
    throw new Error('hls.js is not installed. It is a devDependency of apps/server — run `pnpm install` before building.');
  }
}

const root = hlsRoot();
const { version } = require(path.join(root, 'package.json'));

if (check) {
  const stampPath = path.join(outDir, 'VERSION');
  const staged = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8').trim() : null;
  const missing = FILES.filter(([, to]) => !fs.existsSync(path.join(outDir, to))).map(([, to]) => to);
  if (missing.length > 0 || staged !== version) {
    console.error(
      `[breeze] hls.js not staged for ${version}` +
        (staged ? ` (found ${staged})` : '') +
        (missing.length > 0 ? `; missing ${missing.join(', ')}` : '') +
        '\n         Run: node scripts/vendor-hls.mjs',
    );
    process.exit(1);
  }
  console.log(`[breeze] hls.js ${version} staged in ${path.relative(repoRoot, outDir)}`);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
let bytes = 0;
for (const [from, to] of FILES) {
  const source = path.join(root, from);
  if (!fs.existsSync(source)) {
    throw new Error(`hls.js ${version} has no ${from}. The package layout changed — check its release notes.`);
  }
  fs.copyFileSync(source, path.join(outDir, to));
  bytes += fs.statSync(source).size;
}
// Read by the server for the cache-busting query, as GSAP's stamp is.
fs.writeFileSync(path.join(outDir, 'VERSION'), `${version}\n`, 'utf8');
fs.writeFileSync(
  path.join(outDir, 'README.md'),
  [
    '# hls.js',
    '',
    `Version ${version}, copied verbatim from the \`hls.js\` npm package by`,
    '`scripts/vendor-hls.mjs`. Not part of Breeze Overlay and **not** covered by',
    "Breeze's MPL-2.0 licence: it is Apache-2.0, see `LICENSE` beside this file.",
    '',
    'Loaded by a media layer the first time it plays an HLS stream in a browser',
    'that cannot play HLS itself. Generated build output: restaged from',
    '`node_modules` on every build. To upgrade, bump the pin in',
    '`apps/server/package.json`.',
    '',
  ].join('\n'),
  'utf8',
);
console.log(`[breeze] staged hls.js ${version} (${(bytes / 1024).toFixed(0)} KB) → ${path.relative(repoRoot, outDir)}`);
