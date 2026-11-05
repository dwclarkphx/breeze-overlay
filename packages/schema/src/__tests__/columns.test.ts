// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Column matching and the manual-table paste (0.79.1). The paste is what a
 * production team does with a roster or a game row copied out of Excel or
 * Sheets; on a sport-template table it must never move the template's keys,
 * which the Game block and every binding read.
 */

import { describe, expect, it } from 'vitest';

import { matchDeclaredColumns, pasteBlock } from '../columns.js';
import type { DataColumn } from '../data.js';
import { sportDataColumns, sportRuleset, sportSeedRows, sportTemplate } from '../sports.js';

const basketball = sportTemplate('basketball')!;
const nba = sportRuleset(basketball, 'nba');
const gameColumns = sportDataColumns(basketball, nba, 'game');
const gameRows = sportSeedRows(basketball, nba, 'game');
const playerColumns = sportDataColumns(basketball, nba, 'players');

const tsv = (...lines: Array<Array<string | number>>): string => lines.map((l) => l.join('\t')).join('\n') + '\n';
const header = { row: 0, column: 0, headers: true };

describe('matchDeclaredColumns', () => {
  it('finds each column by name whatever the order', () => {
    const { index, match } = matchDeclaredColumns(['awayScore', 'homeScore'], [
      { key: 'homeScore', type: 'number' },
      { key: 'awayScore', type: 'number' },
    ]);
    expect(index).toEqual([1, 0]);
    expect(match).toEqual({ missing: [], positional: false });
  });
});

describe('pasting into a sport-template table', () => {
  it('keeps the template columns and maps a game row by header, in any order', () => {
    const text = tsv(['Away Score', 'Home Score', 'Status', 'Period'], [68, 72, 'live', 3]);
    const out = pasteBlock(gameColumns, gameRows, text, { ...header, lockColumns: true });
    expect(out.columns).toEqual(gameColumns);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ homeScore: 72, awayScore: 68, status: 'live', period: 3 });
    expect(out.asData).toBe(false);
  });

  it('reports the headers it could not place and the columns it left blank', () => {
    const text = tsv(['homeScore', 'awayScore', 'Notes'], [10, 8, 'tip at 7']);
    const out = pasteBlock(gameColumns, gameRows, text, { ...header, lockColumns: true });
    expect(out.unmatched).toEqual(['Notes']);
    expect(out.blank).toContain('status');
    expect(out.rows[0]!.status).toBeNull();
    expect(Object.keys(out.rows[0]!)).not.toContain('notes');
  });

  it('pastes a roster with the sheet’s own header names', () => {
    const text = tsv(['Name', 'Team', 'Number', 'PTS'], ['Jordan Smith', 'PHX', 23, 31], ['Ali Khan', 'PHX', 4, 12]);
    const out = pasteBlock(playerColumns, [], text, { ...header, lockColumns: true });
    expect(out.rows).toEqual([
      expect.objectContaining({ name: 'Jordan Smith', team: 'PHX', number: '23', pts: 31 }),
      expect.objectContaining({ name: 'Ali Khan', team: 'PHX', number: '4', pts: 12 }),
    ]);
  });

  it('takes a first line that names no column as data, by position', () => {
    const text = tsv(['live', 2, '2nd', 40, 38]);
    const out = pasteBlock(gameColumns, gameRows, text, { ...header, lockColumns: true });
    expect(out.asData).toBe(true);
    expect(out.rows[0]).toMatchObject({ status: 'live', period: 2, periodLabel: '2nd', homeScore: 40, awayScore: 38 });
    expect(out.columns).toEqual(gameColumns);
  });

  it('keeps a blank cell blank and reads yes/no into a boolean column', () => {
    const text = tsv(['homeScore', 'homeBonus', 'home4'], [55, 'yes', '']);
    const out = pasteBlock(gameColumns, gameRows, text, { ...header, lockColumns: true });
    expect(out.rows[0]).toMatchObject({ homeScore: 55, homeBonus: true, home4: '' });
  });
});

describe('pasting into an ordinary manual table', () => {
  const standings: DataColumn[] = [
    { key: 'team', label: 'Team', type: 'string' },
    { key: 'w', label: 'W', type: 'number' },
  ];

  it('makes the header row the table, keeping the keys of columns it names', () => {
    const text = tsv(['W', 'Team', 'Streak'], [11, 'Mesa', 'W3']);
    const out = pasteBlock(standings, [], text, { ...header, lockColumns: false });
    expect(out.columns.map((c) => c.key)).toEqual(['w', 'team', 'streak']);
    expect(out.columns[0]).toEqual(standings[1]);
    expect(out.rows[0]).toEqual({ w: 11, team: 'Mesa', streak: 'W3' });
  });

  it('gives repeated headers their own keys', () => {
    const out = pasteBlock([], [], tsv(['Pts', 'Pts'], [1, 2]), { ...header, lockColumns: false });
    expect(out.columns.map((c) => c.key)).toEqual(['pts', 'pts_2']);
    expect(out.rows[0]).toEqual({ pts: 1, pts_2: 2 });
  });

  it('writes a block pasted into a cell from that cell, adding rows', () => {
    const rows = [{ team: 'Mesa', w: 11 }];
    const out = pasteBlock(standings, rows, tsv(['Tempe', 9], ['Gilbert', 7]), { row: 0, column: 0, headers: false, lockColumns: false });
    expect(out.rows).toEqual([{ team: 'Tempe', w: 9 }, { team: 'Gilbert', w: 7 }]);
    const shifted = pasteBlock(standings, rows, tsv([12]), { row: 0, column: 1, headers: false, lockColumns: true });
    expect(shifted.rows).toEqual([{ team: 'Mesa', w: 12 }]);
  });
});
