// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/** Typed fields (Phase 9 Wave B). */

import { describe, expect, it } from 'vitest';

import { bindingsJsonSchema, collectBindings } from '../bindings.js';
import { createComposition, createTextLayer } from '../factory.js';
import { clampNumber, fieldText, stepNumber, toBoolean, type FieldSpec, type NumberField } from '../fields.js';
import type { Composition } from '../types.js';
import { validateComposition } from '../validate.js';

const score: NumberField = { kind: 'number', min: 0, max: 199, buttons: [1, 2, 3] };

function scorebug(fields: Record<string, FieldSpec>): Composition {
  return {
    ...createComposition({
      id: 'bug',
      name: 'Scorebug',
      duration: 1,
      layers: [
        { ...createTextLayer({ id: 'home', text: '0' }), binding: 'homeScore' },
        { ...createTextLayer({ id: 'per', text: '1st' }), binding: 'period' },
      ],
    }),
    fields,
  };
}

describe('numbers', () => {
  it('steps and clamps without floating-point tails', () => {
    expect(stepNumber(score, 98, 3)).toBe(101);
    expect(stepNumber(score, 1, -3)).toBe(0);
    expect(stepNumber({ kind: 'number', step: 0.1 }, 0.2, 0.1)).toBe(0.3);
    expect(clampNumber(score, 'abc')).toBe(0);
    expect(clampNumber(score, '250')).toBe(199);
  });

  it('formats for a text layer', () => {
    expect(fieldText({ kind: 'number', pad: 2 }, 7)).toBe('07');
    expect(fieldText({ kind: 'number', decimals: 1, suffix: '°' }, 72)).toBe('72.0°');
    expect(fieldText({ kind: 'number', prefix: '+' }, '3')).toBe('+3');
    expect(fieldText({ kind: 'number', pad: 2 }, -3)).toBe('-03');
  });
});

describe('the other kinds', () => {
  it('shows an option by its label and a toggle by its words', () => {
    const period: FieldSpec = { kind: 'enum', options: [{ value: '1', label: '1st' }, { value: 'OT' }] };
    expect(fieldText(period, '1')).toBe('1st');
    expect(fieldText(period, 'OT')).toBe('OT');
    expect(fieldText({ kind: 'boolean', onText: 'BONUS' }, true)).toBe('BONUS');
    expect(fieldText({ kind: 'boolean', onText: 'BONUS' }, 'off')).toBe('');
    expect(fieldText({ kind: 'color' }, '#ff0000')).toBeUndefined();
    expect(toBoolean('Yes')).toBe(true);
  });
});

describe('collectBindings', () => {
  it('retypes a bound field and adds one nothing binds to', () => {
    const comp = scorebug({
      homeScore: score,
      period: { kind: 'enum', options: [{ value: '1st' }, { value: '2nd' }] },
      bonus: { kind: 'boolean', label: 'Bonus' },
    });
    const bindings = collectBindings(comp);
    const home = bindings.find((b) => b.name === 'homeScore')!;
    expect(home.kind).toBe('number');
    expect(home.defaultValue).toBe(0);
    expect(bindings.find((b) => b.name === 'period')!.defaultValue).toBe('1st');
    const bonus = bindings.find((b) => b.name === 'bonus')!;
    expect(bonus).toMatchObject({ kind: 'boolean', layerIds: [], label: 'Bonus', defaultValue: false });
  });

  it('describes each kind in the bindings JSON Schema', () => {
    const comp = scorebug({ homeScore: score, period: { kind: 'enum', options: [{ value: '1st', label: 'First' }] } });
    const props = bindingsJsonSchema(comp)['properties'] as Record<string, Record<string, unknown>>;
    expect(props['homeScore']).toMatchObject({ type: 'number', minimum: 0, maximum: 199, 'x-breeze-buttons': [1, 2, 3] });
    expect(props['period']).toMatchObject({ type: 'string', enum: ['1st'], oneOf: [{ const: '1st', title: 'First' }] });
  });
});

describe('validation', () => {
  it('accepts declared fields and refuses impossible ones', () => {
    expect(validateComposition(scorebug({ homeScore: score })).valid).toBe(true);
    const bad = validateComposition(scorebug({ homeScore: { kind: 'number', min: 5, max: 1 } }));
    expect(bad.valid).toBe(false);
    expect(bad.errors.map((e) => e.path)).toContain('/fields/homeScore');
    expect(validateComposition(scorebug({ x: { kind: 'enum', options: [] } as FieldSpec })).valid).toBe(false);
    expect(validateComposition(scorebug({ x: { kind: 'slider' } as unknown as FieldSpec })).valid).toBe(false);
  });
});
