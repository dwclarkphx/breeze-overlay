// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Wave 5 in the schema (CYCLE.md): the guard a fetch must pass, and backups.
 * The registry applies both; these are the rules it applies.
 */

import { describe, expect, it } from 'vitest';

import { applyGuard, type DataSet, type DataSourceDef } from '../data.js';
import { FORMAT_VERSION } from '../types.js';
import { validateDataSources } from '../validate.js';

const OBS: DataSet = {
  id: 'obs',
  columns: [
    { key: 'place', type: 'string' },
    { key: 'temp', type: 'number' },
  ],
  rows: [
    { place: 'Phoenix', temp: 104 },
    { place: 'Tucson', temp: 99 },
    { place: 'Flagstaff', temp: 71 },
    { place: 'Yuma', temp: 108 },
  ],
};

describe('applyGuard', () => {
  it('passes everything through with no guard', () => {
    expect(applyGuard(undefined, OBS)).toEqual({ ok: true, data: OBS, dropped: 0 });
  });

  it('refuses too few rows', () => {
    const result = applyGuard({ minRows: 5 }, OBS);
    expect(result).toMatchObject({ ok: false, kind: 'min' });
    expect(!result.ok && result.reason).toMatch(/4 rows, fewer than the minimum of 5/);
  });

  it('refuses a row with a required column empty — blank strings count as empty', () => {
    const data = { ...OBS, rows: [...OBS.rows, { place: '  ', temp: 90 }] };
    const result = applyGuard({ required: ['place'] }, data);
    expect(result).toMatchObject({ ok: false, kind: 'rows' });
    expect(!result.ok && result.reason).toBe('row 5: "place" is empty');
  });

  it('refuses a value out of range, and one that is not a number', () => {
    const hot = { ...OBS, rows: [...OBS.rows, { place: 'Oops', temp: 212 }] };
    expect(applyGuard({ ranges: [{ column: 'temp', max: 130 }] }, hot)).toMatchObject({
      ok: false,
      reason: 'row 5: "temp" is 212, above the maximum of 130',
    });
    const junk = { ...OBS, rows: [{ place: 'Oops', temp: 'n/a' as unknown as number }] };
    expect(applyGuard({ ranges: [{ column: 'temp', min: -40 }] }, junk)).toMatchObject({
      ok: false,
      reason: 'row 1: "temp" is "n/a", not a number',
    });
  });

  it('reads numeric strings, and leaves empty cells to `required`', () => {
    const data = { ...OBS, rows: [{ place: 'A', temp: '101' as unknown as number }, { place: 'B', temp: null }] };
    expect(applyGuard({ ranges: [{ column: 'temp', min: 0, max: 130 }] }, data)).toMatchObject({ ok: true, dropped: 0 });
  });

  it('drops bad rows instead when told to, then checks the count that is left', () => {
    const data = { ...OBS, rows: [...OBS.rows, { place: 'Oops', temp: 212 }] };
    const result = applyGuard({ ranges: [{ column: 'temp', max: 130 }], badRows: 'drop' }, data);
    expect(result).toMatchObject({ ok: true, dropped: 1 });
    expect(result.ok && result.data.rows).toHaveLength(4);

    const tooFew = applyGuard({ ranges: [{ column: 'temp', max: 100 }], badRows: 'drop', minRows: 3 }, data);
    expect(!tooFew.ok && tooFew.reason).toMatch(/2 rows after dropping 3, fewer than the minimum of 3/);
  });

  it('refuses a sudden drop against last-good, and carries what would have aired', () => {
    const halved = { ...OBS, rows: OBS.rows.slice(0, 1) };
    const result = applyGuard({ maxDropPercent: 50 }, halved, OBS);
    expect(result).toMatchObject({ ok: false, kind: 'drop', reason: 'rows fell from 4 to 1 (75%), more than the 50% allowed' });
    expect(result.ok === false && result.kind === 'drop' && result.data.rows).toHaveLength(1);
    // Within the limit, or with nothing to compare against, it passes.
    expect(applyGuard({ maxDropPercent: 50 }, { ...OBS, rows: OBS.rows.slice(0, 2) }, OBS).ok).toBe(true);
    expect(applyGuard({ maxDropPercent: 50 }, halved).ok).toBe(true);
  });

  it('leaves the input alone', () => {
    const data = { ...OBS, rows: [...OBS.rows, { place: 'Oops', temp: 212 }] };
    applyGuard({ ranges: [{ column: 'temp', max: 130 }], badRows: 'drop' }, data);
    expect(data.rows).toHaveLength(5);
  });
});

const doc = (...sources: unknown[]) => ({ formatVersion: FORMAT_VERSION, sources });
const primary = (extra: Record<string, unknown> = {}) => ({
  id: 'obs', name: 'Obs', type: 'http-json', url: 'https://example.com/obs.json', ...extra,
});
const canned: DataSourceDef = {
  id: 'canned', name: 'Unavailable', type: 'manual',
  columns: [{ key: 'place', type: 'string' }], rows: [{ place: 'Temporarily unavailable' }],
};

describe('guard and backup in the validator', () => {
  it('accepts a full guard and a backup, both ways round in the file', () => {
    const guarded = primary({
      guard: {
        minRows: 3, maxDropPercent: 50, required: ['place'], badRows: 'drop', maxUnchanged: 3600,
        ranges: [{ column: 'temp', min: -40, max: 130 }],
      },
      fallback: 'canned',
      fallbackOn: 'failing',
    });
    expect(validateDataSources(doc(guarded, canned)).valid).toBe(true);
    expect(validateDataSources(doc(canned, guarded)).valid).toBe(true);
  });

  it('refuses a guard on a manual source — its rows are typed, not fetched', () => {
    expect(validateDataSources(doc({ ...canned, guard: { minRows: 1 } })).valid).toBe(false);
  });

  it('refuses bad guard values', () => {
    for (const guard of [{ minRows: 0 }, { maxDropPercent: 100 }, { maxUnchanged: 5 }, { required: [] }, { badRows: 'skip' }, { speed: 1 }]) {
      expect(validateDataSources(doc(primary({ guard }))).valid, JSON.stringify(guard)).toBe(false);
    }
  });

  it('refuses a range whose minimum is above its maximum', () => {
    const result = validateDataSources(doc(primary({ guard: { ranges: [{ column: 'temp', min: 10, max: 0 }] } })));
    expect(result.errors[0]?.message).toMatch(/every row would fail/);
  });

  it('refuses a missing backup, itself, and a loop', () => {
    expect(validateDataSources(doc(primary({ fallback: 'nope' }))).errors[0]?.message).toMatch(/no data source "nope"/);
    expect(validateDataSources(doc(primary({ fallback: 'obs' }))).errors[0]?.message).toMatch(/its own backup/);
    const a = primary({ fallback: 'b' });
    const b = { ...primary({ fallback: 'obs' }), id: 'b' };
    expect(validateDataSources(doc(a, b)).errors[0]?.message).toMatch(/loop back to "obs"/);
  });

  it('accepts a chain of backups', () => {
    const a = primary({ fallback: 'b' });
    const b = { ...primary({ fallback: 'canned' }), id: 'b' };
    expect(validateDataSources(doc(a, b, canned)).valid).toBe(true);
  });

  it('refuses fallbackOn with no backup to take over', () => {
    expect(validateDataSources(doc(primary({ fallbackOn: 'failing' }))).valid).toBe(false);
  });
});
