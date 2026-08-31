// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Poster frames — the still-mode replacement for a live `<video>`.
 *
 * Driven against a fake document rather than happy-dom, deliberately. happy-dom
 * has no decoder and no 2D context, so every capture there resolves `null` down
 * the same failure path — the tests would pass without ever exercising the seek
 * or the draw, which are the two things worth guarding. A fake lets the events
 * be dispatched in order and the chosen frame time be read back.
 */

import { describe, expect, it, vi } from 'vitest';
import type { VideoLayer } from '@breeze/schema';

import {
  capturePoster,
  posterFrameTime,
  PosterSync,
  type CapturePosterOptions,
  type PosterCapture,
} from '../poster.js';

/** Lets every pending microtask and `.then` settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/* ------------------------------------------------------------ frame time */

describe('posterFrameTime', () => {
  it('nudges off zero rather than taking the first frame', () => {
    // Several encoders put a black frame first, and a thumbnail of black cannot
    // be told from one that failed to load.
    expect(posterFrameTime(0, 30)).toBeCloseTo(0.1, 6);
  });

  it('nudges when the layer has not started yet', () => {
    // `mediaTimeAt` returns null before `startAt`; the live path parks on frame
    // 0, and this is the one place the two deliberately differ.
    expect(posterFrameTime(null, 30)).toBeCloseTo(0.1, 6);
  });

  it('keeps the nudge proportional on a very short clip', () => {
    // 0.1s into a half-second sting is a fifth of the way through it.
    expect(posterFrameTime(0, 0.5)).toBeCloseTo(0.05, 6);
  });

  it('passes a real requested time straight through', () => {
    expect(posterFrameTime(2.5, 30)).toBeCloseTo(2.5, 6);
  });

  it('clamps past the end rather than seeking nowhere', () => {
    expect(posterFrameTime(90, 30)).toBeCloseTo(30, 6);
  });

  it('takes the requested time when the duration is not known yet', () => {
    expect(posterFrameTime(2.5, NaN)).toBeCloseTo(2.5, 6);
    expect(posterFrameTime(0, NaN)).toBeCloseTo(0.1, 6);
  });
});

/* -------------------------------------------------------------- capturing */

interface FakeVideo {
  src: string;
  currentTime: number;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  crossOrigin: string | null;
  muted: boolean;
  preload: string;
  released: number;
  fire: (type: string) => void;
}

/**
 * A document that hands out inspectable stand-ins for `<video>` and `<canvas>`.
 *
 * `drawn` records what `drawImage` was asked to paint, so a test can assert the
 * capture reached the draw rather than bailing out of one of the null paths.
 */
function fakeDoc(opts: { width?: number; height?: number; context?: boolean } = {}) {
  const videos: FakeVideo[] = [];
  const drawn: Array<{ w: number; h: number }> = [];

  const doc = {
    createElement(tag: string): unknown {
      if (tag === 'video') {
        const handlers = new Map<string, () => void>();
        const video: FakeVideo = {
          src: '',
          currentTime: 0,
          duration: 4,
          videoWidth: opts.width ?? 1920,
          videoHeight: opts.height ?? 1080,
          crossOrigin: null,
          muted: false,
          preload: '',
          released: 0,
          fire: (type) => handlers.get(type)?.(),
        };
        videos.push(video);
        return Object.assign(video, {
          addEventListener: (type: string, fn: () => void) => handlers.set(type, fn),
          removeAttribute: () => (video.released += 1),
          load: () => undefined,
        });
      }

      const canvas = {
        width: 0,
        height: 0,
        getContext: () =>
          opts.context === false
            ? null
            : { drawImage: (_el: unknown, _x: number, _y: number, w: number, h: number) => drawn.push({ w, h }) },
        toDataURL: () => 'data:image/png;base64,POSTER',
      };
      return canvas;
    },
  } as unknown as Document;

  return { doc, videos, drawn };
}

describe('capturePoster', () => {
  it('seeks, draws once, and releases the element', async () => {
    const { doc, videos, drawn } = fakeDoc();
    const capture = capturePoster({ doc, src: 'sting.webm', maxSize: 128 });
    const video = videos[0]!;

    expect(video.src).toBe('sting.webm');
    // `metadata`, not `auto`: buffering the clip is the cost being removed.
    expect(video.preload).toBe('metadata');
    expect(video.muted).toBe(true);

    video.fire('loadeddata');
    expect(video.currentTime).toBeCloseTo(0.1, 6);

    video.fire('seeked');
    await expect(capture.frame).resolves.toBe('data:image/png;base64,POSTER');

    // The bitmap is capped on its longest edge and keeps the clip's aspect.
    expect(drawn).toEqual([{ w: 128, h: 72 }]);
    // The whole point of the module: no element outlives the frame it produced.
    expect(video.released).toBe(1);
  });

  it('asks for the media time the caller resolved from the duration', async () => {
    const { doc, videos } = fakeDoc();
    const mediaTime = vi.fn((duration: number) => Math.min(2.5, duration));
    const capture = capturePoster({ doc, src: 'sting.webm', mediaTime });

    videos[0]!.fire('loadeddata');
    expect(mediaTime).toHaveBeenCalledWith(4);
    expect(videos[0]!.currentTime).toBeCloseTo(2.5, 6);

    videos[0]!.fire('seeked');
    await capture.frame;
  });

  it('draws without waiting when the element is already on the wanted frame', async () => {
    /*
     * A seek to where the element already sits fires no `seeked` event, so a
     * capture that only ever drew from that handler would hang forever on a
     * clip whose first frame is the one asked for.
     */
    const { doc, videos } = fakeDoc();
    const capture = capturePoster({ doc, src: 'sting.webm', mediaTime: () => 0.1 });

    videos[0]!.currentTime = 0.1;
    videos[0]!.fire('loadeddata');

    await expect(capture.frame).resolves.toBe('data:image/png;base64,POSTER');
  });

  it('resolves null on an error, and still releases', async () => {
    const { doc, videos } = fakeDoc();
    const capture = capturePoster({ doc, src: 'missing.webm' });

    videos[0]!.fire('error');

    await expect(capture.frame).resolves.toBeNull();
    expect(videos[0]!.released).toBe(1);
  });

  it('resolves null rather than throwing when there is no 2D context', async () => {
    // The happy-dom and headless cases. A thumbnail is a convenience and must
    // not be able to throw into a panel drawing something else.
    const { doc, videos } = fakeDoc({ context: false });
    const capture = capturePoster({ doc, src: 'sting.webm' });

    videos[0]!.fire('loadeddata');
    videos[0]!.fire('seeked');

    await expect(capture.frame).resolves.toBeNull();
  });

  it('cancel releases immediately and settles null', async () => {
    const { doc, videos } = fakeDoc();
    const capture = capturePoster({ doc, src: 'sting.webm' });

    capture.cancel();
    expect(videos[0]!.released).toBe(1);
    await expect(capture.frame).resolves.toBeNull();

    // A late decode must not reopen a capture the caller has already abandoned.
    capture.cancel();
    videos[0]!.fire('loadeddata');
    expect(videos[0]!.released).toBe(1);
  });
});

/* ------------------------------------------------------------------ sync */

function layer(over: Partial<VideoLayer> = {}): VideoLayer {
  return { id: 'v', type: 'video', src: 'sting.webm', ...over } as VideoLayer;
}

/** A minimal `<img>`: the three members `PosterSync` touches. */
function fakeImg() {
  return {
    src: '',
    ownerDocument: {} as Document,
    removeAttribute: function (this: { src: string }) {
      this.src = '';
    },
  } as unknown as HTMLImageElement;
}

/** Records every capture and lets the test decide when each one lands. */
function recorder() {
  const calls: Array<CapturePosterOptions & { resolve: (v: string | null) => void; cancelled: boolean }> = [];
  const capture = (opts: CapturePosterOptions): PosterCapture => {
    let resolve!: (v: string | null) => void;
    const frame = new Promise<string | null>((r) => (resolve = r));
    const entry = { ...opts, resolve, cancelled: false };
    calls.push(entry);
    return {
      frame,
      cancel: () => {
        entry.cancelled = true;
        resolve(null);
      },
    };
  };
  return { calls, capture };
}

describe('PosterSync', () => {
  it('captures once for a build-then-seek, at the seeked time', async () => {
    /*
     * The sequence every thumbnail runs: `build()` ends with `syncTo(0)` and
     * `mountCompositionThumb` calls `seek(posterTime)` on the next line, in the
     * same synchronous run. Capturing on the first decodes the wrong frame;
     * capturing on both decodes twice.
     */
    const { calls, capture } = recorder();
    const sync = new PosterSync(capture);
    sync.add('v', { img: fakeImg(), layer: layer({ startAt: 1 }), offset: 0, src: 'sting.webm' });

    sync.syncTo(0);
    sync.syncTo(3);
    await settle();

    expect(calls).toHaveLength(1);
    // Composition time 3 on a layer starting at 1 is media time 2.
    expect(calls[0]!.mediaTime?.(4)).toBeCloseTo(2, 6);
  });

  it('writes the captured frame onto the img', async () => {
    const { calls, capture } = recorder();
    const img = fakeImg();
    const sync = new PosterSync(capture);
    sync.add('v', { img, layer: layer(), offset: 0, src: 'sting.webm' });

    sync.syncTo(1);
    await settle();
    calls[0]!.resolve('data:image/png;base64,POSTER');
    await settle();

    expect(img.src).toBe('data:image/png;base64,POSTER');
  });

  it('leaves the img sourceless when no frame could be taken', async () => {
    // Not a broken-image icon, which reads as a bug in the editor rather than
    // as a clip the browser would not open.
    const { calls, capture } = recorder();
    const img = fakeImg();
    const sync = new PosterSync(capture);
    sync.add('v', { img, layer: layer(), offset: 0, src: 'sting.webm' });

    sync.syncTo(1);
    await settle();
    calls[0]!.resolve(null);
    await settle();

    expect(img.src).toBe('');
  });

  it('does not re-decode for a pose that moved less than a frame', async () => {
    const { calls, capture } = recorder();
    const sync = new PosterSync(capture);
    sync.add('v', { img: fakeImg(), layer: layer(), offset: 0, src: 'sting.webm' });

    sync.syncTo(1);
    await settle();
    sync.syncTo(1.01);
    await settle();

    expect(calls).toHaveLength(1);
  });

  it('re-decodes when the pose genuinely moves', async () => {
    // The other half — a threshold that never lets anything through would
    // satisfy the case above on its own.
    const { calls, capture } = recorder();
    const sync = new PosterSync(capture);
    sync.add('v', { img: fakeImg(), layer: layer(), offset: 0, src: 'sting.webm' });

    sync.syncTo(1);
    await settle();
    sync.syncTo(3);
    await settle();

    expect(calls).toHaveLength(2);
    expect(calls[1]!.mediaTime?.(4)).toBeCloseTo(3, 6);
  });

  it('re-captures and clears the img when a binding changes the source', async () => {
    // A dynamic field bound to a video layer writes a URL, and assigning an
    // `.mp4` to an `<img>` renders the browser's broken-image icon.
    const { calls, capture } = recorder();
    const img = fakeImg();
    const sync = new PosterSync(capture);
    sync.add('v', { img, layer: layer(), offset: 0, src: 'sting.webm' });

    sync.syncTo(1);
    await settle();
    calls[0]!.resolve('data:image/png;base64,FIRST');
    await settle();
    expect(img.src).toBe('data:image/png;base64,FIRST');

    sync.setSrc('v', 'other.webm');
    expect(img.src).toBe('');
    await settle();

    expect(calls).toHaveLength(2);
    expect(calls[1]!.src).toBe('other.webm');
  });

  it('captures nothing for a layer with no source', async () => {
    const { calls, capture } = recorder();
    const sync = new PosterSync(capture);
    sync.add('v', { img: fakeImg(), layer: layer({ src: '' }), offset: 0, src: '' });

    sync.syncTo(1);
    await settle();

    expect(calls).toHaveLength(0);
  });

  it('cancels a capture in flight on destroy and never writes after it', async () => {
    const { calls, capture } = recorder();
    const img = fakeImg();
    const sync = new PosterSync(capture);
    sync.add('v', { img, layer: layer(), offset: 0, src: 'sting.webm' });

    sync.syncTo(1);
    await settle();
    sync.destroy();

    expect(calls[0]!.cancelled).toBe(true);

    // A decode that lands after the panel unmounted must not touch the DOM.
    calls[0]!.resolve('data:image/png;base64,LATE');
    await settle();
    expect(img.src).toBe('');
  });

  it('ignores a syncTo after destroy', async () => {
    const { calls, capture } = recorder();
    const sync = new PosterSync(capture);
    sync.add('v', { img: fakeImg(), layer: layer(), offset: 0, src: 'sting.webm' });

    sync.destroy();
    sync.syncTo(1);
    await settle();

    expect(calls).toHaveLength(0);
  });
});
