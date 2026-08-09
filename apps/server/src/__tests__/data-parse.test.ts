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

import {
  csvToDataSet,
  guessRowPath,
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
