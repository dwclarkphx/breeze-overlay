// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Per-cell keyframes.
 *
 * Two things are worth pinning here and they are both about ownership rather
 * than about motion. A cell that animates must have handed its transform to
 * GSAP outright — the moment `TableBlock` also writes `style.transform` on it,
 * one of the two silently loses, because GSAP caches the transform and rewrites
 * the whole string. And a cell that does *not* animate must stay on the cheap
 * static path, because the reason this was affordable at all is that it costs
 * nothing for the tables that never use it.
 *
 * Assertions read inline style rather than computed opacity wherever "has this
 * started" is the question. Computed opacity cannot tell a cell that has not
 * begun from one that has finished, so an end-state-only assertion here would
 * pass without ever exercising anything.
 */

import { describe, expect, it } from 'vitest';
import {
  createComposition,
  createShapeLayer,
  createTableLayer,
  createTextLayer,
  type Composition,
  type Layer,
  type TableLayer,
} from '@breeze/schema';

import { BreezeRuntime } from '../runtime.js';

const ROW_H = 40;

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ team: `Team ${i + 1}`, w: n - i }));

function tableLayer(cells: Layer[], overrides: Partial<TableLayer> = {}): TableLayer {
  return createTableLayer({
    id: 'table',
    size: { width: 600, height: 400 },
    row: { height: ROW_H, gap: 0, cells },
    data: {
      columns: [{ key: 'team', type: 'string' }, { key: 'w', type: 'number' }],
      rows: rows(4),
    },
    rowAnim: { id: 'rows-up', stagger: 0.1, duration: 0.4 },
    ...overrides,
  });
}

function mount(layer: TableLayer): { runtime: BreezeRuntime; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const composition: Composition = createComposition({
    id: 'standings',
    duration: 4,
    layers: [layer],
  });
  return { runtime: new BreezeRuntime({ container, composition, injectStyles: false }), container };
}

const cellsNamed = (container: HTMLElement, id: string): HTMLElement[] =>
  [...container.querySelectorAll<HTMLElement>(`[data-cell="${id}"]`)];

/** A cell that slides in from the left over the first half second. */
const slidingCell = (): Layer =>
  createTextLayer({
    id: 'team',
    cell: 'team',
    size: { width: 400, height: ROW_H },
    transform: { x: 100 },
    keyframes: { x: [{ t: 0, v: -200 }, { t: 0.5, v: 100 }] },
  });

describe('cell transform ownership', () => {
  it('leaves an animated cell free of a hand-written transform', () => {
    // The bug this prevents: TableBlock writes style.transform, GSAP later
    // rewrites the whole string from its own cache, and the authored static
    // offset vanishes on the first tick.
    const { container } = mount(tableLayer([slidingCell()]));
    const cells = cellsNamed(container, 'team');

    expect(cells).toHaveLength(4);
    for (const cell of cells) {
      expect(cell.style.transform).not.toBe('');
      // Whatever is there came from GSAP seeding the baseline, so it holds the
      // first keyframe's value rather than the authored resting position.
      expect(cell.style.transform).toContain('-200');
    }
  });

  it('keeps an un-keyframed cell on the static path', () => {
    const plain = createTextLayer({
      id: 'plain',
      cell: 'team',
      size: { width: 400, height: ROW_H },
      transform: { x: 24, y: 6 },
    });
    const { container } = mount(tableLayer([plain]));

    // `translate(24px, 6px)` — written directly, not through GSAP, which is
    // what keeps a twenty-row table from handing GSAP a hundred static targets.
    for (const cell of cellsNamed(container, 'plain')) {
      expect(cell.style.transform).toContain('translate(24px, 6px)');
    }
  });

  it('seeds a baseline for properties the cell does not keyframe', () => {
    // A cell keyframing only opacity is still excluded from staticTransform, so
    // if `x` were not seeded it would collapse to the row origin.
    const fading = createTextLayer({
      id: 'fading',
      cell: 'team',
      size: { width: 400, height: ROW_H },
      transform: { x: 64 },
      keyframes: { opacity: [{ t: 0, v: 0 }, { t: 0.4, v: 1 }] },
    });
    const { container } = mount(tableLayer([fading]));

    for (const cell of cellsNamed(container, 'fading')) {
      expect(cell.style.transform).toContain('64');
    }
  });
});

describe('cell keyframe playback', () => {
  it('animates every row from one tween', () => {
    const { runtime, container } = mount(tableLayer([slidingCell()]));

    runtime.seek(0);
    const atStart = cellsNamed(container, 'team').map((c) => c.style.transform);
    runtime.seek(1);
    const atEnd = cellsNamed(container, 'team').map((c) => c.style.transform);

    expect(atStart.every((t) => t.includes('-200'))).toBe(true);
    expect(atEnd.every((t) => t.includes('100'))).toBe(true);
    expect(atEnd).not.toEqual(atStart);
  });

  it('staggers cell motion by the row reveal, so no row animates off-screen', () => {
    /*
     * The reason cell time zero is the row's arrival rather than the table's.
     * With a 0.1s row stagger, row 4's cell must not have finished at the
     * moment row 1's has — otherwise row 4's motion was spent while row 4 was
     * still waiting its turn to appear.
     */
    const { runtime, container } = mount(tableLayer([slidingCell()]));

    runtime.seek(0.5);
    const [first, , , last] = cellsNamed(container, 'team');
    expect(first!.style.transform).not.toBe(last!.style.transform);
  });

  it('moves every row together when the table has no row reveal', () => {
    // No reveal means no stagger to ride, and every row is on screen at once —
    // the same rule with nothing to offset.
    const { runtime, container } = mount(
      tableLayer([slidingCell()], { rowAnim: { id: 'none' } }),
    );

    runtime.seek(0.25);
    const seen = new Set(cellsNamed(container, 'team').map((c) => c.style.transform));
    expect(seen.size).toBe(1);
  });
});

describe('cell tracks survive the table changing under them', () => {
  it('re-seeds cells after a re-sort rebuilds rows', () => {
    /*
     * A rebuilt row is a brand-new element with no transform on it at all,
     * because animated cells skip `staticTransform`. If the refill did not
     * re-apply baselines, every cell in the new row would stack at the row
     * origin — visible, wrong, and only on re-sort.
     */
    // Bound to a source, so a `$data` push actually reaches it — a table with
    // only authored rows is never rebuilt and would test nothing.
    const { runtime, container } = mount(
      tableLayer([slidingCell()], { source: 'standings' }),
    );

    runtime.update({
      $data: {
        standings: {
          id: 'standings',
          columns: [{ key: 'team', type: 'string' }, { key: 'w', type: 'number' }],
          rows: rows(6),
        },
      },
    });

    const cells = cellsNamed(container, 'team');
    expect(cells.length).toBeGreaterThan(4);
    for (const cell of cells) {
      expect(cell.style.transform, cell.dataset['cell']).not.toBe('');
    }
  });

  it('builds no cell track for a table whose cells carry no keyframes', () => {
    // The feature has to be inert for tables that do not use it — that is the
    // whole argument for it being affordable.
    const plain = createShapeLayer({ id: 'bg', size: { width: 600, height: ROW_H } });
    const { runtime, container } = mount(tableLayer([plain]));

    runtime.seek(1);
    for (const cell of cellsNamed(container, 'bg')) {
      // Untouched by GSAP: still exactly the string TableBlock wrote.
      expect(cell.style.transform).toBe('translate(0px, 0px)');
    }
  });
});
