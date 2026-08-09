// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYOUT,
  LAYOUT_LIMITS,
  LAYOUT_STORAGE_KEY,
  clampLayout,
  clampPanel,
  loadLayout,
  saveLayout,
} from '../state/layout.js';

/** A `localStorage` stand-in, so these never touch a real one. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    read: () => data,
  };
}

describe('clampPanel', () => {
  it('leaves a size inside the limits alone', () => {
    expect(clampPanel('left', 300)).toBe(300);
    expect(clampPanel('timeline', 200)).toBe(200);
  });

  it('holds a panel at its minimum rather than letting it vanish', () => {
    expect(clampPanel('left', 0)).toBe(LAYOUT_LIMITS.left.min);
    expect(clampPanel('right', -500)).toBe(LAYOUT_LIMITS.right.min);
    expect(clampPanel('timeline', 10)).toBe(LAYOUT_LIMITS.timeline.min);
  });

  it('holds a panel at its maximum', () => {
    expect(clampPanel('left', 9999)).toBe(LAYOUT_LIMITS.left.max);
  });

  it('caps a panel at a share of the window, so the stage keeps room', () => {
    // 45% of 800 is 360, tighter than the 480 hard maximum.
    expect(clampPanel('left', 9999, 800)).toBe(360);
  });

  it('lets the minimum win over the share cap on a very small window', () => {
    /*
     * 45% of 200 is 90, below the 180 minimum. Returning 90 would render a panel
     * too narrow to use; a window this size cannot be laid out either way, and
     * an unusable panel is the worse of the two failures.
     */
    expect(clampPanel('left', 300, 200)).toBe(LAYOUT_LIMITS.left.min);
  });

  it('falls back to the default for a value that is not a number', () => {
    expect(clampPanel('left', Number.NaN)).toBe(DEFAULT_LAYOUT.left);
    expect(clampPanel('right', Number.POSITIVE_INFINITY)).toBe(DEFAULT_LAYOUT.right);
  });

  it('rounds, so the DOM never gets a fractional pixel', () => {
    expect(clampPanel('left', 260.4)).toBe(260);
  });
});

describe('clampLayout', () => {
  it('measures the side panels against width and the timeline against height', () => {
    const clamped = clampLayout(
      { left: 9999, right: 9999, timeline: 9999 },
      { width: 800, height: 600 },
    );
    // 45% of 800 = 360 for the sides; 45% of 600 = 270 for the timeline.
    expect(clamped).toEqual({ left: 360, right: 360, timeline: 270 });
  });
});

describe('loadLayout', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(loadLayout(fakeStorage())).toEqual(DEFAULT_LAYOUT);
  });

  it('reads back what was saved', () => {
    const store = fakeStorage();
    saveLayout({ left: 320, right: 260, timeline: 200 }, store);
    expect(loadLayout(store)).toEqual({ left: 320, right: 260, timeline: 200 });
  });

  it('clamps a stored size that is out of range', () => {
    const store = fakeStorage({ [LAYOUT_STORAGE_KEY]: JSON.stringify({ left: 4000 }) });
    expect(loadLayout(store).left).toBe(LAYOUT_LIMITS.left.max);
  });

  it('falls back per key, not wholesale, when one entry is unusable', () => {
    const store = fakeStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({ left: 320, right: 'wide', timeline: null }),
    });
    expect(loadLayout(store)).toEqual({
      left: 320,
      right: DEFAULT_LAYOUT.right,
      timeline: DEFAULT_LAYOUT.timeline,
    });
  });

  it('survives a corrupt entry rather than throwing on the way to first paint', () => {
    const store = fakeStorage({ [LAYOUT_STORAGE_KEY]: '{not json' });
    expect(loadLayout(store)).toEqual(DEFAULT_LAYOUT);
  });

  it('survives storage being unavailable entirely', () => {
    // Private browsing and locked-down profiles throw on access, not just write.
    const hostile = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadLayout(hostile)).toEqual(DEFAULT_LAYOUT);
    expect(() => saveLayout(DEFAULT_LAYOUT, hostile)).not.toThrow();
  });
});
