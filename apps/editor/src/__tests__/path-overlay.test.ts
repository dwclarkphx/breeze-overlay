// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import type { Layer } from '@breeze/schema';

import { parsePath, serializePath } from '../state/path-geometry.js';
import {
  IDENTITY,
  apply,
  beginPathDrag,
  dragPathTo,
  insertOnSegment,
  invert,
  layerToStage,
  overlayModel,
  pathPatch,
  pathTargets,
  removeAnchor,
  compose,
  toggleSmooth,
  type Affine,
} from '../state/path-overlay.js';

/** A layer at (300, 200) on the stage, rotated 90°, on a stage shown at 50% and panned. */
const ROT90: Affine = { a: 0, b: 1, c: -1, d: 0, e: 300, f: 200 };
const STAGE_TO_SCREEN: Affine = { a: 0.5, b: 0, c: 0, d: 0.5, e: 40, f: 60 };
const LAYER_TO_SCREEN = compose(ROT90, STAGE_TO_SCREEN);

const close = (p: { x: number; y: number }, x: number, y: number) => {
  expect(p.x).toBeCloseTo(x, 6);
  expect(p.y).toBeCloseTo(y, 6);
};

describe('matrices', () => {
  it('composes in application order and inverts exactly', () => {
    close(apply(LAYER_TO_SCREEN, { x: 10, y: 0 }), 40 + 300 * 0.5, 60 + 210 * 0.5);
    const back = apply(invert(LAYER_TO_SCREEN)!, apply(LAYER_TO_SCREEN, { x: 12.5, y: -7 }));
    close(back, 12.5, -7);
  });

  it('has no inverse for a layer scaled to nothing, and no mapping without both CTMs', () => {
    expect(invert({ ...IDENTITY, a: 0, d: 0 })).toBeNull();
    expect(layerToStage(null, STAGE_TO_SCREEN)).toBeNull();
    expect(layerToStage(LAYER_TO_SCREEN, null)).toBeNull();
  });

  it('recovers the layer transform from the two screen CTMs', () => {
    // The overlay draws in stage space: zoom and pan must cancel out entirely.
    const m = layerToStage(LAYER_TO_SCREEN, STAGE_TO_SCREEN)!;
    close(apply(m, { x: 0, y: 0 }), 300, 200);
    close(apply(m, { x: 10, y: 0 }), 300, 210);
  });
});

describe('which path a layer offers', () => {
  const shape = { id: 's', type: 'shape', shape: 'path', path: 'M 0 0 L 10 10' } as unknown as Layer;
  const masked = {
    id: 'm', type: 'text', mask: { type: 'path', path: 'M 0 0 L 5 5', x: 7, y: 9, width: 0, height: 0, feather: 4 },
  } as unknown as Layer;

  it('offers a path shape, a path mask with its offset, or both', () => {
    expect(pathTargets(shape)).toEqual([{ kind: 'shape', d: 'M 0 0 L 10 10', offset: { x: 0, y: 0 } }]);
    expect(pathTargets(masked)).toEqual([{ kind: 'mask', d: 'M 0 0 L 5 5', offset: { x: 7, y: 9 } }]);
    expect(pathTargets({ ...shape, mask: (masked as { mask: unknown }).mask } as Layer).map((t) => t.kind)).toEqual(['shape', 'mask']);
    expect(pathTargets({ id: 'r', type: 'shape', shape: 'rect' } as unknown as Layer)).toEqual([]);
    expect(pathTargets(null)).toEqual([]);
  });

  it('writes a mask back whole, so a shallow patch cannot drop its feather', () => {
    expect(pathPatch(masked, 'mask', 'M 1 1 L 2 2')).toEqual({
      mask: { type: 'path', path: 'M 1 1 L 2 2', x: 7, y: 9, width: 0, height: 0, feather: 4 },
    });
    expect(pathPatch(shape, 'shape', 'M 1 1 L 2 2')).toEqual({ path: 'M 1 1 L 2 2' });
  });
});

describe('overlay model', () => {
  it('draws anchors and handles in stage space, offset included', () => {
    const path = parsePath('M 0 0 C 10 0 20 10 20 20 L 0 20')!;
    const model = overlayModel(path, { x: 5, y: 0 }, ROT90);
    close(model.anchors[0]!.at, 300, 205);
    close(model.anchors[0]!.out!, 300, 215);
    expect(model.anchors.map((a) => a.smooth)).toEqual([true, true, false]);
  });

  it('offers insert targets on straight segments only, closing segment included', () => {
    const path = parsePath('M 0 0 C 10 0 20 10 20 20 L 0 20 Z')!;
    expect(overlayModel(path, { x: 0, y: 0 }, IDENTITY).straight.map((s) => s.after)).toEqual([1, 2]);
  });
});

describe('dragging', () => {
  const tri = parsePath('M 0 100 L 50 0 L 100 100 Z')!;

  it('moves an anchor by the pointer delta, through rotation and zoom', () => {
    const at = apply(LAYER_TO_SCREEN, { x: 50, y: 0 });
    const drag = beginPathDrag(tri, { part: 'anchor', index: 1 }, { x: 0, y: 0 }, LAYER_TO_SCREEN, at)!;
    // 10 screen px right at 50% zoom is 20 stage px right, which on a layer
    // rotated 90° is 20 layer px *up* (negative y).
    expect(dragPathTo(drag, { x: at.x + 10, y: at.y }).points[1]).toEqual({ x: 50, y: -20 });
  });

  it('keeps the grab offset, so an off-centre press does not jump the point', () => {
    const at = apply(LAYER_TO_SCREEN, { x: 50, y: 0 });
    const press = { x: at.x + 2, y: at.y + 1 };
    const drag = beginPathDrag(tri, { part: 'anchor', index: 1 }, { x: 0, y: 0 }, LAYER_TO_SCREEN, press)!;
    expect(dragPathTo(drag, press).points[1]).toEqual({ x: 50, y: 0 });
  });

  /*
   * The return leg. A drag that goes out and comes back must land on the
   * origin and still hand back a path to dispatch — 0.41's lifetime bar stayed
   * on its last position because a guard skipped exactly this.
   */
  it('returns to the origin when the pointer does, mid-gesture state differing first', () => {
    const at = apply(LAYER_TO_SCREEN, { x: 50, y: 0 });
    const drag = beginPathDrag(tri, { part: 'anchor', index: 1 }, { x: 0, y: 0 }, LAYER_TO_SCREEN, at)!;
    expect(serializePath(dragPathTo(drag, { x: at.x + 30, y: at.y + 30 }))).not.toBe(serializePath(tri));
    expect(serializePath(dragPathTo(drag, at))).toBe(serializePath(tri));
  });

  it('takes a mask offset off again on the way back', () => {
    const offset = { x: 100, y: 50 };
    const at = apply(IDENTITY, { x: 50 + offset.x, y: 0 + offset.y });
    const drag = beginPathDrag(tri, { part: 'anchor', index: 1 }, offset, IDENTITY, at)!;
    expect(dragPathTo(drag, { x: at.x + 5, y: at.y }).points[1]).toEqual({ x: 55, y: 0 });
  });

  it('moves a handle without moving its anchor', () => {
    const curved = toggleSmooth(tri, 1);
    const out = curved.points[1]!.out!;
    const drag = beginPathDrag(curved, { part: 'out', index: 1 }, { x: 0, y: 0 }, IDENTITY, out)!;
    const p = dragPathTo(drag, { x: out.x, y: out.y + 15 }).points[1]!;
    expect([p.x, p.y]).toEqual([50, 0]);
    expect(p.out!.y).toBeCloseTo(out.y + 15, 1);
    expect(p.in).toEqual(curved.points[1]!.in);
  });

  it('refuses a part that does not exist, or a layer with no inverse', () => {
    expect(beginPathDrag(tri, { part: 'out', index: 1 }, { x: 0, y: 0 }, IDENTITY, { x: 0, y: 0 })).toBeNull();
    expect(beginPathDrag(tri, { part: 'anchor', index: 9 }, { x: 0, y: 0 }, IDENTITY, { x: 0, y: 0 })).toBeNull();
    const flat = { ...IDENTITY, a: 0, d: 0 };
    expect(beginPathDrag(tri, { part: 'anchor', index: 0 }, { x: 0, y: 0 }, flat, { x: 0, y: 0 })).toBeNull();
  });
});

describe('clicks', () => {
  const tri = parsePath('M 0 100 L 50 0 L 100 100 Z')!;

  it('toggles a corner to a curve and back', () => {
    expect(toggleSmooth(tri, 1).points[1]!.out).toBeDefined();
    expect(serializePath(toggleSmooth(toggleSmooth(tri, 1), 1))).toBe(serializePath(tri));
  });

  it('removes an anchor but never below two', () => {
    expect(removeAnchor(tri, 0).points).toHaveLength(2);
    const line = parsePath('M 0 0 L 1 1')!;
    expect(removeAnchor(line, 0)).toBe(line);
  });

  it('inserts onto the line itself, even from a press beside it', () => {
    // Pressed 3px below the midpoint of the top-left edge (0,100)→(50,0).
    const next = insertOnSegment(tri, 0, { x: 0, y: 0 }, IDENTITY, { x: 25, y: 53 });
    const p = next.points[1]!;
    // On the line y = 100 - 2x.
    expect(p.y).toBeCloseTo(100 - 2 * p.x, 0);
    expect(next.points).toHaveLength(4);
  });
});
