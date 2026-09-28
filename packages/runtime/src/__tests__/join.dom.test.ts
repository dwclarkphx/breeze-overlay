// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Late join (0.74.1) — an output page opened while its graphic is already on
 * air takes up where another output is, from that output's playback report.
 *
 * The reports here are built exactly as the output page builds them (see
 * `apps/server/client/player.ts`), so what is tested is the path a reloaded
 * browser source actually takes: report → hub → `joinAt`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gsap } from 'gsap';
import {
  createComposition,
  createShapeLayer,
  createTableLayer,
  createTextLayer,
  type Composition,
  type Layer,
  type TableLayer,
} from '@breeze/schema';

import { BreezeRuntime, type JoinReport } from '../runtime.js';

const ROW_H = 50;
const CITIES = ['Phoenix', 'Tucson', 'Flagstaff', 'Yuma'];

function cities(overrides: Partial<TableLayer> = {}): TableLayer {
  return createTableLayer({
    id: 'city',
    binding: 'city',
    size: { width: 600, height: ROW_H },
    rowsPerPage: 1,
    row: {
      height: ROW_H,
      gap: 0,
      cells: [
        createShapeLayer({ id: 'bg', size: { width: 600, height: ROW_H } }),
        createTextLayer({ id: 'name', cell: 'name', size: { width: 400, height: ROW_H } }),
      ],
    },
    data: { columns: [{ key: 'name', type: 'string' }], rows: CITIES.map((name) => ({ name })) },
    rowAnim: { id: 'rows-up', stagger: 0.05, duration: 0.4 },
    cycle: { dwell: 6, group: 'cities', keyColumn: 'name' },
    ...overrides,
  });
}

function forecast(): TableLayer {
  return createTableLayer({
    id: 'days',
    binding: 'days',
    size: { width: 600, height: ROW_H * 2 },
    rowsPerPage: 2,
    row: {
      height: ROW_H,
      gap: 0,
      cells: [createTextLayer({ id: 'day', cell: 'day', size: { width: 400, height: ROW_H } })],
    },
    data: {
      columns: [{ key: 'place', type: 'string' }, { key: 'day', type: 'string' }],
      rows: CITIES.flatMap((place) => ['Mon', 'Tue'].map((day) => ({ place, day: `${place} ${day}` }))),
    },
    follow: { table: 'city', column: 'place', leaderColumn: 'name' },
  });
}

function comp(layers: Layer[]): Composition {
  return createComposition({
    id: 'wx',
    name: 'Weather',
    duration: 2,
    markers: [{ type: 'stop', time: 1 }],
    layers,
  });
}

let rootTime = 0;
function advance(seconds: number): void {
  rootTime += seconds;
  gsap.updateRoot(rootTime);
}

const made: BreezeRuntime[] = [];
function mount(composition: Composition): BreezeRuntime {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const r = new BreezeRuntime({ container, composition, injectStyles: false });
  made.push(r);
  return r;
}

function toHold(r: BreezeRuntime): void {
  r.play();
  advance(1.2);
  expect(r.playbackState).toBe('holding');
}

/** What the output page sends the hub — the same filter and fields. */
function reportOf(r: BreezeRuntime, ageMs = 0): JoinReport {
  return {
    state: r.playbackState,
    time: r.currentTime,
    step: r.currentStep,
    tables: r.tableStates
      .filter((s) => s.pageCount > 1 || s.cycling || s.held)
      .map((s) => ({
        table: s.table,
        page: s.page,
        pageCount: s.pageCount,
        hasCycle: s.hasCycle,
        cycling: s.cycling,
        held: s.held,
        secondsLeft: s.secondsLeft,
        ...(s.follows ? { follows: s.follows } : {}),
      })),
    ageMs,
  };
}

const state = (r: BreezeRuntime, table = 'city') => r.tableStates.find((s) => s.table === table)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
  gsap.ticker.lagSmoothing(0);
  rootTime = gsap.globalTimeline.time();
});

afterEach(() => {
  for (const r of made.splice(0)) r.destroy();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('joinAt', () => {
  it('cuts to the hold another output is on, without playing the intro', () => {
    const r = mount(comp([cities()]));
    const joined = r.joinAt({ state: 'holding', time: 1, step: 1 });
    expect(joined).toBe(true);
    expect(r.playbackState).toBe('holding');
    expect(r.currentTime).toBeCloseTo(1, 5);
    expect(r.getTableRows('city').map((row) => row['name'])).toEqual(['Phoenix']);
    // On screen, not just in the model: the reveal rendered through to rest.
    const rows = [...document.querySelectorAll<HTMLElement>('.bz-table-row')];
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.style.opacity || '1')).toBe(1);
    // No intro running: the clock does not move on its own.
    advance(0.5);
    expect(r.currentTime).toBeCloseTo(1, 5);
  });

  it('goes to the reported page with the reported time left', () => {
    const r = mount(comp([cities()]));
    r.joinAt({ state: 'holding', time: 1, step: 1, tables: [{ table: 'city', page: 2, secondsLeft: 4, cycling: true }] });
    expect(state(r)).toMatchObject({ page: 2, key: 'Flagstaff', cycling: true });
    expect(state(r).secondsLeft).toBeCloseTo(4, 1);
    // A page turned at the cut is at rest too — its reveal is behind the playhead.
    const row = document.querySelector<HTMLElement>('.bz-table-row')!;
    expect(row.textContent).toContain('Flagstaff');
    expect(Number(row.style.opacity || '1')).toBe(1);
    vi.advanceTimersByTime(4_010);
    expect(state(r)).toMatchObject({ page: 3, key: 'Yuma' });
  });

  it('allows for the age of the report, walking on past pages that have turned since', () => {
    const r = mount(comp([cities()]));
    // Made 13 s ago at the start of page 0: two turns since, 1 s into page 2.
    r.joinAt({
      state: 'holding', time: 1, step: 1, ageMs: 13_000,
      tables: [{ table: 'city', page: 0, secondsLeft: 6, cycling: true }],
    });
    expect(state(r).page).toBe(2);
    expect(state(r).secondsLeft).toBeCloseTo(5, 1);
  });

  it('keeps a joined output turning on the same second as the one it joined', () => {
    const first = mount(comp([cities()]));
    toHold(first);
    vi.advanceTimersByTime(8_300); // page 1, 2.3 s in

    const second = mount(comp([cities()]));
    // The hub read the report 1.5 s after it was made.
    const report = reportOf(first);
    vi.advanceTimersByTime(1_500);
    second.joinAt({ ...report, ageMs: 1_500 });

    expect(state(second).page).toBe(state(first).page);
    expect(state(second).secondsLeft).toBeCloseTo(state(first).secondsLeft!, 0);
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(3_000);
      expect(state(second).page).toBe(state(first).page);
    }
  });

  it('moves a follower with its leader and keeps the follower on its own reported page', () => {
    const r = mount(comp([cities(), forecast()]));
    r.joinAt({
      state: 'holding', time: 1, step: 1,
      tables: [{ table: 'city', page: 1, secondsLeft: 5, cycling: true }],
    });
    expect(r.getTableRows('days').map((row) => row['day'])).toEqual(['Tucson Mon', 'Tucson Tue']);
  });

  it('stays held when the output it joined was held', () => {
    const r = mount(comp([cities()]));
    r.joinAt({ state: 'holding', time: 1, step: 1, tables: [{ table: 'city', page: 3, secondsLeft: null, held: true }] });
    vi.advanceTimersByTime(60_000);
    expect(state(r)).toMatchObject({ page: 3, held: true, cycling: false });
  });

  it('starts the time of a cycling table the report did not mention', () => {
    const r = mount(comp([cities()]));
    r.joinAt({ state: 'holding', time: 1, step: 1 });
    expect(state(r).cycling).toBe(true);
    vi.advanceTimersByTime(6_010);
    expect(state(r).page).toBe(1);
  });

  it('picks up an intro partway and reaches the hold', () => {
    const r = mount(comp([cities()]));
    r.joinAt({ state: 'playing-in', time: 0.4, step: 0, ageMs: 200 });
    expect(r.playbackState).toBe('playing-in');
    expect(r.currentTime).toBeCloseTo(0.6, 2);
    advance(0.6);
    expect(r.playbackState).toBe('holding');
  });

  it('does nothing for an output that is not on air', () => {
    const r = mount(comp([cities()]));
    for (const s of ['idle', 'finished', 'playing-out']) {
      expect(r.joinAt({ state: s, time: 1.5, step: 1 })).toBe(false);
      expect(r.playbackState).toBe('idle');
    }
  });

  it('leaves a page that has already been told what to do, unless forced', () => {
    const r = mount(comp([cities()]));
    toHold(r);
    const report = { state: 'holding', time: 1, step: 1, tables: [{ table: 'city', page: 3, secondsLeft: 2, cycling: true }] };
    expect(r.joinAt(report)).toBe(false);
    expect(state(r).page).toBe(0);
    expect(r.joinAt(report, { force: true })).toBe(true);
    expect(state(r).page).toBe(3);
  });

  it('answers a live command normally after joining', () => {
    const r = mount(comp([cities()]));
    r.joinAt({ state: 'holding', time: 1, step: 1, tables: [{ table: 'city', page: 1, secondsLeft: 3, cycling: true }] });
    r.next();
    expect(state(r).page).toBe(2);
    r.stop();
    advance(1.5);
    expect(r.playbackState).toBe('finished');
  });
});
