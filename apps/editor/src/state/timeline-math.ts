// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Timeline geometry — pure functions, no React.
 *
 * Time↔pixel conversion, ruler tick selection and snapping all have exact
 * answers, so they are kept out of the components where they would only be
 * reachable through a rendered DOM.
 */

export interface TimelineView {
  /** Seconds at the left edge of the usable track area. */
  start: number;
  /** Pixels per second. */
  pxPerSecond: number;
  /** Width of the track area in pixels. */
  width: number;
  /**
   * Left gutter in pixels before `start` is drawn.
   *
   * Keyframe diamonds and markers are centered on their time, so anything at
   * t=0 extends half its width to the *left* of the track area — hanging over
   * the layer-name column, where it is both clipped and unclickable. The
   * gutter keeps the earliest content fully inside the track area.
   */
  inset?: number;
}

const insetOf = (view: TimelineView): number => view.inset ?? 0;

/** Usable drawing width, excluding the gutter. */
export function trackWidth(view: TimelineView): number {
  return Math.max(0, view.width - insetOf(view));
}

export function timeToPx(view: TimelineView, time: number): number {
  return (time - view.start) * view.pxPerSecond + insetOf(view);
}

export function pxToTime(view: TimelineView, px: number): number {
  return view.start + (px - insetOf(view)) / view.pxPerSecond;
}

export function visibleRange(view: TimelineView): { from: number; to: number } {
  return { from: view.start, to: view.start + trackWidth(view) / view.pxPerSecond };
}

/** Zoom about a fixed pixel position, so the time under the cursor stays put. */
export function zoomAround(
  view: TimelineView,
  anchorPx: number,
  factor: number,
  limits = { min: 20, max: 4000 },
): TimelineView {
  const anchorTime = pxToTime(view, anchorPx);
  const pxPerSecond = Math.min(limits.max, Math.max(limits.min, view.pxPerSecond * factor));
  return { ...view, pxPerSecond, start: Math.max(0, anchorTime - anchorPx / pxPerSecond) };
}

/**
 * Furthest right the view may scroll: far enough to bring the end of the
 * composition to the right edge, and no further.
 */
export function maxStart(view: TimelineView, duration: number): number {
  const visibleSeconds = trackWidth(view) / view.pxPerSecond;
  return Math.max(0, duration - visibleSeconds);
}

/** Scale that fits `duration` exactly into the usable track width. */
export function fitScale(view: TimelineView, duration: number): number {
  return trackWidth(view) / Math.max(0.1, duration);
}

/**
 * The whole view after a Fit: scrolled home, scaled so the composition ends at
 * the right edge.
 *
 * A function rather than two statements at the call site because "fitted" is a
 * property of the *pair* — a scale computed from one width and then applied to
 * a view holding another leaves the composition slightly over or under the edge,
 * which is exactly how Fit ended up producing a horizontal scrollbar. Passing
 * the freshly measured width through here makes the mismatch unrepresentable.
 */
export function fitView(view: TimelineView, duration: number, width = view.width): TimelineView {
  const sized = { ...view, width };
  return { ...sized, start: 0, pxPerSecond: fitScale(sized, duration) };
}

/**
 * Extra panel height needed to show every row without scrolling.
 *
 * Measured from the scrollport rather than computed from a row count and a row
 * height, because the row height is a CSS variable that changes at the small
 * breakpoint — a constant here would be right on a desktop and wrong on a
 * tablet, and wrong in the direction that leaves a scrollbar behind.
 *
 * Rounded up: a fractional shortfall still shows a scrollbar.
 */
export function overflowHeight(scrollHeight: number, clientHeight: number): number {
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) return 0;
  return Math.max(0, Math.ceil(scrollHeight - clientHeight));
}

/**
 * Keep the view inside the composition.
 *
 * This is what makes zoom invertible. `zoomAround` preserves the time under
 * the anchor and then clamps `start` at 0 — so zooming out from the left edge
 * hits the clamp and quietly discards the anchor, while zooming back in has
 * room to scroll right and honours an anchor that no longer corresponds to
 * anything. Out and in stopped being inverses, and the view drifted right a
 * little further on every cycle.
 *
 * Bounding `start` by the content fixes it: once the whole composition fits on
 * screen there is nowhere to scroll, so `start` is forced back to 0 and the
 * round trip closes. It also stops the timeline scrolling off into empty space
 * past the end.
 */
export function clampView(view: TimelineView, duration: number): TimelineView {
  const start = Math.min(Math.max(0, view.start), maxStart(view, duration));
  return start === view.start ? view : { ...view, start };
}

/**
 * Ruler tick interval: the smallest "nice" step whose spacing is at least
 * `minPx`. Without the 1/2/5 progression the ruler ends up labeled at
 * intervals like 0.37s, which nobody can read.
 */
export const TICK_STEPS = [
  0.01, 0.02, 0.05,
  0.1, 0.2, 0.25, 0.5,
  1, 2, 5, 10, 15, 30, 60,
];

export function tickInterval(pxPerSecond: number, minPx = 64): number {
  for (const step of TICK_STEPS) {
    if (step * pxPerSecond >= minPx) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1]!;
}

export function ticks(view: TimelineView, minPx = 64): number[] {
  const interval = tickInterval(view.pxPerSecond, minPx);
  const { from, to } = visibleRange(view);
  const first = Math.ceil(from / interval) * interval;
  const out: number[] = [];
  for (let t = first; t <= to + 1e-9; t += interval) {
    // Re-round each step: accumulating a float interval drifts visibly by the
    // right-hand edge of a long timeline.
    out.push(Math.round(t / interval) * interval);
  }
  return out;
}

/** Frame duration for a composition, used for frame-accurate snapping. */
export function frameDuration(fps: number): number {
  return 1 / Math.max(1, fps);
}

export function snapToFrame(time: number, fps: number): number {
  const frame = frameDuration(fps);
  return Math.round(time / frame) * frame;
}

export interface SnapTarget {
  time: number;
  /** What the time belongs to, for highlighting the snap in the UI. */
  source: 'frame' | 'marker' | 'keyframe' | 'playhead' | 'start' | 'end';
}

/**
 * Snap `time` to the nearest candidate within `thresholdPx`.
 *
 * Frame snapping is applied as a fallback rather than a candidate: it should
 * never beat a marker or a sibling keyframe, but it should always apply when
 * nothing else is near, so dragged keyframes land on whole frames.
 */
export function snapTime(
  time: number,
  candidates: SnapTarget[],
  view: TimelineView,
  fps: number,
  thresholdPx = 8,
): { time: number; snappedTo: SnapTarget | null } {
  let best: SnapTarget | null = null;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const distance = Math.abs(timeToPx(view, candidate.time) - timeToPx(view, time));
    if (distance <= thresholdPx && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  if (best) return { time: best.time, snappedTo: best };
  return { time: Math.max(0, snapToFrame(time, fps)), snappedTo: null };
}

/** Format seconds for the ruler and readouts: `m:ss.mmm`, or `s.mmm` under a minute. */
export function formatTime(seconds: number, showMinutes = false): string {
  const clamped = Math.max(0, seconds);
  if (!showMinutes && clamped < 60) return `${clamped.toFixed(3)}s`;
  const m = Math.floor(clamped / 60);
  const s = clamped - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/** Time and frame number together — what a broadcast operator actually reads. */
export function formatTimecode(seconds: number, fps: number): string {
  const frame = Math.round(seconds * fps);
  const totalSeconds = Math.floor(frame / fps);
  const frames = frame % Math.round(fps);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

/* ------------------------------------------------------- layer lifetimes */

/**
 * A layer's in/out window. `out: undefined` means "runs to the end of the
 * composition" — a real state, not a missing value, so it has to survive every
 * edit rather than being silently resolved to a number.
 */
export interface Lifetime {
  in: number;
  out: number | undefined;
}

/**
 * Slide a whole lifetime along the timeline.
 *
 * The out-point moves by however much the in-point *actually* moved, not by the
 * requested delta — otherwise dragging a layer left into the 0 boundary would
 * clamp its start while its end kept traveling, quietly stretching it.
 *
 * `duration` resolves an open-ended window. Without it, `out: undefined` stays
 * undefined and only the in-point moves — which is a *stretch*, not a move: the
 * right edge is pinned to the end of the composition, so dragging the bar left
 * lengthened the layer and dragging it right shortened it. Since a layer created
 * without an explicit out-point is the common case, that was what most drags
 * did. Passing the composition duration materialises the out-point at the end
 * and slides both edges together, which is what grabbing the middle of a bar is
 * asking for.
 *
 * The move is also clamped at the far end, not just at zero. Clamping one edge
 * while the other kept traveling is the same stretch in mirror image, so the
 * applied delta is bounded by whichever edge runs out of room first.
 */
export function moveLifetime(
  start: Lifetime,
  deltaSeconds: number,
  duration?: number,
): Lifetime {
  // The effective right edge: an explicit out-point, else the end of the
  // composition when we have been told where that is.
  const end = start.out ?? duration;

  let applied = Math.max(deltaSeconds, -start.in);
  if (end !== undefined && duration !== undefined) {
    applied = Math.min(applied, duration - end);
  }

  // Nothing moved: hand back the original window rather than materialising an
  // out-point for a gesture that had no effect.
  if (applied === 0) return start;

  return {
    in: start.in + applied,
    out: end === undefined ? undefined : end + applied,
  };
}

/** Drag the left edge. Cannot cross the out-point, or pass zero. */
export function trimIn(start: Lifetime, time: number, fps: number, duration: number): Lifetime {
  const limit = (start.out ?? duration) - frameDuration(fps);
  return { ...start, in: Math.min(Math.max(0, time), Math.max(0, limit)) };
}

/**
 * Drag the right edge. Cannot cross the in-point — the schema requires
 * `out > in`, so an inverted window would fail validation on save.
 */
export function trimOut(start: Lifetime, time: number, fps: number, duration: number): Lifetime {
  const floor = start.in + frameDuration(fps);
  return { ...start, out: Math.max(floor, Math.min(time, duration)) };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Rubber-band selection: does a keyframe at (px, laneY) fall inside `rect`? */
export function hitsRect(rect: Rect, px: number, laneY: number): boolean {
  const left = Math.min(rect.x, rect.x + rect.width);
  const right = Math.max(rect.x, rect.x + rect.width);
  const top = Math.min(rect.y, rect.y + rect.height);
  const bottom = Math.max(rect.y, rect.y + rect.height);
  return px >= left && px <= right && laneY >= top && laneY <= bottom;
}
