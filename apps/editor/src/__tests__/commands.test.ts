// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import {
  createComposition,
  createShapeLayer,
  createTableLayer,
  createTextLayer,
} from '@breeze/schema';
import type { Composition } from '@breeze/schema';
// Validation is a server/tooling concern and lives behind a subpath so it
// never reaches a browser bundle. Tests are tooling, so they may import it.
import { validateComposition } from '@breeze/schema/validate';

import {
  applyCommand,
  applyCommands,
  findCellOwner,
  findLayer,
  isCell,
  normalizeTrack,
} from '../state/commands.js';

const base = (): Composition =>
  createComposition({
    id: 'c',
    layers: [
      createShapeLayer({ id: 'bar', transform: { x: 10, y: 20 } }),
      createTextLayer({ id: 'name', text: 'Jane' }),
    ],
  });

describe('purity', () => {
  it('never mutates the input composition', () => {
    const comp = base();
    const snapshot = JSON.stringify(comp);
    applyCommand(comp, { kind: 'patchLayer', layerId: 'bar', patch: { opacity: 0.5 } });
    expect(JSON.stringify(comp)).toBe(snapshot);
  });

  it('returns a new object so history can hold the old one by reference', () => {
    const comp = base();
    const next = applyCommand(comp, { kind: 'renameComposition', name: 'x' });
    expect(next).not.toBe(comp);
  });
});

describe('layers', () => {
  it('adds a layer on top by default', () => {
    const next = applyCommand(base(), { kind: 'addLayer', layer: createShapeLayer({ id: 'new' }) });
    expect(next.layers.map((l) => l.id)).toEqual(['bar', 'name', 'new']);
  });

  it('inserts a layer at an explicit index', () => {
    const next = applyCommand(base(), {
      kind: 'addLayer',
      layer: createShapeLayer({ id: 'new' }),
      index: 0,
    });
    expect(next.layers.map((l) => l.id)).toEqual(['new', 'bar', 'name']);
  });

  it('adds into a group when given a parent', () => {
    const comp = createComposition({
      layers: [{ id: 'grp', type: 'group', children: [] }],
    });
    const next = applyCommand(comp, {
      kind: 'addLayer',
      layer: createShapeLayer({ id: 'child' }),
      parentId: 'grp',
    });
    expect(findLayer(next.layers, 'child')).toBeDefined();
  });

  it('deletes several layers in one command', () => {
    const next = applyCommand(base(), { kind: 'deleteLayers', layerIds: ['bar', 'name'] });
    expect(next.layers).toEqual([]);
  });

  it('deletes nested layers too', () => {
    const comp = createComposition({
      layers: [{ id: 'grp', type: 'group', children: [createShapeLayer({ id: 'inner' })] }],
    });
    const next = applyCommand(comp, { kind: 'deleteLayers', layerIds: ['inner'] });
    expect(findLayer(next.layers, 'inner')).toBeUndefined();
    expect(findLayer(next.layers, 'grp')).toBeDefined();
  });

  it('reorders within bounds and clamps out-of-range targets', () => {
    const next = applyCommand(base(), { kind: 'reorderLayer', layerId: 'bar', toIndex: 99 });
    expect(next.layers.map((l) => l.id)).toEqual(['name', 'bar']);
  });

  it('refuses to patch id or type, which would orphan the layer', () => {
    const next = applyCommand(base(), {
      kind: 'patchLayer',
      layerId: 'bar',
      patch: { id: 'hijacked', type: 'text', opacity: 0.3 } as never,
    });
    const layer = findLayer(next.layers, 'bar')!;
    expect(layer.id).toBe('bar');
    expect(layer.type).toBe('shape');
    expect(layer.opacity).toBe(0.3);
  });

  it('patches a nested layer without touching its siblings', () => {
    const comp = createComposition({
      layers: [
        {
          id: 'grp',
          type: 'group',
          children: [createShapeLayer({ id: 'a' }), createShapeLayer({ id: 'b' })],
        },
      ],
    });
    const next = applyCommand(comp, { kind: 'patchLayer', layerId: 'a', patch: { opacity: 0.1 } });
    expect(findLayer(next.layers, 'a')!.opacity).toBe(0.1);
    expect(findLayer(next.layers, 'b')!.opacity).toBe(1);
  });
});

describe('keyframes', () => {
  const withTrack = () =>
    applyCommands(base(), [
      { kind: 'setKeyframe', layerId: 'bar', prop: 'x', time: 0, value: -100 },
      { kind: 'setKeyframe', layerId: 'bar', prop: 'x', time: 0.5, value: 0 },
    ]);

  it('creates a track in time order', () => {
    const comp = applyCommands(base(), [
      { kind: 'setKeyframe', layerId: 'bar', prop: 'x', time: 1, value: 5 },
      { kind: 'setKeyframe', layerId: 'bar', prop: 'x', time: 0, value: 0 },
    ]);
    expect(findLayer(comp.layers, 'bar')!.keyframes!.x!.map((k) => k.t)).toEqual([0, 1]);
  });

  it('replaces rather than duplicates a keyframe at the same time', () => {
    const comp = applyCommands(withTrack(), [
      { kind: 'setKeyframe', layerId: 'bar', prop: 'x', time: 0.5, value: 42 },
    ]);
    const track = findLayer(comp.layers, 'bar')!.keyframes!.x!;
    expect(track).toHaveLength(2);
    expect(track[1]!.v).toBe(42);
  });

  it('keeps a hand-tuned ease when only the value changes', () => {
    let comp = applyCommand(withTrack(), {
      kind: 'setKeyframeEase',
      layerId: 'bar',
      prop: 'x',
      time: 0,
      ease: 'power3.out',
    });
    comp = applyCommand(comp, { kind: 'setKeyframe', layerId: 'bar', prop: 'x', time: 0, value: -500 });

    const kf = findLayer(comp.layers, 'bar')!.keyframes!.x![0]!;
    expect(kf.v).toBe(-500);
    expect(kf.ease).toBe('power3.out');
  });

  it('moves a keyframe and re-sorts the track', () => {
    const comp = applyCommand(withTrack(), {
      kind: 'moveKeyframe', layerId: 'bar', prop: 'x', from: 0, to: 0.9,
    });
    const track = findLayer(comp.layers, 'bar')!.keyframes!.x!;
    expect(track.map((k) => k.t)).toEqual([0.5, 0.9]);
  });

  it('clamps a keyframe dragged before zero', () => {
    const comp = applyCommand(withTrack(), {
      kind: 'moveKeyframe', layerId: 'bar', prop: 'x', from: 0.5, to: -3,
    });
    expect(findLayer(comp.layers, 'bar')!.keyframes!.x![0]!.t).toBe(0);
  });

  it('collapses rather than duplicates when dragged onto another keyframe', () => {
    // Two keyframes at the same time would fail schema validation.
    const comp = applyCommand(withTrack(), {
      kind: 'moveKeyframe', layerId: 'bar', prop: 'x', from: 0, to: 0.5,
    });
    const track = findLayer(comp.layers, 'bar')!.keyframes!.x!;
    expect(track).toHaveLength(1);
    expect(track[0]!.t).toBe(0.5);
  });

  it('drops the track entirely when its last keyframe goes', () => {
    const comp = applyCommand(withTrack(), {
      kind: 'deleteKeyframes',
      targets: [
        { layerId: 'bar', prop: 'x', time: 0 },
        { layerId: 'bar', prop: 'x', time: 0.5 },
      ],
    });
    expect(findLayer(comp.layers, 'bar')!.keyframes).toBeUndefined();
  });

  it('deletes across multiple tracks in one command', () => {
    let comp = withTrack();
    comp = applyCommand(comp, { kind: 'setKeyframe', layerId: 'bar', prop: 'y', time: 0, value: 1 });
    comp = applyCommand(comp, {
      kind: 'deleteKeyframes',
      targets: [
        { layerId: 'bar', prop: 'x', time: 0 },
        { layerId: 'bar', prop: 'y', time: 0 },
      ],
    });
    expect(findLayer(comp.layers, 'bar')!.keyframes!.x).toHaveLength(1);
    expect(findLayer(comp.layers, 'bar')!.keyframes!.y).toBeUndefined();
  });

  it('pastes relative to the playhead, preserving spacing', () => {
    const comp = applyCommand(base(), {
      kind: 'pasteKeyframes',
      layerId: 'name',
      prop: 'opacity',
      keyframes: [{ t: 1, v: 0 }, { t: 1.5, v: 1 }],
      atTime: 3,
    });
    expect(findLayer(comp.layers, 'name')!.keyframes!.opacity!.map((k) => k.t)).toEqual([3, 3.5]);
  });

  it('produces schema-valid output after a paste that overlaps existing keys', () => {
    let comp = withTrack();
    comp = applyCommand(comp, {
      kind: 'pasteKeyframes',
      layerId: 'bar',
      prop: 'x',
      keyframes: [{ t: 0, v: 9 }, { t: 0.5, v: 10 }],
      atTime: 0,
    });
    expect(validateComposition(comp).errors).toEqual([]);
  });
});

describe('setValues', () => {
  it('writes the static baseline when the property is not animated', () => {
    const comp = applyCommand(base(), {
      kind: 'setValues', layerId: 'bar', values: { x: 42, y: 7 }, time: 1,
    });
    expect(findLayer(comp.layers, 'bar')!.transform).toMatchObject({ x: 42, y: 7 });
    expect(findLayer(comp.layers, 'bar')!.keyframes).toBeUndefined();
  });

  it('writes a keyframe at the playhead when the property IS animated', () => {
    /*
     * The bug this command exists to prevent: dragging on canvas wrote
     * transform.x, which the planner ignores entirely once a keyframe track
     * exists — so dragging an animated layer looked like it did nothing.
     */
    let comp = applyCommand(base(), {
      kind: 'setKeyframe', layerId: 'bar', prop: 'x', time: 0, value: -100,
    });
    comp = applyCommand(comp, {
      kind: 'setValues', layerId: 'bar', values: { x: 500 }, time: 1.25,
    });

    const layer = findLayer(comp.layers, 'bar')!;
    expect(layer.keyframes!.x!.map((k) => [k.t, k.v])).toEqual([[0, -100], [1.25, 500]]);
    // The baseline is left alone — the track owns the value now.
    expect(layer.transform?.x).toBe(10);
  });

  it('handles a mix of animated and static properties in one command', () => {
    // Dragging sets x and y together; only one of them may be animated.
    let comp = applyCommand(base(), {
      kind: 'setKeyframe', layerId: 'bar', prop: 'x', time: 0, value: 0,
    });
    comp = applyCommand(comp, {
      kind: 'setValues', layerId: 'bar', values: { x: 300, y: 400 }, time: 0.5,
    });

    const layer = findLayer(comp.layers, 'bar')!;
    expect(layer.keyframes!.x!.some((k) => k.t === 0.5 && k.v === 300)).toBe(true);
    expect(layer.keyframes!.y).toBeUndefined();
    expect(layer.transform?.y).toBe(400);
  });

  it('routes opacity, blur and brightness to the right home', () => {
    const comp = applyCommand(base(), {
      kind: 'setValues', layerId: 'bar', values: { opacity: 0.4, blur: 3, brightness: 1.5 }, time: 0,
    });
    const layer = findLayer(comp.layers, 'bar')!;
    expect(layer.opacity).toBe(0.4);
    expect(layer.effects).toMatchObject({ blur: 3, brightness: 1.5 });
  });

  it('preserves a hand-tuned ease when overwriting a keyframe', () => {
    let comp = applyCommand(base(), {
      kind: 'setKeyframe', layerId: 'bar', prop: 'x', time: 0.5, value: 1, ease: 'power3.out',
    });
    comp = applyCommand(comp, {
      kind: 'setValues', layerId: 'bar', values: { x: 99 }, time: 0.5,
    });
    expect(findLayer(comp.layers, 'bar')!.keyframes!.x![0]).toMatchObject({ v: 99, ease: 'power3.out' });
  });

  it('is a no-op when the values already match', () => {
    const comp = base();
    const t = findLayer(comp.layers, 'bar')!.transform!;
    expect(applyCommand(comp, {
      kind: 'setValues', layerId: 'bar', values: { x: t.x!, y: t.y! }, time: 0,
    })).toBe(comp);
  });

  it('produces schema-valid output', () => {
    let comp = applyCommand(base(), { kind: 'setKeyframe', layerId: 'bar', prop: 'x', time: 0, value: 0 });
    comp = applyCommand(comp, { kind: 'setValues', layerId: 'bar', values: { x: 1, y: 2 }, time: 0.75 });
    expect(validateComposition(comp).errors).toEqual([]);
  });
});

describe('resizeLayer', () => {
  it('applies size and position in one command', () => {
    const comp = applyCommand(base(), {
      kind: 'resizeLayer',
      layerId: 'bar',
      size: { width: 300, height: 80 },
      values: { x: 40, y: 50 },
      time: 0,
    });
    const layer = findLayer(comp.layers, 'bar')!;
    expect(layer.size).toEqual({ width: 300, height: 80 });
    expect(layer.transform).toMatchObject({ x: 40, y: 50 });
  });

  it('writes a keyframe when the position is animated', () => {
    // Same rule as setValues — a resize that nudges an animated layer must not
    // write a baseline the planner ignores.
    let comp = applyCommand(base(), { kind: 'setKeyframe', layerId: 'bar', prop: 'x', time: 0, value: 0 });
    comp = applyCommand(comp, {
      kind: 'resizeLayer',
      layerId: 'bar',
      size: { width: 300, height: 80 },
      values: { x: 99 },
      time: 0.5,
    });
    expect(findLayer(comp.layers, 'bar')!.keyframes!.x!.some((k) => k.t === 0.5 && k.v === 99)).toBe(true);
  });

  it('is a no-op when nothing changes', () => {
    const comp = base();
    const layer = findLayer(comp.layers, 'bar')!;
    expect(
      applyCommand(comp, {
        kind: 'resizeLayer',
        layerId: 'bar',
        size: layer.size!,
        values: { x: layer.transform!.x!, y: layer.transform!.y! },
        time: 0,
      }),
    ).toBe(comp);
  });

  it('produces schema-valid output', () => {
    const comp = applyCommand(base(), {
      kind: 'resizeLayer',
      layerId: 'bar',
      size: { width: 10, height: 10 },
      values: { x: 1, y: 2 },
      time: 0,
    });
    expect(validateComposition(comp).errors).toEqual([]);
  });
});

describe('normalizeTrack', () => {
  it('sorts, dedupes and snaps float drift to microseconds', () => {
    const track = normalizeTrack([
      { t: 0.30000000000000004, v: 1 },
      { t: 0.1, v: 2 },
      { t: 0.3, v: 3 },
    ]);
    expect(track.map((k) => k.t)).toEqual([0.1, 0.3]);
    // Last write wins on a duplicate time.
    expect(track[1]!.v).toBe(3);
  });
});

describe('markers', () => {
  it('keeps markers sorted by time', () => {
    const comp = applyCommands(base(), [
      { kind: 'addMarker', marker: { type: 'stop', time: 1 } },
      { kind: 'addMarker', marker: { type: 'stop', time: 0.4 } },
    ]);
    expect(comp.markers!.map((m) => m.time)).toEqual([0.4, 1]);
  });

  it('clamps a marker dragged before zero', () => {
    const comp = applyCommands(base(), [
      { kind: 'addMarker', marker: { type: 'stop', time: 1 } },
      { kind: 'moveMarker', index: 0, time: -5 },
    ]);
    expect(comp.markers![0]!.time).toBe(0);
  });

  it('ignores a move targeting a marker that does not exist', () => {
    const comp = base();
    expect(applyCommand(comp, { kind: 'moveMarker', index: 7, time: 1 })).toBe(comp);
  });
});

/*
 * Cells.
 *
 * The runtime has played per-cell keyframe tracks since 0.53.0, but the editor
 * could not address a cell: `mapLayer` and `findLayer` descended into a group's
 * `children` and stopped at a table. These cover the consequence of teaching
 * them about `row.cells` — that every command keyed on a layer id now reaches a
 * cell without a case of its own.
 */
describe('table cells', () => {
  const withTable = (): Composition =>
    createComposition({
      id: 'c',
      layers: [
        createShapeLayer({ id: 'bg' }),
        createTableLayer({
          id: 'standings',
          row: {
            height: 40,
            cells: [
              createShapeLayer({ id: 'rowbg', size: { width: 400, height: 40 } }),
              createTextLayer({ id: 'team', cell: 'team', text: 'Team' }),
            ],
          },
        }),
      ],
    });

  const cells = (comp: Composition) => {
    const table = comp.layers.find((l) => l.id === 'standings');
    if (table?.type !== 'table') throw new Error('table missing');
    return table.row.cells;
  };

  it('finds a cell by id, the same way it finds a stage layer', () => {
    const comp = withTable();
    expect(findLayer(comp.layers, 'team')?.id).toBe('team');
    expect(findLayer(comp.layers, 'rowbg')?.type).toBe('shape');
    expect(findLayer(comp.layers, 'absent')).toBeUndefined();
  });

  it('reports which table owns a cell, and nothing for a stage layer', () => {
    const comp = withTable();
    expect(findCellOwner(comp.layers, 'team')?.id).toBe('standings');
    expect(findCellOwner(comp.layers, 'bg')).toBeUndefined();
    expect(isCell(comp.layers, 'team')).toBe(true);
    expect(isCell(comp.layers, 'bg')).toBe(false);
  });

  it('patches a cell through the ordinary patchLayer command', () => {
    const next = applyCommand(withTable(), {
      kind: 'patchLayer',
      layerId: 'team',
      patch: { opacity: 0.5 },
    });
    expect(cells(next)[1]!.opacity).toBe(0.5);
  });

  it('keyframes a cell through the ordinary setKeyframe command', () => {
    const next = applyCommand(withTable(), {
      kind: 'setKeyframe',
      layerId: 'team',
      prop: 'x',
      time: 0.2,
      value: 40,
    });
    expect(cells(next)[1]!.keyframes?.x).toEqual([{ t: 0.2, v: 40 }]);
  });

  it('leaves the rest of the document identical when a cell changes', () => {
    const comp = withTable();
    const next = applyCommand(comp, { kind: 'patchLayer', layerId: 'team', patch: { opacity: 0.5 } });
    // The untouched sibling must survive by reference, or every cell edit
    // re-renders and re-measures every other layer on the stage.
    expect(next.layers[0]).toBe(comp.layers[0]);
    expect(next).not.toBe(comp);
  });

  it('records no undo step for a no-op cell patch', () => {
    const comp = withTable();
    // Identity is the signal `pushCommand` uses to skip an undo entry. A patch
    // that reaches a cell and changes nothing has to preserve it just as one
    // aimed at a top-level layer does.
    expect(applyCommand(comp, { kind: 'patchLayer', layerId: 'team', patch: { cell: 'team' } })).toBe(comp);
  });

  it('adds a cell to a table given the table as parent', () => {
    const next = applyCommand(withTable(), {
      kind: 'addLayer',
      layer: createTextLayer({ id: 'wins', cell: 'w' }),
      parentId: 'standings',
    });
    expect(cells(next).map((c) => c.id)).toEqual(['rowbg', 'team', 'wins']);
  });

  it('deletes a cell without disturbing the table', () => {
    const next = applyCommand(withTable(), { kind: 'deleteLayers', layerIds: ['team'] });
    expect(cells(next).map((c) => c.id)).toEqual(['rowbg']);
    expect(next.layers.map((l) => l.id)).toEqual(['bg', 'standings']);
  });

  it('reorders cells, which is their paint order inside the row', () => {
    // buildRow writes zIndex from the array index, so this is the only way to
    // put a badge behind a name without deleting and re-adding the cell.
    const next = applyCommand(withTable(), { kind: 'reorderLayer', layerId: 'team', toIndex: 0 });
    expect(cells(next).map((c) => c.id)).toEqual(['team', 'rowbg']);
  });

  it('ignores a reorder aimed at an id that is neither layer nor cell', () => {
    const comp = withTable();
    expect(applyCommand(comp, { kind: 'reorderLayer', layerId: 'nope', toIndex: 0 })).toBe(comp);
  });

  it('leaves a composition carrying cell keyframes schema-valid', () => {
    const next = applyCommand(withTable(), {
      kind: 'setKeyframe',
      layerId: 'team',
      prop: 'opacity',
      time: 0.3,
      value: 1,
    });
    expect(validateComposition(next).valid).toBe(true);
  });
});
