// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Stages GSAP's distribution files into apps/server/public/vendor/gsap/.
 *
 *   node scripts/vendor-gsap.mjs           # stage
 *   node scripts/vendor-gsap.mjs --check   # verify staged, exit 1 if not
 *
 * GSAP is not bundled into anything Breeze ships. It is copied here unmodified
 * and loaded by a script tag, so upgrading it is replacing one file and
 * reloading the browser source — not a `pnpm install` and a rebuild. That is
 * the whole reason this script exists; see dev/docs/GSAP-EXTERNAL.md.
 *
 * Copied from node_modules rather than downloaded, so the version staged is the
 * one pnpm-lock.yaml pinned and an install stays offline-capable. A Breeze
 * install that needed the network before its first graphic could play would be
 * the wrong trade for a tool that runs in school gyms and church halls.
 *
 * One staged copy, not one per app: the editor loads these through /public too
 * (via the dev proxy, and directly in production, where one Fastify server
 * hosts both). Two copies could diverge, and a preview animating against a
 * different GSAP than air is exactly the drift ROADMAP rule 1 forbids.
 *
 * The files are copied byte-for-byte. Each carries its own GreenSock license
 * banner, and the npm tarball ships no LICENSE file — the banner *is* the
 * notice, so re-minifying or concatenating them would strip the only copy of it
 * that travels with the code.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * Resolution is anchored at packages/runtime, not at this file.
 *
 * pnpm builds a strict, non-flat node_modules: a package is only linked into
 * the workspace packages that declare it. gsap is declared by packages/runtime
 * and apps/editor, and by nothing at the repo root — so `createRequire` on this
 * script's own URL would fail to find it, correctly. Anchoring on the runtime's
 * manifest also means this script stages the version the *renderer* resolved,
 * which is the one that has to match what the shim reads off window.
 */
const require = createRequire(path.join(repoRoot, 'packages', 'runtime', 'package.json'));
const outDir = path.join(repoRoot, 'apps', 'server', 'public', 'vendor', 'gsap');

const check = process.argv.includes('--check');

/**
 * Only what the runtime actually imports.
 *
 * GSAP's tarball is 6.4 MB of plugins, almost none of which Breeze registers.
 * Staging the lot would put megabytes of unused, separately-licensed code into
 * the shipped tree for no benefit. Adding a plugin here is a deliberate act
 * that should accompany the `registerPlugin` call that needs it.
 *
 * Source maps come along because the files are minified: without them a stack
 * trace from inside GSAP during a live show is unreadable, which is precisely
 * when it matters most.
 */
const FILES = [
  'gsap.min.js',
  'gsap.min.js.map',
  'SplitText.min.js',
  'SplitText.min.js.map',
];

/**
 * Resolve GSAP's installed root through Node rather than by guessing a path.
 *
 * pnpm's store means node_modules/gsap is a symlink into a content-addressed
 * directory whose name embeds the version; joining `node_modules/gsap` by hand
 * works until it doesn't. `package.json` is used as the resolution target
 * because GSAP's `exports` map deliberately exposes it and nothing else that
 * would identify the root.
 */
function gsapRoot() {
  try {
    return path.dirname(require.resolve('gsap/package.json'));
  } catch {
    throw new Error(
      'gsap is not installed. It is a devDependency of packages/runtime and ' +
        'apps/editor — run `pnpm install` before building.',
    );
  }
}

const root = gsapRoot();
const { version } = require(path.join(root, 'package.json'));
const distDir = path.join(root, 'dist');

if (check) {
  const stampPath = path.join(outDir, 'VERSION');
  const staged = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8').trim() : null;
  const missing = FILES.filter((f) => !fs.existsSync(path.join(outDir, f)));

  if (missing.length > 0 || staged !== version) {
    console.error(
      `[breeze] GSAP not staged for ${version}` +
        (staged ? ` (found ${staged})` : '') +
        (missing.length > 0 ? `; missing ${missing.join(', ')}` : '') +
        '\n         Run: node scripts/vendor-gsap.mjs',
    );
    process.exit(1);
  }
  console.log(`[breeze] GSAP ${version} staged in ${path.relative(repoRoot, outDir)}`);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });

let bytes = 0;
for (const file of FILES) {
  const from = path.join(distDir, file);
  if (!fs.existsSync(from)) {
    throw new Error(
      `gsap ${version} has no dist/${file}. The distribution layout changed — ` +
        'check the release notes before bumping the pin in packages/runtime.',
    );
  }
  fs.copyFileSync(from, path.join(outDir, file));
  bytes += fs.statSync(from).size;
}

/*
 * The stamp is load-bearing, not informational. `pages.ts` reads it to build
 * the cache-busting query on the vendor script tags: without that, an operator
 * who drops in a newer gsap.min.js gets the old one back out of the browser
 * cache and concludes the upgrade path does not work. It also gives --check
 * something to compare against, so a stale staged copy is a build failure
 * rather than a mystery at air time.
 */
fs.writeFileSync(path.join(outDir, 'VERSION'), `${version}\n`, 'utf8');

/*
 * GSAP's tarball ships no LICENSE file — the notice lives in each minified
 * banner and in its README. A reader looking at a directory of vendored
 * third-party code should not have to open a minified file to learn what
 * governs it, so the pointer is restated here.
 */
fs.writeFileSync(
  path.join(outDir, 'README.md'),
  [
    '# GSAP (GreenSock Animation Platform)',
    '',
    `Version ${version}, copied verbatim from the \`gsap\` npm package by`,
    '`scripts/vendor-gsap.mjs`. Not part of Breeze Overlay and **not** covered by',
    "Breeze's MPL-2.0 licence.",
    '',
    'Copyright (c) 2008-2026, GreenSock. All rights reserved.',
    'Subject to the terms of the GreenSock Standard License:',
    '<https://gsap.com/standard-license>',
    '',
    'These files are generated build output. Editing them here is legitimate —',
    'replacing `gsap.min.js` with a newer release is the supported upgrade path',
    '(see the user guide) — but any change is lost the next time the build runs,',
    'which restages from `node_modules`. To make an upgrade permanent, bump the',
    'pin in `packages/runtime/package.json` and `apps/editor/package.json`.',
    '',
  ].join('\n'),
  'utf8',
);

console.log(
  `[breeze] staged GSAP ${version} → ${path.relative(repoRoot, outDir)} ` +
    `(${FILES.length} files, ${(bytes / 1024).toFixed(0)} KB)`,
);
