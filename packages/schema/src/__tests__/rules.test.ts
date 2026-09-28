// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Layer rules (CYCLE.md, Wave 6): what a condition reads, how rules combine,
 * and what the validator refuses.
 */

import { describe, expect, it } from 'vitest';

import type { DataSet } from '../data.js';
import { createComposition, createShapeLayer, createTableLayer, createTextLayer } from '../factory.js';
import { conditionHolds, fillTemplate, modesIn, resolveRules, type LayerRule, type RuleContext } from '../rules.js';
import type { Layer } from '../types.js';
import { validateComposition } from '../validate.js';

const ALERTS: DataSet = { id: 'alerts', columns: [{ key: 'event', type: 'string' }], rows: [{ event: 'Heat Warning' }] };
const WX: DataSet = {
  id: 'wx',
  columns: [{ key: 'place', type: 'string' }, { key: 'hi', type: 'number' }, { key: 'icon', type: 'string' }],
  rows: [{ place: 'Phoenix', hi: 108, icon: 'sunny' }, { place: 'Flagstaff', hi: 71, icon: 'snow/day' }],
};

const ctx = (extra: Partial<RuleContext> = {}): RuleContext => ({
  source: (id) => ({ alerts: ALERTS, wx: WX } as Record<string, DataSet>)[id],
  field: (name) => ({ temp: 104, headline: 'Storm' } as Record<string, unknown>)[name],
  mode: 'first-alert',
  ...extra,
});

describe('conditions', () => {
  it('reads the mode, a field, a source row, a row count and a cell row', () => {
    expect(conditionHolds(ctx(), { mode: true, cmp: 'eq', value: 'first-alert' })).toBe(true);
    expect(conditionHolds(ctx(), { binding: 'temp', cmp: 'gt', value: 100 })).toBe(true);
    expect(conditionHolds(ctx(), { source: 'wx', column: 'hi', cmp: 'gte', value: 100 })).toBe(true);
    expect(conditionHolds(ctx(), { source: 'wx', column: 'hi', where: { column: 'place', value: ' FLAGSTAFF ' }, cmp: 'lt', value: 80 })).toBe(true);
    expect(conditionHolds(ctx(), { source: 'alerts', cmp: 'notEmpty' })).toBe(true);
    expect(conditionHolds(ctx(), { source: 'alerts', cmp: 'gt', value: 1 })).toBe(false);
    expect(conditionHolds(ctx({ row: { place: 'Yuma' } }), { column: 'place', cmp: 'eq', value: 'Yuma' })).toBe(true);
  });

  it('counts a source with no data yet as no rows', () => {
    expect(conditionHolds(ctx(), { source: 'nowhere', cmp: 'empty' })).toBe(true);
  });

  it('never calls an absent value greater or less than anything', () => {
    expect(conditionHolds(ctx(), { binding: 'unset', cmp: 'gt', value: 100 })).toBe(false);
    expect(conditionHolds(ctx(), { binding: 'unset', cmp: 'lt', value: 100 })).toBe(false);
    expect(conditionHolds(ctx(), { binding: 'unset', cmp: 'empty' })).toBe(true);
  });

  it('matches `in` against a list or a comma string, ignoring case and spaces', () => {
    expect(conditionHolds(ctx(), { mode: true, cmp: 'in', value: 'storm, First-Alert' })).toBe(true);
    expect(conditionHolds(ctx(), { mode: true, cmp: 'in', value: ['storm', 'election'] })).toBe(false);
  });
});

describe('resolveRules', () => {
  it('is visible and unchanged with no rules', () => {
    expect(resolveRules(undefined, ctx())).toEqual({ hidden: false });
  });

  it('reads "show when" as hidden until a rule holds, "hide when" as shown until one does', () => {
    const showWhen: LayerRule[] = [{ when: [{ mode: true, cmp: 'eq', value: 'storm' }], show: true }];
    expect(resolveRules(showWhen, ctx()).hidden).toBe(true);
    expect(resolveRules(showWhen, ctx({ mode: 'storm' })).hidden).toBe(false);
    const hideWhen: LayerRule[] = [{ when: [{ source: 'alerts', cmp: 'empty' }], show: false }];
    expect(resolveRules(hideWhen, ctx()).hidden).toBe(false);
  });

  it('lets a later rule win, property by property', () => {
    const rules: LayerRule[] = [
      { when: [{ binding: 'temp', cmp: 'gt', value: 90 }], color: '#ffaa00' },
      { when: [{ binding: 'temp', cmp: 'gt', value: 100 }], color: '#ff0000' },
      { when: [{ mode: true, cmp: 'eq', value: 'nope' }], color: '#0000ff' },
    ];
    expect(resolveRules(rules, ctx()).color).toBe('#ff0000');
  });

  it('needs every condition of a rule', () => {
    const rules: LayerRule[] = [{ when: [{ mode: true, cmp: 'eq', value: 'first-alert' }, { binding: 'temp', cmp: 'lt', value: 50 }], color: 'red' }];
    expect(resolveRules(rules, ctx()).color).toBeUndefined();
  });

  it('fills an image source from the cell row, or from the source row the rule names', () => {
    expect(resolveRules([{ when: [{ column: 'icon', cmp: 'notEmpty' }], src: 'icons/{icon}.png' }], ctx({ row: { icon: 'rain' } })).src).toBe('icons/rain.png');
    const fromSource: LayerRule[] = [{ when: [{ source: 'wx', column: 'icon', where: { column: 'place', value: 'Flagstaff' }, cmp: 'notEmpty' }], src: 'icons/{icon}.png' }];
    // A slash in the value cannot climb into another folder.
    expect(resolveRules(fromSource, ctx()).src).toBe('icons/snow-day.png');
  });

  it('lists the modes rules name', () => {
    expect(modesIn([
      { when: [{ mode: true, cmp: 'eq', value: 'first-alert' }], show: true },
      { when: [{ mode: true, cmp: 'in', value: 'storm,election' }], color: 'red' },
      { when: [{ mode: true, cmp: 'ne', value: 'ignored' }], show: false },
    ])).toEqual(['first-alert', 'storm', 'election']);
    expect(fillTemplate('{a}-{b}', { a: 1 })).toBe('1-');
  });
});

describe('rules in the validator', () => {
  const comp = (layers: Layer[]) => createComposition({ id: 'c', name: 'C', duration: 2, layers });

  it('accepts rules of every kind', () => {
    const c = comp([
      createShapeLayer({ id: 'banner', rules: [
        { when: [{ mode: true, cmp: 'eq', value: 'first-alert' }], show: true },
        { when: [{ source: 'alerts', cmp: 'notEmpty' }, { binding: 'x', cmp: 'in', value: ['a', 'b'] }], color: '#c8102e' },
      ] }),
      createTableLayer({ id: 't', data: { columns: [{ key: 'hi', type: 'number' }], rows: [] }, row: { height: 40, cells: [
        createTextLayer({ id: 'hi', cell: 'hi', rules: [{ when: [{ column: 'hi', cmp: 'gt', value: 100 }], color: '#ff7a00' }] }),
      ] } }),
    ]);
    expect(validateComposition(c).errors.filter((e) => e.severity !== 'warning')).toEqual([]);
  });

  it('refuses a column on its own outside a table, and two subjects in one condition', () => {
    const lone = comp([createShapeLayer({ id: 's', rules: [{ when: [{ column: 'hi', cmp: 'gt', value: 1 }], show: true }] })]);
    expect(validateComposition(lone).errors[0]?.message).toMatch(/not in a table/);
    const two = comp([createShapeLayer({ id: 's', rules: [{ when: [{ mode: true, binding: 'x', cmp: 'eq', value: 1 }], show: true }] })]);
    expect(validateComposition(two).valid).toBe(false);
  });

  it('refuses an effect the layer cannot show', () => {
    const c = comp([createShapeLayer({ id: 's', rules: [{ when: [{ mode: true, cmp: 'eq', value: 'x' }], src: 'a.png' }] })]);
    expect(validateComposition(c).errors[0]?.message).toMatch(/src changes an image/);
  });

  it('only warns about a rule with no effect, or a comparison with no value', () => {
    const c = comp([createShapeLayer({ id: 's', rules: [{ when: [{ mode: true, cmp: 'eq' }] }] })]);
    const result = validateComposition(c);
    expect(result.valid).toBe(true);
    expect(result.errors.map((e) => e.severity)).toEqual(['warning', 'warning']);
  });

  it('refuses a mode no server would accept, and matches modes whatever their case', () => {
    const c = comp([createShapeLayer({ id: 's', rules: [{ when: [{ mode: true, cmp: 'eq', value: 'Alert!' }], show: true }] })]);
    expect(validateComposition(c).errors[0]?.message).toMatch(/cannot be a mode/);
    expect(conditionHolds(ctx({ mode: 'First-Alert' }), { mode: true, cmp: 'eq', value: 'first-alert' })).toBe(true);
    expect(conditionHolds(ctx({ mode: 'First-Alert' }), { mode: true, cmp: 'ne', value: 'FIRST-ALERT' })).toBe(false);
    expect(modesIn([
      { when: [{ mode: true, cmp: 'eq', value: 'First Alert' }], show: true },
      { when: [{ mode: true, cmp: 'eq', value: 'first alert' }], show: true },
    ])).toEqual(['First Alert']);
  });

  it('refuses a malformed rule in the schema', () => {
    const bad = comp([createShapeLayer({ id: 's', rules: [{ when: [], show: true }] })]);
    expect(validateComposition(bad).valid).toBe(false);
    const op = comp([createShapeLayer({ id: 's', rules: [{ when: [{ mode: true, cmp: 'like' as never }], show: true }] })]);
    expect(validateComposition(op).valid).toBe(false);
  });
});
