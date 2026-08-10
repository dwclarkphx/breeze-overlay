// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Which GSAP is staged in `public/vendor/gsap/`?
 *
 * GSAP is not bundled into the client — it is copied there verbatim by
 * `scripts/vendor-gsap.mjs` and loaded by a script tag, precisely so that an
 * operator can replace `gsap.min.js` with a newer release and reload the
 * browser source without rebuilding Breeze. The procedure they follow is in
 * docs/USER-GUIDE.md § "Upgrading the animation engine".
 *
 * That upgrade path needs the server to know what is on disk, for two reasons,
 * and both of them are failure modes rather than niceties:
 *
 * 1. **Cache busting.** The vendor files are served from a stable URL. Without
 *    a version in the query string, the operator who swaps the file gets the
 *    cached old one back and concludes the mechanism does not work.
 * 2. **The page-level guard.** The output page checks the GSAP it actually
 *    loaded against the version it expected. A graphic that goes black on air
 *    with nothing in the console is the expensive failure; a mismatch that
 *    announces itself is a cheap one.
 */

import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';

/**
 * Deliberately not a plausible-looking version, for the same reason
 * `UNKNOWN_VERSION` in version.ts is not `0.0.0`: this string ends up in a URL
 * and in an on-screen diagnostic, and one that looks real would send someone
 * hunting for a GSAP release that does not exist.
 */
export const UNSTAGED = 'unstaged';

/** Where the staged files live, relative to the URL space, without a trailing slash. */
export const GSAP_VENDOR_URL = '/public/vendor/gsap';

function read(): string {
  try {
    const stamp = path.join(config.publicDir, 'vendor', 'gsap', 'VERSION');
    const raw = fs.readFileSync(stamp, 'utf8').trim();
    return raw || UNSTAGED;
  } catch {
    /*
     * Never fatal. A missing stamp means the build did not stage GSAP, which
     * the page's own guard will report far more usefully than a server that
     * refuses to start — and refusing to start would take every *other*
     * graphic and the control panel down with it.
     */
    return UNSTAGED;
  }
}

/**
 * Resolved once at startup.
 *
 * Note the consequence, because it is the one sharp edge in the upgrade path:
 * replacing `gsap.min.js` on a *running* server changes the file but not this
 * string, so the cache-busting query stays put and a browser may keep serving
 * the old copy from cache. Restarting the server after a swap is the documented
 * step (see the user guide). Re-reading the stamp per request would trade a
 * documented restart for a filesystem hit on every page load of a process whose
 * whole job is to be predictable under load.
 */
export const GSAP_VERSION = read();
