// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The bundlers' stand-in for `gsap/SplitText` — see `gsap-global.ts` for why
 * this arrangement exists.
 *
 * SplitText is a separate UMD file (`SplitText.min.js`, ~8 KB) that assigns
 * `window.SplitText` and finds the core library through `window.gsap`, so its
 * script tag must follow GSAP's. `runtime.ts` still calls
 * `gsap.registerPlugin(SplitText)` exactly as before; registration is what
 * connects the two, and it does not care that both arrived as globals.
 *
 * It ships as its own file rather than folded into the core for the same reason
 * the core is external at all: an operator upgrading GSAP gets both files from
 * the same release and can replace them independently if only one is at fault.
 */

import type { SplitText as SplitTextApi } from 'gsap/SplitText';

const host = globalThis as unknown as Record<string, unknown>;
const loaded = host['SplitText'];

if (!loaded) {
  throw new Error(
    '[breeze] GSAP SplitText was not found on window. It loads from ' +
      '/public/vendor/gsap/SplitText.min.js, whose script tag must come after ' +
      "gsap.min.js's — SplitText resolves the core library through window.gsap.",
  );
}

export const SplitText = loaded as typeof SplitTextApi;

export default SplitText;
