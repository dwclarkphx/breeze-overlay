// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Phase 8.6 Wave 3 (CYCLE.md): many places per source, NWS observations and
 * paired daily periods, the CAP reader, air quality, and expiry.
 *
 * The EnviroFlash payloads below are the Phoenix (area 111) feeds as captured
 * on 2026-09-27 (`dev/wxnow/`), trimmed only of whitespace. They are the test
 * that matters for the AirNow reader: it reads prose, and prose is what breaks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AIR_QUALITY_COLUMNS,
  CAP_COLUMNS,
  FORMAT_VERSION,
  MAX_PLACES,
  WEATHER_COLUMNS,
  aqiCategory,
  placesFromRows,
  type AirQualityDataSource,
  type CapDataSource,
  type DataSet,
  type DataSourceDef,
  type WeatherDataSource,
} from '@breeze/schema';
import { validateDataSources } from '@breeze/schema/validate';

vi.mock('../data/fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/fetch.js')>()),
  fetchText: vi.fn(),
}));

import { fetchText } from '../data/fetch.js';
import {
  airNowCurrentRows,
  airNowForecastRows,
  loadAirQuality,
  openMeteoAqRows,
  parseAirNowCurrent,
  parseAirNowForecast,
  parseProseTime,
} from '../data/airquality.js';
import { alertWindow, capDueIn, capToDataSet, parseCapXml } from '../data/cap.js';
import { eachPlace, localParts, parseInZone, rowDate, startTomorrow } from '../data/places.js';
import { DataRegistry } from '../data/registry.js';
import { effectiveExpiry } from '../data/sources.js';
import { loadWeather, nwsObservationRow, pairNwsPeriods } from '../data/weather.js';

const fetchMock = vi.mocked(fetchText);

/** Answer fetches from a URL → body map; anything else is a network failure. */
function serve(routes: Record<string, string | Error>): void {
  fetchMock.mockImplementation(async (url: string) => {
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        if (body instanceof Error) throw body;
        return { body, status: 200 };
      }
    }
    throw new Error(`fetch failed: ${url}`);
  });
}

afterEach(() => {
  fetchMock.mockReset();
  vi.useRealTimers();
});

/* ------------------------------------------------------------ fixtures */

const REALTIME_111 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Phoenix, AZ - Current Air Quality</title>
<pubDate>Sun, 27 Sep 2026 07:30:03 MST</pubDate>
<item><title>Phoenix, AZ - Current Air Quality</title>
<link>https://feeds.enviroflash.info/rss/realtime/111.xml?id=E0BA4850</link>
<description>
<!-- Format data output -->
&lt;div xmlns="http://www.w3.org/1999/xhtml"&gt;&lt;table style="width: 350px;"&gt;&lt;tr&gt;&lt;td&gt;&lt;br /&gt;&lt;/td&gt;&lt;/tr&gt;
&lt;tr&gt;&lt;td valign="top"&gt;
&lt;div&gt;&lt;b&gt;Location:&lt;/b&gt;  Phoenix, AZ&lt;/div&gt;&lt;br /&gt;
&lt;div&gt;
  &lt;b&gt;Current Air Quality:&lt;/b&gt;
  09/27/26 7:00 AM MST&lt;br /&gt;&lt;br /&gt;
  &lt;div&gt;
    Moderate  - 71 AQI - Ozone&lt;br /&gt;&lt;br /&gt;
    Good  - 34 AQI - Particle Pollution (2.5 microns)&lt;br /&gt;&lt;br /&gt;
    Good  - 20 AQI - Particle Pollution (10 microns)&lt;br /&gt;&lt;br /&gt;
  &lt;/div&gt;
&lt;/div&gt;
&lt;div&gt;&lt;b&gt;Agency:&lt;/b&gt; Arizona Department of Environmental Quality &lt;/div&gt;&lt;br /&gt;
&lt;div&gt;&lt;i&gt;Last Update: Sun, 27 Sep 2026 07:30:03 MST&lt;/i&gt;&lt;/div&gt;
&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;&lt;/div&gt;
</description></item></channel></rss>`;

const FORECAST_111 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Phoenix, AZ - Air Quality Forecast</title>
<item><title>Phoenix, AZ - Air Quality Forecast</title>
<description>
&lt;div xmlns="http://www.w3.org/1999/xhtml"&gt;&lt;table&gt;&lt;tr&gt;&lt;td valign="top"&gt;
&lt;div&gt;&lt;b&gt;Location:&lt;/b&gt;  Phoenix, AZ&lt;/div&gt;&lt;br /&gt;
&lt;div&gt;
  &lt;b&gt;Forecast:&lt;/b&gt;&lt;br /&gt;
  Today, 09/27/2026: Good  - 45 AQI - Ozone&lt;br /&gt;&lt;br /&gt;
  &lt;div&gt; Tomorrow, 09/28/2026: Good  - 41 AQI - Ozone&lt;br /&gt;&lt;/div&gt;&lt;br /&gt;
  &lt;div&gt; Tuesday, 09/29/2026: Good  - 40 AQI - Particle Pollution (10 microns)&lt;br /&gt;&lt;/div&gt;&lt;br /&gt;
&lt;/div&gt;
&lt;div&gt;&lt;b&gt;Agency:&lt;/b&gt; Arizona Department of Environmental Quality &lt;/div&gt;&lt;br /&gt;
&lt;div&gt;&lt;i&gt;Last Update: Sun, 27 Sep 2026 07:15:03 MST&lt;/i&gt;&lt;/div&gt;
&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;&lt;/div&gt;
</description></item></channel></rss>`;

const CAP_AGGREGATE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
<id>https://feeds.enviroflash.info//</id><title>AIRNow Alerts</title>
<updated>2026-09-27T10:23:07-07:00</updated>
<entry>
  <id>https://feeds.enviroflash.info/cap/32.xml?id=E07ADBDE</id>
  <title>Texas Commission on Environmental Quality -  Notification</title>
  <link href="https://feeds.enviroflash.info/cap/32.xml?id=E07ADBDE"/>
  <updated>2026-09-27T10:23:07-06:00</updated>
  <content type="application/xhtml+xml"><div xmlns="http://www.w3.org/1999/xhtml"><div><b>Location:</b> Dallas-Fort Worth, TX</div></div></content>
  <cap:status>Actual</cap:status><cap:msgType>Alert</cap:msgType>
  <cap:sender>https://www.airnow.gov</cap:sender><cap:scope>Public</cap:scope>
  <cap:info>
    <cap:category>Met</cap:category>
    <cap:event>Ozone is forecast to reach Unhealthy for Sensitive Groups on Sun 09/27/2026. A(n) Ozone Action Day has been called for Sun 09/27/2026. </cap:event>
    <cap:urgency>Future</cap:urgency><cap:severity>Moderate</cap:severity><cap:certainty>Likely</cap:certainty>
    <cap:eventCode><cap:valueName>OET:v1.2</cap:valueName><cap:value>OET-004</cap:value></cap:eventCode>
    <cap:effective>2026-09-27T00:00:00-06:00</cap:effective>
    <cap:expires>2026-09-28T00:00:00-06:00</cap:expires>
    <cap:senderName>AIRNow Program, US Environmental Protection Agency</cap:senderName>
    <cap:headline>Air Quality Alert for Dallas-Fort Worth</cap:headline>
    <cap:description>Ozone is forecast to reach Unhealthy for Sensitive Groups on Sun 09/27/2026.</cap:description>
    <cap:instruction>Active children and adults, and people with lung disease, such as asthma, should reduce prolonged or heavy exertion outdoors</cap:instruction>
    <cap:web>https://feeds.enviroflash.info/cap/32.xml?id=E07ADC11</cap:web>
    <cap:area><cap:areaDesc>Dallas-Fort Worth, TX</cap:areaDesc><cap:circle>32.767,-96.783 1</cap:circle></cap:area>
  </cap:info>
</entry>
<entry>
  <id>https://feeds.enviroflash.info/cap/60.xml?id=E07AE24B</id>
  <title>Texas Commission on Environmental Quality -  Notification</title>
  <link href="https://feeds.enviroflash.info/cap/60.xml?id=E07AE24B"/>
  <cap:status>Actual</cap:status><cap:msgType>Alert</cap:msgType>
  <cap:info>
    <cap:event>Ozone Action Day</cap:event><cap:severity>Moderate</cap:severity>
    <cap:effective>2026-09-27T00:00:00-06:00</cap:effective>
    <cap:expires>2026-09-28T00:00:00-06:00</cap:expires>
    <cap:headline>Air Quality Alert for Houston-Galveston-Brazoria</cap:headline>
    <cap:area><cap:areaDesc>Houston-Galveston-Brazoria, TX</cap:areaDesc></cap:area>
  </cap:info>
</entry>
</feed>`;

/* --------------------------------------------------------------- places */

describe('places from a table', () => {
  it('reads ordinary headers, numbers typed as text, and skips unnamed rows', () => {
    const places = placesFromRows([
      { city: 'Phoenix', code: 'PHX', lat: '33.4484', lon: '-112.0740', area: 111 },
      { city: '', lat: 1, lon: 2 },
      { city: 'Flagstaff', code: 'FLG', lat: 35.1983, lon: -111.6513, station: 'KFLG' },
    ]);
    expect(places).toEqual([
      { name: 'Phoenix', key: 'PHX', latitude: 33.4484, longitude: -112.074, area: '111' },
      { name: 'Flagstaff', key: 'FLG', latitude: 35.1983, longitude: -111.6513, station: 'KFLG' },
    ]);
  });

  it('prefers an explicit column mapping over the aliases', () => {
    const places = placesFromRows([{ name: 'wrong', Town: 'Yuma', y: 32.69, x: -114.62 }], {
      name: 'Town',
      latitude: 'y',
      longitude: 'x',
    });
    expect(places).toEqual([{ name: 'Yuma', latitude: 32.69, longitude: -114.62 }]);
  });

  it('stops at MAX_PLACES', () => {
    const rows = Array.from({ length: MAX_PLACES + 5 }, (_, i) => ({ name: `P${i}`, lat: 1, lon: 1 }));
    expect(placesFromRows(rows)).toHaveLength(MAX_PLACES);
  });

  it('keeps a failing place on its last-good rows, keyed by name, with a warning', async () => {
    const prior: DataSet = {
      id: 'wx',
      columns: WEATHER_COLUMNS,
      rows: [
        { place: 'Tucson', temp: 99 },
        { place: 'Phoenix', temp: 101 },
      ],
    };
    const result = await eachPlace(
      [{ name: 'Phoenix' }, { name: 'Tucson' }, { name: 'Yuma' }],
      async (place) => {
        if (place.name === 'Phoenix') return [{ temp: 104 }];
        throw new Error('timed out');
      },
      prior,
    );
    expect(result.rows).toEqual([
      { temp: 104, place: 'Phoenix', placeKey: null },
      { place: 'Tucson', temp: 99 },
    ]);
    expect(result.warning).toMatch(/2 of 3 places failed/);
    expect(result.warning).toMatch(/last-good rows for Tucson \(timed out\)/);
    expect(result.warning).toMatch(/no data yet for Yuma/);
  });

  it('throws when every place failed — even with last-good rows, an outage is not a success', async () => {
    const prior: DataSet = { id: 'wx', columns: WEATHER_COLUMNS, rows: [{ place: 'A', temp: 1 }, { place: 'B', temp: 2 }] };
    await expect(
      eachPlace([{ name: 'A' }, { name: 'B' }], async () => { throw new Error('down'); }, prior),
    ).rejects.toThrow(/every place failed/);
    // With one place the provider's own message comes through untouched.
    await expect(
      eachPlace([{ name: 'A' }], async () => { throw new Error('HTTP 503'); }, undefined),
    ).rejects.toThrow('HTTP 503');
  });

  it('keeps only last-good rows the source says are still fit to show', async () => {
    const prior: DataSet = { id: 'aq', columns: AIR_QUALITY_COLUMNS, rows: [{ place: 'Tucson', aqi: 40, fresh: false }] };
    const result = await eachPlace(
      [{ name: 'Phoenix' }, { name: 'Tucson' }],
      async (place) => {
        if (place.name === 'Phoenix') return [{ aqi: 71 }];
        throw new Error('down');
      },
      prior,
      (row) => row['fresh'] !== false,
    );
    expect(result.rows.map((r) => r['place'])).toEqual(['Phoenix']);
    expect(result.warning).toMatch(/no data yet for Tucson/);
  });
});

describe('local time', () => {
  it('reads the wall clock at the place', () => {
    const now = new Date('2026-09-27T23:30:00Z');
    expect(localParts('America/Phoenix', now)).toEqual({ date: '2026-09-27', hour: 16, minute: 30, second: 0 });
    expect(localParts('America/New_York', now)).toMatchObject({ date: '2026-09-27', hour: 19 });
  });

  it('takes a row date from any of the three time shapes', () => {
    expect(rowDate('2026-09-28', 'America/Phoenix')).toBe('2026-09-28');
    expect(rowDate('2026-09-28T06:00:00-07:00', 'America/Phoenix')).toBe('2026-09-28');
    // 03:00Z on the 28th is still the evening of the 27th in Phoenix — and
    // `+00:00` is UTC too, as Bright Sky writes it.
    expect(rowDate('2026-09-28T03:00:00Z', 'America/Phoenix')).toBe('2026-09-27');
    expect(rowDate('2026-09-28T03:00:00+00:00', 'America/Phoenix')).toBe('2026-09-27');
  });

  it('parses wall time in a zone, across daylight saving', () => {
    expect(new Date(parseInZone('2026-09-27T18:00:00', 'America/Phoenix')).toISOString()).toBe('2026-09-28T01:00:00.000Z');
    expect(new Date(parseInZone('2026-07-01T12:00:00', 'America/Denver')).toISOString()).toBe('2026-07-01T18:00:00.000Z');
    expect(new Date(parseInZone('2026-12-01T12:00:00', 'America/Denver')).toISOString()).toBe('2026-12-01T19:00:00.000Z');
    // An explicit offset wins over the zone.
    expect(parseInZone('2026-09-27T18:00:00-05:00', 'America/Phoenix')).toBe(Date.parse('2026-09-27T23:00:00Z'));
  });

  it('drops today only once the hour has passed', () => {
    const rows = [{ time: '2026-09-27' }, { time: '2026-09-28' }];
    const afternoon = new Date('2026-09-27T21:59:00Z'); // 14:59 in Phoenix
    const later = new Date('2026-09-27T22:00:00Z'); // 15:00
    expect(startTomorrow(rows, 15, 'America/Phoenix', afternoon)).toHaveLength(2);
    expect(startTomorrow(rows, 15, 'America/Phoenix', later)).toEqual([{ time: '2026-09-28' }]);
    expect(startTomorrow(rows, undefined, 'America/Phoenix', later)).toHaveLength(2);
  });
});

/* ---------------------------------------------------------------- NWS */

describe('NWS daily pairing', () => {
  const period = (name: string, start: string, isDaytime: boolean, temperature: number, pop: number) => ({
    name,
    startTime: start,
    isDaytime,
    temperature,
    temperatureUnit: 'F',
    probabilityOfPrecipitation: { value: pop },
    windSpeed: '5 to 10 mph',
    windDirection: 'SW',
    shortForecast: isDaytime ? 'Sunny' : 'Mostly Clear',
    icon: `https://api.weather.gov/icons/land/${isDaytime ? 'day' : 'night'}/skc?size=medium`,
  });

  it('pairs each day with its night, and keeps an evening Tonight as its own row', () => {
    const rows = pairNwsPeriods(
      [
        period('Tonight', '2026-09-27T18:00:00-07:00', false, 78, 0),
        period('Monday', '2026-09-28T06:00:00-07:00', true, 101, 10),
        period('Monday Night', '2026-09-28T18:00:00-07:00', false, 77, 30),
      ],
      'imperial',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ time: '2026-09-27', period: 'Tonight', tempMax: null, tempMin: 78, isDay: false });
    expect(rows[1]).toMatchObject({
      time: '2026-09-28',
      period: 'Monday',
      temp: 101,
      tempMax: 101,
      tempMin: 77,
      condition: 'Sunny',
      // The wetter of the two halves: a dry day with a stormy night is not 10%.
      precipProb: 30,
      isDay: true,
    });
  });
});

describe('NWS observations', () => {
  const obs = {
    timestamp: '2026-09-27T14:51:00+00:00',
    textDescription: 'Clear',
    icon: 'https://api.weather.gov/icons/land/day/skc?size=medium',
    temperature: { value: 35, unitCode: 'wmoUnit:degC' },
    dewpoint: { value: 5, unitCode: 'wmoUnit:degC' },
    windDirection: { value: 270, unitCode: 'wmoUnit:degree_(angle)' },
    windSpeed: { value: 5, unitCode: 'wmoUnit:m_s-1' },
    windGust: { value: null, unitCode: 'wmoUnit:km_h-1' },
    seaLevelPressure: { value: 101325, unitCode: 'wmoUnit:Pa' },
    visibility: { value: 16093, unitCode: 'wmoUnit:m' },
    relativeHumidity: { value: 15.2, unitCode: 'wmoUnit:percent' },
    heatIndex: { value: 34, unitCode: 'wmoUnit:degC' },
  };

  it('converts by the unit each value states', () => {
    const row = nwsObservationRow(obs, 'imperial', new Date('2026-09-27T15:21:00Z'), 'KPHX');
    expect(row).toMatchObject({
      temp: 95,
      dewPoint: 41,
      feelsLike: 93,
      // 5 m/s is 18 km/h is 11 mph — read as km/h it would have been 3.
      windSpeed: 11,
      windGust: null,
      windDir: 'W',
      pressure: 29.92,
      visibility: 10,
      humidity: 15,
      condition: 'Clear',
      icon: 'clear',
      isDay: true,
      station: 'KPHX',
      ageMinutes: 30,
    });
  });

  it('tries the next station when the nearest reports no temperature', async () => {
    serve({
      'https://api.weather.gov/points/': JSON.stringify({
        properties: {
          observationStations: 'https://api.weather.gov/gridpoints/PSR/158,56/stations',
          timeZone: 'America/Phoenix',
        },
      }),
      'https://api.weather.gov/gridpoints/PSR/158,56/stations': JSON.stringify({
        features: [{ properties: { stationIdentifier: 'KXXX' } }, { properties: { stationIdentifier: 'KPHX' } }],
      }),
      'https://api.weather.gov/stations/KXXX/': JSON.stringify({
        properties: { ...obs, temperature: { value: null, unitCode: 'wmoUnit:degC' } },
      }),
      'https://api.weather.gov/stations/KPHX/': JSON.stringify({ properties: obs }),
    });
    const def: WeatherDataSource = {
      id: 'obs', name: 'Obs', type: 'weather', provider: 'nws',
      latitude: 33.4484, longitude: -112.074, units: 'imperial', mode: 'observed', place: 'Phoenix',
    };
    const { data } = await loadWeather(def, { now: new Date('2026-09-27T15:00:00Z') });
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({ station: 'KPHX', temp: 95, place: 'Phoenix', ageMinutes: 9 });
  });

  it('runs a list of places, tagging rows and keeping a failed one on its last-good rows', async () => {
    serve({
      'https://api.weather.gov/points/33.4484,-112.0740': JSON.stringify({ properties: {} }),
      'https://api.weather.gov/points/35.1983,-111.6513': new Error('timed out after 10000ms'),
      'https://api.weather.gov/stations/KPHX/': JSON.stringify({ properties: obs }),
    });
    const def: WeatherDataSource = {
      id: 'obs', name: 'Obs', type: 'weather', provider: 'nws', units: 'imperial', mode: 'observed',
      places: [
        { name: 'Phoenix', key: 'PHX', latitude: 33.4484, longitude: -112.074, station: 'KPHX' },
        { name: 'Flagstaff', key: 'FLG', latitude: 35.1983, longitude: -111.6513 },
      ],
    };
    const prior: DataSet = { id: 'obs', columns: WEATHER_COLUMNS, rows: [{ place: 'Flagstaff', placeKey: 'FLG', temp: 71 }] };
    const result = await loadWeather(def, { prior, now: new Date('2026-09-27T15:00:00Z') });
    expect(result.data.rows.map((r) => [r['place'], r['placeKey'], r['temp']])).toEqual([
      ['Phoenix', 'PHX', 95],
      ['Flagstaff', 'FLG', 71],
    ]);
    expect(result.warning).toMatch(/Flagstaff/);
  });

  it('refuses a table-fed source whose table has not loaded, rather than blanking it', async () => {
    const def: WeatherDataSource = {
      id: 'wx', name: 'Wx', type: 'weather', provider: 'nws', placesFrom: { source: 'cities' },
    };
    await expect(loadWeather(def, {})).rejects.toThrow(/"cities" has not loaded yet/);
  });
});

/* ---------------------------------------------------------------- CAP */

describe('CAP reader', () => {
  const capDef: CapDataSource = { id: 'aq-alerts', name: 'Alerts', type: 'cap', url: 'https://feeds.enviroflash.info/cap/aggregate.xml' };

  it("reads AirNow's Atom feed, with fields on the entry and inside cap:info", () => {
    const alerts = parseCapXml(CAP_AGGREGATE);
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({
      status: 'Actual',
      msgType: 'Alert',
      severity: 'Moderate',
      headline: 'Air Quality Alert for Dallas-Fort Worth',
      areaDesc: 'Dallas-Fort Worth, TX',
      web: 'https://feeds.enviroflash.info/cap/32.xml?id=E07ADC11',
    });
  });

  it('filters by area, case-insensitively', () => {
    const data = capToDataSet({ ...capDef, area: 'houston' }, CAP_AGGREGATE, new Date('2026-09-27T15:00:00Z'));
    expect(data.columns).toBe(CAP_COLUMNS);
    expect(data.rows.map((r) => r['areaDesc'])).toEqual(['Houston-Galveston-Brazoria, TX']);
  });

  it('reads AirNow days as local calendar days when told to', () => {
    // 00:30 CDT on the 28th: the Sunday action day is over. Believing the
    // printed -06:00 would keep it on air until 01:00.
    const now = new Date('2026-09-28T05:30:00Z');
    const alert = parseCapXml(CAP_AGGREGATE)[0]!;
    expect(alertWindow(alert, {}, now).ended).toBe(false);
    expect(alertWindow(alert, { times: 'local-day', timezone: 'America/Chicago' }, now).ended).toBe(true);
    // And during Sunday it is in effect.
    const sunday = new Date('2026-09-27T20:00:00Z');
    expect(alertWindow(alert, { times: 'local-day', timezone: 'America/Chicago' }, sunday)).toEqual({ ended: false, active: true });
  });

  it('drops tests, cancellations and expired alerts, then sorts most severe first', () => {
    const feature = (id: string, extra: Record<string, unknown>) => ({
      id,
      properties: {
        id, status: 'Actual', messageType: 'Alert', event: 'Heat Advisory', severity: 'Moderate',
        areaDesc: 'Maricopa, AZ', geocode: { SAME: ['004013'], UGC: ['AZZ537'] },
        effective: '2026-09-27T10:00:00-07:00', expires: '2026-09-28T20:00:00-07:00',
        headline: 'Heat Advisory issued', description: 'HOT.\n\nVery\nhot.', instruction: null,
        ...extra,
      },
    });
    const body = JSON.stringify({
      features: [
        feature('a', {}),
        feature('b', { event: 'Excessive Heat Warning', severity: 'Severe' }),
        feature('c', { status: 'Test' }),
        feature('d', { messageType: 'Cancel' }),
        feature('e', { expires: '2026-09-27T11:00:00-07:00' }),
        feature('f', { severity: 'Minor', event: 'Dust Advisory' }),
        feature('g', { geocode: { UGC: ['AZZ999'] } }),
      ],
    });
    const now = new Date('2026-09-27T19:00:00Z');
    const all = capToDataSet(capDef, body, now);
    // Severe first; equal severities keep their onset order; Minor last.
    expect(all.rows.map((r) => r['id'])).toEqual(['b', 'a', 'g', 'f']);
    // NWS hard-wraps descriptions; that is layout, not content.
    expect(all.rows[1]!['description']).toBe('HOT. Very hot.');
    expect(all.rows[1]!['codes']).toBe('004013, AZZ537');

    const filtered = capToDataSet({ ...capDef, codes: 'azz537', minSeverity: 'Moderate' }, body, now);
    expect(filtered.rows.map((r) => r['id'])).toEqual(['b', 'a']);
  });

  it('drops an entry with no CAP status — a placeholder is not an alert', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>x</id>
      <title>There are no active watches, warnings or advisories</title></entry></feed>`;
    expect(capToDataSet(capDef, xml, new Date()).rows).toEqual([]);
  });

  it('reads offset-less times in the configured zone, not the server’s', () => {
    const alert = {
      ...parseCapXml(CAP_AGGREGATE)[0]!,
      effective: '2026-09-27T09:00:00',
      onset: '',
      expires: '2026-09-27T18:00:00',
    };
    // 17:30 MST is 00:30Z on the 28th: still in effect in Phoenix.
    const now = new Date('2026-09-28T00:30:00Z');
    expect(alertWindow(alert, { timezone: 'America/Phoenix' }, now)).toEqual({ ended: false, active: true });
    expect(alertWindow(alert, { timezone: 'America/Phoenix' }, new Date('2026-09-28T01:01:00Z')).ended).toBe(true);
  });

  it('says when the rows next change without the feed changing', () => {
    const now = new Date('2026-09-27T19:00:00Z');
    const rows = [{ expires: '2026-09-27T20:00:00Z', onset: '2026-09-27T18:00:00Z' }, { expires: '2026-09-27T19:30:00Z' }];
    expect(capDueIn(capDef, rows, now)).toBe(30 * 60_000 + 1000);
    expect(capDueIn(capDef, [], now)).toBeUndefined();
    // Whole days: the coming local midnight. 12:00 MST → twelve hours.
    const local = capDueIn({ ...capDef, times: 'local-day', timezone: 'America/Phoenix' }, rows, now)!;
    expect(local).toBe(12 * 3_600_000 + 1000);
  });

  it('reads a bare CAP alert, preferring the English info block', () => {
    const xml = `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
      <identifier>X1</identifier><sender>w-nws.webmaster@noaa.gov</sender><sent>2026-09-27T10:00:00-07:00</sent>
      <status>Actual</status><msgType>Alert</msgType><scope>Public</scope>
      <info><language>es-US</language><event>Aviso de Calor</event><severity>Severe</severity></info>
      <info><language>en-US</language><event>Heat Warning</event><severity>Severe</severity>
        <expires>2026-09-28T20:00:00-07:00</expires>
        <area><areaDesc>Central Phoenix</areaDesc><geocode><valueName>UGC</valueName><value>AZZ537</value></geocode></area>
      </info></alert>`;
    const data = capToDataSet(capDef, xml, new Date('2026-09-27T19:00:00Z'));
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({ id: 'X1', event: 'Heat Warning', areaDesc: 'Central Phoenix', codes: 'AZZ537', active: true });
  });
});

/* -------------------------------------------------------- air quality */

describe('AirNow feeds', () => {
  it('reads the prose time with its named zone', () => {
    expect(parseProseTime('09/27/26 7:00 AM MST')).toBe('2026-09-27T07:00:00-07:00');
    expect(parseProseTime('01/02/2026 12:15 PM EDT')).toBe('2026-01-02T12:15:00-04:00');
    expect(parseProseTime('09/27/26 7:00 AM XYZ')).toBeNull();
  });

  it('parses the realtime feed without altering a word', () => {
    const parsed = parseAirNowCurrent(REALTIME_111);
    expect(parsed).toEqual({
      location: 'Phoenix, AZ',
      agency: 'Arizona Department of Environmental Quality',
      time: '2026-09-27T07:00:00-07:00',
      readings: [
        { category: 'Moderate', aqi: 71, pollutant: 'Ozone' },
        { category: 'Good', aqi: 34, pollutant: 'Particle Pollution (2.5 microns)' },
        { category: 'Good', aqi: 20, pollutant: 'Particle Pollution (10 microns)' },
      ],
    });
  });

  it('reports the highest reading as the overall AQI, preliminary, crediting the agency first', () => {
    const now = new Date('2026-09-27T14:40:00Z'); // 07:40 MST
    const [row] = airNowCurrentRows(parseAirNowCurrent(REALTIME_111), 'current', now, 3 * 3600);
    expect(row).toMatchObject({
      aqi: 71,
      category: 'Moderate',
      categoryIndex: 2,
      color: '#FFFF00',
      pollutant: 'Ozone',
      scale: 'US AQI',
      preliminary: true,
      ageMinutes: 40,
      agency: 'Arizona Department of Environmental Quality',
      attribution: 'Arizona Department of Environmental Quality and the EPA AirNow program',
    });
    expect(airNowCurrentRows(parseAirNowCurrent(REALTIME_111), 'pollutants', now, 3 * 3600)).toHaveLength(3);
  });

  it('blanks a reading older than the expiry, and distrusts one dated in the future', () => {
    const parsed = parseAirNowCurrent(REALTIME_111);
    const late = airNowCurrentRows(parsed, 'current', new Date('2026-09-27T17:30:00Z'), 3 * 3600);
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ aqi: null, category: null, ageMinutes: 210 });

    // Dated two hours ahead: not believed, and a reading that cannot be shown
    // to be current is blank rather than trusted (fail closed).
    const early = airNowCurrentRows(parsed, 'current', new Date('2026-09-27T12:00:00Z'), 3 * 3600);
    expect(early[0]).toMatchObject({ time: null, ageMinutes: null, aqi: null });
  });

  it('reads a reading that shares its line with the label and time', () => {
    const xml = REALTIME_111.replace(
      /Current Air Quality:&lt;\/b&gt;\s*09\/27\/26 7:00 AM MST&lt;br \/&gt;&lt;br \/&gt;\s*&lt;div&gt;\s*/,
      'Current Air Quality:&lt;/b&gt; 09/27/26 7:00 AM MST ',
    );
    expect(parseAirNowCurrent(xml).readings[0]).toEqual({ category: 'Moderate', aqi: 71, pollutant: 'Ozone' });
  });

  it("drops forecast days before the area's today", () => {
    const parsed = parseAirNowForecast(FORECAST_111);
    const rows = airNowForecastRows(parsed, 3, '2026-09-28');
    expect(rows.map((r) => r['period'])).toEqual(['Tomorrow', 'Tuesday']);
  });

  it('parses the forecast feed into days', () => {
    const parsed = parseAirNowForecast(FORECAST_111);
    const rows = airNowForecastRows(parsed, 3);
    expect(rows.map((r) => [r['time'], r['period'], r['aqi'], r['category'], r['pollutant'], r['preliminary']])).toEqual([
      ['2026-09-27', 'Today', 45, 'Good', 'Ozone', false],
      ['2026-09-28', 'Tomorrow', 41, 'Good', 'Ozone', false],
      ['2026-09-29', 'Tuesday', 40, 'Good', 'Particle Pollution (10 microns)', false],
    ]);
  });

  it('loads one area, labelled by the feed when the def names no place', async () => {
    serve({ 'https://feeds.enviroflash.info/rss/realtime/111.xml': REALTIME_111 });
    const def: AirQualityDataSource = { id: 'aq', name: 'AQ', type: 'air-quality', provider: 'airnow-feed', area: '111' };
    const { data } = await loadAirQuality(def, { now: new Date('2026-09-27T14:40:00Z') });
    expect(data.columns).toBe(AIR_QUALITY_COLUMNS);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({ place: 'Phoenix, AZ', aqi: 71 });
  });
});

describe('CAMS via Open-Meteo', () => {
  const def: AirQualityDataSource = {
    id: 'aq', name: 'AQ', type: 'air-quality', provider: 'open-meteo', latitude: 33.45, longitude: -112.07,
  };

  it('bands a US index by the EPA table', () => {
    expect(aqiCategory('us', 50)?.name).toBe('Good');
    expect(aqiCategory('us', 51)?.name).toBe('Moderate');
    expect(aqiCategory('us', 151)?.color).toBe('#FF0000');
    expect(aqiCategory('eu', 45)?.name).toBe('Moderate');
    expect(aqiCategory('us', null)).toBeNull();
  });

  it('names the pollutant driving the current index', () => {
    const [row] = openMeteoAqRows(
      def,
      {
        utc_offset_seconds: -25200,
        current: { time: '2026-09-27T08:00', us_aqi: 62.4, us_aqi_ozone: 62.4, us_aqi_pm2_5: 30, us_aqi_pm10: 12 },
      },
      new Date('2026-09-27T15:20:00Z'),
    );
    expect(row).toMatchObject({ aqi: 62, category: 'Moderate', pollutant: 'Ozone', preliminary: false, ageMinutes: 20 });
  });

  it('forecasts each day by its worst hour', () => {
    const rows = openMeteoAqRows(
      { ...def, mode: 'forecast', count: 2 },
      {
        hourly: {
          time: ['2026-09-27T12:00', '2026-09-27T15:00', '2026-09-28T12:00'],
          us_aqi: [40, 88, 55],
          us_aqi_ozone: [40, 88, 20],
          us_aqi_pm2_5: [10, 12, 55],
        },
      },
      new Date(),
    );
    expect(rows.map((r) => [r['time'], r['aqi'], r['pollutant']])).toEqual([
      ['2026-09-27', 88, 'Ozone'],
      ['2026-09-28', 55, 'Particle Pollution (2.5 microns)'],
    ]);
  });
});

/* ----------------------------------------------------------- validation */

describe('validation', () => {
  const doc = (...sources: DataSourceDef[]) => ({ formatVersion: FORMAT_VERSION, sources });
  const wx = (extra: Partial<WeatherDataSource>): WeatherDataSource => ({
    id: 'wx', name: 'Wx', type: 'weather', provider: 'nws', ...extra,
  });

  it('requires exactly one of a place, a list or a table', () => {
    expect(validateDataSources(doc(wx({}))).valid).toBe(false);
    expect(validateDataSources(doc(wx({ latitude: 33, longitude: -112 }))).valid).toBe(true);
    expect(validateDataSources(doc(wx({ places: [{ name: 'Phoenix', latitude: 33, longitude: -112 }] }))).valid).toBe(true);
    const both = validateDataSources(doc(wx({ latitude: 33, longitude: -112, places: [{ name: 'P', latitude: 1, longitude: 1 }] })));
    expect(both.valid).toBe(false);
    expect(validateDataSources(doc(wx({ places: [{ name: 'Nowhere' }] }))).errors[0]?.message).toMatch(/needs a latitude/);
  });

  it('refuses observed mode from a provider without observations', () => {
    const result = validateDataSources(doc(wx({ provider: 'open-meteo', mode: 'observed', latitude: 1, longitude: 1 })));
    expect(result.errors[0]?.message).toMatch(/no observed mode/);
    expect(validateDataSources(doc(wx({ mode: 'observed', latitude: 1, longitude: 1 }))).valid).toBe(true);
  });

  it('checks a places table exists and is not the source itself', () => {
    const cities: DataSourceDef = { id: 'cities', name: 'Cities', type: 'manual', columns: [], rows: [] };
    expect(validateDataSources(doc(wx({ placesFrom: { source: 'cities' } }), cities)).valid).toBe(true);
    expect(validateDataSources(doc(wx({ placesFrom: { source: 'nope' } }))).errors[0]?.message).toMatch(/no data source "nope"/);
    expect(validateDataSources(doc(wx({ placesFrom: { source: 'wx' } }))).errors[0]?.message).toMatch(/itself/);
  });

  it('checks air-quality places by what the provider reads', () => {
    const aq = (extra: Partial<AirQualityDataSource>): AirQualityDataSource => ({
      id: 'aq', name: 'AQ', type: 'air-quality', provider: 'airnow-feed', ...extra,
    });
    expect(validateDataSources(doc(aq({ area: '111' }))).valid).toBe(true);
    expect(validateDataSources(doc(aq({ latitude: 1, longitude: 1 }))).valid).toBe(false);
    expect(validateDataSources(doc(aq({ area: '111', scale: 'eu' }))).errors[0]?.message).toMatch(/US AQI only/);
    expect(validateDataSources(doc(aq({ provider: 'open-meteo', latitude: 1, longitude: 1, scale: 'eu' }))).valid).toBe(true);
  });

  it('keeps a station to one place', () => {
    const result = validateDataSources(doc(wx({
      mode: 'observed', station: 'KPHX', places: [{ name: 'Tucson', latitude: 32.2, longitude: -110.9 }],
    })));
    expect(result.errors[0]?.message).toMatch(/station belongs to one place/);
  });

  it('checks time zones against Intl, and asks for one for whole local days', () => {
    expect(validateDataSources(doc(wx({ latitude: 1, longitude: 1, timezone: 'America/Phonix' }))).errors[0]?.message)
      .toMatch(/unknown time zone/);
    expect(validateDataSources(doc(wx({ latitude: 1, longitude: 1, timezone: 'auto' }))).valid).toBe(true);
    const cap: CapDataSource = { id: 'a', name: 'A', type: 'cap', url: 'https://x.test/cap.xml', times: 'local-day' };
    expect(validateDataSources(doc(cap)).errors[0]?.message).toMatch(/need the zone/);
    expect(validateDataSources(doc({ ...cap, timezone: 'America/Chicago' })).valid).toBe(true);
  });

  it('reads places only from a table, never from another place-fed source', () => {
    const other = wx({ id: 'other', latitude: 1, longitude: 1 });
    expect(validateDataSources(doc(wx({ placesFrom: { source: 'other' } }), other)).errors[0]?.message)
      .toMatch(/places come from a table/);
  });

  it('accepts expireAfter and a CAP source', () => {
    const cap: CapDataSource = {
      id: 'alerts', name: 'Alerts', type: 'cap', url: 'https://api.weather.gov/alerts/active?area=AZ',
      minSeverity: 'Moderate', times: 'exact', contact: 'station.example, ops@station.example', expireAfter: 3600,
    };
    expect(validateDataSources(doc(cap)).valid).toBe(true);
  });
});

/* ------------------------------------------------------------ registry */

describe('registry: tables of places and expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T14:40:00Z'));
  });

  it('feeds a table of places into a source that reads it', async () => {
    serve({ 'https://feeds.enviroflash.info/rss/realtime/111.xml': REALTIME_111 });
    const registry = new DataRegistry();
    // Stopped first: no background ticks racing the refreshes below.
    registry.stop();
    const cities: DataSourceDef = {
      id: 'cities', name: 'Cities', type: 'manual',
      columns: [{ key: 'name', type: 'string' }, { key: 'area', type: 'string' }],
      rows: [{ name: 'Phoenix', area: '111' }],
    };
    const aq: AirQualityDataSource = {
      id: 'aq', name: 'AQ', type: 'air-quality', provider: 'airnow-feed', placesFrom: { source: 'cities' },
    };
    await registry.upsert('p', cities);
    await registry.upsert('p', aq);
    const entry = await registry.refresh('p', 'aq');
    expect(entry.status.lastError).toBeUndefined();
    expect(entry.data.rows[0]).toMatchObject({ place: 'Phoenix', aqi: 71 });
  });

  it('empties an AirNow source whose last success is older than its expiry, and recovers', async () => {
    const aq: AirQualityDataSource = { id: 'aq', name: 'AQ', type: 'air-quality', provider: 'airnow-feed', area: '111' };
    expect(effectiveExpiry(aq)).toBe(3 * 3600);

    const registry = new DataRegistry();
    // Stopped first: no background ticks racing the refreshes below.
    registry.stop();
    await registry.upsert('p', aq);
    serve({ 'https://feeds.enviroflash.info/rss/realtime/111.xml': REALTIME_111 });
    let entry = await registry.refresh('p', 'aq');
    expect(entry.data.rows).toHaveLength(1);

    serve({});
    vi.setSystemTime(new Date('2026-09-27T16:40:00Z'));
    entry = await registry.refresh('p', 'aq');
    // Two hours: failing, but still inside the limit — last-good stays.
    expect(entry.data.rows).toHaveLength(1);
    expect(entry.status.expired).toBeUndefined();

    vi.setSystemTime(new Date('2026-09-27T17:41:00Z'));
    entry = await registry.refresh('p', 'aq');
    expect(entry.data.rows).toEqual([]);
    expect(entry.data.columns).toBe(AIR_QUALITY_COLUMNS);
    expect(entry.status.expired).toBe(true);

    serve({ 'https://feeds.enviroflash.info/rss/realtime/111.xml': REALTIME_111 });
    entry = await registry.refresh('p', 'aq');
    expect(entry.status.expired).toBeUndefined();
    expect(entry.data.rows).toHaveLength(1);
  });

  it('keeps an expired CAP source blank — cached alerts do not come back', async () => {
    const cap: CapDataSource = {
      id: 'alerts', name: 'Alerts', type: 'cap', url: 'https://feeds.enviroflash.info/cap/aggregate.xml',
      expireAfter: 3600,
    };
    const registry = new DataRegistry();
    registry.stop();
    await registry.upsert('p', cap);
    serve({ 'https://feeds.enviroflash.info/cap/aggregate.xml': CAP_AGGREGATE });
    let entry = await registry.refresh('p', 'alerts');
    expect(entry.data.rows).toHaveLength(2);

    serve({});
    vi.setSystemTime(new Date('2026-09-27T15:41:00Z'));
    entry = await registry.refresh('p', 'alerts');
    expect(entry.data.rows).toEqual([]);
    vi.setSystemTime(new Date('2026-09-27T15:45:00Z'));
    entry = await registry.refresh('p', 'alerts');
    expect(entry.data.rows).toEqual([]);
  });

  it('counts an outage of every place as a failure, so expiry still runs', async () => {
    const aq: AirQualityDataSource = {
      id: 'aq', name: 'AQ', type: 'air-quality', provider: 'airnow-feed',
      places: [{ name: 'Phoenix', area: '111' }, { name: 'Also Phoenix', area: '111' }],
    };
    const registry = new DataRegistry();
    registry.stop();
    await registry.upsert('p', aq);
    serve({ 'https://feeds.enviroflash.info/rss/realtime/111.xml': REALTIME_111 });
    let entry = await registry.refresh('p', 'aq');
    expect(entry.data.rows).toHaveLength(2);

    serve({});
    vi.setSystemTime(new Date('2026-09-27T16:40:00Z'));
    entry = await registry.refresh('p', 'aq');
    expect(entry.status.failures).toBe(1);
    expect(entry.data.rows).toHaveLength(2);
    vi.setSystemTime(new Date('2026-09-27T17:41:00Z'));
    entry = await registry.refresh('p', 'aq');
    expect(entry.data.rows).toEqual([]);
  });

  it('re-reads cached alerts against the clock while the feed is down', async () => {
    const cap: CapDataSource = {
      id: 'alerts', name: 'Alerts', type: 'cap', url: 'https://feeds.enviroflash.info/cap/aggregate.xml',
      times: 'local-day', timezone: 'America/Chicago',
    };
    const registry = new DataRegistry();
    // Stopped first: no background ticks racing the refreshes below.
    registry.stop();
    await registry.upsert('p', cap);
    serve({ 'https://feeds.enviroflash.info/cap/aggregate.xml': CAP_AGGREGATE });
    let entry = await registry.refresh('p', 'alerts');
    expect(entry.data.rows).toHaveLength(2);

    serve({});
    vi.setSystemTime(new Date('2026-09-28T05:30:00Z'));
    entry = await registry.refresh('p', 'alerts');
    expect(entry.status.lastError).toBeDefined();
    expect(entry.data.rows).toEqual([]);
  });
});
