// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Layer expansion — the one place nesting is resolved.
 *
 * Groups and `composition` layers both introduce a tree, and both the timeline
 * planner and the DOM builder need to walk it. Doing that walk twice invites
 * the two to disagree about ids, time offsets or recursion limits, so it
 * happens exactly once here and produces a flat list of instances that both
 * consume.
 *
 * Nested compositions follow After Effects precomp semantics:
 *  - the child's layers are inlined into the parent's single timeline, so
 *    there is still one playhead and one source of truth (which is what makes
 *    `seek()` and editor scrubbing land on a single coherent frame)
 *  - the child's own STOP markers are ignored; only the root composition
 *    defines playback steps
 *  - `layer.in` acts as the precomp's start time
 */

import type { Composition, Layer } from '@breeze/schema';

export interface ExpandWarning {
  layerId: string;
  message: string;
}

export interface LayerInstance {
  /**
   * Namespaced id, e.g. `badge/bar` for layer `bar` inside the `badge`
   * composition layer. Unique across the whole expanded tree even when the
   * same composition is instantiated twice.
   */
  id: string;
  /** The authored layer. Its own `id` is the un-namespaced one. */
  layer: Layer;
  /** Parent instance id, or null at the top level. */
  parentId: string | null;
  /** Seconds added to every keyframe time and in/out point of this instance. */
  offset: number;
  /** Nesting depth; 0 at the top level. */
  depth: number;
  /**
   * Binding names frozen by an enclosing composition layer's `overrides`.
   * A parent `update()` must not overwrite these — that is the whole point of
   * instantiating the same badge twice with different text.
   */
  pinnedBindings: Set<string>;
  /** Values supplied by the enclosing composition layer for pinned bindings. */
  overrides: Record<string, unknown>;
}

export interface ExpandResult {
  instances: LayerInstance[];
  warnings: ExpandWarning[];
}

export interface ExpandOptions {
  /** Resolves a `composition` layer's `ref` to another composition. */
  resolve?: ((id: string) => Composition | undefined) | undefined;
  /** Safety net against a resolver that returns ever-deeper structures. */
  maxDepth?: number;
}

export const DEFAULT_MAX_DEPTH = 8;

interface Frame {
  layers: Layer[];
  parentId: string | null;
  prefix: string;
  offset: number;
  depth: number;
  pinnedBindings: Set<string>;
  overrides: Record<string, unknown>;
  /** Composition ids currently open above this frame — the cycle guard. */
  chain: readonly string[];
}


/** Stop-marker times of a composition, sorted. */
function stopTimes(comp: Composition): number[] {
  return (comp.markers ?? [])
    .filter((m) => m.type === 'stop')
    .map((m) => m.time)
    .sort((a, b) => a - b);
}

export function expandComposition(comp: Composition, options: ExpandOptions = {}): ExpandResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const instances: LayerInstance[] = [];
  const warnings: ExpandWarning[] = [];

  /*
   * Only the root's stop markers become playback steps, so they are the whole
   * of what a flattened child can hold at — see the warning where a nested
   * composition is walked.
   */
  const rootStops = stopTimes(comp);

  const walk = (frame: Frame): void => {
    for (const layer of frame.layers) {
      const id = `${frame.prefix}${layer.id}`;

      instances.push({
        id,
        layer,
        parentId: frame.parentId,
        offset: frame.offset,
        depth: frame.depth,
        pinnedBindings: frame.pinnedBindings,
        overrides: frame.overrides,
      });

      if (layer.type === 'group') {
        walk({
          ...frame,
          layers: layer.children,
          parentId: id,
          prefix: `${id}/`,
          // A group is a transform container, not a time container: children
          // share the group's clock rather than being offset by it.
          depth: frame.depth + 1,
        });
        continue;
      }

      if (layer.type !== 'composition') continue;

      /*
       * Independent elements are not expanded (SCENES.md §3).
       *
       * The instance above is still pushed, for the scene's own paint order —
       * but the walk stops here, so this instance never gets children and its
       * DOM node stays empty. The visible graphic is mounted separately, by
       * the player, into its own full-frame container built from the
       * referenced composition's own stage; this instance's `transform` is
       * not read for that. Confirmed as the intended shape (SCENES.md §2): an
       * independent element is a link and a channel, not a placement — move,
       * resize or restyle it by editing the referenced composition, not this
       * layer.
       */
      if (layer.independent) continue;

      /* ------------------------------------------- nested composition */

      if (frame.chain.includes(layer.ref)) {
        warnings.push({
          layerId: id,
          message: `cyclic composition reference "${layer.ref}" — not expanded`,
        });
        continue;
      }

      if (frame.depth + 1 > maxDepth) {
        warnings.push({
          layerId: id,
          message: `nesting deeper than ${maxDepth} levels — not expanded`,
        });
        continue;
      }

      const child = options.resolve?.(layer.ref);
      if (!child) {
        warnings.push({
          layerId: id,
          message: `unresolved composition reference "${layer.ref}"`,
        });
        continue;
      }

      /*
       * A flattened child's own STOP markers are dropped, and that is worth
       * saying out loud rather than leaving to be discovered on air.
       *
       * Precomp semantics (see the module note) give the root sole authority
       * over playback steps, so a ticker authored as *animate in → STOP → hold
       * on air* stops holding the moment it is nested: its content runs
       * straight past the point it was built to wait at. The graphic is not
       * broken and the runtime cannot know which timing was intended — the
       * author may have aligned the parent deliberately — so this reports the
       * mismatch and leaves the decision where it belongs.
       *
       * Compared in root time: the child's marker is offset by the same `in`
       * that offsets its layers, which is what makes "0.6 inside a mount that
       * starts at 2s" line up with a root stop at 2.6.
       */
      const childOffset = frame.offset + (layer.in ?? 0);
      const dropped = stopTimes(child)
        .map((t) => t + childOffset)
        .filter((t) => !rootStops.some((r) => Math.abs(r - t) < 1e-3));

      if (dropped.length) {
        const at = dropped.map((t) => `${Math.round(t * 1000) / 1000}s`).join(', ');
        warnings.push({
          layerId: id,
          message:
            `"${layer.ref}" holds at ${at}, which this composition does not — a nested ` +
            'composition plays on its parent\'s timeline and its own STOP markers are ' +
            'ignored. Move a marker so the two line up, or the child will run straight ' +
            'through the point it was built to hold at.',
        });
      }

      const overrides = layer.overrides ?? {};
      walk({
        layers: child.layers,
        parentId: id,
        prefix: `${id}/`,
        // `in` doubles as the precomp start time.
        offset: frame.offset + (layer.in ?? 0),
        depth: frame.depth + 1,
        // Pins accumulate: an override applied two levels up still wins.
        pinnedBindings: new Set([...frame.pinnedBindings, ...Object.keys(overrides)]),
        overrides: { ...frame.overrides, ...overrides },
        chain: [...frame.chain, layer.ref],
      });
    }
  };

  walk({
    layers: comp.layers,
    parentId: null,
    prefix: '',
    offset: 0,
    depth: 0,
    pinnedBindings: new Set(),
    overrides: {},
    chain: [comp.id],
  });

  return { instances, warnings };
}

/** Instances whose parent is `parentId`, in author order. */
export function childrenOf(instances: LayerInstance[], parentId: string | null): LayerInstance[] {
  return instances.filter((i) => i.parentId === parentId);
}

/*
 * The scene element list lives in `@breeze/schema` (`scene.ts`), not here.
 * The server and the control panel both need it and neither should import this
 * package — the runtime barrel pulls GSAP in at module load. Expansion's only
 * responsibility for independence is the `continue` above.
 */
