// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Stage viewport geometry — pure functions, no React.
 *
 * The stage is a fixed-size rectangle (1920×1080 and friends) shown inside a
 * panel of whatever size the device gives us, so every interesting number here
 * is a ratio between two boxes. The previous code carried a hardcoded 0.45
 * instead, which is only "fit" on a desktop-sized panel: on a tablet a 1920×1080
 * stage at 45% is 864×486 inside a panel a few hundred pixels wide, so the
 * preview was cropped and the Fit button put it back exactly where it was.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export const ZOOM_LIMITS = { min: 0.05, max: 4 } as const;

export function clampZoom(zoom: number, limits = ZOOM_LIMITS): number {
  if (!Number.isFinite(zoom)) return limits.min;
  return Math.min(limits.max, Math.max(limits.min, zoom));
}

/**
 * Narrowest viewport that still gets safe-area guides.
 *
 * The guides are drawn in *stage* coordinates and scaled down with everything
 * else, but their stroke is not — a 2px dashed rect stays 2px however far the
 * stage is zoomed out. Below roughly this width the stage is small enough that
 * three nested dashed rectangles plus two center lines cover more of the
 * artwork than they frame, and the panel becomes unusable for the thing it is
 * for. Wider than a phone, narrower than any real editing pane.
 */
export const MIN_GUIDE_CANVAS_WIDTH = 480;

/**
 * Is the viewport wide enough to be worth drawing guides on?
 *
 * An unmeasured canvas (width 0, before the ResizeObserver has run) counts as
 * wide enough. Treating it as too narrow would hide the guides on the first
 * frame of every load and then show them a tick later — a flash on a surface
 * where nothing has moved.
 */
export function canvasFitsGuides(canvas: Size, min = MIN_GUIDE_CANVAS_WIDTH): boolean {
  if (canvas.width <= 0) return true;
  return canvas.width >= min;
}

/**
 * Smallest stage that is plausibly a whole broadcast frame.
 *
 * Below the smallest SD raster in *either* axis, and the composition is an
 * element rather than a frame — a badge, a bug, a strap — placed somewhere on
 * someone else's raster by whoever composites it.
 */
export const MIN_BROADCAST_STAGE: Size = { width: 640, height: 480 };

/**
 * Should safe-area guides be on by default for this stage?
 *
 * Distinct from `canvasFitsGuides`, which asks whether the *panel* is wide
 * enough to draw them legibly — a transient fact about a splitter position.
 * This asks whether they mean anything for the *document*, which is a property
 * of the composition and does not change when someone drags a divider.
 *
 * `SAFE_AREAS` are fractions of the stage, and that arithmetic is only
 * meaningful when the stage *is* the broadcast raster. The demo's `badge` is
 * 120×40, where title-safe works out at 12px and action-safe at 4px: three
 * nested rectangles and two center lines drawn over an element small enough
 * that they obscure the thing being designed, describing an inset nobody will
 * ever honour, because the badge gets composited into a corner rather than
 * filling the frame.
 *
 * A default rather than a lock. An author may well want the center lines to
 * line something up inside a small element, and the checkbox stays live for
 * exactly that — this only decides where it starts.
 */
export function stageWantsGuides(stage: Size, min: Size = MIN_BROADCAST_STAGE): boolean {
  // An unset or degenerate stage gets guides, on the same argument as an
  // unmeasured canvas above: default to showing rather than to a flash.
  if (stage.width <= 0 || stage.height <= 0) return true;
  return stage.width >= min.width && stage.height >= min.height;
}

/**
 * Largest scale at which `stage` fits inside `canvas`, with `padding` pixels of
 * breathing room on every side.
 *
 * Returns `null` when the canvas has not been measured yet — a zero-size canvas
 * would otherwise produce a zoom of 0 on the first render, and the caller needs
 * to tell "not measured" from "measured and tiny" so it can leave the previous
 * zoom alone rather than collapsing the stage.
 */
export function fitZoom(
  canvas: Size,
  stage: Size,
  padding = 24,
  limits = ZOOM_LIMITS,
): number | null {
  if (canvas.width <= 0 || canvas.height <= 0) return null;
  if (stage.width <= 0 || stage.height <= 0) return null;

  const usableWidth = Math.max(1, canvas.width - padding * 2);
  const usableHeight = Math.max(1, canvas.height - padding * 2);

  return clampZoom(
    Math.min(usableWidth / stage.width, usableHeight / stage.height),
    limits,
  );
}

/**
 * Pan that keeps the stage point currently under `pointer` under it after the
 * zoom changes — the difference between zooming and teleporting.
 *
 * The stage is centered in the canvas by layout and then offset by `pan`, and it
 * scales about its own center, so that center sits at `center + pan` on screen
 * and a stage point `v` away from it lands at `center + pan + zoom·v`. Solving
 * for the pan that leaves `pointer` fixed:
 *
 *     v          = (pointer − center − pan) / zoom
 *     pan′       = pointer − center − nextZoom·v
 *                = (pointer − center)(1 − k) + k·pan,  k = nextZoom / zoom
 *
 * Anchoring matters most on touch: a pinch that ignores the gesture's midpoint
 * drifts the graphic out from under the fingers doing the pinching.
 */
export function zoomAtPoint(
  pan: Point,
  zoom: number,
  nextZoom: number,
  pointer: Point,
  centre: Point,
): Point {
  if (zoom <= 0) return pan;
  const k = nextZoom / zoom;
  return {
    x: (pointer.x - centre.x) * (1 - k) + k * pan.x,
    y: (pointer.y - centre.y) * (1 - k) + k * pan.y,
  };
}

/** Euclidean distance — the pinch gesture's only measurement. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * How far a touch may travel and still count as a tap rather than a pan.
 *
 * A finger never holds still, so without a threshold a tap meant to deselect
 * registers as a two-pixel pan and the selection never clears.
 */
export const TAP_SLOP_PX = 8;
