// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { createRequire } from 'node:module';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The editor is a browser bundle, so it cannot read a manifest at runtime the
 * way the server does — the version has to be baked in at build time.
 *
 * Taken from this package's own `package.json`, which `scripts/sync-version.mjs`
 * holds equal to the root version. A literal here would be a second place to
 * forget on a bump, which is exactly how all four workspace packages came to sit
 * at 0.1.0 while the product reached 0.44.
 */
const APP_VERSION = (createRequire(import.meta.url)('./package.json') as { version?: string })
  .version ?? 'dev';

/**
 * Vendor chunk assignment.
 *
 * Vite 8 builds on Rolldown, which only accepts the *function* form of
 * `manualChunks` — the old `{ name: [modules] }` object form throws
 * "manualChunks is not a function" at build time. Rollup's object form used to
 * pull each entry's private dependency subtree along with it; the function form
 * hands us one module id at a time, so the subtree has to be named explicitly.
 *
 * `MOVEABLE_PKGS` is therefore react-moveable *and* its transitive deps. If
 * react-moveable is ever upgraded and its dependency set changes, the stragglers
 * fall back to the app chunk rather than breaking the build — check the printed
 * chunk sizes after a major bump.
 */
/**
 * MPL-2.0 §3.2: distributing Executable Form requires informing recipients
 * how to obtain the Source Code Form. Applied as an output banner so it rides
 * at the top of every emitted chunk; `/*!` marks it a legal comment so the
 * minifier leaves it alone.
 */
const LICENSE_BANNER = `/*! Breeze Overlay — Mozilla Public License 2.0
 *  Source: https://github.com/dwclarkphx/breeze-overlay
 *  Includes GSAP (GreenSock Animation Platform), (C) Webflow.
 *  GSAP is licensed separately — https://gsap.com/standard-license
 */`;

const REACT_PKGS = new Set(['react', 'react-dom', 'scheduler']);

const MOVEABLE_PKGS = new Set([
  'react-moveable',
  'react-css-styled',
  'react-selecto',
  'selecto',
  'gesto',
  'keycon',
  'css-to-mat',
  'overlap-area',
  'framework-utils',
  '@daybrush/utils',
  '@egjs/agent',
  '@egjs/children-differ',
  '@egjs/component',
  '@egjs/list-differ',
  '@scena/dragscroll',
  '@scena/event-emitter',
  '@scena/matrix',
]);

/**
 * Resolve a module id to its owning package name.
 *
 * pnpm ids look like `/…/node_modules/.pnpm/react@19.2.8/node_modules/react/index.js`,
 * so the *last* `node_modules/` segment is the one that names the package.
 */
function packageOf(id: string): string | undefined {
  const path = id.replace(/\\/g, '/');
  const marker = 'node_modules/';
  const at = path.lastIndexOf(marker);
  if (at === -1) return undefined;
  const parts = path.slice(at + marker.length).split('/');
  const [first, second] = parts;
  if (!first) return undefined;
  return first.startsWith('@') && second ? `${first}/${second}` : first;
}

/**
 * The editor is served from the Breeze server at /editor in production, so the
 * base path has to match or every asset URL 404s once built.
 *
 * Test config lives in `vitest.config.ts`, not here. Vitest 4 no longer bundles
 * its own Vite, so the version clash that originally forced the split is gone —
 * they stay apart because the test run has no use for the React plugin or the
 * build/proxy config, and keeping them separate means a change to one cannot
 * silently perturb the other.
 */
export default defineConfig({
  plugins: [react()],
  base: '/editor/',
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        banner: LICENSE_BANNER,
        /**
         * Split the heavy, rarely-changing dependencies out of the app chunk.
         *
         * Load time over a LAN was never the problem. The point is cache
         * reuse: `react-moveable` alone is a third of the bundle and changes
         * approximately never, so isolating it means a rebuild of the editor
         * only invalidates the small app chunk rather than forcing every
         * operator's browser to re-fetch the lot.
         */
        manualChunks(id: string): string | undefined {
          const pkg = packageOf(id);
          if (!pkg) return undefined;
          if (pkg === 'gsap') return 'vendor-gsap';
          if (REACT_PKGS.has(pkg)) return 'vendor-react';
          if (MOVEABLE_PKGS.has(pkg)) return 'vendor-moveable';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 7332,
    // Dev server talks to the real Fastify server, so the editor never needs a
    // mock API and dev/prod behavior cannot drift.
    proxy: {
      '/api': 'http://127.0.0.1:7331',
      '/assets': 'http://127.0.0.1:7331',
      '/play': 'http://127.0.0.1:7331',
      /*
       * The control hub. Needs `ws: true` and a `ws://` target — without it
       * Vite proxies the upgrade request as plain HTTP and the socket fails to
       * open, so an editor run from the dev server would never register its
       * presence while a built one did. A discrepancy between dev and prod is
       * exactly the kind of thing that gets chased in the wrong place.
       */
      '/ws': { target: 'ws://127.0.0.1:7331', ws: true },
    },
  },
});
