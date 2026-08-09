// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Timeline planning — pure functions, no DOM, no GSAP.
 *
 * Turning composition JSON into an explicit list of `set` and `tween`
 * instructions before touching GSAP means the hard part (keyframe → tween
 * segmentation, defaults, layer in/out windows, nested time offsets) is
 * unit-testable in Node and identical for both consumers: the editor preview
 * and the served /play page.
 */

import {
  ANIMATABLE_PROPS,
  DEFAULT_TRANSFORM,
  type AnimatableProp,
  type Composition,
  type Ease,
  type Layer,
} from '@breeze/schema';

import {
  expandComposition,
  type ExpandOptions,
  type ExpandWarning,
  type LayerInstance,
} from './expand.js';

export interface SetInstruction {
  layerId: string;
  prop: AnimatableProp;
  value: number;
  /** Composition time at which the value is applied. */
  at: number;
}

export interface TweenInstruction {
  layerId: string;
  prop: AnimatableProp;
  from: number;
  to: number;
  /** Composition time the tween starts. */
  start: number;
  duration: number;
  ease: Ease;
}

export interface VisibilityWindow {
  layerId: string;
  in: number;
  out: number;
}

export interface TimelinePlan {
  duration: number;
  /** Baseline values applied at t=0 before anything animates. */
  sets: SetInstruction[];
  tweens: TweenInstruction[];
  /** Sorted stop-marker times; playback holds at each. */
  holds: number[];
  windows: VisibilityWindow[];
  /** Flat layer ids in render order, groups and nested comps expanded. */
  order: string[];
  /** Expanded layer instances, in the same order as `order`. */
  instances: LayerInstance[];
  /** Unresolved refs, cycles and depth cut-offs — surfaced by the editor. */
  warnings: ExpandWarning[];
}

/** Baseline (un-keyframed) value for an animatable property on a layer. */
export function baselineValue(layer: Layer, prop: AnimatableProp): number {
  const t = { ...DEFAULT_TRANSFORM, ...(layer.transform ?? {}) };
  switch (prop) {
    case 'x': return t.x;
    case 'y': return t.y;
    case 'scaleX': return t.scaleX;
    case 'scaleY': return t.scaleY;
    case 'rotation': return t.rotation;
    case 'skewX': return t.skewX;
    case 'skewY': return t.skewY;
    case 'opacity': return layer.opacity ?? 1;
    case 'blur': return layer.effects?.blur ?? 0;
    case 'brightness': return layer.effects?.brightness ?? 1;
    case 'maskOffset': return 0;
    default: {
      const exhaustive: never = prop;
      throw new Error(`unhandled prop ${String(exhaustive)}`);
    }
  }
}

/** Depth-first flatten of groups only — kept for callers that predate nesting. */
export function flattenLayers(layers: Layer[], out: Layer[] = []): Layer[] {
  for (const layer of layers) {
    out.push(layer);
    if (layer.type === 'group') flattenLayers(layer.children, out);
  }
  return out;
}

/** One layer's motion, before it is attributed to a layer id. */
export interface LayerMotion {
  sets: Array<Omit<SetInstruction, 'layerId'>>;
  tweens: Array<Omit<TweenInstruction, 'layerId'>>;
}

/**
 * Turn one layer's keyframe tracks into sets and tweens.
 *
 * Split out of `buildPlan` so table cells can be planned by the same code.
 * A cell is a layer, its keyframes mean what any other layer's keyframes mean,
 * and a second keyframe interpreter for them would be a second set of rounding,
 * easing and empty-segment rules to keep in step — the drift would show up as
 * "the cell animates slightly differently from the layer" and be miserable to
 * chase.
 */
export function layerMotion(layer: Layer, offset = 0): LayerMotion {
  const sets: LayerMotion['sets'] = [];
  const tweens: LayerMotion['tweens'] = [];

  for (const prop of ANIMATABLE_PROPS) {
    const track = layer.keyframes?.[prop];

    if (!track || track.length === 0) {
      const base = baselineValue(layer, prop);
      // Only emit sets that differ from the CSS/runtime default, to keep
      // the plan small and diffs readable.
      if (base !== defaultFor(prop)) sets.push({ prop, value: base, at: 0 });
      continue;
    }

    const first = track[0]!;
    // Hold the first keyframe's value from t=0 up to its own time.
    sets.push({ prop, value: first.v, at: 0 });

    for (let i = 0; i < track.length - 1; i++) {
      const a = track[i]!;
      const b = track[i + 1]!;
      const segment = b.t - a.t;
      if (segment <= 0) continue;
      if (a.v === b.v) continue; // nothing to animate
      tweens.push({
        prop,
        from: a.v,
        to: b.v,
        start: offset + a.t,
        duration: segment,
        ease: a.ease ?? 'none',
      });
    }
  }

  return { sets, tweens };
}

/** True when this layer has at least one keyframe worth building a track for. */
export function hasKeyframes(layer: Layer): boolean {
  for (const prop of ANIMATABLE_PROPS) {
    if ((layer.keyframes?.[prop]?.length ?? 0) > 0) return true;
  }
  return false;
}

export function buildPlan(comp: Composition, options: ExpandOptions = {}): TimelinePlan {
  const { instances, warnings } = expandComposition(comp, options);

  const sets: SetInstruction[] = [];
  const tweens: TweenInstruction[] = [];
  const windows: VisibilityWindow[] = [];
  const order: string[] = [];

  for (const instance of instances) {
    const { id, layer, offset } = instance;
    order.push(id);

    windows.push({
      layerId: id,
      in: offset + (layer.in ?? 0),
      out: layer.out === undefined ? Number.POSITIVE_INFINITY : offset + layer.out,
    });

    const motion = layerMotion(layer, offset);
    for (const s of motion.sets) sets.push({ layerId: id, ...s });
    for (const t of motion.tweens) tweens.push({ layerId: id, ...t });
  }

  // Only the root composition's markers define steps; a nested comp's markers
  // are ignored, the same way After Effects ignores markers inside a precomp.
  const holds = (comp.markers ?? [])
    .filter((m) => m.type === 'stop')
    .map((m) => m.time)
    .sort((a, b) => a - b);

  return {
    duration: comp.duration ?? derivedDuration(instances),
    sets,
    tweens,
    holds,
    windows,
    order,
    instances,
    warnings,
  };
}

/**
 * Latest keyframe / out-point across the expanded tree, including nested time
 * offsets — a precomp starting at 2s and running 3s makes the parent 5s long.
 */
export function derivedDuration(instances: LayerInstance[]): number {
  let max = 0;
  for (const { layer, offset } of instances) {
    if (layer.out !== undefined && Number.isFinite(layer.out)) max = Math.max(max, offset + layer.out);
    for (const track of Object.values(layer.keyframes ?? {})) {
      const last = track?.[track.length - 1];
      if (last) max = Math.max(max, offset + last.t);
    }
  }
  return max;
}

/** Value a property has when nothing sets it. */
export function defaultFor(prop: AnimatableProp): number {
  switch (prop) {
    case 'scaleX':
    case 'scaleY':
    case 'opacity':
    case 'brightness':
      return 1;
    default:
      return 0;
  }
}

/**
 * Evaluate the plan at an arbitrary time without GSAP — used by tests and by
 * the future non-real-time renderer. Named GSAP eases fall back to linear here;
 * structured eases (cubic-bezier, stepped) are exact.
 */
export function evaluatePlan(
  plan: TimelinePlan,
  time: number,
  easeResolver: (ease: Ease) => (p: number) => number,
): Map<string, Partial<Record<AnimatableProp, number>>> {
  const state = new Map<string, Partial<Record<AnimatableProp, number>>>();

  const write = (layerId: string, prop: AnimatableProp, value: number) => {
    let layerState = state.get(layerId);
    if (!layerState) {
      layerState = {};
      state.set(layerId, layerState);
    }
    layerState[prop] = value;
  };

  for (const s of plan.sets) {
    if (time >= s.at) write(s.layerId, s.prop, s.value);
  }

  // Tweens are applied in chronological order so later segments win.
  const ordered = [...plan.tweens].sort((a, b) => a.start - b.start);
  for (const tw of ordered) {
    if (time <= tw.start) continue;
    if (time >= tw.start + tw.duration) {
      write(tw.layerId, tw.prop, tw.to);
      continue;
    }
    const p = (time - tw.start) / tw.duration;
    const eased = easeResolver(tw.ease)(p);
    write(tw.layerId, tw.prop, tw.from + (tw.to - tw.from) * eased);
  }

  return state;
}

/** Next stop-marker strictly after `time`, or null if the outro is next. */
export function nextHoldAfter(plan: TimelinePlan, time: number, epsilon = 1e-4): number | null {
  for (const h of plan.holds) {
    if (h > time + epsilon) return h;
  }
  return null;
}
