// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Wave 4 in the schema: `unpivot`, and `TableLayer.follow`.
 *
 * Both directions again, for the cycle suite's reason: a validator only ever
 * asserted to reject cannot fail, because a fixture with an unrelated fault
 * rejects too.
 */

import { describe, expect, it } from 'vitest';

import { applyTransforms, unpivot, type DataSet } from '../data.js';
import { createComposition, createTableLayer, createTextLayer } from '../factory.js';
import type { Composition, TableFollow, TableLayer } from '../types.js';
import { validateComposition } from '../validate.js';

/** A wide sheet: one row a city, one column a day. */
const WEEK: DataSet = {
  id: 'week',
  columns: [
    { key: 'place', type: 'string' },
    { key: 'mon', label: 'Mon', type: 'number' },
    { key: 'tue', label: 'Tue', type: 'number' },
    { key: 'note', type: 'string' },
  ],
  rows: [
    { place: 'Phoenix', mon: 104, tue: 106, note: 'hot' },
    { place: 'Flagstaff', mon: 78, tue: null, note: 'cool' },
  ],
};

describe('unpivot', () => {
  it('folds the named columns into rows, row-major, keeping one place together', () => {
    const out = unpivot(WEEK, { op: 'unpivot', columns: ['mon', 'tue'], keep: ['place'] });
    expect(out.columns).toEqual([
      { key: 'place', type: 'string' },
      { key: 'key', type: 'string' },
      { key: 'value', type: 'number' },
    ]);
    expect(out.rows).toEqual([
      { place: 'Phoenix', key: 'Mon', value: 104 },
      { place: 'Phoenix', key: 'Tue', value: 106 },
      { place: 'Flagstaff', key: 'Mon', value: 78 },
      { place: 'Flagstaff', key: 'Tue', value: null },
    ]);
  });

  it('folds every column not kept when no columns are named', () => {
    const out = unpivot(WEEK, { op: 'unpivot', keep: ['place'] });
    expect(out.rows).toHaveLength(6);
    expect(out.rows.map((r) => r['key'])).toEqual(['Mon', 'Tue', 'note', 'Mon', 'Tue', 'note']);
  });

  it('carries every unfolded column when keep is absent', () => {
    const out = unpivot(WEEK, { op: 'unpivot', columns: ['mon', 'tue'] });
    expect(out.columns.map((c) => c.key)).toEqual(['place', 'note', 'key', 'value']);
    expect(out.rows[0]).toEqual({ place: 'Phoenix', note: 'hot', key: 'Mon', value: 104 });
  });

  it('types the value column as text when the folded columns disagree', () => {
    const out = unpivot(WEEK, { op: 'unpivot', columns: ['mon', 'note'], keep: ['place'] });
    expect(out.columns.find((c) => c.key === 'value')?.type).toBe('string');
  });

  it('uses the column key where there is no label, and honours renamed outputs', () => {
    const out = unpivot(WEEK, { op: 'unpivot', columns: ['note'], keep: ['place'], key: 'day', value: 'hi' });
    expect(out.rows[0]).toEqual({ place: 'Phoenix', day: 'note', hi: 'hot' });
  });

  it('runs inside the pipeline, so later transforms see the folded rows', () => {
    const out = applyTransforms(WEEK, [
      { op: 'unpivot', columns: ['mon', 'tue'], keep: ['place'] },
      { op: 'filter', key: 'value', cmp: 'notEmpty' },
      { op: 'sort', key: 'value', dir: 'desc' },
    ]);
    expect(out.rows.map((r) => r['value'])).toEqual([106, 104, 78]);
  });

  it('leaves the source untouched', () => {
    unpivot(WEEK, { op: 'unpivot', keep: ['place'] });
    expect(WEEK.rows[0]).toEqual({ place: 'Phoenix', mon: 104, tue: 106, note: 'hot' });
  });
});

function table(init: Partial<TableLayer> & { id: string }, cell = 'value'): TableLayer {
  return createTableLayer({
    size: { width: 400, height: 200 },
    row: {
      height: 40,
      cells: [createTextLayer({ id: `${init.id}-cell`, cell, size: { width: 400, height: 40 } })],
    },
    data: { columns: WEEK.columns, rows: WEEK.rows },
    ...init,
  });
}

function comp(layers: TableLayer[]): Composition {
  return createComposition({ id: 'c1', name: 'C', duration: 2, layers });
}

const issuesAt = (c: Composition, needle: string) =>
  validateComposition(c).errors.filter((e) => e.path.includes(needle));

describe('unpivot in the validator', () => {
  it('declares the key and value columns, so a cell may read them', () => {
    const c = comp([table({ id: 't1', transforms: [{ op: 'unpivot', keep: ['place'] }] })]);
    expect(validateComposition(c).valid).toBe(true);
  });

  it('declares renamed outputs, not the defaults', () => {
    const c = comp([table({ id: 't1', transforms: [{ op: 'unpivot', keep: ['place'], value: 'hi' }] })]);
    expect(validateComposition(c).errors.some((e) => e.message.includes('value'))).toBe(true);
  });

  it('forgets the columns it folded away — a cell still reading one would render empty', () => {
    const c = comp([table({ id: 't1', transforms: [{ op: 'unpivot', keep: ['place'] }] }, 'mon')]);
    expect(validateComposition(c).errors).toContainEqual(expect.objectContaining({
      message: expect.stringContaining('unknown column "mon"'),
    }));
    const kept = comp([table({ id: 't1', transforms: [{ op: 'unpivot', keep: ['place'] }] }, 'place')]);
    expect(validateComposition(kept).valid).toBe(true);
  });

  it('refuses a name column and a value column with the same name', () => {
    const c = comp([table({ id: 't1', transforms: [{ op: 'unpivot', keep: ['place'], key: 'x', value: 'x' }] }, 'x')]);
    expect(validateComposition(c).valid).toBe(false);
  });

  it('does not check cells on a live table with no snapshot, whatever the transforms add', () => {
    const live = table({ id: 't1', source: 'wide', transforms: [{ op: 'unpivot', keep: ['place'] }] }, 'place');
    delete (live as { data?: unknown }).data;
    expect(validateComposition(comp([live])).valid).toBe(true);
  });

  it('refuses an empty column list — fold nothing is a mistake, not a choice', () => {
    const c = comp([table({ id: 't1', transforms: [{ op: 'unpivot', columns: [] }] })]);
    expect(validateComposition(c).valid).toBe(false);
  });

  it('refuses unknown keys on the transform', () => {
    const c = comp([table({ id: 't1', transforms: [{ op: 'unpivot', into: 'x' } as never] })]);
    expect(validateComposition(c).valid).toBe(false);
  });
});

describe('follow', () => {
  const rotation = () => table({ id: 'rot', binding: 'cities' }, 'place');
  const tile = (follow: unknown) =>
    table({ id: 'tile', binding: 'today', follow: follow as TableFollow }, 'place');

  it('accepts a follower naming a table in the same composition, by binding or id', () => {
    expect(validateComposition(comp([rotation(), tile({ table: 'cities', column: 'place' })])).valid).toBe(true);
    expect(validateComposition(comp([rotation(), tile({ table: 'rot', column: 'place' })])).valid).toBe(true);
  });

  it('accepts a leader column', () => {
    const c = comp([rotation(), tile({ table: 'cities', column: 'place', leaderColumn: 'place' })]);
    expect(validateComposition(c).valid).toBe(true);
  });

  it('only warns about a leader it cannot see — it may be in the parent', () => {
    const result = validateComposition(comp([tile({ table: 'main.cities', column: 'place' })]));
    expect(result.valid).toBe(true);
    expect(result.errors).toContainEqual(expect.objectContaining({
      path: expect.stringContaining('/follow/table'),
      severity: 'warning',
    }));
  });

  it('refuses a table that follows itself, by id or by binding', () => {
    expect(issuesAt(comp([tile({ table: 'tile', column: 'place' })]), '/follow/table')[0]?.severity).toBeUndefined();
    expect(validateComposition(comp([tile({ table: 'today', column: 'place' })])).valid).toBe(false);
  });

  it('refuses a follow with no column, or with unknown keys', () => {
    expect(validateComposition(comp([rotation(), tile({ table: 'cities' })])).valid).toBe(false);
    expect(validateComposition(comp([rotation(), tile({ table: 'cities', column: '' })])).valid).toBe(false);
    expect(validateComposition(comp([rotation(), tile({ table: 'cities', column: 'place', by: 'x' })])).valid).toBe(false);
  });

  it('survives the factory', () => {
    expect(tile({ table: 'cities', column: 'place' }).follow).toEqual({ table: 'cities', column: 'place' });
  });
});
