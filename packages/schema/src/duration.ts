// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Composition timing helpers.
 *
 * Split out of `validate.ts` so consumers can compute a duration without
 * dragging in Ajv. `validate.ts` instantiates a validator and compiles schemas
 * at module load, which is a top-level side effect no bundler can tree-shake —
 * so anything importing from the same module inherits ~250 kB of validator
 * whether it validates or not.
 */

import type { Composition, Layer } from './types.js';

/** Depth-first walk over the layer tree, groups expanded. */
export function walkLayers(
  layers: Layer[],
  fn: (layer: Layer, path: string) => void,
  base = '/layers',
): void {
  layers.forEach((layer, i) => {
    const path = `${base}/${i}`;
    fn(layer, path);
    if (layer.type === 'group') walkLayers(layer.children, fn, `${path}/children`);
  });
}

/**
 * Latest keyframe / out-point across all layers, in seconds.
 *
 * Markers deliberately do NOT extend the duration: a STOP marker past the last
 * keyframe means the outro never plays, which is an authoring mistake we want
 * `validateCompositionSemantics` to catch rather than paper over.
 */
export function compositionDuration(comp: Composition): number {
  let max = 0;
  walkLayers(comp.layers, (layer) => {
    if (layer.out !== undefined && Number.isFinite(layer.out)) max = Math.max(max, layer.out);
    for (const track of Object.values(layer.keyframes ?? {})) {
      const last = track?.[track.length - 1];
      if (last) max = Math.max(max, last.t);
    }
  });
  return max;
}

/**
 * The time a thumbnail poses this composition at.
 *
 * `posterTime ?? first stop marker ?? 0`, clamped into the composition.
 *
 * **Why not simply t=0.** t=0 is the one moment a graphic is guaranteed to look
 * like nothing: layers are off-stage, mid-animate-in, or still transparent. A
 * thumbnail taken there renders every lower third in a project as the same
 * empty box, which fails the only job a thumbnail has — telling two graphics
 * apart.
 *
 * **Why the first stop marker is the default.** A stop is where the author said
 * playback waits for an operator, which is by construction the pose the graphic
 * spends its on-air life in. It is the rest frame, inferred rather than
 * configured, and it is right for the majority of graphics without anyone
 * setting anything.
 *
 * `posterTime` overrides it for the case inference cannot reach: a multi-state
 * graphic has several stops and only the author knows which one reads as the
 * thing. A composition with no stop at all — a sting that plays straight
 * through — has no rest pose to infer and falls back to 0, which is honest
 * rather than wrong; such a graphic is usually mid-motion at every frame.
 */
export function posterTimeOf(comp: Composition): number {
  const duration = comp.duration ?? compositionDuration(comp);

  if (comp.posterTime !== undefined && Number.isFinite(comp.posterTime)) {
    // Clamped rather than trusted. `duration` is optional and derived when
    // absent, so a poster time authored against a longer edit of the graphic
    // can outlive the keyframes that justified it — and seeking past the end
    // parks the timeline on its final frame, which is the outro.
    return Math.max(0, Math.min(comp.posterTime, duration));
  }

  const stop = (comp.markers ?? [])
    .filter((m) => m.type === 'stop' && Number.isFinite(m.time) && m.time >= 0)
    .sort((a, b) => a.time - b.time)[0];

  if (stop) return Math.max(0, Math.min(stop.time, duration));

  /*
   * No stop marker: pose at the end, not at 0.
   *
   * **This fell back to 0 first, and 0 was wrong.** The reasoning was that a
   * graphic which never holds is mid-motion at every frame, so no pose is
   * better than another. The demo's `badge` disproved it: no stop marker, a
   * chip keyframed `scaleX 0 → 1` and a label `opacity 0 → 1`, so t=0 is
   * precisely the frame where it is scaled to nothing and fully transparent.
   * The thumbnail rendered perfectly and showed an empty box, which is
   * indistinguishable from a thumbnail that failed to build.
   *
   * No stop marker usually means nothing *holds* — the graphic animates in and
   * stays — so the end is its settled pose. The case this is wrong for is a
   * graphic that animates out without ever stopping, which is blank at the end;
   * but that one is equally blank at 0, so this is never worse than what it
   * replaces and is right for every intro-only composition.
   */
  return duration;
}
