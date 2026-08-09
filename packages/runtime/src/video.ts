// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Video layers, slaved to the composition playhead.
 *
 * A `<video>` left to its own devices runs on its own clock, so a stinger
 * drifts out of sync with the graphic wrapped around it and scrubbing in the
 * editor shows a frozen frame. Every video is therefore driven from the
 * timeline: the runtime tells it what composition time it is, and this decides
 * the media time.
 *
 * `startAt` is the composition time at which frame 0 of the media plays.
 */

import type { VideoLayer } from '@breeze/schema';

/** Below this, seeking every frame costs more than it buys. */
const SEEK_EPSILON = 0.04; // ~1 frame at 25fps

/**
 * `HTMLMediaElement.HAVE_METADATA`, inlined.
 *
 * Reading it off the global throws outright anywhere the DOM constructor is
 * absent — Node tests today, and a non-real-time or server-side renderer
 * later. The value is fixed by the HTML spec, so there is nothing to gain by
 * looking it up.
 */
const HAVE_METADATA = 1;

export interface VideoBinding {
  el: HTMLVideoElement;
  layer: VideoLayer;
  /** Nested-composition time offset applied to `startAt`. */
  offset: number;
}

export class VideoSync {
  private bindings: VideoBinding[] = [];
  private pendingSeeks = new WeakMap<HTMLVideoElement, number>();

  add(binding: VideoBinding): void {
    this.bindings.push(binding);

    // A seek issued before metadata arrives is silently dropped by the
    // element, which is how a video ends up stuck on frame 0 after a reload.
    binding.el.addEventListener('loadedmetadata', () => {
      const pending = this.pendingSeeks.get(binding.el);
      if (pending !== undefined) {
        this.seekElement(binding.el, pending);
        this.pendingSeeks.delete(binding.el);
      }
    });
  }

  get size(): number {
    return this.bindings.length;
  }

  /** Media time for a given composition time, or null if it should not show. */
  mediaTimeFor(binding: VideoBinding, compTime: number): number | null {
    const start = binding.offset + (binding.layer.startAt ?? 0);
    const elapsed = compTime - start;
    if (elapsed < 0) return null;

    const duration = binding.el.duration;
    if (!Number.isFinite(duration) || duration <= 0) return elapsed;

    if (elapsed <= duration) return elapsed;
    if (binding.layer.loop) return elapsed % duration;
    return duration; // hold the last frame
  }

  /**
   * Has this video played out, and been told to disappear when it does?
   *
   * Separate from `mediaTimeFor` because the two answer different questions and
   * only one of them has a time in it. A stinger that has finished should leave
   * nothing behind — holding its final frame parks whatever that frame happened
   * to be over live pictures — while a background plate wants exactly the
   * opposite. `hold` is the default because it is what the runtime did before
   * the option existed.
   */
  private isCleared(binding: VideoBinding, compTime: number): boolean {
    if (binding.layer.loop || binding.layer.onEnd !== 'clear') return false;

    const duration = binding.el.duration;
    if (!Number.isFinite(duration) || duration <= 0) return false;

    const start = binding.offset + (binding.layer.startAt ?? 0);
    return compTime - start > duration;
  }

  /**
   * Show or hide according to `onEnd`.
   *
   * `visibility` rather than `display`, deliberately. A `display: none` element
   * measures zero, and the runtime measures elements — that is the bug behind
   * Fit Width breaking silently on layers with an in-point. Visibility keeps the
   * box, and a paused `<video>` costs nothing to keep laid out.
   */
  private applyEndState(binding: VideoBinding, compTime: number): void {
    binding.el.style.visibility = this.isCleared(binding, compTime) ? 'hidden' : '';
  }

  /** Scrubbing: park every video on the exact frame for `compTime`. */
  syncTo(compTime: number): void {
    for (const binding of this.bindings) {
      binding.el.pause();
      this.applyEndState(binding, compTime);
      const media = this.mediaTimeFor(binding, compTime);
      if (media === null) {
        this.seekElement(binding.el, 0);
        continue;
      }
      this.seekElement(binding.el, media);
    }
  }

  /** Rolling: line each video up with `compTime` and let it run. */
  play(compTime: number): void {
    for (const binding of this.bindings) {
      this.applyEndState(binding, compTime);
      const media = this.mediaTimeFor(binding, compTime);
      if (media === null) {
        binding.el.pause();
        this.seekElement(binding.el, 0);
        continue;
      }

      // Only correct when we have actually drifted; a seek on every frame
      // makes Chromium re-decode and stutters the whole graphic.
      if (Math.abs(binding.el.currentTime - media) > SEEK_EPSILON) {
        this.seekElement(binding.el, media);
      }

      // play() rejects when the element is detached or the source is missing;
      // a failed stinger must not break the graphic around it.
      void binding.el.play().catch(() => undefined);
    }
  }

  pause(): void {
    for (const binding of this.bindings) binding.el.pause();
  }

  /** Start videos whose start time has just passed, without re-seeking the rest. */
  tick(compTime: number): void {
    for (const binding of this.bindings) {
      // Runs every frame, so a stinger disappears the moment it plays out
      // rather than at the next seek.
      this.applyEndState(binding, compTime);
      const media = this.mediaTimeFor(binding, compTime);
      if (media === null) continue;
      if (binding.el.paused && !binding.el.ended) {
        void binding.el.play().catch(() => undefined);
      }
    }
  }

  destroy(): void {
    for (const binding of this.bindings) {
      binding.el.pause();
      // Dropping the source releases the decoder; a browser source that
      // reloads repeatedly otherwise accumulates them.
      binding.el.removeAttribute('src');
      binding.el.load();
    }
    this.bindings = [];
  }

  private seekElement(el: HTMLVideoElement, time: number): void {
    if (el.readyState < HAVE_METADATA) {
      this.pendingSeeks.set(el, time);
      return;
    }
    const duration = Number.isFinite(el.duration) ? el.duration : undefined;
    el.currentTime = duration === undefined ? time : Math.min(time, duration);
  }
}
