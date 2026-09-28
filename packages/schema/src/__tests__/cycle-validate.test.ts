// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * `TableLayer.cycle` in the schema — both directions, for the reason the sprite
 * suite gives: a validator only ever asserted to reject is a suite that cannot
 * fail, because a fixture with an unrelated fault rejects too.
 */

import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION, type Composition, type TableCycle } from '../types.js';

import { createTableLayer } from '../factory.js';
import { validateComposition } from '../validate.js';

function comp(cycle?: unknown): Composition {
  const layer = createTableLayer({
    id: 't1',
    rowsPerPage: 4,
    ...(cycle !== undefined ? { cycle: cycle as TableCycle } : {}),
  });
  return {
    formatVersion: FORMAT_VERSION,
    id: 'c1',
    name: 'C',
    stage: { width: 1920, height: 1080, fps: 30, background: 'transparent' },
    duration: 5,
    layers: [layer],
  } as Composition;
}

describe('table cycle schema', () => {
  it('accepts a table with no cycle, as every table before it had', () => {
    expect(validateComposition(comp()).valid).toBe(true);
  });

  it('accepts a full cycle', () => {
    const cycle: TableCycle = {
      dwell: 8,
      durationColumn: 'DURATION_MS',
      durationUnit: 'ms',
      end: 'continue',
      group: 'conf',
      keyColumn: 'group',
    };
    expect(validateComposition(comp(cycle)).valid).toBe(true);
  });

  it('accepts a zero dwell — cycling switched off without losing the settings', () => {
    expect(validateComposition(comp({ dwell: 0, end: 'hold' })).valid).toBe(true);
  });

  it('refuses a cycle with no dwell', () => {
    expect(validateComposition(comp({ end: 'loop' })).valid).toBe(false);
  });

  it('refuses a negative dwell', () => {
    expect(validateComposition(comp({ dwell: -1 })).valid).toBe(false);
  });

  it('refuses an unknown end — it cannot be honoured, and the failure is silent on air', () => {
    expect(validateComposition(comp({ dwell: 5, end: 'bounce' })).valid).toBe(false);
  });

  it('refuses an unknown duration unit', () => {
    expect(validateComposition(comp({ dwell: 5, durationUnit: 'minutes' })).valid).toBe(false);
  });

  it('refuses unknown keys, as the rest of the table does', () => {
    expect(validateComposition(comp({ dwell: 5, speed: 2 })).valid).toBe(false);
  });

  it('survives the factory — the layer keeps its cycle', () => {
    expect(comp({ dwell: 5 }).layers[0]).toMatchObject({ cycle: { dwell: 5 } });
  });
});
