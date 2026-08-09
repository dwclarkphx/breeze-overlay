// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Table rendering, against a real DOM.
 *
 * The behaviors worth a test are the ones with an on-air failure mode: that a
 * re-sort moves the *existing* row elements rather than rebuilding them (or the
 * standings shuffle is a flicker), that a row leaving the data leaves the DOM,
 * and that data arriving over `update()` reaches the cells at all.
 *
 * happy-dom reports every `offsetWidth` as 0, so nothing here asserts on
 * measurement — that is what `rowsThatFit` is unit-tested for.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  createShapeLayer,
  createTableLayer,
  createTextLayer,
  type DataSet,
  type TableLayer,
} from '@breeze/schema';

import { TableBlock, type TableAnimator } from '../table.js';

/**
 * Records tweens instead of running them; nothing here waits on a clock.
 *
 * `set` writes the transform through to the element, because that is what GSAP
 * does and the position of a row is the thing most of these tests assert on. A
 * fake that only recorded the call would let a regression through in which rows
 * are never positioned at all.
 */
function fakeAnimator() {
  const tweens: Array<{ targets: unknown; vars: Record<string, unknown> }> = [];
  const sets: Array<{ targets: unknown; vars: Record<string, unknown> }> = [];

  const animator: TableAnimator = {
    to: (targets, vars) => {
      tweens.push({ targets, vars });
      return { kill: () => {} };
    },
    set: (targets, vars) => {
      sets.push({ targets, vars });
      if (typeof vars['y'] === 'number' && targets instanceof HTMLElement) {
        targets.style.transform = `translateY(${vars['y']}px)`;
      }
    },
  };

  return { animator, tweens, sets };
}

function makeLayer(overrides: Partial<TableLayer> = {}): TableLayer {
  return createTableLayer({
    id: 'standings',
    size: { width: 720, height: 400 },
    row: {
      height: 60,
      gap: 0,
      cells: [
        createShapeLayer({ id: 'bg', size: { width: 720, height: 60 } }),
        createTextLayer({ id: 'team', cell: 'team', size: { width: 400, height: 60 } }),
        createTextLayer({ id: 'w', cell: 'w', size: { width: 80, height: 60 } }),
      ],
    },
    data: { columns: [], rows: [] },
    ...overrides,
  });
}

function dataset(rows: Array<{ team: string; w: number }>): DataSet {
  return {
    id: 'standings',
    columns: [
      { key: 'team', type: 'string' },
      { key: 'w', type: 'number' },
    ],
    rows,
  };
}

function makeBlock(layer: TableLayer) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const { animator, tweens, sets } = fakeAnimator();
  const block = new TableBlock({
    layer,
    host,
    ctx: { doc: document, resolveAsset: (s) => s },
    animator,
    layerId: 'standings',
  });
  return { block, host, tweens, sets };
}

const rowEls = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>('.bz-table-row')];

const cellText = (row: HTMLElement) =>
  [...row.querySelectorAll<HTMLElement>('.bz-text-inner')].map((el) => el.textContent);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('rendering', () => {
  it('clones the template row once per data row', () => {
    const { block, host } = makeBlock(makeLayer());
    block.setDataSet(dataset([{ team: 'Mesa', w: 11 }, { team: 'Tempe', w: 9 }]));

    const rows = rowEls(host);
    expect(rows).toHaveLength(2);
    // Every cell layer is present in each clone, styled by the shared builder.
    expect(rows[0]!.querySelectorAll('.bz-layer')).toHaveLength(3);
  });

  it('writes each row into the cells bound to its columns', () => {
    const { block, host } = makeBlock(makeLayer());
    block.setDataSet(dataset([{ team: 'Mesa', w: 11 }, { team: 'Tempe', w: 9 }]));

    expect(cellText(rowEls(host)[0]!)).toEqual(['Mesa', '11']);
    expect(cellText(rowEls(host)[1]!)).toEqual(['Tempe', '9']);
  });

  it('positions rows by transform, one pitch apart', () => {
    const { block, host } = makeBlock(makeLayer({ row: { height: 60, gap: 8, cells: makeLayer().row.cells } }));
    block.setDataSet(dataset([{ team: 'Mesa', w: 11 }, { team: 'Tempe', w: 9 }]));

    expect(rowEls(host)[0]!.style.transform).toBe('translateY(0px)');
    expect(rowEls(host)[1]!.style.transform).toBe('translateY(68px)');
  });

  it('renders the authored snapshot before any data arrives', () => {
    // A table that is empty until the first push flashes blank on air, and an
    // export has nothing to embed.
    const layer = makeLayer({
      data: {
        columns: [{ key: 'team', type: 'string' }, { key: 'w', type: 'number' }],
        rows: [{ team: 'Placeholder', w: 0 }],
      },
    });
    const { host } = makeBlock(layer);
    expect(cellText(rowEls(host)[0]!)).toEqual(['Placeholder', '0']);
  });
});

describe('re-sorting', () => {
  it('moves the same elements rather than rebuilding them', () => {
    /*
     * The standings shuffle. If a re-sort tore the rows down and rebuilt them,
     * FLIP would have nothing to animate and the table would flicker — so the
     * test holds the element identities across the sort.
     */
    const layer = makeLayer({ transforms: [{ op: 'sort', key: 'w', dir: 'desc' }] });
    const { block, host } = makeBlock(layer);

    block.setDataSet(dataset([{ team: 'Mesa', w: 9 }, { team: 'Tempe', w: 11 }]));
    const before = rowEls(host);
    const mesaEl = before.find((el) => cellText(el)[0] === 'Mesa')!;

    block.setDataSet(dataset([{ team: 'Mesa', w: 14 }, { team: 'Tempe', w: 11 }]));
    const after = rowEls(host);

    expect(after).toHaveLength(2);
    // The same element, still carrying the same team — it moved, it was not
    // replaced. DOM order is deliberately not asserted: rows are positioned by
    // transform, so the elements stay in creation order and only their y moves.
    expect(after).toContain(mesaEl);
    expect(cellText(mesaEl)[0]).toBe('Mesa');
    expect(block.visibleRows.map((r) => r.team)).toEqual(['Mesa', 'Tempe']);
  });

  it('tweens a moving row to an absolute position, not a delta', () => {
    /*
     * GSAP owns `y` outright. The earlier shape kept the resting place in the
     * element's own transform and tweened a delta on top, baking the result back
     * when the tween ended — but GSAP rewrites the whole transform string from
     * its own cache, so the bake was wiped and re-sorted rows snapped to the top
     * of the table. An absolute target has no bake step to get wrong.
     */
    const layer = makeLayer({ transforms: [{ op: 'sort', key: 'w', dir: 'desc' }] });
    const { block, host, tweens } = makeBlock(layer);

    block.setDataSet(dataset([{ team: 'Mesa', w: 9 }, { team: 'Tempe', w: 11 }]));
    const mesaEl = rowEls(host).find((el) => cellText(el)[0] === 'Mesa')!;
    tweens.length = 0;

    block.setDataSet(dataset([{ team: 'Mesa', w: 14 }, { team: 'Tempe', w: 11 }]));

    // Mesa was on row 1 and is now row 0 — the target is 0, not -60.
    const mesaTween = tweens.find((t) => t.targets === mesaEl)!;
    expect(mesaTween.vars['y']).toBe(0);
    // Retargetable, so a tick landing mid-flight redirects rather than races.
    expect(mesaTween.vars['overwrite']).toBe('auto');
  });

  it('tweens the rows whose position changed, and only those', () => {
    const layer = makeLayer({ transforms: [{ op: 'sort', key: 'w', dir: 'desc' }] });
    const { block, tweens } = makeBlock(layer);

    block.setDataSet(dataset([{ team: 'Mesa', w: 9 }, { team: 'Tempe', w: 11 }]));
    tweens.length = 0;
    block.setDataSet(dataset([{ team: 'Mesa', w: 14 }, { team: 'Tempe', w: 11 }]));

    // Both rows swapped places, so both move; a third, unmoved row would not.
    expect(tweens.filter((t) => 'y' in t.vars)).toHaveLength(2);
  });

  it('snaps instead of tweening when the flip duration is zero', () => {
    const layer = makeLayer({
      transforms: [{ op: 'sort', key: 'w', dir: 'desc' }],
      flip: { duration: 0 },
    });
    const { block, host, tweens } = makeBlock(layer);

    block.setDataSet(dataset([{ team: 'Mesa', w: 9 }, { team: 'Tempe', w: 11 }]));
    const mesaEl = rowEls(host).find((el) => cellText(el)[0] === 'Mesa')!;
    tweens.length = 0;
    block.setDataSet(dataset([{ team: 'Mesa', w: 14 }, { team: 'Tempe', w: 11 }]));

    expect(tweens.filter((t) => 'y' in t.vars)).toHaveLength(0);
    // Snapped, not left where it was.
    expect(mesaEl.style.transform).toBe('translateY(0px)');
  });

  it('removes rows that left the data', () => {
    const { block, host } = makeBlock(makeLayer());
    block.setDataSet(dataset([{ team: 'Mesa', w: 11 }, { team: 'Tempe', w: 9 }]));
    block.setDataSet(dataset([{ team: 'Mesa', w: 11 }]));

    expect(rowEls(host)).toHaveLength(1);
    expect(cellText(rowEls(host)[0]!)[0]).toBe('Mesa');
  });
});

describe('paging', () => {
  const eight = dataset(
    Array.from({ length: 8 }, (_, i) => ({ team: `Team ${i + 1}`, w: 10 - i })),
  );

  it('shows one page and reports the overflow', () => {
    const { block, host } = makeBlock(makeLayer({ rowsPerPage: 3 }));
    block.setDataSet(eight);

    expect(rowEls(host)).toHaveLength(3);
    expect(block.pageCount).toBe(3);
    expect(block.overflow).toBe(true);
  });

  it('advances a page and wraps back to the first', () => {
    const { block, host } = makeBlock(makeLayer({ rowsPerPage: 3 }));
    block.setDataSet(eight);

    expect(block.nextPage()).toBe(true);
    expect(cellText(rowEls(host)[0]!)[0]).toBe('Team 4');

    block.nextPage(); // page 3 — two rows
    expect(rowEls(host)).toHaveLength(2);

    expect(block.nextPage()).toBe(true);
    expect(block.currentPage).toBe(0);
  });

  it('refuses to page when everything is on one page', () => {
    // False is how the runtime knows NEXT was not consumed and must fall
    // through to the STOP-marker behavior.
    const { block } = makeBlock(makeLayer({ rowsPerPage: 20 }));
    block.setDataSet(eight);
    expect(block.nextPage()).toBe(false);
  });

  it('drops back to the first page when a feed shrinks under it', () => {
    const { block } = makeBlock(makeLayer({ rowsPerPage: 3 }));
    block.setDataSet(eight);
    block.nextPage();
    block.nextPage();
    expect(block.currentPage).toBe(2);

    block.setDataSet(dataset([{ team: 'Mesa', w: 11 }]));
    expect(block.currentPage).toBe(0);
  });
});

describe('change detection', () => {
  it('reports whether the rendered view actually changed', () => {
    /*
     * The runtime uses this to decide whether to rebuild the reveal track. A
     * poll that returns identical rows must not count as a change, or a table
     * on air re-reveals itself every interval.
     */
    const { block } = makeBlock(makeLayer());
    expect(block.setDataSet(dataset([{ team: 'Mesa', w: 11 }]))).toBe(true);
    expect(block.setDataSet(dataset([{ team: 'Mesa', w: 11 }]))).toBe(false);
    expect(block.setDataSet(dataset([{ team: 'Mesa', w: 12 }]))).toBe(true);
  });

  it('ignores rows outside the current page', () => {
    const { block } = makeBlock(makeLayer({ rowsPerPage: 1 }));
    block.setDataSet(dataset([{ team: 'Mesa', w: 11 }, { team: 'Tempe', w: 9 }]));
    // Row two changed; row one, the only one on screen, did not.
    expect(block.setDataSet(dataset([{ team: 'Mesa', w: 11 }, { team: 'Tempe', w: 4 }]))).toBe(false);
  });
});

describe('teardown', () => {
  it('leaves no rows behind', () => {
    const { block, host } = makeBlock(makeLayer());
    block.setDataSet(dataset([{ team: 'Mesa', w: 11 }]));
    block.destroy();
    expect(rowEls(host)).toHaveLength(0);
  });
});
