// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Cue → take (Phase 9 Wave A): a TAKE never shows new values on the old pose.
 * Off air it is update + play; on air it runs the outro, then puts the new
 * values up and plays them in.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gsap } from 'gsap';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Composition, Project } from '@breeze/schema';

import { BreezeRuntime } from '../runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = JSON.parse(
  readFileSync(path.resolve(here, '../../../../examples/breeze-demo.json'), 'utf8'),
) as Project;
const lowerThird = project.compositions.find((c) => c.id === 'l3rd-name-2a94g') as Composition;

let container: HTMLElement;
let runtime: BreezeRuntime;
let rootTime = 0;

function advance(seconds: number): void {
  // Small steps, so GSAP fires callbacks in order on the way.
  for (let left = seconds; left > 0; left -= 0.05) {
    rootTime += Math.min(0.05, left);
    gsap.updateRoot(rootTime);
  }
}

// Upper-cased here: whether the layer's own text-transform is applied to
// textContent is not what is under test.
const nameText = () =>
  runtime.getLayerElement('name')!.querySelector('.bz-text-inner')?.textContent?.toUpperCase();

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

describe('take', () => {
  it('from idle updates and plays straight away', () => {
    runtime.take({ name: 'First Name' });
    expect(runtime.playbackState).toBe('playing-in');
    expect(nameText()).toBe('FIRST NAME');
    advance(2);
    expect(runtime.playbackState).toBe('holding');
  });

  it('on air runs the outro first, and the old name stays up until it has', () => {
    runtime.take({ name: 'First Name' });
    advance(2);
    expect(runtime.playbackState).toBe('holding');

    runtime.take({ name: 'Second Name' });
    expect(runtime.playbackState).toBe('playing-out');
    expect(runtime.takePending).toBe(true);
    // Mid-outro: still the first name — the new value is not on the old pose.
    advance(0.3);
    expect(nameText()).toBe('FIRST NAME');

    advance(1.5);
    expect(runtime.takePending).toBe(false);
    expect(nameText()).toBe('SECOND NAME');
    advance(2);
    expect(runtime.playbackState).toBe('holding');
  });

  it('a second take while one waits replaces the waiting values', () => {
    runtime.take({ name: 'One' });
    advance(2);
    runtime.take({ name: 'Two' });
    runtime.take({ name: 'Three' });
    advance(4);
    expect(nameText()).toBe('THREE');
    expect(runtime.playbackState).toBe('holding');
  });

  it('clear cancels a waiting take', () => {
    runtime.take({ name: 'One' });
    advance(2);
    runtime.take({ name: 'Two' });
    runtime.clear();
    expect(runtime.takePending).toBe(false);
    advance(3);
    expect(runtime.playbackState).toBe('idle');
    expect(nameText()).toBe('ONE');
  });
});
