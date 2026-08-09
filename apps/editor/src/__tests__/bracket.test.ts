// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { applyTransforms, type DataColumn, type DataRow } from '@breeze/schema';

import {
  carriedColumns,
  firstRound,
  isBracketTable,
  isFedCell,
  previewAdvance,
} from '../state/bracket.js';

const cols = (...keys: string[]): DataColumn[] => keys.map((key) => ({ key, type: 'string' }));

describe('bracket detection', () => {
  it('needs both a slot and a round column', () => {
    expect(isBracketTable(cols('slot', 'round', 'homeTeam'))).toBe(true);
    expect(isBracketTable(cols('slot', 'homeTeam'))).toBe(false);
    expect(isBracketTable(cols('team', 'w', 'l'))).toBe(false);
  });

  it('does not offer to resolve an ordinary standings table', () => {
    expect(previewAdvance(cols('team', 'w', 'l', 'pct'))).toBeNull();
  });
});

describe('preview transform', () => {
  it('wires scores only when both score columns exist', () => {
    expect(previewAdvance(cols('slot', 'round'))?.scores).toBeUndefined();
    expect(previewAdvance(cols('slot', 'round', 'homeScore'))?.scores).toBeUndefined();
    expect(previewAdvance(cols('slot', 'round', 'homeScore', 'awayScore'))?.scores).toEqual({
      home: 'homeScore',
      away: 'awayScore',
    });
  });

  it('adds the shoot-out pair when it is there too', () => {
    const t = previewAdvance(cols('slot', 'round', 'homeScore', 'awayScore', 'homePens', 'awayPens'));
    expect(t?.scores?.shootout).toEqual({ home: 'homePens', away: 'awayPens' });
  });
});

describe('fed cells', () => {
  const carried = carriedColumns();
  const rows: DataRow[] = [
    { slot: 'A', round: 'R1', homeTeam: 'X', awayTeam: 'Y', winner: 'X' },
    { slot: 'B', round: 'R1', homeTeam: 'P', awayTeam: 'Q', winner: 'Q' },
    { slot: 'F', round: 'R2' },
  ];
  const seed = firstRound(rows);

  it('takes the first round that appears as the one the operator seeds', () => {
    expect(seed).toBe('R1');
  });

  it('leaves the seed round editable', () => {
    expect(isFedCell(rows[0]!, 'homeTeam', seed, carried)).toBe(false);
  });

  it('locks a carried column in every later round', () => {
    expect(isFedCell(rows[2]!, 'homeTeam', seed, carried)).toBe(true);
    expect(isFedCell(rows[2]!, 'awayTeam', seed, carried)).toBe(true);
  });

  it('leaves columns advance does not write alone, whatever the round', () => {
    // Scores and winners are typed by the operator in every round — locking
    // them would make the bracket unfillable past the first tier.
    expect(isFedCell(rows[2]!, 'winner', seed, carried)).toBe(false);
    expect(isFedCell(rows[2]!, 'homeScore', seed, carried)).toBe(false);
  });

  it('locks exactly the cells the transform goes on to fill', () => {
    const out = applyTransforms(
      { id: 'b', columns: cols('slot', 'round', 'homeTeam', 'awayTeam', 'winner'), rows },
      [previewAdvance(cols('slot', 'round'))!],
    );
    const final = out.rows.at(-1)!;
    expect(final.homeTeam).toBe('X');
    expect(final.awayTeam).toBe('Q');
    // Both were reported fed above; both were written. The grid marks read-only
    // exactly what it is about to overwrite.
    expect(isFedCell(rows[2]!, 'homeTeam', seed, carried)).toBe(true);
    expect(isFedCell(rows[2]!, 'awayTeam', seed, carried)).toBe(true);
  });
});
