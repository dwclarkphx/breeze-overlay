// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Base stylesheet injected once per document that hosts a runtime.
 *
 * Rules that matter for playout:
 *  - transparent everywhere, so vMix Web Browser / OBS Browser Source get alpha
 *  - no layout-affecting animation: every animated property is transform,
 *    opacity or filter
 *  - `backface-visibility: hidden` + explicit `translateZ(0)` keeps layers on
 *    their own compositor layer in CEF, which is what stops the 60fps judder
 */

export const RUNTIME_STYLE_ID = 'breeze-runtime-style';

export const RUNTIME_CSS = `
.bz-root {
  position: relative;
  overflow: hidden;
  transform-origin: 0 0;
  background: transparent;
}
.bz-stage {
  position: absolute;
  inset: 0;
  transform-origin: 0 0;
}
.bz-layer {
  position: absolute;
  left: 0;
  top: 0;
  will-change: transform, opacity;
  backface-visibility: hidden;
  transform: translateZ(0);
}
.bz-layer[data-hidden='1'] { display: none; }
.bz-content {
  position: absolute;
  inset: 0;
  display: flex;
}
.bz-shape { position: absolute; inset: 0; }
.bz-image, .bz-video, .bz-sprite { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.bz-text {
  position: absolute;
  inset: 0;
  display: flex;
  white-space: pre;
  overflow: visible;
}
.bz-text-inner {
  display: inline-block;
  transform-origin: left center;
  white-space: pre;
}
.bz-crawl { position: absolute; inset: 0; overflow: hidden; display: flex; align-items: center; }
.bz-crawl-track { display: inline-flex; white-space: pre; will-change: transform; }
/* Two blocks of identical copy. The loop translates by exactly one block's
   width, so the seam between them is invisible — and new headlines are swapped
   in there rather than mid-pass. */
.bz-crawl-block { display: inline-block; white-space: pre; flex: none; }
.bz-nested { position: absolute; inset: 0; }
.bz-group { position: absolute; inset: 0; }
/* Rows are absolutely positioned and moved by transform only, so a re-sort is a
   FLIP on the compositor rather than a relayout of the whole table. The hidden
   overflow is what makes a page boundary a clean edge instead of a half-row. */
.bz-table { position: absolute; inset: 0; overflow: hidden; }
.bz-table-row {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  will-change: transform, opacity;
  backface-visibility: hidden;
}
`;

/** Page-level CSS for output pages — full transparency, no scrollbars. */
export const OUTPUT_PAGE_CSS = `
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background: transparent !important;
  overflow: hidden;
}
* { box-sizing: border-box; }
`;

export function injectRuntimeStyles(doc: Document = document): void {
  if (doc.getElementById(RUNTIME_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = RUNTIME_STYLE_ID;
  style.textContent = RUNTIME_CSS;
  doc.head.appendChild(style);
}
