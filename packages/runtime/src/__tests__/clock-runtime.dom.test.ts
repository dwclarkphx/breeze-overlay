// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Clock layers inside the runtime — the wiring, not the formatting.
 *
 * The formatter has its own unit tests. What only shows up here is whether the
 * runtime finds clock layers at all, writes them before the first paint,
 * re-runs Fit Width when the text changes width, and lets go of its timer on
 * destroy.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComposition, createTextLayer, type Composition } from '@breeze/schema';

import { BreezeRuntime } from '../runtime.js';

const PHX = 'America/Phoenix';
/** Monday 3 August 2026, 01:42:07 UTC — 18:42 in Phoenix. */
const T0 = new Date('2026-08-03T01:42:07Z');

function comp(layers: Composition['layers']): Composition {
  return createComposition({ id: 'bug', name: 'Bug', duration: 1, layers });
}

function mount(composition: Composition) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const runtime = new BreezeRuntime({ container, composition, injectStyles: false });
  return { runtime, container };
}

const textOf = (runtime: BreezeRuntime, id: string) =>
  runtime.getLayerElement(id)?.querySelector('.bz-text-inner')?.textContent ?? '';

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
  vi.useRealTimers();
  document.body.textContent = '';
});

describe('clock layers', () => {
  it('overwrites the authored placeholder before the first paint', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const { runtime } = mount(
      comp([
        createTextLayer({
          id: 'time',
          text: 'PLACEHOLDER',
          clock: { format: 'h:mm A', timezone: PHX },
        }),
      ]),
    );
    cleanup.push(() => runtime.destroy());

    // Not after the first interval — immediately. A graphic cued and held
    // before air must never show the placeholder on a renderer.
    expect(textOf(runtime, 'time')).toBe('6:42 PM');
  });

  it('advances the text when the wall clock crosses a minute', () => {
    vi.useFakeTimers();
    /*
     * 01:42:07Z, and time is advanced only by `advanceTimersByTime` from here.
     * Fake timers move the system clock as well as the timer queue, so calling
     * `setSystemTime` between advances would double-count — that mistake makes
     * this test read as though the clock ran a minute fast.
     */
    vi.setSystemTime(T0);

    const { runtime } = mount(
      comp([
        createTextLayer({ id: 'time', text: '', clock: { format: 'h:mm A', timezone: PHX } }),
      ]),
    );
    cleanup.push(() => runtime.destroy());
    expect(textOf(runtime, 'time')).toBe('6:42 PM');

    // → 01:42:37Z. Several ticks have fired and none should have changed
    // anything: the format has no seconds, so the text is still 6:42 PM.
    vi.advanceTimersByTime(30_000);
    expect(textOf(runtime, 'time')).toBe('6:42 PM');

    // → 01:43:07Z, over the minute boundary.
    vi.advanceTimersByTime(30_000);
    expect(textOf(runtime, 'time')).toBe('6:43 PM');
  });

  it('leaves ordinary text layers alone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const { runtime } = mount(
      comp([
        createTextLayer({ id: 'name', text: 'JANE DOE' }),
        createTextLayer({ id: 'time', text: '', clock: { format: 'HH:mm', timezone: PHX } }),
      ]),
    );
    cleanup.push(() => runtime.destroy());

    vi.setSystemTime(new Date('2026-08-03T02:43:02Z'));
    vi.advanceTimersByTime(6000);

    expect(textOf(runtime, 'name')).toBe('JANE DOE');
    expect(textOf(runtime, 'time')).toBe('19:43');
  });

  it('keeps ticking a clock that also carries a text reveal', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const { runtime } = mount(
      comp([
        createTextLayer({
          id: 'time',
          text: '',
          clock: { format: 'h:mm A', timezone: PHX },
          textAnimPreset: { id: 'chars-up' },
        }),
      ]),
    );
    cleanup.push(() => runtime.destroy());

    /*
     * SplitText restores the markup it recorded when it split, so a write that
     * happens before the revert puts the previous minute back — silently, and
     * only on a layer that has a reveal. Hence a case for exactly that pairing.
     */
    vi.setSystemTime(new Date('2026-08-03T01:43:02Z'));
    vi.advanceTimersByTime(6000);
    expect(runtime.getLayerElement('time')?.textContent).toContain('6:43');
  });

  it('stops its timer on destroy', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const { runtime } = mount(
      comp([
        createTextLayer({ id: 'time', text: '', clock: { format: 'h:mm:ss A', timezone: PHX } }),
      ]),
    );
    const el = runtime.getLayerElement('time')!;
    runtime.destroy();

    vi.setSystemTime(new Date('2026-08-03T01:59:59Z'));
    // Detached element: if an interval survived, it would still be writing to
    // this node — one leaked timer per editor rebuild.
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    expect(el.querySelector('.bz-text-inner')?.textContent).toBe('6:42:07 PM');
  });

  it('creates no timer for a composition with no clocks', () => {
    vi.useFakeTimers();
    const { runtime } = mount(comp([createTextLayer({ id: 'name', text: 'JANE DOE' })]));
    cleanup.push(() => runtime.destroy());

    expect(vi.getTimerCount()).toBe(0);
  });
});
