// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The tab icon: a B in the editor's accent blue (`--accent`, #58a6ff).
 *
 * Drawn as a path rather than set as `<text>`: a text glyph comes from
 * whatever font the viewing machine has, so the icon would be a different B on
 * every browser. The counters are cut with the even-odd rule. No background,
 * so it sits on a light or a dark tab strip alike.
 */
export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<path fill="#58a6ff" fill-rule="evenodd" d="' +
  'M14 8H36C46 8 52 13.5 52 21.5C52 26.5 49.5 30 45.5 31.8C51 33.5 54 38 54 43.5C54 51.5 47.5 56 38 56H14Z' +
  'M24 17V27.5H34.5C38.5 27.5 41 25.5 41 22.2C41 19 38.5 17 34.5 17Z' +
  'M24 36V47H36C40.5 47 43 45 43 41.5C43 38 40.5 36 36 36Z' +
  '"/></svg>';

/** The `<link>` every page but the output carries. */
export const FAVICON_LINK = '<link rel="icon" type="image/svg+xml" href="/favicon.svg">';
