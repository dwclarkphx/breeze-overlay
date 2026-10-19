// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * A table turned by hand goes back to page one when the graphic leaves air.
 *
 * Only self-paging tables used to reset; a standings table paged with NEXT kept
 * its last page through STOP and CLEAR and rolled back in on it. The reset
 * happens when the outro *ends* — not when STOP is pressed, so the page on
 * screen does not jump mid-outro — and on CLEAR. A page an operator chooses
 * after that, off air, is still the page the graphic opens on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gsap } from 'gsap';
import {
  createComposition,
  createTableLayer,
  createTextLayer,
  type Composition,
  type TableLayer,
} from '@breeze/schema';

import { BreezeRuntime } from '../runtime.js';

const ROW_H = 50;
const TEAMS = ['Mesa', 'Tempe', 'Gilbert', 'Peoria', 'Glendale', 'Surprise'].map((team) => ({ team }));

function table(overrides: Partial<TableLayer> = {}): TableLayer {
  return createTableLayer({
    id: 'standings',
    binding: 'standings',
    size: { width: 600, height: 400 },
    rowsPerPage: 2,
    row: { height: ROW_H, gap: 0, cells: [createTextLayer({ id: 'team', cell: 'team', size: { width: 400, height: ROW_H } })] },
    data: { columns: [{ key: 'team', type: 'string' }], rows: TEAMS },
    rowAnim: { id: 'rows-up', stagger: 0.05, duration: 0.4 },
    ...overrides,
  });
}

function comp(layer: TableLayer): Composition {
  return createComposition({
    id: 'standings',
    name: 'Standings',
    duration: 2,
    markers: [{ type: 'stop', time: 1 }],
    layers: [layer],
  });
}

let rootTime = 0;
function advance(seconds: number): void {
  rootTime += seconds;
  gsap.updateRoot(rootTime);
}

let runtime: BreezeRuntime;
function mount(layer = table()): BreezeRuntime {
  const container = document.createElement('div');
  document.body.appendChild(container);
  runtime = new BreezeRuntime({ container, composition: comp(layer), injectStyles: false });
  return runtime;
}

function toHold(r: BreezeRuntime): void {
  r.play();
  advance(1.2);
  expect(r.playbackState).toBe('holding');
}

const page = (r: BreezeRuntime) => r.tableStates.find((s) => s.table === 'standings')!.page;
const teams = (r: BreezeRuntime) => r.getTableRows('standings').map((row) => row['team']);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
  gsap.ticker.lagSmoothing(0);
  rootTime = gsap.globalTimeline.time();
});

afterEach(() => {
  runtime?.destroy();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('a table paged by hand, leaving air', () => {
  it('keeps its page through the outro, then is back on page one once off air', () => {
    const r = mount();
    toHold(r);
    r.next();
    r.next();
    expect(page(r)).toBe(2);

    r.stop();
    advance(0.3);
    expect(r.playbackState).toBe('playing-out');
    // No jump to page one while the outro is still on screen.
    expect(page(r)).toBe(2);

    advance(1);
    expect(r.playbackState).toBe('finished');
    expect(page(r)).toBe(0);
  });

  it('rolls back in on page one, showing page one’s rows', () => {
    const r = mount();
    toHold(r);
    r.next();
    r.stop();
    advance(1.2);

    toHold(r);
    expect(page(r)).toBe(0);
    expect(teams(r)).toEqual(['Mesa', 'Tempe']);
  });

  it('is back on page one after CLEAR', () => {
    const r = mount();
    toHold(r);
    r.next();
    expect(page(r)).toBe(1);

    r.clear();
    expect(page(r)).toBe(0);
    toHold(r);
    expect(teams(r)).toEqual(['Mesa', 'Tempe']);
  });

  it('opens on a page an operator chose after it went off air', () => {
    const r = mount();
    toHold(r);
    r.next();
    r.stop();
    advance(1.2);
    expect(page(r)).toBe(0);

    expect(r.goToPage({ n: 3 })).toBe(true);
    toHold(r);
    expect(page(r)).toBe(2);
    expect(teams(r)).toEqual(['Glendale', 'Surprise']);
  });

  it('starts on page one when PLAY cuts the outro short', () => {
    const r = mount();
    toHold(r);
    r.next();
    r.stop();
    advance(0.3);
    expect(r.playbackState).toBe('playing-out');

    toHold(r);
    expect(page(r)).toBe(0);
  });

  it('keeps a cycle’s HOLD through leaving air, while still going back to page one', () => {
    const r = mount(table({ cycle: { dwell: 6 } }));
    toHold(r);
    r.next();
    r.setCycle('hold');
    r.stop();
    advance(1.2);
    expect(page(r)).toBe(0);
    expect(r.tableStates[0]!.held).toBe(true);
  });
});
