// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import { parsePlaceLine, placeLine } from '../state/places.js';

describe('typed place lines', () => {
  it('reads a name with a comma in it, up to the first number', () => {
    expect(parsePlaceLine('Phoenix, AZ, 33.4484, -112.0740, PHX, kphx', 'coordinates')).toEqual({
      name: 'Phoenix, AZ',
      latitude: 33.4484,
      longitude: -112.074,
      key: 'PHX',
      station: 'KPHX',
    });
    expect(parsePlaceLine('Phoenix, AZ, 111, PHX', 'area')).toEqual({ name: 'Phoenix, AZ', area: '111', key: 'PHX' });
  });

  it('refuses a line with no name or half a coordinate', () => {
    expect(parsePlaceLine('33.4, -112.0', 'coordinates')).toBeNull();
    expect(parsePlaceLine('Phoenix, 33.4', 'coordinates')).toBeNull();
    expect(parsePlaceLine('', 'area')).toBeNull();
  });

  it('writes a place back the way it reads', () => {
    const lines = ['Phoenix, AZ, 33.4484, -112.074, PHX, KPHX', 'Yuma, 32.69, -114.62', 'Flagstaff, 35.19, -111.65, , KFLG'];
    for (const line of lines) {
      expect(placeLine(parsePlaceLine(line, 'coordinates')!, 'coordinates')).toBe(line);
    }
    expect(placeLine({ name: 'Tucson', area: '112', station: 'KTUS' }, 'area')).toBe('Tucson, 112');
  });
});
