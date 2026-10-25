// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The on-stage bezier surface — the arithmetic half (MASKS.md §5.1, D′).
 *
 * `path-geometry.ts` edits a path; this decides *which* path a selected layer
 * offers to the stage, where its anchors and handles are drawn, and what a
 * pointer at a given place on screen means in the path's own coordinates. Pure
 * functions again, for the same reason as there and in `stage-math.ts`: every
 * defect this stage has shipped was a wrong number, and a wrong number is only
 * cheap to find when it can be computed without a browser.
 *
 * **Coordinates.** Three spaces meet here:
 *
 * - *layer space* — the layer's own pixels, origin at its box's top-left. Path
 *   data is authored here: a path shape's `<svg>` has no viewBox, and a
 *   `userSpaceOnUse` mask resolves here too.
 * - *stage space* — the composition's pixels. The handle overlay is drawn here,
 *   inside `.stage-transform`, beside `.stage-guides`.
 * - *client space* — the pointer.
 *
 * Every mapping is an affine matrix the browser already knows:
 * `getScreenCTM()` on an `<svg>` whose user space is layer space, and on the
 * overlay `<svg>` whose user space is stage space. Composing them carries the
 * layer's GSAP transform — translate, rotate, scale, skew — the stage zoom and
 * the pan, all at once and exactly, with none of it re-derived here. That holds
 * only while every `.bz-layer` sits at `left: 0; top: 0`, which `styles.ts`
 * notes beside the rule.
 */

import type { Layer, LayerMask, ShapeLayer } from '@breeze/schema';

import {
  insertPoint,
  moveHandle,
  movePoint,
  removePoint,
  smoothPoint,
  straightenPoint,
  type EditablePath,
  type Point,
} from './path-geometry.js';

/* ------------------------------------------------------------- matrices */

/** A 2D affine matrix in the SVG/DOMMatrix `a b c d e f` layout. */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function apply(m: Affine, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/**
 * `m` then `n`: the matrix for applying `m` first.
 *
 * Not called `then`, whatever reads most naturally: a module that exports
 * `then` is a thenable, so `await import()` of it calls the export as if it
 * were a promise's `then`, gets a matrix back, and never resolves. That hung
 * vitest's collection of this file with no error at all.
 */
export function compose(m: Affine, n: Affine): Affine {
  return {
    a: n.a * m.a + n.c * m.b,
    b: n.b * m.a + n.d * m.b,
    c: n.a * m.c + n.c * m.d,
    d: n.b * m.c + n.d * m.d,
    e: n.a * m.e + n.c * m.f + n.e,
    f: n.b * m.e + n.d * m.f + n.f,
  };
}

/**
 * Inverse, or null for a matrix that flattens the plane.
 *
 * A layer at scale 0 — mid-way through a scale-in, say — has no inverse: every
 * point of it is on one spot, so there is no answer to "which layer point is
 * under the pointer". The caller shows no handles rather than dividing by zero
 * and drawing them at infinity.
 */
export function invert(m: Affine): Affine | null {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

/**
 * Layer space → stage space, from the two screen CTMs.
 *
 * `layerToScreen` then the inverse of `stageToScreen`. Null when either is
 * missing (a hidden layer has no CTM) or the stage matrix is singular.
 */
export function layerToStage(layerToScreen: Affine | null, stageToScreen: Affine | null): Affine | null {
  if (!layerToScreen || !stageToScreen) return null;
  const screenToStage = invert(stageToScreen);
  return screenToStage ? compose(layerToScreen, screenToStage) : null;
}

/* ---------------------------------------------------------- which path */

/** The path a selected layer offers to the stage. */
export interface PathTarget {
  /** A path shape's own geometry, or the layer's path mask. */
  kind: 'shape' | 'mask';
  d: string;
  /**
   * Where `d`'s origin sits in layer space. Zero for a shape; the mask's
   * `x`/`y` for a mask, which the runtime applies as a translate rather than
   * baking into the data (mask.ts) — so dragging has to take it off again on
   * the way back, or every drag would add the offset twice.
   */
  offset: Point;
}

/** Which path editors this layer has: a path shape, a path mask, or both. */
export function pathTargets(layer: Layer | null): PathTarget[] {
  if (!layer) return [];
  const out: PathTarget[] = [];
  if (layer.type === 'shape' && (layer as ShapeLayer).shape === 'path' && (layer as ShapeLayer).path) {
    out.push({ kind: 'shape', d: (layer as ShapeLayer).path!, offset: { x: 0, y: 0 } });
  }
  const mask = (layer as { mask?: LayerMask }).mask;
  if (mask?.type === 'path' && mask.path) {
    out.push({ kind: 'mask', d: mask.path, offset: { x: mask.x || 0, y: mask.y || 0 } });
  }
  return out;
}

/**
 * The patch that writes `d` back to where it came from.
 *
 * The mask is replaced whole, spread from the current one, because `patchLayer`
 * is a shallow merge: patching `{ mask: { path } }` alone would drop the
 * mask's type, feather and invert.
 */
export function pathPatch(layer: Layer, kind: PathTarget['kind'], d: string): Partial<Layer> {
  if (kind === 'shape') return { path: d } as Partial<Layer>;
  const mask = (layer as { mask?: LayerMask }).mask;
  return { mask: { ...(mask as LayerMask), path: d } } as Partial<Layer>;
}

/* ------------------------------------------------------------ drawing */

export interface OverlayAnchor {
  index: number;
  at: Point;
  smooth: boolean;
  in?: Point;
  out?: Point;
}

export interface OverlaySegment {
  /** Index of the anchor the segment leaves. */
  after: number;
  from: Point;
  to: Point;
}

export interface OverlayModel {
  anchors: OverlayAnchor[];
  /**
   * Straight segments only — the ones `insertPoint` will split. A curve gets no
   * insert target at all, rather than one that silently refuses: splitting a
   * curve without de Casteljau would change the shape under the cursor.
   */
  straight: OverlaySegment[];
}

/** Everything the overlay draws, in stage space. */
export function overlayModel(path: EditablePath, offset: Point, toStage: Affine): OverlayModel {
  const map = (p: Point): Point => apply(toStage, { x: p.x + offset.x, y: p.y + offset.y });
  const anchors = path.points.map((p, index) => ({
    index,
    at: map(p),
    smooth: Boolean(p.in || p.out),
    ...(p.in ? { in: map(p.in) } : {}),
    ...(p.out ? { out: map(p.out) } : {}),
  }));

  const straight: OverlaySegment[] = [];
  const n = path.points.length;
  const count = path.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const from = path.points[i]!;
    const to = path.points[(i + 1) % n]!;
    if (!from.out && !to.in) straight.push({ after: i, from: map(from), to: map(to) });
  }
  return { anchors, straight };
}

/* ------------------------------------------------------------ gestures */

/** What the pointer went down on. */
export type Grab = { part: 'anchor'; index: number } | { part: 'in' | 'out'; index: number };

/** Where a grabbed part sits in path space (before the offset). */
export function grabbedPoint(path: EditablePath, grab: Grab): Point | null {
  const p = path.points[grab.index];
  if (!p) return null;
  if (grab.part === 'anchor') return { x: p.x, y: p.y };
  return p[grab.part] ?? null;
}

/**
 * The frozen start of a drag.
 *
 * Everything a move needs is captured at pointer-down and every move is
 * recomputed from it — never from the previous move — so a long drag cannot
 * accumulate rounding drift. The pointer's offset from the grabbed point is
 * kept too: grabbing a 10px anchor 3px off centre must not make it jump 3px on
 * the first move.
 */
export interface PathDrag {
  grab: Grab;
  start: EditablePath;
  /** Client → path space, as it was when the drag began. */
  clientToPath: Affine;
  /** Grabbed point minus the pointer, in path space. */
  grabOffset: Point;
}

/**
 * Begin a drag, or null when the part does not exist or the layer has no
 * inverse. `layerToScreen` is the layer's screen CTM; `offset` the target's.
 */
export function beginPathDrag(
  path: EditablePath,
  grab: Grab,
  offset: Point,
  layerToScreen: Affine,
  pointer: Point,
): PathDrag | null {
  const grabbed = grabbedPoint(path, grab);
  const screenToLayer = invert(layerToScreen);
  if (!grabbed || !screenToLayer) return null;
  // Layer space minus the target's offset is path space.
  const clientToPath = compose(screenToLayer, { ...IDENTITY, e: -offset.x, f: -offset.y });
  const under = apply(clientToPath, pointer);
  return {
    grab,
    start: path,
    clientToPath,
    grabOffset: { x: grabbed.x - under.x, y: grabbed.y - under.y },
  };
}

/** Rounded to a tenth, matching what `serializePath` writes. */
function tenth(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The path with the grabbed part under `pointer`.
 *
 * **Always returns a path, including when the pointer is back where it
 * started.** A move that lands on the origin must still be dispatched: a guard
 * comparing against the frozen start cannot tell "has not moved" from "moved
 * and came back", and the second case left the timeline's lifetime bar stranded
 * on the last position dragged to (0.41). The reducer already refuses a
 * genuine no-op without consuming an undo slot, so there is nothing to save by
 * skipping it here.
 */
export function dragPathTo(drag: PathDrag, pointer: Point): EditablePath {
  const under = apply(drag.clientToPath, pointer);
  const to = { x: tenth(under.x + drag.grabOffset.x), y: tenth(under.y + drag.grabOffset.y) };
  const { grab } = drag;
  return grab.part === 'anchor'
    ? movePoint(drag.start, grab.index, to)
    : moveHandle(drag.start, grab.index, grab.part, to);
}

/** Double-click on an anchor: a corner becomes a curve and a curve a corner. */
export function toggleSmooth(path: EditablePath, index: number): EditablePath {
  const p = path.points[index];
  if (!p) return path;
  return p.in || p.out ? straightenPoint(path, index) : smoothPoint(path, index);
}

/** Alt-click on an anchor. `removePoint` keeps the last two, so a path never collapses. */
export function removeAnchor(path: EditablePath, index: number): EditablePath {
  return removePoint(path, index);
}

/**
 * Double-click on a straight segment: a new anchor where the pointer is,
 * projected onto the segment so it lands exactly on the line rather than a
 * pixel or two beside it — which would bend a straight edge the author was
 * only trying to split.
 */
export function insertOnSegment(
  path: EditablePath,
  after: number,
  offset: Point,
  layerToScreen: Affine,
  pointer: Point,
): EditablePath {
  const from = path.points[after];
  const to = path.points[after + 1] ?? (path.closed ? path.points[0] : undefined);
  const screenToLayer = invert(layerToScreen);
  if (!from || !to || !screenToLayer) return path;

  const layer = apply(screenToLayer, pointer);
  const p = { x: layer.x - offset.x, y: layer.y - offset.y };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0.5 : Math.min(1, Math.max(0, ((p.x - from.x) * dx + (p.y - from.y) * dy) / len2));
  return insertPoint(path, after, { x: tenth(from.x + dx * t), y: tenth(from.y + dy * t) });
}

