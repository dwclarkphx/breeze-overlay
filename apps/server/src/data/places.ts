// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * One source, many places (Phase 8.6 Wave 3 — CYCLE.md).
 *
 * The weather and air-quality adapters fetch one place at a time — no provider
 * here takes a list — so a statewide rotation is a loop. What this module owns
 * is everything around the loop that must not differ between the two:
 *
 *  - **A failing place keeps its last-good rows.** Rule 1 of the registry,
 *    applied per place: Flagstaff's gridpoint timing out must not blank
 *    Phoenix, and must not blank Flagstaff either while an older forecast for
 *    it is still in hand. The source reports a *warning*, not an error — it is
 *    working, and the editor should say so.
 *  - **Every row says which place it is about**, in `place` and `placeKey`, so
 *    a table can page through the cities with a Cycle keyed on either.
 *  - **Politeness.** A few places at a time, never the whole list at once: the
 *    providers are public services, and forty simultaneous requests from one
 *    station is the pattern their abuse detection is built to catch.
 */

import { HAS_OFFSET, localParts, type DataRow, type DataSet, type PlaceRef } from '@breeze/schema';

/** What the registry hands an adapter beyond the def itself. */
export interface PlaceContext {
  /** Places resolved from a `placesFrom` table. Undefined when the table has not loaded. */
  places?: PlaceRef[] | undefined;
  /** The source's current rows — where a failing place's last-good rows come from. */
  prior?: DataSet | undefined;
  /** Injected in tests; defaults to the wall clock. */
  now?: Date | undefined;
}

export interface LoadResult {
  data: DataSet;
  /** Set when some places failed and kept their last-good rows. */
  warning?: string;
}

/** Requests in flight at once across a many-place fetch. */
const CONCURRENCY = 3;

/**
 * The places a def reports on, or null for a one-place def.
 *
 * A `placesFrom` table that has not loaded yet is an error rather than an
 * empty list: an empty list would ingest zero rows and blank a graphic that
 * was showing last-good weather a moment ago, which is exactly what rule 1
 * forbids. Throwing leaves the rows alone and puts the reason in the status.
 */
export function placesOf(
  def: { places?: PlaceRef[]; placesFrom?: { source: string } },
  ctx: PlaceContext,
): PlaceRef[] | null {
  if (def.places) return def.places;
  if (def.placesFrom) {
    const places = ctx.places;
    if (!places) throw new Error(`the places table "${def.placesFrom.source}" has not loaded yet`);
    if (places.length === 0) {
      throw new Error(`the places table "${def.placesFrom.source}" has no rows with a name`);
    }
    return places;
  }
  return null;
}

/** Stamp a place onto rows. */
export function tagRows(rows: DataRow[], name: string | null, key: string | null): DataRow[] {
  return rows.map((row) => ({ ...row, place: name, placeKey: key }));
}

/**
 * Fetch every place, a few at a time, falling back per place.
 *
 * Throws when *every* place failed, whatever last-good rows exist: nothing new
 * arrived, so this is a failed fetch — the registry keeps what it had, counts
 * the failure, backs off, and lets `expireAfter` run. Treating an outage as a
 * success with a warning would reset all three. With one place, the original
 * error is rethrown untouched so the message the editor shows is the
 * provider's own, not a summary of a list of one.
 *
 * `keep` decides whether a failing place's last-good rows are still fit to
 * show — an AirNow reading past its expiry is not, however fresh the other
 * places are.
 */
export async function eachPlace(
  places: PlaceRef[],
  fetchPlace: (place: PlaceRef) => Promise<DataRow[]>,
  prior: DataSet | undefined,
  keep: (row: DataRow) => boolean = () => true,
): Promise<{ rows: DataRow[]; warning?: string }> {
  const results: Array<{ rows: DataRow[] } | { error: unknown }> = new Array(places.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= places.length) return;
      const place = places[i]!;
      try {
        results[i] = { rows: tagRows(await fetchPlace(place), place.name, place.key ?? null) };
      } catch (error) {
        results[i] = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, places.length) }, worker));

  const rows: DataRow[] = [];
  const kept: string[] = [];
  const missing: string[] = [];
  let firstError: unknown;

  results.forEach((result, i) => {
    const place = places[i]!;
    if ('rows' in result) {
      rows.push(...result.rows);
      return;
    }
    firstError ??= result.error;
    const reason = result.error instanceof Error ? result.error.message : String(result.error);
    // Keyed on the name, not the index: the table can be reordered between
    // fetches, and Phoenix's old rows must not come back labelled Tucson.
    const lastGood = (prior?.rows ?? []).filter((row) => row['place'] === place.name && keep(row));
    if (lastGood.length > 0) {
      rows.push(...lastGood);
      kept.push(`${place.name} (${reason})`);
    } else {
      missing.push(`${place.name} (${reason})`);
    }
  });

  const failed = kept.length + missing.length;
  if (failed === places.length) {
    if (places.length === 1) throw firstError;
    throw new Error(`every place failed — ${[...kept, ...missing].join('; ')}`);
  }

  if (failed === 0) return { rows };
  const parts: string[] = [];
  if (kept.length) parts.push(`showing last-good rows for ${kept.join('; ')}`);
  if (missing.length) parts.push(`no data yet for ${missing.join('; ')}`);
  return { rows, warning: `${failed} of ${places.length} places failed: ${parts.join('; ')}` };
}

/* ------------------------------------------------------------ local time */

/*
 * Moved to `@breeze/schema` (`time.ts`) in Wave 7, so the output page's `date`
 * transform reads "today" exactly as these readers do. Re-exported here so
 * nothing that imported them from this module has to change.
 */
export { HAS_OFFSET, localParts, msToLocalMidnight, parseInZone, zoneOffsetMinutes } from '@breeze/schema';

/**
 * The local calendar date a row's `time` falls on.
 *
 * Providers write time three ways: a bare date (Open-Meteo daily), local wall
 * time with no offset (Open-Meteo hourly) — whose first ten characters already
 * are the local date — and a time with an offset or `Z` (NWS, MET, Bright
 * Sky), which is moved into the place's zone first. NWS's offset already *is*
 * the place's, so moving it changes nothing; Bright Sky's `+00:00` is not.
 */
export function rowDate(time: unknown, zone: string | undefined): string | null {
  if (typeof time !== 'string' || time.length < 10) return null;
  if (!HAS_OFFSET.test(time)) return time.slice(0, 10);
  // No zone known: the server's own, as the rest of the start-tomorrow rule uses.
  const at = new Date(time);
  if (Number.isNaN(at.getTime())) return null;
  return localParts(zone, at).date;
}

/**
 * Drop today's rows once the local hour has passed `after`.
 *
 * Applied before the row count is taken, so "five days starting tomorrow"
 * still means five.
 */
export function startTomorrow(
  rows: DataRow[],
  after: number | undefined,
  zone: string | undefined,
  now: Date,
): DataRow[] {
  if (after === undefined) return rows;
  const local = localParts(zone, now);
  if (local.hour < after) return rows;
  return rows.filter((row) => rowDate(row['time'], zone) !== local.date);
}
