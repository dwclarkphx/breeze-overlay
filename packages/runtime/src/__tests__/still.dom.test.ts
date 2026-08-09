// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Still mode — one paused frame rather than playback.
 *
 * Built for composition and scene thumbnails. The claim under test is narrow
 * and worth stating precisely: a still skips the text *animation* scaffolding
 * and nothing else. Same layers, same text, same fit, same pose at a given time.
 *
 * What is deliberately NOT asserted here is anything about layout. happy-dom
 * does no layout, so `refit` has nothing real to measure — these cover which
 * code paths run, and the Playwright suite covers what they produce.
 */

import { describe, expect, it } from 'vitest';
import type { Composition, TextAnimPresetId } from '@breeze/schema';

import { BreezeRuntime } from '../runtime.js';

function composition(preset?: TextAnimPresetId): Composition {
  return {
    formatVersion: 1,
    id: 'strap',
    name: 'Strap',
    duration: 3,
    stage: { width: 1920, height: 1080, fps: 60, background: 'transparent' },
    markers: [{ type: 'stop', time: 1 }],
    layers: [
      {
        id: 'plate',
        type: 'shape',
        shape: 'rect',
        fill: '#1f6feb',
        size: { width: 800, height: 120 },
        keyframes: { x: [{ t: 0, v: -900 }, { t: 1, v: 0 }] },
      },
      {
        id: 'name',
        type: 'text',
        text: 'Jane Doe',
        style: { fontFamily: 'Inter', fontSize: 48, fill: '#ffffff' },
        ...(preset ? { textAnimPreset: { id: preset } } : {}),
      },
    ],
  };
}

function mount(comp: Composition, still: boolean): { rt: BreezeRuntime; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const rt = new BreezeRuntime({ container, composition: comp, autoPlay: false, still });
  return { rt, container };
}

/**
 * The per-piece boxes SplitText leaves behind, which is what a still skips.
 *
 * SplitText replaces the span's text with one `inline-block` div per unit, as a
 * *direct* child of `.bz-text-inner` — verified against the real DOM rather than
 * assumed, because an over-deep selector here would report 0 for both modes and
 * the test would pass without proving anything.
 */
const splitPieces = (rt: BreezeRuntime, layerId: string): number =>
  rt.getLayerElement(layerId)?.querySelectorAll('.bz-text-inner > div').length ?? 0;

describe('still mode', () => {
  it('renders the same layers as a normal runtime', () => {
    // The point worth guarding: this skips animation scaffolding, not content.
    // A still that quietly dropped a layer would be a thumbnail that lies.
    const { rt: normal } = mount(composition(), false);
    const { rt: still } = mount(composition(), true);

    for (const id of ['plate', 'name']) {
      expect(normal.getLayerElement(id), `normal ${id}`).toBeTruthy();
      expect(still.getLayerElement(id), `still ${id}`).toBeTruthy();
    }
  });

  it('keeps the text itself, which is what makes two thumbnails distinguishable', () => {
    // The reason text layers were not excluded outright: the demo project ships
    // `Lower Third — Name` and `Lower Third — Title`, and stripping text would
    // make both render as the same colored bar.
    const { container } = mount(composition(), true);
    expect(container.textContent).toContain('Jane Doe');
  });

  it('does not split text for a reveal preset', () => {
    const { rt: normal } = mount(composition('words-up'), false);
    const { rt: still } = mount(composition('words-up'), true);

    expect(splitPieces(normal, 'name')).toBeGreaterThan(0);
    expect(splitPieces(still, 'name')).toBe(0);
  });

  it('reports which mode it was built in', () => {
    expect(mount(composition(), true).rt.still).toBe(true);
    expect(mount(composition(), false).rt.still).toBe(false);
  });

  it('defaults to off, so nothing on air changes', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const rt = new BreezeRuntime({ container, composition: composition(), autoPlay: false });
    expect(rt.still).toBe(false);
  });

  it('poses identically to a normal runtime at a given time', () => {
    /*
     * The property a thumbnail depends on. A still is only useful if the frame
     * it paints is the frame the graphic will actually show — so seeking both
     * to the first stop marker has to put the plate in the same place.
     */
    const { rt: normal } = mount(composition(), false);
    const { rt: still } = mount(composition(), true);

    normal.seek(1);
    still.seek(1);

    const transformOf = (rt: BreezeRuntime): string =>
      rt.getLayerElement('plate')!.style.transform;

    // Read the inline style, not the computed one: happy-dom does no layout, and
    // an element that never animated and one that finished both compute to the
    // same thing. The inline transform is what GSAP actually wrote.
    expect(transformOf(still)).toBe(transformOf(normal));
    expect(transformOf(still)).not.toBe('');
  });

  it('still accepts data updates without splitting', () => {
    // `update()` shares the refit path with build, and a thumbnail is seeded
    // with data before it is seeked. It must not resurrect the split.
    const comp = composition('words-up');
    comp.layers[1] = { ...comp.layers[1]!, binding: 'name' } as never;

    const { rt: still, container } = mount(comp, true);
    still.update({ name: 'Someone Else' });

    expect(container.textContent).toContain('Someone Else');
    expect(splitPieces(still, 'name')).toBe(0);
  });

  it('builds an order of magnitude fewer nodes for a chars reveal', () => {
    /*
     * The measured reason this mode exists, as a guard rather than a claim.
     *
     * A `chars-up` reveal on six straps builds ~294 elements against a still's
     * 30 — one inline-block per character, each of which is also a GSAP tween
     * target. Node count rather than wall-clock because the ratio is a property
     * of the code and the timing is a property of whatever DOM is running it:
     * measured under happy-dom the same case is 444ms against 2.9ms, but
     * happy-dom is not a browser and that multiplier will not survive Chrome.
     * The node count will.
     */
    const withReveal = (preset?: TextAnimPresetId): Composition => {
      const c = composition(preset);
      c.layers = [
        c.layers[0]!,
        ...Array.from({ length: 6 }, (_, i) => ({
          ...(c.layers[1] as never as Record<string, unknown>),
          id: `t${i}`,
          text: `Competitor Number ${i} With A Fairly Long Name`,
        })),
      ] as never;
      return c;
    };

    const count = (el: HTMLElement): number => el.querySelectorAll('*').length;

    const { container: normal } = mount(withReveal('chars-up'), false);
    const { container: still } = mount(withReveal('chars-up'), true);

    expect(count(still)).toBeLessThan(count(normal) / 5);
  });

  it('builds exactly the same node count when there is no reveal', () => {
    // The other half of the claim: for the majority of graphics, which carry no
    // `textAnimPreset` at all, this mode must cost and change nothing.
    const { container: normal } = mount(composition(), false);
    const { container: still } = mount(composition(), true);

    expect(still.querySelectorAll('*').length).toBe(normal.querySelectorAll('*').length);
  });

  it('leaves a composition with no reveal byte-for-byte the same', () => {
    // Most graphics have no `textAnimPreset` at all, and for those a still must
    // be a pure cost saving with no rendering difference whatsoever.
    const { rt: normal, container: a } = mount(composition(), false);
    const { rt: still, container: b } = mount(composition(), true);

    normal.seek(1);
    still.seek(1);

    // Instance ids differ between runtimes, so compare with them stripped.
    const scrub = (html: string): string => html.replace(/bz-[a-z0-9]+-\d+/g, 'bz-uid');
    expect(scrub(b.innerHTML)).toBe(scrub(a.innerHTML));
  });
});
