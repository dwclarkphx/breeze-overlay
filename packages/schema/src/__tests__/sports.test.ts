// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/** Sport templates (Phase 9 Wave B): the catalogue, the scoring, the guide and the check. */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DataRow } from '../data.js';
import {
  SPORT_TABLES,
  SPORT_TEMPLATES,
  applyGameAction,
  checkSportTable,
  newGameRow,
  periodLabel,
  sportCsv,
  sportDataColumns,
  sportRuleset,
  sportSeedRows,
  sportTableColumns,
  sportTemplate,
  type GameAction,
  type SportTemplate,
} from '../sports.js';
import { validateDataSources } from '../validate.js';

const en = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../../i18n/locales/en.json'), 'utf8'),
) as Record<string, string>;

const sport = (id: string): SportTemplate => sportTemplate(id)!;
const run = (id: string, ruleset: string, actions: GameAction[], start?: DataRow): DataRow => {
  const t = sport(id);
  const r = sportRuleset(t, ruleset);
  return actions.reduce((row, a) => applyGameAction(t, r, row, a), start ?? newGameRow(t, r));
};
const times = (n: number, a: GameAction): GameAction[] => Array.from({ length: n }, () => a);

describe('the catalogue', () => {
  it('covers every group asked for, pickleball and table tennis included', () => {
    const ids = SPORT_TEMPLATES.map((t) => t.id);
    for (const id of ['basketball', 'american-football', 'baseball', 'softball', 'volleyball', 'soccer', 'rugby-union', 'rugby-league', 'aussie-rules', 'gaelic-football', 'hurling', 'ice-hockey', 'field-hockey', 'lacrosse', 'handball', 'water-polo', 'cricket', 'tennis', 'badminton', 'table-tennis', 'pickleball']) {
      expect(ids).toContain(id);
    }
  });

  it('names every sport, ruleset and timer in the catalogue', () => {
    for (const t of SPORT_TEMPLATES) {
      expect(en[t.labelKey], t.labelKey).toBeTruthy();
      for (const r of t.rulesets) {
        expect(en[r.labelKey], r.labelKey).toBeTruthy();
        for (const timer of r.timers) expect(en[timer.labelKey], timer.labelKey).toBeTruthy();
      }
    }
  });

  it('gives every table unique column keys and makes valid manual sources', () => {
    for (const t of SPORT_TEMPLATES) {
      for (const r of t.rulesets) {
        for (const table of SPORT_TABLES) {
          const keys = sportTableColumns(t, r, table).map((c) => c.key);
          expect(new Set(keys).size, `${t.id}/${r.id}/${table}`).toBe(keys.length);
        }
      }
      const r = t.rulesets[0]!;
      const sources = SPORT_TABLES.map((table) => ({
        id: `${t.prefix}-${table}`,
        name: `${t.id} ${table}`,
        type: 'manual' as const,
        columns: sportDataColumns(t, r, table),
        rows: sportSeedRows(t, r, table),
        template: { sport: t.id, ruleset: r.id, table },
      }));
      const result = validateDataSources({ formatVersion: 1, sources });
      expect(result.errors, t.id).toEqual([]);
    }
  });
});

describe('scoring', () => {
  it('basketball: +1/+2/+3 into the score and the quarter', () => {
    const row = run('basketball', 'nba', [
      { type: 'score', side: 'home', action: 'three' },
      { type: 'score', side: 'away', action: 'fg' },
      { type: 'period', delta: 1 },
      { type: 'score', side: 'home', action: 'ft' },
    ]);
    expect(row).toMatchObject({ homeScore: 4, awayScore: 2, home1: 3, home2: 1, away1: 2, period: 2, periodLabel: '2nd' });
  });

  it('takes a mistaken basket back, never below zero', () => {
    const row = run('basketball', 'nba', [
      { type: 'score', side: 'home', action: 'fg' },
      { type: 'unscore', side: 'home', action: 'three' },
    ]);
    expect(row['homeScore']).toBe(0);
  });

  it('runs overtime into OT columns and labels', () => {
    const row = run('basketball', 'nfhs', [...times(4, { type: 'period', delta: 1 }), { type: 'score', side: 'away', action: 'fg' }]);
    expect(row).toMatchObject({ period: 5, periodLabel: 'OT', awayOT: 2, awayScore: 2 });
  });

  it('resets team fouls each quarter', () => {
    const row = run('basketball', 'nba', [{ type: 'adjust', column: 'homeFouls', delta: 4 }, { type: 'period', delta: 1 }]);
    expect(row['homeFouls']).toBe(0);
  });

  it('AFL: a goal is six, a behind one, shown G.B.T', () => {
    const row = run('aussie-rules', 'afl', [
      { type: 'score', side: 'home', action: 'goal' },
      { type: 'score', side: 'home', action: 'goal' },
      { type: 'score', side: 'home', action: 'behind' },
    ]);
    expect(row).toMatchObject({ homeGoals: 2, homeBehinds: 1, homeScore: 13, homeDisplay: '2.1.13' });
  });

  it('GAA: goals and points, shown G-P', () => {
    const row = run('gaelic-football', 'inter-county', [{ type: 'score', side: 'away', action: 'goal' }, { type: 'score', side: 'away', action: 'point' }]);
    expect(row).toMatchObject({ awayScore: 4, awayDisplay: '1-01' });
  });

  it('rugby union: a try is five and counts as a try', () => {
    const row = run('rugby-union', 'world-rugby', [{ type: 'score', side: 'home', action: 'try' }, { type: 'score', side: 'home', action: 'con' }]);
    expect(row).toMatchObject({ homeScore: 7, homeTries: 1 });
  });

  it('baseball: the period moves by half-innings and clears the count', () => {
    const row = run('baseball', 'mlb', [{ type: 'adjust', column: 'strikes', delta: 2 }, { type: 'period', delta: 1 }]);
    expect(row).toMatchObject({ period: 1, half: 'bottom', strikes: 0, periodLabel: 'Bot 1st' });
    const next = run('baseball', 'mlb', [{ type: 'period', delta: 1 }, { type: 'period', delta: 1 }]);
    expect(next).toMatchObject({ period: 2, half: 'top', periodLabel: 'Top 2nd' });
  });

  it('cricket: runs and balls for the batting side, overs and run rate derived', () => {
    const row = run('cricket', 't20', [
      ...times(5, { type: 'score', side: 'home', action: 'one' }),
      { type: 'score', side: 'home', action: 'wide' },
      { type: 'score', side: 'home', action: 'four' },
      { type: 'score', side: 'home', action: 'wicket' },
    ]);
    expect(row).toMatchObject({ homeRuns: 10, homeBalls: 7, homeOvers: '1.1', homeWickets: 1, homeExtras: 1, homeScore: 10 });
    expect(row['runRate']).toBe('8.57');
  });

  it('volleyball: a set to 25 by two, the decider to 15', () => {
    let row = run('volleyball', 'fivb', times(25, { type: 'point', side: 'home' }));
    expect(row).toMatchObject({ homeGames: 1, homePoints: 0, home1: 25, away1: 0, period: 2, homeScore: 1 });
    // 24-24, then two clear.
    row = run('volleyball', 'fivb', [...times(24, { type: 'point', side: 'home' }), ...times(24, { type: 'point', side: 'away' })]);
    row = applyGameAction(sport('volleyball'), sportRuleset(sport('volleyball'), 'fivb'), row, { type: 'point', side: 'home' });
    expect(row['homeGames']).toBe(0);
    const t = sport('volleyball');
    const r = sportRuleset(t, 'fivb');
    const decider = applyGameAction(t, r, { ...newGameRow(t, r), homeGames: 2, awayGames: 2, period: 5, homePoints: 14, awayPoints: 3 }, { type: 'point', side: 'home' });
    expect(decider).toMatchObject({ status: 'final', homeGames: 3 });
  });

  it('badminton: capped at 30', () => {
    const t = sport('badminton');
    const r = sportRuleset(t, 'bwf');
    const row = applyGameAction(t, r, { ...newGameRow(t, r), homePoints: 29, awayPoints: 29 }, { type: 'point', side: 'away' });
    expect(row['awayGames']).toBe(1);
  });

  it('tennis: 15/30/40, deuce and advantage, a game, a set and a tiebreak', () => {
    const t = sport('tennis');
    const r = sportRuleset(t, 'best-of-3');
    let row = run('tennis', 'best-of-3', times(2, { type: 'point', side: 'home' }));
    expect(row).toMatchObject({ homePointText: '30', awayPointText: '0' });
    row = run('tennis', 'best-of-3', [...times(3, { type: 'point', side: 'home' }), ...times(4, { type: 'point', side: 'away' })]);
    expect(row).toMatchObject({ homePointText: '40', awayPointText: 'AD' });
    row = run('tennis', 'best-of-3', times(4 * 6, { type: 'point', side: 'home' }));
    expect(row).toMatchObject({ homeSets: 1, homeGames: 0, home1: 6, away1: 0, period: 2 });
    row = applyGameAction(t, r, { ...newGameRow(t, r), homeGames: 5, awayGames: 6, homePoints: 3, awayPoints: 0 }, { type: 'point', side: 'home' });
    expect(row).toMatchObject({ homeGames: 6, awayGames: 6, tiebreak: true });
    row = [...times(7, { type: 'point', side: 'away' } as GameAction)].reduce((acc, a) => applyGameAction(t, r, acc, a), row);
    expect(row).toMatchObject({ awaySets: 1, home1: 6, away1: 7, tiebreak: false });
  });

  it('pickleball: only the serving side scores; a fault passes the serve', () => {
    const t = sport('pickleball');
    const r = sportRuleset(t, 'doubles');
    let row = newGameRow(t, r);
    expect(row['call']).toBe('0-0-2');
    row = applyGameAction(t, r, row, { type: 'point', side: 'home' });
    expect(row).toMatchObject({ homePoints: 1, call: '1-0-2' });
    row = applyGameAction(t, r, row, { type: 'point', side: 'away' });
    expect(row).toMatchObject({ homePoints: 1, awayPoints: 0, serving: 'away', serverNumber: 1, call: '0-1-1' });
    row = applyGameAction(t, r, row, { type: 'point', side: 'home' });
    expect(row).toMatchObject({ serving: 'away', serverNumber: 2 });
  });

  it('ignores an action the sport does not have and a column the row does not have', () => {
    const t = sport('soccer');
    const r = sportRuleset(t, 'fifa');
    const row = newGameRow(t, r);
    expect(applyGameAction(t, r, row, { type: 'score', side: 'home', action: 'three' })['homeScore']).toBe(0);
    expect(applyGameAction(t, r, row, { type: 'set', column: 'nonsense', value: 1 })).toEqual(row);
    expect(applyGameAction(t, r, row, { type: 'point', side: 'home' })).toEqual(row);
  });
});

describe('labels', () => {
  it('writes periods the way a broadcast does', () => {
    const r = (id: string, ruleset: string) => sportRuleset(sport(id), ruleset);
    expect(periodLabel(r('basketball', 'nba'), 3)).toBe('3rd');
    expect(periodLabel(r('basketball', 'nba'), 6)).toBe('2OT');
    expect(periodLabel(r('soccer', 'fifa'), 2)).toBe('2nd Half');
    expect(periodLabel(r('ice-hockey', 'nhl'), 5)).toBe('SO');
    expect(periodLabel(r('cricket', 'odi'), 2)).toBe('2nd innings');
    expect(periodLabel(r('baseball', 'mlb'), 11, 'top')).toBe('Top 11th');
  });
});

describe('the format guide and the check', () => {
  const t = sport('basketball');
  const r = sportRuleset(t, 'nba');

  it('passes a feed that has every required column', () => {
    const columns = sportDataColumns(t, r, 'players');
    const result = checkSportTable(t, r, 'players', { columns, rows: sportSeedRows(t, r, 'players') });
    expect(result.ok).toBe(true);
  });

  it('names what a Sheet is missing, mistyped or holding the wrong value', () => {
    const result = checkSportTable(t, r, 'teams', {
      columns: [
        { key: 'side', type: 'string' },
        { key: 'name', type: 'string' },
        { key: 'rebounds', type: 'string' },
        { key: 'mascot', type: 'string' },
      ],
      rows: [{ side: 'visitors', name: 'Suns', rebounds: 'lots', mascot: 'Gorilla' }],
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['abbr']);
    expect(result.mistyped).toEqual([{ column: 'rebounds', row: 1, value: 'lots' }]);
    expect(result.unexpected).toEqual([{ column: 'side', row: 1, value: 'visitors' }]);
    expect(result.extra).toEqual(['mascot']);
  });

  it('writes a starter CSV with the header and the seed rows', () => {
    const csv = sportCsv(t, r, 'teams').split('\n');
    expect(csv[0]!.startsWith('side,name,shortName,abbr,color')).toBe(true);
    expect(csv[1]!.startsWith('home,Home,Home,HOME,#1f4e9c')).toBe(true);
  });
});
