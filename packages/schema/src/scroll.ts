// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The scroll transport behind roll layers (Phase 9 Wave R, ROLLS.md §5).
 *
 * **The runtime solves the position; the hub owns the state** — the timer's
 * rule (timer.ts), applied to a clock with a speed and a sign. A scroll's state
 * is `{ running, anchor, base, rate }`, retained per channel under `$scrolls`.
 * Each output works out where the text is from the hub's anchor, so two
 * outputs agree, a reloaded browser source is on the right line with no
 * operator action, and a network blip cannot freeze a credits roll.
 *
 * **Travel is in seconds at the designer's speed, not pixels.** The hub knows
 * nothing about layout; a time survives the designer changing the speed, is the
 * same on two outputs rendering the same text, and lets two rolls sharing one
 * id at different speeds stay in proportion. On screen it is `travel × speed`
 * px.
 *
 * **Extent** — the whole travel, in the same seconds — is known only to a
 * renderer, which reports it with its playback. The hub clamps with the last
 * extent it heard every time it rebases, so reversing at the end moves at
 * once instead of first unwinding time spent "past" the end.
 *
 * Free of I/O, so the hub, the runtime and the panels share one copy.
 */

import type { RollEnd, RollStart } from './types.js';

/** Reserved update key: `{ clock, scrolls, playAt? }`. */
export const SCROLLS_UPDATE_KEY = '$scrolls';

/** The id a roll has when it names none. */
export const DEFAULT_SCROLL_ID = 'main';

export const SCROLL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;

/** One scroll's state, as the hub retains it. Times are hub-clock epoch ms. */
export interface ScrollState {
  running: boolean;
  /** When `base` was taken. Meaningless while stopped. */
  anchor: number;
  /** Travel at `anchor`, in seconds at the designer's speed. */
  base: number;
  /** Signed multiple of the designer's speed: +1 forward as designed, −0.5 backward at half. */
  rate: number;
}

export interface ScrollsPayload {
  /** The hub's clock when this was sent, so a page can correct for its own clock. */
  clock: number;
  /** Scrolls an operator has touched since the last PLAY. */
  scrolls: Record<string, ScrollState>;
  /**
   * When the graphic was last played (hub clock). A roll with `start: 'play'`
   * and no state of its own is running from here at ×1; with `start:
   * 'operator'` it waits at the top. Absent: nothing has been played.
   */
  playAt?: number;
}

export const SCROLL_ACTIONS = [
  'play',
  'pause',
  'toggle',
  'forward',
  'backward',
  'reverse',
  'faster',
  'slower',
  'speed',
  'jog',
  'seek',
  'restart',
  'end',
  'reset',
] as const;
export type ScrollAction = (typeof SCROLL_ACTIONS)[number];

/** The operator's speed ladder — multiples of the designer's speed (decided 2026-10-26). */
export const SCROLL_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export const SCROLL_SPEED_MIN = 0.1;
export const SCROLL_SPEED_MAX = 10;

/** What a renderer reports about one scroll, so the hub can clamp and a panel can draw a position bar. */
export interface ScrollInfo {
  /** The whole travel, seconds at the designer's speed. */
  extent?: number;
  end?: RollEnd;
  start?: RollStart;
}

/** A scroll's report, as an output sends it with its playback. */
export interface ScrollReport extends ScrollInfo {
  id: string;
  /** Travel now, in seconds — for the panel's position bar. */
  travel: number;
  running: boolean;
  rate: number;
}

export function idleScroll(): ScrollState {
  return { running: false, anchor: 0, base: 0, rate: 1 };
}

/**
 * The state a scroll is in when nobody has touched it since PLAY: running from
 * PLAY at ×1 for a roll that starts on PLAY, waiting at the top for one that
 * waits for the operator.
 */
export function implicitScroll(start: RollStart | undefined, playAt: number | undefined): ScrollState {
  if ((start ?? 'play') === 'play' && playAt !== undefined) return { running: true, anchor: playAt, base: 0, rate: 1 };
  return idleScroll();
}

/** A scroll's state from a payload: its own if touched, else implicit. */
export function resolveScroll(
  payload: Pick<ScrollsPayload, 'scrolls' | 'playAt'> | undefined,
  id: string,
  start: RollStart | undefined,
): ScrollState {
  return payload?.scrolls[id] ?? implicitScroll(start, payload?.playAt);
}

/** Travel at `now`, unclamped. */
export function scrollTravel(state: ScrollState, now: number): number {
  return state.base + (state.running ? (state.rate * Math.max(0, now - state.anchor)) / 1000 : 0);
}

/**
 * Travel kept inside the text: clamped to `[0, extent]`, or wrapped round it
 * for a loop. With no extent known (no output has reported yet) it is only
 * kept from going below zero.
 */
export function clampTravel(travel: number, info: ScrollInfo | undefined): number {
  const extent = info?.extent;
  if (extent === undefined || !Number.isFinite(extent) || extent <= 0) return Math.max(0, travel);
  if (info?.end === 'loop') return ((travel % extent) + extent) % extent;
  return Math.min(extent, Math.max(0, travel));
}

/** Where a scroll is at `now`, kept inside the text. */
export function scrollPosition(state: ScrollState, now: number, info?: ScrollInfo): number {
  return clampTravel(scrollTravel(state, now), info);
}

/** Whether a scroll that is not looping has reached the end it is heading for. */
export function scrollAtEnd(state: ScrollState, now: number, info: ScrollInfo | undefined): boolean {
  const extent = info?.extent;
  if (extent === undefined || info?.end === 'loop') return false;
  const travel = scrollTravel(state, now);
  return state.rate >= 0 ? travel >= extent : travel <= 0;
}

/** The next rung up (or down) the speed ladder from `speed`. */
export function nextScrollSpeed(speed: number, dir: 1 | -1): number {
  const s = Math.abs(speed);
  if (dir > 0) return SCROLL_SPEEDS.find((v) => v > s + 1e-9) ?? SCROLL_SPEEDS[SCROLL_SPEEDS.length - 1]!;
  return [...SCROLL_SPEEDS].reverse().find((v) => v < s - 1e-9) ?? SCROLL_SPEEDS[0]!;
}

export interface ScrollActionValue {
  /** `speed`: the multiple. `jog`: signed seconds. `seek`: seconds, or a percentage when `percent`. */
  value?: number;
  percent?: boolean;
}

/**
 * Apply an operator action. Every action rebases first — `base` becomes where
 * the scroll is now, clamped, and `anchor` becomes now — so nothing on screen
 * jumps, and the arithmetic after is about one instant.
 */
export function applyScrollAction(
  previous: ScrollState | undefined,
  action: ScrollAction,
  now: number,
  arg: ScrollActionValue = {},
  info?: ScrollInfo,
): ScrollState {
  const prior = previous ?? idleScroll();
  const state: ScrollState = { ...prior, base: scrollPosition(prior, now, info), anchor: now };
  const speed = Math.abs(state.rate) || 1;
  const sign = state.rate < 0 ? -1 : 1;
  const value = arg.value !== undefined && Number.isFinite(arg.value) ? arg.value : undefined;
  switch (action) {
    case 'play':
      state.running = true;
      return state;
    case 'pause':
      state.running = false;
      return state;
    case 'toggle':
      state.running = !state.running;
      return state;
    case 'forward':
      state.rate = speed;
      state.running = true;
      return state;
    case 'backward':
      state.rate = -speed;
      state.running = true;
      return state;
    case 'reverse':
      state.rate = -state.rate || -1;
      return state;
    case 'faster':
      state.rate = sign * nextScrollSpeed(speed, 1);
      return state;
    case 'slower':
      state.rate = sign * nextScrollSpeed(speed, -1);
      return state;
    case 'speed':
      if (value !== undefined) state.rate = sign * Math.min(SCROLL_SPEED_MAX, Math.max(SCROLL_SPEED_MIN, Math.abs(value)));
      return state;
    case 'jog':
      if (value !== undefined) state.base = clampTravel(state.base + value, info);
      return state;
    case 'seek': {
      if (value === undefined) return state;
      const extent = info?.extent;
      if (arg.percent) {
        if (extent === undefined) return state;
        state.base = clampTravel((Math.min(100, Math.max(0, value)) / 100) * extent, info);
      } else {
        state.base = clampTravel(value, info);
      }
      return state;
    }
    case 'restart':
      state.base = 0;
      return state;
    case 'end':
      if (info?.extent !== undefined) state.base = info.extent;
      return state;
    case 'reset':
      return { ...idleScroll(), anchor: now };
  }
}

/** The scroll a roll layer is driven by, with its id resolved. */
export function scrollIdOf(layer: { scrollId?: string }): string {
  return layer.scrollId ?? DEFAULT_SCROLL_ID;
}

/** One scroll a composition shows, for a panel: its id and the first roll's settings. */
export interface ScrollRef {
  id: string;
  layerId: string;
  layerName: string;
  direction: string;
  speed: number;
  start: RollStart;
  end: RollEnd;
}

interface ScrollLayerLike {
  id: string;
  name?: string;
  type: string;
  scrollId?: string;
  direction?: string;
  speed?: number;
  start?: RollStart;
  end?: RollEnd;
  children?: ScrollLayerLike[];
  ref?: string;
}

/**
 * Every scroll a composition shows — its own rolls, groups', and those of the
 * compositions it mounts (`resolve`), since a mounted credits roll runs on the
 * channel it is mounted in. First roll per id wins.
 */
export function collectScrolls(
  layers: readonly ScrollLayerLike[],
  resolve?: (id: string) => { layers: readonly ScrollLayerLike[] } | undefined,
): ScrollRef[] {
  const out = new Map<string, ScrollRef>();
  const seen = new Set<string>();
  const walk = (list: readonly ScrollLayerLike[]): void => {
    for (const layer of list) {
      if (layer.type === 'roll') {
        const id = scrollIdOf(layer);
        if (!out.has(id)) {
          out.set(id, {
            id,
            layerId: layer.id,
            layerName: layer.name ?? layer.id,
            direction: layer.direction ?? 'up',
            speed: layer.speed ?? 0,
            start: layer.start ?? 'play',
            end: layer.end ?? 'hold',
          });
        }
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

/**
 * Read a seek value as an operator types it: `90` and `1:30` are seconds,
 * `50%` is half way. Null when it is neither.
 */
export function parseScrollSeek(text: string): ScrollActionValue | null {
  const t = text.trim();
  const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(t);
  if (pct) return { value: Number(pct[1]), percent: true };
  const parts = t.split(':');
  if (t === '' || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + Number(p);
  return { value: seconds };
}
