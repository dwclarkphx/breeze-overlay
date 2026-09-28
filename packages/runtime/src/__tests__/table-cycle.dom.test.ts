// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Cycle through the runtime — the verbs an operator, a control surface and the
 * cycle timer all reach tables through.
 *
 * Two clocks are driven by hand here and they are different things. GSAP's root
 * timeline (`advance`) carries the graphic to its hold and plays page-turn
 * tweens; the wall clock and `setTimeout` (`vi.advanceTimersByTime`) carry the
 * cycle. A cycle deliberately runs on the wall clock: it is solved from an
 * anchor in epoch milliseconds so that two outputs agree, which a per-page GSAP
 * clock could not promise.
 *
 * Assertions read the logical page (`tableStates`, `getTableRows`), which a turn
 * commits at once while the rows animate after it. The cycle timer fires a few
 * milliseconds past each boundary, so the page is unambiguous when it asks;
 * the tests step just past a boundary for the same reason.
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

import { BreezeRuntime } from '../runtime.js';
import { installGlobals } from '../globals.js';

const ROW_H = 50;

const GROUPS = ['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D'].map((group, i) => ({
  group,
  team: `Team ${i + 1}`,
  secs: i === 2 ? 20 : null,
}));

function table(overrides: Partial<TableLayer> = {}): TableLayer {
  return createTableLayer({
    id: 'standings',
    binding: 'standings',
    size: { width: 600, height: 400 },
    rowsPerPage: 2,
    row: {
      height: ROW_H,
      gap: 0,
      cells: [
        createShapeLayer({ id: 'bg', size: { width: 600, height: ROW_H } }),
        createTextLayer({ id: 'team', cell: 'team', size: { width: 400, height: ROW_H } }),
      ],
    },
    data: {
      columns: [
        { key: 'group', type: 'string' },
        { key: 'team', type: 'string' },
        { key: 'secs', type: 'number' },
      ],
      rows: GROUPS,
    },
    rowAnim: { id: 'rows-up', stagger: 0.05, duration: 0.4 },
    cycle: { dwell: 6 },
    ...overrides,
  });
}

function comp(layers: Layer[], markers: Composition['markers'] = [{ type: 'stop', time: 1 }]): Composition {
  return createComposition({ id: 'standings', name: 'Standings', duration: 2, markers, layers });
}

let rootTime = 0;
/** Advance GSAP's root timeline — the graphic's own clock. */
function advance(seconds: number): void {
  rootTime += seconds;
  gsap.updateRoot(rootTime);
}

let runtime: BreezeRuntime;

function mount(composition: Composition): BreezeRuntime {
  const container = document.createElement('div');
  document.body.appendChild(container);
  runtime = new BreezeRuntime({ container, composition, injectStyles: false });
  return runtime;
}

/** Roll in and reach the hold at t=1. */
function toHold(r: BreezeRuntime): void {
  r.play();
  advance(1.2);
  expect(r.playbackState).toBe('holding');
}

const state = (r: BreezeRuntime, table = 'standings') =>
  r.tableStates.find((s) => s.table === table)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
  gsap.ticker.lagSmoothing(0);
  rootTime = gsap.globalTimeline.time();
});

afterEach(() => {
  runtime?.destroy();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('the cycle', () => {
  it('does not turn before the graphic holds', () => {
    const r = mount(comp([table()]));
    vi.advanceTimersByTime(60_000);
    expect(state(r).page).toBe(0);
    expect(state(r).cycling).toBe(false);
  });

  it('turns every dwell once holding, and loops', () => {
    const r = mount(comp([table()]));
    toHold(r);
    expect(state(r)).toMatchObject({ page: 0, pageCount: 4, key: 'A', cycling: true });

    vi.advanceTimersByTime(6_010);
    expect(state(r)).toMatchObject({ page: 1, key: 'B' });

    vi.advanceTimersByTime(18_000);
    expect(state(r).page).toBe(0);
  });

  it('shows the page it is on in the rows it renders', () => {
    const r = mount(comp([table()]));
    toHold(r);
    vi.advanceTimersByTime(6_010);
    expect(r.getTableRows('standings').map((row) => row['team'])).toEqual(['Team 3', 'Team 4']);
  });

  it('keeps a page up for its longest row when there is a duration column', () => {
    const r = mount(comp([table({ cycle: { dwell: 6, durationColumn: 'secs' } })]));
    toHold(r);
    vi.advanceTimersByTime(6_010);
    expect(state(r).page).toBe(1); // group B has a 20s row
    vi.advanceTimersByTime(19_000);
    expect(state(r).page).toBe(1);
    vi.advanceTimersByTime(1_100);
    expect(state(r).page).toBe(2);
  });

  it('reports time left to the next turn', () => {
    const r = mount(comp([table()]));
    toHold(r);
    vi.advanceTimersByTime(2_000);
    expect(state(r).secondsLeft).toBeCloseTo(4, 1);
  });

  it('stops turning when the graphic leaves its hold, and starts again from page one on a new run', () => {
    const r = mount(comp([table()]));
    toHold(r);
    vi.advanceTimersByTime(6_010);
    r.stop();
    vi.advanceTimersByTime(60_000);
    expect(state(r).page).toBe(1);

    advance(2);
    toHold(r);
    expect(state(r).page).toBe(0);
  });

  it('stays on the same page when data arrives, and keeps its time', () => {
    const r = mount(comp([table()]));
    toHold(r);
    vi.advanceTimersByTime(8_000); // page 1, 2s into it
    r.update({ standings: GROUPS.map((row) => ({ ...row, team: row.team.toUpperCase() })) });
    expect(state(r).page).toBe(1);
    vi.advanceTimersByTime(3_900);
    expect(state(r).page).toBe(1);
    vi.advanceTimersByTime(200);
    expect(state(r).page).toBe(2);
  });
});

describe('end of the cycle', () => {
  it('hold stays on the last page', () => {
    const r = mount(comp([table({ cycle: { dwell: 5, end: 'hold' } })]));
    toHold(r);
    vi.advanceTimersByTime(60_000);
    expect(state(r).page).toBe(3);
    expect(state(r).cycling).toBe(false);
    expect(r.playbackState).toBe('holding');
  });

  it('continue carries the graphic on once the last page has had its time', () => {
    const r = mount(comp([table({ cycle: { dwell: 5, end: 'continue' } })]));
    toHold(r);
    vi.advanceTimersByTime(20_050);
    expect(r.playbackState).toBe('playing-out');
  });
});

describe('operator commands', () => {
  it('NEXT turns a page and restarts its time', () => {
    const r = mount(comp([table()]));
    toHold(r);
    vi.advanceTimersByTime(5_000);
    r.next();
    expect(state(r).page).toBe(1);
    vi.advanceTimersByTime(5_000);
    expect(state(r).page).toBe(1);
    vi.advanceTimersByTime(1_100);
    expect(state(r).page).toBe(2);
  });

  it('PREV turns back, wrapping to the last page', () => {
    const r = mount(comp([table()]));
    toHold(r);
    r.prev();
    expect(state(r).page).toBe(3);
  });

  it('PREV with nothing to page returns to the previous hold by a cut, and never goes off air', () => {
    const plain = table({ id: 'short', binding: 'short', rowsPerPage: 20, cycle: undefined });
    const r = mount(comp([plain], [{ type: 'stop', time: 0.5 }, { type: 'stop', time: 1.2 }]));
    r.play();
    advance(0.6);
    r.next();
    advance(1);
    expect(r.currentStep).toBe(2);

    r.prev();
    expect(r.playbackState).toBe('holding');
    expect(r.currentTime).toBeCloseTo(0.5, 3);

    r.prev(); // no earlier hold
    expect(r.playbackState).toBe('holding');
    expect(r.currentTime).toBeCloseTo(0.5, 3);
  });

  it('goes to a page by number or by key, in any state', () => {
    const r = mount(comp([table()]));
    expect(r.goToPage({ key: 'c' })).toBe(true);
    expect(state(r).page).toBe(2);
    expect(r.goToPage({ n: 2 })).toBe(true);
    expect(state(r).page).toBe(1);
    expect(r.goToPage({ key: 'Z' })).toBe(false);
    expect(r.goToPage({ n: 9 })).toBe(false);

    // A page chosen before air is the page the graphic opens on.
    toHold(r);
    expect(state(r).page).toBe(1);
  });

  it('holds and resumes, and a resumed page gets its full time', () => {
    const r = mount(comp([table()]));
    toHold(r);
    r.setCycle('hold');
    vi.advanceTimersByTime(60_000);
    expect(state(r)).toMatchObject({ page: 0, held: true, cycling: false });

    r.setCycle('resume');
    vi.advanceTimersByTime(5_900);
    expect(state(r).page).toBe(0);
    vi.advanceTimersByTime(200);
    expect(state(r).page).toBe(1);
  });

  it('emits a page event', () => {
    const r = mount(comp([table()]));
    const seen = vi.fn();
    r.on('page', seen);
    toHold(r);
    vi.advanceTimersByTime(6_010);
    r.next();
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe('aiming', () => {
  const two = () =>
    comp([
      table(),
      table({ id: 'other', binding: 'other', cycle: { dwell: 6 } }),
    ]);

  it('turns only the table it names, and leaves the timeline alone', () => {
    const r = mount(two());
    toHold(r);
    r.next('other');
    expect(state(r, 'other').page).toBe(1);
    expect(state(r).page).toBe(0);
    expect(r.playbackState).toBe('holding');
  });

  it('turns every paged table without a name, as NEXT always has', () => {
    const r = mount(two());
    toHold(r);
    r.next();
    expect(state(r).page).toBe(1);
    expect(state(r, 'other').page).toBe(1);
  });

  it('brings the rest of a group along', () => {
    const r = mount(
      comp([
        table({ cycle: { dwell: 6, group: 'conf' } }),
        table({ id: 'other', binding: 'other', cycle: { dwell: 6, group: 'conf' } }),
        table({ id: 'third', binding: 'third', cycle: { dwell: 6 } }),
      ]),
    );
    toHold(r);
    r.next('standings');
    expect(state(r, 'other').page).toBe(1);
    expect(state(r, 'third').page).toBe(0);
    r.setCycle('hold', 'other');
    expect(state(r).held).toBe(true);
    expect(state(r, 'third').held).toBe(false);
  });

  it('does nothing for a table the graphic does not have', () => {
    const r = mount(two());
    toHold(r);
    r.next('nope');
    expect(state(r).page).toBe(0);
    expect(r.playbackState).toBe('holding');
  });
});

describe('window.breeze', () => {
  it('exposes prev, page and cycle for host scripting', () => {
    const r = mount(comp([table()]));
    const host: Record<string, unknown> = {};
    const g = installGlobals(r, host);
    expect(typeof host['prev']).toBe('function');
    expect(g.page('3')).toBe(true);
    expect(state(r).page).toBe(2);
    expect(g.page('D')).toBe(true);
    expect(state(r).page).toBe(3);
    expect(g.cycle('hold')).toBe(true);
  });
});
