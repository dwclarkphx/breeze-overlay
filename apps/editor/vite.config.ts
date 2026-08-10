// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import { defineConfig, type Plugin } from 'vite';
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
 *  Requires GSAP (GreenSock Animation Platform), (C) Webflow — loaded
 *  separately from /vendor/gsap/, not included in these chunks.
 *  GSAP is licensed separately — https://gsap.com/standard-license
 */`;

/**
 * GSAP resolves to a global, not to the npm package — the same arrangement
 * `apps/server/scripts/build-client.mjs` sets up for the output page, for the
 * same reason: the library ships as a replaceable `gsap.min.js` an operator can
 * upgrade without rebuilding Breeze. See dev/docs/GSAP-EXTERNAL.md.
 *
 * Keeping both consumers on one arrangement is not tidiness. ROADMAP rule 1 is
 * that the editor preview and the served page run the *same* renderer; if only
 * one of them took GSAP from a global, the two could end up animating against
 * different versions of the library and the preview would stop being a promise
 * about what goes to air.
 *
 * Regex `find`s, not strings: Vite's string form matches by prefix, so a plain
 * `'gsap'` entry would also swallow `'gsap/SplitText'` and send both imports to
 * the core shim. Anchoring each pattern is what keeps them apart.
 *
 * Vite's `rollupOptions.external` is deliberately not used. The editor is built
 * as ESM, where an external bare specifier survives into the output as a literal
 * `import ... from 'gsap'` — unresolvable in a browser without an import map.
 */
const RUNTIME_VENDOR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'runtime',
  'src',
  'vendor',
);

const GSAP_ALIAS = [
  { find: /^gsap$/, replacement: path.join(RUNTIME_VENDOR, 'gsap-global.ts') },
  { find: /^gsap\/SplitText$/, replacement: path.join(RUNTIME_VENDOR, 'splittext-global.ts') },
];

/**
 * Inject the vendored GSAP script tags into index.html.
 *
 * Injected rather than written into `index.html` by hand so the cache-busting
 * version cannot be forgotten on a bump — the same reason `APP_VERSION` above is
 * read from a manifest rather than typed as a literal. Nothing in the editor
 * imports GSAP directly, but `@breeze/runtime` does, and the alias sends that
 * import to a global these tags are what populate.
 *
 * The URL is the *server's* staged copy, not one of the editor's own. In
 * production one Fastify process serves both /editor and /public; in dev the
 * `/public` proxy below forwards to it. One staged set means an operator who
 * upgrades GSAP cannot leave the editor preview on a different version from
 * air — which would quietly break ROADMAP rule 1's promise that the preview
 * shows what goes out.
 *
 * Classic (non-module) tags, and Vite leaves their absolute `/public/...` URLs
 * alone rather than rewriting them against `base`, which is what we want: they
 * are server routes, not editor build assets.
 */
function gsapVendorTags(): Plugin {
  const stamp = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'server',
    'public',
    'vendor',
    'gsap',
    'VERSION',
  );

  return {
    name: 'breeze-gsap-vendor-tags',
    transformIndexHtml() {
      /*
       * Read per transform, not once at module load: `pnpm --filter
       * @breeze/server dev` may stage GSAP after the editor's dev server is
       * already up, and a version read too early would pin the query string to
       * a stale value for the life of the process.
       */
      let version = 'unstaged';
      try {
        version = fs.readFileSync(stamp, 'utf8').trim() || 'unstaged';
      } catch {
        /*
         * Not fatal, and deliberately quiet at this point. The editor is
         * routinely started before the server has ever built, and a warning
         * here would fire on every ordinary first run. The tags still emit; if
         * GSAP genuinely is missing, the shim's thrown error names the file and
         * the command that stages it, which is more use than a build-time
         * warning nobody reads.
         */
      }
      const v = encodeURIComponent(version);
      return [
        {
          tag: 'script',
          attrs: { src: `/public/vendor/gsap/gsap.min.js?v=${v}` },
          injectTo: 'head' as const,
        },
        {
          tag: 'script',
          attrs: { src: `/public/vendor/gsap/SplitText.min.js?v=${v}` },
          injectTo: 'head' as const,
        },
      ];
    },
  };
}

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
  plugins: [react(), gsapVendorTags()],
  base: '/editor/',
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  resolve: {
    alias: GSAP_ALIAS,
  },
  /*
   * Without this, Vite's dev-time optimizer still pre-bundles `gsap` on the
   * strength of it appearing in `@breeze/runtime`'s imports — work that produces
   * a chunk the alias guarantees nothing will ever import. Excluding it keeps
   * the dev server from doing it and, more usefully, keeps a stale optimizer
   * cache from being a candidate explanation the next time something looks off.
   */
  optimizeDeps: {
    exclude: ['gsap'],
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
         *
         * There is no `vendor-gsap` entry any more, and its absence is the
         * point rather than an omission: GSAP is aliased to a global, so no
         * module id here can ever resolve to it. The chunk it used to name is
         * now a separate, operator-replaceable file served from /vendor/gsap/.
         */
        manualChunks(id: string): string | undefined {
          const pkg = packageOf(id);
          if (!pkg) return undefined;
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
       * The vendored GSAP files. The editor deliberately does not stage its own
       * copy: one staged set under `apps/server/public/vendor/gsap/` serves both
       * the output page and the editor, so an operator who upgrades GSAP cannot
       * end up with a preview running one version and air running another.
       * In production the same Fastify server hosts /editor and /public, so
       * this proxy is the only place the arrangement needs stating twice.
       */
      '/public': 'http://127.0.0.1:7331',
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
