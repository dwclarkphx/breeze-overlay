// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/** Timer arithmetic (Phase 9 Wave B) — shared by the hub, the runtime and the panels. */

import { describe, expect, it } from 'vitest';

import {
  applyTimerAction,
  formatTimer,
  formatTimerMs,
  idleTimer,
  parseTimerInput,
  timerFinished,
  timerTickMs,
  timerValue,
  type TextTimer,
} from '../timer.js';

const quarter: TextTimer = { id: 'game', mode: 'countdown', duration: 8 * 60, tenthsUnder: 60 };

describe('state', () => {
  it('runs from the anchor and freezes on pause', () => {
    let s = applyTimerAction(undefined, 'start', 1_000);
    expect(timerValue(quarter, s, 11_000)).toBe(8 * 60_000 - 10_000);
    s = applyTimerAction(s, 'pause', 11_000);
    // Time passing while paused changes nothing.
    expect(timerValue(quarter, s, 99_000)).toBe(8 * 60_000 - 10_000);
    s = applyTimerAction(s, 'start', 100_000);
    expect(timerValue(quarter, s, 105_000)).toBe(8 * 60_000 - 15_000);
  });

  it('is the same on two outputs reading the same state, whenever they read it', () => {
    const s = applyTimerAction(undefined, 'start', 50_000);
    // Two pages with the same hub clock agree; a page reloaded later shows the right time.
    expect(timerValue(quarter, s, 80_000)).toBe(timerValue(quarter, { ...s }, 80_000));
    expect(timerValue(quarter, s, 80_000)).toBe(8 * 60_000 - 30_000);
  });

  it('toggles, sets and adds', () => {
    let s = applyTimerAction(undefined, 'toggle', 0);
    expect(s.running).toBe(true);
    s = applyTimerAction(s, 'toggle', 2_000);
    expect(s.running).toBe(false);
    s = applyTimerAction(s, 'set', 2_000, 24_000);
    expect(timerValue({ mode: 'countdown', duration: 24 }, s, 5_000)).toBe(24_000);
    s = applyTimerAction(s, 'add', 5_000, 10_000);
    expect(timerValue({ mode: 'countdown', duration: 24 }, s, 5_000)).toBe(34_000);
    s = applyTimerAction(s, 'reset', 6_000);
    expect(s).toEqual(idleTimer());
  });

  it('stops at zero by default, and goes into overtime when told to continue', () => {
    const s = applyTimerAction(undefined, 'start', 0);
    expect(timerValue({ mode: 'countdown', duration: 5 }, s, 9_000)).toBe(0);
    expect(timerFinished({ mode: 'countdown', duration: 5 }, s, 9_000)).toBe(true);
    expect(timerValue({ mode: 'countdown', duration: 5, end: 'continue' }, s, 9_000)).toBe(-4_000);
  });

  it('counts up to a limit', () => {
    const s = applyTimerAction(undefined, 'start', 0);
    const half: TextTimer = { mode: 'countup', limit: 45 * 60 };
    expect(timerValue(half, s, 46 * 60_000)).toBe(45 * 60_000);
    expect(timerValue({ ...half, end: 'continue' }, s, 46 * 60_000)).toBe(46 * 60_000);
  });

  it('counts down to a time of day with nobody pressing start', () => {
    const at = Date.UTC(2026, 9, 25, 16, 50, 0); // 9:50 AM in Phoenix
    const service: TextTimer = { mode: 'countdown', until: '10:00', timezone: 'America/Phoenix' };
    expect(timerValue(service, undefined, at)).toBe(10 * 60_000);
    expect(formatTimer(service, undefined, at)).toBe('10:00');
    expect(timerFinished(service, undefined, at + 11 * 60_000)).toBe(true);
  });
});

describe('format', () => {
  it('rounds a countdown up and a count-up down', () => {
    expect(formatTimerMs(400, 'm:ss', 'down')).toBe('0:01');
    expect(formatTimerMs(0, 'm:ss', 'down')).toBe('0:00');
    expect(formatTimerMs(59_900, 'm:ss', 'up')).toBe('0:59');
  });

  it('carries totals into the largest unit present', () => {
    expect(formatTimerMs(75 * 60_000, 'm:ss')).toBe('75:00');
    expect(formatTimerMs(75 * 60_000, 'h:mm:ss')).toBe('1:15:00');
    expect(formatTimerMs(95_000, 's')).toBe('95');
    expect(formatTimerMs(12_340, 'ss.SS')).toBe('12.34');
  });

  it('switches to tenths in the last minute, and keeps literals literal', () => {
    const s = applyTimerAction(undefined, 'start', 0);
    expect(formatTimer(quarter, s, 7 * 60_000 + 30_000)).toBe('30.0');
    expect(formatTimer(quarter, s, 0)).toBe('8:00');
    expect(formatTimerMs(5_000, '[T-]m:ss', 'down')).toBe('T-0:05');
  });

  it('marks overtime with a minus sign', () => {
    expect(formatTimerMs(-65_000, 'm:ss', 'down')).toBe('-1:05');
  });

  it('ticks as finely as the format needs', () => {
    expect(timerTickMs({ mode: 'countdown' })).toBe(250);
    expect(timerTickMs(quarter)).toBe(100);
    expect(timerTickMs({ mode: 'stopwatch', format: 'ss.SS' })).toBe(50);
  });
});

describe('parseTimerInput', () => {
  it('reads the shapes an operator types', () => {
    expect(parseTimerInput('8:00')).toBe(480_000);
    expect(parseTimerInput('90')).toBe(90_000);
    expect(parseTimerInput('1:02:03')).toBe(3_723_000);
    expect(parseTimerInput('24.5')).toBe(24_500);
  });

  it('refuses what is not a time', () => {
    expect(parseTimerInput('')).toBeNull();
    expect(parseTimerInput('soon')).toBeNull();
    expect(parseTimerInput('1:2:3:4')).toBeNull();
  });
});
