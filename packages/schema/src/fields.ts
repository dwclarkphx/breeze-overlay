// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Typed fields (Phase 9 Wave B, PHASE9.md §3).
 *
 * A binding's kind used to come only from the layer that carried it — a text
 * layer was a `string`, an image an `image`. A composition can now say more
 * about a field in `Composition.fields`: that `homeScore` is a **number** with
 * +1/+2/+3 buttons, that `period` is one of four **options**, that `bonus` is
 * an on/off **toggle**, that `teamColor` is a **colour**, that `logo` is an
 * **asset** picked from the bin. The control panel renders the matching
 * control, the bindings JSON Schema describes it (so any OGraf form generator
 * reads it, Wave D), and the runtime shows it:
 *
 *  - a text layer bound to a number shows it formatted — `pad`, `decimals`,
 *    `prefix`, `suffix`;
 *  - bound to an option, it shows the option's label;
 *  - bound to a toggle, `onText` / `offText`;
 *  - a text or shape layer bound to a colour is recoloured rather than
 *    retyped;
 *  - an image bound to an asset takes it as its source, as before.
 *
 * A field may be declared with no layer bound to it at all — a toggle read
 * only by a layer rule (`bonus is true → show`) is the usual case.
 *
 * Free of I/O and Ajv: the panel and the runtime import it from the barrel.
 */

export const FIELD_KINDS = ['number', 'boolean', 'enum', 'color', 'asset'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export interface FieldOption {
  value: string;
  /** What the panel's select shows and a bound text layer reads. Default `value`. */
  label?: string;
}

interface FieldBase {
  /** Panel caption. Default: the bound layer's name, then the field name. */
  label?: string;
}

export interface NumberField extends FieldBase {
  kind: 'number';
  min?: number;
  max?: number;
  /** What −/+ change it by. Default 1. */
  step?: number;
  /** Extra one-tap buttons — `[1, 2, 3]` for basketball scoring. Negative values subtract. */
  buttons?: number[];
  /** Decimal places shown. Default: as typed. */
  decimals?: number;
  /** Zero-pad the whole part to this many digits — `07`. */
  pad?: number;
  prefix?: string;
  suffix?: string;
  default?: number;
}

export interface BooleanField extends FieldBase {
  kind: 'boolean';
  /** What a bound text layer shows when on / off. Default `''` both ways. */
  onText?: string;
  offText?: string;
  default?: boolean;
}

export interface EnumField extends FieldBase {
  kind: 'enum';
  options: FieldOption[];
  default?: string;
}

export interface ColorField extends FieldBase {
  kind: 'color';
  default?: string;
}

export interface AssetField extends FieldBase {
  kind: 'asset';
  /** Which assets the picker offers. Default `image`. */
  assetKind?: 'image' | 'video';
  default?: string;
}

export type FieldSpec = NumberField | BooleanField | EnumField | ColorField | AssetField;

/** `#rgb`, `#rrggbb` or `#rrggbbaa` — what an `<input type="color">` and the panel accept. */
export const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** The value a field starts at when nothing has been sent. */
export function fieldDefault(spec: FieldSpec): unknown {
  switch (spec.kind) {
    case 'number':
      return spec.default ?? (spec.min !== undefined && spec.min > 0 ? spec.min : 0);
    case 'boolean':
      return spec.default ?? false;
    case 'enum':
      return spec.default ?? spec.options[0]?.value ?? '';
    case 'color':
      return spec.default ?? '#ffffff';
    case 'asset':
      return spec.default ?? '';
  }
}

/** A number from whatever arrived — a panel sends numbers, a URL sends strings. Null when it is not one. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A boolean from whatever arrived: `true`, `1`, `on`, `yes` (any case) are on. */
export function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['true', '1', 'on', 'yes'].includes(value.trim().toLowerCase());
  return false;
}

/** Clamp to `min`/`max`. A value that is not a number comes back as the field's default. */
export function clampNumber(spec: NumberField, value: unknown): number {
  const n = toNumber(value) ?? (fieldDefault(spec) as number);
  const lo = spec.min ?? -Infinity;
  const hi = spec.max ?? Infinity;
  return Math.min(hi, Math.max(lo, n));
}

/** `current + delta`, clamped, without the floating-point tail `0.1 + 0.2` leaves. */
export function stepNumber(spec: NumberField, current: unknown, delta: number): number {
  const places = Math.max(decimalsOf(spec.step ?? 1), decimalsOf(delta), decimalsOf(toNumber(current) ?? 0));
  const raw = (toNumber(current) ?? (fieldDefault(spec) as number)) + delta;
  return clampNumber(spec, Number(raw.toFixed(places)));
}

function decimalsOf(n: number): number {
  const s = String(n);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/**
 * The text a bound text layer shows for a typed field. Undefined for a colour,
 * which recolours the layer instead of retyping it.
 */
export function fieldText(spec: FieldSpec, value: unknown): string | undefined {
  switch (spec.kind) {
    case 'number': {
      const n = toNumber(value);
      if (n === null) return value == null ? '' : String(value);
      const fixed = spec.decimals !== undefined ? Math.abs(n).toFixed(spec.decimals) : String(Math.abs(n));
      const [whole = '', frac] = fixed.split('.');
      const padded = spec.pad ? whole.padStart(spec.pad, '0') : whole;
      const body = `${n < 0 ? '-' : ''}${padded}${frac !== undefined ? `.${frac}` : ''}`;
      return `${spec.prefix ?? ''}${body}${spec.suffix ?? ''}`;
    }
    case 'boolean':
      return toBoolean(value) ? (spec.onText ?? '') : (spec.offText ?? '');
    case 'enum': {
      const v = value == null ? '' : String(value);
      const option = spec.options.find((o) => o.value === v);
      return option ? (option.label ?? option.value) : v;
    }
    case 'color':
      return undefined;
    case 'asset':
      return value == null ? '' : String(value);
  }
}

/** A colour value fit to paint with, or null — a bad value must not blank the layer. */
export function fieldColor(value: unknown): string | null {
  return typeof value === 'string' && COLOR_PATTERN.test(value.trim()) ? value.trim() : null;
}

/** Problems with one field declaration, as plain messages. */
export function fieldSpecProblems(spec: FieldSpec): string[] {
  const out: string[] = [];
  if (spec.kind === 'number') {
    if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) out.push('min is greater than max');
    if (spec.step !== undefined && !(spec.step > 0)) out.push('step must be greater than 0');
    if (spec.pad !== undefined && (!Number.isInteger(spec.pad) || spec.pad < 0 || spec.pad > 12)) out.push('pad must be 0–12');
    if (spec.decimals !== undefined && (!Number.isInteger(spec.decimals) || spec.decimals < 0 || spec.decimals > 6)) out.push('decimals must be 0–6');
  }
  if (spec.kind === 'enum') {
    if (spec.options.length === 0) out.push('needs at least one option');
    const seen = new Set<string>();
    for (const o of spec.options) {
      if (seen.has(o.value)) out.push(`duplicate option "${o.value}"`);
      seen.add(o.value);
    }
    if (spec.default !== undefined && !seen.has(spec.default)) out.push(`default "${spec.default}" is not an option`);
  }
  if (spec.kind === 'color' && spec.default !== undefined && !COLOR_PATTERN.test(spec.default)) {
    out.push('default must be a #hex colour');
  }
  return out;
}
