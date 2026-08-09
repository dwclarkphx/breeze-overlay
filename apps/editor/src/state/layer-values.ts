// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Reading animatable values off a layer.
 *
 * Shared by the properties panel and the stage, so a number typed into a field
 * and the same number produced by dragging on canvas go through identical
 * logic. They used to diverge: the panel wrote a keyframe when a property was
 * animated, while dragging always wrote the static baseline — which the planner
 * ignores entirely once a keyframe track exists, so dragging an animated layer
 * silently did nothing.
 */

import { DEFAULT_TRANSFORM, type AnimatableProp, type Layer } from '@breeze/schema';

export function isAnimated(layer: Layer, prop: AnimatableProp): boolean {
  return Boolean(layer.keyframes?.[prop]?.length);
}

/** The authored static value, used when a property has no keyframes. */
export function baselineOf(layer: Layer, prop: AnimatableProp): number {
  const t = { ...DEFAULT_TRANSFORM, ...(layer.transform ?? {}) };
  if (prop === 'opacity') return layer.opacity ?? 1;
  if (prop === 'blur') return layer.effects?.blur ?? 0;
  if (prop === 'brightness') return layer.effects?.brightness ?? 1;
  if (prop === 'maskOffset') return 0;
  return t[prop as keyof typeof t] ?? 0;
}

/**
 * What the property is actually worth at `playhead` — the value on screen.
 *
 * Between keyframes this interpolates linearly rather than replaying the
 * authored easing. That is deliberate for a readout and for the starting point
 * of a drag: it is close enough to feel right, and it avoids the panel needing
 * a GSAP instance to answer "what number is this now?".
 */
export function displayValue(layer: Layer, prop: AnimatableProp, playhead: number): number {
  const track = layer.keyframes?.[prop];
  if (!track?.length) return baselineOf(layer, prop);

  const at = track.find((kf) => Math.abs(kf.t - playhead) < 1e-6);
  if (at) return at.v;

  const before = [...track].reverse().find((kf) => kf.t <= playhead);
  const after = track.find((kf) => kf.t >= playhead);

  if (before && after && before !== after) {
    const p = (playhead - before.t) / (after.t - before.t);
    return before.v + (after.v - before.v) * p;
  }
  return (before ?? after ?? track[0]!).v;
}
