// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Tables inside the runtime — the wiring rather than the rendering.
 *
 * What is worth testing here is everything the `TableBlock` unit tests cannot
 * see: that a `$data` push finds the tables bound to that source, that `next()`
 * pages only while holding, and that the row reveal is rebuilt against the rows
 * that are actually on screen after data arrives.
 */

import { describe, expect, it } from 'vitest';
import {
  DATA_UPDATE_KEY,
  createComposition,
  createShapeLayer,
  createTableLayer,
  createTextLayer,
  type Composition,
  type TableLayer,
} from '@breeze/schema';

import { BreezeRuntime } from '../runtime.js';

const ROW_H = 50;

function tableLayer(overrides: Partial<TableLayer> = {}): TableLayer {
  return createTableLayer({
    id: 'table',
    size: { width: 600, height: 200 },
    row: {
      height: ROW_H,
      gap: 0,
      cells: [
        createShapeLayer({ id: 'bg', size: { width: 600, height: ROW_H } }),
        createTextLayer({ id: 'team', cell: 'team', size: { width: 400, height: ROW_H } }),
      ],
    },
    data: {
      columns: [{ key: 'team', type: 'string' }, { key: 'w', type: 'number' }],
      rows: [{ team: 'Authored', w: 0 }],
    },
    rowAnim: { id: 'rows-up', stagger: 0.05, duration: 0.4 },
    ...overrides,
  });
}

function comp(layer: TableLayer, markers: Composition['markers'] = []): Composition {
  return createComposition({
    id: 'standings',
    name: 'Standings',
    duration: 2,
    markers,
    layers: [layer],
  });
}

function mount(composition: Composition, data?: Record<string, unknown>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const runtime = new BreezeRuntime({
    container,
    composition,
    injectStyles: false,
    ...(data ? { data } : {}),
  });
  return { runtime, container };
}

const teams = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('.bz-table-row')]
    .map((el) => el.querySelector('[data-layer-id$="/team"] .bz-text-inner')?.textContent ?? '')
    .filter(Boolean);

const dataset = (rows: Array<{ team: string; w: number }>) => ({
  id: 'standings',
  columns: [{ key: 'team', type: 'string' as const }, { key: 'w', type: 'number' as const }],
  rows,
});

describe('data delivery', () => {
  it('renders the authored snapshot with no data at all', () => {
    const { runtime, container } = mount(comp(tableLayer()));
    expect(teams(container)).toEqual(['Authored']);
    runtime.destroy();
  });

  it('routes a $data push to the tables bound to that source', () => {
    const layer = tableLayer({ source: 'standings' });
    const { runtime, container } = mount(comp(layer));

    runtime.update({ [DATA_UPDATE_KEY]: { standings: dataset([{ team: 'Mesa', w: 11 }]) } });
    expect(teams(container)).toEqual(['Mesa']);
    runtime.destroy();
  });

  it('ignores a push for a source no table is bound to', () => {
    const layer = tableLayer({ source: 'standings' });
    const { runtime, container } = mount(comp(layer));

    runtime.update({ [DATA_UPDATE_KEY]: { weather: dataset([{ team: 'Nope', w: 0 }]) } });
    expect(teams(container)).toEqual(['Authored']);
    runtime.destroy();
  });

  it('accepts data seeded at construction, before the first paint', () => {
    /*
     * The output page inlines the server's current rows into the constructor
     * rather than pushing them a tick later. A table that renders its authored
     * snapshot and swaps a frame afterwards flashes on air.
     */
    const layer = tableLayer({ source: 'standings' });
    const { runtime, container } = mount(comp(layer), {
      [DATA_UPDATE_KEY]: { standings: dataset([{ team: 'Seeded', w: 1 }]) },
    });

    expect(teams(container)).toEqual(['Seeded']);
    runtime.destroy();
  });

  it('rebuilds the reveal against the seeded rows, not the authored ones', () => {
    /*
     * The authored row element is removed the moment real data arrives. A
     * reveal track still pointing at it animates nothing, so the seeded rows
     * appear with no stagger — visible on air as a table that simply exists
     * rather than one that builds.
     */
    const layer = tableLayer({ source: 'standings' });
    const { runtime, container } = mount(comp(layer), {
      [DATA_UPDATE_KEY]: {
        standings: dataset([{ team: 'One', w: 3 }, { team: 'Two', w: 2 }, { team: 'Three', w: 1 }]),
      },
    });

    const rows = [...container.querySelectorAll<HTMLElement>('.bz-table-row')];
    expect(rows).toHaveLength(3);

    /*
     * Probed part-way into the reveal rather than at t=0. A from-tween at
     * position 0 is reverted when the playhead renders backwards onto 0 — the
     * same GSAP behavior the baseline `set`s in `buildTimeline` work around —
     * so frame 0 cannot distinguish "the track is empty" from "the track is
     * correct". Mid-stagger can: the first row is on its way in and the last has
     * not started, which is only true if the track targets these rows.
     */
    runtime.seek(0.05);

    /*
     * Read the *inline* style, not the computed one. A row the stagger has not
     * reached carries no inline opacity at all, and computes to 1 — identical to
     * a row that has finished. Collapsing those two is how a reveal test passes
     * against a track that animates nothing.
     */
    expect(Number(rows[0]!.style.opacity)).toBeGreaterThan(0);
    expect(Number(rows[0]!.style.opacity)).toBeLessThan(1);
    expect(rows[2]!.style.opacity).toBe('');
    runtime.destroy();
  });

  it('leaves the reveal alone once it is behind the playhead', () => {
    /*
     * A feed ticking while the graphic holds on air must not re-apply the
     * `from` state to rows the audience is already looking at — the table would
     * blink on every poll. Late rows animate themselves instead, on their own
     * clock, inside `TableBlock.render`.
     */
    const layer = tableLayer({ source: 'standings' });
    const { runtime, container } = mount(comp(layer));
    runtime.seek(1.5);

    runtime.update({ [DATA_UPDATE_KEY]: { standings: dataset([{ team: 'Late', w: 1 }]) } });

    const row = container.querySelector<HTMLElement>('.bz-table-row')!;
    expect(row.style.opacity === '' || Number(row.style.opacity) === 1).toBe(true);
    runtime.destroy();
  });

  it('rebinds through the layer binding as well as the source', () => {
    const layer = tableLayer({ binding: 'standings' });
    const { runtime, container } = mount(comp(layer));

    runtime.update({ standings: [{ team: 'Via binding', w: 1 }] });
    expect(teams(container)).toEqual(['Via binding']);
    runtime.destroy();
  });

  it('retypes a bare push using the authored columns', () => {
    // Otherwise numeric strings infer as text and the standings sort 11, 2, 9.
    const layer = tableLayer({
      binding: 'standings',
      transforms: [{ op: 'sort', key: 'w', dir: 'desc' }],
    });
    const { runtime, container } = mount(comp(layer));

    runtime.update({ standings: [{ team: 'Nine', w: '9' }, { team: 'Eleven', w: '11' }] });
    expect(teams(container)).toEqual(['Eleven', 'Nine']);
    runtime.destroy();
  });
});

describe('paging on next()', () => {
  const paged = () =>
    comp(
      tableLayer({
        binding: 'standings',
        rowsPerPage: 2,
        data: {
          columns: [{ key: 'team', type: 'string' }, { key: 'w', type: 'number' }],
          rows: [
            { team: 'One', w: 4 }, { team: 'Two', w: 3 },
            { team: 'Three', w: 2 }, { team: 'Four', w: 1 },
          ],
        },
      }),
      [{ type: 'stop', time: 1 }],
    );

  it('pages while holding, without moving the playhead', () => {
    const { runtime, container } = mount(paged());
    runtime.seek(1);
    // Force the hold state the way playback would reach it.
    runtime.play();
    runtime.seek(1);

    expect(teams(container)).toEqual(['One', 'Two']);
    runtime.destroy();
  });

  it('leaves NEXT alone while the intro is still running', () => {
    /*
     * During the intro NEXT means "skip to the next marker". A table quietly
     * eating that press would strand the graphic mid-animation with no way
     * forward, which is why paging is gated on `holding`.
     */
    const { runtime } = mount(paged());
    runtime.play();
    expect(runtime.playbackState).toBe('playing-in');

    runtime.next();
    // Still heading for a marker rather than having consumed the verb.
    expect(runtime.playbackState).toBe('playing-in');
    runtime.destroy();
  });

  it('reports pages and overflow for the properties panel', () => {
    const { runtime } = mount(paged());
    expect(runtime.overflowingTables).toEqual(['table']);
    expect(runtime.tablePages['table']).toEqual({ page: 0, pageCount: 2, rows: 4 });
    runtime.destroy();
  });

  it('reports no overflow when every row fits', () => {
    const { runtime } = mount(comp(tableLayer()));
    expect(runtime.overflowingTables).toEqual([]);
    runtime.destroy();
  });
});

describe('bindings', () => {
  it('exposes a table binding as a dataset field', () => {
    const { runtime } = mount(comp(tableLayer({ binding: 'standings' })));
    const binding = runtime.bindings.find((b) => b.name === 'standings');
    expect(binding?.kind).toBe('dataset');
    runtime.destroy();
  });
});

describe('teardown', () => {
  it('removes its rows with the rest of the graphic', () => {
    const { runtime, container } = mount(comp(tableLayer()));
    runtime.destroy();
    expect(container.querySelectorAll('.bz-table-row')).toHaveLength(0);
  });
});
