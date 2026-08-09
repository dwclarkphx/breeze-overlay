// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The DataSet contract. Every adapter normalizes into this shape and every
 * consumer reads it, so the transform pipeline is the one piece of Phase-6 logic
 * that a bug in would be visible on air in every graphic at once.
 */

import { describe, expect, it } from 'vitest';

import {
  applyTransforms,
  coerce,
  conform,
  inferColumns,
  scalarDataSet,
  type DataSet,
} from '../data.js';

const standings: DataSet = {
  id: 'standings',
  columns: [
    { key: 'team', label: 'Team', type: 'string' },
    { key: 'w', label: 'W', type: 'number' },
    { key: 'l', label: 'L', type: 'number' },
  ],
  rows: [
    { team: 'Chandler', w: 9, l: 4 },
    { team: 'Mesa', w: 11, l: 2 },
    { team: 'Gilbert', w: 7, l: 6 },
    { team: 'Tempe', w: 11, l: 3 },
  ],
};

describe('coerce', () => {
  it('parses numbers out of the strings a spreadsheet produces', () => {
    expect(coerce('1,234', 'number')).toBe(1234);
    expect(coerce(' 42 ', 'number')).toBe(42);
    expect(coerce('$1,999', 'number')).toBe(1999);
  });

  it('keeps unparseable text as text rather than turning it into NaN', () => {
    // A NaN in a numeric column sorts unpredictably and renders as "NaN" on
    // air. The honest fallback is the text the operator actually typed.
    expect(coerce('TBD', 'number')).toBe('TBD');
  });

  it('treats an absent value as null, not as zero or empty string', () => {
    expect(coerce(null, 'number')).toBeNull();
    expect(coerce(undefined, 'string')).toBeNull();
  });

  it('accepts the spellings of yes and no that feeds actually use', () => {
    expect(coerce('YES', 'boolean')).toBe(true);
    expect(coerce('0', 'boolean')).toBe(false);
    expect(coerce('maybe', 'boolean')).toBe('maybe');
  });
});

describe('inferColumns', () => {
  it('collects keys across every row, not just the first', () => {
    // A feed whose first entry omits an optional field would otherwise drop
    // that column for every row behind it.
    const columns = inferColumns([{ a: 1 }, { a: 2, b: 'x' }]);
    expect(columns.map((c) => c.key)).toEqual(['a', 'b']);
  });

  it('widens a column to text when its values disagree', () => {
    const columns = inferColumns([{ score: 3 }, { score: 'TBD' }]);
    expect(columns[0]!.type).toBe('string');
  });
});

describe('conform', () => {
  it('drops keys no column declares', () => {
    const rows = conform([{ team: 'Mesa', junk: 'x' } as never], standings.columns);
    expect(Object.keys(rows[0]!)).toEqual(['team', 'w', 'l']);
  });
});

describe('applyTransforms', () => {
  it('returns the same object when there is nothing to do', () => {
    // Identity matters: the runtime compares rendered signatures to decide
    // whether to re-render, and a fresh object every poll would defeat that.
    expect(applyTransforms(standings, [])).toBe(standings);
  });

  it('sorts numerically on a numeric column', () => {
    const out = applyTransforms(standings, [{ op: 'sort', key: 'w', dir: 'desc' }]);
    expect(out.rows.map((r) => r.w)).toEqual([11, 11, 9, 7]);
  });

  it('keeps author order for ties, so a rank is reproducible', () => {
    const out = applyTransforms(standings, [{ op: 'sort', key: 'w', dir: 'desc' }]);
    expect(out.rows.slice(0, 2).map((r) => r.team)).toEqual(['Mesa', 'Tempe']);
  });

  it('sorts text naturally — "Team 10" after "Team 9"', () => {
    const data: DataSet = {
      id: 'x',
      columns: [{ key: 'name', type: 'string' }],
      rows: [{ name: 'Team 10' }, { name: 'Team 9' }, { name: 'Team 1' }],
    };
    const out = applyTransforms(data, [{ op: 'sort', key: 'name' }]);
    expect(out.rows.map((r) => r.name)).toEqual(['Team 1', 'Team 9', 'Team 10']);
  });

  it('sorts nulls last in both directions', () => {
    const data: DataSet = {
      id: 'x',
      columns: [{ key: 'pts', type: 'number' }],
      rows: [{ pts: 5 }, { pts: null }, { pts: 9 }],
    };
    expect(applyTransforms(data, [{ op: 'sort', key: 'pts' }]).rows.map((r) => r.pts))
      .toEqual([5, 9, null]);
    expect(applyTransforms(data, [{ op: 'sort', key: 'pts', dir: 'desc' }]).rows.map((r) => r.pts))
      .toEqual([9, 5, null]);
  });

  it('filters with the comparisons the panel offers', () => {
    expect(applyTransforms(standings, [{ op: 'filter', key: 'w', cmp: 'gte', value: 9 }]).rows)
      .toHaveLength(3);
    expect(applyTransforms(standings, [{ op: 'filter', key: 'team', cmp: 'contains', value: 'e' }]).rows
      .map((r) => r.team)).toEqual(['Chandler', 'Mesa', 'Gilbert', 'Tempe']);
    expect(applyTransforms(standings, [{ op: 'filter', key: 'team', cmp: 'startsWith', value: 'me' }]).rows
      .map((r) => r.team)).toEqual(['Mesa']);
  });

  it('limits and offsets in the order given', () => {
    const out = applyTransforms(standings, [{ op: 'offset', n: 1 }, { op: 'limit', n: 2 }]);
    expect(out.rows.map((r) => r.team)).toEqual(['Mesa', 'Gilbert']);
  });

  it('stamps rank at the point in the pipeline where it runs', () => {
    /*
     * The whole reason rank is a pipeline step. Sort by wins, rank, then
     * re-sort alphabetically: the table reads A–Z and still shows each team's
     * league position. A rank computed at render time could not do this.
     */
    const out = applyTransforms(standings, [
      { op: 'sort', key: 'w', dir: 'desc' },
      { op: 'rank' },
      { op: 'sort', key: 'team' },
    ]);
    expect(out.rows.map((r) => [r.team, r.rank])).toEqual([
      ['Chandler', 3],
      ['Gilbert', 4],
      ['Mesa', 1],
      ['Tempe', 2],
    ]);
  });

  it('adds a column for the rank so cells can bind to it', () => {
    const out = applyTransforms(standings, [{ op: 'rank', as: 'pos' }]);
    expect(out.columns.map((c) => c.key)).toContain('pos');
  });

  it('never mutates the source data', () => {
    const before = JSON.stringify(standings);
    applyTransforms(standings, [{ op: 'sort', key: 'w' }, { op: 'rank' }, { op: 'limit', n: 1 }]);
    expect(JSON.stringify(standings)).toBe(before);
  });
});

describe('scalarDataSet', () => {
  it('makes a one-row set rather than a second shape', () => {
    const set = scalarDataSet('wx', { temp: 41, condition: 'Sunny' });
    expect(set.rows).toHaveLength(1);
    expect(set.columns.find((c) => c.key === 'temp')?.type).toBe('number');
  });
});
