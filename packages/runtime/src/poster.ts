// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * One frame from a video, captured and then let go of.
 *
 * **What this is for.** A still (`RuntimeOptions.still`) exists to be a
 * thumbnail, and until now a video layer inside one built a real `<video>` with
 * `preload="auto"` — a decoder and a download per thumbnail, held for as long
 * as the panel showing it was on screen. Twenty compositions with a stinger in
 * them were twenty of those, none of which would ever play a frame. The fix is
 * the one the editor's own `LayerThumb` already used for a bare video layer:
 * draw a single frame onto a canvas, keep the bitmap, drop the element.
 *
 * **Why the helper moved here rather than being imported from the editor.** The
 * runtime is what builds a still's DOM, so it is the only place that can decide
 * a video layer should be an `<img>`. Putting the capture beside it and having
 * `LayerThumb` call in is the direction that leaves one implementation; the
 * other direction leaves the editor unable to reach the layer at all. Same
 * resolution as the asset reader/rewriter pair, and the local
 * `hasIndependentChildren` the scene work deleted in favour of the schema's.
 *
 * **A poster is not a paused video, and the difference is deliberate in one
 * place.** `VideoSync.syncTo` parks a live element on literal frame 0 when the
 * layer has not started yet. A poster nudges off zero instead, because several
 * encoders put a black or near-black frame first and a thumbnail of black is
 * indistinguishable from a thumbnail that failed to load — the one thing a
 * thumbnail exists to rule out. On a graphic that has started, the two agree
 * exactly: both go through `mediaTimeAt`.
 */

import type { VideoLayer } from '@breeze/schema';

import { mediaTimeAt, SEEK_EPSILON } from './video.js';

/** Longest edge of a captured bitmap, in device pixels, when none is given. */
const DEFAULT_MAX_SIZE = 128;

/**
 * How far off zero to nudge, and the cap on that nudge for a very short clip.
 *
 * A tenth of a second clears the leading black frame on every encoder we have
 * seen without landing somewhere unrepresentative; `duration / 10` keeps it
 * proportional on a half-second sting, where 0.1s is already a fifth of the way
 * through.
 */
const BLACK_FRAME_NUDGE = 0.1;

export interface PosterCapture {
  /** The frame as a data URL, or null if one could not be taken. */
  frame: Promise<string | null>;
  /** Abandon the capture and release the element now. Safe to call twice. */
  cancel: () => void;
}

export interface CapturePosterOptions {
  /** Document to build the throwaway elements in. */
  doc: Document;
  /** Already resolved to something the page can load. */
  src: string;
  /** Longest edge of the captured bitmap, in device pixels. */
  maxSize?: number;
  /**
   * The media time to grab, decided once the duration is known.
   *
   * A callback rather than a number because the duration is the whole reason
   * this is asynchronous: `mediaTimeAt` needs it to clamp, hold or wrap, and it
   * does not exist until the element has loaded. Returning `null` means the
   * layer has not started at this composition time — the frame is taken from
   * the head of the clip, as the live path does.
   */
  mediaTime?: (duration: number) => number | null;
}

/**
 * The frame to actually seek to.
 *
 * Split out and exported because it is the only part of a capture that can be
 * tested without a decoder, and because the black-frame rule is a judgement
 * call rather than a mechanism — the kind of thing that gets "simplified" back
 * to `currentTime = 0` by someone reading the seek in isolation.
 */
export function posterFrameTime(requested: number | null, duration: number): number {
  const known = Number.isFinite(duration) && duration > 0;
  const nudge = known ? Math.min(BLACK_FRAME_NUDGE, duration / 10) : BLACK_FRAME_NUDGE;

  // Not started, or parked on the first frame: take the nudge rather than black.
  if (requested === null || requested <= 0) return nudge;

  return known ? Math.min(requested, duration) : requested;
}

/**
 * Grab one frame and release the decoder.
 *
 * Resolves to `null` rather than rejecting on every failure path — a missing
 * asset, a codec the browser will not open, a cross-origin file that taints the
 * canvas. All three are the same thing to the caller: no picture, fall back to
 * the glyph. A thumbnail is a convenience and must not be able to throw into a
 * panel that is drawing something else.
 */
export function capturePoster(opts: CapturePosterOptions): PosterCapture {
  const { doc, src } = opts;
  const max = opts.maxSize ?? DEFAULT_MAX_SIZE;

  let settle: (value: string | null) => void = () => undefined;
  const frame = new Promise<string | null>((resolve) => {
    settle = resolve;
  });

  let done = false;
  const video = doc.createElement('video');

  /**
   * Drop the source and reload.
   *
   * This is the point of the whole module: an element that keeps its `src` also
   * keeps a decoder and whatever it has buffered, and a browser source that
   * rebuilds its panels accumulates them. `load()` throws in some non-browser
   * DOMs, and a failure to tidy up must not become the caller's problem.
   */
  const release = (): void => {
    try {
      video.removeAttribute('src');
      video.load();
    } catch {
      /* Not a real media element. Nothing was allocated, so nothing to free. */
    }
  };

  const finish = (value: string | null): void => {
    if (done) return;
    done = true;
    release();
    settle(value);
  };

  const draw = (): void => {
    if (done) return;

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return finish(null);

    const canvas = doc.createElement('canvas');
    const scale = Math.min(1, max / Math.max(w, h));
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));

    // Absent outside a real browser, and null when the context cannot be had.
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return finish(null);

    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      finish(canvas.toDataURL('image/png'));
    } catch {
      // A cross-origin asset taints the canvas and `toDataURL` throws.
      finish(null);
    }
  };

  const onLoaded = (): void => {
    if (done) return;
    const duration = video.duration;
    const requested = opts.mediaTime ? opts.mediaTime(duration) : null;
    const time = posterFrameTime(requested, duration);

    /*
     * A seek that lands where the element already is fires no `seeked` event,
     * which would leave the promise hanging forever on a clip whose first frame
     * is already the one we want. Draw straight away in that case.
     */
    if (Math.abs(video.currentTime - time) < 1e-6) return draw();
    video.currentTime = time;
  };

  video.crossOrigin = 'anonymous';
  video.muted = true;
  // `metadata`, not `auto`: the element lives for one seek and one draw, and
  // buffering the rest of the clip is exactly the cost being removed here.
  video.preload = 'metadata';
  video.addEventListener('loadeddata', onLoaded, { once: true });
  video.addEventListener('seeked', draw, { once: true });
  video.addEventListener('error', () => finish(null), { once: true });
  video.src = src;

  return { frame, cancel: () => finish(null) };
}

/* ------------------------------------------------------------------ sync */

export interface PosterBinding {
  /** The element the captured frame is written to. */
  img: HTMLImageElement;
  layer: VideoLayer;
  /** Nested-composition time offset applied to `startAt`. */
  offset: number;
  /** Already resolved to something the page can load. */
  src: string;
}

/** Injected in tests, so the coalescing can be exercised without a decoder. */
export type CaptureFn = (opts: CapturePosterOptions) => PosterCapture;

interface PosterEntry extends PosterBinding {
  pending: PosterCapture | null;
  /** Composition time the current frame was taken for, or null if none is. */
  posedAt: number | null;
}

/**
 * `VideoSync`'s counterpart for a still: the same bindings, no media.
 *
 * The two are separate classes rather than a mode on one because they overlap
 * in almost nothing. `VideoSync` exists to keep a running element in step with
 * a playhead — play, pause, drift correction, an end state that changes every
 * frame. A still has no playhead: it is posed once and then looked at. What
 * they do share, `mediaTimeAt`, is shared directly.
 *
 * **Captures are coalesced onto a microtask.** A thumbnail is built and then
 * immediately seeked to its poster time — `build()` ends with `syncTo(0)` and
 * `mountCompositionThumb` calls `seek(posterTimeOf(comp))` on the next line, in
 * the same synchronous run. Capturing on the first of those would decode the
 * wrong frame and capturing on both would decode twice, so the requested time
 * is recorded and the work runs once the caller has finished posing.
 */
export class PosterSync {
  private entries = new Map<string, PosterEntry>();
  private want: number | null = null;
  private flushing = false;
  private destroyed = false;

  constructor(private readonly capture: CaptureFn = capturePoster) {}

  add(id: string, binding: PosterBinding): void {
    this.entries.set(id, { ...binding, pending: null, posedAt: null });
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Point one binding at a different clip.
   *
   * A dynamic field bound to a video layer writes a URL, and in a still the
   * element is an `<img>` — assigning an `.mp4` to its `src` would render the
   * browser's broken-image icon rather than a frame. So a binding change goes
   * through here and re-captures instead.
   */
  setSrc(id: string, src: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.src === src) return;
    entry.src = src;
    entry.pending?.cancel();
    entry.pending = null;
    entry.posedAt = null;
    entry.img.removeAttribute('src');
    if (this.want !== null) this.schedule();
  }

  /** Pose every poster at `compTime`. Cheap to call repeatedly. */
  syncTo(compTime: number): void {
    if (this.destroyed || !this.entries.size) return;
    this.want = compTime;
    this.schedule();
  }

  destroy(): void {
    this.destroyed = true;
    for (const entry of this.entries.values()) entry.pending?.cancel();
    this.entries.clear();
  }

  private schedule(): void {
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => {
      this.flushing = false;
      this.flush();
    });
  }

  private flush(): void {
    const compTime = this.want;
    if (this.destroyed || compTime === null) return;

    for (const entry of this.entries.values()) {
      if (!entry.src) continue;
      // Already showing this pose, within a frame. Re-decoding for a difference
      // nobody can see is the cost this class was written to avoid.
      if (entry.posedAt !== null && Math.abs(entry.posedAt - compTime) < SEEK_EPSILON) continue;

      entry.pending?.cancel();
      entry.posedAt = compTime;

      const capture = this.capture({
        doc: entry.img.ownerDocument,
        src: entry.src,
        mediaTime: (duration) => mediaTimeAt(entry.layer, entry.offset, compTime, duration),
      });
      entry.pending = capture;

      void capture.frame.then((url) => {
        if (this.destroyed || entry.pending !== capture) return;
        entry.pending = null;
        // No frame leaves the `<img>` sourceless, which renders as nothing —
        // deliberately not a broken-image icon, which reads as a bug in the
        // editor rather than as a clip that could not be decoded.
        if (url) entry.img.src = url;
        else entry.posedAt = null;
      });
    }
  }
}
