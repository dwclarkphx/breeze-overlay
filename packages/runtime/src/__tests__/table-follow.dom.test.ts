// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Follow (CYCLE.md, Wave 4): a table that shows the rows for whatever page
 * another table is on — the forecast tiles that change with the city a
 * rotation is showing.
 *
 * The same two clocks as the cycle suite: GSAP's root timeline carries the
 * graphic to its hold, the wall clock carries the cycle. Assertions read the
 * logical rows (`getTableRows`), which a turn commits at once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gsap } from 'gsap';
import {
  createComposition,
  createLayer,
  createTableLayer,
  createTextLayer,
  type Composition,
  type CompositionLayer,
  type DataColumn,
  type DataRow,
  type Layer,
  type TableLayer,
} from '@breeze/schema';

import { BreezeRuntime } from '../runtime.js';

const CITIES = ['Phoenix', 'Tucson', 'Flagstaff'];

/** The rotation: one city a page. */
function leader(overrides: Partial<TableLayer> = {}): TableLayer {
  return createTableLayer({
    id: 'rot',
    binding: 'cities',
    size: { width: 600, height: 50 },
    rowsPerPage: 1,
    row: { height: 50, cells: [createTextLayer({ id: 'name', cell: 'place', size: { width: 600, height: 50 } })] },
    data: { columns: [{ key: 'place', type: 'string' }], rows: CITIES.map((place) => ({ place })) },
    ...overrides,
  });
}

const FORECAST: DataRow[] = CITIES.flatMap((place, i) =>
  ['Mon', 'Tue', 'Wed'].map((day, d) => ({ place, day, hi: 100 - i * 10 + d })),
);

/** The tiles: every day for every city, trimmed to the rotation's city. */
function follower(overrides: Partial<TableLayer> = {}, rows = FORECAST, columns?: DataColumn[]): TableLayer {
  return createTableLayer({
    id: 'tiles',
    binding: 'days',
    // Tall enough for all nine rows on one page, so an unfollowed table shows them all.
    size: { width: 600, height: 400 },
    row: { height: 40, cells: [createTextLayer({ id: 'hi', cell: 'hi', size: { width: 200, height: 40 } })] },
    data: {
      columns: columns ?? [
        { key: 'place', type: 'string' },
        { key: 'day', type: 'string' },
        { key: 'hi', type: 'number' },
      ],
      rows,
    },
    follow: { table: 'cities', column: 'place' },
    ...overrides,
  });
}

function comp(layers: Layer[], id = 'wx'): Composition {
  return createComposition({ id, name: id, duration: 2, markers: [{ type: 'stop', time: 1 }], layers });
}

let rootTime = 0;
function advance(seconds: number): void {
  rootTime += seconds;
  gsap.updateRoot(rootTime);
}

let runtime: BreezeRuntime;
function mount(composition: Composition, library: Composition[] = []): BreezeRuntime {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const byId = new Map(library.map((c) => [c.id, c]));
  runtime = new BreezeRuntime({
    container,
    composition,
    injectStyles: false,
    resolveComposition: (id) => byId.get(id),
  });
  return runtime;
}

const places = (r: BreezeRuntime, id = 'tiles') => [...new Set(r.getTableRows(id).map((row) => row['place']))];
const days = (r: BreezeRuntime, id = 'tiles') => r.getTableRows(id).map((row) => row['day']);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
  gsap.ticker.lagSmoothing(0);
  rootTime = gsap.globalTimeline.time();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  runtime?.destroy();
  vi.useRealTimers();
  warn.mockRestore();
  document.body.innerHTML = '';
});

describe('follow', () => {
  it('shows the leader’s first city before anything plays', () => {
    const r = mount(comp([leader(), follower()]));
    expect(places(r)).toEqual(['Phoenix']);
    expect(days(r)).toEqual(['Mon', 'Tue', 'Wed']);
  });

  it('reports what it follows, as an address a control surface can use', () => {
    const r = mount(comp([leader(), follower()]));
    expect(r.tableStates.find((s) => s.table === 'days')).toMatchObject({ follows: 'cities' });
    expect(r.tableStates.find((s) => s.table === 'cities')?.follows).toBeUndefined();
  });

  it('moves with the leader’s cycle', () => {
    const r = mount(comp([leader({ cycle: { dwell: 6 } }), follower()]));
    r.play();
    advance(1.2);
    expect(r.playbackState).toBe('holding');
    expect(places(r)).toEqual(['Phoenix']);

    vi.advanceTimersByTime(6_010);
    expect(places(r)).toEqual(['Tucson']);
    vi.advanceTimersByTime(6_000);
    expect(places(r)).toEqual(['Flagstaff']);
    vi.advanceTimersByTime(6_000);
    expect(places(r)).toEqual(['Phoenix']);
  });

  it('moves with an operator’s page commands, and back to the first city on CLEAR', () => {
    // A cycling leader: CLEAR sends a cycle back to its first page, and only a cycle.
    const r = mount(comp([leader({ cycle: { dwell: 60 } }), follower()]));
    r.play();
    advance(1.2);
    r.next('cities');
    expect(places(r)).toEqual(['Tucson']);
    expect(r.goToPage({ key: 'flagstaff' }, 'cities')).toBe(true);
    expect(places(r)).toEqual(['Flagstaff']);
    r.prev('cities');
    expect(places(r)).toEqual(['Tucson']);
    r.clear();
    expect(places(r)).toEqual(['Phoenix']);
  });

  it('matches the key trimmed and without regard to case, as page?name= does', () => {
    const rows = FORECAST.map((row) => ({ ...row, place: ` ${String(row['place']).toUpperCase()} ` }));
    const r = mount(comp([leader(), follower({}, rows)]));
    expect(days(r)).toEqual(['Mon', 'Tue', 'Wed']);
  });

  it('shows nothing for a city its data does not have — never the previous city', () => {
    const rows = FORECAST.filter((row) => row['place'] !== 'Tucson');
    const r = mount(comp([leader(), follower({}, rows)]));
    r.next('cities');
    expect(r.getTableRows('tiles')).toEqual([]);
    r.next('cities');
    expect(places(r)).toEqual(['Flagstaff']);
  });

  it('filters before its own transforms, so a limit applies within the city', () => {
    const r = mount(comp([leader(), follower({ transforms: [{ op: 'limit', n: 2 }] })]));
    r.next('cities');
    expect(places(r)).toEqual(['Tucson']);
    expect(days(r)).toEqual(['Mon', 'Tue']);
  });

  it('filters after its transforms where only they produce the column', () => {
    // A sheet with a column a city — the follow column exists only once unpivoted.
    const wide = [
      { day: 'Mon', phoenix: 104, tucson: 99 },
      { day: 'Tue', phoenix: 106, tucson: 101 },
    ];
    const tiles = follower(
      { transforms: [{ op: 'unpivot', keep: ['day'], key: 'place', value: 'hi' }] },
      wide,
      [
        { key: 'day', type: 'string' },
        { key: 'phoenix', label: 'Phoenix', type: 'number' },
        { key: 'tucson', label: 'Tucson', type: 'number' },
      ],
    );
    const r = mount(comp([leader(), tiles]));
    expect(r.getTableRows('tiles').map((row) => row['hi'])).toEqual([104, 106]);
    r.next('cities');
    expect(r.getTableRows('tiles').map((row) => row['hi'])).toEqual([99, 101]);
  });

  it('follows a leader column other than its own, when told to', () => {
    const r = mount(comp([
      leader({
        data: {
          columns: [{ key: 'label', type: 'string' }, { key: 'code', type: 'string' }],
          rows: [{ label: 'The Valley', code: 'Phoenix' }, { label: 'Old Pueblo', code: 'Tucson' }],
        },
      }),
      follower({ follow: { table: 'cities', column: 'place', leaderColumn: 'code' } }),
    ]));
    expect(places(r)).toEqual(['Phoenix']);
    r.next('cities');
    expect(places(r)).toEqual(['Tucson']);
  });

  it('settles a chain in one step whatever order the tables were built in', () => {
    // The leaf is built first and follows the middle, which follows the rotation.
    const leaf = follower({ id: 'leaf', binding: 'leaf', follow: { table: 'days', column: 'place' } });
    const r = mount(comp([leaf, leader(), follower()]));
    r.next('cities');
    expect(places(r)).toEqual(['Tucson']);
    expect(places(r, 'leaf')).toEqual(['Tucson']);
  });

  it('commits a chain at once on air, before the outgoing rows have animated away', () => {
    // On air a follow change fades the old rows out first. The new city's rows
    // must already be the logical state, or the leaf would read the middle
    // table's old key and settle on the wrong city.
    const leaf = follower({ id: 'leaf', binding: 'leaf', follow: { table: 'days', column: 'place' } });
    const r = mount(comp([leader({ cycle: { dwell: 60 } }), follower({ rowsPerPage: 2 }), leaf]));
    r.play();
    advance(1.2);
    r.next('cities');
    expect(places(r)).toEqual(['Tucson']);
    expect(places(r, 'leaf')).toEqual(['Tucson']);
    expect(r.tableStates.find((s) => s.table === 'days')).toMatchObject({ page: 0, pageCount: 2 });
  });

  it('refreshes when new data reaches the leader', () => {
    const r = mount(comp([leader({ source: 'cities-feed' }), follower()]));
    r.update({ $data: { 'cities-feed': { id: 'cities-feed', columns: [{ key: 'place', type: 'string' }], rows: [{ place: 'Flagstaff' }] } } });
    expect(places(r)).toEqual(['Flagstaff']);
  });

  it('shows everything, with a warning, when the leader is not in the graphic', () => {
    const r = mount(comp([follower({ follow: { table: 'nowhere', column: 'place' } })]));
    expect(r.getTableRows('tiles')).toHaveLength(9);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nowhere'));
  });

  it('breaks a loop where it closes rather than letting two tables filter on each other', () => {
    const a = follower({ id: 'a', binding: 'a', follow: { table: 'b', column: 'place' } });
    const b = follower({ id: 'b', binding: 'b', follow: { table: 'a', column: 'place' } });
    const r = mount(comp([a, b]));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('loop'));
    // The first table found in the loop lets go; the other still follows it.
    expect(r.tableStates.find((s) => s.table === 'a')?.follows).toBeUndefined();
    expect(r.tableStates.find((s) => s.table === 'b')).toMatchObject({ follows: 'a' });
    expect(r.getTableRows('a')).toHaveLength(9);
    expect(places(r, 'b')).toEqual(['Phoenix']);
  });

  it('keeps a loop from taking down a table that only hangs off it', () => {
    const a = follower({ id: 'a', binding: 'a', follow: { table: 'b', column: 'place' } });
    const b = follower({ id: 'b', binding: 'b', follow: { table: 'a', column: 'place' } });
    const c = follower({ id: 'c', binding: 'c', follow: { table: 'a', column: 'place' } });
    const r = mount(comp([c, a, b]));
    expect(r.tableStates.find((s) => s.table === 'c')).toMatchObject({ follows: 'a' });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('table c '));
  });

  it('warns when two leaders are equally near, and says how to choose', () => {
    const wall = comp([leader()], 'wall-rot');
    const mountOf = (id: string): CompositionLayer => ({ ...(createLayer('composition') as CompositionLayer), id, ref: 'wall-rot' });
    mount(comp([mountOf('m1'), mountOf('m2'), follower()], 'wall'), [wall]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mount.binding'));
  });

  it('follows the nearest namesake where a graphic is mounted twice', () => {
    const tile = comp([leader(), follower()], 'tile');
    const mountOf = (id: string): CompositionLayer => ({ ...(createLayer('composition') as CompositionLayer), id, ref: 'tile' });
    const r = mount(comp([mountOf('west'), mountOf('east')], 'wall'), [tile]);

    r.next('east.cities');
    expect(places(r, 'west/tiles')).toEqual(['Phoenix']);
    expect(places(r, 'east/tiles')).toEqual(['Tucson']);
    expect(r.tableStates.find((s) => s.table === 'east.days')).toMatchObject({ follows: 'east.cities' });
  });
});

describe('a follower that cycles itself', () => {
  /** Phoenix has one day, Tucson three, Flagstaff two. */
  const UNEVEN: DataRow[] = [
    { place: 'Phoenix', day: 'Mon', hi: 104 },
    { place: 'Tucson', day: 'Mon', hi: 99 },
    { place: 'Tucson', day: 'Tue', hi: 100 },
    { place: 'Tucson', day: 'Wed', hi: 101 },
    { place: 'Flagstaff', day: 'Mon', hi: 70 },
    { place: 'Flagstaff', day: 'Tue', hi: 71 },
  ];

  it('pages through each city on its own dwell, even after a city with one page', () => {
    const r = mount(comp([
      leader({ cycle: { dwell: 12 } }),
      follower({ rowsPerPage: 1, cycle: { dwell: 4 } }, UNEVEN),
    ]));
    r.play();
    advance(1.2);
    expect(days(r)).toEqual(['Mon']);

    vi.advanceTimersByTime(12_010);
    expect(places(r)).toEqual(['Tucson']);
    expect(days(r)).toEqual(['Mon']);
    // Phoenix had one page, so the tiles were not cycling; Tucson's pages must still turn.
    vi.advanceTimersByTime(4_000);
    expect(days(r)).toEqual(['Tue']);
    vi.advanceTimersByTime(4_000);
    expect(days(r)).toEqual(['Wed']);
    vi.advanceTimersByTime(4_000);
    expect(places(r)).toEqual(['Flagstaff']);
    expect(days(r)).toEqual(['Mon']);
    expect(r.tableStates.find((s) => s.table === 'days')?.secondsLeft).toBeCloseTo(4, 0);
  });

  it('brings its cycle group back to the first page with it', () => {
    const partner = follower(
      { id: 'west', binding: 'west', rowsPerPage: 1, cycle: { dwell: 4, group: 'g' } },
      UNEVEN.filter((row) => row['place'] === 'Tucson'),
    );
    delete (partner as { follow?: unknown }).follow;
    const r = mount(comp([
      leader({ cycle: { dwell: 10 } }),
      follower({ rowsPerPage: 1, cycle: { dwell: 4, group: 'g' } }, UNEVEN),
      partner,
    ]));
    r.play();
    advance(1.2);
    const page = (t: string) => r.tableStates.find((s) => s.table === t)?.page;

    vi.advanceTimersByTime(8_010);
    expect(page('west')).toBe(2);
    // The rotation turns at 10s: the tiles start the new city on page one, and so does their partner.
    vi.advanceTimersByTime(2_000);
    expect(places(r)).toEqual(['Tucson']);
    expect(page('days')).toBe(0);
    expect(page('west')).toBe(0);
    vi.advanceTimersByTime(4_000);
    expect(page('days')).toBe(1);
    expect(page('west')).toBe(1);
  });
});
