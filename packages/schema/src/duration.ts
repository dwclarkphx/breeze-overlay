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
