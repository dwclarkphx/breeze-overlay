// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import {
  MIN_BROADCAST_STAGE,
  MIN_GUIDE_CANVAS_WIDTH,
  ZOOM_LIMITS,
  canvasFitsGuides,
  clampZoom,
  distance,
  fitZoom,
  midpoint,
  stageWantsGuides,
  zoomAtPoint,
} from '../state/stage-math.js';

const HD = { width: 1920, height: 1080 };

describe('fitZoom', () => {
  it('fits a 1080p stage into a desktop-sized canvas', () => {
    // 1200 wide minus 24px padding either side is 1152 usable: 1152/1920 = 0.6,
    // and the height is not the binding constraint.
    expect(fitZoom({ width: 1200, height: 900 }, HD)).toBeCloseTo(0.6, 6);
  });

  it('is bound by whichever axis runs out first', () => {
    // A wide, short canvas: the height decides.
    const zoom = fitZoom({ width: 2000, height: 400 }, HD)!;
    expect(zoom).toBeCloseTo((400 - 48) / 1080, 6);
  });

  it('scales down for a tablet-sized canvas', () => {
    /*
     * The reported bug. The zoom was hardcoded at 0.45, which puts a 1080p stage
     * at 864×486 — wider than this canvas, so the preview was cropped and Fit
     * put it straight back. Any correct fit here is well under 0.45.
     */
    const zoom = fitZoom({ width: 520, height: 700 }, HD)!;
    expect(zoom).toBeLessThan(0.45);
    expect(zoom * HD.width).toBeLessThanOrEqual(520);
  });

  it('re-fits when a tablet rotates', () => {
    const landscape = fitZoom({ width: 900, height: 500 }, HD)!;
    const portrait = fitZoom({ width: 500, height: 900 }, HD)!;
    expect(portrait).toBeLessThan(landscape);
  });

  it('returns null for an unmeasured canvas', () => {
    // Distinguishable from "measured and tiny": the caller must keep the
    // previous zoom rather than collapsing the stage to nothing on first paint.
    expect(fitZoom({ width: 0, height: 0 }, HD)).toBeNull();
    expect(fitZoom({ width: 800, height: 0 }, HD)).toBeNull();
  });

  it('returns null for a stage with no size', () => {
    expect(fitZoom({ width: 800, height: 600 }, { width: 0, height: 0 })).toBeNull();
  });

  it('never returns a zoom outside the limits', () => {
    // A canvas smaller than the padding must not produce a zero or negative scale.
    const tiny = fitZoom({ width: 10, height: 10 }, HD)!;
    expect(tiny).toBeGreaterThanOrEqual(ZOOM_LIMITS.min);

    const huge = fitZoom({ width: 40000, height: 40000 }, HD)!;
    expect(huge).toBeLessThanOrEqual(ZOOM_LIMITS.max);
  });
});

describe('clampZoom', () => {
  it('holds the limits', () => {
    expect(clampZoom(99)).toBe(ZOOM_LIMITS.max);
    expect(clampZoom(0)).toBe(ZOOM_LIMITS.min);
    expect(clampZoom(-3)).toBe(ZOOM_LIMITS.min);
  });

  it('survives a NaN from a degenerate pinch', () => {
    expect(clampZoom(Number.NaN)).toBe(ZOOM_LIMITS.min);
  });
});

describe('zoomAtPoint', () => {
  const centre = { x: 500, y: 300 };

  it('leaves the pan alone when zooming about the center with no offset', () => {
    expect(zoomAtPoint({ x: 0, y: 0 }, 1, 2, centre, centre)).toEqual({ x: 0, y: 0 });
  });

  it('keeps the point under the pointer fixed', () => {
    const pan = { x: 40, y: -20 };
    const zoom = 0.5;
    const next = 1.25;
    const pointer = { x: 620, y: 250 };

    // Where the pointer is, in stage space, before and after.
    const before = { x: (pointer.x - centre.x - pan.x) / zoom, y: (pointer.y - centre.y - pan.y) / zoom };
    const pan2 = zoomAtPoint(pan, zoom, next, pointer, centre);
    const after = { x: (pointer.x - centre.x - pan2.x) / next, y: (pointer.y - centre.y - pan2.y) / next };

    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('is reversible', () => {
    const pan = { x: 12, y: 7 };
    const pointer = { x: 700, y: 400 };
    const out = zoomAtPoint(pan, 1, 2, pointer, centre);
    const back = zoomAtPoint(out, 2, 1, pointer, centre);
    expect(back.x).toBeCloseTo(pan.x, 9);
    expect(back.y).toBeCloseTo(pan.y, 9);
  });

  it('refuses to divide by a zero zoom', () => {
    const pan = { x: 5, y: 5 };
    expect(zoomAtPoint(pan, 0, 1, { x: 1, y: 1 }, centre)).toBe(pan);
  });
});

describe('pinch geometry', () => {
  it('measures the spread between two fingers', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('finds the midpoint the zoom anchors on', () => {
    expect(midpoint({ x: 0, y: 10 }, { x: 20, y: 30 })).toEqual({ x: 10, y: 20 });
  });
});

describe('canvasFitsGuides', () => {
  it('draws guides on a normal editing pane', () => {
    expect(canvasFitsGuides({ width: 1200, height: 800 })).toBe(true);
  });

  it('hides them once the pane is narrower than the threshold', () => {
    expect(canvasFitsGuides({ width: 320, height: 800 })).toBe(false);
  });

  it('treats the threshold itself as wide enough', () => {
    // "smaller than 480" — 480 exactly still gets guides. Stated as a test
    // because off-by-one at a boundary is the whole content of this function.
    expect(canvasFitsGuides({ width: MIN_GUIDE_CANVAS_WIDTH, height: 400 })).toBe(true);
    expect(canvasFitsGuides({ width: MIN_GUIDE_CANVAS_WIDTH - 1, height: 400 })).toBe(false);
  });

  it('allows guides on an unmeasured canvas', () => {
    /*
     * Width 0 means the ResizeObserver has not run yet, not that the pane is
     * tiny. Reading it as "too narrow" would hide the guides for the first
     * frame of every load and show them a tick later — a flash on a surface
     * where nothing actually moved. Same reasoning as `fitZoom` returning null
     * rather than 0 for an unmeasured canvas.
     */
    expect(canvasFitsGuides({ width: 0, height: 0 })).toBe(true);
  });

  it('ignores height — the threshold is a width', () => {
    expect(canvasFitsGuides({ width: 1200, height: 40 })).toBe(true);
  });

  it('honours an explicit threshold', () => {
    expect(canvasFitsGuides({ width: 500, height: 400 }, 640)).toBe(false);
  });
});

describe('stageWantsGuides', () => {
  it('draws guides on a full broadcast frame', () => {
    expect(stageWantsGuides({ width: 1920, height: 1080 })).toBe(true);
    expect(stageWantsGuides({ width: 1280, height: 720 })).toBe(true);
    expect(stageWantsGuides({ width: 3840, height: 2160 })).toBe(true);
  });

  it('leaves them off for an element-sized stage', () => {
    /*
     * The demo's `badge` is 120×40. `SAFE_AREAS` are fractions of the stage, so
     * title-safe there is 12px and action-safe 4px: three nested rectangles and
     * two center lines over something small enough that they obscure the thing
     * being designed, describing an inset nobody will honour — the badge is
     * composited into a corner rather than filling the frame.
     */
    expect(stageWantsGuides({ width: 120, height: 40 })).toBe(false);
  });

  it('treats a full-width strip as an element, because it is one', () => {
    // A 1920×120 ticker occupies the full raster width but is not the frame;
    // its own 10% inset is not the broadcast title-safe area.
    expect(stageWantsGuides({ width: 1920, height: 120 })).toBe(false);
  });

  it('requires both axes, not either', () => {
    expect(stageWantsGuides({ width: 640, height: 100 })).toBe(false);
    expect(stageWantsGuides({ width: 100, height: 480 })).toBe(false);
  });

  it('treats the threshold itself as a frame', () => {
    // Off-by-one at the boundary is the whole content of this function.
    expect(stageWantsGuides(MIN_BROADCAST_STAGE)).toBe(true);
    expect(
      stageWantsGuides({ width: MIN_BROADCAST_STAGE.width - 1, height: MIN_BROADCAST_STAGE.height }),
    ).toBe(false);
    expect(
      stageWantsGuides({ width: MIN_BROADCAST_STAGE.width, height: MIN_BROADCAST_STAGE.height - 1 }),
    ).toBe(false);
  });

  it('allows guides on a degenerate stage rather than flashing them off', () => {
    // Same call as `canvasFitsGuides` on an unmeasured canvas: default to
    // showing, so nothing appears a tick after load on a surface that did not
    // move.
    expect(stageWantsGuides({ width: 0, height: 0 })).toBe(true);
  });

  it('honours an explicit threshold', () => {
    expect(stageWantsGuides({ width: 800, height: 600 }, { width: 1920, height: 1080 })).toBe(false);
  });
});
