// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Data-driven graphics in the runtime (Phase 9 Wave R, CHARTS.md).
 *
 * The arithmetic is the schema's (`@breeze/schema` charts.ts); this is the
 * part that touches the DOM: putting a driven value on a property, counting a
 * number up, redrawing a plotted line. Shared by top-level layers and table
 * cells, so a bar on its own and a bar in a results table move the same way.
 *
 * **Every driven property moves through a proxy** — a `{ v }` object per
 * element and property, tweened by GSAP and written out on each update. The
 * proxy remembers where the property *is*, so a second change arriving
 * mid-tween retargets from the bar's current length rather than snapping it
 * back to where the first change started.
 */

import {
  DRIVE_GSAP_PROPS,
  DEFAULT_TRANSFORM,
  decimalsIn,
  formatCount,
  plotPathData,
  plotPoints,
  type DataRow,
  type Ease,
  type Layer,
  type LayerDrive,
  type NumberCount,
  type ShapeLayer,
} from '@breeze/schema';

import { setShapeSweep, setShapeTrim, type LayerNodes } from './dom.js';
import { resolveEase } from './ease.js';
import { baselineValue } from './plan.js';

/** The slice of GSAP used here — injected so the module can be tested headless. */
export interface ChartAnimator {
  to(target: unknown, vars: Record<string, unknown>): { kill(): void };
  set(target: unknown, vars: Record<string, unknown>): void;
}

type Proxy = { v: number; target?: number; tween?: { kill(): void } };

const proxies = new WeakMap<Element, Map<string, Proxy>>();

function proxyFor(el: Element, key: string, initial: () => number): Proxy {
  let byKey = proxies.get(el);
  if (!byKey) {
    byKey = new Map();
    proxies.set(el, byKey);
  }
  let p = byKey.get(key);
  if (!p) {
    p = { v: initial() };
    byKey.set(key, p);
  }
  return p;
}

/** The value a property has before anything drives it. */
function restingValue(layer: Layer, prop: LayerDrive['property']): number {
  if (prop === 'width') return layer.size?.width ?? 0;
  if (prop === 'height') return layer.size?.height ?? 0;
  return baselineValue(layer, prop);
}

/** Put `v` on the element. Width and height grow from the edge the drive names. */
function writeDriven(nodes: LayerNodes, drive: LayerDrive, v: number, animator: ChartAnimator): void {
  const layer = nodes.layer;
  const el = nodes.el;
  switch (drive.property) {
    case 'width':
    case 'height': {
      const size = Math.max(0, v);
      const authored = drive.property === 'width' ? (layer.size?.width ?? 0) : (layer.size?.height ?? 0);
      const shift = drive.grow === 'end' ? authored - size : drive.grow === 'center' ? (authored - size) / 2 : 0;
      el.style[drive.property] = `${size}px`;
      // A margin, never the transform: GSAP owns that, and would rewrite it from its cache.
      if (drive.property === 'width') el.style.marginLeft = shift ? `${shift}px` : '';
      else el.style.marginTop = shift ? `${shift}px` : '';
      if (layer.type === 'shape' && layer.arc && nodes.shapePath) {
        // An arc is drawn in its box's pixels; a resized box redraws it.
        const resized: ShapeLayer = { ...layer, size: { width: drive.property === 'width' ? size : (layer.size?.width ?? 0), height: drive.property === 'height' ? size : (layer.size?.height ?? 0) } };
        setShapeSweep(nodes.shapePath, resized, layer.arc.sweep);
      }
      return;
    }
    case 'sweep':
      if (nodes.shapePath && layer.type === 'shape') setShapeSweep(nodes.shapePath, layer, v);
      return;
    case 'trim':
      if (nodes.shapePath) setShapeTrim(nodes.shapePath, v);
      return;
    default:
      animator.set(el, { [drive.property]: v });
  }
}

/**
 * How a drive reaches its new value: `set` jumps there, `tween` animates from
 * wherever it is, `grow` starts from the bottom of its range — a bar growing in
 * as the graphic plays.
 */
export type DriveMode = 'set' | 'tween' | 'grow';

export function applyDriveValue(
  nodes: LayerNodes,
  drive: LayerDrive,
  index: number,
  value: number,
  animator: ChartAnimator,
  mode: DriveMode,
): void {
  const p = proxyFor(nodes.el, `drive:${index}`, () => restingValue(nodes.layer, drive.property));
  // Already on its way there: an update that changes nothing must not restart the tween.
  if (mode === 'tween' && p.tween && p.target === value) return;
  p.tween?.kill();
  delete p.tween;
  p.target = value;
  const animate = mode !== 'set' && drive.tween !== undefined && drive.tween.duration > 0;
  if (!animate) {
    p.v = value;
    writeDriven(nodes, drive, value, animator);
    return;
  }
  if (mode === 'grow') {
    p.v = drive.range[0];
    writeDriven(nodes, drive, p.v, animator);
  }
  if (p.v === value) {
    writeDriven(nodes, drive, value, animator);
    return;
  }
  p.tween = animator.to(p, {
    v: value,
    duration: drive.tween!.duration,
    ease: resolveEase(drive.tween!.ease as Ease | undefined),
    overwrite: true,
    onUpdate: () => writeDriven(nodes, drive, p.v, animator),
    onComplete: () => {
      delete p.tween;
    },
  });
}

/** Whether a layer has a drive on a transform property, so GSAP must own its transform. */
export function drivesTransform(layer: Layer): boolean {
  return (layer.drives ?? []).some((d) => DRIVE_GSAP_PROPS.has(d.property) && d.property !== 'opacity');
}

/** A cell's static transform handed to GSAP, so a drive can move one part of it. */
export function seedGsapTransform(el: HTMLElement, layer: Layer, animator: ChartAnimator): void {
  const t = { ...DEFAULT_TRANSFORM, ...(layer.transform ?? {}) };
  animator.set(el, {
    x: t.x,
    y: t.y,
    rotation: t.rotation,
    scaleX: t.scaleX,
    scaleY: t.scaleY,
    skewX: t.skewX,
    skewY: t.skewY,
  });
}

/* ---------------------------------------------------------------- counts */

/** Formatting a count falls back to when the layer's `count` names none — a number field's. */
export interface CountFormat {
  decimals?: number;
  prefix?: string;
  suffix?: string;
}

/**
 * Show `value` on `inner`, counting to it from the number shown before (CHARTS.md
 * §4.5). The first number a layer shows is written straight away: there is no
 * "before" to count from, and counting up from zero on load would be a graphic
 * animating when nothing changed. `onDone` runs once the final text is up — the
 * runtime refits then, not on every frame.
 */
export function countTo(
  inner: HTMLElement,
  value: number,
  count: NumberCount,
  fallback: CountFormat,
  animator: ChartAnimator,
  onDone?: () => void,
): void {
  const decimals = count.decimals ?? fallback.decimals ?? decimalsIn(value);
  const prefix = count.prefix ?? fallback.prefix ?? '';
  const suffix = count.suffix ?? fallback.suffix ?? '';
  const write = (n: number): void => {
    inner.textContent = formatCount(n, decimals, prefix, suffix);
  };
  const known = proxies.get(inner)?.get('count');
  const p = proxyFor(inner, 'count', () => value);
  p.tween?.kill();
  delete p.tween;
  if (!known || p.v === value || count.duration <= 0) {
    p.v = value;
    write(value);
    onDone?.();
    return;
  }
  p.tween = animator.to(p, {
    v: value,
    duration: count.duration,
    ease: resolveEase(count.ease as Ease | undefined),
    overwrite: true,
    onUpdate: () => write(p.v),
    onComplete: () => {
      delete p.tween;
      write(value);
      onDone?.();
    },
  });
}

/** A value as a number for counting, or null when it is not one. */
export function countable(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/* ----------------------------------------------------------------- plots */

/**
 * Redraw a plotted path from rows (CHARTS.md §4.4). When the row count is the
 * same as last time and the plot asks for a tween, the points move to their
 * new heights instead of the line being replaced — a temperature line that
 * reshapes when the forecast updates.
 */
export function drawPlot(nodes: LayerNodes, rows: readonly DataRow[], animator: ChartAnimator, animate: boolean): void {
  const layer = nodes.layer;
  const path = nodes.shapePath;
  if (layer.type !== 'shape' || !layer.plot || !path) return;
  const plot = layer.plot;
  const size = layer.size ?? { width: 0, height: 0 };
  const target = plotPoints(rows, plot, size.width, size.height);
  const draw = (points: ReadonlyArray<[number, number]>): void => {
    path.setAttribute('d', plotPathData(points, plot.curve, plot.area === true, size.height));
  };

  let byKey = proxies.get(path);
  if (!byKey) {
    byKey = new Map();
    proxies.set(path, byKey);
  }
  const state = byKey as unknown as Map<string, { points?: Array<[number, number]>; tween?: { kill(): void } }>;
  const prior = state.get('plot');
  prior?.tween?.kill();
  const from = prior?.points;
  const tween = plot.tween;
  if (!animate || !tween || tween.duration <= 0 || !from || from.length !== target.length || target.length === 0) {
    state.set('plot', { points: target });
    draw(target);
    return;
  }
  const live = from.map(([x, y]) => [x, y] as [number, number]);
  const progress = { p: 0 };
  const entry: { points: Array<[number, number]>; tween?: { kill(): void } } = { points: live };
  entry.tween = animator.to(progress, {
    p: 1,
    duration: tween.duration,
    ease: resolveEase(tween.ease as Ease | undefined),
    overwrite: true,
    onUpdate: () => {
      for (let i = 0; i < live.length; i++) {
        live[i]![0] = from[i]![0] + (target[i]![0] - from[i]![0]) * progress.p;
        live[i]![1] = from[i]![1] + (target[i]![1] - from[i]![1]) * progress.p;
      }
      draw(live);
    },
    onComplete: () => {
      entry.points = target;
      delete entry.tween;
      draw(target);
    },
  });
  state.set('plot', entry);
}
