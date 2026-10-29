// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Timers on text layers (Phase 9 Wave B, PHASE9.md §3).
 *
 * A timer is a property of a text layer, beside `TextClock` and for the same
 * reason: Fit Width, styling, reveals and masks for free. Countdown, count-up
 * and stopwatch, plus `until` — counting down to a time of day, which is the
 * church "service starts in" clock and needs nobody to press start.
 *
 * **The runtime solves the time; the hub owns the state.** A timer's state is
 * `{ running, anchor, elapsed, base?, adjust }`, retained per channel under
 * `$timers` exactly like field data. The value on screen is worked out locally
 * from the hub's anchor, so two outputs agree, a reloaded browser source shows
 * the right time with no operator action, and a network blip cannot freeze the
 * clock — the `TextClock` argument against a websocket frame per second,
 * applied to a clock the operator controls.
 *
 * Free of I/O, so the hub, the runtime and the panels share one copy of the
 * arithmetic.
 */

import { localParts } from './time.js';

export const TIMER_MODES = ['countdown', 'countup', 'stopwatch'] as const;
export type TimerMode = (typeof TIMER_MODES)[number];

/**
 * What happens at the end — zero for a countdown, `limit` for a count-up.
 * `stop` holds the end value on screen; `continue` keeps going (a countdown
 * goes negative, shown with a minus sign: overtime).
 */
export const TIMER_ENDS = ['stop', 'continue'] as const;
export type TimerEnd = (typeof TIMER_ENDS)[number];

/** The id a timer has when the layer names none. */
export const DEFAULT_TIMER_ID = 'main';

export const TIMER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;

export interface TextTimer {
  /**
   * Which of the channel's timers this layer shows — `game`, `shot`. Two
   * layers naming the same id show the same clock. Default `main`.
   */
  id?: string;
  mode: TimerMode;
  /** Countdown: where it starts, in seconds. Count-up: where it starts (default 0). */
  duration?: number;
  /** Count-up: where it ends, in seconds. Absent counts up for ever. */
  limit?: number;
  /**
   * Countdown only: count down to this time of day instead — `10:00` or
   * `18:30:00`, 24-hour, in `timezone`. Needs nobody to press start, and
   * ignores start, pause and set: the time of day is the state.
   */
  until?: string;
  /** IANA zone for `until`. Absent is the render host's zone. */
  timezone?: string;
  /**
   * Tokens: `h` `hh` hours, `m` `mm` minutes (total minutes when there is no
   * hour token), `s` `ss` seconds (total seconds when there is no minute
   * token), `S` tenths, `SS` hundredths. `[text]` is literal. Default `m:ss`,
   * or `m:ss.S` for a stopwatch.
   */
  format?: string;
  /**
   * Under this many seconds, switch to `tenthsFormat` — the last minute of a
   * basketball quarter reads `59.9`, not `0:59`.
   */
  tenthsUnder?: number;
  /** The format used under `tenthsUnder`. Default `s.S`. */
  tenthsFormat?: string;
  end?: TimerEnd;
}

/** One timer's state, as the hub retains it. Times are hub-clock epoch ms. */
export interface TimerState {
  running: boolean;
  /** When it last started running. Meaningless while stopped. */
  anchor: number;
  /** Milliseconds run before `anchor`. */
  elapsed: number;
  /** Replaces the layer's `duration` — what `set` writes. */
  base?: number;
  /** Added to the displayed value — what `add` accumulates. */
  adjust: number;
}

/** Reserved update key: `{ clock: hubNowMs, timers: Record<id, TimerState> }`. */
export const TIMERS_UPDATE_KEY = '$timers';

export interface TimersPayload {
  /** The hub's clock when this was sent, so a page can correct for its own clock being wrong. */
  clock: number;
  timers: Record<string, TimerState>;
}

export const TIMER_ACTIONS = ['start', 'pause', 'toggle', 'reset', 'set', 'add'] as const;
export type TimerAction = (typeof TIMER_ACTIONS)[number];

export function idleTimer(): TimerState {
  return { running: false, anchor: 0, elapsed: 0, adjust: 0 };
}

/** Milliseconds a timer has run by `now`. */
export function timerElapsed(state: TimerState, now: number): number {
  return state.elapsed + (state.running ? Math.max(0, now - state.anchor) : 0);
}

/**
 * Apply an operator action. `value` is in milliseconds, for `set` (the new
 * displayed value) and `add` (a signed change to it).
 */
export function applyTimerAction(
  previous: TimerState | undefined,
  action: TimerAction,
  now: number,
  value?: number,
): TimerState {
  const state: TimerState = { ...(previous ?? idleTimer()) };
  switch (action) {
    case 'start':
      if (!state.running) {
        state.running = true;
        state.anchor = now;
      }
      return state;
    case 'pause':
      if (state.running) {
        state.elapsed = timerElapsed(state, now);
        state.running = false;
      }
      return state;
    case 'toggle':
      return applyTimerAction(state, state.running ? 'pause' : 'start', now);
    case 'reset':
      return idleTimer();
    case 'set':
      state.base = Math.max(0, value ?? 0);
      state.elapsed = 0;
      state.adjust = 0;
      if (state.running) state.anchor = now;
      return state;
    case 'add':
      state.adjust += value ?? 0;
      return state;
  }
}

/** Seconds from now's time of day to `until`'s, in `zone`. Negative once it has passed. */
function untilMs(until: string, zone: string | undefined, now: number): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(until.trim());
  if (!m) return 0;
  const target = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
  const at = new Date(now);
  const parts = localParts(zone, at);
  const current = parts.hour * 3600 + parts.minute * 60 + parts.second + at.getMilliseconds() / 1000;
  return Math.round((target - current) * 1000);
}

/**
 * The value on screen, in milliseconds: time left for a countdown, time run
 * for a count-up. Clamped at the end unless `end: 'continue'`.
 */
export function timerValue(timer: TextTimer, state: TimerState | undefined, now: number): number {
  const s = state ?? idleTimer();
  const end = timer.end ?? 'stop';
  if (timer.mode === 'countdown') {
    const left = timer.until !== undefined
      ? untilMs(timer.until, timer.timezone, now) + s.adjust
      : (s.base ?? (timer.duration ?? 0) * 1000) - timerElapsed(s, now) + s.adjust;
    return end === 'stop' ? Math.max(0, left) : left;
  }
  const run = (s.base ?? (timer.duration ?? 0) * 1000) + timerElapsed(s, now) + s.adjust;
  const limit = timer.limit !== undefined ? timer.limit * 1000 : undefined;
  return end === 'stop' && limit !== undefined ? Math.min(limit, Math.max(0, run)) : Math.max(0, run);
}

/** Whether a timer has reached its end — zero, or `limit`. */
export function timerFinished(timer: TextTimer, state: TimerState | undefined, now: number): boolean {
  const v = timerValue(timer, state, now);
  if (timer.mode === 'countdown') return v <= 0;
  return timer.limit !== undefined && v >= timer.limit * 1000;
}

const TIMER_TOKENS = ['hh', 'mm', 'ss', 'SS', 'h', 'm', 's', 'S'] as const;

/**
 * Render milliseconds through a token format. A countdown shows whole seconds
 * rounded *up* (0.4 s left reads `0:01`, and `0:00` means zero), a count-up
 * rounds down — the convention every broadcast clock follows.
 */
export function formatTimerMs(ms: number, format: string, direction: 'down' | 'up' = 'up'): string {
  const negative = ms < 0;
  const abs = Math.abs(ms);
  const hasTenths = format.includes('S');
  const hasHundredths = format.includes('SS');
  const unit = hasHundredths ? 10 : hasTenths ? 100 : 1000;
  const units = direction === 'down' && !negative ? Math.ceil(abs / unit) : Math.floor(abs / unit);
  const total = units * unit;
  const bare = format.replace(/\[[^\]]*\]/g, '');
  const hasH = bare.includes('h');
  const hasM = bare.includes('m');
  const hours = Math.floor(total / 3_600_000);
  const minutesTotal = Math.floor(total / 60_000);
  const minutes = hasH ? minutesTotal % 60 : minutesTotal;
  const secondsTotal = Math.floor(total / 1000);
  const seconds = hasM ? secondsTotal % 60 : secondsTotal;
  const tenths = Math.floor((total % 1000) / 100);
  const hundredths = Math.floor((total % 1000) / 10);
  const value: Record<(typeof TIMER_TOKENS)[number], string> = {
    hh: String(hours).padStart(2, '0'),
    h: String(hours),
    mm: String(minutes).padStart(2, '0'),
    m: String(minutes),
    ss: String(seconds).padStart(2, '0'),
    s: String(seconds),
    SS: String(hundredths).padStart(2, '0'),
    S: String(tenths),
  };
  let out = '';
  let i = 0;
  while (i < format.length) {
    if (format[i] === '[') {
      const close = format.indexOf(']', i);
      if (close !== -1) {
        out += format.slice(i + 1, close);
        i = close + 1;
        continue;
      }
    }
    const token = TIMER_TOKENS.find((t) => format.startsWith(t, i));
    if (token) {
      out += value[token];
      i += token.length;
    } else {
      out += format[i];
      i += 1;
    }
  }
  return negative && total > 0 ? `-${out}` : out;
}

/** The text a timer layer shows at `now`. */
export function formatTimer(timer: TextTimer, state: TimerState | undefined, now: number): string {
  const ms = timerValue(timer, state, now);
  const base = timer.format ?? (timer.mode === 'stopwatch' ? 'm:ss.S' : 'm:ss');
  const format =
    timer.tenthsUnder !== undefined && ms >= 0 && ms < timer.tenthsUnder * 1000 ? (timer.tenthsFormat ?? 's.S') : base;
  return formatTimerMs(ms, format, timer.mode === 'countdown' ? 'down' : 'up');
}

/** How often a timer's text can change: tenths need 100 ms, hundredths 50, seconds 250. */
export function timerTickMs(timer: TextTimer): number {
  const formats = [timer.format ?? (timer.mode === 'stopwatch' ? 'm:ss.S' : 'm:ss')];
  if (timer.tenthsUnder !== undefined) formats.push(timer.tenthsFormat ?? 's.S');
  if (formats.some((f) => f.includes('SS'))) return 50;
  if (formats.some((f) => f.includes('S'))) return 100;
  return 250;
}

/**
 * Read `1:30`, `90`, `1:02:03` or `12.5` as milliseconds. Null when it is not a
 * time — the panel's Set box says so rather than setting zero.
 */
export function parseTimerInput(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const parts = t.split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + Number(p);
  return Math.round(seconds * 1000);
}

/** The timer a text layer shows, with its id resolved. */
export function timerIdOf(timer: TextTimer): string {
  return timer.id ?? DEFAULT_TIMER_ID;
}

/** One timer a composition shows, for a panel: its id and the first layer's settings. */
export interface TimerRef {
  id: string;
  layerId: string;
  layerName: string;
  timer: TextTimer;
}

interface TimerLayerLike {
  id: string;
  name?: string;
  type: string;
  timer?: TextTimer;
  children?: TimerLayerLike[];
  ref?: string;
}

/**
 * Every timer id a composition shows — its own layers, groups, and the
 * compositions it mounts (`resolve`), since a mounted scorebug's clock runs on
 * the channel of the graphic it is mounted in. First layer per id wins.
 */
export function collectTimers(
  layers: readonly TimerLayerLike[],
  resolve?: (id: string) => { layers: readonly TimerLayerLike[] } | undefined,
): TimerRef[] {
  const out = new Map<string, TimerRef>();
  const seen = new Set<string>();
  const walk = (list: readonly TimerLayerLike[]): void => {
    for (const layer of list) {
      if (layer.type === 'text' && layer.timer) {
        const id = timerIdOf(layer.timer);
        if (!out.has(id)) out.set(id, { id, layerId: layer.id, layerName: layer.name ?? layer.id, timer: layer.timer });
      }
      if (layer.children) walk(layer.children);
      if (layer.type === 'composition' && layer.ref && resolve && !seen.has(layer.ref)) {
        seen.add(layer.ref);
        const nested = resolve(layer.ref);
        if (nested) walk(nested.layers);
      }
    }
  };
  walk(layers);
  return [...out.values()];
}
