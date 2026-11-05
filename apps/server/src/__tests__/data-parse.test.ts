// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Adapter parsing. These are the payload shapes that actually turn up: a Google
 * Sheet's published CSV, a REST feed with the rows buried a few levels down, and
 * the TSV a spreadsheet puts on the clipboard.
 */

import { describe, expect, it } from 'vitest';

import { checkSportTable, sportDataColumns, sportRuleset, sportTemplate, type DataColumn } from '@breeze/schema';

import {
  columnMatchName,
  columnMatchWarning,
  csvToDataSet,
  gridToDataSet,
  guessRowPath,
  matchDeclaredColumns,
  type ColumnMatch,
  headerToKey,
  inferColumnsFromRows,
  jsonToDataSet,
  parseDelimited,
  resolvePath,
  sniffDelimiter,
} from '../data/parse.js';

describe('parseDelimited', () => {
  it('reads a plain sheet', () => {
    expect(parseDelimited('team,w\nMesa,11\nTempe,9')).toEqual([
      ['team', 'w'],
      ['Mesa', '11'],
      ['Tempe', '9'],
    ]);
  });

  it('keeps a quoted comma inside its field', () => {
    // A regex split on commas gets "Smith, Jr." wrong, and a name is exactly
    // the sort of field that has one.
    expect(parseDelimited('name,role\n"Smith, Jr.",Reporter')).toEqual([
      ['name', 'role'],
      ['Smith, Jr.', 'Reporter'],
    ]);
  });

  it('unescapes a doubled quote', () => {
    expect(parseDelimited('q\n"He said ""hi"""')).toEqual([['q'], ['He said "hi"']]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(parseDelimited('a,b\n"line1\nline2",x')).toEqual([
      ['a', 'b'],
      ['line1\nline2', 'x'],
    ]);
  });

  it('treats CRLF as one break', () => {
    expect(parseDelimited('a,b\r\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('strips the BOM Excel leaves on the first header', () => {
    // Otherwise the first column's key becomes an invisible-prefixed string
    // that no cell can bind to.
    const grid = parseDelimited('﻿team,w\nMesa,11');
    expect(grid[0]).toEqual(['team', 'w']);
  });

  it('does not invent a row from a trailing newline', () => {
    expect(parseDelimited('a\n1\n')).toHaveLength(2);
  });
});

describe('sniffDelimiter', () => {
  it('picks tab for clipboard data from a spreadsheet', () => {
    expect(sniffDelimiter('team\tw\tl')).toBe('\t');
  });

  it('defaults to comma', () => {
    expect(sniffDelimiter('team,w,l')).toBe(',');
    expect(sniffDelimiter('single')).toBe(',');
  });

  it('picks semicolon for European exports', () => {
    expect(sniffDelimiter('team;w;l')).toBe(';');
  });
});

describe('headerToKey', () => {
  it('normalizes away the churn a retitle would otherwise cause', () => {
    expect(headerToKey('  Team Name ', 0)).toBe('team_name');
    expect(headerToKey('W%', 1)).toBe('w');
  });

  it('falls back to a positional key for an unnamed column', () => {
    expect(headerToKey('   ', 2)).toBe('col3');
  });
});

describe('inferColumnsFromRows', () => {
  it('types a numeric column as a number so it sorts as one', () => {
    const columns = inferColumnsFromRows(['Team', 'W'], [['Mesa', '11'], ['Tempe', '9']]);
    expect(columns.map((c) => c.type)).toEqual(['string', 'number']);
  });

  it('keeps a column with any non-numeric value as text', () => {
    const columns = inferColumnsFromRows(['W'], [['11'], ['TBD']]);
    expect(columns[0]!.type).toBe('string');
  });

  it('ignores blanks when deciding', () => {
    const columns = inferColumnsFromRows(['W'], [['11'], [''], ['9']]);
    expect(columns[0]!.type).toBe('number');
  });
});

describe('csvToDataSet', () => {
  it('turns a published sheet into typed rows', () => {
    const set = csvToDataSet('sheet', 'Team,W,L\nMesa,11,2\nTempe,9,4');
    expect(set.columns.map((c) => c.key)).toEqual(['team', 'w', 'l']);
    expect(set.rows[0]).toEqual({ team: 'Mesa', w: 11, l: 2 });
  });

  it('synthesises keys when there is no header row', () => {
    const set = csvToDataSet('sheet', 'Mesa,11', { header: false });
    expect(set.columns.map((c) => c.key)).toEqual(['col1', 'col2']);
  });

  it('lets declared columns override what the header says', () => {
    const set = csvToDataSet('sheet', 'A,B\nMesa,11', {
      columns: [{ key: 'team', type: 'string' }, { key: 'w', type: 'number' }],
    });
    expect(set.rows[0]).toEqual({ team: 'Mesa', w: 11 });
  });

  it('is an empty set, not a throw, for an empty body', () => {
    expect(csvToDataSet('sheet', '').rows).toEqual([]);
  });
});

/**
 * Declared columns are found by header name (0.79.1). Before this, a declared
 * column read the cell at its own position and the header row was ignored —
 * and every Sheets or CSV source made from a sport template declares its
 * columns, so a sheet with its score columns the other way round put the
 * score on air reversed and passed the format check.
 */
describe('declared columns are matched by header name', () => {
  const basketball = sportTemplate('basketball')!;
  const nba = sportRuleset(basketball, 'nba');
  const gameColumns = sportDataColumns(basketball, nba, 'game');

  /** A one-row CSV with these headers in this order. */
  const sheet = (values: Record<string, string | number>): string => {
    const keys = Object.keys(values);
    return `${keys.join(',')}\n${keys.map((k) => values[k]).join(',')}\n`;
  };

  it('reads a game sheet whose score columns are the other way round the right way round', () => {
    const csv = sheet({ status: 'live', period: 3, periodLabel: '3rd', awayScore: 68, homeScore: 72 });
    let match: ColumnMatch | undefined;
    const set = csvToDataSet('game', csv, { columns: gameColumns, onColumns: (m) => (match = m) });
    expect(set.rows[0]).toMatchObject({ homeScore: 72, awayScore: 68, period: 3, periodLabel: '3rd' });
    expect(match?.positional).toBe(false);
  });

  it('is not moved by a column inserted into the sheet', () => {
    const csv = sheet({ status: 'live', notes: 'tip at 7', period: 2, homeScore: 40, awayScore: 38 });
    const set = csvToDataSet('game', csv, { columns: gameColumns });
    expect(set.rows[0]).toMatchObject({ status: 'live', period: 2, homeScore: 40, awayScore: 38 });
    expect(set.columns).toEqual(gameColumns);
    expect(checkSportTable(basketball, nba, 'game', set).ok).toBe(true);
  });

  it('matches the header however the sheet writes it', () => {
    const csv = 'STATUS,Period,Home Score,away_score,home score\nlive,1,10,8,99\n';
    const set = csvToDataSet('game', csv, { columns: gameColumns });
    // The first `Home Score` wins; a repeated header after it is ignored.
    expect(set.rows[0]).toMatchObject({ status: 'live', period: 1, homeScore: 10, awayScore: 8 });
  });

  it("falls back to a column's label when no header carries its key", () => {
    const columns: DataColumn[] = [
      { key: 'team', label: 'Team name', type: 'string' },
      { key: 'w', label: 'Wins', type: 'number' },
    ];
    const set = csvToDataSet('standings', 'Wins,Team Name\n11,Mesa\n', { columns });
    expect(set.rows[0]).toEqual({ team: 'Mesa', w: 11 });
  });

  it("does not let one column's label take the header another column's key names", () => {
    const columns: DataColumn[] = [
      { key: 'name', label: 'Team', type: 'string' },
      { key: 'team', type: 'string' },
    ];
    const set = csvToDataSet('players', 'team,name\nPHX,Jordan Smith\n', { columns });
    expect(set.rows[0]).toEqual({ name: 'Jordan Smith', team: 'PHX' });
  });

  it('leaves a column blank, and says so, when its header has gone', () => {
    let match: ColumnMatch | undefined;
    const csv = sheet({ status: 'live', period: 4, homeScore: 101 });
    const set = csvToDataSet('game', csv, { columns: gameColumns, onColumns: (m) => (match = m) });
    expect(set.rows[0]!.homeScore).toBe(101);
    expect(set.rows[0]!.awayScore).toBeNull();
    expect(match?.missing).toContain('awayScore');
    expect(columnMatchWarning(match)).toMatch(/not found in the header row, left blank: .*awayScore/);
  });

  it('reads by position, and says so, when no header names any declared column', () => {
    let match: ColumnMatch | undefined;
    const set = csvToDataSet('sheet', 'A,B\nMesa,11', {
      columns: [{ key: 'team', type: 'string' }, { key: 'w', type: 'number' }],
      onColumns: (m) => (match = m),
    });
    expect(set.rows[0]).toEqual({ team: 'Mesa', w: 11 });
    expect(match).toEqual({ missing: [], positional: true });
    expect(columnMatchWarning(match)).toMatch(/read by position/);
  });

  it('keeps position with no header row: there is nothing to match against', () => {
    let called = false;
    const set = csvToDataSet('sheet', 'Mesa,11', {
      header: false,
      columns: [{ key: 'team', type: 'string' }, { key: 'w', type: 'number' }],
      onColumns: () => (called = true),
    });
    expect(set.rows[0]).toEqual({ team: 'Mesa', w: 11 });
    expect(called).toBe(false);
  });

  it("reads a line score's unplayed periods as blank, not 0", () => {
    const csv = 'status,period,homeScore,awayScore,home1,home2,home3,home4\nlive,2,30,28,16,14,,\n';
    const set = csvToDataSet('game', csv, { columns: gameColumns });
    expect(set.rows[0]).toMatchObject({ home1: 16, home2: 14, home3: null, home4: null });
  });

  it('reports nothing when every column was found', () => {
    expect(columnMatchWarning({ missing: [], positional: false })).toBeUndefined();
    expect(columnMatchWarning(undefined)).toBeUndefined();
  });

  it('applies to a Sheets grid the same way (gridToDataSet)', () => {
    const grid = [['awayScore', 'homeScore', 'status', 'period'], ['3', '7', 'live', '2']];
    const set = gridToDataSet('game', grid, { columns: gameColumns });
    expect(set.rows[0]).toMatchObject({ homeScore: 7, awayScore: 3 });
  });

  it('normalises names of any script', () => {
    expect(columnMatchName('Home Score')).toBe(columnMatchName('homeScore'));
    expect(columnMatchName('home_score')).toBe('homescore');
    expect(columnMatchName('Équipe')).toBe('équipe');
    expect(columnMatchName('得点')).toBe('得点');
    expect(columnMatchName(' — ')).toBe('');
  });

  it('never matches an empty header', () => {
    const { index } = matchDeclaredColumns(['', 'w'], [{ key: '', type: 'string' }, { key: 'w', type: 'number' }]);
    expect(index).toEqual([undefined, 1]);
  });
});

describe('resolvePath', () => {
  const payload = { data: { standings: [{ teams: [{ team: 'Mesa' }] }] } };

  it('walks dots and brackets', () => {
    expect(resolvePath(payload, 'data.standings[0].teams')).toEqual([{ team: 'Mesa' }]);
  });

  it('returns the payload for an empty path', () => {
    expect(resolvePath(payload, '')).toBe(payload);
    expect(resolvePath(payload, undefined)).toBe(payload);
  });

  it('is undefined for a path that does not exist, rather than throwing', () => {
    // A feed that changes shape must show an error in the panel, not take the
    // poller down.
    expect(resolvePath(payload, 'data.nope.deeper')).toBeUndefined();
  });
});

describe('guessRowPath', () => {
  it('finds the row array a level or two down', () => {
    expect(guessRowPath({ results: [{ a: 1 }, { a: 2 }] })).toBe('results');
    expect(guessRowPath({ data: { teams: [{ a: 1 }] } })).toBe('data.teams');
  });

  it('is the empty path when the payload is already the array', () => {
    expect(guessRowPath([{ a: 1 }])).toBe('');
  });

  it('does not mistake an array of scalars for rows', () => {
    expect(guessRowPath({ tags: ['a', 'b'] })).toBeUndefined();
  });
});

describe('jsonToDataSet', () => {
  it('reads rows from a path', () => {
    const set = jsonToDataSet('feed', { data: { teams: [{ team: 'Mesa', w: 11 }] } }, {
      rowPath: 'data.teams',
    });
    expect(set.rows).toEqual([{ team: 'Mesa', w: 11 }]);
  });

  it('flattens one level of nesting into prefixed columns', () => {
    const set = jsonToDataSet('feed', [{ team: { name: 'Mesa', id: 4 }, w: 11 }]);
    expect(set.rows[0]).toEqual({ team_name: 'Mesa', team_id: 4, w: 11 });
  });

  it('joins an array inside a row rather than dropping it', () => {
    // An object column renders as "[object Object]" on air, which is worse than
    // a comma-separated list.
    const set = jsonToDataSet('feed', [{ tags: ['a', 'b'] }]);
    expect(set.rows[0]!.tags).toBe('a, b');
  });

  it('treats a lone object as a one-row set — the scalar-source shape', () => {
    const set = jsonToDataSet('wx', { temp: 41, condition: 'Sunny' });
    expect(set.rows).toHaveLength(1);
    expect(set.rows[0]!.temp).toBe(41);
  });

  it('is empty when the path points at nothing', () => {
    expect(jsonToDataSet('feed', { a: 1 }, { rowPath: 'b.c' }).rows).toEqual([]);
  });
});
