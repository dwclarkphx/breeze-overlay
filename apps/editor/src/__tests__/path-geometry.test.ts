// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/*
 * path-geometry.ts shipped in 0.71.0 proven only by throwaway Node scripts in a
 * sandbox that could not run vitest (MASKS.md §5.1). These are those checks,
 * committed — the on-stage surface (D′) now dispatches every gesture through
 * these functions, so they need to fail in CI rather than in a session's notes.
 */

import { describe, expect, it } from 'vitest';

import {
  addPoint,
  insertPoint,
  isEditablePath,
  moveHandle,
  movePoint,
  parsePath,
  pathBounds,
  removePoint,
  serializePath,
  setClosed,
  smoothPoint,
  straightenPoint,
  type EditablePath,
} from '../state/path-geometry.js';

const TRIANGLE = 'M 0 100 L 50 0 L 100 100 Z';
const CURVE = 'M 0 0 C 10 20 30 40 50 50 L 100 0';

describe('parsePath / serializePath', () => {
  it('round-trips the subset it supports, straight and curved', () => {
    for (const d of [TRIANGLE, CURVE, 'M 0 0 L 10 10', 'M 0 0 C 0 0 10 10 20 20 Z']) {
      expect(serializePath(parsePath(d)!)).toBe(d);
    }
  });

  it('reads commas and tight spacing, and writes the canonical form', () => {
    expect(serializePath(parsePath('M0,100L50,0L100,100Z')!)).toBe(TRIANGLE);
  });

  it('refuses what it cannot round-trip, rather than approximating it', () => {
    for (const d of [
      'M 0 0 A 10 10 0 0 1 20 20', // arc
      'M 0 0 Q 10 10 20 0', // quadratic
      'M 0 0 l 10 10', // relative
      'M 0 0 H 10', // shorthand
      'M 0 0 L 10 10 M 20 20 L 30 30', // second subpath
      '',
      undefined,
    ]) {
      expect(parsePath(d), String(d)).toBeNull();
      expect(isEditablePath(d)).toBe(false);
    }
  });
});

describe('point operations', () => {
  const tri = (): EditablePath => parsePath(TRIANGLE)!;

  it('moves an anchor and carries its handles with it', () => {
    const smooth = smoothPoint(tri(), 1);
    const before = smooth.points[1]!;
    const moved = movePoint(smooth, 1, { x: before.x + 10, y: before.y + 5 }).points[1]!;
    expect(moved.in).toEqual({ x: before.in!.x + 10, y: before.in!.y + 5 });
    expect(moved.out).toEqual({ x: before.out!.x + 10, y: before.out!.y + 5 });
  });

  it('moves one handle and leaves the anchor and the other handle alone', () => {
    const smooth = smoothPoint(tri(), 1);
    const next = moveHandle(smooth, 1, 'out', { x: 99, y: 1 }).points[1]!;
    expect(next.out).toEqual({ x: 99, y: 1 });
    expect(next.in).toEqual(smooth.points[1]!.in);
    expect([next.x, next.y]).toEqual([50, 0]);
  });

  it('never mutates its input', () => {
    const path = tri();
    const copy = JSON.stringify(path);
    movePoint(path, 0, { x: 5, y: 5 });
    moveHandle(path, 0, 'in', { x: 5, y: 5 });
    smoothPoint(path, 1);
    removePoint(path, 0);
    expect(JSON.stringify(path)).toBe(copy);
  });

  it('smooths a corner with collinear handles a third of the way to each neighbour', () => {
    const p = smoothPoint(tri(), 1).points[1]!;
    // Neighbours are (0,100) and (100,100): the tangent is horizontal.
    expect(p.in!.y).toBeCloseTo(0);
    expect(p.out!.y).toBeCloseTo(0);
    expect(p.out!.x - p.x).toBeCloseTo(Math.hypot(50, 100) / 3);
    expect(serializePath(straightenPoint(smoothPoint(tri(), 1), 1))).toBe(TRIANGLE);
  });

  it('keeps at least two points', () => {
    const line = parsePath('M 0 0 L 10 10')!;
    expect(removePoint(line, 0)).toBe(line);
    expect(removePoint(tri(), 1).points).toHaveLength(2);
  });

  it('inserts only into straight segments', () => {
    expect(insertPoint(tri(), 0, { x: 25, y: 50 }).points).toHaveLength(4);
    // The closing segment, from the last point back to the first.
    expect(insertPoint(tri(), 2, { x: 50, y: 100 }).points[3]).toEqual({ x: 50, y: 100 });
    const curved = parsePath(CURVE)!;
    expect(insertPoint(curved, 0, { x: 5, y: 5 })).toBe(curved);
  });

  it('adds, opens and closes', () => {
    const open = setClosed(tri(), false);
    expect(serializePath(open)).toBe('M 0 100 L 50 0 L 100 100');
    expect(serializePath(addPoint(open, { x: 0, y: 0 }))).toBe('M 0 100 L 50 0 L 100 100 L 0 0');
  });

  it('bounds anchors and handles together', () => {
    expect(pathBounds(parsePath(CURVE)!)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });
});
