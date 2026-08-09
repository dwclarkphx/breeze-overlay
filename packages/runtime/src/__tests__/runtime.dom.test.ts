// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Runtime integration tests against a real DOM implementation.
 *
 * These cover the lifecycle state machine and the GSAP wiring without needing
 * a browser download; the Playwright suite in tests/e2e then verifies the same
 * behavior in Chromium, where the compositor and computed styles are real.
 *
 * Time is driven explicitly with `gsap.updateRoot()` rather than wall clock so
 * the assertions are deterministic — the same reason ROADMAP §2 rule 5 asks
 * for a timeline with no wall-clock dependence.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gsap } from 'gsap';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createComposition, createShapeLayer } from '@breeze/schema';
import type { Composition, Project } from '@breeze/schema';

import { BreezeRuntime } from '../runtime.js';
import { installGlobals } from '../globals.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = JSON.parse(
  readFileSync(path.resolve(here, '../../../../examples/lower-third.json'), 'utf8'),
) as Project;
const byId = new Map(project.compositions.map((c) => [c.id, c]));
const lowerThird = byId.get('l3rd-name') as Composition;

let container: HTMLElement;
let runtime: BreezeRuntime;
let rootTime = 0;

/** Advance GSAP's root timeline by `seconds` without touching wall clock. */
function advance(seconds: number): void {
  rootTime += seconds;
  gsap.updateRoot(rootTime);
}

function transformOf(layerId: string): string {
  return runtime.getLayerElement(layerId)!.style.transform;
}

function translateXOf(layerId: string): number {
  const match = /translate(?:3d)?\(([-0-9.]+)px/.exec(transformOf(layerId));
  return match ? Number(match[1]) : 0;
}

beforeEach(() => {
  gsap.ticker.lagSmoothing(0);
  rootTime = gsap.globalTimeline.time();
  container = document.createElement('div');
  document.body.appendChild(container);
  runtime = new BreezeRuntime({ container, composition: lowerThird });
});

afterEach(() => {
  runtime.destroy();
  container.remove();
});

describe('construction', () => {
  it('builds one element per layer in author order', () => {
    // Constructed without a resolver, so the nested badge is one flat layer.
    const ids = [...container.querySelectorAll('[data-layer-id]')].map((el) =>
      el.getAttribute('data-layer-id'),
    );
    expect(ids).toEqual(['bar', 'accent', 'name', 'badge', 'title']);
  });

  it('degrades to an empty placeholder when a nested ref cannot resolve', () => {
    // A missing sub-composition must not take the rest of the graphic down.
    expect(runtime.getLayerElement('badge')).toBeDefined();
    expect(runtime.warnings.map((w) => w.layerId)).toEqual(['badge']);
  });

  it('sizes the root to the stage', () => {
    expect(runtime.element.style.width).toBe('1920px');
    expect(runtime.element.style.height).toBe('1080px');
  });

  it('leaves the stage background transparent for browser sources', () => {
    expect(runtime.element.style.background).toBe('');
  });

  it('reports the authored duration and step count', () => {
    expect(runtime.duration).toBeCloseTo(2.4, 3);
    // One STOP marker means one holdable state.
    expect(runtime.stepCount).toBe(1);
  });

  it('starts idle at frame zero', () => {
    expect(runtime.playbackState).toBe('idle');
    expect(runtime.currentTime).toBe(0);
  });

  it('renders text content into the glyph span', () => {
    const inner = runtime.getLayerElement('name')!.querySelector('.bz-text-inner');
    expect(inner?.textContent).toBe('JANE DOE');
  });

  it('renders a gradient fill as CSS', () => {
    const shape = runtime.getLayerElement('bar')!.querySelector<HTMLElement>('.bz-shape')!;
    expect(shape.style.background).toContain('linear-gradient');
  });
});

describe('seeking', () => {
  it('places the bar off-stage at t=0', () => {
    runtime.seek(0);
    expect(translateXOf('bar')).toBeCloseTo(-960, 0);
  });

  it('places the bar at rest once the intro has finished', () => {
    runtime.seek(0.6);
    expect(translateXOf('bar')).toBeCloseTo(120, 0);
  });

  it('keeps the bar at rest through the hold segment', () => {
    runtime.seek(1.2);
    expect(translateXOf('bar')).toBeCloseTo(120, 0);
  });

  it('returns the bar off-stage at the end of the outro', () => {
    runtime.seek(2.1);
    expect(translateXOf('bar')).toBeCloseTo(-960, 0);
  });

  it('is reversible — seeking back restores the earlier frame exactly', () => {
    runtime.seek(0.6);
    const atRest = translateXOf('bar');
    runtime.seek(2.1);
    runtime.seek(0.6);
    expect(translateXOf('bar')).toBeCloseTo(atRest, 4);
  });

  it('clamps a seek past the end to the last frame', () => {
    runtime.seek(99);
    expect(runtime.currentTime).toBeCloseTo(runtime.duration, 3);
  });
});

describe('lifecycle', () => {
  it('holds at the STOP marker instead of running through', () => {
    runtime.play();
    expect(runtime.playbackState).toBe('playing-in');

    advance(1.6);

    expect(runtime.playbackState).toBe('holding');
    expect(runtime.currentTime).toBeCloseTo(1.5, 2);
    expect(translateXOf('bar')).toBeCloseTo(120, 0);
  });

  it('stays parked at the hold while time keeps passing', () => {
    runtime.play();
    advance(1.6);
    const held = runtime.currentTime;

    advance(2.0);

    expect(runtime.playbackState).toBe('holding');
    expect(runtime.currentTime).toBeCloseTo(held, 4);
  });

  it('runs the outro on stop() and finishes', () => {
    runtime.play();
    advance(1.6);
    runtime.stop();
    expect(runtime.playbackState).toBe('playing-out');

    advance(1.2);

    expect(runtime.playbackState).toBe('finished');
    expect(translateXOf('bar')).toBeCloseTo(-960, 0);
  });

  it('ignores remaining STOP markers once stopping', () => {
    // A second stop marker must not re-hold the graphic on its way off air.
    const twoStops: Composition = {
      ...lowerThird,
      markers: [
        { type: 'stop', time: 0.8 },
        { type: 'stop', time: 1.5 },
      ],
    };
    runtime.destroy();
    runtime = new BreezeRuntime({ container, composition: twoStops });

    runtime.play();
    advance(0.9);
    expect(runtime.playbackState).toBe('holding');

    runtime.stop();
    advance(2.0);
    expect(runtime.playbackState).toBe('finished');
  });

  it('advances one step per next() call', () => {
    const twoStops: Composition = {
      ...lowerThird,
      markers: [
        { type: 'stop', time: 0.8 },
        { type: 'stop', time: 1.5 },
      ],
    };
    runtime.destroy();
    runtime = new BreezeRuntime({ container, composition: twoStops });

    expect(runtime.stepCount).toBe(2);
    // 0 before any hold is reached, then 1-based as each is entered — so the
    // overlay can print `currentStep/stepCount` with no arithmetic.
    expect(runtime.currentStep).toBe(0);

    runtime.play();
    advance(0.9);
    expect(runtime.currentStep).toBe(1);

    runtime.next();
    advance(0.8);
    expect(runtime.playbackState).toBe('holding');
    expect(runtime.currentStep).toBe(2);
  });

  it('reads as step 1 of 1 at the only hold of a simple graphic', () => {
    // Regression: this reported "2/2" in OBS, counting the outro as a step.
    runtime.play();
    advance(1.6);

    expect(runtime.playbackState).toBe('holding');
    expect(runtime.currentStep).toBe(1);
    expect(runtime.stepCount).toBe(1);
  });

  it('falls back to the outro when next() has no marker left', () => {
    runtime.play();
    advance(1.6);
    runtime.next();
    advance(1.2);
    expect(runtime.playbackState).toBe('finished');
  });

  it('resumes after a seek-induced pause when the transport switches to play()', () => {
    /*
     * Regression: the editor's Holds toggle. Preview with holds off calls
     * playThrough(); pausing calls seek(), which parks a paused timeline while
     * deliberately leaving `state` at `playing-in`. Ticking Holds and pressing
     * play then routes to play(), whose double-press guard used to see
     * `playing-in` and return — the transport read as playing and the clock
     * never moved, before or after the hold mark.
     */
    runtime.playThrough();
    advance(0.4);
    runtime.seek(runtime.currentTime);
    const paused = runtime.currentTime;

    runtime.play();
    advance(0.3);

    expect(runtime.currentTime).toBeGreaterThan(paused);
    expect(runtime.playbackState).toBe('playing-in');

    // And it still honours the hold it is now resuming toward.
    advance(1.0);
    expect(runtime.playbackState).toBe('holding');
    expect(runtime.currentTime).toBeCloseTo(1.5, 2);
  });

  it('resumes from a pause taken after the hold mark', () => {
    runtime.playThrough();
    advance(1.8);
    runtime.seek(runtime.currentTime);
    const paused = runtime.currentTime;

    runtime.play();
    advance(0.3);

    expect(runtime.currentTime).toBeGreaterThan(paused);
  });

  it('still ignores a double play() while the intro is actually rolling', () => {
    runtime.play();
    advance(0.4);
    const mid = runtime.currentTime;

    runtime.play();

    // No rewind to zero: the guard must survive the fix above.
    expect(runtime.currentTime).toBeCloseTo(mid, 4);
  });

  it('playThrough ignores STOP markers so a preview runs end to end', () => {
    // The editor's transport: holds are an on-air concern, not an authoring one.
    runtime.playThrough();
    advance(1.6);

    expect(runtime.playbackState).not.toBe('holding');

    advance(1.2);
    expect(runtime.playbackState).toBe('finished');
  });

  it('playThrough resumes from the playhead rather than the top', () => {
    runtime.seek(1.0);
    runtime.playThrough();

    expect(runtime.currentTime).toBeGreaterThanOrEqual(1.0);
  });

  it('playThrough rewinds when the playhead is already at the end', () => {
    runtime.seek(runtime.duration);
    runtime.playThrough();

    expect(runtime.currentTime).toBeLessThan(0.2);
  });

  it('clear() resets to frame zero', () => {
    runtime.play();
    advance(1.6);
    runtime.clear();

    expect(runtime.playbackState).toBe('idle');
    expect(runtime.currentTime).toBe(0);
    expect(translateXOf('bar')).toBeCloseTo(-960, 0);
  });

  it('replays from the top after finishing', () => {
    runtime.play();
    advance(1.6);
    runtime.stop();
    advance(1.2);
    expect(runtime.playbackState).toBe('finished');

    runtime.play();
    expect(runtime.currentTime).toBeLessThan(0.2);
    advance(1.6);
    expect(runtime.playbackState).toBe('holding');
  });

  it('advances to the next hold when PLAY is pressed again', () => {
    // One-button workflow: repeated PLAY steps the graphic forward.
    const twoStops: Composition = {
      ...lowerThird,
      markers: [
        { type: 'stop', time: 0.8 },
        { type: 'stop', time: 1.5 },
      ],
    };
    runtime.destroy();
    runtime = new BreezeRuntime({ container, composition: twoStops });

    runtime.play();
    advance(0.9);
    expect(runtime.currentStep).toBe(1);

    runtime.play();
    advance(0.8);

    expect(runtime.playbackState).toBe('holding');
    expect(runtime.currentStep).toBe(2);
  });

  it('runs the outro when PLAY is pressed with no hold left', () => {
    // The end of the same walk-forward: in → hold → out.
    runtime.play();
    advance(1.6);
    expect(runtime.playbackState).toBe('holding');

    runtime.play();
    advance(1.2);

    expect(runtime.playbackState).toBe('finished');
  });

  it('does not stutter when PLAY is pressed twice during the intro', () => {
    runtime.play();
    advance(0.4);
    const during = runtime.currentTime;

    runtime.play();

    // Left alone — the intro carries on rather than restarting.
    expect(runtime.currentTime).toBeCloseTo(during, 3);
    expect(runtime.playbackState).toBe('playing-in');
  });

  it('brings the graphic back when PLAY interrupts the outro', () => {
    runtime.play();
    advance(1.6);
    runtime.stop();
    advance(0.2);
    expect(runtime.playbackState).toBe('playing-out');

    runtime.play();

    expect(runtime.currentTime).toBeLessThan(0.2);
    advance(1.6);
    expect(runtime.playbackState).toBe('holding');
  });

  it('survives STOP pressed twice', () => {
    /*
     * Reported from the operator panel: STOP, then STOP again, and PLAY was
     * dead until CLEAR. The second STOP flipped `finished` into `playing-out`
     * and resumed a timeline already parked at its end — nothing ran,
     * `onComplete` never fired again, and `play()` would not rewind from
     * `playing-out`.
     */
    runtime.play();
    advance(1.6);
    runtime.stop();
    advance(1.2);
    expect(runtime.playbackState).toBe('finished');

    runtime.stop();
    expect(runtime.playbackState).toBe('finished');

    runtime.play();
    expect(runtime.currentTime).toBeLessThan(0.2);
    advance(1.6);
    expect(runtime.playbackState).toBe('holding');
  });

  it('ignores STOP while already playing out', () => {
    runtime.play();
    advance(1.6);
    runtime.stop();
    advance(0.2);
    expect(runtime.playbackState).toBe('playing-out');

    runtime.stop();
    expect(runtime.playbackState).toBe('playing-out');

    // And it still reaches the end rather than stalling half way off.
    advance(1.2);
    expect(runtime.playbackState).toBe('finished');
  });

  it('takes the graphic back on air when PLAY interrupts the outro', () => {
    runtime.play();
    advance(1.6);
    runtime.stop();
    advance(0.2);
    expect(runtime.playbackState).toBe('playing-out');

    runtime.play();
    // A clean roll-in from the top, not a resume from mid-exit.
    expect(runtime.currentTime).toBeLessThan(0.2);
    advance(1.6);
    expect(runtime.playbackState).toBe('holding');
  });

  it('ignores STOP when nothing has played', () => {
    runtime.stop();
    expect(runtime.playbackState).toBe('idle');
    expect(runtime.currentTime).toBe(0);
  });

  it('does not wedge when NEXT is pressed after finishing', () => {
    // next() falls through to stop() when no markers remain, which used to be
    // the same dead end.
    runtime.play();
    advance(1.6);
    runtime.stop();
    advance(1.2);

    runtime.next();
    expect(runtime.playbackState).toBe('finished');

    runtime.play();
    advance(1.6);
    expect(runtime.playbackState).toBe('holding');
  });

  it('recovers from repeated stop/play cycles', () => {
    for (let i = 0; i < 5; i++) {
      runtime.play();
      advance(1.6);
      expect(runtime.playbackState).toBe('holding');
      runtime.stop();
      runtime.stop();
      advance(1.2);
      expect(runtime.playbackState).toBe('finished');
    }
  });

  it('emits lifecycle events with the current state', () => {
    const seen: string[] = [];
    runtime.on('play', (p) => seen.push(`play:${p.state}`));
    runtime.on('hold', (p) => seen.push(`hold:${p.state}`));
    runtime.on('finished', (p) => seen.push(`finished:${p.state}`));

    runtime.play();
    advance(1.6);
    runtime.stop();
    advance(1.2);

    expect(seen).toEqual(['play:playing-in', 'hold:holding', 'finished:finished']);
  });
});

describe('update()', () => {
  it('replaces bound text without disturbing playback', () => {
    runtime.play();
    advance(1.6);

    runtime.update({ name: 'Alex Rivera', title: 'Field Producer' });

    const nameEl = runtime.getLayerElement('name')!.querySelector('.bz-text-inner');
    const titleEl = runtime.getLayerElement('title')!.querySelector('.bz-text-inner');
    expect(nameEl?.textContent).toBe('Alex Rivera');
    expect(titleEl?.textContent).toBe('Field Producer');
    expect(runtime.playbackState).toBe('holding');
    expect(runtime.currentTime).toBeCloseTo(1.5, 2);
  });

  it('ignores keys that no layer binds', () => {
    expect(() => runtime.update({ nonexistent: 'x' })).not.toThrow();
  });

  it('accepts a JSON string through the global update verb', () => {
    const globals = installGlobals(runtime, {});
    globals.update(JSON.stringify({ name: 'From a host script' }));
    expect(runtime.getLayerElement('name')!.querySelector('.bz-text-inner')?.textContent).toBe(
      'From a host script',
    );
  });

  it('survives an unparseable payload without changing state', () => {
    const globals = installGlobals(runtime, {});
    runtime.play();
    advance(1.6);
    globals.update('{not json');
    expect(runtime.playbackState).toBe('holding');
  });

  it('coerces non-string values rather than printing [object Object]', () => {
    runtime.update({ name: 42 });
    expect(runtime.getLayerElement('name')!.querySelector('.bz-text-inner')?.textContent).toBe('42');
  });
});

describe('nested compositions', () => {
  /** Rebuild with a resolver so the badge sub-composition expands. */
  function withNesting(): BreezeRuntime {
    runtime.destroy();
    runtime = new BreezeRuntime({
      container,
      composition: lowerThird,
      resolveComposition: (id) => byId.get(id),
    });
    return runtime;
  }

  it('builds nested layers inside the composition layer element', () => {
    const rt = withNesting();
    const badge = rt.getLayerElement('badge')!;
    const chip = rt.getLayerElement('badge/chip')!;

    expect(chip).toBeDefined();
    expect(badge.contains(chip)).toBe(true);
  });

  it('reports no warnings once every ref resolves', () => {
    expect(withNesting().warnings).toEqual([]);
  });

  it('applies the enclosing layer overrides to nested text', () => {
    const rt = withNesting();
    const label = rt.getLayerElement('badge/label')!.querySelector('.bz-text-inner');
    expect(label?.textContent).toBe('LIVE');
  });

  it('shields pinned bindings from a parent update()', () => {
    const rt = withNesting();
    rt.update({ badgeText: 'SHOULD NOT APPLY' });

    const label = rt.getLayerElement('badge/label')!.querySelector('.bz-text-inner');
    expect(label?.textContent).toBe('LIVE');
  });

  it('still lets unpinned bindings through to top-level layers', () => {
    const rt = withNesting();
    rt.update({ name: 'Reaches through' });

    const nameEl = rt.getLayerElement('name')!.querySelector('.bz-text-inner');
    expect(nameEl?.textContent).toBe('Reaches through');
  });

  it('runs nested keyframes on the parent playhead, offset by the in-point', () => {
    const rt = withNesting();

    // The chip scales 0 → 1 over 0.35s starting at the badge in-point of 0.3s.
    rt.seek(0.3);
    const atStart = rt.getLayerElement('badge/chip')!.style.transform;
    rt.seek(0.65);
    const atEnd = rt.getLayerElement('badge/chip')!.style.transform;

    expect(atStart).not.toBe(atEnd);
    expect(atEnd).toMatch(/scale/);
  });

  it('hides nested layers before their in-point', () => {
    const rt = withNesting();
    rt.seek(0.1);
    expect(rt.getLayerElement('badge/chip')!.dataset['hidden']).toBe('1');

    rt.seek(0.5);
    expect(rt.getLayerElement('badge/chip')!.dataset['hidden']).toBeUndefined();
  });
});

describe('masks', () => {
  it('emits an SVG mask for a layer that declares one', () => {
    runtime.destroy();
    runtime = new BreezeRuntime({
      container,
      composition: lowerThird,
      resolveComposition: (id) => byId.get(id),
    });

    const chip = runtime.getLayerElement('badge/chip')!;
    const reference = chip.style.getPropertyValue('mask-image');

    expect(reference).toMatch(/^url\(#bz-mask-/);

    const maskId = /url\(#(.+)\)/.exec(reference)![1]!;
    const maskEl = runtime.element.querySelector(`#${maskId}`);
    expect(maskEl).not.toBeNull();
    expect(maskEl!.tagName.toLowerCase()).toBe('mask');
  });

  it('uses a real gaussian blur for feather rather than faking it', () => {
    runtime.destroy();
    runtime = new BreezeRuntime({
      container,
      composition: lowerThird,
      resolveComposition: (id) => byId.get(id),
    });

    const blur = runtime.element.querySelector('feGaussianBlur');
    expect(blur).not.toBeNull();
    // feather 6 → stdDeviation 3
    expect(blur!.getAttribute('stdDeviation')).toBe('3');
  });

  it('paints a white backing rect only when inverted', () => {
    const masked = (invert: boolean): Composition =>
      createComposition({
        id: 'm',
        layers: [
          createShapeLayer({
            id: 'sq',
            size: { width: 100, height: 100 },
            mask: { type: 'rect', x: 10, y: 10, width: 50, height: 50, invert },
          }),
        ],
      });

    runtime.destroy();
    runtime = new BreezeRuntime({ container, composition: masked(false) });
    expect(runtime.element.querySelectorAll('mask rect')).toHaveLength(1);

    runtime.destroy();
    runtime = new BreezeRuntime({ container, composition: masked(true) });
    const rects = runtime.element.querySelectorAll('mask rect');
    expect(rects).toHaveLength(2);
    expect(rects[0]!.getAttribute('fill')).toBe('#ffffff');
    expect(rects[1]!.getAttribute('fill')).toBe('#000000');
  });

  it('drives mask position from the maskOffset keyframe track', () => {
    const comp = createComposition({
      id: 'wipe',
      layers: [
        createShapeLayer({
          id: 'sq',
          size: { width: 200, height: 100 },
          mask: { type: 'rect', x: 0, y: 0, width: 200, height: 100 },
          keyframes: { maskOffset: [{ t: 0, v: -200 }, { t: 1, v: 0 }] },
        }),
      ],
    });

    runtime.destroy();
    runtime = new BreezeRuntime({ container, composition: comp });

    const group = runtime.element.querySelector('mask g')!;
    runtime.seek(0);
    expect(group.getAttribute('transform')).toBe('translate(-200 0)');

    runtime.seek(1);
    expect(group.getAttribute('transform')).toBe('translate(0 0)');
  });

  it('removes its mask definitions on destroy', () => {
    runtime.destroy();
    runtime = new BreezeRuntime({
      container,
      composition: lowerThird,
      resolveComposition: (id) => byId.get(id),
    });
    expect(document.querySelectorAll('mask').length).toBeGreaterThan(0);

    runtime.destroy();
    expect(container.querySelectorAll('mask')).toHaveLength(0);
  });
});

describe('teardown', () => {
  it('removes its DOM and stops responding', () => {
    runtime.play();
    runtime.destroy();
    expect(container.querySelector('.bz-root')).toBeNull();
    expect(() => runtime.play()).not.toThrow();
  });
});
