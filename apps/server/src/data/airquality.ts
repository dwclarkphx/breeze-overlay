// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Air quality (Phase 8.6 Wave 3 — CYCLE.md): AirNow's EnviroFlash feeds, and
 * CAMS through Open-Meteo, onto one column set.
 *
 * **AirNow via EnviroFlash.** The public RSS feeds per reporting area —
 * `rss/realtime/<id>.xml` for observations, `rss/forecast/<id>.xml` for the
 * agency's forecast. No key. The data sits in an HTML fragment inside each
 * item's description, so this is a reader of that fragment's prose:
 *
 *     Moderate  - 71 AQI - Ozone
 *     Today, 09/27/2026: Good  - 45 AQI - Ozone
 *
 * Two things about it are load-bearing:
 *
 *  - **The data-use guidelines.** AirNow's terms (which cover these feeds —
 *    see AIR_QUALITY_PROVIDER_INFO) forbid altering values, forecasts or
 *    advisory text. So the category name and pollutant name are the feed's own
 *    words, passed through; the number is not rounded or recomputed; the only
 *    thing *derived* is the band colour, looked up from the category the feed
 *    stated. Observations are marked preliminary; the agency is credited first.
 *  - **The timestamps.** The feeds' machine-readable dates are not trustworthy
 *    (the CAP feed stamps one moment three different ways). The prose time
 *    with its named zone — `09/27/26 7:00 AM MST` — is the one that is right,
 *    so that is what is parsed, and a reading dated in the future is treated as
 *    having no time at all rather than believed.
 *
 * **CAMS via Open-Meteo.** A model, not a monitor: global where AirNow is US
 * only, and the fallback for anywhere without a reporting area. Hosted is
 * non-commercial (gated in the editor like the weather provider); self-hosted
 * is not.
 */

import {
  AIR_QUALITY_COLUMNS,
  AIR_QUALITY_PROVIDER_INFO,
  AQI_CATEGORIES,
  AQI_SCALE_NAMES,
  DEFAULT_AIR_QUALITY_EXPIRY,
  aqiCategory,
  conform,
  type AirQualityDataSource,
  type AirQualityMode,
  type AqiScale,
  type DataRow,
  type DataSet,
  type PlaceRef,
} from '@breeze/schema';

import { fetchText, userAgent } from './fetch.js';
import { eachPlace, localParts, placesOf, tagRows, type LoadResult, type PlaceContext } from './places.js';
import { childNamed, childrenNamed, childText, parseXml } from './xml.js';

const ENVIROFLASH_BASE = 'https://feeds.enviroflash.info/rss';
const OPEN_METEO_AQ_HOSTED = 'https://air-quality-api.open-meteo.com';

/** Forecast days when the def does not say. AirNow's feeds carry up to about four. */
const DEFAULT_DAYS = 3;
const MAX_DAYS = 7;

/** A reading dated more than this far ahead is not believed. */
const FUTURE_TOLERANCE_MS = 15 * 60_000;

function blankRow(): DataRow {
  const row: DataRow = {};
  for (const col of AIR_QUALITY_COLUMNS) row[col.key] = null;
  return row;
}

/* ----------------------------------------------------------- prose parsing */

/**
 * An HTML fragment → its lines of text.
 *
 * The fragment's own newlines are indentation, not structure — the structure
 * is `<br>` and `<div>` — so whitespace is collapsed first and line breaks are
 * put back only where the markup breaks a line.
 */
export function htmlLines(html: string): string[] {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/<br\s*\/?>|<\/?div\b[^>]*>|<\/?tr\b[^>]*>|<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * US zone abbreviations → UTC offset in minutes.
 *
 * The feeds name the zone in the prose (`MST`, `CDT`), and the abbreviation is
 * the reliable part: it says standard or daylight, which the offsets the same
 * feeds print elsewhere get wrong.
 */
const ZONE_OFFSETS: Record<string, number> = {
  UTC: 0, GMT: 0,
  AST: -240, ADT: -180,
  EST: -300, EDT: -240,
  CST: -360, CDT: -300,
  MST: -420, MDT: -360,
  PST: -480, PDT: -420,
  AKST: -540, AKDT: -480,
  HST: -600, HDT: -540,
  SST: -660, CHST: 600,
};

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * `09/27/26 7:00 AM MST` → `2026-09-27T07:00:00-07:00`, or null.
 *
 * An unknown zone abbreviation gives null rather than a guess: a reading an
 * hour off in either direction would misstate how current it is, and how
 * current it is is the one thing the terms insist on.
 */
export function parseProseTime(text: string): string | null {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s+([A-Za-z]{2,5})\b/i.exec(text);
  if (!m) return null;
  const [, mo, da, yr, hh, mm, ampm, zone] = m;
  const offset = ZONE_OFFSETS[zone!.toUpperCase()];
  if (offset === undefined) return null;
  const year = yr!.length === 2 ? 2000 + Number(yr) : Number(yr);
  let hour = Number(hh) % 12;
  if (ampm!.toUpperCase() === 'PM') hour += 12;
  const pad = (n: number | string): string => String(n).padStart(2, '0');
  return `${year}-${pad(mo!)}-${pad(da!)}T${pad(hour)}:${mm}:00${offsetText(offset)}`;
}

/** `09/28/2026` → `2026-09-28`. */
function usDate(text: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!m) return null;
  return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}

export interface AirNowReading {
  category: string;
  aqi: number | null;
  pollutant: string;
}

export interface AirNowCurrent {
  location: string | null;
  agency: string | null;
  /** ISO time from the prose, or null. */
  time: string | null;
  readings: AirNowReading[];
}

export interface AirNowForecastDay {
  period: string;
  date: string | null;
  category: string;
  aqi: number | null;
  pollutant: string | null;
}

/** `Moderate  - 71 AQI - Ozone`. The AQI part is optional: some agencies forecast a category only. */
const READING = /^(.+?)\s+-\s+(?:(\d+)\s+AQI\s+-\s+)?(.+)$/i;

function descriptionOf(xml: string): { title: string; html: string } {
  const root = parseXml(xml);
  if (!root) throw new Error('no XML in the response — is this an EnviroFlash RSS feed?');
  const channel = root.local.toLowerCase() === 'rss' ? childNamed(root, 'channel') : root;
  const item = channel ? childrenNamed(channel, 'item')[0] : undefined;
  if (!item) throw new Error('the feed has no item — the reporting area may not publish this product');
  return { title: childText(item, 'title'), html: childText(item, 'description') };
}

const labelled = (lines: string[], label: string): string | null => {
  const line = lines.find((l) => l.toLowerCase().startsWith(`${label.toLowerCase()}:`));
  return line ? line.slice(label.length + 1).trim() || null : null;
};

export function parseAirNowCurrent(xml: string): AirNowCurrent {
  const { html } = descriptionOf(xml);
  const lines = htmlLines(html);
  const readings: AirNowReading[] = [];
  let time: string | null = null;

  for (const line of lines) {
    time ??= line.toLowerCase().startsWith('last update') ? null : parseProseTime(line);
    if (!/\bAQI\b/i.test(line)) continue;
    if (/^(location|agency|last update)\b/i.test(line)) continue;
    // Should the label, the time and a reading ever share a line, the reading
    // is what follows them — never "Current Air Quality: Moderate".
    const text = line
      .replace(/^current air quality:\s*/i, '')
      .replace(/^\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*(AM|PM)\s+[A-Za-z]{2,5}\s*/i, '');
    const m = READING.exec(text);
    if (!m) continue;
    readings.push({ category: m[1]!.trim(), aqi: m[2] ? Number(m[2]) : null, pollutant: m[3]!.trim() });
  }

  return { location: labelled(lines, 'Location'), agency: labelled(lines, 'Agency'), time, readings };
}

/**
 * The feed's own zone, from its `Last Update: Sun, 27 Sep 2026 07:15:03 MST`
 * line, as an offset in minutes — or null. What "today" means for a forecast
 * is the reporting area's today, and this is the one place the feed says
 * which zone that is.
 */
export function feedOffset(xml: string): number | null {
  const { html } = descriptionOf(xml);
  const line = htmlLines(html).find((l) => /^last update/i.test(l));
  const zone = line ? /\b([A-Za-z]{2,5})\s*$/.exec(line)?.[1] : undefined;
  const offset = zone ? ZONE_OFFSETS[zone.toUpperCase()] : undefined;
  return offset ?? null;
}

/** Today's date at a UTC offset. */
function dateAtOffset(now: Date, offsetMinutes: number): string {
  return new Date(now.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function parseAirNowForecast(xml: string): { location: string | null; agency: string | null; days: AirNowForecastDay[] } {
  const { html } = descriptionOf(xml);
  const lines = htmlLines(html);
  const days: AirNowForecastDay[] = [];

  for (const line of lines) {
    // `Tomorrow, 09/28/2026: Good  - 41 AQI - Ozone`
    const m = /^([^,:]+),\s*(\d{1,2}\/\d{1,2}\/\d{4}):\s*(.+)$/.exec(line);
    if (!m) continue;
    const reading = READING.exec(m[3]!.trim());
    days.push({
      period: m[1]!.trim(),
      date: usDate(m[2]!),
      category: (reading ? reading[1]! : m[3]!).trim(),
      aqi: reading?.[2] ? Number(reading[2]) : null,
      pollutant: reading ? reading[3]!.trim() : null,
    });
  }

  return { location: labelled(lines, 'Location'), agency: labelled(lines, 'Agency'), days };
}

/* ------------------------------------------------------------- AirNow rows */

/** The band for a category the feed named; the number only when the name is unfamiliar. */
function bandFor(category: string, aqi: number | null): { index: number; color: string } | null {
  const named = AQI_CATEGORIES.us.find((b) => b.name.toLowerCase() === category.trim().toLowerCase());
  const band = named ?? aqiCategory('us', aqi);
  return band ? { index: band.index, color: band.color } : null;
}

/** Credit as the guidelines order it: the reporting agency first, then AirNow. */
export function airNowCredit(agency: string | null): string {
  return agency ? `${agency} and the EPA AirNow program` : 'EPA AirNow program';
}

function airNowRow(
  reading: AirNowReading,
  base: { time: string | null; age: number | null; agency: string | null; preliminary: boolean },
): DataRow {
  const band = bandFor(reading.category, reading.aqi);
  return {
    ...blankRow(),
    time: base.time,
    aqi: reading.aqi,
    category: reading.category || null,
    categoryIndex: band?.index ?? null,
    color: band?.color ?? null,
    pollutant: reading.pollutant || null,
    scale: AQI_SCALE_NAMES.us,
    preliminary: base.preliminary,
    ageMinutes: base.age,
    agency: base.agency,
    attribution: airNowCredit(base.agency),
  };
}

/**
 * Observation rows for one reporting area.
 *
 * `current` keeps the highest reading — that is the overall AQI by the EPA's
 * definition, a selection among the published values rather than a new one.
 * A reading older than `expireAfter` keeps its row (place, time, age, credit)
 * but loses its values: the feed has stopped updating, and the terms allow
 * only current data on air.
 */
export function airNowCurrentRows(
  parsed: AirNowCurrent,
  mode: AirQualityMode,
  now: Date,
  expireAfter: number,
): DataRow[] {
  let time = parsed.time;
  let age: number | null = null;
  if (time) {
    const at = Date.parse(time);
    if (!Number.isFinite(at) || at - now.getTime() > FUTURE_TOLERANCE_MS) time = null;
    else age = Math.max(0, Math.floor((now.getTime() - at) / 60_000));
  }
  /*
   * Fail closed. A reading whose time could not be read — missing, an unknown
   * zone, or dated in the future — cannot be shown to be current, and current
   * is the one thing the terms insist on. So it is blank, like a stale one,
   * rather than trusted indefinitely.
   */
  const stale = age === null || age * 60 > expireAfter;
  const base = { time, age, agency: parsed.agency, preliminary: true };

  const readings = stale ? [] : parsed.readings;
  if (readings.length === 0) {
    return [airNowRow({ category: '', aqi: null, pollutant: '' }, base)];
  }
  if (mode === 'pollutants') return readings.map((r) => airNowRow(r, base));

  const top = readings.reduce((best, r) => ((r.aqi ?? -1) > (best.aqi ?? -1) ? r : best));
  return [airNowRow(top, base)];
}

/**
 * Forecast rows, from today on.
 *
 * `today` is the reporting area's date; days before it are dropped, so a feed
 * that has stopped updating cannot keep presenting yesterday as "Today". An
 * unknown `today` keeps everything rather than guessing.
 */
export function airNowForecastRows(
  parsed: ReturnType<typeof parseAirNowForecast>,
  count: number,
  today: string | null = null,
): DataRow[] {
  const current = parsed.days.filter((day) => today === null || day.date === null || day.date >= today);
  return current.slice(0, count).map((day) => {
    const band = bandFor(day.category, day.aqi);
    return {
      ...blankRow(),
      time: day.date,
      period: day.period,
      aqi: day.aqi,
      category: day.category || null,
      categoryIndex: band?.index ?? null,
      color: band?.color ?? null,
      pollutant: day.pollutant,
      scale: AQI_SCALE_NAMES.us,
      // A forecast is not an observation; "preliminary" is the observations' label.
      preliminary: false,
      agency: parsed.agency,
      attribution: airNowCredit(parsed.agency),
    };
  });
}

async function airNowFetch(def: AirQualityDataSource, area: string, product: 'realtime' | 'forecast'): Promise<string> {
  if (!/^\d{1,6}$/.test(area)) throw new Error(`"${area}" is not an AirNow reporting-area id (a number, like 111)`);
  const result = await fetchText(`${ENVIROFLASH_BASE}/${product}/${area}.xml`, {
    timeoutMs: 15_000,
    headers: { 'user-agent': userAgent(def.contact), accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.5' },
  });
  if (result.body === null) throw new Error('EnviroFlash returned no body');
  return result.body;
}

/* --------------------------------------------------------- Open-Meteo CAMS */

/** Sub-index variables per scale, with the pollutant names AirNow uses — one vocabulary for both providers. */
const SUB_INDICES: Record<AqiScale, Array<[string, string]>> = {
  us: [
    ['us_aqi_ozone', 'Ozone'],
    ['us_aqi_pm2_5', 'Particle Pollution (2.5 microns)'],
    ['us_aqi_pm10', 'Particle Pollution (10 microns)'],
    ['us_aqi_nitrogen_dioxide', 'Nitrogen Dioxide'],
    ['us_aqi_sulphur_dioxide', 'Sulfur Dioxide'],
    ['us_aqi_carbon_monoxide', 'Carbon Monoxide'],
  ],
  eu: [
    ['european_aqi_ozone', 'Ozone'],
    ['european_aqi_pm2_5', 'Particle Pollution (2.5 microns)'],
    ['european_aqi_pm10', 'Particle Pollution (10 microns)'],
    ['european_aqi_nitrogen_dioxide', 'Nitrogen Dioxide'],
    ['european_aqi_sulphur_dioxide', 'Sulfur Dioxide'],
  ],
};

const OVERALL: Record<AqiScale, string> = { us: 'us_aqi', eu: 'european_aqi' };

interface OpenMeteoAqPayload {
  current?: Record<string, unknown>;
  hourly?: Record<string, unknown[]>;
  utc_offset_seconds?: number;
  error?: boolean;
  reason?: string;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function openMeteoAqUrl(def: AirQualityDataSource, latitude: number, longitude: number): string {
  const info = AIR_QUALITY_PROVIDER_INFO[def.provider];
  const base = info.needsBaseUrl ? (def.baseUrl ?? '').replace(/\/+$/, '') : OPEN_METEO_AQ_HOSTED;
  if (!base) throw new Error('self-hosted Open-Meteo needs a baseUrl');
  const scale: AqiScale = def.scale ?? 'us';
  const vars = [OVERALL[scale], ...SUB_INDICES[scale].map(([key]) => key)].join(',');
  const params = new URLSearchParams({
    latitude: latitude.toFixed(4),
    longitude: longitude.toFixed(4),
    timezone: def.timezone?.trim() || 'auto',
  });
  if ((def.mode ?? 'current') === 'forecast') {
    params.set('hourly', vars);
    params.set('forecast_days', String(Math.min(MAX_DAYS, clampDays(def.count))));
  } else {
    params.set('current', vars);
  }
  return `${base}/v1/air-quality?${params.toString()}`;
}

function clampDays(count: number | undefined): number {
  if (count === undefined || !Number.isFinite(count)) return DEFAULT_DAYS;
  return Math.max(1, Math.min(MAX_DAYS, Math.floor(count)));
}

/** The highest sub-index at one sample — the pollutant driving the overall value. */
function leading(scale: AqiScale, at: (key: string) => number | null): string | null {
  let best: [string, number] | null = null;
  for (const [key, name] of SUB_INDICES[scale]) {
    const v = at(key);
    if (v !== null && (best === null || v > best[1])) best = [name, v];
  }
  return best ? best[0] : null;
}

function camsRow(
  def: AirQualityDataSource,
  scale: AqiScale,
  values: { time: string | null; aqi: number | null; pollutant: string | null; period?: string | null; age?: number | null },
): DataRow {
  const info = AIR_QUALITY_PROVIDER_INFO[def.provider];
  const aqi = values.aqi === null ? null : Math.round(values.aqi);
  const band = aqiCategory(scale, aqi);
  return {
    ...blankRow(),
    time: values.time,
    period: values.period ?? null,
    aqi,
    category: band?.name ?? null,
    categoryIndex: band?.index ?? null,
    color: band?.color ?? null,
    pollutant: values.pollutant,
    scale: AQI_SCALE_NAMES[scale],
    // A model forecast, not a monitor's reading.
    preliminary: false,
    ageMinutes: values.age ?? null,
    attribution: info.attribution,
  };
}

export function openMeteoAqRows(def: AirQualityDataSource, payload: OpenMeteoAqPayload, now: Date): DataRow[] {
  const scale: AqiScale = def.scale ?? 'us';
  const mode: AirQualityMode = def.mode ?? 'current';

  if (mode !== 'forecast') {
    const c = payload.current ?? {};
    const time = typeof c['time'] === 'string' ? c['time'] : null;
    // `current.time` is local wall time with no offset; the payload says the offset.
    const at = time ? Date.parse(`${time}Z`) - (payload.utc_offset_seconds ?? 0) * 1000 : NaN;
    const age = Number.isFinite(at) ? Math.max(0, Math.floor((now.getTime() - at) / 60_000)) : null;
    if (mode === 'pollutants') {
      return SUB_INDICES[scale].map(([key, name]) =>
        camsRow(def, scale, { time, aqi: num(c[key]), pollutant: name, age }),
      );
    }
    return [camsRow(def, scale, { time, aqi: num(c[OVERALL[scale]]), pollutant: leading(scale, (k) => num(c[k])), age })];
  }

  /*
   * Forecast: the day's highest hour, and the pollutant driving it at that
   * hour. A daily AQI forecast is a daily *maximum* by convention — the number
   * for the worst part of the day, which is what anyone planning around it
   * needs.
   */
  const hourly = payload.hourly ?? {};
  const times = Array.isArray(hourly['time']) ? hourly['time'] : [];
  const series = (key: string, i: number): number | null => num(Array.isArray(hourly[key]) ? hourly[key][i] : undefined);
  const byDate = new Map<string, { aqi: number; i: number }>();
  times.forEach((t, i) => {
    if (typeof t !== 'string') return;
    const aqi = series(OVERALL[scale], i);
    if (aqi === null) return;
    const date = t.slice(0, 10);
    const best = byDate.get(date);
    if (!best || aqi > best.aqi) byDate.set(date, { aqi, i });
  });

  return [...byDate.entries()].slice(0, clampDays(def.count)).map(([date, { aqi, i }]) =>
    camsRow(def, scale, { time: date, aqi, pollutant: leading(scale, (k) => series(k, i)) }),
  );
}

async function openMeteoAqFetch(def: AirQualityDataSource, latitude: number, longitude: number): Promise<OpenMeteoAqPayload> {
  const result = await fetchText(openMeteoAqUrl(def, latitude, longitude), {
    timeoutMs: 15_000,
    headers: { 'user-agent': userAgent(def.contact) },
  });
  if (result.body === null) throw new Error('Open-Meteo returned no body');
  const payload = JSON.parse(result.body) as OpenMeteoAqPayload;
  // Answers 200 with `{error: true, reason}` for a bad request, like the weather API.
  if (payload.error) throw new Error(`Open-Meteo: ${payload.reason ?? 'request rejected'}`);
  return payload;
}

/* ---------------------------------------------------------------- dispatch */

/** `expireAfter`, with AirNow's default when the def does not say. */
export function airQualityExpiry(def: AirQualityDataSource): number {
  return def.expireAfter ?? DEFAULT_AIR_QUALITY_EXPIRY;
}

async function placeRows(def: AirQualityDataSource, place: PlaceRef, now: Date): Promise<{ rows: DataRow[]; location: string | null }> {
  const mode: AirQualityMode = def.mode ?? 'current';

  if (def.provider === 'airnow-feed') {
    if (!place.area) throw new Error(`no AirNow area id for ${place.name}`);
    if (mode === 'forecast') {
      const xml = await airNowFetch(def, place.area, 'forecast');
      const parsed = parseAirNowForecast(xml);
      const offset = feedOffset(xml);
      const today = def.timezone?.trim()
        ? localParts(def.timezone.trim(), now).date
        : offset !== null ? dateAtOffset(now, offset) : null;
      return { rows: airNowForecastRows(parsed, clampDays(def.count), today), location: parsed.location };
    }
    const parsed = parseAirNowCurrent(await airNowFetch(def, place.area, 'realtime'));
    return { rows: airNowCurrentRows(parsed, mode, now, airQualityExpiry(def)), location: parsed.location };
  }

  if (place.latitude === undefined || place.longitude === undefined) {
    throw new Error(`no latitude/longitude for ${place.name}`);
  }
  const payload = await openMeteoAqFetch(def, place.latitude, place.longitude);
  return { rows: openMeteoAqRows(def, payload, now), location: null };
}

export async function loadAirQuality(def: AirQualityDataSource, ctx: PlaceContext = {}): Promise<LoadResult> {
  const now = ctx.now ?? new Date();
  const places = placesOf(def, ctx);
  const finish = (rows: DataRow[]): DataSet => ({
    id: def.id,
    columns: AIR_QUALITY_COLUMNS,
    rows: conform(rows, AIR_QUALITY_COLUMNS),
  });

  if (!places) {
    const one: PlaceRef = {
      name: def.place?.trim() || '',
      ...(def.area !== undefined ? { area: def.area } : {}),
      ...(def.latitude !== undefined ? { latitude: def.latitude } : {}),
      ...(def.longitude !== undefined ? { longitude: def.longitude } : {}),
    };
    const { rows, location } = await placeRows(def, one, now);
    // A one-area AirNow source with no name of its own is labelled by the
    // feed's own Location line — "Phoenix, AZ" — which is the agency's name
    // for the area and the right thing to put on screen.
    return { data: finish(tagRows(rows, one.name || location, null)) };
  }

  const { rows, warning } = await eachPlace(
    places,
    async (place) => (await placeRows(def, place, now)).rows,
    ctx.prior,
    (row) => keepAirQualityRow(def, row, now),
  );
  return { data: finish(rows), ...(warning ? { warning } : {}) };
}

/**
 * Whether a failing place's last-good row may stay on air.
 *
 * An observation only while it is younger than the expiry — measured from its
 * own time, not from the last fetch, since the other places keep the source's
 * fetches succeeding. A forecast row only while its day has not ended
 * anywhere (twelve hours behind UTC is the latest any US zone runs).
 */
function keepAirQualityRow(def: AirQualityDataSource, row: DataRow, now: Date): boolean {
  const time = typeof row['time'] === 'string' ? row['time'] : null;
  if ((def.mode ?? 'current') === 'forecast') {
    return time === null || time >= dateAtOffset(now, -12 * 60);
  }
  if (row['aqi'] === null) return true;
  const at = time ? Date.parse(time) : NaN;
  return Number.isFinite(at) && now.getTime() - at <= airQualityExpiry(def) * 1000;
}
