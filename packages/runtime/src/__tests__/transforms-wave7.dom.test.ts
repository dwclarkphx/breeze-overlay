// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Wave 7 on a live graphic: a `lookup` that re-runs when the source it reads
 * changes, a `union` feeding a crawl, and a `date` window that moves on at
 * midnight without anything being pushed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DATA_UPDATE_KEY,
  createComposition,
  createLayer,
  createTableLayer,
  createTextLayer,
  type Composition,
  type CompositionLayer,
  type CrawlLayer,
  type DataSet,
  type DataTransform,
  type Layer,
} from '@breeze/schema';

import { BreezeRuntime } from '../runtime.js';

const PHX = 'America/Phoenix';

const FORECAST: DataSet = {
  id: 'forecast',
  columns: [
    { key: 'city', type: 'string' },
    { key: 'hi', type: 'number' },
  ],
  rows: [
    { city: 'PHX', hi: 104 },
    { city: 'FLG', hi: 78 },
  ],
};

const cities = (phx: string): DataSet => ({
  id: 'cities',
  columns: [
    { key: 'city', type: 'string' },
    { key: 'name', type: 'string' },
  ],
  rows: [
    { city: 'PHX', name: phx },
    { city: 'FLG', name: 'Flagstaff' },
  ],
});

const GAMES: DataSet = {
  id: 'games',
  columns: [
    { key: 'game', type: 'string' },
    { key: 'day', type: 'string' },
  ],
  rows: [
    { game: 'Sat', day: '2026-09-26' },
    { game: 'Sun', day: '2026-09-27' },
    { game: 'Mon', day: '2026-09-28' },
  ],
};

function table(source: string, transforms: DataTransform[], cell: string): Layer {
  return createTableLayer({
    id: 't',
    source,
    size: { width: 600, height: 400 },
    row: { height: 40, cells: [createTextLayer({ id: 'c', cell, size: { width: 600, height: 40 } })] },
    transforms,
  });
}

function comp(layers: Layer[]): Composition {
  return createComposition({ id: 'wx', name: 'wx', duration: 2, layers });
}

let runtime: BreezeRuntime | undefined;
let container: HTMLElement;
function mount(composition: Composition, datasets: Record<string, DataSet>, library: Composition[] = []): BreezeRuntime {
  container = document.createElement('div');
  document.body.appendChild(container);
  const byId = new Map(library.map((c) => [c.id, c]));
  runtime = new BreezeRuntime({
    container,
    composition,
    injectStyles: false,
    data: { [DATA_UPDATE_KEY]: datasets },
    resolveComposition: (id) => byId.get(id),
  });
  return runtime;
}

const column = (r: BreezeRuntime, key: string) => r.getTableRows('t').map((row) => row[key]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  // 11 pm on Sunday the 27th in Phoenix.
  vi.setSystemTime(new Date('2026-09-28T06:00:00Z'));
});

afterEach(() => {
  runtime?.destroy();
  runtime = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('lookup on air', () => {
  it('brings the other source’s columns in at load, whichever order the sources arrive in', () => {
    const lookup: DataTransform[] = [{ op: 'lookup', source: 'cities', key: 'city' }];
    const a = mount(comp([table('forecast', lookup, 'name')]), { forecast: FORECAST, cities: cities('Phoenix') });
    expect(column(a, 'name')).toEqual(['Phoenix', 'Flagstaff']);
    a.destroy();

    const b = mount(comp([table('forecast', lookup, 'name')]), { cities: cities('Phoenix'), forecast: FORECAST });
    expect(column(b, 'name')).toEqual(['Phoenix', 'Flagstaff']);
  });

  it('re-runs when the source it reads changes, with nothing pushed to its own', () => {
    const r = mount(comp([table('forecast', [{ op: 'lookup', source: 'cities', key: 'city' }], 'name')]), {
      forecast: FORECAST,
      cities: cities('Phoenix'),
    });
    r.update({ [DATA_UPDATE_KEY]: { cities: cities('Phoenix Metro') } }, { silent: true });
    expect(column(r, 'name')).toEqual(['Phoenix Metro', 'Flagstaff']);
    expect(container.textContent).toContain('Phoenix Metro');
  });

  it('ignores a source it does not read', () => {
    const r = mount(comp([table('forecast', [{ op: 'lookup', source: 'cities', key: 'city' }], 'name')]), {
      forecast: FORECAST,
      cities: cities('Phoenix'),
    });
    const before = r.getTableRows('t');
    r.update({ [DATA_UPDATE_KEY]: { other: cities('Nope') } }, { silent: true });
    expect(r.getTableRows('t')).toEqual(before);
  });
});

describe('union into a crawl', () => {
  const crawl = (transforms: DataTransform[], extra: Partial<CrawlLayer> = {}): CrawlLayer =>
    ({
      id: 'ticker',
      name: 'Ticker',
      type: 'crawl',
      position: { x: 0, y: 0 },
      size: { width: 800, height: 60 },
      speed: 120,
      direction: 'left',
      separator: ' | ',
      items: ['Typed'],
      source: 'alerts',
      column: 'title',
      transforms,
      style: { fontFamily: 'sans-serif', fontSize: 32, fill: '#fff' },
      ...extra,
    }) as CrawlLayer;
  const titles = (...t: string[]): DataSet => ({
    id: 'x',
    columns: [{ key: 'title', type: 'string' }],
    rows: t.map((title) => ({ title })),
  });
  const shown = () =>
    (container.querySelector<HTMLElement>('.bz-crawl-block')?.textContent ?? '')
      .split(' | ')
      .map((s) => s.trim())
      .filter(Boolean);

  it('shows both sources, and follows a change to the one it only reads', () => {
    const r = mount(comp([crawl([{ op: 'union', source: 'promos' }])]), {
      alerts: titles('Heat warning'),
      promos: titles('Fair Saturday'),
    });
    expect(shown()).toEqual(['Heat warning', 'Fair Saturday']);

    r.update({ [DATA_UPDATE_KEY]: { promos: titles('Fair Sunday') } }, { silent: true });
    // A running crawl queues the new text for its next pass; the queued block is what changed.
    r.play();
    vi.advanceTimersByTime(60_000);
    expect(container.textContent).toContain('Fair Sunday');
  });
});

describe('a mounted crawl with an override', () => {
  it('keeps saying what the override says through a feed change and the clock', () => {
    const ticker = createComposition({
      id: 'ticker',
      name: 'ticker',
      duration: 2,
      layers: [
        {
          id: 'crawl', name: 'Crawl', type: 'crawl', position: { x: 0, y: 0 }, size: { width: 800, height: 60 },
          speed: 120, direction: 'left', separator: ' | ', items: ['Typed'], binding: 'tick',
          source: 'alerts', column: 'title',
          transforms: [{ op: 'date', column: 'day', keep: 'upcoming', timezone: PHX }],
          style: { fontFamily: 'sans-serif', fontSize: 32, fill: '#fff' },
        } as CrawlLayer,
      ],
    });
    const mountLayer: CompositionLayer = {
      ...(createLayer('composition') as CompositionLayer),
      id: 'news',
      ref: 'ticker',
      overrides: { tick: ['Pinned'] },
    };
    const feed = (title: string): DataSet => ({
      id: 'alerts',
      columns: [{ key: 'title', type: 'string' }, { key: 'day', type: 'string' }],
      rows: [{ title, day: '2026-09-30' }],
    });
    const r = mount(comp([mountLayer]), { alerts: feed('From the feed') }, [ticker]);
    const text = () => container.querySelector<HTMLElement>('.bz-crawl-block')?.textContent ?? '';
    expect(text()).toContain('Pinned');

    r.update({ [DATA_UPDATE_KEY]: { alerts: feed('Newer') } }, { silent: true });
    r.play();
    vi.advanceTimersByTime(120_000);
    expect(container.textContent).not.toContain('Newer');
    expect(container.textContent).not.toContain('From the feed');
  });
});

describe('date on air', () => {
  it('carries a follower with its leader when midnight changes the leader’s page', () => {
    const leaderTable = createTableLayer({
      id: 'lead',
      binding: 'games',
      source: 'games',
      size: { width: 600, height: 40 },
      rowsPerPage: 1,
      row: { height: 40, cells: [createTextLayer({ id: 'g', cell: 'game', size: { width: 600, height: 40 } })] },
      transforms: [{ op: 'date', column: 'day', keep: 'days', timezone: PHX }],
    });
    const info: DataSet = {
      id: 'info',
      columns: [{ key: 'game', type: 'string' }, { key: 'note', type: 'string' }],
      rows: [{ game: 'Sun', note: 'sun-info' }, { game: 'Mon', note: 'mon-info' }],
    };
    const followerTable = createTableLayer({
      id: 't',
      source: 'info',
      size: { width: 600, height: 200 },
      row: { height: 40, cells: [createTextLayer({ id: 'n', cell: 'note', size: { width: 600, height: 40 } })] },
      follow: { table: 'games', column: 'game' },
    });
    const r = mount(comp([leaderTable, followerTable]), { games: GAMES, info });
    expect(column(r, 'note')).toEqual(['sun-info']);

    vi.advanceTimersByTime(60 * 60_000 + 30_000);
    expect(r.getTableRows('lead').map((row) => row['game'])).toEqual(['Mon']);
    expect(column(r, 'note')).toEqual(['mon-info']);
  });

  it('moves "today" on at midnight in the named zone, with nothing pushed', () => {
    const r = mount(
      comp([table('games', [{ op: 'date', column: 'day', keep: 'days', timezone: PHX }], 'game')]),
      { games: GAMES },
    );
    expect(column(r, 'game')).toEqual(['Sun']);

    // 00:00:30 on Monday in Phoenix — the next tick after midnight.
    vi.advanceTimersByTime(60 * 60_000 + 30_000);
    expect(column(r, 'game')).toEqual(['Mon']);
    expect(container.textContent).toContain('Mon');
    expect(container.textContent).not.toContain('Sun');
  });

  it('does not re-render a table whose window did not change', () => {
    const r = mount(
      comp([table('games', [{ op: 'date', column: 'day', keep: 'days', timezone: PHX }], 'game')]),
      { games: GAMES },
    );
    const row = container.querySelector('.bz-table [data-row-key], .bz-table > *');
    vi.advanceTimersByTime(5 * 30_000);
    expect(column(r, 'game')).toEqual(['Sun']);
    expect(container.querySelector('.bz-table [data-row-key], .bz-table > *')).toBe(row);
  });

  it('starts no clock for a graphic without a date step, and stops it on destroy', () => {
    const plain = mount(comp([table('games', [{ op: 'limit', n: 1 }], 'game')]), { games: GAMES });
    expect(vi.getTimerCount()).toBe(0);
    plain.destroy();

    const clocked = mount(
      comp([table('games', [{ op: 'date', column: 'day', keep: 'days', timezone: PHX }], 'game')]),
      { games: GAMES },
    );
    expect(vi.getTimerCount()).toBe(1);
    clocked.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
