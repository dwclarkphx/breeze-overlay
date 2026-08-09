// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Wave 4 weather providers — MET Norway and Bright Sky.
 *
 * Same principle as `data-weather.test.ts`: captured payload *shapes*, not live
 * origins, and assertions about normalization rather than about the wire. The
 * fixtures below are trimmed copies of real responses taken from
 * `api.met.no/weatherapi/locationforecast/2.0/complete` and
 * `api.brightsky.dev`, so a provider changing the field names it ships breaks a
 * test rather than a graphic.
 *
 * The unit conversions get the most attention here for the reason given in the
 * other file: a wrong-but-plausible number is the failure that goes to air. MET
 * reports wind in m/s and Bright Sky in km/h, and this adapter's `metric` means
 * km/h — so one of them converts, the other does not, and mixing that up is a
 * 3.6× error that still looks like weather.
 */

import { describe, expect, it } from 'vitest';

import { WEATHER_COLUMNS, WEATHER_PROVIDER_INFO, pollFloor, type WeatherDataSource } from '@breeze/schema';

import {
  brightSkyIsDay,
  brightSkyToDataSet,
  brightSkyToIcon,
  metIsDay,
  metSymbolBase,
  metToDataSet,
  metToIcon,
  metToText,
} from '../data/weather.js';

const met: WeatherDataSource = {
  id: 'wx',
  name: 'Weather',
  type: 'weather',
  provider: 'met-norway',
  latitude: 59.9139,
  longitude: 10.7522,
};

const dwd: WeatherDataSource = { ...met, provider: 'brightsky', latitude: 52.52, longitude: 13.4 };

/** Trimmed from a real `complete` response for Oslo. */
const metPayload = {
  properties: {
    timeseries: [
      {
        time: '2026-08-02T00:00:00Z',
        data: {
          instant: {
            details: {
              air_pressure_at_sea_level: 1010.6,
              air_temperature: 15.5,
              cloud_area_fraction: 3.3,
              relative_humidity: 64.7,
              ultraviolet_index_clear_sky: 0.1,
              wind_from_direction: 241.0,
              wind_speed: 2.0,
              wind_speed_of_gust: 4.5,
            },
          },
          next_1_hours: {
            summary: { symbol_code: 'clearsky_night' },
            details: { precipitation_amount: 0.0, probability_of_precipitation: 8.2 },
          },
          next_6_hours: {
            summary: { symbol_code: 'partlycloudy_night' },
            details: {
              precipitation_amount: 0.0,
              air_temperature_max: 16.4,
              air_temperature_min: 13.8,
            },
          },
        },
      },
      {
        time: '2026-08-02T01:00:00Z',
        data: {
          instant: { details: { air_temperature: 14.6, wind_speed: 1.6 } },
          next_1_hours: { summary: { symbol_code: 'partlycloudy_night' }, details: {} },
        },
      },
    ],
  },
};

/** Trimmed from a real `/weather` (MOSMIX) response for Berlin. */
const brightSkyForecast = [
  {
    timestamp: '2026-08-04T06:00:00+00:00',
    precipitation: 0.0,
    pressure_msl: 1013.9,
    temperature: 21.5,
    wind_direction: 102,
    wind_speed: 13.0,
    cloud_cover: 63,
    relative_humidity: null,
    wind_gust_speed: 22.2,
    condition: 'dry',
    precipitation_probability: 2,
    icon: 'partly-cloudy-day',
  },
  {
    timestamp: '2026-08-04T07:00:00+00:00',
    precipitation: 0.0,
    temperature: 23.0,
    wind_speed: 11.1,
    icon: 'partly-cloudy-day',
  },
];

/** Trimmed from a real `current_weather` response — note the windowed keys. */
const brightSkyCurrent = [
  {
    timestamp: '2026-08-04T01:30:00+00:00',
    temperature: 21.3,
    pressure_msl: 1013.7,
    relative_humidity: 80,
    cloud_cover: 100,
    precipitation_10: 0.0,
    wind_direction_10: 100,
    wind_speed_10: 13.3,
    wind_gust_speed_10: 19.4,
    condition: 'dry',
    icon: 'cloudy',
  },
];

describe('MET Norway symbol codes', () => {
  it('strips the day/night variant before mapping', () => {
    // The variant is not an icon distinction here — `isDay` is its own column,
    // and a designer's artwork picks the night version from that.
    expect(metSymbolBase('clearsky_day')).toBe('clearsky');
    expect(metSymbolBase('clearsky_night')).toBe('clearsky');
    expect(metSymbolBase('clearsky_polartwilight')).toBe('clearsky');
    expect(metToIcon('clearsky_day')).toBe('clear');
    expect(metToIcon('clearsky_night')).toBe('clear');
  });

  it('collapses intensity onto one icon per condition', () => {
    for (const code of ['lightrain', 'rain', 'heavyrain']) {
      expect(metToIcon(code), code).toBe('rain');
    }
    for (const code of ['lightsnow', 'snow', 'heavysnow']) {
      expect(metToIcon(code), code).toBe('snow');
    }
  });

  it('maps every thunder variant onto thunderstorm', () => {
    for (const code of [
      'rainandthunder',
      'heavyrainshowersandthunder',
      'lightsleetshowersandthunder',
      'snowandthunder',
    ]) {
      expect(metToIcon(code), code).toBe('thunderstorm');
    }
  });

  it('distinguishes fair from clear and from partly cloudy', () => {
    expect(metToIcon('fair_day')).toBe('mostly-clear');
    expect(metToIcon('partlycloudy_day')).toBe('partly-cloudy');
    expect(metToIcon('cloudy')).toBe('cloudy');
  });

  it('returns unknown rather than guessing at an unrecognised code', () => {
    expect(metToIcon('somethingnew_day')).toBe('unknown');
    expect(metToIcon(null)).toBe('unknown');
    expect(metToText('somethingnew')).toBeNull();
  });

  it('reads day/night off the code and refuses to guess at polar twilight', () => {
    // MET already accounts for polar twilight; a naive sunrise calculation at
    // 78°N does not, which is why this is read rather than computed.
    expect(metIsDay('clearsky_day')).toBe(true);
    expect(metIsDay('clearsky_night')).toBe(false);
    expect(metIsDay('clearsky_polartwilight')).toBeNull();
    expect(metIsDay('cloudy')).toBeNull();
  });
});

describe('MET Norway normalization', () => {
  it('produces one row in current mode with every canonical column', () => {
    const set = metToDataSet(met, metPayload);
    expect(set.rows).toHaveLength(1);
    for (const col of WEATHER_COLUMNS) {
      expect(Object.hasOwn(set.rows[0]!, col.key), col.key).toBe(true);
    }
  });

  it('converts wind from m/s to km/h for metric', () => {
    // The conversion that is silent when wrong: 2.0 m/s is a limp 7 km/h, and
    // passing it through unconverted reads as a plausible light breeze.
    const set = metToDataSet(met, metPayload);
    expect(set.rows[0]!['windSpeed']).toBe(7);
    expect(set.rows[0]!['windGust']).toBe(16);
  });

  it('converts wind to mph for imperial', () => {
    const set = metToDataSet({ ...met, units: 'imperial' }, metPayload);
    expect(set.rows[0]!['windSpeed']).toBe(4);
  });

  it('converts temperature to Fahrenheit for imperial and leaves it alone for metric', () => {
    expect(metToDataSet(met, metPayload).rows[0]!['temp']).toBe(15.5);
    expect(metToDataSet({ ...met, units: 'imperial' }, metPayload).rows[0]!['temp']).toBe(59.9);
  });

  it('converts pressure to inHg only for imperial', () => {
    expect(metToDataSet(met, metPayload).rows[0]!['pressure']).toBe(1011);
    expect(metToDataSet({ ...met, units: 'imperial' }, metPayload).rows[0]!['pressure']).toBeCloseTo(29.84, 1);
  });

  it('takes precipitation probability from the period block', () => {
    expect(metToDataSet(met, metPayload).rows[0]!['precipProb']).toBe(8);
  });

  it('labels the wind bearing', () => {
    expect(metToDataSet(met, metPayload).rows[0]!['windDir']).toBe('WSW');
  });

  it('reads high and low from the 6-hour aggregate in daily mode', () => {
    // These live only in `complete`, and they are the reason this adapter does
    // not use the smaller `compact` product.
    const set = metToDataSet({ ...met, mode: 'daily', count: 1 }, metPayload);
    expect(set.rows[0]!['tempMax']).toBe(16.4);
    expect(set.rows[0]!['tempMin']).toBe(13.8);
  });

  it('carries the obligatory credit on every row', () => {
    const set = metToDataSet({ ...met, mode: 'hourly', count: 2 }, metPayload);
    expect(set.rows).toHaveLength(2);
    for (const row of set.rows) {
      expect(row['attribution']).toBe(WEATHER_PROVIDER_INFO['met-norway'].attribution);
    }
  });

  it('nulls the fields a location does not carry rather than dropping the row', () => {
    // Outside the Nordics MET ships no precipitation probability and no gust at
    // all — the fixed column set exists so a graphic bound to them still renders.
    const set = metToDataSet({ ...met, mode: 'hourly', count: 2 }, metPayload);
    expect(set.rows[1]!['precipProb']).toBeNull();
    expect(set.rows[1]!['windGust']).toBeNull();
    expect(set.rows[1]!['temp']).toBe(14.6);
  });

  it('survives a payload with no timeseries at all', () => {
    expect(metToDataSet(met, {}).rows).toEqual([]);
    expect(metToDataSet(met, { properties: {} }).rows).toEqual([]);
  });
});

describe('Bright Sky normalization', () => {
  it('passes wind through unconverted for metric', () => {
    // Bright Sky reports km/h, not the SI m/s its parsing library emits. If
    // this ever starts failing by a factor of 3.6, that assumption changed.
    const set = brightSkyToDataSet(dwd, brightSkyForecast);
    expect(set.rows[0]!['windSpeed']).toBe(13);
    expect(set.rows[0]!['windGust']).toBe(22);
  });

  it('converts wind to mph for imperial', () => {
    const set = brightSkyToDataSet({ ...dwd, units: 'imperial' }, brightSkyForecast);
    expect(set.rows[0]!['windSpeed']).toBe(8);
  });

  it('reads the windowed keys the current_weather endpoint uses instead', () => {
    // `current_weather` has no plain `wind_speed`; it reports over 10/30/60
    // minute windows. Reading only the plain key returned a null wind bug.
    const set = brightSkyToDataSet(dwd, brightSkyCurrent);
    expect(set.rows[0]!['windSpeed']).toBe(13);
    expect(set.rows[0]!['windGust']).toBe(19);
    expect(set.rows[0]!['windDir']).toBe('E');
    expect(set.rows[0]!['precipAmount']).toBe(0);
  });

  it('maps day and night icon variants onto one icon plus isDay', () => {
    expect(brightSkyToIcon('partly-cloudy-day')).toBe('partly-cloudy');
    expect(brightSkyToIcon('partly-cloudy-night')).toBe('partly-cloudy');
    expect(brightSkyIsDay('partly-cloudy-day')).toBe(true);
    expect(brightSkyIsDay('partly-cloudy-night')).toBe(false);
    expect(brightSkyIsDay('cloudy')).toBeNull();
  });

  it('returns unknown for an icon it does not recognize', () => {
    expect(brightSkyToIcon('brand-new')).toBe('unknown');
    expect(brightSkyToIcon(null)).toBe('unknown');
  });

  it('takes the precipitation probability MOSMIX supplies', () => {
    expect(brightSkyToDataSet(dwd, brightSkyForecast).rows[0]!['precipProb']).toBe(2);
  });

  it('nulls humidity when MOSMIX omits it rather than dropping the row', () => {
    const set = brightSkyToDataSet(dwd, brightSkyForecast);
    expect(set.rows[0]!['humidity']).toBeNull();
    expect(set.rows[0]!['temp']).toBe(21.5);
  });

  it('produces every canonical column and the obligatory credit', () => {
    const set = brightSkyToDataSet(dwd, brightSkyCurrent);
    for (const col of WEATHER_COLUMNS) {
      expect(Object.hasOwn(set.rows[0]!, col.key), col.key).toBe(true);
    }
    expect(set.rows[0]!['attribution']).toBe(WEATHER_PROVIDER_INFO.brightsky.attribution);
  });

  it('honours the requested row count in forecast mode', () => {
    expect(brightSkyToDataSet({ ...dwd, mode: 'hourly', count: 2 }, brightSkyForecast).rows).toHaveLength(2);
    expect(brightSkyToDataSet({ ...dwd, mode: 'current' }, brightSkyForecast).rows).toHaveLength(1);
  });
});

describe('licensing and poll floors', () => {
  it('offers a commercially usable option outside the US that needs no self-hosting', () => {
    // The whole point of this wave. Before it, the only free commercial option
    // outside the US was a self-hosted Open-Meteo — a single point of failure
    // that also needs a box to run on.
    const global = Object.values(WEATHER_PROVIDER_INFO).filter(
      (i) => i.commercialUse === 'yes' && !i.needsBaseUrl && i.id !== 'nws',
    );
    expect(global.map((i) => i.id).sort()).toEqual(['brightsky', 'met-norway']);
  });

  it('obliges a credit line for both, since both licenses require one', () => {
    expect(WEATHER_PROVIDER_INFO['met-norway'].attribution).toBeTruthy();
    expect(WEATHER_PROVIDER_INFO.brightsky.attribution).toBeTruthy();
  });

  it('clamps a too-eager poll to the provider floor', () => {
    expect(pollFloor({ ...met, pollInterval: 5 })).toBe(900);
    expect(pollFloor({ ...dwd, pollInterval: 5 })).toBe(900);
  });

  it('demands a contact for MET Norway and not for Bright Sky', () => {
    // MET blocks unidentified traffic; Bright Sky has no such policy. The flag
    // is what the editor keys its warning on, so it is worth pinning.
    expect(WEATHER_PROVIDER_INFO['met-norway'].needsContact).toBe(true);
    expect(WEATHER_PROVIDER_INFO.brightsky.needsContact).toBe(false);
  });

  it('offers model selection only for Open-Meteo', () => {
    const withModels = Object.values(WEATHER_PROVIDER_INFO)
      .filter((i) => i.supportsModelSelection)
      .map((i) => i.id)
      .sort();
    expect(withModels).toEqual(['open-meteo', 'open-meteo-self']);
  });

  it('needs no base URL for either — they are fixed origins', () => {
    expect(WEATHER_PROVIDER_INFO['met-norway'].needsBaseUrl).toBe(false);
    expect(WEATHER_PROVIDER_INFO.brightsky.needsBaseUrl).toBe(false);
  });
});
