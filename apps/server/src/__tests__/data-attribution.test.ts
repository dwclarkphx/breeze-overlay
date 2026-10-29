// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Show attribution in the loader (Phase 9 Wave 0): the adapter's rows come back
 * with `attribution` blanked when the box is unticked, and untouched when the
 * property is absent — the case every project saved before 0.79.0 is in.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AirQualityDataSource, DataSet, WeatherDataSource } from '@breeze/schema';

const credit = (id: string, text: string): DataSet => ({
  id,
  columns: [
    { key: 'temp', type: 'number' },
    { key: 'attribution', type: 'string' },
  ],
  rows: [{ temp: 20, attribution: text }],
});

vi.mock('../data/weather.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/weather.js')>()),
  loadWeather: vi.fn(async (def: WeatherDataSource) => ({ data: credit(def.id, 'Weather data from MET Norway') })),
}));
vi.mock('../data/airquality.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/airquality.js')>()),
  loadAirQuality: vi.fn(async (def: AirQualityDataSource) => ({ data: credit(def.id, 'AirNow') })),
}));

import { loadDataSource } from '../data/registry.js';

const met: WeatherDataSource = {
  id: 'wx',
  name: 'Weather',
  type: 'weather',
  provider: 'met-norway',
  latitude: 59.9,
  longitude: 10.7,
};

describe('show attribution', () => {
  it('keeps the credit when the property is absent', async () => {
    const { data } = await loadDataSource(met);
    expect(data?.rows[0]?.attribution).toBe('Weather data from MET Norway');
  });

  it('blanks the credit, and keeps the column, when it is off', async () => {
    const { data } = await loadDataSource({ ...met, showAttribution: false });
    expect(data?.rows[0]?.attribution).toBe('');
    expect(data?.columns.map((c) => c.key)).toContain('attribution');
    expect(data?.rows[0]?.temp).toBe(20);
  });

  it('applies to air quality the same way', async () => {
    const aq: AirQualityDataSource = { id: 'aq', name: 'AQ', type: 'air-quality', provider: 'airnow-feed', area: '111' };
    expect((await loadDataSource(aq)).data?.rows[0]?.attribution).toBe('AirNow');
    expect((await loadDataSource({ ...aq, showAttribution: false })).data?.rows[0]?.attribution).toBe('');
  });
});
