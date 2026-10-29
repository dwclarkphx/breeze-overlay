// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Show attribution (Phase 9 Wave 0). The column survives, blank, so a layer
 * rule `attribution is empty → hide` can take the credit strap off air.
 */

import { describe, expect, it } from 'vitest';

import {
  AIR_QUALITY_PROVIDER_INFO,
  WEATHER_PROVIDER_INFO,
  attributionShown,
  blankAttribution,
  type DataSet,
} from '../data.js';
import { conditionHolds, type RuleContext } from '../rules.js';
import { validateDataSources } from '../validate.js';

const wx: DataSet = {
  id: 'wx',
  columns: [
    { key: 'temp', type: 'number' },
    { key: 'attribution', type: 'string' },
  ],
  rows: [
    { temp: 21, attribution: 'Weather data from MET Norway' },
    { temp: 19, attribution: 'Weather data from MET Norway' },
  ],
};

const ctx = (set: DataSet): RuleContext => ({
  source: (id) => (id === set.id ? set : undefined),
  field: () => undefined,
  mode: '',
});

describe('show attribution', () => {
  it('is on unless explicitly turned off, so older projects keep their credit', () => {
    expect(attributionShown({})).toBe(true);
    expect(attributionShown({ showAttribution: true })).toBe(true);
    expect(attributionShown({ showAttribution: false })).toBe(false);
  });

  it('blanks the column rather than dropping it', () => {
    const out = blankAttribution(wx);
    expect(out.columns).toEqual(wx.columns);
    expect(out.rows.map((r) => r.attribution)).toEqual(['', '']);
    expect(out.rows.map((r) => r.temp)).toEqual([21, 19]);
    // The input is not mutated — it may be last-good.
    expect(wx.rows[0]!.attribution).toBe('Weather data from MET Norway');
  });

  it('leaves rows that no longer carry the column alone', () => {
    const out = blankAttribution({ id: 'x', columns: [], rows: [{ temp: 1 }] });
    expect(out.rows[0]).toEqual({ temp: 1 });
  });

  it('makes the existing empty rule hold, which is what hides the credit strap', () => {
    const rule = { source: 'wx', column: 'attribution', cmp: 'empty' as const };
    expect(conditionHolds(ctx(wx), rule)).toBe(false);
    expect(conditionHolds(ctx(blankAttribution(wx)), rule)).toBe(true);
  });

  it('warns for every licence that obliges a credit, and not for NWS', () => {
    expect(WEATHER_PROVIDER_INFO.nws.creditRequired).toBe(false);
    for (const p of ['open-meteo', 'open-meteo-self', 'met-norway', 'brightsky'] as const) {
      expect(WEATHER_PROVIDER_INFO[p].creditRequired).toBe(true);
    }
    for (const info of Object.values(AIR_QUALITY_PROVIDER_INFO)) expect(info.creditRequired).toBe(true);
  });

  it('is a valid property on weather and air-quality sources', () => {
    const result = validateDataSources({
      formatVersion: 1,
      sources: [
        { id: 'wx', name: 'Wx', type: 'weather', provider: 'met-norway', latitude: 1, longitude: 1, showAttribution: false },
        { id: 'aq', name: 'AQ', type: 'air-quality', provider: 'airnow-feed', area: '111', showAttribution: false },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
