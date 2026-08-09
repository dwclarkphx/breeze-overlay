// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Weather adapter.
 *
 * Tested against captured payload *shapes* rather than live origins, and the
 * assertions are mostly about normalization: the point of this adapter is that
 * a graphic bound to `temp` and `icon` does not care which provider filled
 * them, so the tests that matter are the ones that would fail if a provider
 * quietly changed the columns it contributes.
 *
 * The unit-conversion cases are here because they are the failures that do not
 * look like failures — a wrong-but-plausible temperature goes to air.
 */

import { describe, expect, it } from 'vitest';

import {
  WEATHER_COLUMNS,
  WEATHER_PROVIDER_INFO,
  pollFloor,
  type WeatherDataSource,
} from '@breeze/schema';

import {
  attributionFor,
  bearingToCompass,
  isVariableError,
  nwsToDataSet,
  nwsToIcon,
  openMeteoToDataSet,
  openMeteoUrl,
  parseNwsWind,
  wmoToIcon,
} from '../data/weather.js';
import { effectiveInterval } from '../data/sources.js';

const base: WeatherDataSource = {
  id: 'wx',
  name: 'Weather',
  type: 'weather',
  provider: 'open-meteo',
  latitude: 33.44838,
  longitude: -112.074043,
  units: 'imperial',
  mode: 'current',
};

describe('unit helpers', () => {
  it('maps a bearing to a compass point', () => {
    expect(bearingToCompass(0)).toBe('N');
    expect(bearingToCompass(90)).toBe('E');
    expect(bearingToCompass(180)).toBe('S');
    expect(bearingToCompass(270)).toBe('W');
    // Wraps rather than falling off the end of the table.
    expect(bearingToCompass(360)).toBe('N');
    expect(bearingToCompass(350)).toBe('N');
    expect(bearingToCompass(-45)).toBe('NW');
    expect(bearingToCompass(null)).toBeNull();
  });

  it('takes the upper bound of an NWS wind range', () => {
    expect(parseNwsWind('10 to 15 mph')).toBe(15);
    expect(parseNwsWind('15 mph')).toBe(15);
    expect(parseNwsWind('5 to 10 mph')).toBe(10);
    expect(parseNwsWind('Calm')).toBeNull();
    expect(parseNwsWind(null)).toBeNull();
  });
});

describe('icon vocabulary', () => {
  it('maps WMO codes onto the canonical set', () => {
    expect(wmoToIcon(0)).toBe('clear');
    expect(wmoToIcon(3)).toBe('overcast');
    expect(wmoToIcon(65)).toBe('rain');
    expect(wmoToIcon(95)).toBe('thunderstorm');
    // An unknown code must not throw or leak the number into the graphic.
    expect(wmoToIcon(4242)).toBe('unknown');
    expect(wmoToIcon(null)).toBe('unknown');
  });

  it('prefers the NWS icon-URL token over the prose forecast', () => {
    // The token says thunderstorm; the prose says "Chance Showers". The token
    // wins because it is the machine-readable half.
    expect(
      nwsToIcon('https://api.weather.gov/icons/land/day/tsra_hi,40?size=medium', 'Chance Showers'),
    ).toBe('thunderstorm');
    expect(nwsToIcon('https://api.weather.gov/icons/land/night/skc?size=medium', null)).toBe('clear');
    expect(nwsToIcon('https://api.weather.gov/icons/land/day/bkn?size=medium', null)).toBe(
      'partly-cloudy',
    );
  });

  it('falls back to prose when there is no usable token', () => {
    expect(nwsToIcon(null, 'Patchy Fog')).toBe('fog');
    expect(nwsToIcon(null, 'Slight Chance Rain Showers')).toBe('showers');
    expect(nwsToIcon(null, 'Sunny')).toBe('clear');
    expect(nwsToIcon(null, null)).toBe('unknown');
  });
});

describe('open-meteo url', () => {
  it('truncates coordinates to four decimals', () => {
    const url = new URL(openMeteoUrl(base));
    expect(url.searchParams.get('latitude')).toBe('33.4484');
    expect(url.searchParams.get('longitude')).toBe('-112.0740');
  });

  it('asks the origin for imperial units rather than converting', () => {
    const url = new URL(openMeteoUrl(base));
    expect(url.searchParams.get('temperature_unit')).toBe('fahrenheit');
    expect(url.searchParams.get('wind_speed_unit')).toBe('mph');
    expect(url.searchParams.get('precipitation_unit')).toBe('inch');
  });

  it('omits unit params entirely for metric — they are the origin default', () => {
    const url = new URL(openMeteoUrl({ ...base, units: 'metric' }));
    expect(url.searchParams.get('temperature_unit')).toBeNull();
  });

  it('points at the self-hosted origin and strips its trailing slash', () => {
    const url = openMeteoUrl({
      ...base,
      provider: 'open-meteo-self',
      baseUrl: 'http://localhost:8282/',
    });
    expect(url.startsWith('http://localhost:8282/v1/forecast?')).toBe(true);
  });

  it('refuses a self-hosted def with no baseUrl rather than silently using the hosted API', () => {
    // The failure this guards against is the expensive one: falling back to
    // api.open-meteo.com would put a commercial station on the non-commercial
    // tier without anyone being told.
    expect(() => openMeteoUrl({ ...base, provider: 'open-meteo-self' })).toThrow(/baseUrl/);
  });

  it('requests the right block per mode', () => {
    expect(new URL(openMeteoUrl(base)).searchParams.get('current')).toContain('temperature_2m');
    const hourly = new URL(openMeteoUrl({ ...base, mode: 'hourly', count: 12 }));
    expect(hourly.searchParams.get('forecast_hours')).toBe('12');
    const daily = new URL(openMeteoUrl({ ...base, mode: 'daily', count: 5 }));
    expect(daily.searchParams.get('forecast_days')).toBe('5');
  });

  it('clamps daily requests to the 16 days the model produces', () => {
    const url = new URL(openMeteoUrl({ ...base, mode: 'daily', count: 90 }));
    expect(url.searchParams.get('forecast_days')).toBe('16');
  });

  it('defaults the timezone to auto and honours an explicit one', () => {
    expect(new URL(openMeteoUrl(base)).searchParams.get('timezone')).toBe('auto');
    expect(new URL(openMeteoUrl({ ...base, timezone: 'MST' })).searchParams.get('timezone')).toBe(
      'MST',
    );
    // Whitespace-only is not a time zone; fall back rather than send a blank.
    expect(new URL(openMeteoUrl({ ...base, timezone: '  ' })).searchParams.get('timezone')).toBe(
      'auto',
    );
  });

  it('pins the model when one is named, and omits the param when not', () => {
    /*
     * The case this exists for: a self-hosted instance only holds the models its
     * operator has synced, so the `best_match` default can ask the box for data
     * it does not have. Confirmed against a real instance answering
     * `?models=ncep_gfs_seamless`.
     */
    const pinned = new URL(
      openMeteoUrl({
        ...base,
        provider: 'open-meteo-self',
        baseUrl: 'http://localhost:8282',
        models: 'ncep_gfs_seamless',
      }),
    );
    expect(pinned.searchParams.get('models')).toBe('ncep_gfs_seamless');
    expect(new URL(openMeteoUrl(base)).searchParams.get('models')).toBeNull();
  });
});

describe('optional-variable fallback', () => {
  it('drops only the optional variables in lean mode', () => {
    const full = new URL(openMeteoUrl({ ...base, mode: 'hourly' })).searchParams.get('hourly')!;
    const lean = new URL(
      openMeteoUrl({ ...base, mode: 'hourly' }, { lean: true }),
    ).searchParams.get('hourly')!;

    expect(full).toContain('uv_index');
    expect(lean).not.toContain('uv_index');
    expect(lean).not.toContain('is_day');
    // The variables a graphic is actually built on must survive the fallback —
    // a lean retry that dropped temperature would be worse than the error.
    for (const kept of ['temperature_2m', 'weather_code', 'wind_speed_10m']) {
      expect(lean).toContain(kept);
    }
  });

  it('recognizes a missing-variable error and nothing else', () => {
    // Matched on the variable name rather than the wording, because the wording
    // has changed between releases and a self-hosted instance can be any age.
    expect(isVariableError('Cannot initialize Variable uv_index')).toBe(true);
    expect(isVariableError('data corrupted: variable uv_index_max not available')).toBe(true);
    // A genuine outage must not be retried into a second failure and a worse
    // error message.
    expect(isVariableError('Timeout while reading data')).toBe(false);
    expect(isVariableError('Latitude must be in range of -90 to 90°')).toBe(false);
  });
});

describe('open-meteo normalization', () => {
  const current = {
    current: {
      time: '2026-08-03T14:00',
      temperature_2m: 41.700000000000003,
      apparent_temperature: 43.2,
      relative_humidity_2m: 12,
      is_day: 1,
      precipitation: 0,
      weather_code: 0,
      surface_pressure: 1004.2,
      wind_speed_10m: 8.4,
      wind_direction_10m: 270,
      wind_gusts_10m: 15.1,
    },
  };

  it('produces exactly one row in current mode, with every canonical column', () => {
    const data = openMeteoToDataSet(base, current);
    expect(data.rows).toHaveLength(1);
    for (const col of WEATHER_COLUMNS) {
      expect(Object.hasOwn(data.rows[0]!, col.key)).toBe(true);
    }
  });

  it('rounds a float artifact out of the temperature', () => {
    // 41.700000000000003 is what the conversion actually returns, and Fit Width
    // would shrink the strap to fit all eighteen characters of it.
    const data = openMeteoToDataSet(base, current);
    expect(data.rows[0]!['temp']).toBe(42);
  });

  it('labels the wind bearing and reads the WMO code', () => {
    const data = openMeteoToDataSet(base, current);
    expect(data.rows[0]!['windDir']).toBe('W');
    expect(data.rows[0]!['icon']).toBe('clear');
    expect(data.rows[0]!['condition']).toBe('Clear');
    expect(data.rows[0]!['isDay']).toBe(true);
  });

  it('converts pressure to inHg, the one unit the API will not convert', () => {
    // Open-Meteo takes temperature_unit, wind_speed_unit and precipitation_unit
    // and has no pressure_unit — surface_pressure is hPa whatever else was
    // asked for. An imperial bug read 1004 next to a Fahrenheit temperature.
    const data = openMeteoToDataSet(base, current);
    expect(data.rows[0]!['pressure']).toBe(29.65);
  });

  it('leaves pressure in hPa when the source is metric', () => {
    const data = openMeteoToDataSet({ ...base, units: 'metric' }, current);
    expect(data.rows[0]!['pressure']).toBe(1004);
  });

  it('carries the attribution the license obliges on every row', () => {
    const data = openMeteoToDataSet(base, current);
    expect(data.rows[0]!['attribution']).toBe('Weather data by Open-Meteo.com');
  });

  it('transposes the column-major daily block into rows', () => {
    const data = openMeteoToDataSet(
      { ...base, mode: 'daily', count: 3 },
      {
        daily: {
          time: ['2026-08-03', '2026-08-04', '2026-08-05'],
          weather_code: [0, 95, 3],
          temperature_2m_max: [110, 108, 104],
          temperature_2m_min: [88, 86, 84],
          precipitation_probability_max: [0, 40, 10],
        },
      },
    );
    expect(data.rows).toHaveLength(3);
    expect(data.rows.map((r) => r['tempMax'])).toEqual([110, 108, 104]);
    expect(data.rows.map((r) => r['icon'])).toEqual(['clear', 'thunderstorm', 'overcast']);
  });

  it('pads with nulls when a series comes back shorter than time', () => {
    // A short series must not truncate every other series with it — the row
    // count is `time`'s, and the gap shows as an empty cell.
    const data = openMeteoToDataSet(
      { ...base, mode: 'daily', count: 3 },
      {
        daily: {
          time: ['2026-08-03', '2026-08-04', '2026-08-05'],
          temperature_2m_max: [110],
        },
      },
    );
    expect(data.rows).toHaveLength(3);
    expect(data.rows[0]!['tempMax']).toBe(110);
    expect(data.rows[2]!['tempMax']).toBeNull();
    expect(data.rows[2]!['time']).toBe('2026-08-05');
  });

  it('survives a payload missing the block entirely', () => {
    const data = openMeteoToDataSet({ ...base, mode: 'daily' }, {});
    expect(data.rows).toEqual([]);
    expect(data.columns).toEqual(WEATHER_COLUMNS);
  });
});

describe('nws normalization', () => {
  const nwsDef: WeatherDataSource = { ...base, provider: 'nws' };

  const periods = [
    {
      name: 'Today',
      startTime: '2026-08-03T06:00:00-07:00',
      isDaytime: true,
      temperature: 110,
      temperatureUnit: 'F',
      probabilityOfPrecipitation: { value: 20 },
      windSpeed: '5 to 15 mph',
      windDirection: 'SW',
      icon: 'https://api.weather.gov/icons/land/day/tsra_hi,20?size=medium',
      shortForecast: 'Slight Chance Showers And Thunderstorms',
    },
    {
      name: 'Tonight',
      startTime: '2026-08-03T18:00:00-07:00',
      isDaytime: false,
      temperature: 88,
      temperatureUnit: 'F',
      probabilityOfPrecipitation: { value: null },
      windSpeed: '10 mph',
      windDirection: 'W',
      icon: 'https://api.weather.gov/icons/land/night/few?size=medium',
      shortForecast: 'Mostly Clear',
    },
  ];

  it('fills tempMax on a daytime period and tempMin on a night one', () => {
    // A graphic bound to tempMax/tempMin works against NWS without the designer
    // knowing NWS reports one number per half-day.
    const data = nwsToDataSet({ ...nwsDef, mode: 'daily', count: 2 }, periods);
    expect(data.rows[0]!['tempMax']).toBe(110);
    expect(data.rows[0]!['tempMin']).toBeNull();
    expect(data.rows[1]!['tempMin']).toBe(88);
    expect(data.rows[1]!['tempMax']).toBeNull();
  });

  it('converts to metric when asked, honouring the declared unit', () => {
    const data = nwsToDataSet({ ...nwsDef, units: 'metric' }, periods);
    expect(data.rows[0]!['temp']).toBe(43); // 110 °F
    expect(data.rows[0]!['windSpeed']).toBe(24); // 15 mph
  });

  it('does not convert a period the office already reported in Celsius', () => {
    // The Pacific territories' offices answer in C. Assuming F would cool Guam
    // by about thirty degrees, and it would look plausible.
    const data = nwsToDataSet({ ...nwsDef, units: 'metric' }, [
      { ...periods[0]!, temperature: 31, temperatureUnit: 'C' },
    ]);
    expect(data.rows[0]!['temp']).toBe(31);
  });

  it('returns one row in current mode however many periods arrived', () => {
    const data = nwsToDataSet({ ...nwsDef, mode: 'current' }, periods);
    expect(data.rows).toHaveLength(1);
  });

  it('leaves a null probability null rather than turning it into zero', () => {
    // Zero means "no chance of rain", which is a claim. Null means "not stated".
    const data = nwsToDataSet({ ...nwsDef, mode: 'daily', count: 2 }, periods);
    expect(data.rows[1]!['precipProb']).toBeNull();
  });

  it('produces the same column set as Open-Meteo', () => {
    const a = nwsToDataSet(nwsDef, periods);
    const b = openMeteoToDataSet(base, { current: { temperature_2m: 1 } });
    expect(a.columns).toEqual(b.columns);
  });
});

describe('license gating', () => {
  it('marks the hosted Open-Meteo API non-commercial and the self-hosted one not', () => {
    expect(WEATHER_PROVIDER_INFO['open-meteo'].commercialUse).toBe('non-commercial-only');
    expect(WEATHER_PROVIDER_INFO['open-meteo-self'].commercialUse).toBe('yes');
    expect(WEATHER_PROVIDER_INFO.nws.commercialUse).toBe('yes');
  });

  it('requires attribution everywhere except the public-domain provider', () => {
    expect(attributionFor('open-meteo').required).toBe(true);
    expect(attributionFor('open-meteo-self').required).toBe(true);
    expect(attributionFor('nws').required).toBe(false);
    // NWS still supplies a credit line — courtesy, not obligation.
    expect(attributionFor('nws').text).toBeTruthy();
  });

  it('clamps a too-fast poll to the provider floor instead of rejecting it', () => {
    expect(pollFloor(base)).toBe(900);
    expect(effectiveInterval({ ...base, pollInterval: 5 })).toBe(900);
    expect(effectiveInterval({ ...base, pollInterval: 1800 })).toBe(1800);
  });

  it('lets a self-hosted instance poll far faster than the hosted service', () => {
    const self: WeatherDataSource = {
      ...base,
      provider: 'open-meteo-self',
      baseUrl: 'http://localhost:8282',
      pollInterval: 60,
    };
    expect(effectiveInterval(self)).toBe(60);
    expect(effectiveInterval({ ...self, pollInterval: 5 })).toBe(60);
  });

  it('holds NWS to a politer floor than the global five seconds', () => {
    expect(effectiveInterval({ ...base, provider: 'nws', pollInterval: 5 })).toBe(300);
  });
});
