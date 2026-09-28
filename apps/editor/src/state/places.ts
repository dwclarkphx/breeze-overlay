// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The data panel's typed list of places (Phase 8.6 Wave 3), one per line.
 *
 * Kept out of the component so it can be tested without a DOM, and because
 * the reading rule — name first, then the first number — is the kind of thing
 * that breaks quietly.
 */

import type { PlaceRef } from '@breeze/schema';

/** `coordinates` — weather and CAMS; `area` — AirNow reporting areas. */
export type PlaceKind = 'coordinates' | 'area';

const isNumber = (s: string): boolean => s !== '' && Number.isFinite(Number(s));
const isArea = (s: string): boolean => /^\d{1,6}$/.test(s);

/**
 * `Phoenix, AZ, 33.4484, -112.0740, PHX, KPHX` → a place.
 *
 * Read from the first number, not by position: a place name has a comma in it
 * as often as not ("Phoenix, AZ"), so the name is everything before the first
 * coordinate (or area id), and what follows is key, then station.
 */
export function parsePlaceLine(line: string, kind: PlaceKind): PlaceRef | null {
  const parts = line.split(',').map((p) => p.trim());
  const first = parts.findIndex(kind === 'area' ? isArea : isNumber);
  if (first <= 0) return null;
  const name = parts.slice(0, first).join(', ').trim();
  if (!name) return null;
  const place: PlaceRef = { name };
  let rest: string[];
  if (kind === 'area') {
    place.area = parts[first]!;
    rest = parts.slice(first + 1);
  } else {
    const lat = parts[first]!;
    const lon = parts[first + 1] ?? '';
    if (!isNumber(lon)) return null;
    place.latitude = Number(lat);
    place.longitude = Number(lon);
    rest = parts.slice(first + 2);
  }
  if (rest[0]) place.key = rest[0];
  if (rest[1] && kind === 'coordinates') place.station = rest[1].toUpperCase();
  return place;
}

/** The inverse, for showing a saved list back in the box. */
export function placeLine(place: PlaceRef, kind: PlaceKind): string {
  const head = kind === 'area'
    ? [place.name, place.area ?? '']
    : [place.name, String(place.latitude ?? ''), String(place.longitude ?? '')];
  // The station only means something for coordinate places (NWS observed).
  const station = kind === 'area' ? undefined : place.station;
  const tail = [place.key, station].map((v) => v ?? '');
  while (tail.length && !tail[tail.length - 1]) tail.pop();
  return [...head, ...tail].join(', ');
}
