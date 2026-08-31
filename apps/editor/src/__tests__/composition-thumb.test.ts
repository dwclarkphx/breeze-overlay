// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Mounting a composition as a thumbnail still.
 *
 * The assertions here are mostly about *how* it is mounted rather than what it
 * looks like, because the two failures this code exists to avoid are both
 * silent. A hidden container measures zero and breaks Fit Width without an
 * error; a second scale double-applies and produces a thumbnail that is merely
 * the wrong size, which reads as a styling opinion rather than a bug.
 */

import { describe, expect, it, vi } from 'vitest';

import { FORMAT_VERSION, type Composition, type Layer } from '@breeze/schema';

import { isScene } from '@breeze/schema';

import {
  PREVIEW_GAP,
  mountCompositionThumb,
  placePreview,
  previewBox,
} from '../state/composition-thumb.js';

function comp(over: Partial<Composition> = {}): Composition {
  return {
    formatVersion: FORMAT_VERSION,
    id: 'c',
    name: 'C',
    stage: { width: 1920, height: 1080, fps: 30, background: 'transparent' },
    duration: 4,
    markers: [{ type: 'stop', time: 1.5 }],
    layers: [
      {
        id: 'box',
        type: 'shape',
        shape: 'rect',
        fill: '#ff0000',
        size: { width: 400, height: 200 },
        transform: { x: 100, y: 100 },
      } as unknown as Layer,
    ],
    ...over,
  } as Composition;
}

const nested = (ref: string, independent = false): Layer =>
  ({ id: `n-${ref}`, type: 'composition', name: ref, ref, ...(independent ? { independent: true } : {}) }) as Layer;

describe('scene detection', () => {
  /*
   * `isScene` is the schema's, not this module's. An earlier draft here grew
   * its own `hasIndependentChildren` doing exactly the same walk — the same
   * duplication that bit the asset reader and rewriter, caught earlier this
   * time. Kept as tests because the thumbnail's behaviour depends on the
   * answer, even though the function is not ours.
   */
  it('is false for an ordinary composition', () => {
    expect(isScene(comp())).toBe(false);
  });

  it('is false for a flattened nested composition', () => {
    // A reusable badge inside a lower third is *not* a scene: it animates as
    // part of the strap and a single runtime renders it correctly.
    expect(isScene(comp({ layers: [nested('badge')] }))).toBe(false);
  });

  it('is true for an independent child', () => {
    expect(isScene(comp({ layers: [nested('bug', true)] }))).toBe(true);
  });

  it('finds an independent child nested inside a group', () => {
    // The case a shallow check misses. `walkLayers` handles it, which is most
    // of why the schema's version is the one worth using.
    const group = { id: 'g', type: 'group', children: [nested('bug', true)] } as unknown as Layer;
    expect(isScene(comp({ layers: [group] }))).toBe(true);
  });
});

describe('mounting a scene', () => {
  const bug = comp({
    id: 'bug',
    name: 'Bug',
    markers: [{ type: 'stop', time: 0.5 }],
    layers: [
      {
        id: 'dot',
        type: 'shape',
        shape: 'ellipse',
        fill: '#00ff00',
        size: { width: 80, height: 80 },
        transform: { x: 1700, y: 80 },
      } as unknown as Layer,
    ],
  });

  const scene = comp({
    id: 'scene',
    name: 'Scene',
    layers: [nested('bug', true)],
  });

  const resolve = (id: string) => (id === 'bug' ? bug : undefined);

  it('builds a runtime for the scene and one per element', () => {
    /*
     * The whole point of the scene case. `expand.ts` skips independent
     * children, so a single runtime renders the shared plate and none of the
     * elements — the thumbnail would be wrong rather than missing.
     */
    const mount = mountCompositionThumb({ composition: scene, size: 40, resolveComposition: resolve });
    const host = mount.element.firstElementChild as HTMLElement;
    // One container per runtime: the scene's own layers, plus the bug.
    expect(host.children.length).toBe(2);
    mount.destroy();
  });

  it('draws the element, not just the scene', () => {
    const mount = mountCompositionThumb({ composition: scene, size: 40, resolveComposition: resolve });
    const host = mount.element.firstElementChild as HTMLElement;
    const element = host.children[1] as HTMLElement;
    expect(element.querySelectorAll('.bz-layer').length).toBeGreaterThan(0);
    mount.destroy();
  });

  it('skips an element whose ref resolves to nothing', () => {
    // A dangling ref is an authoring state the panel has to survive, not an
    // error worth losing the rest of the thumbnail over.
    const dangling = comp({ layers: [nested('missing', true)] });
    const mount = mountCompositionThumb({ composition: dangling, size: 40, resolveComposition: () => undefined });
    const host = mount.element.firstElementChild as HTMLElement;
    expect(host.children.length).toBe(1);
    mount.destroy();
  });

  it('destroys every runtime it built', () => {
    // One `destroy` per mount, not per runtime: a scene leaking its elements'
    // masks and timelines would leak several per panel render.
    const parent = document.createElement('div');
    const mount = mountCompositionThumb({ composition: scene, size: 40, resolveComposition: resolve });
    parent.appendChild(mount.element);
    mount.destroy();
    expect(parent.children.length).toBe(0);
  });
});

describe('mountCompositionThumb', () => {
  it('returns a wrapper sized to the thumbnail, not to the stage', () => {
    const mount = mountCompositionThumb({ composition: comp(), size: 40 });
    expect(mount.element.style.width).toBe('40px');
    expect(mount.element.style.height).toBe('40px');
    mount.destroy();
  });

  it('never hides the host with display:none', () => {
    /*
     * The trap. A `display: none` box reports `offsetWidth 0`, and the runtime
     * measures elements — Fit Width then scales text to zero and the strap
     * renders as nothing, with no error anywhere.
     */
    const mount = mountCompositionThumb({ composition: comp(), size: 40 });
    const host = mount.element.firstElementChild as HTMLElement;
    expect(host.style.display).not.toBe('none');
    expect(host.style.visibility).not.toBe('hidden');
    mount.destroy();
  });

  it('gives the host the stage size so the runtime has something to measure', () => {
    const mount = mountCompositionThumb({ composition: comp(), size: 40 });
    const host = mount.element.firstElementChild as HTMLElement;
    expect(host.style.width).toBe('1920px');
    expect(host.style.height).toBe('1080px');
    mount.destroy();
  });

  it('applies exactly one scale, and the runtime applies none', () => {
    /*
     * SCENES.md §3 records the inverse mistake: `scaleMode: 'contain'` makes the
     * runtime measure its own container and scale itself, so a wrapper that also
     * scales double-applies.
     *
     * **This test needs the DOM to have layout, and happy-dom does not.**
     * `fitToContainer` opens with `if (!cw || !ch) return 1`, and every
     * `clientWidth` in happy-dom is 0 — so the runtime silently writes no
     * transform whatever `scaleMode` says, and the obvious version of this test
     * passes identically against the bug it is named for. Two earlier drafts
     * did exactly that.
     *
     * Faking the measurement is what makes the assertion mean something. It is
     * a real limitation of the environment rather than of the code, so it is
     * worked around here rather than asserted around.
     */
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
    const width = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
    const height = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 960 });
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 540 });

    try {
      const mount = mountCompositionThumb({ composition: comp(), size: 40 });
      const host = mount.element.firstElementChild as HTMLElement;

      expect((host.style.transform.match(/scale\(/g) ?? []).length).toBe(1);
      expect((mount.element.style.transform.match(/scale\(/g) ?? []).length).toBe(0);

      // The load-bearing one: `fitToContainer` writes onto the runtime's own
      // `.bz-root`, inside the host, so checking the host alone cannot see it.
      const root = host.querySelector<HTMLElement>('.bz-root');
      expect(root, 'the runtime should have built a root').not.toBeNull();
      expect(root!.style.transform).not.toContain('scale(');
      mount.destroy();
    } finally {
      if (width) Object.defineProperty(proto, 'clientWidth', width);
      if (height) Object.defineProperty(proto, 'clientHeight', height);
    }
  });

  it('scales by the binding axis', () => {
    // 40 / 1920 is smaller than 40 / 1080, so width decides.
    const mount = mountCompositionThumb({ composition: comp(), size: 40 });
    const host = mount.element.firstElementChild as HTMLElement;
    const scale = Number(/scale\(([-0-9.]+)\)/.exec(host.style.transform)?.[1]);
    expect(scale).toBeCloseTo(40 / 1920, 6);
    mount.destroy();
  });

  it('builds the composition into the host', () => {
    const mount = mountCompositionThumb({ composition: comp(), size: 40 });
    const host = mount.element.firstElementChild as HTMLElement;
    expect(host.querySelectorAll('.bz-layer').length).toBeGreaterThan(0);
    mount.destroy();
  });

  it('survives a stage with no size rather than dividing by zero', () => {
    const zero = comp({ stage: { width: 0, height: 0, fps: 30, background: 'transparent' } as never });
    const mount = mountCompositionThumb({ composition: zero, size: 40 });
    const host = mount.element.firstElementChild as HTMLElement;
    expect(host.style.transform).toContain('scale(1)');
    mount.destroy();
  });

  it('detaches on destroy', () => {
    // Ownership matters: the runtime holds masks, a GSAP timeline and any
    // poster capture still in flight, and a panel that re-renders per keystroke
    // would leak one set per render.
    const parent = document.createElement('div');
    const mount = mountCompositionThumb({ composition: comp(), size: 40 });
    parent.appendChild(mount.element);
    expect(parent.children.length).toBe(1);

    mount.destroy();
    expect(parent.children.length).toBe(0);
  });
});

/**
 * The two costs a thumbnail used to carry, asserted where a caller can see them.
 *
 * Both have runtime-level tests; this is the level that matters to the thing
 * that made them worth paying off. A composition picker showing twenty graphics
 * mounts twenty of these, and until 0.69.0 that was twenty one-second intervals
 * and twenty `<video preload="auto">` elements that would never play a frame.
 */
describe('what a thumbnail no longer allocates', () => {
  const withClockAndVideo = (): Composition =>
    comp({
      layers: [
        {
          id: 'time',
          type: 'text',
          text: 'PLACEHOLDER',
          style: { fontFamily: 'Inter', fontSize: 48, fill: '#ffffff' },
          clock: { format: 'h:mm:ss A', timezone: 'America/Phoenix' },
        },
        { id: 'sting', type: 'video', src: 'assets/sting.webm', size: { width: 1920, height: 1080 } },
      ] as unknown as Layer[],
    });

  it('mounts a clock and a video without a timer or a media element', () => {
    vi.useFakeTimers();
    try {
      const mount = mountCompositionThumb({ composition: withClockAndVideo(), size: 40 });

      expect(vi.getTimerCount()).toBe(0);
      expect(mount.element.querySelectorAll('video').length).toBe(0);
      // In their place: a poster `<img>`, and a clock showing the real time.
      expect(mount.element.querySelectorAll('img.bz-video').length).toBe(1);
      expect(mount.element.textContent).not.toContain('PLACEHOLDER');

      mount.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------ preview geometry */

describe('previewBox', () => {
  it('is aspect-correct, not square', () => {
    // The row thumbnail is square because it sits in a column of square
    // things. A preview is a picture; letterboxing 16:9 into a square would
    // waste a third of it.
    expect(previewBox({ width: 1920, height: 1080 }, 320)).toEqual({ width: 320, height: 180 });
  });

  it('caps the longest side whichever it is', () => {
    expect(previewBox({ width: 1080, height: 1920 }, 320)).toEqual({ width: 180, height: 320 });
  });

  it('falls back to a square for a stage with no size', () => {
    expect(previewBox({ width: 0, height: 0 }, 320)).toEqual({ width: 320, height: 320 });
  });
});

describe('placePreview', () => {
  const viewport = { width: 1000, height: 800 };
  const anchor = { x: 100, y: 400, width: 32, height: 32 };
  const box = { width: 320, height: 180 };

  it('sits to the right of the anchor by default', () => {
    const at = placePreview(anchor, box, viewport);
    expect(at.x).toBe(anchor.x + anchor.width + PREVIEW_GAP);
  });

  it('centres on the anchor vertically', () => {
    const at = placePreview(anchor, box, viewport);
    expect(at.y).toBe(anchor.y + anchor.height / 2 - box.height / 2);
  });

  it('flips to the left rather than sliding over the row', () => {
    /*
     * The reason flip comes before clamp. Clamping a preview that does not fit
     * on the right slides it left until it covers the very row being pointed
     * at — hiding the thing the preview exists to identify.
     */
    const nearRight = { x: 900, y: 400, width: 32, height: 32 };
    const at = placePreview(nearRight, box, viewport);
    expect(at.x).toBe(nearRight.x - PREVIEW_GAP - box.width);
    expect(at.x + box.width).toBeLessThanOrEqual(nearRight.x);
  });

  it('clamps to the top edge rather than going off screen', () => {
    const high = { x: 100, y: 4, width: 32, height: 32 };
    expect(placePreview(high, box, viewport).y).toBe(0);
  });

  it('clamps to the bottom edge', () => {
    const low = { x: 100, y: 790, width: 32, height: 32 };
    expect(placePreview(low, box, viewport).y).toBe(viewport.height - box.height);
  });

  it('pins to the left edge when it fits on neither side', () => {
    // A preview wider than the viewport fits nowhere; the least bad answer is
    // to show as much of it as possible rather than to place it off screen.
    const tiny = { width: 200, height: 400 };
    const at = placePreview({ x: 100, y: 100, width: 32, height: 32 }, { width: 300, height: 100 }, tiny);
    expect(at.x).toBeGreaterThanOrEqual(0);
    expect(at.x).toBeLessThanOrEqual(tiny.width);
  });
});

describe('mount.preview', () => {
  it('clones rather than building a second runtime', () => {
    /*
     * The property the whole feature rests on: a still never animates, so a
     * clone is a faithful copy at zero build cost. If this ever became a real
     * mount, a panel of twenty comps would build forty runtimes on hover.
     */
    const mount = mountCompositionThumb({ composition: comp(), size: 40 });
    const big = mount.preview(320);

    expect(big.querySelectorAll('.bz-layer').length).toBeGreaterThan(0);
    // Detached until the caller places it.
    expect(big.parentElement).toBeNull();
    mount.destroy();
  });

  it('scales the copy up, leaving the thumbnail alone', () => {
    const mount = mountCompositionThumb({ composition: comp(), size: 40 });
    const small = (mount.element.firstElementChild as HTMLElement).style.transform;
    const big = mount.preview(320);
    const copy = big.firstElementChild as HTMLElement;

    const scaleOf = (t: string): number => Number(/scale\(([-0-9.]+)\)/.exec(t)?.[1]);
    expect(scaleOf(copy.style.transform)).toBeGreaterThan(scaleOf(small));
    // The original is untouched — the preview must not resize the row.
    expect((mount.element.firstElementChild as HTMLElement).style.transform).toBe(small);
    mount.destroy();
  });
});

describe('the thumbnail is not blank', () => {
  /*
   * The `badge` bug, as a guard.
   *
   * `badge` has no stop marker and animates in from `scaleX: 0` /
   * `opacity: 0`, so posing it at t=0 built a perfectly working thumbnail of an
   * empty box — indistinguishable, from the panel, from one that failed to
   * build. Everything up to this point passed while that was true: the mount
   * was correct, the scale was correct, the runtime built. Only the *frame* was
   * wrong.
   */
  const introOnly = comp({
    duration: undefined,
    markers: [],
    layers: [
      {
        id: 'label',
        type: 'text',
        text: 'LIVE',
        style: { fontFamily: 'Inter', fontSize: 20 },
        size: { width: 200, height: 60 },
        keyframes: { opacity: [{ t: 0, v: 0 }, { t: 0.4, v: 1 }] },
      } as unknown as Layer,
    ],
  });

  it('poses an intro-only graphic where it is visible', () => {
    const mount = mountCompositionThumb({ composition: introOnly, size: 40 });
    const layer = mount.element.querySelector<HTMLElement>('[data-layer-id="label"]');

    expect(layer, 'the layer should have been built').not.toBeNull();
    // The assertion that would have caught it: at t=0 this reads "0".
    expect(Number(layer!.style.opacity || '1')).toBeGreaterThan(0);
    mount.destroy();
  });
});
