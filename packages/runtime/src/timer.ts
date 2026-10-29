// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Operator timers on text layers, ticked locally (Phase 9 Wave B).
 *
 * The hub owns each timer's state — running, an anchor, time run before it —
 * and sends it under `$timers` with the hub's own clock. This works out the
 * value on screen from that, against the hub's clock rather than this host's:
 * `offset` is how far the hub's clock is ahead of ours, taken when a payload
 * arrives. Two outputs on two machines whose clocks disagree by a second still
 * show the same game clock, and a reloaded browser source shows the right time
 * the moment its `welcome` lands, with nobody pressing anything.
 *
 * One interval per runtime, like `ClockTicker`, and only while a timer is
 * actually moving — a paused game clock or a stopped countdown costs nothing.
 * `until` timers (count down to a time of day) always move.
 */

import {
  formatTimer,
  timerIdOf,
  timerTickMs,
  timerValue,
  type TextTimer,
  type TimerState,
  type TimersPayload,
} from '@breeze/schema';

export interface TimerTarget {
  timer: TextTimer;
  write: (text: string) => void;
}

export class TimerTicker {
  private targets = new Map<string, TimerTarget>();
  private last = new Map<string, string>();
  private states: Record<string, TimerState> = {};
  /** Hub clock minus our clock, ms. */
  private offset = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private period = 0;

  constructor(
    /** Called when any text changed on a tick — the runtime refits and re-runs rules. */
    private readonly onChange: () => void,
    /** Injected for tests. */
    private readonly now: () => number = () => Date.now(),
    /** A still: write on add and on payloads, never start an interval. */
    private readonly once = false,
  ) {}

  /** The hub's clock, as best this host can tell. */
  hubNow(): number {
    return this.now() + this.offset;
  }

  add(id: string, target: TimerTarget): void {
    this.targets.set(id, target);
    this.writeOne(id, target);
    this.restart();
  }

  remove(id: string): void {
    this.targets.delete(id);
    this.last.delete(id);
    this.restart();
  }

  get size(): number {
    return this.targets.size;
  }

  /** Take the hub's latest state. Ignores anything that is not a timers payload. */
  setPayload(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') return false;
    const p = payload as Partial<TimersPayload>;
    if (typeof p.clock === 'number' && Number.isFinite(p.clock)) this.offset = p.clock - this.now();
    this.states = p.timers && typeof p.timers === 'object' ? { ...p.timers } : {};
    const changed = this.tick();
    this.restart();
    return changed;
  }

  /** A timer's state by id, for a panel or a test. */
  state(id: string): TimerState | undefined {
    return this.states[id];
  }

  /**
   * A timer's value in seconds — time left for a countdown, time run for a
   * count-up — as a layer rule reads it (`timer: 'game', cmp: 'lte', value: 30`).
   * Undefined when no layer on this graphic shows that timer.
   */
  seconds(id: string): number | undefined {
    for (const target of this.targets.values()) {
      if (timerIdOf(target.timer) !== id) continue;
      return timerValue(target.timer, this.states[id], this.hubNow()) / 1000;
    }
    return undefined;
  }

  /** Render every target now. True if any text changed. */
  tick(): boolean {
    let changed = false;
    for (const [id, target] of this.targets) if (this.writeOne(id, target)) changed = true;
    return changed;
  }

  private writeOne(id: string, target: TimerTarget): boolean {
    const text = formatTimer(target.timer, this.states[timerIdOf(target.timer)], this.hubNow());
    if (this.last.get(id) === text) return false;
    this.last.set(id, text);
    target.write(text);
    return true;
  }

  /** Whether anything on screen can change without a new payload. */
  private moving(target: TimerTarget): boolean {
    if (target.timer.until !== undefined) return true;
    return this.states[timerIdOf(target.timer)]?.running === true;
  }

  private restart(): void {
    if (this.once) return;
    const live = [...this.targets.values()].filter((t) => this.moving(t));
    const wanted = live.length ? Math.min(...live.map((t) => timerTickMs(t.timer))) : 0;
    if (wanted === this.period && (this.interval || !wanted)) return;
    this.stop();
    this.period = wanted;
    if (!wanted) return;
    this.interval = setInterval(() => {
      if (this.tick()) this.onChange();
    }, wanted);
    (this.interval as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.period = 0;
  }

  destroy(): void {
    this.stop();
    this.targets.clear();
    this.last.clear();
  }
}
