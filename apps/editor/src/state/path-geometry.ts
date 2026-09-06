// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Bezier path editing — the pure half of the pen tool (MASKS.md §5).
 *
 * Pure functions over a point model, with no DOM and no React, for the reason
 * `stage-math.ts` gives for the same split: the arithmetic of an editing
 * gesture is where the bugs live, and it is only testable in isolation if it is
 * separable in the first place. The drag surface on top of this is a matter of
 * pointer events; *this* is where a handle ends up in the wrong place.
 *
 * One model serves a path `ShapeLayer` and a `LayerMask` of type `path`,
 * because the two carry the same `d` string in the same coordinate space — the
 * layer's own pixels — which is the whole reason Wave D builds one editor
 * rather than two.
 *
 * **The subset is deliberate, and refusing to parse is a feature.** A pen tool
 * emits `M`, `L`, `C` and `Z`, and this reads back exactly that. Anything else
 * — arcs, quadratics, relative commands, shorthand, multiple subpaths — parses
 * to `null`, and a caller that gets `null` must leave the string alone and say
 * so. That is not a limitation to apologise for: it is the guarantee that the
 * editor can never silently rewrite hand-authored or imported path data into
 * something that merely looks similar. Losing a curve someone drew elsewhere is
 * far worse than declining to drag it.
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * One anchor, with the control points either side of it.
 *
 * Both handles are *absolute* coordinates rather than offsets from the anchor.
 * Offsets read more naturally in isolation and are worse here: every gesture in
 * the editor works in the same pixel space the `d` string does, so absolute
 * handles make the drag code a direct assignment instead of an addition that
 * has to be undone on the way back out.
 */
export interface PathPoint {
  x: number;
  y: number;
  /** Control point leaving this anchor, when the segment after it curves. */
  out?: Point;
  /** Control point arriving at this anchor, when the segment before it curves. */
  in?: Point;
}

export interface EditablePath {
  points: PathPoint[];
  /** Whether the last point joins back to the first (`Z`). */
  closed: boolean;
}

/** Rounded to a tenth of a pixel — enough for sub-pixel work, short in JSON. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function fmt(p: Point): string {
  return `${round(p.x)} ${round(p.y)}`;
}

/**
 * Write a `d` string.
 *
 * A segment is a `C` when either of the handles bracketing it exists and an `L`
 * when neither does, so a path drawn entirely with clicks stays entirely
 * straight lines rather than becoming curves with degenerate controls — which
 * would be equivalent on screen and unreadable in the JSON.
 */
export function serializePath(path: EditablePath): string {
  const { points, closed } = path;
  if (points.length === 0) return '';

  const first = points[0]!;
  const parts: string[] = [`M ${fmt(first)}`];

  const segment = (from: PathPoint, to: PathPoint): string => {
    if (!from.out && !to.in) return `L ${fmt(to)}`;
    // A missing handle collapses onto its own anchor, which is what makes a
    // curve with one handle bend on one side only.
    const c1 = from.out ?? { x: from.x, y: from.y };
    const c2 = to.in ?? { x: to.x, y: to.y };
    return `C ${fmt(c1)} ${fmt(c2)} ${fmt(to)}`;
  };

  for (let i = 1; i < points.length; i++) {
    parts.push(segment(points[i - 1]!, points[i]!));
  }

  if (closed && points.length > 1) {
    const last = points[points.length - 1]!;
    // `Z` alone draws a straight line home; it can only be left implicit when
    // that closing segment is genuinely straight.
    if (last.out || first.in) parts.push(segment(last, first));
    parts.push('Z');
  }

  return parts.join(' ');
}

/** Command letters this model can round-trip. */
const SUPPORTED = new Set(['M', 'L', 'C', 'Z', 'z']);

/**
 * Read a `d` string back into points, or `null` if it is outside the subset.
 *
 * `null` means "do not touch this" — see the module note. It is returned for
 * anything unparseable *and* for anything merely unsupported, because the
 * caller's correct response to both is identical: leave the data alone.
 */
export function parsePath(d: string | undefined): EditablePath | null {
  if (!d || !d.trim()) return null;

  // Commands split off their arguments; commas and whitespace both separate.
  const tokens = d.trim().match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  if (!tokens) return null;

  const points: PathPoint[] = [];
  let closed = false;
  let i = 0;
  let seenMove = false;

  const number = (): number | null => {
    const token = tokens[i];
    if (token === undefined) return null;
    const value = Number(token);
    if (!Number.isFinite(value)) return null;
    i += 1;
    return value;
  };

  const point = (): Point | null => {
    const x = number();
    const y = number();
    return x === null || y === null ? null : { x, y };
  };

  while (i < tokens.length) {
    const command = tokens[i]!;
    if (!/[A-Za-z]/.test(command)) return null; // a number where a command belongs
    if (!SUPPORTED.has(command)) return null;
    i += 1;

    // Everything after `Z` would be a second subpath, which this model has no
    // way to represent — and quietly dropping it would delete artwork.
    if (closed) return null;

    if (command === 'M') {
      // A second moveto is a second subpath, same argument as above.
      if (seenMove) return null;
      const p = point();
      if (!p) return null;
      points.push({ x: p.x, y: p.y });
      seenMove = true;
      continue;
    }

    if (!seenMove) return null; // data that does not start with a moveto

    if (command === 'L') {
      const p = point();
      if (!p) return null;
      points.push({ x: p.x, y: p.y });
      continue;
    }

    if (command === 'C') {
      const c1 = point();
      const c2 = point();
      const p = point();
      if (!c1 || !c2 || !p) return null;
      const previous = points[points.length - 1];
      if (!previous) return null;
      // A control sitting exactly on its anchor is how `serializePath` writes a
      // one-sided curve, so it reads back as the absent handle it came from
      // rather than as a handle that happens to be at zero length.
      if (c1.x !== previous.x || c1.y !== previous.y) previous.out = c1;
      const next: PathPoint = { x: p.x, y: p.y };
      if (c2.x !== p.x || c2.y !== p.y) next.in = c2;
      points.push(next);
      continue;
    }

    // Z / z
    closed = true;
  }

  if (points.length === 0) return null;

  /*
   * A closed path whose final curve lands back on the start carries a duplicate
   * anchor — `C … firstPoint Z` is what `serializePath` emits — so it is folded
   * away here, handing its arriving handle to the point it duplicates. Without
   * this, every save/load round trip on a closed curved path would grow one
   * more redundant point than the last.
   */
  if (closed && points.length > 1) {
    const last = points[points.length - 1]!;
    const first = points[0]!;
    if (last.x === first.x && last.y === first.y) {
      if (last.in) first.in = last.in;
      points.pop();
    }
  }

  return { points, closed };
}

/** Can the editor safely drag this string, or must it be left as text? */
export function isEditablePath(d: string | undefined): boolean {
  return parsePath(d) !== null;
}

/* ------------------------------------------------------------- mutations */

/*
 * Every mutation returns a new path and leaves its input alone, so a gesture
 * can recompute from the value it started with rather than accumulating
 * rounding — the same discipline the keyframe commands follow, and the reason
 * dragging a point 200px in one stroke lands on the same number as dragging it
 * there in forty.
 */

function clonePoint(p: PathPoint): PathPoint {
  return {
    x: p.x,
    y: p.y,
    ...(p.in ? { in: { ...p.in } } : {}),
    ...(p.out ? { out: { ...p.out } } : {}),
  };
}

export function clonePath(path: EditablePath): EditablePath {
  return { points: path.points.map(clonePoint), closed: path.closed };
}

/**
 * Move an anchor, taking its handles with it.
 *
 * Handles travel with their anchor because they are stored absolutely: leaving
 * them behind would reshape both neighbouring curves every time a point was
 * nudged, which reads as the curve fighting the drag.
 */
export function movePoint(path: EditablePath, index: number, to: Point): EditablePath {
  const point = path.points[index];
  if (!point) return path;

  const dx = to.x - point.x;
  const dy = to.y - point.y;
  const next = clonePath(path);
  const moved = next.points[index]!;

  moved.x = to.x;
  moved.y = to.y;
  if (moved.in) moved.in = { x: moved.in.x + dx, y: moved.in.y + dy };
  if (moved.out) moved.out = { x: moved.out.x + dx, y: moved.out.y + dy };

  return next;
}

/** Move one control point. The anchor and its opposite handle stay put. */
export function moveHandle(
  path: EditablePath,
  index: number,
  which: 'in' | 'out',
  to: Point,
): EditablePath {
  if (!path.points[index]) return path;
  const next = clonePath(path);
  next.points[index]![which] = { x: to.x, y: to.y };
  return next;
}

/** Append an anchor to the open end of the path — what clicking with the pen does. */
export function addPoint(path: EditablePath, at: Point): EditablePath {
  const next = clonePath(path);
  next.points.push({ x: at.x, y: at.y });
  return next;
}

/**
 * Insert an anchor between two existing ones.
 *
 * The straight-line case only: splitting a curve properly means de Casteljau on
 * the segment and rewriting four handles, and inserting a point into a curve
 * *without* that changes the shape under the author's cursor. Refusing is the
 * honest half of the feature until the subdivision is built — the caller offers
 * the insert on straight segments and leaves curves alone.
 */
export function insertPoint(path: EditablePath, after: number, at: Point): EditablePath {
  const from = path.points[after];
  const to = path.points[after + 1] ?? (path.closed ? path.points[0] : undefined);
  if (!from || !to || from.out || to.in) return path;

  const next = clonePath(path);
  next.points.splice(after + 1, 0, { x: at.x, y: at.y });
  return next;
}

/**
 * Remove an anchor.
 *
 * A path needs two points to be a path at all, so the last two are not
 * removable — an empty `d` fails validation, and a one-point path draws
 * nothing while looking like it should.
 */
export function removePoint(path: EditablePath, index: number): EditablePath {
  if (path.points.length <= 2 || !path.points[index]) return path;
  const next = clonePath(path);
  next.points.splice(index, 1);
  return next;
}

/** Drop both handles from an anchor, making its neighbouring segments straight. */
export function straightenPoint(path: EditablePath, index: number): EditablePath {
  if (!path.points[index]) return path;
  const next = clonePath(path);
  const point = next.points[index]!;
  delete point.in;
  delete point.out;
  return next;
}

/**
 * Give an anchor a pair of handles, aimed along the line between its
 * neighbours — the standard "smooth this corner" gesture.
 *
 * The handle length is a third of the distance to each neighbour, which is the
 * conventional starting point: long enough to round the corner visibly, short
 * enough not to loop.
 */
export function smoothPoint(path: EditablePath, index: number): EditablePath {
  const points = path.points;
  const point = points[index];
  if (!point) return path;

  const previous = points[index - 1] ?? (path.closed ? points[points.length - 1] : undefined);
  const following = points[index + 1] ?? (path.closed ? points[0] : undefined);
  if (!previous || !following || previous === point || following === point) return path;

  // The tangent is the direction between the neighbours, which is what makes
  // the two handles collinear and the join smooth rather than merely curved.
  const tx = following.x - previous.x;
  const ty = following.y - previous.y;
  const length = Math.hypot(tx, ty);
  if (length === 0) return path;

  const ux = tx / length;
  const uy = ty / length;
  const back = Math.hypot(point.x - previous.x, point.y - previous.y) / 3;
  const forward = Math.hypot(following.x - point.x, following.y - point.y) / 3;

  const next = clonePath(path);
  const target = next.points[index]!;
  target.in = { x: point.x - ux * back, y: point.y - uy * back };
  target.out = { x: point.x + ux * forward, y: point.y + uy * forward };
  return next;
}

/** Open or close the path — the `Z` on the end of the string. */
export function setClosed(path: EditablePath, closed: boolean): EditablePath {
  return { points: path.points.map(clonePoint), closed };
}

/**
 * Axis-aligned bounds of the anchors and handles.
 *
 * Control points are included deliberately: this exists to frame the editing
 * surface, and a handle outside the box would be a grab target the author
 * cannot reach. It is *not* the tight bounding box of the drawn curve, which a
 * bezier can only be given by solving each segment — that is a rendering
 * question, and the renderer already answers it.
 */
export function pathBounds(path: EditablePath): { x: number; y: number; width: number; height: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of path.points) {
    xs.push(p.x, p.in?.x ?? p.x, p.out?.x ?? p.x);
    ys.push(p.y, p.in?.y ?? p.y, p.out?.y ?? p.y);
  }
  if (!xs.length) return null;

  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}
