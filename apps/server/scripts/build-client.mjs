// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Bundles the browser-side entry points into apps/server/public.
 * esbuild (not Vite) because these are dependency-free IIFE bundles with no
 * dev-server needs: one call, no config file, no HMR machinery to carry.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const repoRoot = path.resolve(appRoot, '..', '..');

const watch = process.argv.includes('--watch');

/**
 * MPL-2.0 §3.2: distributing Executable Form requires informing recipients
 * how to obtain the Source Code Form. The banner rides at the top of every
 * bundle; `/*!` marks it a legal comment so minifiers leave it alone.
 *
 * It says "requires" rather than "includes" because that is now the fact:
 * GSAP is aliased to a global and loaded from a separate script tag, so no
 * GreenSock code is in this output. A banner that claimed otherwise would be
 * the kind of stale legal notice that is worse than none.
 */
const LICENSE_BANNER = `/*! Breeze Overlay — Mozilla Public License 2.0
 *  Source: https://github.com/dwclarkphx/breeze-overlay
 *  Requires GSAP (GreenSock Animation Platform), (C) Webflow — loaded
 *  separately from /public/vendor/gsap/, not included in this file.
 *  GSAP is licensed separately — https://gsap.com/standard-license
 */`;

/**
 * GSAP resolves to a global, not to the npm package.
 *
 * `packages/runtime` imports `gsap` and `gsap/SplitText` normally; these two
 * entries redirect both to shims that read `window.gsap` / `window.SplitText`,
 * which the vendor script tags populate ahead of this bundle. The library
 * therefore ships as a replaceable file rather than as inlined bytes — see
 * dev/docs/GSAP-EXTERNAL.md.
 *
 * esbuild's own `external` is deliberately not used: in `iife` format an
 * external bare specifier becomes a bare `require("gsap")` call at runtime,
 * which fails in a browser. Aliasing keeps the resolution honest.
 *
 * Aimed at the TypeScript sources rather than `packages/runtime/dist`, so this
 * bundle does not acquire a build-order dependency on the runtime having been
 * compiled first. esbuild reads .ts natively.
 */
const RUNTIME_VENDOR = path.join(repoRoot, 'packages', 'runtime', 'src', 'vendor');

const GSAP_ALIAS = {
  gsap: path.join(RUNTIME_VENDOR, 'gsap-global.ts'),
  'gsap/SplitText': path.join(RUNTIME_VENDOR, 'splittext-global.ts'),
};

const options = {
  entryPoints: [
    path.join(appRoot, 'client', 'player.ts'),
    path.join(appRoot, 'client', 'control.ts'),
    path.join(appRoot, 'client', 'portal.ts'),
  ],
  outdir: path.join(appRoot, 'public'),
  bundle: true,
  alias: GSAP_ALIAS,
  format: 'iife',
  target: ['chrome100'],
  platform: 'browser',
  banner: { js: LICENSE_BANNER },
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

await build(options);
console.log(`[breeze] client bundle written to ${options.outdir}`);
