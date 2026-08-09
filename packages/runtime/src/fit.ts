// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Fit Width — squeeze a long name into a fixed strap without reflowing layout.
 *
 * Measure-and-scale rather than font-size reduction: scaling the glyph span
 * with a transform keeps the text on the compositor and avoids a relayout on
 * every `update()`, which matters when an operator is typing live on air.
 */

import type { TextFit } from '@breeze/schema';

export interface FitResult {
  /** Horizontal scale written to the glyph span. */
  scale: number;
  /** Natural (unscaled) width in stage pixels. */
  measuredWidth: number;
  /** Width actually occupied after scaling, in stage pixels. */
  scaledWidth: number;
  /**
   * True when `minScale` stopped us short of fitting — the text is still wider
   * than its box. The editor surfaces this so an author finds out at build
   * time rather than on air.
   */
  overflow: boolean;
  /**
   * The text could not be measured — it is not laid out, so there is no width to
   * fit against and nothing was applied.
   *
   * Distinct from `scale: 1`, which means "measured, and it fits". Collapsing the
   * two is what let a hidden layer report a successful fit it had never done.
   */
  unmeasured?: boolean;
}

export const DEFAULT_MIN_SCALE = 0.5;

export function applyTextFit(
  inner: HTMLElement,
  fit: TextFit | undefined,
  layerWidth: number,
): FitResult {
  // Reset before measuring, or we measure the previous scale.
  inner.style.transform = '';

  /**
   * `offsetWidth`, deliberately, not `getBoundingClientRect()`.
   *
   * getBoundingClientRect reports the post-transform box, so any ancestor
   * scale — the editor's fit-to-container preview, or `?scale=contain` — would
   * feed screen pixels into a calculation that must work in stage pixels. That
   * makes Fit Width compute one scale in the editor and a different one on air,
   * which is exactly the editor/playout divergence the shared runtime exists to
   * rule out. offsetWidth is layout size and ignores transforms entirely.
   */
  const measured = inner.offsetWidth;

  if (!fit || fit.mode === 'none') {
    return { scale: 1, measuredWidth: measured, scaledWidth: measured, overflow: false };
  }

  /**
   * A zero measurement is "not laid out", never "empty".
   *
   * `offsetWidth` is 0 for anything inside a `display: none` subtree, and a text
   * layer with an in-point is exactly that until the graphic reaches it. Treating
   * 0 as a width meant `0 <= maxWidth` and no scaling — so a long name typed in
   * *before* PLAY, which is how every show does it, got no Fit Width at all and
   * overran its strap the moment the layer appeared.
   *
   * Callers measure hidden layers by un-hiding them for the measurement (see
   * `refit`). This guard is the backstop: with no width to work from, the honest
   * answer is to leave the text alone rather than to conclude it fits.
   */
  if (measured <= 0) {
    return { scale: 1, measuredWidth: 0, scaledWidth: 0, overflow: false, unmeasured: true };
  }

  const maxWidth = fit.maxWidth ?? layerWidth;
  if (measured <= maxWidth) {
    return { scale: 1, measuredWidth: measured, scaledWidth: measured, overflow: false };
  }
  if (!maxWidth) {
    return { scale: 1, measuredWidth: measured, scaledWidth: measured, overflow: false };
  }

  const minScale = fit.minScale ?? DEFAULT_MIN_SCALE;
  const required = maxWidth / measured;
  const scale = Math.max(minScale, required);

  inner.style.transform = `scaleX(${scale.toFixed(5)})`;

  return {
    scale,
    measuredWidth: measured,
    scaledWidth: measured * scale,
    // Clamped by the legibility floor: squashing further would be unreadable,
    // so we accept overflow and flag it rather than silently mangling the name.
    overflow: required < minScale,
  };
}
