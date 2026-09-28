// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Wall-clock time in a named zone — shared by the server's weather and alert
 * readers and the `date` transform (CYCLE.md, Wave 7), which runs in the
 * output page and must agree with them about what "today" is.
 *
 * Intl throughout rather than offset arithmetic: a zone may observe daylight
 * time, and the answer must be the one on a wall clock at the place — Phoenix
 * at 3 pm is the same in January and July, Denver is not.
 */

/** The calendar date and time of day at `zone` (the machine's own when absent or unknown). */
export function localParts(
  zone: string | undefined,
  now: Date,
): { date: string; hour: number; minute: number; second: number } {
  const format = (tz: string | undefined): Intl.DateTimeFormatPart[] =>
    new Intl.DateTimeFormat('en-CA', {
      ...(tz ? { timeZone: tz } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(zone);
  } catch {
    // An unknown zone name reads as the machine's own zone rather than
    // failing; the validators refuse one on save, so this is only reached by
    // a document written by hand.
    parts = format(undefined);
  }
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

/**
 * Milliseconds until the next local midnight at `zone`.
 *
 * Wall-clock arithmetic is safe here: daylight-saving changes happen at 2 am,
 * never between now and the coming midnight.
 */
export function msToLocalMidnight(zone: string | undefined, now: Date): number {
  const { hour, minute, second } = localParts(zone, now);
  return (86_400 - (hour * 3600 + minute * 60 + second)) * 1000 - now.getUTCMilliseconds();
}

/** The zone's offset from UTC at `at`, in minutes — `-420` for Phoenix. */
export function zoneOffsetMinutes(zone: string, at: Date): number {
  const p = localParts(zone, at);
  const [y, mo, d] = p.date.split('-').map(Number) as [number, number, number];
  const asUtc = Date.UTC(y, mo - 1, d, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** An ISO time with an explicit offset or `Z` — as opposed to bare local wall time. */
export const HAS_OFFSET = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/**
 * Parse an ISO time, reading one without an offset as wall time in `zone`.
 *
 * `Date.parse` reads offset-less times in the *machine's* zone, so a server in
 * a UTC container would otherwise move every such time by the zone's offset.
 */
export function parseInZone(iso: string, zone: string | undefined): number {
  if (!iso) return NaN;
  if (HAS_OFFSET.test(iso) || !zone || !/T\d{2}:\d{2}/.test(iso)) return Date.parse(iso);
  const asUtc = Date.parse(`${iso}Z`);
  if (!Number.isFinite(asUtc)) return NaN;
  // Two passes: the offset at the guessed instant, then at the corrected one,
  // so a time just after a DST change lands on the right side of it.
  const first = asUtc - zoneOffsetMinutes(zone, new Date(asUtc)) * 60_000;
  return asUtc - zoneOffsetMinutes(zone, new Date(first)) * 60_000;
}

/** `YYYY-MM-DD` plus `n` days — calendar arithmetic, no zone involved. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * What a cell's date or time value means, or null for anything unreadable.
 *
 * A **date** alone (`2026-09-27`, `9/27/2026`, `20260927`) is a calendar day —
 * it is on the same day in every zone and has no instant. A **time** is an
 * instant: ISO with an offset as written, ISO or `9/27/2026 2:30 PM` without
 * one as wall time in `zone`, and a number (or a string of digits) as epoch
 * milliseconds — seconds when it is too small to be milliseconds.
 *
 * Deliberately strict. The US month-first order is the one Google Sheets and
 * most American exports write; day-first is not guessed at. Nothing is handed
 * to `Date.parse` to guess either: it reads `Sep 27, 2026` in the *machine's*
 * zone, so a UTC playout box would put it on the 26th in Phoenix. A value
 * this does not recognise is dropped from a window rather than misplaced.
 */
export type ReadTime = { date: string; ms?: undefined } | { date: string; ms: number };

/** The largest instant a JavaScript Date can hold, either side of 1970. */
const MAX_MS = 8.64e15;

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i;
const US = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;

/** `YYYY-MM-DD` when the parts name a real day — never the 30th of February. */
function calendarDate(y: number, m: number, d: number): string | null {
  const at = new Date(Date.UTC(y, m - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  return at.toISOString().slice(0, 10);
}

const pad = (n: number): string => String(n).padStart(2, '0');

function instant(ms: number, zone: string | undefined): ReadTime | null {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_MS) return null;
  return { ms, date: localParts(zone, new Date(ms)).date };
}

/** A wall-clock time on a real day, read in `zone`. */
function wallTime(date: string, h: number, mi: number, s: number, frac: string, zone: string | undefined): ReadTime | null {
  if (h > 23 || mi > 59 || s > 59) return null;
  return instant(parseInZone(`${date}T${pad(h)}:${pad(mi)}:${pad(s)}${frac}`, zone), zone);
}

export function readTime(value: unknown, zone: string | undefined): ReadTime | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return instant(Math.abs(value) < 1e11 ? value * 1000 : value, zone);
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  // Eight digits are a compact date (20260927); any other run of digits is epoch time.
  if (/^\d{8}$/.test(text)) {
    const date = calendarDate(Number(text.slice(0, 4)), Number(text.slice(4, 6)), Number(text.slice(6)));
    return date ? { date } : null;
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) return readTime(Number(text), zone);

  const iso = ISO.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi, s, frac, offset] = iso;
    const date = calendarDate(Number(y), Number(mo), Number(d));
    if (!date) return null;
    if (h === undefined) return { date };
    if (!offset) return wallTime(date, Number(h), Number(mi), Number(s ?? 0), frac ?? '', zone);
    if (Number(h) > 23 || Number(mi) > 59 || Number(s ?? 0) > 59) return null;
    const tz = offset.toUpperCase() === 'Z' ? 'Z' : offset.replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
    return instant(Date.parse(`${date}T${pad(Number(h))}:${mi}:${s ?? '00'}${frac ?? ''}${tz}`), zone);
  }

  const us = US.exec(text);
  if (us) {
    const [, mo, d, yRaw, h, mi, s, ampm] = us;
    // Two-digit years: 00–69 are this century, 70–99 the last.
    const y = yRaw!.length === 2 ? (Number(yRaw) < 70 ? 2000 : 1900) + Number(yRaw) : Number(yRaw);
    const date = calendarDate(y, Number(mo), Number(d));
    if (!date) return null;
    if (h === undefined) return { date };
    let hour = Number(h);
    if (ampm) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
    }
    return wallTime(date, hour, Number(mi), Number(s ?? 0), '', zone);
  }

  return null;
}
