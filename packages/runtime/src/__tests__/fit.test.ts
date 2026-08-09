// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Fit Width unit tests.
 *
 * A stub element with a controlled `offsetWidth` is used rather than a DOM
 * environment: happy-dom has no layout engine, so every real element measures
 * 0 and the interesting branches would never run. The Playwright suite covers
 * the same rules against real text metrics in Chromium.
 */

import { describe, expect, it } from 'vitest';
import type { TextFit } from '@breeze/schema';

import { DEFAULT_MIN_SCALE, applyTextFit } from '../fit.js';

function stubSpan(naturalWidth: number): HTMLElement {
  return { style: { transform: '' }, offsetWidth: naturalWidth } as unknown as HTMLElement;
}

const FIT: TextFit = { mode: 'width', maxWidth: 700, minScale: 0.6 };

describe('applyTextFit', () => {
  it('leaves text that already fits at scale 1', () => {
    const el = stubSpan(420);
    const result = applyTextFit(el, FIT, 700);

    expect(result.scale).toBe(1);
    expect(result.overflow).toBe(false);
    expect(el.style.transform).toBe('');
  });

  it('treats an exact fit as no scaling needed', () => {
    const result = applyTextFit(stubSpan(700), FIT, 700);
    expect(result.scale).toBe(1);
    expect(result.overflow).toBe(false);
  });

  describe('unmeasurable text', () => {
    /*
     * The bug this class of test exists for, caught in a browser and not here:
     * `offsetWidth` is 0 for anything inside a `display: none` subtree, and a
     * text layer with an in-point is exactly that until the graphic reaches it.
     * A zero width was read as a width, so `0 <= 700` said "it fits" — and a long
     * name typed in before PLAY, which is how every show does it, was never
     * scaled and overran its strap the moment the layer appeared.
     *
     * The old assertions could not have caught it: a stub with offsetWidth 0
     * returning scale 1 looks exactly like success.
     */
    it('reports that it could not measure, rather than that the text fits', () => {
      const result = applyTextFit(stubSpan(0), FIT, 700);
      expect(result.unmeasured).toBe(true);
      expect(result.measuredWidth).toBe(0);
    });

    it('applies no transform when there is nothing to measure', () => {
      const el = stubSpan(0);
      applyTextFit(el, FIT, 700);
      expect(el.style.transform).toBe('');
    });

    it('does not claim a hidden layer overflows either', () => {
      // Unknown is unknown in both directions: an unmeasured layer must not
      // raise the authoring warning any more than it may claim to fit.
      expect(applyTextFit(stubSpan(0), { mode: 'width', maxWidth: 10, minScale: 0.6 }, 10).overflow)
        .toBe(false);
    });

    it('says nothing about measurement when fitting is off', () => {
      // mode 'none' returns before any of this; the flag is about Fit Width
      // failing to measure, not about a layer that never asked to be fitted.
      expect(applyTextFit(stubSpan(0), { mode: 'none' }, 700).unmeasured).toBeUndefined();
    });

    it('still fits normally once the same text is laid out', () => {
      const el = stubSpan(1000);
      const result = applyTextFit(el, FIT, 700);
      expect(result.unmeasured).toBeUndefined();
      expect(result.scale).toBeCloseTo(0.7, 5);
    });
  });

  it('condenses to exactly the max width', () => {
    const el = stubSpan(1000);
    const result = applyTextFit(el, FIT, 700);

    expect(result.scale).toBeCloseTo(0.7, 5);
    expect(result.scaledWidth).toBeCloseTo(700, 3);
    expect(result.overflow).toBe(false);
    expect(el.style.transform).toBe('scaleX(0.70000)');
  });

  it('clamps at minScale and reports overflow instead of squashing further', () => {
    // 1400px into a 700px box needs 0.5, below the 0.6 floor.
    const result = applyTextFit(stubSpan(1400), FIT, 700);

    expect(result.scale).toBeCloseTo(0.6, 5);
    expect(result.scaledWidth).toBeCloseTo(840, 3);
    expect(result.overflow).toBe(true);
  });

  it('uses a 0.5 floor when the composition does not specify one', () => {
    const result = applyTextFit(stubSpan(10_000), { mode: 'width', maxWidth: 700 }, 700);
    expect(result.scale).toBeCloseTo(DEFAULT_MIN_SCALE, 5);
    expect(result.overflow).toBe(true);
  });

  it('falls back to the layer width when no maxWidth is given', () => {
    const result = applyTextFit(stubSpan(600), { mode: 'width' }, 300);
    expect(result.scale).toBeCloseTo(0.5, 5);
  });

  it('does nothing in mode "none", however long the text is', () => {
    const el = stubSpan(5000);
    const result = applyTextFit(el, { mode: 'none' }, 700);

    expect(result.scale).toBe(1);
    expect(result.overflow).toBe(false);
    expect(el.style.transform).toBe('');
  });

  it('clears a previous scale before measuring, so refits are not cumulative', () => {
    const el = stubSpan(1000);
    applyTextFit(el, FIT, 700);
    expect(el.style.transform).toBe('scaleX(0.70000)');

    // Same element, now with shorter text: the old transform must not persist.
    (el as unknown as { offsetWidth: number }).offsetWidth = 400;
    const result = applyTextFit(el, FIT, 700);

    expect(result.scale).toBe(1);
    expect(el.style.transform).toBe('');
  });

  it('is idempotent — refitting unchanged text gives the same scale', () => {
    const el = stubSpan(1000);
    const first = applyTextFit(el, FIT, 700);
    const second = applyTextFit(el, FIT, 700);

    expect(second.scale).toBeCloseTo(first.scale, 10);
    expect(second.measuredWidth).toBe(first.measuredWidth);
  });
});
