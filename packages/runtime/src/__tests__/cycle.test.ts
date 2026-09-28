// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Cycle arithmetic — which page is on air, and until when.
 *
 * Every case here is a question asked of an anchor, never a sequence of ticks:
 * that is the property the whole feature rests on, so it is the property these
 * tests pin.
 */

import { describe, expect, it } from 'vitest';
import type { TableCycle } from '@breeze/schema';

import {
  MIN_PAGE_SECONDS,
  cycleEnabled,
  cyclePosition,
  normalisePageKey,
  pageDurations,
} from '../cycle.js';

const T0 = 1_800_000_000_000;
const s = (seconds: number) => T0 + seconds * 1000;

describe('cycleEnabled', () => {
  it('needs a cycle with a positive dwell', () => {
    expect(cycleEnabled(undefined)).toBe(false);
    expect(cycleEnabled({ dwell: 0 })).toBe(false);
    expect(cycleEnabled({ dwell: Number.NaN })).toBe(false);
    expect(cycleEnabled({ dwell: 6 })).toBe(true);
  });
});

describe('pageDurations', () => {
  const pages = [
    [{ t: 4 }, { t: 9 }],
    [{ t: null }, { t: 'x' }],
    [{ t: '12' }],
  ];

  it('gives every page the dwell when there is no duration column', () => {
    expect(pageDurations(pages, { dwell: 6 })).toEqual([6, 6, 6]);
  });

  it('lasts as long as the longest row on the page, falling back to the dwell', () => {
    const cycle: TableCycle = { dwell: 6, durationColumn: 't' };
    expect(pageDurations(pages, cycle)).toEqual([9, 6, 12]);
  });

  it('reads milliseconds when told to, rather than parking a page for hours', () => {
    const cycle: TableCycle = { dwell: 6, durationColumn: 't', durationUnit: 'ms' };
    expect(pageDurations([[{ t: 8000 }]], cycle)).toEqual([8]);
  });

  it('never goes below the floor — a zero in a feed must not strobe the table', () => {
    expect(pageDurations([[{ t: 0.01 }]], { dwell: 0.01, durationColumn: 't' })).toEqual([
      MIN_PAGE_SECONDS,
    ]);
  });
});

describe('cyclePosition — loop', () => {
  const durations = [5, 5, 5];
  const anchor = { page: 0, at: T0 };

  it('stays on the anchored page until its time is up', () => {
    expect(cyclePosition(durations, anchor, s(0))).toEqual({ page: 0, nextAt: s(5), done: false });
    expect(cyclePosition(durations, anchor, s(4.9)).page).toBe(0);
  });

  it('turns on the boundary', () => {
    expect(cyclePosition(durations, anchor, s(5))).toEqual({ page: 1, nextAt: s(10), done: false });
  });

  it('answers a late question with the right page, not one behind', () => {
    // A throttled tab or a timer that fired 7s late asks once, and must land
    // exactly where it would have been — the reason the page is solved.
    expect(cyclePosition(durations, anchor, s(12)).page).toBe(2);
  });

  it('wraps, and a week of looping costs the same as a minute', () => {
    expect(cyclePosition(durations, anchor, s(15)).page).toBe(0);
    const aWeek = 7 * 24 * 3600;
    const pos = cyclePosition(durations, anchor, s(aWeek + 6));
    expect(pos.page).toBe((Math.floor((aWeek + 6) / 5)) % 3);
  });

  it('walks from the anchored page, not from page one', () => {
    expect(cyclePosition(durations, { page: 2, at: T0 }, s(6)).page).toBe(0);
  });

  it('treats a clock that stepped backwards as still on the anchored page', () => {
    expect(cyclePosition(durations, anchor, s(-30)).page).toBe(0);
  });

  it('honours unequal page times', () => {
    const uneven = [2, 10, 3];
    expect(cyclePosition(uneven, anchor, s(11)).page).toBe(1);
    expect(cyclePosition(uneven, anchor, s(12)).page).toBe(2);
    expect(cyclePosition(uneven, anchor, s(15)).page).toBe(0);
  });

  it('has nothing to do with one page', () => {
    expect(cyclePosition([5], anchor, s(100))).toEqual({ page: 0, nextAt: null, done: false });
  });
});

describe('cyclePosition — hold and continue', () => {
  const durations = [5, 5];
  const anchor = { page: 0, at: T0 };

  it('stops on the last page and reports done once it has had its time', () => {
    expect(cyclePosition(durations, anchor, s(7), 'hold')).toEqual({ page: 1, nextAt: s(10), done: false });
    expect(cyclePosition(durations, anchor, s(10), 'hold')).toEqual({ page: 1, nextAt: null, done: true });
    expect(cyclePosition(durations, anchor, s(500), 'continue').page).toBe(1);
  });

  it('lets a single page leave once its time is up', () => {
    // A round-up with one page of results must still go.
    expect(cyclePosition([4], anchor, s(3), 'continue').done).toBe(false);
    expect(cyclePosition([4], anchor, s(4), 'continue').done).toBe(true);
  });
});

describe('normalisePageKey', () => {
  it('matches the way an operator types', () => {
    expect(normalisePageKey('  C ')).toBe('c');
    expect(normalisePageKey(null)).toBe('');
    expect(normalisePageKey(3)).toBe('3');
  });
});
