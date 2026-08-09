// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import {
  clampView,
  fitScale,
  fitView,
  formatTimecode,
  hitsRect,
  maxStart,
  moveLifetime,
  overflowHeight,
  pxToTime,
  trackWidth,
  trimIn,
  trimOut,
  type Lifetime,
  snapTime,
  snapToFrame,
  tickInterval,
  ticks,
  timeToPx,
  visibleRange,
  zoomAround,
  type SnapTarget,
  type TimelineView,
} from '../state/timeline-math.js';

const view: TimelineView = { start: 0, pxPerSecond: 200, width: 800 };

describe('conversion', () => {
  it('round-trips time through pixels', () => {
    for (const t of [0, 0.333, 1.5, 3.999]) {
      expect(pxToTime(view, timeToPx(view, t))).toBeCloseTo(t, 9);
    }
  });

  it('accounts for a scrolled start', () => {
    const scrolled: TimelineView = { ...view, start: 2 };
    expect(timeToPx(scrolled, 2)).toBe(0);
    expect(timeToPx(scrolled, 3)).toBe(200);
  });

  it('reports the visible range from width and scale', () => {
    expect(visibleRange(view)).toEqual({ from: 0, to: 4 });
  });
});

describe('zoom', () => {
  it('keeps the time under the anchor fixed', () => {
    const anchorPx = 300;
    const before = pxToTime(view, anchorPx);
    const zoomed = zoomAround(view, anchorPx, 2);
    expect(pxToTime(zoomed, anchorPx)).toBeCloseTo(before, 6);
  });

  it('respects zoom limits', () => {
    expect(zoomAround(view, 0, 100).pxPerSecond).toBe(4000);
    expect(zoomAround(view, 0, 0.0001).pxPerSecond).toBe(20);
  });

  it('never scrolls before zero', () => {
    expect(zoomAround({ ...view, start: 0.1 }, 700, 0.5).start).toBeGreaterThanOrEqual(0);
  });
});

describe('track gutter', () => {
  /*
   * Keyframes and markers are centered on their time, so content at t=0 reaches
   * left of the track area — where it is clipped and unclickable. The gutter
   * shifts the whole time axis right so the earliest content stays reachable.
   */
  const inset: TimelineView = { start: 0, pxPerSecond: 200, width: 800, inset: 10 };

  it('places t=0 at the gutter, not at the very edge', () => {
    expect(timeToPx(inset, 0)).toBe(10);
  });

  it('still round-trips time through pixels', () => {
    for (const t of [0, 0.5, 1.75, 3]) {
      expect(pxToTime(inset, timeToPx(inset, t))).toBeCloseTo(t, 9);
    }
  });

  it('leaves the earliest keyframe center inside the track area', () => {
    // A diamond is 11px wide, so its center must sit at least ~6px in.
    expect(timeToPx(inset, 0)).toBeGreaterThanOrEqual(6);
  });

  it('excludes the gutter from the usable width', () => {
    expect(trackWidth(inset)).toBe(790);
    expect(visibleRange(inset).to).toBeCloseTo(790 / 200, 9);
  });

  it('treats a view without a gutter as inset 0', () => {
    const none: TimelineView = { start: 0, pxPerSecond: 200, width: 800 };
    expect(timeToPx(none, 0)).toBe(0);
    expect(trackWidth(none)).toBe(800);
  });

  it('fits the composition into the usable width', () => {
    // 790 usable px over 2.4s, not 800 — otherwise the end falls off the edge.
    expect(fitScale(inset, 2.4)).toBeCloseTo(790 / 2.4, 6);
  });
});

describe('view clamping', () => {
  const DURATION = 2.4;

  it('forces start to 0 when the whole composition fits', () => {
    // 900px at 240px/s shows 3.75s — more than the composition, so there is
    // nowhere to scroll.
    const clamped = clampView({ start: 0.75, pxPerSecond: 240, width: 900 }, DURATION);
    expect(clamped.start).toBe(0);
  });

  it('allows scrolling when zoomed in past the composition length', () => {
    const zoomed: TimelineView = { start: 1, pxPerSecond: 2000, width: 900 };
    expect(clampView(zoomed, DURATION).start).toBe(1);
  });

  it('stops the view scrolling past the end', () => {
    const zoomed: TimelineView = { start: 99, pxPerSecond: 2000, width: 900 };
    // 900px at 2000px/s shows 0.45s, so the furthest start is 2.4 - 0.45.
    expect(clampView(zoomed, DURATION).start).toBeCloseTo(DURATION - 0.45, 6);
  });

  it('never allows a negative start', () => {
    expect(clampView({ start: -5, pxPerSecond: 240, width: 900 }, DURATION).start).toBe(0);
  });

  it('returns the same object when nothing needs clamping', () => {
    const view: TimelineView = { start: 0, pxPerSecond: 240, width: 900 };
    expect(clampView(view, DURATION)).toBe(view);
  });

  it('reports no scroll room when the composition fits on screen', () => {
    expect(maxStart({ start: 0, pxPerSecond: 240, width: 900 }, DURATION)).toBe(0);
  });

  it('makes zoom out then zoom in a round trip', () => {
    /*
     * Regression: zoomAround clamps start at 0, so zooming out from the left
     * edge discarded the anchor while zooming back in still honoured it —
     * leaving the view scrolled right, with keyframes painting over the layer
     * names. Clamping to the content closes the loop.
     */
    const start: TimelineView = { start: 0, pxPerSecond: 240, width: 900 };

    let view = clampView(zoomAround(start, start.width / 2, 1 / 1.4), DURATION);
    view = clampView(zoomAround(view, view.width / 2, 1.4), DURATION);

    expect(view.pxPerSecond).toBeCloseTo(start.pxPerSecond, 6);
    expect(view.start).toBe(0);
  });

  it('survives repeated zoom cycles without drifting', () => {
    let view: TimelineView = { start: 0, pxPerSecond: 240, width: 900 };
    for (let i = 0; i < 12; i++) {
      view = clampView(zoomAround(view, view.width / 2, 1 / 1.4), DURATION);
      view = clampView(zoomAround(view, view.width / 2, 1.4), DURATION);
    }
    expect(view.start).toBe(0);
    expect(view.pxPerSecond).toBeCloseTo(240, 4);
  });

  it('keeps the anchored time under the cursor while there is room to scroll', () => {
    // Zoom anchoring should still work normally away from the boundary.
    const view: TimelineView = { start: 1, pxPerSecond: 2000, width: 900 };
    const anchorPx = 400;
    const before = pxToTime(view, anchorPx);
    const zoomed = clampView(zoomAround(view, anchorPx, 1.2), 60);
    expect(pxToTime(zoomed, anchorPx)).toBeCloseTo(before, 6);
  });
});

describe('ruler ticks', () => {
  it('picks a readable interval from the 1/2/5 progression', () => {
    expect(tickInterval(200)).toBe(0.5);
    expect(tickInterval(20)).toBe(5);
    expect(tickInterval(2000)).toBe(0.05);
  });

  it('spaces ticks at least the minimum pixels apart', () => {
    for (const pxPerSecond of [25, 60, 200, 900, 3000]) {
      expect(tickInterval(pxPerSecond, 64) * pxPerSecond).toBeGreaterThanOrEqual(64);
    }
  });

  it('emits ticks across the visible range only', () => {
    const list = ticks({ start: 1, pxPerSecond: 200, width: 400 });
    expect(list[0]).toBeGreaterThanOrEqual(1);
    expect(list[list.length - 1]!).toBeLessThanOrEqual(3.0001);
  });

  it('does not accumulate float drift across a long timeline', () => {
    const list = ticks({ start: 0, pxPerSecond: 100, width: 6000 });
    for (const t of list) {
      // Every tick should be a clean multiple, not 12.000000000000002.
      expect(Math.abs(t * 1000 - Math.round(t * 1000))).toBeLessThan(1e-6);
    }
  });
});

describe('snapping', () => {
  const fps = 60;

  it('falls back to frame snapping when nothing is near', () => {
    const { time, snappedTo } = snapTime(1.008, [], view, fps);
    expect(snappedTo).toBeNull();
    expect(time).toBeCloseTo(snapToFrame(1.008, fps), 9);
  });

  it('prefers a nearby marker over the frame grid', () => {
    const targets: SnapTarget[] = [{ time: 1.5, source: 'marker' }];
    const { time, snappedTo } = snapTime(1.51, targets, view, fps);
    expect(snappedTo?.source).toBe('marker');
    expect(time).toBe(1.5);
  });

  it('ignores candidates beyond the pixel threshold', () => {
    const targets: SnapTarget[] = [{ time: 1.5, source: 'marker' }];
    // 0.2s at 200px/s is 40px away, well past the 8px threshold.
    expect(snapTime(1.7, targets, view, fps).snappedTo).toBeNull();
  });

  it('picks the closest of several candidates', () => {
    const targets: SnapTarget[] = [
      { time: 1.49, source: 'keyframe' },
      { time: 1.51, source: 'marker' },
    ];
    expect(snapTime(1.505, targets, view, fps).snappedTo?.source).toBe('marker');
  });

  it('threshold is in pixels, so zooming in makes snapping more precise', () => {
    const targets: SnapTarget[] = [{ time: 1.5, source: 'marker' }];
    const zoomedIn: TimelineView = { ...view, pxPerSecond: 4000 };
    // 0.02s is 8px at 400px/s but 80px at 4000px/s.
    expect(snapTime(1.52, targets, view, fps).snappedTo).not.toBeNull();
    expect(snapTime(1.52, targets, zoomedIn, fps).snappedTo).toBeNull();
  });

  it('never returns a negative time', () => {
    expect(snapTime(-3, [], view, fps).time).toBe(0);
  });
});

describe('frames', () => {
  it('snaps to whole frames', () => {
    expect(snapToFrame(0.51, 60)).toBeCloseTo(31 / 60, 9);
    expect(snapToFrame(0.51, 25)).toBeCloseTo(13 / 25, 9);
  });

  it('formats broadcast timecode', () => {
    expect(formatTimecode(0, 60)).toBe('00:00:00');
    expect(formatTimecode(1.5, 60)).toBe('00:01:30');
    expect(formatTimecode(61.5, 60)).toBe('01:01:30');
  });
});

describe('layer lifetimes', () => {
  const FPS = 60;
  const DURATION = 2.4;
  const frame = 1 / FPS;

  describe('moveLifetime', () => {
    it('slides both edges by the same amount', () => {
      expect(moveLifetime({ in: 1, out: 2 }, 0.5)).toEqual({ in: 1.5, out: 2.5 });
    });

    it('keeps an open-ended layer open-ended', () => {
      // `out: undefined` means "runs to the end" — a real state, not a gap.
      expect(moveLifetime({ in: 1, out: undefined }, 0.5)).toEqual({ in: 1.5, out: undefined });
    });

    it('clamps at zero without stretching the layer', () => {
      /*
       * The out-point moves by however far the in-point actually moved. Moving
       * it by the requested delta instead would pin the start at 0 while the
       * end kept traveling, silently changing the layer's length.
       */
      expect(moveLifetime({ in: 0.5, out: 1.5 }, -2)).toEqual({ in: 0, out: 1 });
    });

    it('is reversible away from the boundary', () => {
      // Within float tolerance, not exactly: 1 + 0.4 - 0.4 is 0.9999999999999999.
      // The component rounds before dispatching, so nothing that drifty reaches
      // the document — but the arithmetic itself must not be asserted as exact.
      const start = { in: 1, out: 2 };
      const round = moveLifetime(moveLifetime(start, 0.4), -0.4);
      expect(round.in).toBeCloseTo(start.in, 9);
      expect(round.out!).toBeCloseTo(start.out, 9);
    });

    it('survives many small moves without accumulating visible drift', () => {
      let life: Lifetime = { in: 1, out: 2 };
      for (let i = 0; i < 200; i++) life = moveLifetime(life, i % 2 ? -0.05 : 0.05);
      expect(life.in).toBeCloseTo(1, 6);
      expect(life.out!).toBeCloseTo(2, 6);
    });

    /*
     * The reported bug: grabbing a lifetime bar and dragging it changed the
     * layer's length instead of moving it.
     *
     * A layer created without an explicit out-point runs to the end of the
     * composition, which is the common case — so with only the in-point moving,
     * the right edge stayed pinned to the end and the window stretched or shrank
     * on nearly every drag. Given the duration, both edges travel together.
     */
    describe('given the composition duration', () => {
      it('preserves the length of an open-ended layer', () => {
        // 1s → end(4s) is a 3s window; moved left by 1s it must still be 3s.
        expect(moveLifetime({ in: 1, out: undefined }, -1, 4)).toEqual({ in: 0, out: 3 });
      });

      it('does not stretch when clamped at zero', () => {
        const moved = moveLifetime({ in: 1, out: undefined }, -99, 4);
        expect(moved).toEqual({ in: 0, out: 3 });
      });

      it('clamps at the far end rather than running past it', () => {
        // Clamping one edge while the other keeps traveling is the same
        // stretch in mirror image.
        expect(moveLifetime({ in: 1, out: 2 }, 99, 4)).toEqual({ in: 3, out: 4 });
      });

      it('cannot move a layer that already fills the composition', () => {
        const full: Lifetime = { in: 0, out: undefined };
        expect(moveLifetime(full, 1, 4)).toBe(full);
        expect(moveLifetime(full, -1, 4)).toBe(full);
      });

      it('leaves an unmoved window untouched rather than materialising an out-point', () => {
        // A click that does not drag must not turn "runs to the end" into an
        // explicit end time.
        const open: Lifetime = { in: 1, out: undefined };
        expect(moveLifetime(open, 0, 4)).toBe(open);
      });

      it('keeps the length of an explicit window through a round trip', () => {
        const start: Lifetime = { in: 1, out: 2.5 };
        const there = moveLifetime(start, 0.5, 4);
        const back = moveLifetime(there, -0.5, 4);
        expect(there.out! - there.in).toBeCloseTo(1.5, 9);
        expect(back.in).toBeCloseTo(start.in, 9);
        expect(back.out!).toBeCloseTo(start.out!, 9);
      });
    });
  });

  describe('trimIn', () => {
    it('moves only the in-point', () => {
      expect(trimIn({ in: 1, out: 2 }, 1.5, FPS, DURATION)).toEqual({ in: 1.5, out: 2 });
    });

    it('never crosses the out-point', () => {
      // An inverted window fails schema validation on save.
      const result = trimIn({ in: 1, out: 2 }, 5, FPS, DURATION);
      expect(result.in).toBeCloseTo(2 - frame, 6);
      expect(result.in).toBeLessThan(result.out!);
    });

    it('uses the composition end as the limit for an open-ended layer', () => {
      const result = trimIn({ in: 1, out: undefined }, 99, FPS, DURATION);
      expect(result.in).toBeCloseTo(DURATION - frame, 6);
    });

    it('never goes negative', () => {
      expect(trimIn({ in: 1, out: 2 }, -5, FPS, DURATION).in).toBe(0);
    });
  });

  describe('trimOut', () => {
    it('moves only the out-point', () => {
      expect(trimOut({ in: 1, out: 2 }, 1.8, FPS, DURATION)).toEqual({ in: 1, out: 1.8 });
    });

    it('never crosses the in-point', () => {
      const result = trimOut({ in: 1, out: 2 }, 0, FPS, DURATION);
      expect(result.out).toBeCloseTo(1 + frame, 6);
      expect(result.out!).toBeGreaterThan(result.in);
    });

    it('does not extend past the composition', () => {
      expect(trimOut({ in: 1, out: 2 }, 99, FPS, DURATION).out).toBe(DURATION);
    });

    it('gives an open-ended layer a concrete out-point', () => {
      expect(trimOut({ in: 1, out: undefined }, 2, FPS, DURATION).out).toBe(2);
    });
  });

  it('recovers a layer stranded at the end of the timeline', () => {
    // The reported case: added while the playhead sat near the end, so its
    // window began at 2.3s with no way back short of the properties panel.
    const stranded: Lifetime = { in: 2.3, out: undefined };
    expect(moveLifetime(stranded, -99)).toEqual({ in: 0, out: undefined });
  });
});

describe('rubber-band selection', () => {
  it('hits points inside the rectangle', () => {
    expect(hitsRect({ x: 10, y: 10, width: 100, height: 50 }, 50, 30)).toBe(true);
    expect(hitsRect({ x: 10, y: 10, width: 100, height: 50 }, 5, 30)).toBe(false);
  });

  it('handles a rectangle dragged up and to the left', () => {
    // Negative width/height must still select, or dragging one way silently fails.
    expect(hitsRect({ x: 110, y: 60, width: -100, height: -50 }, 50, 30)).toBe(true);
  });
});

describe('fitView', () => {
  const DURATION = 2.4;
  const view: TimelineView = { start: 0.9, pxPerSecond: 240, width: 800, inset: 10 };

  it('scrolls home and scales so the composition ends at the right edge', () => {
    const fitted = fitView(view, DURATION);
    expect(fitted.start).toBe(0);
    expect(visibleRange(fitted).to).toBeCloseTo(DURATION, 9);
  });

  it('leaves nothing to scroll to — which is the definition of fitted', () => {
    // The property the Fit button actually promises. If maxStart is above zero
    // there is off-screen content and the panel will show a scrollbar.
    expect(maxStart(fitView(view, DURATION), DURATION)).toBe(0);
  });

  it('takes a freshly measured width, overriding the one in the view', () => {
    /*
     * The bug this argument exists for. Fit removes the vertical scrollbar,
     * which hands the track column ~15px more width — but `view.width` still
     * holds the pre-Fit measurement until the ResizeObserver catches up. Fitting
     * to the stale number left the composition overhanging the right edge, so a
     * horizontal scrollbar appeared under a timeline that had just been told to
     * fit. The caller re-measures and passes the result in.
     */
    const fitted = fitView(view, DURATION, 815);
    expect(fitted.width).toBe(815);
    expect(visibleRange(fitted).to).toBeCloseTo(DURATION, 9);
    expect(maxStart(fitted, DURATION)).toBe(0);
  });

  it('still ends at the edge when the column got narrower instead', () => {
    const fitted = fitView(view, DURATION, 400);
    expect(visibleRange(fitted).to).toBeCloseTo(DURATION, 9);
    expect(maxStart(fitted, DURATION)).toBe(0);
  });

  it('accounts for the gutter', () => {
    // 790 usable of 800, not 800 — same rule fitScale follows.
    expect(fitView(view, DURATION).pxPerSecond).toBeCloseTo(790 / DURATION, 6);
  });
});

describe('overflowHeight', () => {
  it('reports how much taller the panel must be', () => {
    expect(overflowHeight(420, 280)).toBe(140);
  });

  it('is zero when everything already fits', () => {
    expect(overflowHeight(200, 280)).toBe(0);
    expect(overflowHeight(280, 280)).toBe(0);
  });

  it('rounds a fractional shortfall up', () => {
    // Sub-pixel content still shows a scrollbar, so growing by the floor of the
    // shortfall would leave one behind for the sake of half a pixel.
    expect(overflowHeight(280.4, 280)).toBe(1);
  });

  it('survives an unmeasured element', () => {
    expect(overflowHeight(Number.NaN, 280)).toBe(0);
  });
});
