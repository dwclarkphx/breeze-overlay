// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The `areas` and `areaKind` columns a CAP source adds (0.76.0), and the
 * sentence they exist for.
 */

import { applyTransforms } from '@breeze/schema';
import { describe, expect, it } from 'vitest';

import { areaKind, areaNames, capToDataSet } from '../data/cap.js';

describe('areaNames', () => {
  it('strips a trailing state code from each area', () => {
    expect(areaNames('Pima, AZ; Pinal, AZ')).toBe('Pima; Pinal');
    expect(areaNames('Central Mountains; Tonto Basin')).toBe('Central Mountains; Tonto Basin');
    expect(areaNames('')).toBe('');
  });
});

describe('areaKind', () => {
  it('is counties only when every UGC code is a county', () => {
    expect(areaKind(['AZC019', 'AZC021', '004019'])).toBe('counties');
    expect(areaKind(['AZC019', 'AZZ537'])).toBe('areas');
    expect(areaKind(['AZZ537'])).toBe('areas');
  });

  it('is areas when there are no UGC codes to go on', () => {
    expect(areaKind([])).toBe('areas');
    expect(areaKind(['004013'])).toBe('areas');
  });
});

describe('a compose step over a CAP source', () => {
  const feature = (id: string, extra: Record<string, unknown>) => ({
    id,
    properties: {
      id, status: 'Actual', messageType: 'Alert', event: 'Flood Watch', severity: 'Severe',
      areaDesc: 'Pima, AZ; Pinal, AZ', geocode: { SAME: ['004019', '004021'], UGC: ['AZC019', 'AZC021'] },
      effective: '2026-09-29T15:16:00-07:00', onset: '2026-09-29T15:16:00-07:00', ends: '2026-09-30T03:15:00-07:00',
      expires: '2026-09-30T03:15:00-07:00', headline: 'Flood Watch issued', description: 'Wet.', instruction: null,
      ...extra,
    },
  });

  it('writes the whole sentence', () => {
    const body = JSON.stringify({ features: [feature('a', {})] });
    const now = new Date('2026-09-29T22:40:00Z');
    const data = capToDataSet({ id: 'nws', name: 'NWS', type: 'cap', url: 'x', timezone: 'America/Phoenix' } as never, body, now);
    expect(data.rows[0]!['areas']).toBe('Pima; Pinal');
    expect(data.rows[0]!['areaKind']).toBe('counties');
    const out = applyTransforms(
      data,
      [{
        op: 'compose', as: 'sentence', timezone: 'America/Phoenix',
        template: 'The NWS has issued a {event} for the following {areaKind}: {areas|list}; from {onset|when} until {ends|when}',
      }],
      { now },
    );
    expect(out.rows[0]!['sentence']).toBe(
      'The NWS has issued a Flood Watch for the following counties: Pima and Pinal; from 3:16 PM until Wed 3:15 AM',
    );
  });

  it('says areas for a zone-based alert', () => {
    const body = JSON.stringify({
      features: [feature('b', { event: 'Excessive Heat Warning', areaDesc: 'Central Mountains', geocode: { UGC: ['AZZ024'] } })],
    });
    const data = capToDataSet({ id: 'nws', name: 'NWS', type: 'cap', url: 'x' } as never, body, new Date('2026-09-29T22:40:00Z'));
    expect(data.rows[0]!['areaKind']).toBe('areas');
    expect(data.rows[0]!['areas']).toBe('Central Mountains');
  });
});
