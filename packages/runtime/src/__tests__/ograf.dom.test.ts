// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * OGraf actions against a real runtime (Phase 9 Wave D): `goToStep`, and the
 * `OgrafAdapter` a pointer package's page answers with — the step rule, when
 * each promise settles, and the custom actions.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gsap } from 'gsap';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Composition, Project } from '@breeze/schema';

import { OgrafAdapter } from '../ograf.js';
import { BreezeRuntime } from '../runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = JSON.parse(
  readFileSync(path.resolve(here, '../../../../examples/breeze-demo.json'), 'utf8'),
) as Project;
const lowerThird = project.compositions.find((c) => c.id === 'l3rd-name-2a94g') as Composition;
const badge = project.compositions.find((c) => c.id === 'badge-3j8xr') as Composition;

/** The demo strap with a second hold before its first: two steps, 0.8 s and 1.5 s. */
const twoStep: Composition = {
  ...lowerThird,
  markers: [
    { type: 'stop', time: 0.8 },
    { type: 'stop', time: 1.5 },
  ],
};

let container: HTMLElement;
let runtime: BreezeRuntime;
let rootTime = 0;

function advance(seconds: number): void {
  for (let left = seconds; left > 0; left -= 0.05) {
    rootTime += Math.min(0.05, left);
    gsap.updateRoot(rootTime);
  }
}

function build(comp: Composition): void {
  runtime?.destroy();
  runtime = new BreezeRuntime({ container, composition: comp });
}

const nameText = () =>
  runtime.getLayerElement('name')!.querySelector('.bz-text-inner')?.textContent?.toUpperCase();

beforeEach(() => {
  gsap.ticker.lagSmoothing(0);
  rootTime = gsap.globalTimeline.time();
  container = document.createElement('div');
  document.body.appendChild(container);
  build(twoStep);
});

afterEach(() => {
  runtime.destroy();
  container.remove();
});

describe('goToStep', () => {
  it('plays through an earlier hold to the one asked for', () => {
    expect(runtime.goToStep(2)).toBe(true);
    advance(1.0);
    // Past the first hold and still rolling: it did not stop there.
    expect(runtime.playbackState).toBe('playing-in');
    advance(0.6);
    expect(runtime.playbackState).toBe('holding');
    expect(runtime.currentStep).toBe(2);
    expect(runtime.currentTime).toBeCloseTo(1.5, 3);
  });

  it('cuts when told to, and when the hold is behind it', () => {
    expect(runtime.goToStep(2, { cut: true })).toBe(true);
    expect(runtime.playbackState).toBe('holding');
    expect(runtime.currentStep).toBe(2);
    // Backwards is a cut, never a reverse run.
    expect(runtime.goToStep(1)).toBe(true);
    expect(runtime.playbackState).toBe('holding');
    expect(runtime.currentTime).toBeCloseTo(0.8, 3);
  });

  it('does nothing at the hold it is on, and refuses a hold that does not exist', () => {
    runtime.goToStep(1, { cut: true });
    const events: string[] = [];
    runtime.on('play', () => events.push('play'));
    expect(runtime.goToStep(1)).toBe(true);
    expect(events).toEqual([]);
    for (const bad of [0, 3, 1.5, -1]) expect(runtime.goToStep(bad)).toBe(false);
  });

  it('never turns a table page — a step is a hold', () => {
    // The demo standings: six rows at five a page, with a second hold added.
    const standings = project.compositions.find((c) => c.id === 'standings-72q2s') as Composition;
    build({ ...standings, markers: [{ type: 'stop', time: 1.4 }, { type: 'stop', time: 2 }] });
    runtime.goToStep(1, { cut: true });
    const page = () => Object.values(runtime.tablePages)[0]!.page;
    const before = page();
    // NEXT here would turn the page; goToStep goes to the hold it names.
    runtime.goToStep(2);
    advance(1);
    expect(runtime.currentStep).toBe(2);
    expect(page()).toBe(before);
    // And NEXT, for contrast, does turn it — the test is not passing by accident.
    runtime.goToStep(1, { cut: true });
    runtime.next();
    expect(page()).not.toBe(before);
  });
});

describe('OgrafAdapter', () => {
  it('counts STOP markers as steps and reads the start state as no step', () => {
    const ograf = new OgrafAdapter(runtime);
    expect(ograf.stepCount).toBe(2);
    expect(ograf.currentStep).toBeUndefined();
  });

  it('resolves playAction at the hold, with the step it reached', async () => {
    const ograf = new OgrafAdapter(runtime);
    const first = ograf.playAction({});
    advance(1);
    await expect(first).resolves.toEqual({ statusCode: 200, currentStep: 0 });
    const second = ograf.playAction({ delta: 1 });
    advance(1);
    await expect(second).resolves.toEqual({ statusCode: 200, currentStep: 1 });
    expect(runtime.currentTime).toBeCloseTo(1.5, 3);
  });

  it('goes to the end past the last step, and resolves when the outro is done', async () => {
    const ograf = new OgrafAdapter(runtime);
    await ograf.playAction({ goto: 1, skipAnimation: true });
    const out = ograf.playAction({});
    advance(1.5);
    await expect(out).resolves.toEqual({ statusCode: 200 });
    expect(runtime.playbackState).toBe('finished');
    expect(ograf.currentStep).toBeUndefined();
  });

  it('skips animation on request', async () => {
    const ograf = new OgrafAdapter(runtime);
    await expect(ograf.playAction({ goto: 1, skipAnimation: true })).resolves.toEqual({ statusCode: 200, currentStep: 1 });
    await expect(ograf.stopAction({ skipAnimation: true })).resolves.toEqual({ statusCode: 200 });
    expect(runtime.playbackState).toBe('idle');
  });

  it('updates fields, and refuses data that is not an object', async () => {
    build(lowerThird);
    const ograf = new OgrafAdapter(runtime);
    await expect(ograf.updateAction({ data: { name: 'Jane Doe' } })).resolves.toEqual({ statusCode: 200 });
    expect(nameText()).toBe('JANE DOE');
    await expect(ograf.updateAction({ data: 'Jane' })).resolves.toMatchObject({ statusCode: 400 });
  });

  it('plays a graphic with no STOP marker straight through, resolving at once', async () => {
    build(badge);
    const ograf = new OgrafAdapter(runtime);
    expect(ograf.stepCount).toBe(0);
    await expect(ograf.playAction({})).resolves.toEqual({ statusCode: 200 });
    expect(runtime.playbackState).toBe('playing-in');
    advance(1);
    expect(runtime.playbackState).toBe('finished');
  });

  it('keeps its own operator timers', async () => {
    const ograf = new OgrafAdapter(runtime);
    const started = await ograf.customAction({ id: 'timer', payload: { action: 'set', value: 90_000 } });
    expect(started).toMatchObject({ statusCode: 200, result: { running: false } });
    await expect(ograf.customAction({ id: 'timer', payload: { action: 'set' } })).resolves.toMatchObject({ statusCode: 400 });
    await expect(ograf.customAction({ id: 'timer', payload: { action: 'explode' } })).resolves.toMatchObject({ statusCode: 400 });
  });

  it('says so when a custom action does not exist', async () => {
    const ograf = new OgrafAdapter(runtime);
    await expect(ograf.customAction({ id: 'shake-it', payload: {} })).resolves.toMatchObject({ statusCode: 404 });
    await expect(ograf.customAction({ id: 'page', payload: {} })).resolves.toMatchObject({ statusCode: 400 });
    await expect(ograf.customAction({ id: 'cycle', payload: { state: 'sideways' } })).resolves.toMatchObject({ statusCode: 400 });
  });
});
