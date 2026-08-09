// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Weather adapter — NWS, Open-Meteo, MET Norway and Bright Sky, normalised onto
 * one column set.
 *
 * Three things make this an adapter rather than a preset over `http-json`:
 *
 *  1. **The license is enforceable only here.** Open-Meteo's hosted API is
 *     non-commercial; a station that puts it on air behind advertising is in
 *     breach. The def names a provider, the provider carries its terms, and the
 *     editor gates on them. Hand the operator a URL field and all of that
 *     becomes advisory.
 *  2. **NWS is two requests, not one.** `api.weather.gov` has no lat/lon
 *     forecast endpoint: you resolve the point to a grid cell, then fetch the
 *     cell. That is a fetch strategy, not a URL.
 *  3. **The providers disagree about everything.** Temperature units, wind
 *     units, whether a condition is prose or a WMO integer, whether "now" is a
 *     field or the first row of an hourly array. Normalising is the value; see
 *     WEATHER_COLUMNS in `@breeze/schema` for the argument.
 */

import {
  WEATHER_COLUMNS,
  WEATHER_PROVIDER_INFO,
  conform,
  type DataRow,
  type DataSet,
  type WeatherDataSource,
  type WeatherIcon,
  type WeatherMode,
  type WeatherProvider,
  type WeatherUnits,
} from '@breeze/schema';

import { fetchText, userAgent } from './fetch.js';

/** Rows returned in forecast mode when the def does not say. */
const DEFAULT_COUNT = 7;
const MAX_COUNT = 240;

/* ------------------------------------------------------------ unit helpers */

const cToF = (c: number): number => c * 9 / 5 + 32;
const hPaToInHg = (hpa: number): number => hpa * 0.0295299830714;

/**
 * Round to a broadcast-sensible precision.
 *
 * Not cosmetic. `21.700000000000003` in a temperature cell is what a float
 * conversion actually produces, and Fit Width would dutifully shrink the strap
 * to make all eighteen characters fit.
 */
function round(v: number | null | undefined, places = 0): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/**
 * Pressure is the one imperial conversion Open-Meteo will not do for us.
 *
 * The API takes `temperature_unit`, `wind_speed_unit` and `precipitation_unit`,
 * and there is no `pressure_unit` to go with them — `surface_pressure` comes
 * back in hPa whatever else was asked for. So an imperial weather bug would
 * otherwise read 1013 next to a Fahrenheit temperature. Inches of mercury also
 * needs two decimals to be worth showing at all: 29.92 rounded to zero places
 * is 30, which is every pressure.
 */
function toPressure(units: WeatherUnits, hpa: number | null): number | null {
  if (hpa === null) return null;
  return units === 'imperial' ? round(hPaToInHg(hpa), 2) : round(hpa);
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Degrees → compass point. Providers that give a bearing, we give a label. */
export function bearingToCompass(deg: number | null): string | null {
  if (deg === null || !Number.isFinite(deg)) return null;
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const i = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return points[i] ?? null;
}

/* ------------------------------------------------------------ icon mapping */

/**
 * WMO 4677 present-weather codes → the canonical icon vocabulary.
 *
 * Open-Meteo emits these directly. The mapping is lossy on purpose: 61, 63 and
 * 65 are light, moderate and heavy rain, and a lower third has one rain icon.
 */
const WMO_ICONS: Record<number, WeatherIcon> = {
  0: 'clear',
  1: 'mostly-clear',
  2: 'partly-cloudy',
  3: 'overcast',
  45: 'fog', 48: 'fog',
  51: 'drizzle', 53: 'drizzle', 55: 'drizzle',
  56: 'freezing-rain', 57: 'freezing-rain',
  61: 'rain', 63: 'rain', 65: 'rain',
  66: 'freezing-rain', 67: 'freezing-rain',
  71: 'snow', 73: 'snow', 75: 'snow',
  77: 'snow',
  80: 'showers', 81: 'showers', 82: 'showers',
  85: 'snow', 86: 'snow',
  95: 'thunderstorm',
  96: 'hail', 99: 'hail',
};

/** Prose descriptions, for the same codes. */
const WMO_TEXT: Record<number, string> = {
  0: 'Clear', 1: 'Mainly Clear', 2: 'Partly Cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime Fog',
  51: 'Light Drizzle', 53: 'Drizzle', 55: 'Heavy Drizzle',
  56: 'Freezing Drizzle', 57: 'Freezing Drizzle',
  61: 'Light Rain', 63: 'Rain', 65: 'Heavy Rain',
  66: 'Freezing Rain', 67: 'Freezing Rain',
  71: 'Light Snow', 73: 'Snow', 75: 'Heavy Snow', 77: 'Snow Grains',
  80: 'Light Showers', 81: 'Showers', 82: 'Heavy Showers',
  85: 'Snow Showers', 86: 'Snow Showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with Hail', 99: 'Severe Thunderstorm',
};

export function wmoToIcon(code: number | null): WeatherIcon {
  if (code === null) return 'unknown';
  return WMO_ICONS[code] ?? 'unknown';
}

export function wmoToText(code: number | null): string | null {
  if (code === null) return null;
  return WMO_TEXT[code] ?? null;
}

/**
 * NWS gives an icon URL and a prose forecast, neither of which is a code.
 *
 * The URL path carries a token — `.../land/day/tsra_hi,40?size=medium` — and
 * that token is the closest thing NWS has to a machine-readable condition, so
 * it is preferred. Prose is the fallback because `shortForecast` is free text
 * that has changed wording before.
 */
const NWS_ICONS: Array<[RegExp, WeatherIcon]> = [
  [/^(skc|hot|cold)$/, 'clear'],
  [/^few$/, 'mostly-clear'],
  [/^(sct|bkn)$/, 'partly-cloudy'],
  [/^ovc$/, 'overcast'],
  [/^(fg|haze|smoke|dust)$/, 'fog'],
  [/^(fzra|ip|rain_fzra|snow_fzra|rain_ip|snow_ip)$/, 'freezing-rain'],
  [/^(rain_showers|rain_showers_hi)$/, 'showers'],
  [/^(rain|rain_sleet|rain_snow)$/, 'rain'],
  [/^(snow|blizzard|snow_sleet)$/, 'snow'],
  [/^sleet$/, 'sleet'],
  [/tsra/, 'thunderstorm'],
  [/^(wind|wind_.*)$/, 'windy'],
  [/^tornado|hurricane|tropical/, 'windy'],
];

export function nwsToIcon(iconUrl: string | null, shortForecast: string | null): WeatherIcon {
  const token = iconUrl
    ? (/\/(?:day|night)\/([a-z_]+)/.exec(iconUrl)?.[1] ?? null)
    : null;
  if (token) {
    for (const [pattern, icon] of NWS_ICONS) if (pattern.test(token)) return icon;
  }

  const text = (shortForecast ?? '').toLowerCase();
  if (!text) return 'unknown';
  if (text.includes('thunder')) return 'thunderstorm';
  if (text.includes('freezing')) return 'freezing-rain';
  if (text.includes('sleet')) return 'sleet';
  if (text.includes('snow')) return 'snow';
  if (text.includes('shower')) return 'showers';
  if (text.includes('drizzle')) return 'drizzle';
  if (text.includes('rain')) return 'rain';
  if (text.includes('fog') || text.includes('haze')) return 'fog';
  if (text.includes('wind')) return 'windy';
  if (text.includes('overcast')) return 'overcast';
  if (text.includes('mostly cloudy') || text.includes('partly')) return 'partly-cloudy';
  if (text.includes('cloud')) return 'cloudy';
  if (text.includes('mostly sunny') || text.includes('mostly clear')) return 'mostly-clear';
  if (text.includes('sunny') || text.includes('clear')) return 'clear';
  return 'unknown';
}

/* --------------------------------------------------------------- row shape */

/**
 * A row with every canonical key present.
 *
 * Built from a full null template rather than by spreading a partial, so a
 * provider that omits a field yields a null cell instead of an absent key. A
 * bound cell then renders empty; an absent key renders `undefined`.
 */
function blankRow(): DataRow {
  const row: DataRow = {};
  for (const col of WEATHER_COLUMNS) row[col.key] = null;
  return row;
}

function finish(id: string, rows: DataRow[], attribution: string | null): DataSet {
  const withCredit = rows.map((row) => ({ ...row, attribution: attribution ?? null }));
  return { id, columns: WEATHER_COLUMNS, rows: conform(withCredit, WEATHER_COLUMNS) };
}

/* ---------------------------------------------------------- Open-Meteo */

const OPEN_METEO_HOSTED = 'https://api.open-meteo.com';

/**
 * Variables that are nice to have and not worth failing a whole request over.
 *
 * Open-Meteo rejects the *entire* call if one requested variable is unavailable
 * — it does not omit the series and return the rest. That is fine against the
 * hosted API, where everything below exists for `best_match`, but a self-hosted
 * instance pinned to one model (`models=ncep_gfs_seamless`) only has what that
 * model produces and what the operator has actually synced. Asking for
 * `uv_index` from a raw GFS mirror then costs the operator the temperature too.
 *
 * So these are dropped and the request retried once on a variable error, rather
 * than being guessed at up front — guessing means encoding a per-model variable
 * matrix that goes stale the first time Open-Meteo adds a model.
 */
const OPTIONAL_VARS = ['uv_index', 'uv_index_max', 'apparent_temperature_max', 'is_day'];

/**
 * Query string for an Open-Meteo request.
 *
 * Units are asked for in the operator's chosen system rather than converted
 * here: Open-Meteo does the conversion server-side, so asking is both fewer
 * lines and a rounding error smaller. NWS gets the opposite treatment below
 * because it does not offer the choice.
 */
export function openMeteoUrl(def: WeatherDataSource, opts: { lean?: boolean } = {}): string {
  const info = WEATHER_PROVIDER_INFO[def.provider];
  const base = info.needsBaseUrl
    ? (def.baseUrl ?? '').replace(/\/+$/, '')
    : OPEN_METEO_HOSTED;
  if (!base) throw new Error('self-hosted Open-Meteo needs a baseUrl');

  const units: WeatherUnits = def.units ?? 'metric';
  const mode: WeatherMode = def.mode ?? 'current';
  const keep = (vars: string[]): string =>
    (opts.lean ? vars.filter((v) => !OPTIONAL_VARS.includes(v)) : vars).join(',');

  const params = new URLSearchParams({
    // Four decimals is ~11 m. More is noise, and MET Norway 403s on five —
    // truncating everywhere keeps one habit rather than one per provider.
    latitude: def.latitude.toFixed(4),
    longitude: def.longitude.toFixed(4),
    /*
     * `auto` resolves the zone from the coordinates, which is what a weather bug
     * wants — the times on screen should be the times at the place being
     * forecast. An explicit zone is honoured because a station in one zone
     * reporting on another wants its *own* clock, and because a self-hosted
     * instance without the timezone database cannot answer `auto` at all.
     */
    timezone: def.timezone?.trim() || 'auto',
  });

  /*
   * A pinned model is the normal case self-hosted and the rare case hosted.
   * Left unset, Open-Meteo uses `best_match`, which on a self-hosted instance
   * means "whichever models it thinks are best" — and if the operator has only
   * synced one, that is a request for data the box does not have.
   */
  if (def.models?.trim()) params.set('models', def.models.trim());

  if (units === 'imperial') {
    params.set('temperature_unit', 'fahrenheit');
    params.set('wind_speed_unit', 'mph');
    params.set('precipitation_unit', 'inch');
  }

  if (mode === 'current') {
    params.set('current', keep([
      'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
      'is_day', 'precipitation', 'weather_code', 'surface_pressure',
      'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
    ]));
  } else if (mode === 'hourly') {
    params.set('hourly', keep([
      'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
      'precipitation_probability', 'precipitation', 'weather_code',
      'surface_pressure', 'wind_speed_10m', 'wind_direction_10m',
      'wind_gusts_10m', 'is_day', 'uv_index',
    ]));
    params.set('forecast_hours', String(clampCount(def.count, 24)));
  } else {
    params.set('daily', keep([
      'weather_code', 'temperature_2m_max', 'temperature_2m_min',
      'apparent_temperature_max', 'precipitation_sum',
      'precipitation_probability_max', 'wind_speed_10m_max',
      'wind_gusts_10m_max', 'wind_direction_10m_dominant', 'uv_index_max',
    ]));
    params.set('forecast_days', String(Math.min(clampCount(def.count, DEFAULT_COUNT), 16)));
  }

  return `${base}/v1/forecast?${params.toString()}`;
}

/**
 * Does this Open-Meteo error look like "you asked for a variable I don't have"?
 *
 * Matched on the variable name rather than on wording, because the wording has
 * changed between releases and a self-hosted instance can be any age.
 */
export function isVariableError(reason: string): boolean {
  const text = reason.toLowerCase();
  if (!/variable|not available|cannot|invalid/.test(text)) return false;
  return OPTIONAL_VARS.some((v) => text.includes(v));
}

function clampCount(count: number | undefined, fallback: number): number {
  if (count === undefined || !Number.isFinite(count)) return fallback;
  return Math.max(1, Math.min(MAX_COUNT, Math.floor(count)));
}

interface OpenMeteoPayload {
  current?: Record<string, unknown>;
  hourly?: Record<string, unknown[]>;
  daily?: Record<string, unknown[]>;
}

export function openMeteoToDataSet(
  def: WeatherDataSource,
  payload: OpenMeteoPayload,
): DataSet {
  const info = WEATHER_PROVIDER_INFO[def.provider];
  const units: WeatherUnits = def.units ?? 'metric';
  const mode: WeatherMode = def.mode ?? 'current';
  const rows: DataRow[] = [];

  if (mode === 'current') {
    const c = payload.current ?? {};
    const code = num(c['weather_code']);
    rows.push({
      ...blankRow(),
      time: typeof c['time'] === 'string' ? c['time'] : null,
      temp: round(num(c['temperature_2m'])),
      feelsLike: round(num(c['apparent_temperature'])),
      condition: wmoToText(code),
      icon: wmoToIcon(code),
      precipAmount: round(num(c['precipitation']), 2),
      windSpeed: round(num(c['wind_speed_10m'])),
      windGust: round(num(c['wind_gusts_10m'])),
      windDir: bearingToCompass(num(c['wind_direction_10m'])),
      humidity: round(num(c['relative_humidity_2m'])),
      pressure: toPressure(units, num(c['surface_pressure'])),
      isDay: num(c['is_day']) === 1,
    });
    return finish(def.id, rows, info.attribution);
  }

  /*
   * Open-Meteo returns column-major arrays — `{ time: [...], temperature_2m:
   * [...] }` — which is the transpose of a DataSet. `time` is the only array
   * guaranteed present, so it sets the row count; a series that came back short
   * yields nulls at the tail rather than truncating every other series with it.
   */
  const block = (mode === 'hourly' ? payload.hourly : payload.daily) ?? {};
  const times = Array.isArray(block['time']) ? block['time'] : [];
  const at = (key: string, i: number): unknown =>
    Array.isArray(block[key]) ? block[key][i] : undefined;

  const wanted = clampCount(def.count, mode === 'hourly' ? 24 : DEFAULT_COUNT);

  for (let i = 0; i < Math.min(times.length, wanted); i += 1) {
    const code = num(at('weather_code', i));
    const isHourly = mode === 'hourly';
    rows.push({
      ...blankRow(),
      time: typeof times[i] === 'string' ? (times[i] as string) : null,
      temp: round(num(at('temperature_2m', i))),
      tempMin: round(num(at('temperature_2m_min', i))),
      tempMax: round(num(at('temperature_2m_max', i))),
      feelsLike: round(
        num(at(isHourly ? 'apparent_temperature' : 'apparent_temperature_max', i)),
      ),
      condition: wmoToText(code),
      icon: wmoToIcon(code),
      precipProb: round(
        num(at(isHourly ? 'precipitation_probability' : 'precipitation_probability_max', i)),
      ),
      precipAmount: round(num(at(isHourly ? 'precipitation' : 'precipitation_sum', i)), 2),
      windSpeed: round(num(at(isHourly ? 'wind_speed_10m' : 'wind_speed_10m_max', i))),
      windGust: round(num(at(isHourly ? 'wind_gusts_10m' : 'wind_gusts_10m_max', i))),
      windDir: bearingToCompass(
        num(at(isHourly ? 'wind_direction_10m' : 'wind_direction_10m_dominant', i)),
      ),
      humidity: round(num(at('relative_humidity_2m', i))),
      pressure: toPressure(units, num(at('surface_pressure', i))),
      uvIndex: round(num(at(isHourly ? 'uv_index' : 'uv_index_max', i)), 1),
      isDay: isHourly ? num(at('is_day', i)) === 1 : null,
    });
  }

  return finish(def.id, rows, info.attribution);
}

/* ----------------------------------------------------------------- NWS */

const NWS_BASE = 'https://api.weather.gov';

interface NwsPeriod {
  name?: string;
  startTime?: string;
  isDaytime?: boolean;
  temperature?: number;
  temperatureUnit?: string;
  probabilityOfPrecipitation?: { value?: number | null };
  relativeHumidity?: { value?: number | null };
  windSpeed?: string;
  windDirection?: string;
  icon?: string;
  shortForecast?: string;
}

/**
 * NWS reports wind as prose — `"10 to 15 mph"`, sometimes `"15 mph"`.
 *
 * Taking the *upper* bound of a range: a range in a forecast is a gust-inclusive
 * span, and a weather bug that under-reports wind on a day the range matters is
 * the wrong way to be wrong.
 */
export function parseNwsWind(text: string | null | undefined): number | null {
  if (!text) return null;
  const numbers = text.match(/\d+/g);
  if (!numbers?.length) return null;
  return Math.max(...numbers.map(Number));
}

export function nwsToDataSet(def: WeatherDataSource, periods: NwsPeriod[]): DataSet {
  const info = WEATHER_PROVIDER_INFO[def.provider];
  const units: WeatherUnits = def.units ?? 'metric';
  const mode: WeatherMode = def.mode ?? 'current';
  const wanted = mode === 'current' ? 1 : clampCount(def.count, DEFAULT_COUNT);

  const rows: DataRow[] = periods.slice(0, wanted).map((p) => {
    /*
     * `temperatureUnit` is authoritative and is not always F: the gridpoint
     * endpoint answers in C for some offices and for all of the Pacific
     * territories. Converting on the assumption of F silently cools Guam by
     * about thirty degrees.
     */
    const rawTemp = num(p.temperature);
    const nativeF = (p.temperatureUnit ?? 'F').toUpperCase() === 'F';
    let temp: number | null = rawTemp;
    if (rawTemp !== null) {
      if (units === 'imperial' && !nativeF) temp = cToF(rawTemp);
      if (units === 'metric' && nativeF) temp = (rawTemp - 32) * 5 / 9;
    }

    // Wind prose is always mph from this endpoint.
    const windMph = parseNwsWind(p.windSpeed);
    const wind = windMph === null
      ? null
      : units === 'metric' ? windMph / 0.621371 : windMph;

    return {
      ...blankRow(),
      time: p.startTime ?? null,
      temp: round(temp),
      // A daytime period's temperature is the high, a night period's is the low.
      // Filling the matching column too means a `tempMax`-bound graphic works
      // against NWS without the designer knowing which endpoint fed it.
      tempMax: p.isDaytime === true ? round(temp) : null,
      tempMin: p.isDaytime === false ? round(temp) : null,
      condition: p.shortForecast ?? null,
      icon: nwsToIcon(p.icon ?? null, p.shortForecast ?? null),
      precipProb: round(num(p.probabilityOfPrecipitation?.value)),
      humidity: round(num(p.relativeHumidity?.value)),
      windSpeed: round(wind),
      windDir: p.windDirection ?? null,
      isDay: typeof p.isDaytime === 'boolean' ? p.isDaytime : null,
    } satisfies DataRow;
  });

  return finish(def.id, rows, info.attribution);
}

/**
 * NWS point → forecast URL.
 *
 * Two requests, and the first one's answer is cacheable forever in practice: a
 * lat/lon does not change grid cell. It is fetched every poll anyway because
 * caching it correctly means invalidating it when NWS re-grids — which they do,
 * rarely, and which would otherwise strand a source pointing at a dead cell
 * until someone restarted the server. One extra request every fifteen minutes
 * is the cheaper end of that trade.
 */
async function nwsFetch(def: WeatherDataSource): Promise<NwsPeriod[]> {
  const point = `${NWS_BASE}/points/${def.latitude.toFixed(4)},${def.longitude.toFixed(4)}`;
  const pointBody = await fetchText(point, { headers: nwsHeaders(def) });
  if (pointBody.body === null) throw new Error('NWS point lookup returned no body');

  const parsed = JSON.parse(pointBody.body) as {
    properties?: { forecast?: string; forecastHourly?: string };
  };
  const mode: WeatherMode = def.mode ?? 'current';
  const url = mode === 'hourly'
    ? parsed.properties?.forecastHourly
    : parsed.properties?.forecast;

  if (!url) {
    throw new Error(
      `api.weather.gov has no forecast for ${def.latitude},${def.longitude} — NWS covers the US and its territories only`,
    );
  }

  const body = await fetchText(url, { headers: nwsHeaders(def) });
  if (body.body === null) throw new Error('NWS forecast returned no body');
  const forecast = JSON.parse(body.body) as { properties?: { periods?: NwsPeriod[] } };
  return forecast.properties?.periods ?? [];
}

/**
 * NWS refuses anonymous traffic, and asks for a contact address in the UA.
 *
 * From their documentation: *"A User Agent is required to identify your
 * application… the more unique to your application the less likely it will be
 * affected by a security event. If you include contact information (website or
 * email), we can contact you if your string is associated to a security
 * event."* Both halves of that matter, and the second is the sharper one —
 * Breeze's built-in fallback is shared by every install, so a station running
 * on the default is one stranger's misbehaviour away from being throttled with
 * no warning and no way for NWS to reach them.
 *
 * Resolution order is source → server → fallback, so the normal deployment sets
 * `BREEZE_CONTACT` once and every source inherits it.
 */
function nwsHeaders(def: WeatherDataSource): Record<string, string> {
  return {
    'user-agent': userAgent(def.contact),
    accept: 'application/geo+json',
  };
}

/* ------------------------------------------------------- MET Norway */

const MET_BASE = 'https://api.met.no/weatherapi/locationforecast/2.0';

/**
 * `complete`, not `compact`.
 *
 * `compact` carries only temperature, pressure, humidity, cloud cover, wind
 * speed/direction, the symbol code and precipitation amount. Four of the
 * canonical columns — `tempMin`, `tempMax`, `precipProb` and `windGust` — are
 * `complete`-only, and `tempMin`/`tempMax` are what `daily` mode *is*. Taking
 * the smaller payload would mean shipping a provider whose daily mode has no
 * high and no low.
 *
 * Several of those are still absent outside the Nordics — MET's own
 * availability table shows the global (ECMWF) forecast carrying no
 * `probability_of_precipitation` at all, and no gust or UV beyond +60 hours.
 * They come back null, which is exactly what the fixed column set is for.
 */
type MetTimeseries = {
  time?: string;
  data?: {
    instant?: { details?: Record<string, number | undefined> };
    next_1_hours?: MetPeriod;
    next_6_hours?: MetPeriod;
    next_12_hours?: MetPeriod;
  };
};

interface MetPeriod {
  summary?: { symbol_code?: string };
  details?: Record<string, number | undefined>;
}

interface MetPayload {
  properties?: { timeseries?: MetTimeseries[] };
}

/**
 * MET symbol codes → the canonical icon vocabulary.
 *
 * Codes are `<condition>[_day|_night|_polartwilight]`, so the variant suffix is
 * stripped first and only the condition is mapped: a designer's artwork picks
 * day or night from the `isDay` column, not from a second icon name. Intensity
 * prefixes (`light`, `heavy`) collapse the same way the WMO map collapses 61,
 * 63 and 65 — a lower third has one rain icon.
 */
const MET_ICONS: Record<string, WeatherIcon> = {
  clearsky: 'clear',
  fair: 'mostly-clear',
  partlycloudy: 'partly-cloudy',
  cloudy: 'cloudy',
  fog: 'fog',
  lightrain: 'rain', rain: 'rain', heavyrain: 'rain',
  lightrainshowers: 'showers', rainshowers: 'showers', heavyrainshowers: 'showers',
  lightsleet: 'sleet', sleet: 'sleet', heavysleet: 'sleet',
  lightsleetshowers: 'sleet', sleetshowers: 'sleet', heavysleetshowers: 'sleet',
  lightsnow: 'snow', snow: 'snow', heavysnow: 'snow',
  lightsnowshowers: 'snow', snowshowers: 'snow', heavysnowshowers: 'snow',
  lightrainandthunder: 'thunderstorm', rainandthunder: 'thunderstorm',
  heavyrainandthunder: 'thunderstorm',
  lightrainshowersandthunder: 'thunderstorm', rainshowersandthunder: 'thunderstorm',
  heavyrainshowersandthunder: 'thunderstorm',
  lightsleetandthunder: 'thunderstorm', sleetandthunder: 'thunderstorm',
  heavysleetandthunder: 'thunderstorm',
  lightsleetshowersandthunder: 'thunderstorm', sleetshowersandthunder: 'thunderstorm',
  heavysleetshowersandthunder: 'thunderstorm',
  lightsnowandthunder: 'thunderstorm', snowandthunder: 'thunderstorm',
  heavysnowandthunder: 'thunderstorm',
  lightsnowshowersandthunder: 'thunderstorm', snowshowersandthunder: 'thunderstorm',
  heavysnowshowersandthunder: 'thunderstorm',
};

/** Prose for the same codes, so `condition` reads like a forecast. */
const MET_TEXT: Record<string, string> = {
  clearsky: 'Clear', fair: 'Fair', partlycloudy: 'Partly Cloudy', cloudy: 'Cloudy',
  fog: 'Fog',
  lightrain: 'Light Rain', rain: 'Rain', heavyrain: 'Heavy Rain',
  lightrainshowers: 'Light Showers', rainshowers: 'Showers', heavyrainshowers: 'Heavy Showers',
  lightsleet: 'Light Sleet', sleet: 'Sleet', heavysleet: 'Heavy Sleet',
  lightsnow: 'Light Snow', snow: 'Snow', heavysnow: 'Heavy Snow',
  lightsnowshowers: 'Light Snow Showers', snowshowers: 'Snow Showers',
  heavysnowshowers: 'Heavy Snow Showers',
};

/** Strip the `_day` / `_night` / `_polartwilight` variant from a symbol code. */
export function metSymbolBase(code: string | null | undefined): string | null {
  if (!code) return null;
  return code.replace(/_(day|night|polartwilight)$/, '');
}

export function metToIcon(code: string | null | undefined): WeatherIcon {
  const base = metSymbolBase(code);
  if (!base) return 'unknown';
  return MET_ICONS[base] ?? 'unknown';
}

export function metToText(code: string | null | undefined): string | null {
  const base = metSymbolBase(code);
  if (!base) return null;
  return MET_TEXT[base] ?? null;
}

/**
 * Day or night, read off the symbol code rather than computed.
 *
 * MET already decides this — it is the difference between `clearsky_day` and
 * `clearsky_night` — and their answer accounts for polar twilight, which a
 * naive sunrise calculation at 78°N does not. `polartwilight` is neither, so it
 * yields null rather than a coin flip.
 */
export function metIsDay(code: string | null | undefined): boolean | null {
  if (!code) return null;
  if (code.endsWith('_day')) return true;
  if (code.endsWith('_night')) return false;
  return null;
}

export function metToDataSet(def: WeatherDataSource, payload: MetPayload): DataSet {
  const info = WEATHER_PROVIDER_INFO[def.provider];
  const units: WeatherUnits = def.units ?? 'metric';
  const mode: WeatherMode = def.mode ?? 'current';
  const series = payload.properties?.timeseries ?? [];

  /*
   * `daily` reads the 6-hour aggregates, `current`/`hourly` the 1-hour ones.
   *
   * MET's series is hourly for roughly the first two days and then 6-hourly,
   * with `next_1_hours` disappearing at the changeover. A daily mode built on
   * `next_1_hours` would therefore return rows for two days and then stop,
   * which looks like a broken feed rather than a documented boundary.
   */
  const wanted = mode === 'current' ? 1 : clampCount(def.count, DEFAULT_COUNT);
  const step = mode === 'daily' ? 4 : 1;
  const picked = series.filter((_, i) => i % step === 0).slice(0, wanted);

  const rows: DataRow[] = picked.map((entry) => {
    const instant = entry.data?.instant?.details ?? {};
    const period = mode === 'daily'
      ? entry.data?.next_6_hours ?? entry.data?.next_12_hours
      : entry.data?.next_1_hours ?? entry.data?.next_6_hours;
    const details = period?.details ?? {};
    const symbol = period?.summary?.symbol_code
      ?? entry.data?.next_1_hours?.summary?.symbol_code
      ?? entry.data?.next_6_hours?.summary?.symbol_code
      ?? null;

    const tempC = num(instant['air_temperature']);
    const minC = num(details['air_temperature_min']);
    const maxC = num(details['air_temperature_max']);
    const temp = (c: number | null): number | null =>
      c === null ? null : units === 'imperial' ? cToF(c) : c;

    // MET reports wind in m/s. Metric here means km/h — the unit the rest of
    // the adapter uses — so neither branch is a pass-through.
    const windMs = num(instant['wind_speed']);
    const gustMs = num(instant['wind_speed_of_gust']);
    const wind = (ms: number | null): number | null =>
      ms === null ? null : units === 'metric' ? ms * 3.6 : ms * 2.236936;

    const precipMm = num(details['precipitation_amount']);
    const bearing = num(instant['wind_from_direction']);

    return {
      ...blankRow(),
      time: entry.time ?? null,
      temp: round(temp(tempC), 1),
      tempMin: round(temp(minC), 1),
      tempMax: round(temp(maxC), 1),
      condition: metToText(symbol),
      icon: metToIcon(symbol),
      precipProb: round(num(details['probability_of_precipitation'])),
      precipAmount: units === 'imperial'
        ? round(precipMm === null ? null : precipMm / 25.4, 2)
        : round(precipMm, 2),
      windSpeed: round(wind(windMs)),
      windGust: round(wind(gustMs)),
      windDir: bearingToCompass(bearing),
      humidity: round(num(instant['relative_humidity'])),
      pressure: toPressure(units, num(instant['air_pressure_at_sea_level'])),
      uvIndex: round(num(instant['ultraviolet_index_clear_sky']), 1),
      isDay: metIsDay(symbol),
    } satisfies DataRow;
  });

  return finish(def.id, rows, info.attribution);
}

/**
 * MET refuses anonymous traffic, and truncating the coordinates is not optional.
 *
 * From their terms: *"When using requests with latitude/longitude, truncate all
 * coordinates to max 4 decimals… For new products, requests with 5+ decimals
 * will return a 403 Forbidden."* A lat/lon pasted out of Google Maps has six,
 * so without the `toFixed(4)` below the source fails on the first poll and the
 * error says "Forbidden", which reads like an auth problem and is not one.
 */
async function metFetch(def: WeatherDataSource): Promise<MetPayload> {
  const url =
    `${MET_BASE}/complete?lat=${def.latitude.toFixed(4)}&lon=${def.longitude.toFixed(4)}`;

  const result = await fetchText(url, {
    timeoutMs: 15_000,
    headers: { 'user-agent': userAgent(def.contact), accept: 'application/json' },
  });
  if (result.body === null) throw new Error('MET Norway returned no body');
  return JSON.parse(result.body) as MetPayload;
}

/* --------------------------------------------------------- Bright Sky */

const BRIGHTSKY_BASE = 'https://api.brightsky.dev';

/**
 * Bright Sky reports wind in **km/h**, not the SI m/s `dwdparse` emits.
 *
 * Worth stating because getting it wrong is silent and wrong by 3.6×. The
 * evidence is the data: their own documented sample shows Münster at
 * `wind_speed: 12.6` with `wind_gust_speed: 33.5` on an ordinary April day.
 * Read as m/s that is a 45 km/h sustained wind gusting to 120 km/h — a named
 * windstorm, not a Tuesday.
 *
 * So `metric` is a pass-through here and `imperial` divides. If a future
 * Bright Sky release switches to m/s, this constant is the one thing to change.
 */
const BRIGHTSKY_WIND_IS_KMH = true;

interface BrightSkyRecord {
  timestamp?: string;
  temperature?: number | null;
  precipitation?: number | null;
  precipitation_probability?: number | null;
  pressure_msl?: number | null;
  relative_humidity?: number | null;
  wind_speed?: number | null;
  wind_direction?: number | null;
  wind_gust_speed?: number | null;
  cloud_cover?: number | null;
  condition?: string | null;
  icon?: string | null;
  // current_weather reports over 10/30/60-minute windows instead.
  wind_speed_10?: number | null;
  wind_speed_30?: number | null;
  wind_direction_10?: number | null;
  wind_gust_speed_10?: number | null;
  precipitation_10?: number | null;
}

/**
 * Bright Sky icon names → the canonical vocabulary.
 *
 * Theirs is already close to ours, which is the whole reason this map is short
 * and not a judgement call. Day/night variants collapse for the same reason
 * MET's do: `isDay` is its own column.
 */
const BRIGHTSKY_ICONS: Record<string, WeatherIcon> = {
  'clear-day': 'clear',
  'clear-night': 'clear',
  'partly-cloudy-day': 'partly-cloudy',
  'partly-cloudy-night': 'partly-cloudy',
  cloudy: 'cloudy',
  fog: 'fog',
  wind: 'windy',
  rain: 'rain',
  sleet: 'sleet',
  snow: 'snow',
  hail: 'hail',
  thunderstorm: 'thunderstorm',
};

const BRIGHTSKY_TEXT: Record<string, string> = {
  'clear-day': 'Clear', 'clear-night': 'Clear',
  'partly-cloudy-day': 'Partly Cloudy', 'partly-cloudy-night': 'Partly Cloudy',
  cloudy: 'Cloudy', fog: 'Fog', wind: 'Windy', rain: 'Rain',
  sleet: 'Sleet', snow: 'Snow', hail: 'Hail', thunderstorm: 'Thunderstorm',
};

export function brightSkyToIcon(icon: string | null | undefined): WeatherIcon {
  if (!icon) return 'unknown';
  return BRIGHTSKY_ICONS[icon] ?? 'unknown';
}

export function brightSkyToText(icon: string | null | undefined): string | null {
  if (!icon) return null;
  return BRIGHTSKY_TEXT[icon] ?? null;
}

/** Day or night, off the icon suffix — the only place Bright Sky states it. */
export function brightSkyIsDay(icon: string | null | undefined): boolean | null {
  if (!icon) return null;
  if (icon.endsWith('-day')) return true;
  if (icon.endsWith('-night')) return false;
  return null;
}

export function brightSkyToDataSet(def: WeatherDataSource, records: BrightSkyRecord[]): DataSet {
  const info = WEATHER_PROVIDER_INFO[def.provider];
  const units: WeatherUnits = def.units ?? 'metric';
  const mode: WeatherMode = def.mode ?? 'current';

  const wanted = mode === 'current' ? 1 : clampCount(def.count, DEFAULT_COUNT);
  // Daily mode samples one record per 24 hourly rows; Bright Sky has no daily
  // aggregate endpoint, and inventing a min/max here would be a forecast this
  // adapter is not qualified to make.
  const step = mode === 'daily' ? 24 : 1;
  const picked = records.filter((_, i) => i % step === 0).slice(0, wanted);

  const rows: DataRow[] = picked.map((r) => {
    const tempC = num(r.temperature);
    const temp = tempC === null ? null : units === 'imperial' ? cToF(tempC) : tempC;

    // `_10` first: on the current_weather endpoint the plain keys are absent
    // and the 10-minute window is the freshest observation there is.
    const windKmh = num(r.wind_speed ?? r.wind_speed_10 ?? r.wind_speed_30);
    const gustKmh = num(r.wind_gust_speed ?? r.wind_gust_speed_10);
    const wind = (kmh: number | null): number | null => {
      if (kmh === null) return null;
      const asKmh = BRIGHTSKY_WIND_IS_KMH ? kmh : kmh * 3.6;
      return units === 'metric' ? asKmh : asKmh * 0.621371;
    };

    const precipMm = num(r.precipitation ?? r.precipitation_10);
    const bearing = num(r.wind_direction ?? r.wind_direction_10);

    return {
      ...blankRow(),
      time: r.timestamp ?? null,
      temp: round(temp, 1),
      condition: brightSkyToText(r.icon),
      icon: brightSkyToIcon(r.icon),
      precipProb: round(num(r.precipitation_probability)),
      precipAmount: units === 'imperial'
        ? round(precipMm === null ? null : precipMm / 25.4, 2)
        : round(precipMm, 2),
      windSpeed: round(wind(windKmh)),
      windGust: round(wind(gustKmh)),
      windDir: bearingToCompass(bearing),
      humidity: round(num(r.relative_humidity)),
      pressure: toPressure(units, num(r.pressure_msl)),
      isDay: brightSkyIsDay(r.icon),
    } satisfies DataRow;
  });

  return finish(def.id, rows, info.attribution);
}

/**
 * Two endpoints, because "now" and "later" are different products here.
 *
 * `current_weather` is the most recent *observation* from the nearest synop
 * station — which is what a weather bug wants, and is not a forecast. `/weather`
 * returns hourly rows that are MOSMIX forecast once they pass the present. A
 * bug showing "current" conditions from a forecast model is subtly wrong in a
 * way nobody notices until it disagrees with the window.
 */
async function brightSkyFetch(def: WeatherDataSource): Promise<BrightSkyRecord[]> {
  const at = `lat=${def.latitude.toFixed(4)}&lon=${def.longitude.toFixed(4)}`;
  const mode: WeatherMode = def.mode ?? 'current';

  if (mode === 'current') {
    const result = await fetchText(`${BRIGHTSKY_BASE}/current_weather?${at}`, {
      timeoutMs: 15_000,
      headers: { 'user-agent': userAgent(def.contact) },
    });
    if (result.body === null) throw new Error('Bright Sky returned no body');
    const payload = JSON.parse(result.body) as { weather?: BrightSkyRecord };
    if (!payload.weather) {
      throw new Error(
        `Bright Sky has no station near ${def.latitude},${def.longitude} — it covers Germany and its immediate surroundings only`,
      );
    }
    return [payload.weather];
  }

  /*
   * A window, not a single date. `date` alone returns that whole day starting
   * at midnight, so an evening poll in `hourly` mode would hand back rows that
   * are already history. Starting from now is what makes the first row "next".
   */
  const from = new Date();
  const hours = mode === 'daily' ? 24 * clampCount(def.count, DEFAULT_COUNT) : clampCount(def.count, DEFAULT_COUNT);
  const to = new Date(from.getTime() + hours * 3_600_000);

  const url =
    `${BRIGHTSKY_BASE}/weather?${at}` +
    `&date=${encodeURIComponent(from.toISOString())}` +
    `&last_date=${encodeURIComponent(to.toISOString())}` +
    (def.timezone ? `&tz=${encodeURIComponent(def.timezone)}` : '');

  const result = await fetchText(url, {
    timeoutMs: 15_000,
    headers: { 'user-agent': userAgent(def.contact) },
  });
  if (result.body === null) throw new Error('Bright Sky returned no body');

  const payload = JSON.parse(result.body) as { weather?: BrightSkyRecord[] };
  const records = payload.weather ?? [];
  if (records.length === 0) {
    throw new Error(
      `Bright Sky returned no rows for ${def.latitude},${def.longitude} — it covers Germany and its immediate surroundings only`,
    );
  }
  return records;
}

/* ------------------------------------------------------------- dispatch */

export async function weatherToDataSet(def: WeatherDataSource): Promise<DataSet> {
  if (def.provider === 'nws') {
    return nwsToDataSet(def, await nwsFetch(def));
  }

  if (def.provider === 'met-norway') {
    return metToDataSet(def, await metFetch(def));
  }

  if (def.provider === 'brightsky') {
    return brightSkyToDataSet(def, await brightSkyFetch(def));
  }

  const first = await openMeteoFetch(def, false);
  if (!('reason' in first)) return openMeteoToDataSet(def, first.payload);

  /*
   * One retry, without the optional variables. A self-hosted instance pinned to
   * a single model is the case this exists for: it has temperature and wind but
   * not UV, and Open-Meteo fails the whole request rather than the one series.
   * Retrying costs one request on an error path that would otherwise leave the
   * graphic with nothing.
   */
  if (!isVariableError(first.reason)) {
    throw new Error(`Open-Meteo: ${first.reason}`);
  }

  const second = await openMeteoFetch(def, true);
  if ('reason' in second) {
    throw new Error(
      `Open-Meteo: ${second.reason} (retried without optional variables; the model may not cover this location)`,
    );
  }
  return openMeteoToDataSet(def, second.payload);
}

async function openMeteoFetch(
  def: WeatherDataSource,
  lean: boolean,
): Promise<{ payload: OpenMeteoPayload } | { reason: string }> {
  const result = await fetchText(openMeteoUrl(def, { lean }), {
    timeoutMs: 15_000,
    // Open-Meteo does not require identification the way NWS does, but sending
    // it costs nothing and means a self-hosted instance's logs say which
    // station is polling it.
    headers: { 'user-agent': userAgent(def.contact) },
  });
  if (result.body === null) throw new Error('Open-Meteo returned no body');

  const payload = JSON.parse(result.body) as OpenMeteoPayload & {
    error?: boolean;
    reason?: string;
  };
  // Open-Meteo answers 200 with `{error: true, reason}` for a bad request rather
  // than a 4xx, so `response.ok` is not enough to know the call worked.
  if (payload.error) return { reason: payload.reason ?? 'request rejected' };
  return { payload };
}

/** Attribution the operator is obliged to show, or null. Used by the editor. */
export function attributionFor(provider: WeatherProvider): {
  text: string | null;
  url: string | null;
  required: boolean;
} {
  const info = WEATHER_PROVIDER_INFO[provider];
  return {
    text: info.attribution,
    url: info.attributionUrl,
    // NWS output is US-government public domain: crediting is courtesy, not duty.
    required: provider !== 'nws',
  };
}
