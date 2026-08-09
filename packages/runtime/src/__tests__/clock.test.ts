// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Clock formatter and ticker.
 *
 * Every assertion pins an explicit instant and an explicit zone. A test that
 * formats `new Date()` and checks the shape of the answer passes at 09:05 and
 * fails at 10:05 when `h` stops being one character — and the class of bug this
 * feature can actually have is exactly that: a boundary, an hour that is 12
 * rather than 0, a zone that does not observe DST.
 */

import { describe, expect, it, vi } from 'vitest';

import { ClockTicker, formatClock, tickIntervalFor } from '../clock.js';

/** Monday 3 August 2026, 01:42:07 UTC — an evening in the Americas. */
const T = new Date('2026-08-03T01:42:07Z');
const PHX = 'America/Phoenix';

describe('formatClock', () => {
  it('formats the common broadcast layouts', () => {
    expect(formatClock(T, { format: 'h:mm A', timezone: PHX })).toBe('6:42 PM');
    expect(formatClock(T, { format: 'h:mm:ss A', timezone: PHX })).toBe('6:42:07 PM');
    expect(formatClock(T, { format: 'HH:mm', timezone: PHX })).toBe('18:42');
    expect(formatClock(T, { format: 'hh:mm a', timezone: PHX })).toBe('06:42 pm');
  });

  it('resolves the date tokens', () => {
    expect(formatClock(T, { format: 'ddd D MMM', timezone: PHX })).toBe('Sun 2 Aug');
    expect(formatClock(T, { format: 'dddd, MMMM D YYYY', timezone: PHX })).toBe(
      'Sunday, August 2 2026',
    );
    expect(formatClock(T, { format: 'DD/MM/YY', timezone: 'Europe/London' })).toBe('03/08/26');
  });

  it('puts midnight and noon on the right side of 12', () => {
    const midnight = new Date('2026-08-03T07:00:00Z'); // 00:00 in Phoenix
    const noon = new Date('2026-08-03T19:00:00Z'); // 12:00 in Phoenix

    expect(formatClock(midnight, { format: 'h:mm A', timezone: PHX })).toBe('12:00 AM');
    expect(formatClock(midnight, { format: 'HH:mm', timezone: PHX })).toBe('00:00');
    expect(formatClock(noon, { format: 'h:mm A', timezone: PHX })).toBe('12:00 PM');
    expect(formatClock(noon, { format: 'HH:mm', timezone: PHX })).toBe('12:00');
  });

  it('follows DST where the zone observes it, and not where it does not', () => {
    const winter = new Date('2026-01-15T18:00:00Z');
    const summer = new Date('2026-07-15T18:00:00Z');

    // New York shifts an hour between the two.
    expect(formatClock(winter, { format: 'h:mm A', timezone: 'America/New_York' })).toBe('1:00 PM');
    expect(formatClock(summer, { format: 'h:mm A', timezone: 'America/New_York' })).toBe('2:00 PM');

    // Arizona does not. This is the assertion that would fail if the formatter
    // were doing offset arithmetic on a Date instead of asking Intl.
    expect(formatClock(winter, { format: 'h:mm A', timezone: PHX })).toBe('11:00 AM');
    expect(formatClock(summer, { format: 'h:mm A', timezone: PHX })).toBe('11:00 AM');
  });

  it('crosses the date line into the next day', () => {
    expect(formatClock(T, { format: 'ddd HH:mm', timezone: 'Asia/Tokyo' })).toBe('Mon 10:42');
    expect(formatClock(T, { format: 'ddd HH:mm', timezone: PHX })).toBe('Sun 18:42');
  });

  it('copies separators through and honours bracket escapes', () => {
    expect(formatClock(T, { format: '[Now] h:mm A', timezone: PHX })).toBe('Now 6:42 PM');
    // Without the escape, `D` is a day-of-month token — the reason escapes exist.
    expect(formatClock(T, { format: 'D', timezone: PHX })).toBe('2');
    expect(formatClock(T, { format: '[D]', timezone: PHX })).toBe('D');
  });

  it('matches the longest token first', () => {
    // `mm` must not be read as two `m`s, nor `MMMM` as `MMM` + `M`.
    expect(formatClock(T, { format: 'mm', timezone: PHX })).toBe('42');
    expect(formatClock(T, { format: 'MMMM', timezone: PHX })).toBe('August');
    expect(formatClock(T, { format: 'MMM', timezone: PHX })).toBe('Aug');
    expect(formatClock(T, { format: 'MM', timezone: PHX })).toBe('08');
    expect(formatClock(T, { format: 'M', timezone: PHX })).toBe('8');
  });

  it('falls back to the host zone when none is given', () => {
    const withZone = formatClock(T, {
      format: 'HH:mm',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(formatClock(T, { format: 'HH:mm' })).toBe(withZone);
  });
});

describe('tickIntervalFor', () => {
  it('wakes every second only when seconds are on screen', () => {
    expect(tickIntervalFor({ format: 'h:mm:ss A' })).toBe(1000);
    expect(tickIntervalFor({ format: 'HH:mm:ss' })).toBe(1000);
    expect(tickIntervalFor({ format: 'h:mm A' })).toBe(5000);
    expect(tickIntervalFor({ format: 'ddd D MMM' })).toBe(5000);
  });

  it('does not count an s inside an escaped literal', () => {
    // `[seconds]` is a label, not a request for a one-second tick.
    expect(tickIntervalFor({ format: '[seconds] h:mm A' })).toBe(5000);
  });

  it('lets an explicit tickSeconds win', () => {
    expect(tickIntervalFor({ format: 'h:mm A', tickSeconds: 0.5 })).toBe(500);
  });
});

describe('ClockTicker', () => {
  function harness(iso = '2026-08-03T01:42:07Z') {
    const state = { now: new Date(iso), changes: 0, text: {} as Record<string, string> };
    const ticker = new ClockTicker(
      () => (state.changes += 1),
      () => state.now,
    );
    return { state, ticker };
  }

  it('writes the real time on add, not on the first tick', () => {
    const { state, ticker } = harness();
    ticker.add('a', {
      clock: { format: 'h:mm A', timezone: PHX },
      write: (t) => (state.text['a'] = t),
    });

    // The whole point: a graphic cued ten minutes before air must not sit on
    // its authored placeholder until an interval fires.
    expect(state.text['a']).toBe('6:42 PM');
    expect(state.changes).toBe(0);
    ticker.destroy();
  });

  it('reports no change when the rendered text is identical', () => {
    const { state, ticker } = harness();
    ticker.add('a', {
      clock: { format: 'h:mm A', timezone: PHX },
      write: (t) => (state.text['a'] = t),
    });

    state.now = new Date('2026-08-03T01:42:59Z'); // same minute
    expect(ticker.tick()).toBe(false);

    state.now = new Date('2026-08-03T01:43:01Z'); // next minute
    expect(ticker.tick()).toBe(true);
    expect(state.text['a']).toBe('6:43 PM');
    ticker.destroy();
  });

  it('drives several targets from one timer and fires onChange once', () => {
    const { state, ticker } = harness();
    ticker.add('time', {
      clock: { format: 'h:mm A', timezone: PHX },
      write: (t) => (state.text['time'] = t),
    });
    ticker.add('date', {
      clock: { format: 'ddd D MMM', timezone: PHX },
      write: (t) => (state.text['date'] = t),
    });

    expect(ticker.size).toBe(2);
    state.now = new Date('2026-08-04T01:43:01Z');
    expect(ticker.tick()).toBe(true);
    expect(state.text).toEqual({ time: '6:43 PM', date: 'Mon 3 Aug' });
    ticker.destroy();
  });

  it('stops writing once removed, and once destroyed', () => {
    const { state, ticker } = harness();
    ticker.add('a', {
      clock: { format: 'h:mm:ss A', timezone: PHX },
      write: (t) => (state.text['a'] = t),
    });
    ticker.remove('a');

    state.now = new Date('2026-08-03T01:43:01Z');
    expect(ticker.tick()).toBe(false);
    expect(state.text['a']).toBe('6:42:07 PM');
    expect(ticker.size).toBe(0);
    ticker.destroy();
  });

  it('clears its interval on destroy', () => {
    vi.useFakeTimers();
    try {
      const { state, ticker } = harness();
      ticker.add('a', {
        clock: { format: 'h:mm:ss A', timezone: PHX },
        write: (t) => (state.text['a'] = t),
      });

      state.now = new Date('2026-08-03T01:43:01Z');
      vi.advanceTimersByTime(1100);
      expect(state.changes).toBe(1);

      ticker.destroy();
      state.now = new Date('2026-08-03T01:44:01Z');
      vi.advanceTimersByTime(5000);
      // An interval surviving destroy is the editor's rebuild-per-keystroke
      // leak; this is the assertion that catches it.
      expect(state.changes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
