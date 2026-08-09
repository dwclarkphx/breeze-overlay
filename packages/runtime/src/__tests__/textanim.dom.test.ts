// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Text reveals against a real DOM implementation.
 *
 * These cover the wiring that the pure preset table cannot: that SplitText is
 * actually driven, that the reveal is parented at the layer's in-point, and that
 * live text survives being re-split while the graphic is on air.
 *
 * What is deliberately NOT asserted here is where lines fall. happy-dom does no
 * layout, so `lines` splitting has nothing to measure — that belongs in the
 * Playwright suite, where the text really wraps.
 */

import { describe, expect, it } from 'vitest';
import type { Composition, TextAnimPresetId } from '@breeze/schema';

import { BreezeRuntime } from '../runtime.js';

const IN_POINT = 0.5;

function composition(preset?: { id: TextAnimPresetId; stagger?: number; duration?: number }): Composition {
  return {
    id: 'strap',
    name: 'Strap',
    duration: 3,
    stage: { width: 1920, height: 1080, fps: 60, background: 'transparent' },
    layers: [
      {
        id: 'name',
        type: 'text',
        name: 'Name',
        text: 'JANE DOE',
        binding: 'name',
        in: IN_POINT,
        size: { width: 700, height: 44 },
        transform: { x: 100, y: 900, anchorX: 0, anchorY: 0 },
        style: { fontFamily: 'sans-serif', fontSize: 40, fill: '#ffffff' },
        ...(preset ? { textAnimPreset: preset } : {}),
      },
    ],
  } as unknown as Composition;
}

function mount(comp: Composition) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const runtime = new BreezeRuntime({ container, composition: comp, autoPlay: false });
  const inner = () => container.querySelector<HTMLElement>('.bz-text-inner')!;
  const chars = () => [...container.querySelectorAll<HTMLElement>('.bz-text-inner div div')];
  return { container, runtime, inner, chars };
}

describe('text reveal wiring', () => {
  it('splits a text layer that carries a preset', () => {
    const { runtime, chars } = mount(composition({ id: 'chars-up' }));
    // "JANE DOE" — eight glyphs, seven of them characters; the space is not a
    // piece to animate.
    expect(chars().length).toBe(7);
    runtime.destroy();
  });

  it('leaves text alone when there is no preset', () => {
    const { runtime, inner } = mount(composition());
    expect(inner().children.length).toBe(0);
    expect(inner().textContent).toBe('JANE DOE');
    runtime.destroy();
  });

  it('does not animate, or throw, on an unknown preset', () => {
    /*
     * The schema rejects unknown ids, but an export or a hand-edited file can
     * still carry one. Text that appears without its reveal is a blemish;
     * throwing here would take the graphic off air.
     */
    const { runtime, inner } = mount(composition({ id: 'chars-sideways' as TextAnimPresetId }));
    expect(inner().textContent).toBe('JANE DOE');
    expect(inner().children.length).toBe(0);
    runtime.destroy();
  });

  it('holds the pieces at their from-state at the in-point', () => {
    const { runtime, chars } = mount(composition({ id: 'chars-up' }));
    runtime.seek(IN_POINT);

    const first = chars()[0]!;
    expect(Number(first.style.opacity)).toBeCloseTo(0, 2);
    // Rising: translated down its own box at the start of the reveal.
    expect(first.style.transform).toContain('60%');
    runtime.destroy();
  });

  it('leaves the pieces untouched before the layer exists', () => {
    /*
     * A from-tween applies its start state the moment it is created unless told
     * otherwise, which would blank text that has not been revealed yet — and,
     * worse, text an operator has just typed while the graphic holds. The reveal
     * is built with immediateRender off, so before the in-point the pieces carry
     * no inline state at all.
     */
    const { runtime, chars } = mount(composition({ id: 'chars-up' }));
    runtime.seek(IN_POINT - 0.1);
    expect(chars()[0]!.style.opacity).toBe('');
    runtime.destroy();
  });

  it('staggers: the last piece has not begun while the first is under way', () => {
    const { runtime, chars } = mount(composition({ id: 'chars-up', stagger: 0.05, duration: 0.3 }));
    // 0.1s in, the last of seven pieces is not due until 0.3s.
    runtime.seek(IN_POINT + 0.1);

    const pieces = chars();
    /*
     * An unstarted piece has NO inline opacity, and a finished one has opacity 1.
     * Reading the empty string as 1 — which an earlier version of this test did —
     * makes those two states identical and the assertion meaningless. They are
     * distinguished here, which is what "staggered" actually means: some pieces
     * are mid-flight and others have not been touched.
     */
    const state = (el: HTMLElement) => (el.style.opacity === '' ? 'untouched' : Number(el.style.opacity));

    expect(state(pieces[0]!)).not.toBe('untouched');
    expect(Number(state(pieces[0]!))).toBeGreaterThan(0);
    expect(state(pieces[pieces.length - 1]!)).toBe('untouched');
    runtime.destroy();
  });

  it('finishes with every piece at its natural state', () => {
    const { runtime, chars } = mount(composition({ id: 'chars-up' }));
    runtime.seek(2.5);
    for (const piece of chars()) {
      expect(Number(piece.style.opacity)).toBeCloseTo(1, 2);
    }
    runtime.destroy();
  });

  it('positions the reveal at the layer in-point, not at zero', () => {
    // A reveal parented at 0 would play while the layer is still hidden and be
    // over before anyone saw it.
    const { runtime, chars } = mount(composition({ id: 'chars-up' }));
    runtime.seek(0);
    expect(chars()[0]!.style.opacity).toBe('');
    runtime.seek(IN_POINT);
    expect(Number(chars()[0]!.style.opacity)).toBeCloseTo(0, 2);
    runtime.destroy();
  });
});

describe('text reveal under live update', () => {
  it('keeps the new text and re-splits it', () => {
    /*
     * The trap this guards: SplitText.revert() restores the markup recorded when
     * it split, so reverting after writing would put the old name back and
     * discard what the operator just typed. The split is reverted first.
     */
    const { runtime, inner, chars } = mount(composition({ id: 'chars-up' }));
    runtime.update({ name: 'ALEX MORGAN' });

    expect(inner().textContent).toBe('ALEX MORGAN');
    expect(chars().length).toBe(10);
    runtime.destroy();
  });

  it('shows the new text immediately when it arrives after the reveal', () => {
    /*
     * The on-air case: a name is corrected while the strap holds. The reveal has
     * already finished, so re-splitting must leave the pieces visible. `from`
     * tweens make that automatic — the natural state IS the revealed state — and
     * refilling the track must not re-apply the hidden start state.
     */
    const { runtime, inner, chars } = mount(composition({ id: 'chars-up' }));
    runtime.seek(2.5);
    runtime.update({ name: 'CORRECTED NAME' });

    expect(inner().textContent).toBe('CORRECTED NAME');
    for (const piece of chars()) {
      // No inline opacity, or a fully opaque one: either way, visible.
      const opacity = piece.style.opacity;
      if (opacity !== '') expect(Number(opacity)).toBeCloseTo(1, 2);
    }
    runtime.destroy();
  });

  it('can still replay the reveal on the new text', () => {
    // The rebuilt track has to be a real reveal, not a spent one.
    const { runtime, chars } = mount(composition({ id: 'chars-up' }));
    runtime.seek(2.5);
    runtime.update({ name: 'REPLAY ME' });

    runtime.seek(IN_POINT);
    expect(Number(chars()[0]!.style.opacity)).toBeCloseTo(0, 2);
    runtime.destroy();
  });

  it('survives repeated updates without accumulating markup', () => {
    // Each update reverts before re-splitting; skipping that would nest a split
    // inside the previous one and multiply the pieces on every keystroke.
    const { runtime, chars } = mount(composition({ id: 'chars-up' }));
    for (const name of ['ONE', 'TWO', 'THREE', 'FOUR']) runtime.update({ name });

    expect(chars().length).toBe(4); // FOUR
    runtime.destroy();
  });

  it('reverts the split on destroy so the DOM is left as plain text', () => {
    // The editor rebuilds a runtime per edit; a split left in place keeps its
    // record of the original markup alive, once per keystroke.
    const { runtime, container } = mount(composition({ id: 'chars-up' }));
    runtime.destroy();
    expect(container.querySelector('.bz-text-inner')).toBeNull();
  });
});
