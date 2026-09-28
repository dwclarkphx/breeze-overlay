// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Wave 7 in the schema: the `date`, `lookup` and `union` transforms, and the
 * `readTime` reader under `date`.
 *
 * Every clock here is fixed and every zone named. Phoenix keeps no daylight
 * saving, so its offset is -7 all year and the expected days do not move with
 * the calendar the suite happens to run on.
 */

import { describe, expect, it } from 'vitest';

import {
  applyTransforms,
  lookup,
  transformSources,
  transformsUseClock,
  type DataSet,
  type DataTransform,
} from '../data.js';
import { createComposition, createLayer, createTableLayer, createTextLayer } from '../factory.js';
import { addDays, readTime } from '../time.js';
import type { Composition, CrawlLayer, TableLayer } from '../types.js';
import { validateComposition } from '../validate.js';

const PHX = 'America/Phoenix';
/** 8 pm on the 27th in Phoenix; already 3 am on the 28th in UTC. */
const EVENING = new Date('2026-09-28T03:00:00Z');

/* ------------------------------------------------------------- readTime */

describe('readTime', () => {
  it('reads a bare date as a calendar day with no instant', () => {
    expect(readTime('2026-09-27', PHX)).toEqual({ date: '2026-09-27' });
    expect(readTime(' 2026-09-27 ', 'Asia/Tokyo')).toEqual({ date: '2026-09-27' });
  });

  it('reads the US month-first order, with and without a time', () => {
    expect(readTime('9/27/2026', PHX)).toEqual({ date: '2026-09-27' });
    expect(readTime('9/27/26', PHX)).toEqual({ date: '2026-09-27' });
    const pm = readTime('9/27/2026 2:30 PM', PHX);
    expect(pm).toEqual({ date: '2026-09-27', ms: Date.parse('2026-09-27T21:30:00Z') });
    expect(readTime('9/27/2026 12:05 AM', PHX)?.ms).toBe(Date.parse('2026-09-27T07:05:00Z'));
    expect(readTime('9/27/2026 12:05 PM', PHX)?.ms).toBe(Date.parse('2026-09-27T19:05:00Z'));
    expect(readTime('9/27/2026 14:30', PHX)?.ms).toBe(Date.parse('2026-09-27T21:30:00Z'));
  });

  it('reads ISO without an offset as wall time in the zone, and with one as written', () => {
    expect(readTime('2026-09-27T19:00:00', PHX)?.ms).toBe(Date.parse('2026-09-28T02:00:00Z'));
    expect(readTime('2026-09-27 19:00', PHX)?.date).toBe('2026-09-27');
    // Written in UTC, it is still the 27th in Phoenix.
    expect(readTime('2026-09-28T02:00:00Z', PHX)).toEqual({ date: '2026-09-27', ms: Date.parse('2026-09-28T02:00:00Z') });
  });

  it('reads epoch numbers as milliseconds, or seconds when too small to be milliseconds', () => {
    const ms = Date.parse('2026-09-27T12:00:00Z');
    expect(readTime(ms, PHX)).toEqual({ date: '2026-09-27', ms });
    expect(readTime(ms / 1000, PHX)).toEqual({ date: '2026-09-27', ms });
  });

  it('returns null for anything it cannot read', () => {
    for (const v of ['', '  ', 'tomorrow', '27/9', null, undefined, true, Number.NaN, {}]) {
      expect(readTime(v, PHX)).toBeNull();
    }
  });

  it('does not hand anything else to Date.parse, which would read it in the machine’s zone', () => {
    for (const v of ['Sep 27, 2026', '2026/09/27', '9-27-2026', 'September 27, 2026 7:00 PM', '27/9/2026']) {
      expect(readTime(v, PHX), v).toBeNull();
    }
  });

  it('refuses days and times that do not exist', () => {
    for (const v of ['2026-02-30', '2026-13-45', '2/30/2026', '9/27/2026 13:00 PM', '9/27/2026 0:30 AM', '2026-09-27T24:00', '2026-09-27T12:60', '20261345']) {
      expect(readTime(v, PHX), v).toBeNull();
    }
    expect(readTime('2028-02-29', PHX)).toEqual({ date: '2028-02-29' });
  });

  it('refuses a number too large to be a time rather than throwing', () => {
    for (const v of [1e20, -1e20, 1790000000000000000, '17900000000000000000']) {
      expect(readTime(v, PHX)).toBeNull();
    }
  });

  it('reads digits as epoch time, and eight of them as a compact date', () => {
    const ms = Date.parse('2026-09-27T12:00:00Z');
    expect(readTime(String(ms / 1000), PHX)).toEqual({ date: '2026-09-27', ms });
    expect(readTime(String(ms), PHX)).toEqual({ date: '2026-09-27', ms });
    expect(readTime('20260927', PHX)).toEqual({ date: '2026-09-27' });
  });

  it('takes an offset after a space, in either spelling, and single-digit hours', () => {
    const at = Date.parse('2026-09-28T02:00:00Z');
    expect(readTime('2026-09-27 19:00:00 -07:00', 'UTC')?.ms).toBe(at);
    expect(readTime('2026-09-27T19:00:00-0700', 'UTC')?.ms).toBe(at);
    expect(readTime('2026-09-28T02:00:00.000Z', PHX)?.ms).toBe(at);
    expect(readTime('2026-09-27T9:00', PHX)?.ms).toBe(Date.parse('2026-09-27T16:00:00Z'));
  });

  it('puts two-digit years 00–69 in this century and 70–99 in the last', () => {
    expect(readTime('1/1/26', PHX)?.date).toBe('2026-01-01');
    expect(readTime('1/1/99', PHX)?.date).toBe('1999-01-01');
  });

  it('adds calendar days across a month and a year', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

/* ----------------------------------------------------------------- date */

const GAMES: DataSet = {
  id: 'games',
  columns: [
    { key: 'game', type: 'string' },
    { key: 'start', type: 'string' },
  ],
  rows: [
    { game: 'yesterday', start: '2026-09-26' },
    { game: 'this morning', start: '2026-09-27T09:00:00' },
    { game: 'tonight', start: '2026-09-27T21:00:00' },
    { game: 'today, no time', start: '9/27/2026' },
    { game: 'tomorrow', start: '9/28/2026 1:00 PM' },
    { game: 'in two days', start: '2026-09-29' },
    { game: 'unreadable', start: 'TBD' },
    { game: 'blank', start: null },
  ],
};

const games = (transforms: DataTransform[], now = EVENING): string[] =>
  applyTransforms(GAMES, transforms, { now }).rows.map((r) => String(r['game']));

describe('date', () => {
  it('keeps today in the named zone, not the machine’s or UTC’s', () => {
    expect(games([{ op: 'date', column: 'start', keep: 'days', timezone: PHX }])).toEqual([
      'this morning',
      'tonight',
      'today, no time',
    ]);
    // Already the 28th in UTC.
    expect(games([{ op: 'date', column: 'start', keep: 'days', timezone: 'UTC' }])).toEqual(['tomorrow']);
  });

  it('keeps a window of days from an offset', () => {
    expect(games([{ op: 'date', column: 'start', keep: 'days', from: 1, days: 2, timezone: PHX }])).toEqual([
      'tomorrow',
      'in two days',
    ]);
    expect(games([{ op: 'date', column: 'start', keep: 'days', from: -1, timezone: PHX }])).toEqual(['yesterday']);
  });

  it('keeps what is still to come: a time until it passes, a date for the whole of its day', () => {
    expect(games([{ op: 'date', column: 'start', keep: 'upcoming', timezone: PHX }])).toEqual([
      'tonight',
      'today, no time',
      'tomorrow',
      'in two days',
    ]);
    expect(games([{ op: 'date', column: 'start', keep: 'past', timezone: PHX }])).toEqual([
      'yesterday',
      'this morning',
    ]);
  });

  it('drops rows it cannot read from every window', () => {
    const all = [
      ...games([{ op: 'date', column: 'start', keep: 'upcoming', timezone: PHX }]),
      ...games([{ op: 'date', column: 'start', keep: 'past', timezone: PHX }]),
    ];
    expect(all).not.toContain('unreadable');
    expect(all).not.toContain('blank');
  });

  it('moves on with the clock', () => {
    const today = [{ op: 'date', column: 'start', keep: 'days', timezone: PHX }] as DataTransform[];
    // Midnight in Phoenix: the 28th's game is today now.
    expect(games(today, new Date('2026-09-28T07:00:00Z'))).toEqual(['tomorrow']);
    expect(games(today, new Date('2026-09-28T06:59:59Z'))).toContain('tonight');
  });

  it('is reported as clock-bound, and the others are not', () => {
    expect(transformsUseClock([{ op: 'date', column: 'start', keep: 'days' }])).toBe(true);
    expect(transformsUseClock([{ op: 'limit', n: 3 }, { op: 'union', source: 'x' }])).toBe(false);
    expect(transformsUseClock(undefined)).toBe(false);
  });
});

/* --------------------------------------------------------------- lookup */

const FORECAST: DataSet = {
  id: 'forecast',
  columns: [
    { key: 'city', type: 'string' },
    { key: 'hi', type: 'number' },
  ],
  rows: [
    { city: 'phoenix', hi: 104 },
    { city: ' Flagstaff ', hi: 78 },
    { city: 'Nowhere', hi: 1 },
  ],
};

const CITIES: DataSet = {
  id: 'cities',
  columns: [
    { key: 'city', type: 'string' },
    { key: 'name', label: 'Name', type: 'string' },
    { key: 'region', type: 'string' },
  ],
  rows: [
    { city: 'Phoenix', name: 'Phoenix', region: 'Valley' },
    { city: 'Flagstaff', name: 'Flagstaff', region: 'North' },
    { city: 'Phoenix', name: 'Second Phoenix', region: 'Duplicate' },
  ],
};

describe('lookup', () => {
  it('brings every other column across by a trimmed, case-insensitive key; the first match wins', () => {
    const out = lookup(FORECAST, { op: 'lookup', source: 'cities', key: 'city' }, CITIES);
    expect(out.columns.map((c) => c.key)).toEqual(['city', 'hi', 'name', 'region']);
    // The brought column keeps its label and type.
    expect(out.columns[2]).toEqual({ key: 'name', label: 'Name', type: 'string' });
    expect(out.rows).toEqual([
      { city: 'phoenix', hi: 104, name: 'Phoenix', region: 'Valley' },
      { city: ' Flagstaff ', hi: 78, name: 'Flagstaff', region: 'North' },
      { city: 'Nowhere', hi: 1, name: null, region: null },
    ]);
  });

  it('matches on a differently named column, and brings only what it is asked for', () => {
    const other: DataSet = { ...CITIES, columns: CITIES.columns.map((c) => (c.key === 'city' ? { ...c, key: 'id' } : c)), rows: CITIES.rows.map(({ city, ...rest }) => ({ id: city!, ...rest })) };
    const out = lookup(FORECAST, { op: 'lookup', source: 'cities', key: 'city', on: 'id', columns: ['region'] }, other);
    expect(out.columns.map((c) => c.key)).toEqual(['city', 'hi', 'region']);
    expect(out.rows.map((r) => r['region'])).toEqual(['Valley', 'North', null]);
  });

  it('with the other source missing, adds the named columns empty and finds nothing', () => {
    const out = lookup(FORECAST, { op: 'lookup', source: 'gone', key: 'city', columns: ['region'] }, undefined);
    expect(out.rows.map((r) => r['region'])).toEqual([null, null, null]);
    // Without a list there is nothing to name, so nothing is added.
    expect(lookup(FORECAST, { op: 'lookup', source: 'gone', key: 'city' }, undefined).columns).toEqual(FORECAST.columns);
  });

  it('runs in the pipeline against the source the context hands it', () => {
    const out = applyTransforms(
      FORECAST,
      [
        { op: 'lookup', source: 'cities', key: 'city', columns: ['region'] },
        { op: 'filter', key: 'region', cmp: 'eq', value: 'North' },
      ],
      { source: (id) => (id === 'cities' ? CITIES : undefined) },
    );
    expect(out.rows).toEqual([{ city: ' Flagstaff ', hi: 78, region: 'North' }]);
    // The input is untouched.
    expect(FORECAST.rows[0]).toEqual({ city: 'phoenix', hi: 104 });
  });
});

/* ---------------------------------------------------------------- union */

const ALERTS: DataSet = {
  id: 'alerts',
  columns: [
    { key: 'title', type: 'string' },
    { key: 'severity', type: 'string' },
  ],
  rows: [{ title: 'Heat warning', severity: 'high' }],
};
const TYPED: DataSet = {
  id: 'typed',
  columns: [
    { key: 'title', type: 'string' },
    { key: 'by', type: 'string' },
  ],
  rows: [{ title: 'Station fair Saturday', by: 'promo' }],
};

describe('union', () => {
  it('appends the other source’s rows; the columns are the union, empty where a side had none', () => {
    const out = applyTransforms(ALERTS, [{ op: 'union', source: 'typed' }], {
      source: (id) => (id === 'typed' ? TYPED : undefined),
    });
    expect(out.columns.map((c) => c.key)).toEqual(['title', 'severity', 'by']);
    expect(out.rows).toEqual([
      { title: 'Heat warning', severity: 'high', by: null },
      { title: 'Station fair Saturday', severity: null, by: 'promo' },
    ]);
  });

  it('adds nothing when the other source is not there', () => {
    expect(applyTransforms(ALERTS, [{ op: 'union', source: 'typed' }])).toEqual(ALERTS);
  });

  it('is reported with lookup as a source the pipeline reads', () => {
    expect(
      transformSources([
        { op: 'union', source: 'typed' },
        { op: 'lookup', source: 'cities', key: 'city' },
        { op: 'union', source: 'typed' },
        { op: 'sort', key: 'title' },
      ]),
    ).toEqual(['typed', 'cities']);
    expect(transformSources(undefined)).toEqual([]);
  });
});

/* ------------------------------------------------------------- validate */

function table(transforms: DataTransform[], cell = 'city'): Composition {
  const layer: TableLayer = createTableLayer({
    id: 't',
    size: { width: 400, height: 200 },
    row: { height: 40, cells: [createTextLayer({ id: 'c', cell, size: { width: 400, height: 40 } })] },
    data: { columns: FORECAST.columns, rows: [] },
    transforms,
  });
  return createComposition({ id: 'wx', name: 'wx', duration: 2, layers: [layer] });
}

const issues = (c: Composition) => validateComposition(c).errors;
const errors = (c: Composition) => issues(c).filter((i) => i.severity !== 'warning');

describe('validate', () => {
  it('accepts each new transform', () => {
    expect(errors(table([{ op: 'date', column: 'city', keep: 'days', from: 1, days: 7, timezone: PHX }]))).toEqual([]);
    expect(errors(table([{ op: 'lookup', source: 'cities', key: 'city', on: 'city', columns: ['region'] }]))).toEqual([]);
    expect(errors(table([{ op: 'union', source: 'typed' }]))).toEqual([]);
  });

  it('refuses an unknown zone, a bad keep, and a window out of range', () => {
    expect(errors(table([{ op: 'date', column: 'city', keep: 'days', timezone: 'Mars/Olympus' }]))).not.toEqual([]);
    expect(errors(table([{ op: 'date', column: 'city', keep: 'soon' } as unknown as DataTransform]))).not.toEqual([]);
    expect(errors(table([{ op: 'date', column: 'city', keep: 'days', days: 0 }]))).not.toEqual([]);
    expect(errors(table([{ op: 'lookup', source: '', key: 'city' }]))).not.toEqual([]);
    expect(errors(table([{ op: 'union' } as unknown as DataTransform]))).not.toEqual([]);
  });

  it('warns when a window is set on upcoming or past', () => {
    const found = issues(table([{ op: 'date', column: 'city', keep: 'upcoming', days: 3 }]));
    expect(found.some((i) => i.severity === 'warning' && /from and days/.test(i.message))).toBe(true);
    expect(errors(table([{ op: 'date', column: 'city', keep: 'upcoming', days: 3 }]))).toEqual([]);
  });

  it('checks a crawl’s date step too', () => {
    const crawl = (transforms: DataTransform[]) =>
      createComposition({
        id: 'news',
        name: 'news',
        duration: 2,
        layers: [{ ...(createLayer('crawl') as CrawlLayer), source: 'news', column: 'title', transforms }],
      });
    expect(errors(crawl([{ op: 'date', column: 'day', keep: 'days', timezone: 'Foo/Bar' }])).some((i) => /unknown time zone/.test(i.message))).toBe(true);
    expect(issues(crawl([{ op: 'date', column: 'day', keep: 'past', from: 1 }])).some((i) => i.severity === 'warning')).toBe(true);
    expect(errors(crawl([{ op: 'date', column: 'day', keep: 'days', timezone: PHX }]))).toEqual([]);
  });

  it('lets advance name a column an open lookup or a union may bring', () => {
    const advance: DataTransform = { op: 'advance', winner: 'result' };
    expect(errors(table([advance])).some((i) => /advance references unknown column/.test(i.message))).toBe(true);
    expect(errors(table([{ op: 'lookup', source: 'results', key: 'city' }, advance]))).toEqual([]);
    expect(errors(table([{ op: 'union', source: 'results' }, advance]))).toEqual([]);
    // A lookup *after* advance brings nothing advance could have read.
    expect(errors(table([advance, { op: 'lookup', source: 'results', key: 'city' }])).some((i) => /advance references/.test(i.message))).toBe(true);
  });

  it('lets a cell read a column a lookup names, and any column after an open lookup or a union', () => {
    expect(errors(table([], 'region')).some((i) => /unknown column/.test(i.message))).toBe(true);
    expect(errors(table([{ op: 'lookup', source: 'cities', key: 'city', columns: ['region'] }], 'region'))).toEqual([]);
    expect(errors(table([{ op: 'lookup', source: 'cities', key: 'city', columns: ['name'] }], 'region')).some((i) => /unknown column/.test(i.message))).toBe(true);
    expect(errors(table([{ op: 'lookup', source: 'cities', key: 'city' }], 'region'))).toEqual([]);
    expect(errors(table([{ op: 'union', source: 'typed' }], 'region'))).toEqual([]);
  });
});
