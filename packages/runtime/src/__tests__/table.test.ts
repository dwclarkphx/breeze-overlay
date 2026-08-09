// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Table layer — the pure half. Paging arithmetic, row identity and the payload
 * coercion that lets an operator, a REST caller and a playout server all push
 * data at the same layer.
 */

import { describe, expect, it } from 'vitest';

import {
  paging,
  resolveRowAnim,
  rowAnimDuration,
  rowKey,
  rowOffset,
  rowsThatFit,
  toDataSet,
} from '../table.js';

const columns = [
  { key: 'team', type: 'string' as const },
  { key: 'w', type: 'number' as const },
];

describe('rowsThatFit', () => {
  it('requires the last row to fit whole', () => {
    // Half a row peeking out of the bottom reads as a rendering fault; on air
    // there is no scrollbar to explain it.
    expect(rowsThatFit(200, 60)).toBe(3);
    expect(rowsThatFit(179, 60)).toBe(2);
  });

  it('does not charge the last row for a trailing gap', () => {
    // 3 rows of 60 with 10px gaps occupy 200px, not 210.
    expect(rowsThatFit(200, 60, 10)).toBe(3);
    expect(rowsThatFit(199, 60, 10)).toBe(2);
  });

  it('is zero rather than negative for a degenerate box', () => {
    expect(rowsThatFit(0, 60)).toBe(0);
    expect(rowsThatFit(200, 0)).toBe(0);
  });
});

describe('paging', () => {
  it('fills the box when no explicit page size is set', () => {
    const p = paging(10, 200, 60);
    expect(p.perPage).toBe(3);
    expect(p.pageCount).toBe(4);
    expect(p.overflow).toBe(true);
  });

  it('honours an explicit page size even when it overflows the box', () => {
    /*
     * `rowsPerPage` is an authoring instruction. Silently clamping it to the box
     * would drop rows the author asked for, and the loss stays invisible until
     * the one show where the feed runs long — so it is honoured and flagged.
     */
    const p = paging(10, 200, 60, 0, 5);
    expect(p.perPage).toBe(5);
    expect(p.overflow).toBe(true);
  });

  it('reports no overflow when everything fits on one page', () => {
    expect(paging(3, 200, 60).overflow).toBe(false);
    expect(paging(3, 200, 60).pageCount).toBe(1);
  });

  it('never reports zero pages for an empty table', () => {
    expect(paging(0, 200, 60).pageCount).toBe(1);
  });
});

describe('rowOffset', () => {
  it('steps by height plus gap', () => {
    expect(rowOffset(0, 60, 8)).toBe(0);
    expect(rowOffset(2, 60, 8)).toBe(136);
  });
});

describe('rowKey', () => {
  it('keys on the first text column, so a re-sort can FLIP', () => {
    expect(rowKey({ team: 'Mesa', w: 11 }, columns)).toBe(rowKey({ team: 'Mesa', w: 12 }, columns));
  });

  it('distinguishes different teams', () => {
    expect(rowKey({ team: 'Mesa', w: 11 }, columns)).not.toBe(rowKey({ team: 'Tempe', w: 11 }, columns));
  });

  it('falls back to the whole row when the key column is blank', () => {
    const a = rowKey({ team: '', w: 1 }, columns);
    const b = rowKey({ team: '', w: 2 }, columns);
    expect(a).not.toBe(b);
  });
});

describe('resolveRowAnim', () => {
  it('is null for none, absent and unknown presets', () => {
    expect(resolveRowAnim(undefined)).toBeNull();
    expect(resolveRowAnim({ id: 'none' })).toBeNull();
    expect(resolveRowAnim({ id: 'rows-spin' as never })).toBeNull();
  });

  it('lets a layer override timings without restating the preset', () => {
    const anim = resolveRowAnim({ id: 'rows-up', stagger: 0.2 })!;
    expect(anim.stagger).toBe(0.2);
    expect(anim.duration).toBe(0.45);
  });

  it('accepts a zero stagger rather than treating it as absent', () => {
    // 0 means "animate the rows together", which is a real choice; a naive
    // `?? default` would silently reinstate the stagger.
    expect(resolveRowAnim({ id: 'rows-up', stagger: 0 })!.stagger).toBe(0);
  });
});

describe('rowAnimDuration', () => {
  it('is the last row finishing, not the first', () => {
    const anim = resolveRowAnim({ id: 'rows-up', stagger: 0.1, duration: 0.4 })!;
    expect(rowAnimDuration(anim, 5)).toBeCloseTo(0.8, 5);
  });

  it('is zero with no rows or no reveal', () => {
    expect(rowAnimDuration(null, 10)).toBe(0);
    expect(rowAnimDuration(resolveRowAnim({ id: 'rows-up' }), 0)).toBe(0);
  });
});

describe('toDataSet', () => {
  it('accepts a bare array of rows — what a JSON feed pushes', () => {
    const set = toDataSet([{ team: 'Mesa', w: 11 }], 'x')!;
    expect(set.rows).toHaveLength(1);
    expect(set.columns.map((c) => c.key)).toEqual(['team', 'w']);
  });

  it('accepts a full DataSet — what our own control panel pushes', () => {
    const set = toDataSet({ columns, rows: [{ team: 'Mesa', w: '11' }] }, 'x')!;
    expect(set.rows[0]!.w).toBe(11);
  });

  it('accepts a lone object as a one-row set', () => {
    const set = toDataSet({ temp: 41 }, 'wx')!;
    expect(set.rows).toEqual([{ temp: 41 }]);
  });

  it('lets declared columns retype a payload that arrived untyped', () => {
    /*
     * The failure this prevents: a playout server pushes bare rows with numeric
     * strings, the columns are inferred as text, and the standings sort
     * alphabetically — 11, 2, 9 — live on air.
     */
    const set = toDataSet([{ team: 'Mesa', w: '11' }, { team: 'Tempe', w: '9' }], 'x', columns)!;
    expect(set.rows.map((r) => r.w)).toEqual([11, 9]);
  });

  it('is null for values that are not data', () => {
    expect(toDataSet(null, 'x')).toBeNull();
    expect(toDataSet('nope', 'x')).toBeNull();
  });
});
