// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Which frame a thumbnail poses at.
 *
 * The whole of Phase 7.6 rests on this being something other than 0: t=0 is the
 * one moment a graphic is guaranteed to look like nothing, so a thumbnail taken
 * there renders every lower third in a project as the same empty box.
 */

import { describe, expect, it } from 'vitest';

import { FORMAT_VERSION, type Composition, type Marker } from '../types.js';
import { posterTimeOf } from '../duration.js';

function comp(over: Partial<Composition> = {}): Composition {
  return {
    formatVersion: FORMAT_VERSION,
    id: 'c',
    name: 'C',
    stage: { width: 1920, height: 1080, fps: 30, background: 'transparent' },
    duration: 4,
    layers: [],
    ...over,
  } as Composition;
}

const stop = (time: number): Marker => ({ type: 'stop', time });
const cue = (time: number): Marker => ({ type: 'cue', time });

describe('posterTimeOf', () => {
  it('prefers an explicit posterTime', () => {
    expect(posterTimeOf(comp({ posterTime: 2.5, markers: [stop(1)] }))).toBe(2.5);
  });

  it('falls back to the first stop marker', () => {
    // The rest frame, inferred: a stop is where the author said playback waits
    // for an operator, which is where the graphic spends its on-air life.
    expect(posterTimeOf(comp({ markers: [stop(1.5)] }))).toBe(1.5);
  });

  it('takes the earliest stop when there are several', () => {
    // Order in the array is authoring order, not time order.
    expect(posterTimeOf(comp({ markers: [stop(3), stop(1.2), stop(2)] }))).toBe(1.2);
  });

  it('ignores cue markers, which have no playback effect', () => {
    expect(posterTimeOf(comp({ markers: [cue(0.5), stop(2)] }))).toBe(2);
  });

  it('falls back to the end when nothing stops', () => {
    /*
     * **This asserted 0 first, and 0 was wrong.** The demo's `badge` has no
     * stop marker, a chip keyframed `scaleX 0 → 1` and a label
     * `opacity 0 → 1` — so posing at t=0 rendered a perfectly working
     * thumbnail of an empty box, which looks exactly like one that failed to
     * build.
     *
     * No stop marker usually means nothing holds: the graphic animates in and
     * stays, so the end is its settled pose.
     */
    expect(posterTimeOf(comp({ markers: [cue(1)] }))).toBe(4);
    expect(posterTimeOf(comp())).toBe(4);
  });

  it('poses an intro-only graphic where it has finished arriving', () => {
    // The `badge` shape, reduced: nothing holds, everything animates in.
    const badge = comp({
      duration: undefined,
      markers: [],
      layers: [
        {
          id: 'chip',
          type: 'shape',
          shape: 'rect',
          fill: '#fff',
          keyframes: { scaleX: [{ t: 0, v: 0 }, { t: 0.35, v: 1 }] },
        } as never,
        {
          id: 'label',
          type: 'text',
          text: 'LIVE',
          style: { fontFamily: 'Inter', fontSize: 20 },
          keyframes: { opacity: [{ t: 0, v: 0 }, { t: 0.4, v: 1 }] },
        } as never,
      ],
    });
    // 0.4 is where both have arrived; 0 is where neither has.
    expect(posterTimeOf(badge)).toBeCloseTo(0.4, 6);
  });

  it('clamps a posterTime that outlived its keyframes', () => {
    /*
     * `duration` is optional and derived when absent, so a poster authored
     * against a longer edit can survive the edit that shortened it. Seeking
     * past the end parks the timeline on its final frame — the outro, which is
     * the one pose a thumbnail must not show.
     */
    expect(posterTimeOf(comp({ duration: 4, posterTime: 99 }))).toBe(4);
  });

  it('clamps a negative posterTime', () => {
    expect(posterTimeOf(comp({ posterTime: -3 }))).toBe(0);
  });

  it('ignores a non-finite posterTime rather than seeking to NaN', () => {
    // A NaN reaching `seek` renders nothing at all, silently.
    expect(posterTimeOf(comp({ posterTime: Number.NaN, markers: [stop(1)] }))).toBe(1);
  });

  it('clamps a stop marker past the end', () => {
    // `compositionDuration` deliberately does not let markers extend the
    // duration — a stop past the last keyframe is an authoring mistake the
    // validator reports — so the poster must not seek there either.
    expect(posterTimeOf(comp({ duration: 2, markers: [stop(10)] }))).toBe(2);
  });

  it('derives the duration when it is not stated', () => {
    // No explicit duration: the clamp has to fall back to the keyframe walk,
    // or every poster time on a derived-duration composition clamps to 0.
    const derived = comp({
      duration: undefined,
      posterTime: 1.5,
      layers: [
        {
          id: 'a',
          type: 'shape',
          shape: 'rect',
          fill: '#fff',
          keyframes: { opacity: [{ t: 0, v: 0 }, { t: 3, v: 1 }] },
        } as never,
      ],
    });
    expect(posterTimeOf(derived)).toBe(1.5);
  });
});
