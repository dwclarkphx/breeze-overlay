// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Layers that react to data (CYCLE.md, Wave 6).
 *
 * A layer carries `rules`: each tests conditions against the data the graphic
 * has — a table cell's own row, a source's first row or row count, a dynamic
 * field, or the channel's **mode** — and while they hold it shows or hides the
 * layer, recolours it, or swaps its image. The red First Alert banner, the
 * temperature that turns orange over 100, the weather icon picked by the
 * forecast: none of them needs a second graphic, only a rule.
 *
 * Pure, so the runtime, the editor's preview and the tests share one reading.
 */

import { matchesFilter, type DataRow, type DataSet, type DataValue, FILTER_OPS } from './data.js';

/**
 * Reserved `update()` key carrying the channel's mode, like `$data` carries
 * DataSets: it rides the one rebind path, and the hub's retained data replays
 * it to a browser source that reconnects mid-show.
 */
export const MODE_UPDATE_KEY = '$mode';

/** Comparisons a condition can make: the table filter's, plus `in` a list. */
export const RULE_OPS = [...FILTER_OPS, 'in'] as const;
export type RuleOp = (typeof RULE_OPS)[number];

/**
 * One test. Exactly one subject:
 *
 * - `column` alone — the value in a table cell's own row (only meaningful on
 *   a layer inside a row template);
 * - `source` + `column` — that source's first row, or with `where` the first
 *   row whose `where.column` equals `where.value`;
 * - `source` alone — how many rows the source has (none loaded yet is 0);
 * - `binding` — a dynamic field, as `update` sets it;
 * - `mode: true` — the channel's mode ('' when none is set).
 */
export interface RuleCondition {
  column?: string;
  source?: string;
  where?: { column: string; value: DataValue };
  binding?: string;
  mode?: true;
  cmp: RuleOp;
  /** What to compare with. A list — or a comma-separated string — for `in`. */
  value?: DataValue | DataValue[];
}

/**
 * While every condition in `when` holds: show or hide the layer, recolour it
 * (a text layer's colour, a shape's fill), or change an image's source.
 *
 * Rules apply in order and a later one wins, property by property. A layer
 * that has any `show: true` rule is hidden unless one holds — "show when" —
 * and otherwise shown unless a `show: false` one holds — "hide when".
 */
export interface LayerRule {
  when: RuleCondition[];
  show?: boolean;
  color?: string;
  /**
   * Image source. `{column}` is filled from the row the rule reads — a cell's
   * row, or the first `source` row its conditions name — so
   * `icons/{icon}.png` picks the icon per forecast.
   */
  src?: string;
}

/** What a rule reads from the page. */
export interface RuleContext {
  /** A table cell's row; absent for any other layer. */
  row?: DataRow;
  source: (id: string) => DataSet | undefined;
  field: (name: string) => unknown;
  mode: string;
}

/** The outcome for one layer: whether rules hide it, and any recolour or new source. */
export interface RuleResult {
  hidden: boolean;
  color?: string;
  src?: string;
}

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();

function asValue(v: unknown): DataValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return null;
}

/** The row a `source` condition reads: `where`'s match, or the first. */
function sourceRow(ctx: RuleContext, c: RuleCondition): DataRow | undefined {
  const set = c.source !== undefined ? ctx.source(c.source) : undefined;
  if (!set) return undefined;
  if (!c.where) return set.rows[0];
  const wanted = norm(c.where.value);
  return set.rows.find((r) => norm(r[c.where!.column]) === wanted);
}

function subject(ctx: RuleContext, c: RuleCondition): DataValue {
  if (c.mode) return ctx.mode;
  if (c.binding !== undefined) return asValue(ctx.field(c.binding));
  if (c.source !== undefined && c.column === undefined) return ctx.source(c.source)?.rows.length ?? 0;
  if (c.source !== undefined) return sourceRow(ctx, c)?.[c.column!] ?? null;
  if (c.column !== undefined) return ctx.row?.[c.column] ?? null;
  return null;
}

export function conditionHolds(ctx: RuleContext, c: RuleCondition): boolean {
  const value = subject(ctx, c);
  // A mode is a name an operator types: `First-Alert` and `first-alert` are one mode.
  if (c.mode && (c.cmp === 'eq' || c.cmp === 'ne')) {
    const same = norm(value) === norm(Array.isArray(c.value) ? c.value[0] : c.value);
    return c.cmp === 'eq' ? same : !same;
  }
  if (c.cmp === 'in') {
    const list = Array.isArray(c.value) ? c.value : String(c.value ?? '').split(',');
    const v = norm(value);
    return list.some((item) => norm(item) === v);
  }
  // A row count of 0 is "empty" — `empty` / `notEmpty` on a source mean no rows / some rows.
  if (c.source !== undefined && c.column === undefined && (c.cmp === 'empty' || c.cmp === 'notEmpty')) {
    return c.cmp === 'empty' ? value === 0 : value !== 0;
  }
  return matchesFilter(value, c.cmp, Array.isArray(c.value) ? c.value[0] : c.value);
}

/** Fill `{column}` placeholders from a row. A `/` in a value cannot climb out of a folder. */
export function fillTemplate(template: string, row: DataRow | undefined): string {
  return template.replace(/\{([^{}]+)\}/g, (_, key: string) => {
    const v = row?.[key.trim()];
    return v === null || v === undefined ? '' : String(v).replace(/[/\\]/g, '-');
  });
}

/** Evaluate a layer's rules. No rules, or none holding, is `{ hidden: false }`. */
export function resolveRules(rules: readonly LayerRule[] | undefined, ctx: RuleContext): RuleResult {
  if (!rules?.length) return { hidden: false };
  let show = !rules.some((r) => r.show === true);
  let color: string | undefined;
  let src: string | undefined;
  for (const rule of rules) {
    if (!rule.when.every((c) => conditionHolds(ctx, c))) continue;
    if (rule.show !== undefined) show = rule.show;
    if (rule.color !== undefined) color = rule.color;
    if (rule.src !== undefined) {
      const named = rule.when.find((c) => c.source !== undefined && c.column !== undefined);
      src = fillTemplate(rule.src, ctx.row ?? (named ? sourceRow(ctx, named) : undefined));
    }
  }
  return { hidden: !show, ...(color !== undefined ? { color } : {}), ...(src !== undefined ? { src } : {}) };
}

/**
 * What a mode name may be: letters, digits, spaces, `.`, `-`, `_`, up to 48 —
 * a word on a button. The server refuses anything else, so a rule naming
 * something else is refused too rather than producing a button that fails.
 */
export const MODE_PATTERN = /^[\p{L}\p{N} ._-]{1,48}$/u;

/** Every mode a set of rules names — what a control surface offers as buttons. Case-insensitively distinct. */
export function modesIn(rules: readonly LayerRule[] | undefined): string[] {
  const out = new Map<string, string>();
  for (const rule of rules ?? []) {
    for (const c of rule.when) {
      if (!c.mode) continue;
      const values = Array.isArray(c.value) ? c.value : c.cmp === 'in' ? String(c.value ?? '').split(',') : [c.value];
      for (const v of values) {
        const name = String(v ?? '').trim();
        if (name && (c.cmp === 'eq' || c.cmp === 'in') && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), name);
      }
    }
  }
  return [...out.values()];
}
