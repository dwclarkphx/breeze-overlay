// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Data-driven graphics (Phase 9 Wave R, CHARTS.md).
 *
 * No chart layer. A bar chart is a table whose bar cell has a `width` drive; a
 * gauge is an ellipse arc whose `sweep` is driven; a line chart is a path
 * plotted from rows. This file is the arithmetic those share — what number a
 * drive reads, how it maps onto a property, the geometry of an arc and of a
 * plotted line — pure, so the runtime, the editor's preview and the tests
 * agree on every pixel.
 */

import { applyTransforms, numericValue, type DataRow, type DataSet, type TransformContext } from './data.js';
import type { DomainEnd, DriveProp, LayerDrive, PlotDomainEnd, ShapeArc, ShapePlot } from './types.js';

/** What a drive's subject and domain can be read against. */
export interface DriveContext {
  /** The cell's own row, for a layer inside a table row template. */
  row?: DataRow;
  /** The rows a column's `min`/`max`/`total` range over: the cell's table, or the named source. */
  rows?: readonly DataRow[];
  /** A source's current rows. */
  source?: (id: string) => DataSet | undefined;
  /** A dynamic field's value. */
  field?: (name: string) => unknown;
  /** A timer's value in seconds. */
  timer?: (id: string) => number | undefined;
}

/** A field's value as a number, if it is one. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return numericValue(value);
  return null;
}

/** The row a `source` subject reads: the first, or the first matching `where`. */
function sourceRow(drive: LayerDrive, ctx: DriveContext): { row: DataRow | undefined; rows: readonly DataRow[] } {
  const set = drive.from.source ? ctx.source?.(drive.from.source) : undefined;
  const rows = set?.rows ?? [];
  const where = drive.from.where;
  const row = where ? rows.find((r) => String(r[where.column] ?? '') === String(where.value ?? '')) : rows[0];
  return { row, rows };
}

/**
 * The number a drive reads, and the row and rows it was read from (which its
 * domain may refer to). Null when there is nothing numeric there — the drive
 * then leaves the property where it is rather than snapping a bar to zero
 * because a feed is between answers.
 */
export function driveInput(drive: LayerDrive, ctx: DriveContext): { value: number | null; row?: DataRow; rows: readonly DataRow[] } {
  const from = drive.from;
  if (from.timer !== undefined) return { value: ctx.timer?.(from.timer) ?? null, rows: [] };
  if (from.binding !== undefined) return { value: asNumber(ctx.field?.(from.binding)), rows: [] };
  if (from.source !== undefined) {
    const { row, rows } = sourceRow(drive, ctx);
    const value = from.column !== undefined && row ? numericValue(row[from.column]) : null;
    return { value, ...(row ? { row } : {}), rows };
  }
  if (from.column !== undefined) {
    return { value: ctx.row ? numericValue(ctx.row[from.column]) : null, ...(ctx.row ? { row: ctx.row } : {}), rows: ctx.rows ?? [] };
  }
  return { value: null, rows: [] };
}

/** One end of a domain, resolved. Null when it cannot be (no rows yet for `max`, a blank `goal`). */
export function resolveDomainEnd(
  end: DomainEnd,
  input: { value: number | null; row?: DataRow; rows: readonly DataRow[] },
  column: string | undefined,
  ctx: DriveContext,
): number | null {
  if (typeof end === 'number') return end;
  if (typeof end === 'object') {
    if ('column' in end) return input.row ? numericValue(input.row[end.column]) : null;
    return asNumber(ctx.field?.(end.binding));
  }
  const values = column ? input.rows.map((r) => numericValue(r[column])).filter((v): v is number => v !== null) : [];
  // A field or a timer has no rows: its range is itself, so `max` means "all of it".
  if (values.length === 0) return input.value;
  if (end === 'min') return Math.min(...values);
  if (end === 'max') return Math.max(...values);
  return values.reduce((a, b) => a + b, 0);
}

/** Map `value` from `[d0, d1]` onto `range`, clamped unless asked not to be. */
export function mapDrive(value: number, d0: number, d1: number, range: readonly [number, number], clamp = true): number {
  const span = d1 - d0;
  const p = span === 0 ? (value >= d1 ? 1 : 0) : (value - d0) / span;
  const q = clamp ? Math.min(1, Math.max(0, p)) : p;
  return range[0] + (range[1] - range[0]) * q;
}

/**
 * The value a drive puts on its property now, or null to leave it alone.
 * Default domain `0 → max`: the leading bar fills the range.
 */
export function driveValue(drive: LayerDrive, ctx: DriveContext): number | null {
  const input = driveInput(drive, ctx);
  if (input.value === null) return null;
  const column = drive.from.column;
  const min = resolveDomainEnd(drive.domain?.min ?? 0, input, column, ctx);
  const max = resolveDomainEnd(drive.domain?.max ?? 'max', input, column, ctx);
  if (min === null || max === null) return null;
  return mapDrive(input.value, min, max, drive.range, drive.clamp !== false);
}

/** Which drive props are transform or opacity props that GSAP sets directly. */
export const DRIVE_GSAP_PROPS: ReadonlySet<DriveProp> = new Set(['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity']);

/** A sensible output range for a new drive on `prop`, given the layer's size. */
export function defaultDriveRange(prop: DriveProp, size: { width: number; height: number } | undefined): [number, number] {
  switch (prop) {
    case 'width': return [0, size?.width || 400];
    case 'height': return [0, size?.height || 200];
    case 'sweep': return [0, 360];
    case 'trim':
    case 'opacity':
    case 'scaleX':
    case 'scaleY':
      return [0, 1];
    case 'rotation': return [0, 180];
    case 'x':
    case 'y':
      return [0, 400];
  }
}

/* -------------------------------------------------------------------- arcs */

const r2 = (n: number): string => String(Math.round(n * 100) / 100);

/** A point on an ellipse at `deg` clockwise from 12 o'clock. */
function onEllipse(cx: number, cy: number, rx: number, ry: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + rx * Math.sin(rad), cy - ry * Math.cos(rad)];
}

/**
 * SVG path data for an ellipse arc in a `width × height` box (CHARTS.md §4.2).
 *
 * With `thickness` the path runs along the middle of the ring and is meant to
 * be **stroked** `thickness` wide — which is what gives a gauge round caps for
 * free and lets `trim` draw it on. Without, it is a closed wedge from the
 * centre, meant to be filled. A sweep of 360 or more is the whole ellipse,
 * drawn as two half arcs (one SVG arc cannot start and end on the same point).
 */
export function arcPath(width: number, height: number, arc: ShapeArc, sweepOverride?: number): { d: string; stroked: boolean } {
  const sweep = Math.max(0, Math.min(360, sweepOverride ?? arc.sweep));
  const start = arc.start ?? 0;
  const ring = arc.thickness !== undefined && arc.thickness > 0;
  const inset = ring ? arc.thickness! / 2 : 0;
  const cx = width / 2;
  const cy = height / 2;
  const rx = Math.max(0, width / 2 - inset);
  const ry = Math.max(0, height / 2 - inset);
  if (sweep <= 0 || rx <= 0 || ry <= 0) return { d: '', stroked: ring };

  const [sx, sy] = onEllipse(cx, cy, rx, ry, start);
  if (sweep >= 360) {
    const [mx, my] = onEllipse(cx, cy, rx, ry, start + 180);
    const d = `M${r2(sx)} ${r2(sy)} A${r2(rx)} ${r2(ry)} 0 1 1 ${r2(mx)} ${r2(my)} A${r2(rx)} ${r2(ry)} 0 1 1 ${r2(sx)} ${r2(sy)}${ring ? '' : ' Z'}`;
    return { d, stroked: ring };
  }
  const [ex, ey] = onEllipse(cx, cy, rx, ry, start + sweep);
  const large = sweep > 180 ? 1 : 0;
  const arcSeg = `A${r2(rx)} ${r2(ry)} 0 ${large} 1 ${r2(ex)} ${r2(ey)}`;
  const d = ring
    ? `M${r2(sx)} ${r2(sy)} ${arcSeg}`
    : `M${r2(cx)} ${r2(cy)} L${r2(sx)} ${r2(sy)} ${arcSeg} Z`;
  return { d, stroked: ring };
}

/* ------------------------------------------------------------------- plots */

/** The rows a plot draws, after its own transforms. */
export function plotRows(data: DataSet | undefined, plot: ShapePlot, ctx: TransformContext = {}): DataRow[] {
  if (!data) return [];
  return applyTransforms(data, plot.transforms ?? [], ctx).rows;
}

function resolvePlotEnd(end: PlotDomainEnd, values: number[]): number {
  if (typeof end === 'number') return end;
  return end === 'min' ? Math.min(...values) : Math.max(...values);
}

/**
 * The points of a plot in a `width × height` box, y down as SVG has it. Rows
 * whose value is not a number are skipped, so a gap in a feed shortens the
 * line rather than dropping it to the floor.
 */
export function plotPoints(rows: readonly DataRow[], plot: ShapePlot, width: number, height: number): Array<[number, number]> {
  const picked = rows
    .map((row, i) => ({ y: numericValue(row[plot.y]), x: plot.x !== undefined ? numericValue(row[plot.x]) : i }))
    .filter((p): p is { x: number; y: number } => p.y !== null && p.x !== null);
  if (picked.length === 0) return [];
  const ys = picked.map((p) => p.y);
  const xs = picked.map((p) => p.x);
  let lo = resolvePlotEnd(plot.domain?.min ?? 'min', ys);
  let hi = resolvePlotEnd(plot.domain?.max ?? 'max', ys);
  const pad = Math.max(0, Math.min(0.5, plot.domain?.pad ?? 0));
  const span = hi - lo;
  lo -= span * pad;
  hi += span * pad;
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  return picked.map((p) => {
    const px = x1 === x0 ? width / 2 : ((p.x - x0) / (x1 - x0)) * width;
    const py = hi === lo ? height / 2 : height - ((p.y - lo) / (hi - lo)) * height;
    return [px, py];
  });
}

/**
 * Monotone cubic tangents (Fritsch–Carlson): a smooth line that never
 * overshoots between two readings, so an hourly temperature line never dips
 * below the lowest temperature it is drawing.
 */
function monotoneTangents(points: ReadonlyArray<[number, number]>): number[] {
  const n = points.length;
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1]![0] - points[i]![0];
    slopes.push(dx === 0 ? 0 : (points[i + 1]![1] - points[i]![1]) / dx);
  }
  const m: number[] = new Array(n).fill(0);
  m[0] = slopes[0] ?? 0;
  m[n - 1] = slopes[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    const a = slopes[i - 1]!;
    const b = slopes[i]!;
    m[i] = a * b <= 0 ? 0 : (a + b) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    const s = slopes[i]!;
    if (s === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / s;
    const b = m[i + 1]! / s;
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * s;
      m[i + 1] = t * b * s;
    }
  }
  return m;
}

/** SVG path data through `points`, closed to the baseline (`height`) when `area`. */
export function plotPathData(points: ReadonlyArray<[number, number]>, curve: ShapePlot['curve'], area: boolean, height: number): string {
  if (points.length === 0) return '';
  const [fx, fy] = points[0]!;
  let d = `M${r2(fx)} ${r2(fy)}`;
  if (points.length === 1) {
    d += ` L${r2(fx)} ${r2(fy)}`;
  } else if (curve === 'monotone') {
    const m = monotoneTangents(points);
    for (let i = 0; i < points.length - 1; i++) {
      const [x0, y0] = points[i]!;
      const [x1, y1] = points[i + 1]!;
      const dx = (x1 - x0) / 3;
      d += ` C${r2(x0 + dx)} ${r2(y0 + m[i]! * dx)} ${r2(x1 - dx)} ${r2(y1 - m[i + 1]! * dx)} ${r2(x1)} ${r2(y1)}`;
    }
  } else {
    for (let i = 1; i < points.length; i++) d += ` L${r2(points[i]![0])} ${r2(points[i]![1])}`;
  }
  if (area) {
    const [lx] = points[points.length - 1]!;
    d += ` L${r2(lx)} ${r2(height)} L${r2(fx)} ${r2(height)} Z`;
  }
  return d;
}

/** A plot's path data from rows, in one call. */
export function plotPath(rows: readonly DataRow[], plot: ShapePlot, width: number, height: number): string {
  return plotPathData(plotPoints(rows, plot, width, height), plot.curve, plot.area === true, height);
}

/** The decimals a number is written with — what a count shows when none is set. */
export function decimalsIn(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return 0;
  const s = String(n);
  const e = s.indexOf('e-');
  if (e !== -1) return Math.min(6, Number(s.slice(e + 2)));
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : Math.min(6, s.length - dot - 1);
}

/** A counted number as text. */
export function formatCount(n: number, decimals: number, prefix = '', suffix = ''): string {
  const fixed = Math.abs(n).toFixed(Math.max(0, Math.min(6, decimals)));
  const sign = n < 0 && Number(fixed) !== 0 ? '-' : '';
  return `${prefix}${sign}${fixed}${suffix}`;
}
