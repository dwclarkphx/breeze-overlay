// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Sprite-sheet playback. Two things are worth testing directly and neither is
 * visible in a rendered frame: which frame index a composition time resolves
 * to, and what `background-position` that index writes.
 *
 * Both are off-by-one traps. The frame solver has to stop at `frames - 1` on a
 * sheet whose last row is padded, and the position solver divides by
 * `cols - 1` rather than `cols` because 100% aligns the image's right edge with
 * the box's, not the start of a cell past the end.
 */

import { describe, expect, it } from 'vitest';
import type { SpriteLayer } from '@breeze/schema';

import { applySpriteFrame } from '../dom.js';
import { SpriteSync, frameCountOf, type SpriteBinding } from '../sprite.js';

function stubEl(): HTMLElement {
  return { style: { visibility: '', backgroundPosition: '' } } as unknown as HTMLElement;
}

function layerOf(over: Partial<SpriteLayer> = {}): SpriteLayer {
  return {
    id: 's',
    type: 'sprite',
    src: 'burst.png',
    cols: 6,
    rows: 5,
    fps: 30,
    ...over,
  } as SpriteLayer;
}

function binding(over: Partial<SpriteLayer> = {}, offset = 0): SpriteBinding {
  return { el: stubEl(), layer: layerOf(over), offset };
}

const sync = new SpriteSync();

describe('frameCountOf', () => {
  it('defaults to the full grid', () => {
    expect(frameCountOf(layerOf())).toBe(30);
  });

  it('honours a short count for a padded last row', () => {
    expect(frameCountOf(layerOf({ cols: 6, rows: 6, frameCount: 30 }))).toBe(30);
  });

  it('clamps a count larger than the grid', () => {
    // `validate.ts` refuses this on the way in; the clamp is for documents that
    // predate the rule. Stepping past the end of the sheet is a blank graphic.
    expect(frameCountOf(layerOf({ cols: 4, rows: 2, frameCount: 99 }))).toBe(8);
  });
});

describe('frameFor', () => {
  it('returns null before the sheet starts', () => {
    // Distinct from frame 0 on purpose: "has not started" and "is on its first
    // frame" are different states, and only one of them is a playing sprite.
    expect(sync.frameFor(binding({ startAt: 1 }), 0.5)).toBeNull();
  });

  it('is frame 0 exactly on the start time', () => {
    expect(sync.frameFor(binding({ startAt: 1 }), 1)).toBe(0);
  });

  it('steps at the sheet fps, not the stage fps', () => {
    const b = binding({ startAt: 0, fps: 30 });
    expect(sync.frameFor(b, 0.1)).toBe(3);
    expect(sync.frameFor(b, 0.5)).toBe(15);
  });

  it('holds the last real frame, not the last cell', () => {
    // The trap this whole layer type is built around: a 30-frame animation on a
    // 6×6 sheet must stop at index 29, not wander into the six empty cells.
    const b = binding({ cols: 6, rows: 6, frameCount: 30, fps: 30 });
    expect(sync.frameFor(b, 5)).toBe(29);
  });

  it('does not overshoot on the final frame boundary', () => {
    // A tween under steppedEase returns 1 at p >= 1 and lands one frame past
    // the end. Solving from the clock is what avoids that, so it is asserted
    // exactly at the boundary rather than near it.
    const b = binding({ cols: 5, rows: 2, fps: 10 }); // 10 frames, 1.0s
    expect(sync.frameFor(b, 0.9)).toBe(9);
    expect(sync.frameFor(b, 1.0)).toBe(9);
  });

  it('wraps when looping', () => {
    const b = binding({ cols: 5, rows: 2, fps: 10, loop: true }); // 10 frames
    expect(sync.frameFor(b, 1.0)).toBe(0);
    expect(sync.frameFor(b, 1.3)).toBe(3);
  });

  it('applies the nested-composition offset to startAt', () => {
    const b = binding({ startAt: 1, fps: 10 }, 2);
    expect(sync.frameFor(b, 2.5)).toBeNull();
    expect(sync.frameFor(b, 3.0)).toBe(0);
    expect(sync.frameFor(b, 3.5)).toBe(5);
  });
});

describe('onEnd', () => {
  it('hides through visibility, never display', () => {
    // `display: none` measures zero, and the runtime measures elements — the
    // bug behind Fit Width breaking on layers with an in-point.
    const b = binding({ cols: 5, rows: 2, fps: 10, onEnd: 'clear' });
    const s = new SpriteSync();
    s.add(b);
    s.syncTo(2);
    expect(b.el.style.visibility).toBe('hidden');
    expect(b.el.style.display).toBeFalsy();
  });

  it('holds by default', () => {
    const b = binding({ cols: 5, rows: 2, fps: 10 });
    const s = new SpriteSync();
    s.add(b);
    s.syncTo(2);
    expect(b.el.style.visibility).toBe('');
  });

  it('ignores onEnd while looping, because a loop has no end', () => {
    const b = binding({ cols: 5, rows: 2, fps: 10, loop: true, onEnd: 'clear' });
    const s = new SpriteSync();
    s.add(b);
    s.syncTo(50);
    expect(b.el.style.visibility).toBe('');
  });

  it('comes back when the playhead is scrubbed before the end', () => {
    // Clearing is a function of time, not a latch: scrubbing backwards in the
    // editor has to bring the graphic back or the author cannot review it.
    const b = binding({ cols: 5, rows: 2, fps: 10, onEnd: 'clear' });
    const s = new SpriteSync();
    s.add(b);
    s.syncTo(2);
    s.syncTo(0.5);
    expect(b.el.style.visibility).toBe('');
  });
});

describe('applySpriteFrame', () => {
  it('spans 0%..100% across the columns', () => {
    // Dividing by `cols` instead of `cols - 1` is the off-by-one that shows the
    // last frame half-cropped with the next column bleeding in beside it.
    const el = stubEl();
    const layer = layerOf({ cols: 6, rows: 1 });
    applySpriteFrame(el, layer, 0);
    expect(el.style.backgroundPosition).toBe('0% 0%');
    applySpriteFrame(el, layer, 5);
    expect(el.style.backgroundPosition).toBe('100% 0%');
  });

  it('wraps to the next row past the last column', () => {
    const el = stubEl();
    applySpriteFrame(el, layerOf({ cols: 4, rows: 4 }), 4);
    expect(el.style.backgroundPosition).toBe('0% 33.33333333333333%');
  });

  it('pins a single column to 0% rather than dividing by zero', () => {
    const el = stubEl();
    applySpriteFrame(el, layerOf({ cols: 1, rows: 4 }), 2);
    expect(el.style.backgroundPosition).toBe('0% 66.66666666666666%');
  });

  it('pins a 1×1 sheet to the origin', () => {
    const el = stubEl();
    applySpriteFrame(el, layerOf({ cols: 1, rows: 1 }), 0);
    expect(el.style.backgroundPosition).toBe('0% 0%');
  });
});
