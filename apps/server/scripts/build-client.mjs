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

const watch = process.argv.includes('--watch');

/**
 * MPL-2.0 §3.2: distributing Executable Form requires informing recipients
 * how to obtain the Source Code Form. The banner rides at the top of every
 * bundle; `/*!` marks it a legal comment so minifiers leave it alone.
 */
const LICENSE_BANNER = `/*! Breeze Overlay — Mozilla Public License 2.0
 *  Source: https://github.com/dwclarkphx/breeze-overlay
 *  Includes GSAP (GreenSock Animation Platform), (C) Webflow.
 *  GSAP is licensed separately — https://gsap.com/standard-license
 */`;

const options = {
  entryPoints: [
    path.join(appRoot, 'client', 'player.ts'),
    path.join(appRoot, 'client', 'control.ts'),
    path.join(appRoot, 'client', 'portal.ts'),
  ],
  outdir: path.join(appRoot, 'public'),
  bundle: true,
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
