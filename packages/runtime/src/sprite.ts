// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Sprite-sheet layers, slaved to the composition playhead.
 *
 * Deliberately shaped like `VideoSync` rather than like a keyframe track: a
 * sprite sheet is timed media that happens to be delivered as one PNG, and the
 * questions it has to answer — what shows at this composition time, what
 * happens after it plays out, what happens when the operator scrubs — are the
 * questions `video.ts` already answers. `startAt`, `loop` and `onEnd` therefore
 * mean exactly what they mean on a video layer.
 *
 * **The frame is solved from the clock, not tweened.** The roadmap's original
 * sketch was a GSAP tween of `background-position` under `steppedEase`, and it
 * has two faults. `steppedEase(n)` returns `Math.floor(p * n) / n` and then
 * `1` at `p >= 1`, so the final tick of the tween lands on frame `n` — one
 * past the end of an `n`-frame sheet, which is the empty padding cell on a
 * sheet whose last row is short. And a tween has to be given a duration, which
 * would tie the sheet's rate to the layer's lifetime: dragging the layer's bar
 * in the timeline would silently retime an animation authored at 30fps.
 * Solving `floor(elapsed * fps)` per frame is the same step function with
 * neither problem, and it makes scrubbing exact for free.
 *
 * Nothing here is async. A sprite has no metadata to wait for and no decoder
 * to fall behind, so there is no equivalent of `pendingSeeks` — the sheet is
 * either loaded as a background image or it is not, and either way the frame
 * maths is correct the instant it is asked.
 */

import type { SpriteLayer } from '@breeze/schema';

import { applySpriteFrame } from './dom.js';

export interface SpriteBinding {
  el: HTMLElement;
  layer: SpriteLayer;
  /** Nested-composition time offset applied to `startAt`. */
  offset: number;
}

/** Frames a sheet actually uses, which is not always what its grid holds. */
export function frameCountOf(layer: SpriteLayer): number {
  const capacity = layer.cols * layer.rows;
  const declared = layer.frameCount ?? capacity;
  // Clamped rather than trusted even though `validate.ts` refuses an
  // over-large `frameCount`: this runs against documents that predate the
  // rule and against anything hand-edited, and the failure it prevents is a
  // background-position past the end of the sheet — a blank graphic on air.
  return Math.max(1, Math.min(declared, capacity));
}

export class SpriteSync {
  private bindings: SpriteBinding[] = [];

  add(binding: SpriteBinding): void {
    this.bindings.push(binding);
  }

  get size(): number {
    return this.bindings.length;
  }

  /**
   * Frame index for a given composition time, or `null` before the sheet
   * starts.
   *
   * `null` is not "show nothing" — the caller parks on frame 0, matching what
   * `buildSprite` renders and what a page holding before its trigger should
   * show. It is distinct from frame 0 only so the caller can tell "has not
   * started" from "is on its first frame", which is the same distinction the
   * text-reveal tests turned out to need between untouched and finished.
   */
  frameFor(binding: SpriteBinding, compTime: number): number | null {
    const start = binding.offset + (binding.layer.startAt ?? 0);
    const elapsed = compTime - start;
    if (elapsed < 0) return null;

    const frames = frameCountOf(binding.layer);
    const raw = Math.floor(elapsed * binding.layer.fps);

    if (raw < frames) return raw;
    if (binding.layer.loop) return raw % frames;
    return frames - 1; // hold the last frame
  }

  /**
   * Has this sheet played out, and been told to disappear when it does?
   *
   * Split from `frameFor` for the same reason `video.ts` splits `isCleared`
   * from `mediaTimeFor`: one of them is a time and the other is a policy, and
   * folding them together makes the held-last-frame case unrepresentable.
   */
  private isCleared(binding: SpriteBinding, compTime: number): boolean {
    if (binding.layer.loop || binding.layer.onEnd !== 'clear') return false;
    const start = binding.offset + (binding.layer.startAt ?? 0);
    const frames = frameCountOf(binding.layer);
    return compTime - start >= frames / binding.layer.fps;
  }

  /**
   * Show or hide according to `onEnd`.
   *
   * `visibility`, never `display` — a `display: none` element measures zero and
   * the runtime measures elements, which is the bug behind Fit Width breaking
   * silently on layers with an in-point.
   */
  private applyEndState(binding: SpriteBinding, compTime: number): void {
    binding.el.style.visibility = this.isCleared(binding, compTime) ? 'hidden' : '';
  }

  /**
   * Park every sprite on the exact frame for `compTime`.
   *
   * Scrubbing and rolling are the same operation here. A video needs separate
   * `syncTo` and `play` because the element owns a clock that has to be
   * corrected against ours; a sprite has no clock of its own, so there is
   * nothing to drift and nothing to start.
   */
  syncTo(compTime: number): void {
    for (const binding of this.bindings) {
      this.applyEndState(binding, compTime);
      const frame = this.frameFor(binding, compTime);
      applySpriteFrame(binding.el, binding.layer, frame ?? 0);
    }
  }

  /** Alias for `syncTo`; the runtime's tick and seek paths both land here. */
  tick(compTime: number): void {
    this.syncTo(compTime);
  }

  destroy(): void {
    this.bindings = [];
  }
}
