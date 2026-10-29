// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Sport templates for data sources (Phase 9 Wave B — asked for 2026-10-25).
 *
 * Pick a sport and its rules when creating a data source and you get the
 * tables a sports production needs, already shaped for it:
 *
 *  - **teams** — home and away: names, abbreviation, colours, logo, record and
 *    the sport's team stats;
 *  - **players** — the roster and the sport's player stats;
 *  - **coaches** — names and roles;
 *  - **venue** — the ground, attendance, officials, notes;
 *  - **game** — one row of live state: score, period, the line score per
 *    period and what the sport tracks besides (down and distance, balls,
 *    strikes and outs, sets and games, overs and wickets, cards…).
 *
 * Each ruleset also says which operator timers the sport runs (a 12:00
 * countdown and a 24 s shot clock for the NBA, a 45:00 count-up for football)
 * and how it scores (+1/+2/+3; try 5, conversion 2; goal 6, behind 1; tennis
 * points, games and sets). The panel's score buttons and `applyGameAction`
 * read that, so a tap does what the sport means.
 *
 * The same column layout applies to a fetched source — a Google Sheet a
 * scorekeeper fills in, a CSV or JSON feed. `sportTableGuide` is the format
 * guide for building one and `checkSportTable` says what a feed is missing.
 *
 * **Data, not English, where it can be.** Sport and ruleset names are
 * catalogue keys (I18N.md §2.1). Column labels and period labels are values a
 * graphic shows, written the way a broadcast writes them — the same stance the
 * weather columns take — and an operator can retype any of them.
 *
 * Free of I/O and of Ajv.
 */

import type { DataColumn, DataRow, DataSet, DataValue } from './data.js';
import type { TextTimer } from './timer.js';

/* ------------------------------------------------------------------ types */

export const SPORT_TABLES = ['teams', 'players', 'coaches', 'venue', 'game'] as const;
export type SportTable = (typeof SPORT_TABLES)[number];

export const SPORT_GROUPS = ['us', 'football', 'stick', 'racket'] as const;
export type SportGroup = (typeof SPORT_GROUPS)[number];

/** The two sides a game row is written for. A column stem `Score` is `homeScore` / `awayScore`. */
export const SIDES = ['home', 'away'] as const;
export type Side = (typeof SIDES)[number];

/** A column, plus what a feed builder needs to know about it. */
export interface SportColumn extends DataColumn {
  /** A feed without it fails `checkSportTable`. */
  required?: boolean;
  /** One value, for the guide and the sample file. */
  example?: DataValue;
  /** The values it may hold, when it is a closed list. */
  values?: readonly string[];
}

/**
 * One scoring button. `adds` is keyed by column **stem** — `{ Score: 6, Goals: 1 }`
 * adds to `homeScore` and `homeGoals` for the home side. Cricket's are full
 * column names on the batting side's stems the same way.
 */
export interface ScoringAction {
  id: string;
  /** What the button says. Sport terminology, not prose. */
  label: string;
  adds: Record<string, number>;
  /** Counts as a ball faced (cricket). */
  ball?: boolean;
}

/**
 * How the sport scores:
 *  - `points` — buttons that add (most team sports);
 *  - `rally` — a point to a side; games to `pointsToWin`, win by `winBy`, capped at `cap`;
 *  - `sideout` — pickleball's traditional scoring: only the serving side scores;
 *  - `tennis` — 15/30/40/AD, games, sets, tiebreaks;
 *  - `cricket` — runs, wickets and balls for the batting side.
 */
export type ScoringKind = 'points' | 'rally' | 'sideout' | 'tennis' | 'cricket';

/** What a period is called, which decides `periodLabel`. */
export type PeriodName = 'quarter' | 'half' | 'period' | 'inning' | 'set' | 'game' | 'innings';

export interface SportTimerSpec {
  /** Timer id the layer names — `game`, `shot`, `play`, `pitch`, `serve`. */
  id: string;
  /** Catalogue key for the timer's name. */
  labelKey: string;
  timer: TextTimer;
}

export interface SportRuleset {
  id: string;
  /** Catalogue key — `schema.sport.basketball.nba`. */
  labelKey: string;
  periods: number;
  periodName: PeriodName;
  timers: SportTimerSpec[];
  /** Racket sports: points to win a game, the margin, and the cap. */
  pointsToWin?: number;
  winBy?: number;
  cap?: number;
  /** Racket sports: games (sets, for tennis) needed to win the match. */
  toWin?: number;
  /** The deciding game's target when it differs — volleyball's fifth set to 15. */
  decidingPointsToWin?: number;
  /** Tennis: games per set; the tiebreak plays at games-all. */
  gamesPerSet?: number;
  /** Tennis: points in a tiebreak, and in the deciding set's (10 at the Slams). */
  tiebreakPoints?: number;
  decidingTiebreakPoints?: number;
  /** Pickleball doubles: two servers per side. */
  doubles?: boolean;
  /** Cricket: overs per innings. Absent is unlimited (Test). */
  overs?: number;
}

export interface SportTemplate {
  id: string;
  group: SportGroup;
  /** Catalogue key — `schema.sport.basketball.name`. */
  labelKey: string;
  /** What source ids start with — `bball-teams`. */
  prefix: string;
  scoring: ScoringKind;
  actions: ScoringAction[];
  rulesets: SportRuleset[];
  /** Per-period points columns on the game row (`home1`…`homeN`, `homeOT`). */
  lineScore: boolean;
  teamStats: SportColumn[];
  playerStats: SportColumn[];
  /** The sport's own game-row columns, beyond score, period and line score. */
  gameColumns: SportColumn[];
  /** Racket sports: a "team" is a player or a pair. */
  individual?: boolean;
}

/* --------------------------------------------------------------- helpers */

const s = (key: string, label: string, extra: Partial<SportColumn> = {}): SportColumn => ({ key, label, type: 'string', ...extra });
const n = (key: string, label: string, extra: Partial<SportColumn> = {}): SportColumn => ({ key, label, type: 'number', ...extra });
const b = (key: string, label: string, extra: Partial<SportColumn> = {}): SportColumn => ({ key, label, type: 'boolean', ...extra });

/** `{ Fouls: 'Fouls' }` → `homeFouls`, `awayFouls`. */
function bothSides(cols: SportColumn[]): SportColumn[] {
  return cols.flatMap((c) =>
    SIDES.map((side) => ({ ...c, key: `${side}${c.key}`, label: `${side === 'home' ? 'Home' : 'Away'} ${c.label}` })),
  );
}

const countdown = (seconds: number, extra: Partial<TextTimer> = {}): TextTimer => ({ mode: 'countdown', duration: seconds, ...extra });
const countup = (seconds: number, extra: Partial<TextTimer> = {}): TextTimer => ({ mode: 'countup', limit: seconds, ...extra });

const gameClock = (timer: TextTimer): SportTimerSpec => ({ id: 'game', labelKey: 'schema.sport.timer.game', timer: { id: 'game', ...timer } });
const shotClock = (seconds: number, id = 'shot', labelKey = 'schema.sport.timer.shot'): SportTimerSpec => ({
  id,
  labelKey,
  timer: { id, mode: 'countdown', duration: seconds, format: 's', tenthsUnder: 5, tenthsFormat: 's.S' },
});

const pts = (id: string, label: string, points: number, extra: Record<string, number> = {}): ScoringAction => ({
  id,
  label,
  adds: { Score: points, ...extra },
});

/* -------------------------------------------------------------- catalogue */

const basketball: SportTemplate = {
  id: 'basketball',
  group: 'us',
  labelKey: 'schema.sport.basketball.name',
  prefix: 'bball',
  scoring: 'points',
  actions: [pts('ft', '+1', 1), pts('fg', '+2', 2), pts('three', '+3', 3)],
  lineScore: true,
  rulesets: [
    { id: 'nba', labelKey: 'schema.sport.basketball.nba', periods: 4, periodName: 'quarter', timers: [gameClock(countdown(720, { tenthsUnder: 60 })), shotClock(24)] },
    { id: 'wnba', labelKey: 'schema.sport.basketball.wnba', periods: 4, periodName: 'quarter', timers: [gameClock(countdown(600, { tenthsUnder: 60 })), shotClock(24)] },
    { id: 'ncaa-men', labelKey: 'schema.sport.basketball.ncaaMen', periods: 2, periodName: 'half', timers: [gameClock(countdown(1200, { tenthsUnder: 60 })), shotClock(30)] },
    { id: 'ncaa-women', labelKey: 'schema.sport.basketball.ncaaWomen', periods: 4, periodName: 'quarter', timers: [gameClock(countdown(600, { tenthsUnder: 60 })), shotClock(30)] },
    { id: 'nfhs', labelKey: 'schema.sport.basketball.nfhs', periods: 4, periodName: 'quarter', timers: [gameClock(countdown(480, { tenthsUnder: 60 })), shotClock(35)] },
    { id: 'fiba', labelKey: 'schema.sport.basketball.fiba', periods: 4, periodName: 'quarter', timers: [gameClock(countdown(600, { tenthsUnder: 60 })), shotClock(24)] },
  ],
  teamStats: [n('fgPct', 'FG%'), n('threePct', '3P%'), n('ftPct', 'FT%'), n('rebounds', 'REB'), n('assists', 'AST'), n('turnovers', 'TO')],
  playerStats: [n('pts', 'PTS', { example: 18 }), n('reb', 'REB'), n('ast', 'AST'), n('stl', 'STL'), n('blk', 'BLK'), n('fouls', 'PF'), n('min', 'MIN')],
  gameColumns: [
    ...bothSides([n('Fouls', 'Fouls'), n('Timeouts', 'Timeouts'), b('Bonus', 'Bonus')]),
    s('arrow', 'Possession arrow', { values: ['home', 'away', ''] }),
  ],
};

const americanFootball: SportTemplate = {
  id: 'american-football',
  group: 'us',
  labelKey: 'schema.sport.american-football.name',
  prefix: 'fb',
  scoring: 'points',
  actions: [pts('td', 'TD', 6), pts('pat', 'PAT', 1), pts('two', '2PT', 2), pts('fg', 'FG', 3), pts('safety', 'SAF', 2)],
  lineScore: true,
  rulesets: [
    { id: 'nfl', labelKey: 'schema.sport.american-football.nfl', periods: 4, periodName: 'quarter', timers: [gameClock(countdown(900)), shotClock(40, 'play', 'schema.sport.timer.play')] },
    { id: 'ncaa', labelKey: 'schema.sport.american-football.ncaa', periods: 4, periodName: 'quarter', timers: [gameClock(countdown(900)), shotClock(40, 'play', 'schema.sport.timer.play')] },
    { id: 'nfhs', labelKey: 'schema.sport.american-football.nfhs', periods: 4, periodName: 'quarter', timers: [gameClock(countdown(720)), shotClock(25, 'play', 'schema.sport.timer.play')] },
  ],
  teamStats: [n('totalYards', 'Yards'), n('passYards', 'Pass yds'), n('rushYards', 'Rush yds'), n('turnovers', 'TO'), s('possessionTime', 'TOP')],
  playerStats: [n('passYds', 'Pass yds'), n('rushYds', 'Rush yds'), n('recYds', 'Rec yds'), n('td', 'TD'), n('tackles', 'TKL'), n('sacks', 'SCK'), n('int', 'INT')],
  gameColumns: [
    n('down', 'Down', { example: 3 }),
    n('distance', 'To go', { example: 7 }),
    s('ballOn', 'Ball on', { example: 'OPP 34' }),
    b('redZone', 'Red zone'),
    b('flag', 'Flag'),
    ...bothSides([n('Timeouts', 'Timeouts')]),
  ],
};

const baseballColumns = (innings: number): SportColumn[] => [
  s('half', 'Half', { values: ['top', 'bottom'], example: 'top' }),
  n('balls', 'Balls'),
  n('strikes', 'Strikes'),
  n('outs', 'Outs'),
  b('onFirst', 'On first'),
  b('onSecond', 'On second'),
  b('onThird', 'On third'),
  ...bothSides([n('Hits', 'Hits'), n('Errors', 'Errors')]),
  s('pitcher', 'Pitcher'),
  s('batter', 'Batter'),
  n('scheduledInnings', 'Innings', { example: innings }),
];

const baseball: SportTemplate = {
  id: 'baseball',
  group: 'us',
  labelKey: 'schema.sport.baseball.name',
  prefix: 'bb',
  scoring: 'points',
  actions: [pts('run', '+1', 1)],
  lineScore: true,
  rulesets: [
    {
      id: 'mlb',
      labelKey: 'schema.sport.baseball.mlb',
      periods: 9,
      periodName: 'inning',
      timers: [{ id: 'pitch', labelKey: 'schema.sport.timer.pitch', timer: { id: 'pitch', mode: 'countdown', duration: 15, format: 's' } }],
    },
    { id: 'nfhs', labelKey: 'schema.sport.baseball.nfhs', periods: 7, periodName: 'inning', timers: [] },
  ],
  teamStats: [n('wins', 'W'), n('losses', 'L'), n('runsPerGame', 'R/G')],
  playerStats: [s('avg', 'AVG', { example: '.287' }), n('hr', 'HR'), n('rbi', 'RBI'), n('hits', 'H'), n('ab', 'AB'), s('era', 'ERA'), n('so', 'SO')],
  gameColumns: baseballColumns(9),
};

const softball: SportTemplate = {
  ...baseball,
  id: 'softball',
  labelKey: 'schema.sport.softball.name',
  prefix: 'sb',
  rulesets: [
    { id: 'ncaa', labelKey: 'schema.sport.softball.ncaa', periods: 7, periodName: 'inning', timers: [] },
    { id: 'nfhs', labelKey: 'schema.sport.softball.nfhs', periods: 7, periodName: 'inning', timers: [] },
  ],
  gameColumns: baseballColumns(7),
};

const volleyball: SportTemplate = {
  id: 'volleyball',
  group: 'us',
  labelKey: 'schema.sport.volleyball.name',
  prefix: 'vb',
  scoring: 'rally',
  actions: [],
  lineScore: true,
  rulesets: [
    { id: 'fivb', labelKey: 'schema.sport.volleyball.fivb', periods: 5, periodName: 'set', timers: [], pointsToWin: 25, decidingPointsToWin: 15, winBy: 2, toWin: 3 },
    { id: 'nfhs', labelKey: 'schema.sport.volleyball.nfhs', periods: 5, periodName: 'set', timers: [], pointsToWin: 25, decidingPointsToWin: 15, winBy: 2, toWin: 3 },
    { id: 'beach', labelKey: 'schema.sport.volleyball.beach', periods: 3, periodName: 'set', timers: [], pointsToWin: 21, decidingPointsToWin: 15, winBy: 2, toWin: 2 },
  ],
  teamStats: [n('kills', 'Kills'), n('aces', 'Aces'), n('blocks', 'Blocks'), n('digs', 'Digs')],
  playerStats: [n('kills', 'K'), n('aces', 'SA'), n('blocks', 'BLK'), n('digs', 'DIG'), n('assists', 'AST')],
  gameColumns: [...bothSides([n('Games', 'Sets'), n('Points', 'Points'), n('Timeouts', 'Timeouts')]), s('serving', 'Serving', { values: ['home', 'away'] })],
};

const soccer: SportTemplate = {
  id: 'soccer',
  group: 'football',
  labelKey: 'schema.sport.soccer.name',
  prefix: 'fc',
  scoring: 'points',
  actions: [pts('goal', 'GOAL', 1)],
  lineScore: false,
  rulesets: [
    { id: 'fifa', labelKey: 'schema.sport.soccer.fifa', periods: 2, periodName: 'half', timers: [gameClock(countup(2700, { format: 'mm:ss' }))] },
    { id: 'youth', labelKey: 'schema.sport.soccer.youth', periods: 2, periodName: 'half', timers: [gameClock(countup(2400, { format: 'mm:ss' }))] },
    { id: 'nfhs', labelKey: 'schema.sport.soccer.nfhs', periods: 2, periodName: 'half', timers: [gameClock(countdown(2400, { format: 'mm:ss' }))] },
    { id: 'futsal', labelKey: 'schema.sport.soccer.futsal', periods: 2, periodName: 'half', timers: [gameClock(countdown(1200, { format: 'mm:ss' }))] },
  ],
  teamStats: [n('possession', 'Possession %'), n('shots', 'Shots'), n('shotsOnTarget', 'On target'), n('corners', 'Corners'), n('fouls', 'Fouls'), n('offsides', 'Offsides')],
  playerStats: [n('goals', 'G'), n('assists', 'A'), n('shots', 'SH'), n('yellow', 'YC'), n('red', 'RC'), n('saves', 'SV')],
  gameColumns: [
    n('addedTime', 'Added time (min)', { example: 4 }),
    ...bothSides([n('Yellow', 'Yellow cards'), n('Red', 'Red cards'), n('Pens', 'Shoot-out')]),
    s('lastScorer', 'Last scorer'),
  ],
};

const rugbyUnion: SportTemplate = {
  id: 'rugby-union',
  group: 'football',
  labelKey: 'schema.sport.rugby-union.name',
  prefix: 'ru',
  scoring: 'points',
  actions: [pts('try', 'TRY', 5, { Tries: 1 }), pts('con', 'CON', 2), pts('pen', 'PEN', 3), pts('drop', 'DG', 3), pts('pentry', 'PEN TRY', 7, { Tries: 1 })],
  lineScore: false,
  rulesets: [
    { id: 'world-rugby', labelKey: 'schema.sport.rugby-union.worldRugby', periods: 2, periodName: 'half', timers: [gameClock(countup(2400, { format: 'mm:ss', end: 'continue' }))] },
    { id: 'sevens', labelKey: 'schema.sport.rugby-union.sevens', periods: 2, periodName: 'half', timers: [gameClock(countup(420, { format: 'mm:ss', end: 'continue' }))] },
  ],
  teamStats: [n('possession', 'Possession %'), n('territory', 'Territory %'), n('tackles', 'Tackles'), n('lineoutsWon', 'Lineouts won')],
  playerStats: [n('tries', 'T'), n('points', 'PTS'), n('carries', 'CAR'), n('tackles', 'TKL'), n('metres', 'M')],
  gameColumns: bothSides([n('Tries', 'Tries'), n('Yellow', 'Yellow cards'), n('Red', 'Red cards')]),
};

const rugbyLeague: SportTemplate = {
  ...rugbyUnion,
  id: 'rugby-league',
  labelKey: 'schema.sport.rugby-league.name',
  prefix: 'rl',
  actions: [pts('try', 'TRY', 4, { Tries: 1 }), pts('con', 'CON', 2), pts('pen', 'PEN', 2), pts('fg', 'FG', 1), pts('fg2', '2PT FG', 2)],
  rulesets: [
    { id: 'nrl', labelKey: 'schema.sport.rugby-league.nrl', periods: 2, periodName: 'half', timers: [gameClock(countup(2400, { format: 'mm:ss', end: 'continue' }))] },
  ],
  gameColumns: [...bothSides([n('Tries', 'Tries'), n('Sinbin', 'Sin bin')]), n('tackleCount', 'Tackle', { example: 3 })],
};

const aussieRules: SportTemplate = {
  id: 'aussie-rules',
  group: 'football',
  labelKey: 'schema.sport.aussie-rules.name',
  prefix: 'afl',
  scoring: 'points',
  actions: [pts('goal', 'GOAL', 6, { Goals: 1 }), pts('behind', 'BEHIND', 1, { Behinds: 1 }), pts('rushed', 'RUSHED', 1, { Behinds: 1 })],
  lineScore: true,
  rulesets: [
    { id: 'afl', labelKey: 'schema.sport.aussie-rules.afl', periods: 4, periodName: 'quarter', timers: [gameClock(countup(1200, { format: 'mm:ss', end: 'continue' }))] },
  ],
  teamStats: [n('disposals', 'Disposals'), n('marks', 'Marks'), n('tackles', 'Tackles'), n('inside50s', 'Inside 50s'), n('clearances', 'Clearances')],
  playerStats: [n('goals', 'G'), n('behinds', 'B'), n('disposals', 'D'), n('marks', 'M'), n('tackles', 'T')],
  gameColumns: bothSides([n('Goals', 'Goals'), n('Behinds', 'Behinds'), s('Display', 'Score (G.B.T)', { example: '12.9.81' })]),
};

const gaelicFootball: SportTemplate = {
  id: 'gaelic-football',
  group: 'football',
  labelKey: 'schema.sport.gaelic-football.name',
  prefix: 'gaa',
  scoring: 'points',
  actions: [pts('goal', 'GOAL', 3, { Goals: 1 }), pts('point', 'POINT', 1, { Points: 1 }), pts('two', '2 POINTS', 2, { Points: 2 })],
  lineScore: false,
  rulesets: [
    { id: 'inter-county', labelKey: 'schema.sport.gaelic.interCounty', periods: 2, periodName: 'half', timers: [gameClock(countup(2100, { format: 'mm:ss', end: 'continue' }))] },
    { id: 'club', labelKey: 'schema.sport.gaelic.club', periods: 2, periodName: 'half', timers: [gameClock(countup(1800, { format: 'mm:ss', end: 'continue' }))] },
  ],
  teamStats: [n('wides', 'Wides'), n('frees', 'Frees'), n('kickoutsWon', 'Kick-outs won')],
  playerStats: [n('goals', 'G'), n('points', 'P'), s('scoreLine', 'Score', { example: '1-04' })],
  gameColumns: bothSides([n('Goals', 'Goals'), n('Points', 'Points'), s('Display', 'Score (G-P)', { example: '1-12' }), n('Yellow', 'Yellow cards'), n('Black', 'Black cards'), n('Red', 'Red cards')]),
};

const hurling: SportTemplate = {
  ...gaelicFootball,
  id: 'hurling',
  labelKey: 'schema.sport.hurling.name',
  prefix: 'hur',
  actions: [pts('goal', 'GOAL', 3, { Goals: 1 }), pts('point', 'POINT', 1, { Points: 1 })],
  gameColumns: bothSides([n('Goals', 'Goals'), n('Points', 'Points'), s('Display', 'Score (G-P)', { example: '2-21' }), n('Yellow', 'Yellow cards'), n('Red', 'Red cards')]),
};

const penaltyTimer = (seconds = 120): SportTimerSpec => ({
  id: 'penalty',
  labelKey: 'schema.sport.timer.penalty',
  timer: { id: 'penalty', mode: 'countdown', duration: seconds },
});

const iceHockey: SportTemplate = {
  id: 'ice-hockey',
  group: 'stick',
  labelKey: 'schema.sport.ice-hockey.name',
  prefix: 'hky',
  scoring: 'points',
  actions: [pts('goal', 'GOAL', 1)],
  lineScore: true,
  rulesets: [
    { id: 'nhl', labelKey: 'schema.sport.ice-hockey.nhl', periods: 3, periodName: 'period', timers: [gameClock(countdown(1200, { tenthsUnder: 60 })), penaltyTimer()] },
    { id: 'iihf', labelKey: 'schema.sport.ice-hockey.iihf', periods: 3, periodName: 'period', timers: [gameClock(countdown(1200, { tenthsUnder: 60 })), penaltyTimer()] },
    { id: 'nfhs', labelKey: 'schema.sport.ice-hockey.nfhs', periods: 3, periodName: 'period', timers: [gameClock(countdown(1020, { tenthsUnder: 60 })), penaltyTimer()] },
  ],
  teamStats: [n('shots', 'SOG'), n('faceoffPct', 'FO%'), n('hits', 'Hits'), n('pim', 'PIM'), s('powerPlay', 'PP', { example: '1/3' })],
  playerStats: [n('goals', 'G'), n('assists', 'A'), n('points', 'P'), n('plusMinus', '+/-'), n('pim', 'PIM'), n('saves', 'SV'), s('svPct', 'SV%')],
  gameColumns: [...bothSides([n('Shots', 'Shots'), n('Skaters', 'Skaters', { example: 5 })]), s('powerPlay', 'Power play', { values: ['home', 'away', ''] }), b('emptyNet', 'Empty net')],
};

const fieldHockey: SportTemplate = {
  id: 'field-hockey',
  group: 'stick',
  labelKey: 'schema.sport.field-hockey.name',
  prefix: 'fh',
  scoring: 'points',
  actions: [pts('goal', 'GOAL', 1)],
  lineScore: true,
  rulesets: [
    { id: 'fih', labelKey: 'schema.sport.field-hockey.fih', periods: 4, periodName: 'quarter', timers: [gameClock(countdown(900))] },
    { id: 'nfhs', labelKey: 'schema.sport.field-hockey.nfhs', periods: 4, periodName: 'quarter', timers: [gameClock(countdown(900))] },
  ],
  teamStats: [n('shots', 'Shots'), n('circleEntries', 'Circle entries'), n('penaltyCorners', 'Penalty corners')],
  playerStats: [n('goals', 'G'), n('assists', 'A'), n('saves', 'SV')],
  gameColumns: bothSides([n('Corners', 'Penalty corners'), n('Green', 'Green cards'), n('Yellow', 'Yellow cards'), n('Red', 'Red cards')]),
};

const lacrosse: SportTemplate = {
  id: 'lacrosse',
  group: 'stick',
  labelKey: 'schema.sport.lacrosse.name',
  prefix: 'lax',
  scoring: 'points',
  actions: [pts('goal', 'GOAL', 1), pts('two', '2PT', 2)],
  lineScore: true,
  rulesets: [
    { id: 'ncaa-men', labelKey: 'schema.sport.lacrosse.ncaaMen', periods: 4, periodName: 'quarter', timers: [gameClock(countdown(900)), shotClock(80)] },
    { id: 'ncaa-women', labelKey: 'schema.sport.lacrosse.ncaaWomen', periods: 4, periodName: 'quarter', timers: [gameClock(countdown(900)), shotClock(90)] },
    { id: 'box', labelKey: 'schema.sport.lacrosse.box', periods: 4, periodName: 'quarter', timers: [gameClock(countdown(900)), shotClock(30)] },
  ],
  teamStats: [n('shots', 'Shots'), n('groundBalls', 'Ground balls'), n('faceoffsWon', 'Faceoffs won'), n('saves', 'Saves')],
  playerStats: [n('goals', 'G'), n('assists', 'A'), n('groundBalls', 'GB'), n('causedTurnovers', 'CT'), n('saves', 'SV')],
  gameColumns: bothSides([n('Shots', 'Shots'), n('Timeouts', 'Timeouts'), n('Penalties', 'Penalties')]),
};

const handball: SportTemplate = {
  id: 'handball',
  group: 'stick',
  labelKey: 'schema.sport.handball.name',
  prefix: 'hb',
  scoring: 'points',
  actions: [pts('goal', 'GOAL', 1)],
  lineScore: true,
  rulesets: [
    {
      id: 'ihf',
      labelKey: 'schema.sport.handball.ihf',
      periods: 2,
      periodName: 'half',
      timers: [gameClock(countup(1800, { format: 'mm:ss' })), { id: 'suspension', labelKey: 'schema.sport.timer.suspension', timer: { id: 'suspension', mode: 'countdown', duration: 120 } }],
    },
  ],
  teamStats: [n('shots', 'Shots'), n('saves', 'Saves'), n('turnovers', 'Turnovers')],
  playerStats: [n('goals', 'G'), n('shots', 'SH'), n('assists', 'A'), n('saves', 'SV'), n('suspensions', '2MIN')],
  gameColumns: bothSides([n('Timeouts', 'Timeouts'), n('Suspended', 'Players suspended')]),
};

const waterPolo: SportTemplate = {
  id: 'water-polo',
  group: 'stick',
  labelKey: 'schema.sport.water-polo.name',
  prefix: 'wp',
  scoring: 'points',
  actions: [pts('goal', 'GOAL', 1)],
  lineScore: true,
  rulesets: [
    // 28 s since World Aquatics' 2025 Competition Regulations (WP 9.1); it was 30.
    { id: 'world-aquatics', labelKey: 'schema.sport.water-polo.worldAquatics', periods: 4, periodName: 'quarter', timers: [gameClock(countdown(480, { tenthsUnder: 60 })), shotClock(28)] },
    { id: 'nfhs', labelKey: 'schema.sport.water-polo.nfhs', periods: 4, periodName: 'quarter', timers: [gameClock(countdown(420, { tenthsUnder: 60 })), shotClock(30)] },
  ],
  teamStats: [n('shots', 'Shots'), n('exclusions', 'Exclusions'), n('saves', 'Saves')],
  playerStats: [n('goals', 'G'), n('shots', 'SH'), n('exclusions', 'EX'), n('saves', 'SV')],
  gameColumns: bothSides([n('Timeouts', 'Timeouts'), n('Exclusions', 'Exclusions')]),
};

const cricket: SportTemplate = {
  id: 'cricket',
  group: 'racket',
  labelKey: 'schema.sport.cricket.name',
  prefix: 'crk',
  scoring: 'cricket',
  actions: [
    { id: 'dot', label: '0', adds: {}, ball: true },
    { id: 'one', label: '1', adds: { Runs: 1 }, ball: true },
    { id: 'two', label: '2', adds: { Runs: 2 }, ball: true },
    { id: 'three', label: '3', adds: { Runs: 3 }, ball: true },
    { id: 'four', label: '4', adds: { Runs: 4 }, ball: true },
    { id: 'six', label: '6', adds: { Runs: 6 }, ball: true },
    { id: 'wide', label: 'WD', adds: { Runs: 1, Extras: 1 } },
    { id: 'noball', label: 'NB', adds: { Runs: 1, Extras: 1 } },
    { id: 'bye', label: 'B', adds: { Runs: 1, Extras: 1 }, ball: true },
    { id: 'wicket', label: 'W', adds: { Wickets: 1 }, ball: true },
  ],
  lineScore: false,
  rulesets: [
    { id: 't20', labelKey: 'schema.sport.cricket.t20', periods: 2, periodName: 'innings', timers: [], overs: 20 },
    { id: 'odi', labelKey: 'schema.sport.cricket.odi', periods: 2, periodName: 'innings', timers: [], overs: 50 },
    { id: 'test', labelKey: 'schema.sport.cricket.test', periods: 4, periodName: 'innings', timers: [] },
  ],
  teamStats: [n('runRate', 'Run rate'), n('extras', 'Extras')],
  playerStats: [n('runs', 'R'), n('balls', 'B'), n('fours', '4s'), n('sixes', '6s'), s('strikeRate', 'SR'), s('figures', 'Bowling', { example: '2/31' }), s('economy', 'Econ')],
  gameColumns: [
    s('batting', 'Batting side', { values: ['home', 'away'], required: true, example: 'home' }),
    ...bothSides([n('Runs', 'Runs'), n('Wickets', 'Wickets'), n('Balls', 'Balls'), s('Overs', 'Overs', { example: '12.3' }), n('Extras', 'Extras')]),
    n('target', 'Target'),
    s('runRate', 'Run rate', { example: '7.84' }),
    s('requiredRate', 'Required rate'),
    s('striker', 'Striker'),
    s('nonStriker', 'Non-striker'),
    s('bowler', 'Bowler'),
    s('thisOver', 'This over', { example: '1 4 0 W' }),
  ],
};

const serveClock: SportTimerSpec = {
  id: 'serve',
  labelKey: 'schema.sport.timer.serve',
  timer: { id: 'serve', mode: 'countdown', duration: 25, format: 's' },
};

const tennis: SportTemplate = {
  id: 'tennis',
  group: 'racket',
  labelKey: 'schema.sport.tennis.name',
  prefix: 'ten',
  scoring: 'tennis',
  actions: [],
  lineScore: true,
  individual: true,
  rulesets: [
    { id: 'best-of-3', labelKey: 'schema.sport.tennis.bestOf3', periods: 3, periodName: 'set', toWin: 2, gamesPerSet: 6, tiebreakPoints: 7, decidingTiebreakPoints: 7, timers: [serveClock] },
    { id: 'best-of-5', labelKey: 'schema.sport.tennis.bestOf5', periods: 5, periodName: 'set', toWin: 3, gamesPerSet: 6, tiebreakPoints: 7, decidingTiebreakPoints: 10, timers: [serveClock] },
  ],
  teamStats: [n('aces', 'Aces'), n('doubleFaults', 'Double faults'), s('firstServePct', '1st serve %'), n('winners', 'Winners'), n('unforcedErrors', 'Unforced errors'), s('breakPoints', 'Break points', { example: '3/7' })],
  playerStats: [n('ranking', 'Rank'), s('country', 'Country', { example: 'USA' }), s('plays', 'Plays', { example: 'Right-handed' }), n('age', 'Age')],
  gameColumns: [...bothSides([n('Sets', 'Sets'), n('Games', 'Games'), n('Points', 'Points'), s('PointText', 'Point', { example: '40' })]), s('serving', 'Serving', { values: ['home', 'away'] }), b('tiebreak', 'Tiebreak')],
};

const rallyGame = (id: string, prefix: string, labelKey: string, rulesets: SportRuleset[]): SportTemplate => ({
  id,
  group: 'racket',
  labelKey,
  prefix,
  scoring: 'rally',
  actions: [],
  lineScore: true,
  individual: true,
  rulesets,
  teamStats: [n('winners', 'Winners'), n('errors', 'Errors')],
  playerStats: [n('ranking', 'Rank'), s('country', 'Country', { example: 'JPN' })],
  gameColumns: [...bothSides([n('Games', 'Games'), n('Points', 'Points')]), s('serving', 'Serving', { values: ['home', 'away'] })],
});

const badminton = rallyGame('badminton', 'bdm', 'schema.sport.badminton.name', [
  { id: 'bwf', labelKey: 'schema.sport.badminton.bwf', periods: 3, periodName: 'game', timers: [], pointsToWin: 21, winBy: 2, cap: 30, toWin: 2 },
]);

const tableTennis = rallyGame('table-tennis', 'tt', 'schema.sport.table-tennis.name', [
  { id: 'best-of-5', labelKey: 'schema.sport.table-tennis.bestOf5', periods: 5, periodName: 'game', timers: [], pointsToWin: 11, winBy: 2, toWin: 3 },
  { id: 'best-of-7', labelKey: 'schema.sport.table-tennis.bestOf7', periods: 7, periodName: 'game', timers: [], pointsToWin: 11, winBy: 2, toWin: 4 },
]);

const pickleball: SportTemplate = {
  ...rallyGame('pickleball', 'pkl', 'schema.sport.pickleball.name', [
    { id: 'doubles', labelKey: 'schema.sport.pickleball.doubles', periods: 3, periodName: 'game', timers: [], pointsToWin: 11, winBy: 2, toWin: 2, doubles: true },
    { id: 'singles', labelKey: 'schema.sport.pickleball.singles', periods: 3, periodName: 'game', timers: [], pointsToWin: 11, winBy: 2, toWin: 2 },
  ]),
  scoring: 'sideout',
  gameColumns: [
    ...bothSides([n('Games', 'Games'), n('Points', 'Points')]),
    s('serving', 'Serving', { values: ['home', 'away'] }),
    n('serverNumber', 'Server', { example: 2 }),
    s('call', 'Score call', { example: '4-2-1' }),
  ],
};

/** Every template, in the order the picker shows them. */
export const SPORT_TEMPLATES: readonly SportTemplate[] = [
  basketball,
  americanFootball,
  baseball,
  softball,
  volleyball,
  soccer,
  rugbyUnion,
  rugbyLeague,
  aussieRules,
  gaelicFootball,
  hurling,
  iceHockey,
  fieldHockey,
  lacrosse,
  handball,
  waterPolo,
  cricket,
  tennis,
  badminton,
  tableTennis,
  pickleball,
];

/** Catalogue keys for the picker's groups. */
export const SPORT_GROUP_LABEL_KEYS: Record<SportGroup, string> = {
  us: 'schema.sport.group.us',
  football: 'schema.sport.group.football',
  stick: 'schema.sport.group.stick',
  racket: 'schema.sport.group.racket',
};

/** Catalogue keys for the five tables' names. */
export const SPORT_TABLE_LABEL_KEYS: Record<SportTable, string> = {
  teams: 'schema.sport.table.teams',
  players: 'schema.sport.table.players',
  coaches: 'schema.sport.table.coaches',
  venue: 'schema.sport.table.venue',
  game: 'schema.sport.table.game',
};

export function sportTemplate(id: string): SportTemplate | undefined {
  return SPORT_TEMPLATES.find((t) => t.id === id);
}

export function sportRuleset(template: SportTemplate, id: string | undefined): SportRuleset {
  return template.rulesets.find((r) => r.id === id) ?? template.rulesets[0]!;
}

/* ----------------------------------------------------------------- tables */

/** What a data source remembers about the template it was made from. */
export interface SportTemplateRef {
  sport: string;
  ruleset: string;
  table: SportTable;
}

const SIDE_VALUES = ['home', 'away'] as const;

function teamColumns(t: SportTemplate): SportColumn[] {
  return [
    s('side', 'Side', { required: true, values: SIDE_VALUES, example: 'home' }),
    s('name', 'Name', { required: true, example: t.individual ? 'A. Player' : 'Phoenix' }),
    s('shortName', 'Short name', { example: t.individual ? 'Player' : 'PHX Suns' }),
    s('abbr', 'Abbreviation', { required: !t.individual, example: t.individual ? 'PLA' : 'PHX' }),
    s('color', 'Colour', { example: '#e56020' }),
    s('color2', 'Second colour', { example: '#1d1160' }),
    s('logo', 'Logo', { example: 'assets/logo-home.png' }),
    ...(t.individual ? [s('country', 'Country', { example: 'USA' }), n('seed', 'Seed')] : [s('record', 'Record', { example: '12-4' }), n('rank', 'Rank'), s('coach', 'Coach')]),
    ...t.teamStats,
  ];
}

function playerColumns(t: SportTemplate): SportColumn[] {
  return [
    s('team', 'Team', { required: !t.individual, example: t.individual ? 'home' : 'PHX' }),
    s('number', 'Number', { required: !t.individual, example: '23' }),
    s('name', 'Name', { required: true, example: 'Jordan Smith' }),
    s('firstName', 'First name', { example: 'Jordan' }),
    s('lastName', 'Last name', { example: 'Smith' }),
    s('position', 'Position', { example: t.individual ? '' : 'G' }),
    s('headshot', 'Headshot', { example: 'assets/smith.png' }),
    b('starter', 'Starter'),
    b('active', 'On the field'),
    ...t.playerStats,
  ];
}

const COACH_COLUMNS: SportColumn[] = [
  s('team', 'Team', { required: true, example: 'PHX' }),
  s('name', 'Name', { required: true, example: 'Pat Lee' }),
  s('role', 'Role', { required: true, example: 'Head coach' }),
  s('headshot', 'Headshot', { example: 'assets/lee.png' }),
];

const VENUE_COLUMNS: SportColumn[] = [
  s('name', 'Venue', { required: true, example: 'Footprint Center' }),
  s('city', 'City', { example: 'Phoenix' }),
  s('region', 'State / region', { example: 'AZ' }),
  n('capacity', 'Capacity', { example: 17071 }),
  n('attendance', 'Attendance', { example: 16210 }),
  s('surface', 'Surface', { example: 'Hardwood' }),
  s('weather', 'Weather', { example: 'Indoors' }),
  s('officials', 'Officials', { example: 'J. Doe, A. Roe' }),
  s('broadcast', 'Broadcast', { example: 'Channel 5' }),
  s('notes', 'Notes'),
];

/** The line-score columns: `home1`…`homeN` and `homeOT` (or `homeX` for extra innings). */
function lineColumns(t: SportTemplate, r: SportRuleset): SportColumn[] {
  if (!t.lineScore) return [];
  const out: SportColumn[] = [];
  const extra = t.scoring === 'points' ? (r.periodName === 'inning' ? 'X' : 'OT') : null;
  for (const side of SIDES) {
    for (let p = 1; p <= r.periods; p += 1) out.push(n(`${side}${p}`, `${side === 'home' ? 'Home' : 'Away'} ${p}`));
    if (extra) out.push(n(`${side}${extra}`, `${side === 'home' ? 'Home' : 'Away'} ${extra}`));
  }
  return out;
}

function gameColumns(t: SportTemplate, r: SportRuleset): SportColumn[] {
  return [
    s('status', 'Status', { required: true, values: ['pre', 'live', 'final'], example: 'live' }),
    n('period', 'Period', { required: true, example: 2 }),
    s('periodLabel', 'Period label', { example: periodLabel(r, 2, 'top') }),
    n('homeScore', 'Home score', { required: true, example: 54 }),
    n('awayScore', 'Away score', { required: true, example: 51 }),
    s('possession', 'Possession', { values: ['home', 'away', ''] }),
    ...lineColumns(t, r),
    ...t.gameColumns,
  ];
}

/** The columns of one table of a template. */
export function sportTableColumns(t: SportTemplate, r: SportRuleset, table: SportTable): SportColumn[] {
  switch (table) {
    case 'teams':
      return teamColumns(t);
    case 'players':
      return playerColumns(t);
    case 'coaches':
      return COACH_COLUMNS;
    case 'venue':
      return VENUE_COLUMNS;
    case 'game':
      return gameColumns(t, r);
  }
}

/** Plain `DataColumn`s, for a source's `columns` — the guide-only fields dropped. */
export function sportDataColumns(t: SportTemplate, r: SportRuleset, table: SportTable): DataColumn[] {
  return sportTableColumns(t, r, table).map(({ key, label, type }) => ({ key, label, type }));
}

const blankValue = (c: SportColumn): DataValue => (c.type === 'number' ? 0 : c.type === 'boolean' ? false : '');

function rowOf(columns: SportColumn[], values: Record<string, DataValue>): DataRow {
  const row: DataRow = {};
  for (const c of columns) row[c.key] = c.key in values ? values[c.key]! : blankValue(c);
  return row;
}

/** The rows a new manual table starts with. */
export function sportSeedRows(t: SportTemplate, r: SportRuleset, table: SportTable): DataRow[] {
  const cols = sportTableColumns(t, r, table);
  switch (table) {
    case 'teams':
      return [
        rowOf(cols, { side: 'home', name: t.individual ? 'Player A' : 'Home', shortName: t.individual ? 'A' : 'Home', abbr: t.individual ? '' : 'HOME', color: '#1f4e9c', color2: '#ffffff' }),
        rowOf(cols, { side: 'away', name: t.individual ? 'Player B' : 'Away', shortName: t.individual ? 'B' : 'Away', abbr: t.individual ? '' : 'AWAY', color: '#c8102e', color2: '#ffffff' }),
      ];
    case 'players':
      return [
        rowOf(cols, { team: t.individual ? 'home' : 'HOME', number: t.individual ? '' : '1', name: 'Home Player' }),
        rowOf(cols, { team: t.individual ? 'away' : 'AWAY', number: t.individual ? '' : '1', name: 'Away Player' }),
      ];
    case 'coaches':
      return t.individual
        ? []
        : [rowOf(cols, { team: 'HOME', name: 'Home Coach', role: 'Head coach' }), rowOf(cols, { team: 'AWAY', name: 'Away Coach', role: 'Head coach' })];
    case 'venue':
      return [rowOf(cols, { name: 'Venue' })];
    case 'game':
      return [newGameRow(t, r)];
  }
}

/** A game row at the start: zeros, period 1, and the sport's own starting values. */
export function newGameRow(t: SportTemplate, r: SportRuleset): DataRow {
  const cols = gameColumns(t, r);
  const start: Record<string, DataValue> = { status: 'pre', period: 1 };
  if (t.id === 'american-football') Object.assign(start, { down: 1, distance: 10, homeTimeouts: 3, awayTimeouts: 3 });
  if (r.periodName === 'inning') Object.assign(start, { half: 'top', scheduledInnings: r.periods });
  if (t.scoring === 'cricket') start['batting'] = 'home';
  if (t.scoring === 'rally' || t.scoring === 'tennis' || t.scoring === 'sideout') start['serving'] = 'home';
  if (t.scoring === 'sideout') start['serverNumber'] = r.doubles ? 2 : 1;
  if (t.id === 'ice-hockey') Object.assign(start, { homeSkaters: 5, awaySkaters: 5 });
  return deriveGameRow(t, r, rowOf(cols, start), { label: true });
}

/* ---------------------------------------------------------------- labels */

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`;
}

/**
 * The period as a broadcast writes it: `3rd`, `OT`, `2OT`, `2nd Half`,
 * `Top 7th`, `Set 3`, `2nd innings`. A value, not interface text — an operator
 * who wants `Q3` types it into the row.
 */
export function periodLabel(r: SportRuleset, period: number, half?: DataValue): string {
  const p = Math.max(1, Math.trunc(period) || 1);
  const over = p - r.periods;
  switch (r.periodName) {
    case 'quarter':
    case 'period':
      if (over <= 0) return ordinal(p);
      if (r.periodName === 'period' && over === 2) return 'SO';
      return over === 1 ? 'OT' : `${over}OT`;
    case 'half':
      if (over <= 0) return `${ordinal(p)} Half`;
      return over === 1 ? 'OT' : `${over}OT`;
    case 'inning':
      return `${half === 'bottom' ? 'Bot' : 'Top'} ${ordinal(p)}`;
    case 'set':
      return `Set ${p}`;
    case 'game':
      return `Game ${p}`;
    case 'innings':
      return `${ordinal(p)} innings`;
  }
}

/* ---------------------------------------------------------------- derive */

const num = (v: DataValue | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

const TENNIS_POINTS = ['0', '15', '30', '40'];

/**
 * Columns that are worked out from others, so they can never disagree: an
 * AFL score from goals and behinds, a GAA `1-12`, cricket's overs and run
 * rates, a tennis point as `15`/`40`/`AD`, pickleball's score call. With
 * `label`, `periodLabel` is rewritten too — only when the period moved, so an
 * operator's own label survives a score.
 */
export function deriveGameRow(t: SportTemplate, r: SportRuleset, row: DataRow, opts: { label?: boolean } = {}): DataRow {
  const out: DataRow = { ...row };
  if (opts.label) out['periodLabel'] = periodLabel(r, num(out['period']), out['half']);

  for (const side of SIDES) {
    if (t.id === 'aussie-rules') {
      const g = num(out[`${side}Goals`]);
      const bh = num(out[`${side}Behinds`]);
      out[`${side}Score`] = g * 6 + bh;
      out[`${side}Display`] = `${g}.${bh}.${g * 6 + bh}`;
    }
    if (t.id === 'gaelic-football' || t.id === 'hurling') {
      const g = num(out[`${side}Goals`]);
      const p = num(out[`${side}Points`]);
      out[`${side}Score`] = g * 3 + p;
      out[`${side}Display`] = `${g}-${String(p).padStart(2, '0')}`;
    }
    if (t.scoring === 'cricket') {
      const balls = num(out[`${side}Balls`]);
      out[`${side}Overs`] = `${Math.floor(balls / 6)}.${balls % 6}`;
      out[`${side}Score`] = num(out[`${side}Runs`]);
    }
    if (t.scoring === 'tennis') out[`${side}Score`] = num(out[`${side}Sets`]);
    if (t.scoring === 'rally' || t.scoring === 'sideout') out[`${side}Score`] = num(out[`${side}Games`]);
  }

  if (t.scoring === 'cricket') {
    const bat = out['batting'] === 'away' ? 'away' : 'home';
    const runs = num(out[`${bat}Runs`]);
    const balls = num(out[`${bat}Balls`]);
    out['runRate'] = balls > 0 ? ((runs * 6) / balls).toFixed(2) : '';
    const target = num(out['target']);
    if (target > 0 && r.overs) {
      const left = r.overs * 6 - balls;
      const need = target - runs;
      out['requiredRate'] = left > 0 && need > 0 ? ((need * 6) / left).toFixed(2) : '';
    } else {
      out['requiredRate'] = '';
    }
  }

  if (t.scoring === 'tennis') {
    const hp = num(out['homePoints']);
    const ap = num(out['awayPoints']);
    if (out['tiebreak'] === true) {
      out['homePointText'] = String(hp);
      out['awayPointText'] = String(ap);
    } else if (hp >= 3 && ap >= 3) {
      out['homePointText'] = hp === ap ? '40' : hp > ap ? 'AD' : '40';
      out['awayPointText'] = hp === ap ? '40' : ap > hp ? 'AD' : '40';
    } else {
      out['homePointText'] = TENNIS_POINTS[Math.min(hp, 3)]!;
      out['awayPointText'] = TENNIS_POINTS[Math.min(ap, 3)]!;
    }
  }

  if (t.scoring === 'sideout') {
    const serving = out['serving'] === 'away' ? 'away' : 'home';
    const other = serving === 'home' ? 'away' : 'home';
    const call = `${num(out[`${serving}Points`])}-${num(out[`${other}Points`])}`;
    out['call'] = r.doubles ? `${call}-${num(out['serverNumber']) || 1}` : call;
  }
  return out;
}

/* --------------------------------------------------------------- actions */

/** What a panel button, Companion or REST asks of a game row. */
export type GameAction =
  /** A scoring button — `action` is a `ScoringAction` id. Cricket ignores `side`: it scores for the batting side. */
  | { type: 'score'; side: Side; action: string }
  /** The same button taken back — a mistake corrected. */
  | { type: 'unscore'; side: Side; action: string }
  /** A rally, a tennis point, a pickleball rally won by `side`. */
  | { type: 'point'; side: Side }
  /** Add to any number on the row — fouls, timeouts, the down. Never below 0. */
  | { type: 'adjust'; column: string; delta: number }
  /** Write one column. */
  | { type: 'set'; column: string; value: DataValue }
  /** The next or previous period (half-inning for baseball). */
  | { type: 'period'; delta: 1 | -1 }
  /** Back to the start of the game. */
  | { type: 'reset' };

const other = (side: Side): Side => (side === 'home' ? 'away' : 'home');
const add = (row: DataRow, key: string, delta: number): void => {
  row[key] = Math.max(0, num(row[key]) + delta);
};

function scoreAction(t: SportTemplate, r: SportRuleset, row: DataRow, side: Side, id: string, sign: 1 | -1): DataRow {
  const action = t.actions.find((a) => a.id === id);
  if (!action) return row;
  const out = { ...row };
  const who: Side = t.scoring === 'cricket' ? (out['batting'] === 'away' ? 'away' : 'home') : side;
  for (const [stem, value] of Object.entries(action.adds)) add(out, `${who}${stem}`, sign * value);
  // The headline score follows a `Score` stem; AFL and GAA derive theirs.
  if (t.lineScore && action.adds['Score']) {
    const period = num(out['period']) || 1;
    const extra = r.periodName === 'inning' ? 'X' : 'OT';
    add(out, period <= r.periods ? `${who}${period}` : `${who}${extra}`, sign * action.adds['Score']);
  }
  if (t.scoring === 'cricket') {
    if (action.ball) add(out, `${who}Balls`, sign);
    if (sign === 1) {
      const balls = num(out[`${who}Balls`]);
      const started = action.ball && balls % 6 === 1;
      const list = started || !out['thisOver'] ? [] : String(out['thisOver']).split(' ');
      out['thisOver'] = [...list, action.label].join(' ');
    }
  }
  return out;
}

function rallyPoint(t: SportTemplate, r: SportRuleset, row: DataRow, side: Side): DataRow {
  const out = { ...row };
  if (out['status'] === 'final') return out;

  if (t.scoring === 'sideout' && out['serving'] !== side) {
    // Only the serving side scores. A rally lost by the server is a fault:
    // the partner serves, or the serve passes across.
    if (r.doubles && num(out['serverNumber']) === 1) out['serverNumber'] = 2;
    else {
      out['serving'] = side;
      out['serverNumber'] = 1;
    }
    return deriveGameRow(t, r, out);
  }

  add(out, `${side}Points`, 1);
  const hp = num(out['homePoints']);
  const ap = num(out['awayPoints']);
  const mine = side === 'home' ? hp : ap;
  const theirs = side === 'home' ? ap : hp;
  const game = num(out['homeGames']) + num(out['awayGames']) + 1;
  const deciding = game === r.periods;
  const target = deciding && r.decidingPointsToWin ? r.decidingPointsToWin : (r.pointsToWin ?? 21);
  const won = (mine >= target && mine - theirs >= (r.winBy ?? 2)) || (r.cap !== undefined && mine >= r.cap);

  if (t.scoring === 'rally') {
    if (t.id === 'table-tennis') {
      const total = hp + ap;
      if ((hp >= 10 && ap >= 10) || total % 2 === 0) out['serving'] = other(out['serving'] === 'away' ? 'away' : 'home');
    } else {
      out['serving'] = side;
    }
  }

  if (t.lineScore && game <= r.periods) {
    out[`home${game}`] = hp;
    out[`away${game}`] = ap;
  }
  if (!won) return deriveGameRow(t, r, out);

  add(out, `${side}Games`, 1);
  out['homePoints'] = 0;
  out['awayPoints'] = 0;
  if (num(out[`${side}Games`]) >= (r.toWin ?? Math.ceil(r.periods / 2))) {
    out['status'] = 'final';
  } else {
    out['period'] = game + 1;
    if (t.scoring === 'sideout') {
      out['serving'] = other(side);
      out['serverNumber'] = r.doubles ? 2 : 1;
    }
  }
  return deriveGameRow(t, r, out, { label: true });
}

function tennisPoint(t: SportTemplate, r: SportRuleset, row: DataRow, side: Side): DataRow {
  const out = { ...row };
  if (out['status'] === 'final') return out;
  const set = num(out['homeSets']) + num(out['awaySets']) + 1;
  const deciding = set === r.periods;
  const perSet = r.gamesPerSet ?? 6;
  add(out, `${side}Points`, 1);
  const mine = num(out[`${side}Points`]);
  const theirs = num(out[`${other(side)}Points`]);

  const winGame = (): void => {
    add(out, `${side}Games`, 1);
    out['homePoints'] = 0;
    out['awayPoints'] = 0;
    out['serving'] = other(out['serving'] === 'away' ? 'away' : 'home');
  };
  const winSet = (): void => {
    out[`home${set}`] = num(out['homeGames']);
    out[`away${set}`] = num(out['awayGames']);
    add(out, `${side}Sets`, 1);
    out['homeGames'] = 0;
    out['awayGames'] = 0;
    out['tiebreak'] = false;
    if (num(out[`${side}Sets`]) >= (r.toWin ?? 2)) out['status'] = 'final';
    else out['period'] = set + 1;
  };

  if (out['tiebreak'] === true) {
    const needed = deciding ? (r.decidingTiebreakPoints ?? 7) : (r.tiebreakPoints ?? 7);
    // The serve changes after the first point, then every two.
    if ((mine + theirs) % 2 === 1) out['serving'] = other(out['serving'] === 'away' ? 'away' : 'home');
    if (mine >= needed && mine - theirs >= 2) {
      winGame();
      winSet();
      return deriveGameRow(t, r, out, { label: true });
    }
  } else if (mine >= 4 && mine - theirs >= 2) {
    winGame();
    const g = num(out[`${side}Games`]);
    const og = num(out[`${other(side)}Games`]);
    if (g >= perSet && g - og >= 2) {
      winSet();
      return deriveGameRow(t, r, out, { label: true });
    }
    if (g === perSet && og === perSet) out['tiebreak'] = true;
  }
  out[`home${set}`] = num(out['homeGames']);
  out[`away${set}`] = num(out['awayGames']);
  return deriveGameRow(t, r, out);
}

function changePeriod(t: SportTemplate, r: SportRuleset, row: DataRow, delta: 1 | -1): DataRow {
  const out = { ...row };
  const period = num(out['period']) || 1;
  if (r.periodName === 'inning') {
    // Half-innings: top → bottom → next top. The count resets with the half.
    const bottom = out['half'] === 'bottom';
    if (delta === 1) {
      if (bottom) out['period'] = period + 1;
      out['half'] = bottom ? 'top' : 'bottom';
    } else if (bottom || period > 1) {
      if (!bottom) out['period'] = period - 1;
      out['half'] = bottom ? 'top' : 'bottom';
    }
    Object.assign(out, { balls: 0, strikes: 0, outs: 0, onFirst: false, onSecond: false, onThird: false });
    return deriveGameRow(t, r, out, { label: true });
  }
  out['period'] = Math.max(1, Math.min(r.periods + 9, period + delta));
  if (t.id === 'basketball' && delta === 1) {
    Object.assign(out, { homeFouls: 0, awayFouls: 0, homeBonus: false, awayBonus: false });
  }
  if (t.scoring === 'cricket' && delta === 1) {
    out['batting'] = other(out['batting'] === 'away' ? 'away' : 'home');
    out['thisOver'] = '';
  }
  return deriveGameRow(t, r, out, { label: true });
}

/**
 * Apply one action to a game row and return the new row. Pure: the server
 * calls it under the project's lock, a test calls it directly. An action the
 * sport does not have, or a column the row does not have, changes nothing.
 */
export function applyGameAction(t: SportTemplate, r: SportRuleset, row: DataRow, action: GameAction): DataRow {
  switch (action.type) {
    case 'score':
    case 'unscore':
      return deriveGameRow(t, r, scoreAction(t, r, row, action.side, action.action, action.type === 'score' ? 1 : -1));
    case 'point':
      if (t.scoring === 'tennis') return tennisPoint(t, r, row, action.side);
      if (t.scoring === 'rally' || t.scoring === 'sideout') return rallyPoint(t, r, row, action.side);
      return row;
    case 'adjust': {
      if (!(action.column in row) || !Number.isFinite(action.delta)) return row;
      const out = { ...row };
      add(out, action.column, action.delta);
      return deriveGameRow(t, r, out);
    }
    case 'set': {
      if (!(action.column in row)) return row;
      const column = gameColumns(t, r).find((c) => c.key === action.column);
      let value = action.value;
      if (column?.type === 'number') value = num(value);
      if (column?.type === 'boolean') value = value === true || value === 'true' || value === 1 || value === '1';
      if (column?.type === 'string') value = value == null ? '' : String(value);
      return deriveGameRow(t, r, { ...row, [action.column]: value }, { label: action.column === 'period' || action.column === 'half' });
    }
    case 'period':
      return changePeriod(t, r, row, action.delta);
    case 'reset':
      return newGameRow(t, r);
  }
}

/* -------------------------------------------------- format guide & check */

export interface SportTableCheck {
  ok: boolean;
  /** Required columns the feed does not have. */
  missing: string[];
  /** A number column holding something that is not one — the first few. */
  mistyped: Array<{ column: string; row: number; value: DataValue }>;
  /** A closed-list column holding something else — `side: "visitors"`. */
  unexpected: Array<{ column: string; row: number; value: DataValue }>;
  /** Columns the template does not know. Fine — a graphic may use them — but worth saying. */
  extra: string[];
}

/**
 * How a fetched table measures against its template: what a Sheet or feed is
 * missing before a graphic built on the template will work. Run on the rows a
 * preview or a poll returned.
 */
export function checkSportTable(t: SportTemplate, r: SportRuleset, table: SportTable, data: Pick<DataSet, 'columns' | 'rows'>): SportTableCheck {
  const cols = sportTableColumns(t, r, table);
  const present = new Set([...data.columns.map((c) => c.key), ...data.rows.flatMap((row) => Object.keys(row))]);
  const missing = cols.filter((c) => c.required && !present.has(c.key)).map((c) => c.key);
  const mistyped: SportTableCheck['mistyped'] = [];
  const unexpected: SportTableCheck['unexpected'] = [];
  data.rows.forEach((row, i) => {
    for (const c of cols) {
      const v = row[c.key];
      if (v === undefined || v === null || v === '') continue;
      if (c.type === 'number' && mistyped.length < 10 && !Number.isFinite(typeof v === 'number' ? v : Number(v))) {
        mistyped.push({ column: c.key, row: i + 1, value: v });
      }
      if (c.values && unexpected.length < 10 && !c.values.includes(String(v).trim().toLowerCase())) {
        unexpected.push({ column: c.key, row: i + 1, value: v });
      }
    }
  });
  const known = new Set(cols.map((c) => c.key));
  const extra = [...present].filter((k) => !known.has(k));
  return { ok: missing.length === 0 && mistyped.length === 0 && unexpected.length === 0, missing, mistyped, unexpected, extra };
}

function csvCell(v: DataValue | undefined): string {
  const text = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * A starter file for a fetched source: the header row, then the template's
 * seed rows (or one example row) — paste it into a Sheet, publish it, point
 * the source at it.
 */
export function sportCsv(t: SportTemplate, r: SportRuleset, table: SportTable): string {
  const cols = sportTableColumns(t, r, table);
  const seeds = sportSeedRows(t, r, table);
  const rows = seeds.length ? seeds : [Object.fromEntries(cols.map((c) => [c.key, c.example ?? blankValue(c)]))];
  return [cols.map((c) => csvCell(c.key)).join(','), ...rows.map((row) => cols.map((c) => csvCell(row[c.key])).join(','))].join('\n') + '\n';
}

/** The same as JSON — an array of row objects, the shape `http-json` reads with no path. */
export function sportJsonSample(t: SportTemplate, r: SportRuleset, table: SportTable): string {
  const cols = sportTableColumns(t, r, table);
  const example = Object.fromEntries(cols.map((c) => [c.key, c.example ?? blankValue(c)]));
  return `${JSON.stringify([example], null, 2)}\n`;
}

/** Source ids a template creates: `bball-teams`, `bball-game`… */
export function sportSourceId(prefix: string, table: SportTable): string {
  return `${prefix}-${table}`;
}

/** The timers the sports templates in a project's sources run — offered as presets on a text layer. */
export function sportTimersFor(refs: ReadonlyArray<SportTemplateRef | undefined>): Array<{ sport: SportTemplate; ruleset: SportRuleset; spec: SportTimerSpec }> {
  const out: Array<{ sport: SportTemplate; ruleset: SportRuleset; spec: SportTimerSpec }> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref) continue;
    const sport = sportTemplate(ref.sport);
    if (!sport) continue;
    const ruleset = sportRuleset(sport, ref.ruleset);
    for (const spec of ruleset.timers) {
      const key = `${sport.id}/${ruleset.id}/${spec.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ sport, ruleset, spec });
    }
  }
  return out;
}
