// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The `compose` transform (0.76.0): text from a template over other columns.
 *
 * Clocks fixed, zone named. Phoenix keeps no daylight saving, so -07:00 all year.
 */

import { describe, expect, it } from 'vitest';

import { formatInstant, joinList, parseTemplate, renderTemplate, templateColumns, templateUsesClock } from '../compose.js';
import { applyTransforms, transformsUseClock, type DataSet } from '../data.js';
import { createComposition, createTableLayer } from '../factory.js';
import type { Composition, TableLayer } from '../types.js';
import { validateComposition } from '../validate.js';

const PHX = 'America/Phoenix';
/** 3:40 pm Tuesday 29 September 2026 in Phoenix. */
const NOW = new Date('2026-09-29T22:40:00Z');

const render = (template: string, row: Record<string, unknown>, timezone: string | undefined = PHX): string =>
  renderTemplate(parseTemplate(template), row, { timezone, now: NOW });

describe('parseTemplate', () => {
  it('splits text and fields, with modifiers in order', () => {
    const { parts, problems } = parseTemplate('A {x|drop:, AZ|list} B');
    expect(problems).toEqual([]);
    expect(parts).toEqual(['A ', { column: 'x', modifiers: [{ name: 'drop', arg: ', AZ' }, { name: 'list' }] }, ' B']);
  });

  it('keeps colons inside a time format', () => {
    expect(parseTemplate('{t|time:h:mm A}').parts).toEqual([{ column: 't', modifiers: [{ name: 'time', arg: 'h:mm A' }] }]);
  });

  it('reads doubled braces as literal braces', () => {
    expect(render('{{ {x} }}', { x: 'y' })).toBe('{ y }');
  });

  it('lists problems instead of throwing', () => {
    expect(parseTemplate('{x').problems).toHaveLength(1);
    expect(parseTemplate('x}').problems).toHaveLength(1);
    expect(parseTemplate('{}').problems).toHaveLength(1);
    expect(parseTemplate('{x|shout}').problems[0]).toMatch(/unknown modifier "shout"/);
    expect(parseTemplate('{x|time}').problems[0]).toMatch(/needs text/);
    expect(parseTemplate('{x|list:a}').problems[0]).toMatch(/takes no text/);
  });

  it('names the columns a template reads, and whether it needs the clock', () => {
    expect(templateColumns('{a} {b|list} {a}')).toEqual(['a', 'b']);
    expect(templateUsesClock('{a|when}')).toBe(true);
    expect(templateUsesClock('{a|time:h A}')).toBe(false);
  });
});

describe('renderTemplate', () => {
  it('writes an empty or missing value as nothing, never "null"', () => {
    expect(render('[{a}][{b}][{c}]', { a: null, b: undefined, c: '' })).toBe('[][][]');
  });

  it('joins a semicolon list with commas and "and"', () => {
    expect(joinList([])).toBe('');
    expect(joinList(['Pima'])).toBe('Pima');
    expect(joinList(['Pima', 'Pinal'])).toBe('Pima and Pinal');
    expect(joinList(['Pima', 'Pinal', 'Gila'])).toBe('Pima, Pinal and Gila');
    expect(render('{a|list}', { a: 'Pima; Pinal; Gila' })).toBe('Pima, Pinal and Gila');
  });

  it('drops text, changes case and supplies a default', () => {
    expect(render('{a|drop:, AZ|list}', { a: 'Pima, AZ; Pinal, AZ' })).toBe('Pima and Pinal');
    expect(render('{a|upper} {a|lower}', { a: 'Flood Watch' })).toBe('FLOOD WATCH flood watch');
    expect(render('{a|default:none}|{b|default:none}', { a: '', b: 'x' })).toBe('none|x');
  });

  it('formats an instant with the clock layer tokens, in the zone', () => {
    const ms = Date.parse('2026-09-29T15:35:00-07:00');
    expect(formatInstant(ms, 'h:mm A', PHX)).toBe('3:35 PM');
    expect(formatInstant(ms, 'dddd, MMMM D, YYYY', PHX)).toBe('Tuesday, September 29, 2026');
    expect(formatInstant(ms, 'ddd HH:mm', PHX)).toBe('Tue 15:35');
    // The same instant is already tomorrow in Tokyo.
    expect(formatInstant(ms, 'ddd', 'Asia/Tokyo')).toBe('Wed');
    expect(formatInstant(Date.parse('2026-09-29T00:05:00-07:00'), 'h:mm a', PHX)).toBe('12:05 am');
  });

  it('shows a time alone today, the weekday within the week, the date beyond', () => {
    expect(render('{t|when}', { t: '2026-09-29T15:35:00-07:00' })).toBe('3:35 PM');
    expect(render('{t|when}', { t: '2026-09-30T03:15:00-07:00' })).toBe('Wed 3:15 AM');
    expect(render('{t|when}', { t: '2026-10-05T03:15:00-07:00' })).toBe('Mon 3:15 AM');
    expect(render('{t|when}', { t: '2026-10-06T03:15:00-07:00' })).toBe('Oct 6 3:15 AM');
    expect(render('{t|when}', { t: '2026-09-28T20:00:00-07:00' })).toBe('Sep 28 8:00 PM');
    expect(render('[{t|when}]', { t: '' })).toBe('[]');
    expect(render('[{t|when}]', { t: 'soon' })).toBe('[]');
  });

  it('judges "today" in the transform zone, not the machine zone', () => {
    // 3:40 pm Phoenix is already the 30th in Auckland.
    expect(render('{t|when}', { t: '2026-09-30T03:15:00-07:00' }, 'Pacific/Auckland')).toBe('11:15 PM');
  });
});

describe('the compose transform', () => {
  const data: DataSet = {
    columns: [{ key: 'event', type: 'string' }, { key: 'areas', type: 'string' }],
    rows: [{ event: 'Flood Watch', areas: 'Pima; Pinal' }, { event: 'Heat Warning', areas: 'Gila' }],
  };

  it('adds a string column and leaves the others alone', () => {
    const out = applyTransforms(data, [{ op: 'compose', as: 'line', template: '{event}: {areas|list}' }], { now: NOW });
    expect(out.rows.map((r) => r['line'])).toEqual(['Flood Watch: Pima and Pinal', 'Heat Warning: Gila']);
    expect(out.columns.map((c) => c.key)).toEqual(['event', 'areas', 'line']);
    expect(out.rows[0]!['event']).toBe('Flood Watch');
    expect(data.rows[0]).not.toHaveProperty('line');
  });

  it('replaces a column of the same name without declaring it twice', () => {
    const out = applyTransforms(data, [{ op: 'compose', as: 'event', template: '{event}!' }], { now: NOW });
    expect(out.rows[0]!['event']).toBe('Flood Watch!');
    expect(out.columns.filter((c) => c.key === 'event')).toHaveLength(1);
  });

  it('follows a sort and reaches later steps', () => {
    const out = applyTransforms(
      data,
      [{ op: 'compose', as: 'line', template: '{event}' }, { op: 'filter', key: 'line', cmp: 'contains', value: 'Heat' }],
      { now: NOW },
    );
    expect(out.rows).toHaveLength(1);
  });

  it('needs the clock only when the template does', () => {
    expect(transformsUseClock([{ op: 'compose', as: 'x', template: '{t|when}' }])).toBe(true);
    expect(transformsUseClock([{ op: 'compose', as: 'x', template: '{t}' }])).toBe(false);
  });
});

describe('validating compose', () => {
  const comp = (transform: object): Composition => {
    const c = createComposition({ id: 'c' });
    const table: TableLayer = createTableLayer({ id: 't' });
    (table as { transforms?: unknown }).transforms = [transform];
    c.layers.push(table);
    return c;
  };

  it('accepts a sound step', () => {
    const r = validateComposition(comp({ op: 'compose', as: 'line', template: '{a|list} {b|when}', timezone: PHX }));
    expect(r.errors.filter((e) => /transforms/.test(e.path))).toEqual([]);
  });

  it('refuses a bad zone and reports template problems', () => {
    const zone = validateComposition(comp({ op: 'compose', as: 'l', template: '{a}', timezone: 'Mars/Base' }));
    expect(zone.errors.some((e) => /unknown time zone/.test(e.message))).toBe(true);
    const bad = validateComposition(comp({ op: 'compose', as: 'l', template: '{a|shout}' }));
    expect(bad.errors.some((e) => /unknown modifier/.test(e.message))).toBe(true);
  });

  it('requires as and template', () => {
    expect(validateComposition(comp({ op: 'compose', as: 'l' })).valid).toBe(false);
    expect(validateComposition(comp({ op: 'compose', template: '{a}' })).valid).toBe(false);
  });
});
