// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Scenes — compositions that host independently triggered elements.
 *
 * A scene is not a document type. It is an ordinary composition holding
 * `composition` layers marked `independent`, each of which becomes its own
 * graphic on its own control channel (SCENES.md §3).
 *
 * This lives in `@breeze/schema` rather than in `runtime/expand.ts` for one
 * practical reason: the server and the control panel both need the element list
 * and neither should import `@breeze/runtime`, whose barrel pulls GSAP in at
 * module load. It also needs no composition resolver — an independent element
 * is authored directly in the scene, so the scene's own layer tree is the whole
 * answer.
 *
 * One function, three consumers — the player (what runtimes to mount), the
 * server (what channels exist) and the panel (what strips to render). Three
 * call sites deriving this list three ways is how they end up disagreeing about
 * which graphic a trigger reaches.
 */

import { walkLayers } from './duration.js';
import type { Composition } from './types.js';

/** One independently triggered element of a scene. */
export interface SceneElement {
  /** The composition layer's own id, unique within the scene. */
  layerId: string;
  /** Display name for panels; the layer's name, falling back to the ref. */
  name: string;
  /** Composition this element renders. */
  ref: string;
  /**
   * Control channel — the second segment of the channel key. Defaults to `ref`.
   *
   * Not resolved against the project here. An element pointing at a composition
   * that no longer exists still occupies a channel, and how to present that is
   * the caller's business: the player logs it, the panel grays it out.
   */
  channel: string;
}

/**
 * Independently triggered elements, in paint order.
 *
 * Paint order is layer order — `walkLayers` is depth-first in author order, so
 * the result needs no sorting, and must not be sorted: layer order is what
 * decides whether the bug sits over or under the strap.
 */
export function sceneElements(comp: Composition): SceneElement[] {
  const out: SceneElement[] = [];

  walkLayers(comp.layers, (layer) => {
    if (layer.type !== 'composition' || !layer.independent) return;
    out.push({
      layerId: layer.id,
      name: layer.name ?? layer.ref,
      ref: layer.ref,
      channel: layer.channel ?? layer.ref,
    });
  });

  return out;
}

/** True when this composition mounts independently triggered elements. */
export function isScene(comp: Composition): boolean {
  return sceneElements(comp).length > 0;
}
