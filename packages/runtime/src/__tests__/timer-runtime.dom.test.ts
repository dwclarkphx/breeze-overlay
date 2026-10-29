// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Operator timers in the runtime (Phase 9 Wave B): the value is solved
 * locally from the hub's anchor, against the hub's clock, and a rule can read it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TIMERS_UPDATE_KEY,
  applyTimerAction,
  createComposition,
  createTextLayer,
  type Composition,
  type Layer,
  type TextTimer,
  type TimerState,
} from '@breeze/schema';

import { BreezeRuntime } from '../runtime.js';

const T0 = Date.parse('2026-10-25T19:00:00Z');

function timerLayer(id: string, timer: TextTimer, extra: Partial<Layer> = {}): Layer {
  return { ...createTextLayer({ id, text: 'PLACEHOLDER' }), timer, ...extra } as Layer;
}

function mount(layers: Layer[], data: Record<string, unknown> = {}, still = false) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const composition: Composition = createComposition({ id: 'bug', name: 'Bug', duration: 1, layers });
  const runtime = new BreezeRuntime({ container, composition, injectStyles: false, still, data });
  cleanup.push(() => runtime.destroy());
  return runtime;
}

const textOf = (runtime: BreezeRuntime, id: string) =>
  runtime.getLayerElement(id)?.querySelector('.bz-text-inner')?.textContent ?? '';

const payload = (clock: number, timers: Record<string, TimerState>) => ({ [TIMERS_UPDATE_KEY]: { clock, timers } });

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
  vi.useRealTimers();
  document.body.textContent = '';
});

const game: TextTimer = { id: 'game', mode: 'countdown', duration: 480, tenthsUnder: 60 };

describe('timer layers', () => {
  it('shows where the timer starts before anyone has touched it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const runtime = mount([timerLayer('clock', game)]);
    expect(textOf(runtime, 'clock')).toBe('8:00');
  });

  it('runs from the hub anchor, and stops moving when paused', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const runtime = mount([timerLayer('clock', game)]);
    const running = applyTimerAction(undefined, 'start', T0);
    runtime.update(payload(T0, { game: running }));
    vi.advanceTimersByTime(65_000);
    expect(textOf(runtime, 'clock')).toBe('6:55');

    const paused = applyTimerAction(running, 'pause', T0 + 65_000);
    runtime.update(payload(T0 + 65_000, { game: paused }));
    vi.advanceTimersByTime(10_000);
    expect(textOf(runtime, 'clock')).toBe('6:55');
  });

  it('switches to tenths in the last minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const runtime = mount([timerLayer('clock', game)]);
    const state = applyTimerAction(applyTimerAction(undefined, 'set', T0, 59_950), 'start', T0);
    runtime.update(payload(T0, { game: state }));
    expect(textOf(runtime, 'clock')).toBe('60.0');
    vi.advanceTimersByTime(1_000);
    expect(textOf(runtime, 'clock')).toBe('59.0');
  });

  it('reads the hub clock, not this host clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const runtime = mount([timerLayer('clock', game)]);
    // The hub is five minutes ahead and started the clock 30 s ago by its own clock.
    const hubNow = T0 + 300_000;
    runtime.update(payload(hubNow, { game: applyTimerAction(undefined, 'start', hubNow - 30_000) }));
    expect(textOf(runtime, 'clock')).toBe('7:30');
  });

  it('is right on the first frame of a page built with retained state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const started = applyTimerAction(undefined, 'start', T0 - 120_000);
    const runtime = mount([timerLayer('clock', game)], payload(T0, { game: started }));
    expect(textOf(runtime, 'clock')).toBe('6:00');
  });

  it('lets a rule hide the layer at zero', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const countdown: TextTimer = { mode: 'countdown', duration: 5 };
    const runtime = mount([
      timerLayer('cd', countdown, { rules: [{ when: [{ timer: 'main', cmp: 'lte', value: 0 }], show: false }] } as Partial<Layer>),
    ]);
    runtime.update(payload(T0, { main: applyTimerAction(undefined, 'start', T0) }));
    expect(runtime.getLayerElement('cd')!.dataset['ruleHidden']).toBeUndefined();
    expect(runtime.timerSeconds('main')).toBe(5);
    vi.advanceTimersByTime(6_000);
    expect(textOf(runtime, 'cd')).toBe('0:00');
    expect(runtime.timerSeconds('main')).toBe(0);
    expect(runtime.getLayerElement('cd')!.dataset['ruleHidden']).toBe('1');
  });

  it('writes once and starts no interval in a still', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const runtime = mount([timerLayer('clock', game)], payload(T0, { game: applyTimerAction(undefined, 'start', T0) }), true);
    expect(textOf(runtime, 'clock')).toBe('8:00');
    vi.advanceTimersByTime(5_000);
    expect(textOf(runtime, 'clock')).toBe('8:00');
  });
});
