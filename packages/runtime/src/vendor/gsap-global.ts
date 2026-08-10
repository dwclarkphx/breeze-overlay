// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The bundlers' stand-in for the `gsap` package.
 *
 * `runtime.ts` imports GSAP the ordinary way — `import { gsap } from 'gsap'` —
 * and nothing about that line changes. What changed is where the bundlers send
 * it: `apps/server/scripts/build-client.mjs` and `apps/editor/vite.config.ts`
 * both alias the bare specifier to this file, so the shipped bundles carry a
 * reference to a global instead of a copy of the library.
 *
 * The point is upgradability. GSAP arrives as an unmodified `gsap.min.js`
 * staged into `public/vendor/gsap/` by `scripts/vendor-gsap.mjs`, loaded by a
 * plain script tag ahead of the bundle. An operator who wants a newer GSAP
 * replaces that one file and reloads the browser source — no `pnpm install`,
 * no rebuild, no redeploy. Inlining the library would have made every upgrade a
 * rebuild of Breeze, which is exactly the coupling this removes.
 *
 * Why the alias rather than the bundlers' own `external` option: the editor is
 * built as ESM, and an external bare specifier survives into ESM output as a
 * real `import ... from 'gsap'` that no browser can resolve without an import
 * map. An alias resolves identically in esbuild and Vite, in dev and in build,
 * and needs nothing from the page but a script tag.
 *
 * Types come from the `gsap` devDependency, which stays installed. `import
 * type` means that dependency contributes declarations and nothing else — no
 * value ever crosses this boundary at build time.
 */

import type { gsap as GsapApi } from 'gsap';

/**
 * Read once, at module evaluation.
 *
 * Safe because the vendor script tags are classic (non-module, non-deferred)
 * and precede the bundle on every page that loads a runtime, so the global is
 * populated before this module can be evaluated. A live getter would buy
 * nothing: any caller reaching this module already needs GSAP present.
 */
const host = globalThis as unknown as Record<string, unknown>;
const loaded = host['gsap'];

if (!loaded) {
  /*
   * Last-resort diagnostic, not the user-facing one. The page-level check in
   * pages.ts runs in an inline script ahead of the bundle and can still put
   * something legible on screen; by the time this module evaluates, a bundle is
   * already mid-import and a thrown error is all that is left. Both exist
   * because the failure mode this guards — a graphic that goes black on air
   * with a silent console — is the expensive one.
   */
  throw new Error(
    '[breeze] GSAP was not found on window. It loads from ' +
      '/public/vendor/gsap/gsap.min.js, which must be staged by ' +
      '`node scripts/vendor-gsap.mjs` and script-tagged ahead of this bundle.',
  );
}

export const gsap = loaded as typeof GsapApi;

export default gsap;
