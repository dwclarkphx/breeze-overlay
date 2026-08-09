// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Video/timeline sync. The mapping from composition time to media time is the
 * part that decides whether a stinger lands on the right frame, so it is tested
 * directly against stub elements rather than through the DOM.
 */

import { describe, expect, it } from 'vitest';
import type { VideoLayer } from '@breeze/schema';

import { VideoSync, type VideoBinding } from '../video.js';

function stubVideo(duration: number): HTMLVideoElement {
  return {
    duration,
    currentTime: 0,
    paused: true,
    ended: false,
    readyState: 1,
    // Real enough for `onEnd`, which shows and hides through inline style.
    style: { visibility: '' },
    play: () => Promise.resolve(),
    pause: () => undefined,
    addEventListener: () => undefined,
  } as unknown as HTMLVideoElement;
}

function binding(layer: Partial<VideoLayer>, duration = 4, offset = 0): VideoBinding {
  return {
    el: stubVideo(duration),
    layer: { id: 'v', type: 'video', src: 'clip.webm', ...layer } as VideoLayer,
    offset,
  };
}

const sync = new VideoSync();

describe('mediaTimeFor', () => {
  it('returns null before the layer start time', () => {
    const b = binding({ startAt: 1 });
    expect(sync.mediaTimeFor(b, 0.5)).toBeNull();
  });

  it('starts at media time 0 exactly on the start time', () => {
    const b = binding({ startAt: 1 });
    expect(sync.mediaTimeFor(b, 1)).toBe(0);
  });

  it('tracks composition time once running', () => {
    const b = binding({ startAt: 1 });
    expect(sync.mediaTimeFor(b, 2.5)).toBeCloseTo(1.5, 6);
  });

  it('defaults startAt to 0', () => {
    expect(sync.mediaTimeFor(binding({}), 2)).toBeCloseTo(2, 6);
  });

  it('holds the last frame past the end when not looping', () => {
    const b = binding({ startAt: 0 }, 4);
    // Holding beats going black: a stinger that outlives its graphic should
    // sit on its final frame, not disappear.
    expect(sync.mediaTimeFor(b, 9)).toBe(4);
  });

  it('wraps around when looping', () => {
    const b = binding({ startAt: 0, loop: true }, 4);
    expect(sync.mediaTimeFor(b, 9)).toBeCloseTo(1, 6);
  });

  it('adds the nested-composition offset to startAt', () => {
    const b = binding({ startAt: 1 }, 4, 2); // nested comp starts at 2s
    expect(sync.mediaTimeFor(b, 2.5)).toBeNull();
    expect(sync.mediaTimeFor(b, 3)).toBe(0);
    expect(sync.mediaTimeFor(b, 4)).toBeCloseTo(1, 6);
  });

  it('falls back to raw elapsed time before metadata gives a duration', () => {
    const b = binding({ startAt: 0 }, Number.NaN);
    expect(sync.mediaTimeFor(b, 3)).toBeCloseTo(3, 6);
  });
});

describe('syncTo', () => {
  it('parks every video on its exact frame and pauses', () => {
    const s = new VideoSync();
    const a = binding({ startAt: 0 }, 10);
    const b = binding({ startAt: 5 }, 10);
    (a.el as { readyState: number }).readyState = 4;
    (b.el as { readyState: number }).readyState = 4;
    s.add(a);
    s.add(b);

    s.syncTo(6);

    expect(a.el.currentTime).toBeCloseTo(6, 6);
    expect(b.el.currentTime).toBeCloseTo(1, 6);
  });

  it('rewinds a video whose start time has not arrived', () => {
    const s = new VideoSync();
    const b = binding({ startAt: 5 }, 10);
    (b.el as { readyState: number }).readyState = 4;
    b.el.currentTime = 3;
    s.add(b);

    s.syncTo(1);

    expect(b.el.currentTime).toBe(0);
  });

  it('never seeks past the media duration', () => {
    const s = new VideoSync();
    const b = binding({ startAt: 0 }, 4);
    (b.el as { readyState: number }).readyState = 4;
    s.add(b);

    s.syncTo(100);

    expect(b.el.currentTime).toBeLessThanOrEqual(4);
  });
});

/*
 * `onEnd` — what a video shows once it has played out.
 *
 * The runtime has always held the last frame, which is right for a background
 * plate and wrong for a stinger: a transition that has finished should leave
 * nothing behind, and holding its final frame parks whatever that frame
 * happened to be over live pictures. `hold` stays the default because it is
 * what every graphic built before this option assumed.
 */
describe('onEnd', () => {
  const played = (b: VideoBinding) => b.el.style.visibility !== 'hidden';

  /*
   * A fresh VideoSync per case, not the module-level one the mediaTimeFor tests
   * share. `syncTo` walks every binding it holds, so accumulating them across
   * cases would mean each test seeking the previous tests' elements — which
   * passes right up until it does not, and then fails somewhere unrelated.
   */
  const mount = (layer: Partial<VideoLayer>, duration = 4) => {
    const s = new VideoSync();
    const b = binding(layer, duration);
    s.add(b);
    return { s, b };
  };

  it('holds the last frame by default, as it always did', () => {
    const { s, b } = mount({});
    s.syncTo(10); // well past the 4s clip
    expect(played(b)).toBe(true);
    expect(s.mediaTimeFor(b, 10)).toBe(4);
  });

  it('hides the layer once a clip set to clear has played out', () => {
    const { s, b } = mount({ onEnd: 'clear' });
    s.syncTo(10);
    expect(played(b)).toBe(false);
  });

  it('leaves it visible while the clip is still running', () => {
    const { s, b } = mount({ onEnd: 'clear' });
    s.syncTo(2);
    expect(played(b)).toBe(true);
  });

  it('measures from startAt, not from zero', () => {
    // A stinger starting at 2s into a 4s clip ends at 6s, not 4s. Getting this
    // wrong would blank it two seconds early, mid-motion.
    const { s, b } = mount({ onEnd: 'clear', startAt: 2 });
    s.syncTo(5);
    expect(played(b)).toBe(true);
    s.syncTo(6.5);
    expect(played(b)).toBe(false);
  });

  it('never clears a looping clip, which has no end', () => {
    const { s, b } = mount({ onEnd: 'clear', loop: true });
    s.syncTo(100);
    expect(played(b)).toBe(true);
  });

  it('comes back when the playhead scrubs backwards', () => {
    // The editor scrubs both ways. A one-way hide would leave a stinger
    // invisible for the rest of the session after one pass through the end.
    const { s, b } = mount({ onEnd: 'clear' });
    s.syncTo(10);
    expect(played(b)).toBe(false);
    s.syncTo(1);
    expect(played(b)).toBe(true);
  });

  it('clears on the running clock too, not only on a seek', () => {
    const { s, b } = mount({ onEnd: 'clear' });
    s.tick(10);
    expect(played(b)).toBe(false);
  });

  it('stays visible when the duration is unknown', () => {
    // Metadata has not arrived yet. Hiding on an unknown duration would blank
    // every clip for the first frames after a browser source reconnects.
    const { s, b } = mount({ onEnd: 'clear' }, NaN);
    s.syncTo(10);
    expect(played(b)).toBe(true);
  });
});
