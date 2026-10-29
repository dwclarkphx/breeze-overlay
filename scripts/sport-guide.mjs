#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * sport-guide.mjs — writes docs/SPORT-TEMPLATES.md from the sport catalogue.
 *
 * The catalogue (`@breeze/schema` sports.ts) is what the editor's format guide,
 * the starter CSV and the table check all read, so the reference is generated
 * from it too rather than typed: a column renamed in code cannot leave the
 * guide describing the old one. The one thing the catalogue does not hold is
 * where each rule set's durations and scoring come from — the governing
 * bodies' own documents — so those links live here, in RULE_SOURCES.
 *
 * Reads the built schema (packages/schema/dist), so build first.
 *
 * Usage:
 *   node scripts/sport-guide.mjs          # write docs/SPORT-TEMPLATES.md
 *   node scripts/sport-guide.mjs --check  # exit 1 if the file is out of date
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'docs', 'SPORT-TEMPLATES.md');

const schema = await import(pathToFileURL(path.join(root, 'packages/schema/dist/index.js')).href);
const { SPORT_TEMPLATES, sportTableColumns, deriveGameRow } = schema;
const en = JSON.parse(fs.readFileSync(path.join(root, 'packages/i18n/locales/en.json'), 'utf8'));
const t = (key) => en[key] ?? key;

/* ----------------------------------------------------------------- sources */

const NFHS = (sport, name) => ({ title: `NFHS ${name} (rules books are sold through NFHS)`, url: `https://nfhs.org/sports/${sport}` });

/**
 * Where each rule set's numbers come from, checked 2026-10-27. Prefer a
 * governing body's own page over a PDF whose address changes every season.
 * Keyed `<sport>/<rule set>`; `<sport>/*` applies to every rule set of it.
 */
const RULE_SOURCES = {
  'basketball/nba': [{ title: 'NBA Official Rule Book', url: 'https://official.nba.com/rulebook' }],
  'basketball/wnba': [{ title: 'WNBA Rule Book', url: 'https://www.wnba.com/wnba-rule-book' }],
  'basketball/ncaa-men': [{ title: "NCAA men's basketball playing rules", url: 'https://www.ncaa.org/championships/playing-rules/mens-basketball-playing-rules/' }],
  'basketball/ncaa-women': [{ title: "NCAA women's basketball playing rules", url: 'https://www.ncaa.org/championships/playing-rules/womens-basketball-playing-rules/' }],
  'basketball/nfhs': [NFHS('basketball', 'basketball')],
  'basketball/fiba': [{ title: 'FIBA Official Basketball Rules', url: 'https://refereeing.fiba.basketball/en/rules' }],
  'american-football/nfl': [{ title: 'NFL Rulebook', url: 'https://operations.nfl.com/the-rules/nfl-rulebook/' }],
  'american-football/ncaa': [{ title: 'NCAA football playing rules', url: 'https://www.ncaa.org/championships/playing-rules/football-playing-rules/' }],
  'american-football/nfhs': [NFHS('football', 'football')],
  'baseball/mlb': [{ title: 'MLB: Pitch timer', url: 'https://www.mlb.com/glossary/rules/pitch-timer' }],
  'baseball/nfhs': [NFHS('baseball', 'baseball')],
  'softball/ncaa': [{ title: 'NCAA softball playing rules', url: 'https://www.ncaa.org/championships/playing-rules/softball-playing-rules/' }],
  'softball/nfhs': [NFHS('softball', 'softball')],
  'volleyball/fivb': [{ title: 'FIVB Official Volleyball Rules', url: 'https://www.fivb.com/volleyball/the-game/official-volleyball-rules/' }],
  'volleyball/nfhs': [NFHS('volleyball', 'volleyball')],
  'volleyball/beach': [{ title: 'FIVB Official Beach Volleyball Rules', url: 'https://www.fivb.com/beach-volleyball/the-game/official-rules-of-the-games/' }],
  'soccer/fifa': [{ title: 'IFAB Laws of the Game — Law 7, The Duration of the Match', url: 'https://theifab.com/laws/latest/the-duration-of-the-match' }],
  'soccer/youth': [{ title: 'IFAB Laws of the Game — modifications for youth football', url: 'https://www.theifab.com/laws/latest/general-modifications' }],
  'soccer/nfhs': [NFHS('soccer', 'soccer')],
  'soccer/futsal': [{ title: 'Futsal Laws of the Game 2025/26 (U.S. Soccer)', url: 'https://ussoccer.com/stories/2025/10/futsal-lotg' }],
  'rugby-union/world-rugby': [{ title: 'World Rugby Laws of the Game', url: 'https://passport.world.rugby/laws-of-the-game/' }],
  'rugby-union/sevens': [{ title: 'World Rugby — Sevens variations', url: 'https://passport.world.rugby/laws-of-the-game/variations/sevens/' }],
  'rugby-league/nrl': [{ title: 'Rugby League Laws of the Game, International Level (NRL, PDF)', url: 'https://www.nrl.com/siteassets/operations/the-game/nrl-international-rules-book-2023.pdf' }],
  'aussie-rules/afl': [{ title: 'Laws of Australian Football 2026 (AFL, PDF)', url: 'https://play.afl/sites/default/files/2026-02/Laws%20of%20Australian%20Football%202026.pdf' }],
  'gaelic-football/*': [{ title: 'GAA Official Guides (Part 2 holds the playing rules)', url: 'https://www.gaa.ie/article/gaa-official-guides-codes' }],
  'hurling/*': [{ title: 'GAA Official Guides (Part 2 holds the playing rules)', url: 'https://www.gaa.ie/article/gaa-official-guides-codes' }],
  'ice-hockey/nhl': [{ title: 'NHL Official Rules 2024–25 (PDF)', url: 'https://media.nhl.com/site/asset/public/ext/2024-25/2024-25Rules.pdf' }],
  'ice-hockey/iihf': [{ title: 'IIHF Official Rule Book 2026–27 (PDF)', url: 'https://blob.iihf.com/iihf-media/iihfmvc/media/downloads/rule%20book/2026-27_iihf_rule_book.pdf' }],
  'ice-hockey/nfhs': [NFHS('ice-hockey', 'ice hockey'), { title: 'NFHS ice hockey rules brochure (17-minute periods, PDF)', url: 'https://assets.nfhs.org/umbraco/media/869198/nfhs-hockey-brochure.pdf' }],
  'field-hockey/fih': [{ title: 'FIH Rules of Hockey', url: 'https://www.fih.hockey/about-fih/official-documents/rules-of-hockey' }],
  'field-hockey/nfhs': [NFHS('field-hockey', 'field hockey')],
  'lacrosse/ncaa-men': [{ title: "NCAA men's lacrosse rules", url: 'https://ncaa.org/sports/2013/11/26/men-s-lacrosse-rules-of-the-game.aspx' }, { title: 'NCAA: 80-second shot clock', url: 'https://www.ncaa.org/news/2018/9/13/men-s-lacrosse-adds-80-second-shot-clock.aspx' }],
  'lacrosse/ncaa-women': [{ title: "NCAA women's lacrosse playing rules", url: 'https://www.ncaa.org/championships/playing-rules/womens-lacrosse-playing-rules/' }],
  'lacrosse/box': [{ title: 'NLL Rulebook 2019–20, the last the league published openly (PDF)', url: 'https://nll.com/wp-content/uploads/2020/11/NLL-2019-20-Rulebook-FINAL.pdf' }],
  'handball/ihf': [{ title: 'IHF Rules of the Game (Indoor Handball)', url: 'https://www.ihf.info/node/8127' }],
  'water-polo/world-aquatics': [
    { title: 'World Aquatics water polo rules, February 2026 extract (British Water Polo League, PDF)', url: 'https://www.bwpl.org/uploads/2/6/5/9/26598283/water_polo_rules_extract_from_2026-02-18_world-aquatics_cr-final.pdf' },
    { title: 'World Aquatics: 2025 competition regulation updates', url: 'https://www.worldaquatics.com/news/4186172/world-aquatics-updates-competition-regulations-2025' },
  ],
  'water-polo/nfhs': [NFHS('water-polo', 'water polo')],
  'cricket/*': [
    { title: 'MCC Laws of Cricket', url: 'https://www.lords.org/mcc/all-laws' },
    { title: 'ICC playing conditions (Test, ODI, T20I)', url: 'https://www.icc-cricket.com/about/cricket/rules-and-regulations/playing-conditions' },
  ],
  'tennis/*': [{ title: 'ITF Rules of Tennis 2026 (PDF)', url: 'https://www.itftennis.com/media/7221/2026-rules-of-tennis-english.pdf' }],
  'tennis/best-of-5': [{ title: 'Grand Slam Rulebook 2026 (PDF)', url: 'https://www.itftennis.com/media/5986/grand-slam-rulebook-2026-f.pdf' }],
  'badminton/*': [{ title: 'BWF Statutes — Section 4.1, Laws of Badminton', url: 'https://corporate.bwfbadminton.com/statutes/' }],
  'table-tennis/*': [{ title: 'ITTF Laws of Table Tennis 2026–27, as published by Table Tennis England (PDF)', url: 'https://www.tabletennisengland.co.uk/content/uploads/2026/07/Laws-of-Table-Tennis-2026-27.pdf' }],
  'pickleball/*': [{ title: 'USA Pickleball Official Rulebook', url: 'https://usapickleball.org/what-is-pickleball/official-rules/' }],
};

/** What the preset does not cover and an operator should know. */
const RULE_NOTES = {
  'basketball/nfhs': 'The shot clock is adopted state by state; leave the shot-clock layer off where your association does not use one.',
  'baseball/mlb': 'The preset is the 15 s bases-empty timer. With runners on it is 18 s, and 30 s between batters: set the timer to the one you need.',
  'soccer/youth': 'Youth half lengths are set by your league or state association; IFAB lets them be shortened. Change the game clock to match.',
  'soccer/futsal': 'Futsal stops the clock whenever the ball is out of play, so the game clock is run by hand.',
  'rugby-league/nrl': 'A field goal kicked from outside 40 m is worth 2 (the 2PT FG button).',
  'gaelic-football/*': 'A point scored from outside the 40 m arc is worth 2 (the 2 POINTS button).',
  'water-polo/world-aquatics': 'The shot clock is 28 s, and 18 s after a corner or a penalty that keeps possession. Some 2025 events trialled 25 s for men and 30 s for women.',
  'tennis/best-of-5': 'The deciding set at the Grand Slams is a first-to-10 tiebreak at 6–6.',
  'lacrosse/box': 'The NLL no longer publishes its rule book openly; the clock lengths have not changed since 2019–20.',
};

/**
 * A believable game row per sport for the examples — a game in progress, with
 * a line score that adds up to the score. Derived columns are filled by
 * `deriveGameRow`, the same function the Game block runs.
 */
const GAME_EXAMPLES = {
  basketball: { period: 3, homeScore: 72, awayScore: 68, possession: 'home', line: [[24, 22, 26], [20, 25, 23]], homeFouls: 4, awayFouls: 6, homeTimeouts: 3, awayTimeouts: 2, homeBonus: false, awayBonus: true, arrow: 'away' },
  'american-football': { period: 3, homeScore: 21, awayScore: 17, possession: 'home', line: [[7, 7, 7], [3, 14, 0]], down: 3, distance: 7, ballOn: 'OPP 34', redZone: false, flag: false, homeTimeouts: 2, awayTimeouts: 3 },
  baseball: { period: 7, half: 'bottom', homeScore: 4, awayScore: 3, line: [[0, 1, 0, 2, 0, 1], [1, 0, 0, 0, 2, 0, 0]], balls: 2, strikes: 1, outs: 1, onFirst: true, onSecond: false, onThird: true, homeHits: 8, awayHits: 6, homeErrors: 0, awayErrors: 1, pitcher: 'J. Ruiz', batter: 'M. Chen' },
  softball: { period: 5, half: 'top', homeScore: 2, awayScore: 3, line: [[1, 0, 1, 0], [0, 2, 0, 0, 1]], balls: 1, strikes: 2, outs: 2, onFirst: false, onSecond: true, onThird: false, homeHits: 5, awayHits: 6, homeErrors: 1, awayErrors: 0, pitcher: 'A. Ortiz', batter: 'K. Green' },
  volleyball: { period: 3, homeGames: 1, awayGames: 1, homePoints: 18, awayPoints: 15, line: [[25, 22, 18], [21, 25, 15]], homeTimeouts: 1, awayTimeouts: 2, serving: 'home' },
  soccer: { period: 2, homeScore: 2, awayScore: 1, addedTime: 4, homeYellow: 1, awayYellow: 2, homeRed: 0, awayRed: 0, homePens: 0, awayPens: 0, lastScorer: 'A. Silva' },
  'rugby-union': { period: 2, homeScore: 24, awayScore: 17, possession: 'home', homeTries: 3, awayTries: 2, homeYellow: 0, awayYellow: 1, homeRed: 0, awayRed: 0 },
  'rugby-league': { period: 2, homeScore: 18, awayScore: 12, possession: 'away', homeTries: 3, awayTries: 2, homeSinbin: 0, awaySinbin: 1, tackleCount: 3 },
  'aussie-rules': { period: 3, line: [[27, 30, 24], [20, 35, 16]], homeGoals: 12, homeBehinds: 9, awayGoals: 10, awayBehinds: 11 },
  'gaelic-football': { period: 2, homeGoals: 1, homePoints: 12, awayGoals: 0, awayPoints: 14, homeYellow: 1, awayYellow: 0, homeBlack: 0, awayBlack: 1, homeRed: 0, awayRed: 0 },
  hurling: { period: 2, homeGoals: 2, homePoints: 21, awayGoals: 1, awayPoints: 24, homeYellow: 0, awayYellow: 1, homeRed: 0, awayRed: 0 },
  'ice-hockey': { period: 3, homeScore: 3, awayScore: 2, line: [[1, 0, 2], [0, 2, 0]], homeShots: 28, awayShots: 25, homeSkaters: 5, awaySkaters: 4, powerPlay: 'home', emptyNet: false },
  'field-hockey': { period: 4, homeScore: 2, awayScore: 1, line: [[1, 0, 0, 1], [0, 1, 0, 0]], homeCorners: 5, awayCorners: 3, homeGreen: 1, awayGreen: 0, homeYellow: 0, awayYellow: 1, homeRed: 0, awayRed: 0 },
  lacrosse: { period: 4, homeScore: 11, awayScore: 9, possession: 'home', line: [[3, 2, 4, 2], [2, 3, 1, 3]], homeShots: 34, awayShots: 30, homeTimeouts: 1, awayTimeouts: 2, homePenalties: 2, awayPenalties: 3 },
  handball: { period: 2, homeScore: 28, awayScore: 26, possession: 'away', line: [[15, 13], [12, 14]], homeTimeouts: 2, awayTimeouts: 1, homeSuspended: 0, awaySuspended: 1 },
  'water-polo': { period: 4, homeScore: 9, awayScore: 8, possession: 'home', line: [[2, 3, 2, 2], [3, 1, 2, 2]], homeTimeouts: 1, awayTimeouts: 0, homeExclusions: 5, awayExclusions: 6 },
  cricket: { period: 2, batting: 'away', homeRuns: 168, homeWickets: 7, homeBalls: 120, homeExtras: 9, awayRuns: 98, awayWickets: 3, awayBalls: 75, awayExtras: 4, target: 169, striker: 'R. Patel', nonStriker: 'J. Brooks', bowler: 'K. Ahmed', thisOver: '1 4 0 W' },
  tennis: { period: 3, homeSets: 1, awaySets: 1, homeGames: 4, awayGames: 3, homePoints: 3, awayPoints: 2, line: [[6, 4, 4], [3, 6, 3]], serving: 'home', tiebreak: false },
  badminton: { period: 2, homeGames: 1, awayGames: 0, homePoints: 14, awayPoints: 11, line: [[21, 14], [17, 11]], serving: 'home' },
  'table-tennis': { period: 3, homeGames: 2, awayGames: 0, homePoints: 7, awayPoints: 5, line: [[11, 11, 7], [8, 9, 5]], serving: 'away' },
  pickleball: { period: 2, homeGames: 1, awayGames: 0, homePoints: 4, awayPoints: 2, line: [[11, 4], [7, 2]], serving: 'home', serverNumber: 1 },
};

const sourcesFor = (sport, rs) => [...(RULE_SOURCES[`${sport}/*`] ?? []), ...(RULE_SOURCES[`${sport}/${rs}`] ?? [])];

/* ---------------------------------------------------------------- wording */

const PLURAL = { quarter: 'quarters', half: 'halves', period: 'periods', inning: 'innings', set: 'sets', game: 'games', innings: 'innings' };
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const code = (v) => '`' + v + '`';
const cell = (v) => String(v).replace(/\|/g, '\\|');

function timerText(spec) {
  const name = t(spec.labelKey);
  const tm = spec.timer;
  if (tm.mode === 'countdown') return `${name}: ${tm.duration < 60 ? `${tm.duration} s` : clock(tm.duration)} down`;
  if (tm.mode === 'countup') return `${name}: up to ${clock(tm.limit)}`;
  return name;
}

function scoringText(sport, r) {
  switch (sport.scoring) {
    case 'rally': {
      const unit = PLURAL[r.periodName];
      const parts = [`${unit[0].toUpperCase()}${unit.slice(1)} to ${r.pointsToWin}, win by ${r.winBy}`];
      if (r.cap) parts.push(`capped at ${r.cap}`);
      if (r.decidingPointsToWin && r.decidingPointsToWin !== r.pointsToWin) parts.push(`deciding ${r.periodName} to ${r.decidingPointsToWin}`);
      parts.push(`first to ${r.toWin} ${PLURAL[r.periodName]}`);
      return parts.join(', ');
    }
    case 'sideout':
      return `Side-out scoring: only the serving side scores. Games to ${r.pointsToWin}, win by ${r.winBy}, first to ${r.toWin}${r.doubles ? '; two servers a side' : ''}`;
    case 'tennis':
      return `${r.gamesPerSet}-game sets, tiebreak to ${r.tiebreakPoints} at ${r.gamesPerSet}–${r.gamesPerSet}${r.decidingTiebreakPoints !== r.tiebreakPoints ? `, to ${r.decidingTiebreakPoints} in the deciding set` : ''}; first to ${r.toWin} sets`;
    case 'cricket':
      return r.overs ? `${r.overs} overs an innings` : 'Unlimited overs';
    default:
      return '';
  }
}

/** Columns the Game block works out from others. A feed sends them itself. */
function derivedNote(sport, key) {
  const k = key.replace(/^(home|away)/, '');
  if (key === 'periodLabel') return 'Written by the period arrows; type your own to override.';
  if (sport.id === 'aussie-rules' && k === 'Score') return 'Worked out: goals × 6 + behinds.';
  if (sport.id === 'aussie-rules' && k === 'Display') return 'Worked out: goals.behinds.total.';
  if ((sport.id === 'gaelic-football' || sport.id === 'hurling') && k === 'Score') return 'Worked out: goals × 3 + points.';
  if ((sport.id === 'gaelic-football' || sport.id === 'hurling') && k === 'Display') return 'Worked out: goals-points.';
  if (sport.scoring === 'cricket' && k === 'Overs') return 'Worked out from balls.';
  if (sport.scoring === 'cricket' && k === 'Score') return 'Worked out: runs.';
  if (sport.scoring === 'cricket' && (key === 'runRate' || key === 'requiredRate')) return 'Worked out.';
  if (sport.scoring === 'tennis' && k === 'Score') return 'Worked out: sets won.';
  if (sport.scoring === 'tennis' && k === 'PointText') return 'Worked out: 0, 15, 30, 40 or AD.';
  if ((sport.scoring === 'rally' || sport.scoring === 'sideout') && k === 'Score') return `Worked out: ${PLURAL[sport.rulesets[0].periodName]} won.`;
  if (sport.scoring === 'sideout' && key === 'call') return 'Worked out: the score call, server first.';
  return '';
}

const LINE = /^(home|away)(\d+|OT|X)$/;
const LINE_UNIT = { baseball: 'runs', softball: 'runs', 'ice-hockey': 'goals', 'field-hockey': 'goals', lacrosse: 'goals', handball: 'goals', 'water-polo': 'goals' };

function exampleOf(c, game = false) {
  if (c.example !== undefined) return c.example;
  if (c.values?.length) return c.values[0];
  if (!game) return '';
  return c.type === 'number' ? 0 : c.type === 'boolean' ? false : '';
}

function shownExample(c) {
  if (c.values?.length) return c.values.map((v) => (v === '' ? '(blank)' : code(v))).join(', ');
  if (c.example !== undefined && c.example !== '') return code(c.example);
  return '';
}

/** A format table; a line score collapses to one row per side. */
function columnTable(sport, cols, { derived = false } = {}) {
  const out = ['| Column | Type | Required | Example or allowed values | Meaning |', '|---|---|---|---|---|'];
  const line = cols.filter((c) => LINE.test(c.key));
  let lineDone = false;
  for (const c of cols) {
    if (LINE.test(c.key)) {
      if (lineDone) continue;
      lineDone = true;
      for (const side of ['home', 'away']) {
        const keys = line.filter((l) => l.key.startsWith(side)).map((l) => code(l.key));
        const per = sport.scoring === 'tennis' ? 'games in each set' : `${LINE_UNIT[sport.id] ?? 'points'} in each ${sport.rulesets[0].periodName}`;
        out.push(`| ${keys.join(', ')} | number | | | ${side === 'home' ? 'Home' : 'Away'} ${per} — the line score |`);
      }
      continue;
    }
    const note = derived ? derivedNote(sport, c.key) : '';
    const meaning = [c.label, note].filter(Boolean).join('. ');
    out.push(`| ${code(c.key)} | ${c.type} | ${c.required ? 'yes' : ''} | ${cell(shownExample(c))} | ${cell(meaning)} |`);
  }
  return out.join('\n');
}

/** A game row for the example: the sport's own values, a line score that adds up, derived columns worked out. */
function exampleGameRow(sport, r, cols) {
  const ex = GAME_EXAMPLES[sport.id] ?? {};
  const row = {};
  for (const c of cols) row[c.key] = LINE.test(c.key) ? '' : exampleOf(c, true);
  for (const [k, v] of Object.entries(ex)) if (k !== 'line') row[k] = v;
  if (ex.line) {
    ['home', 'away'].forEach((side, i) => ex.line[i].forEach((v, p) => { if (`${side}${p + 1}` in row) row[`${side}${p + 1}`] = v; }));
  }
  if (!('status' in ex)) row.status = 'live';
  if (!('possession' in ex) && 'possession' in row) row.possession = '';
  return deriveGameRow(sport, r, row, { label: true });
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (cols, rows) => [cols.map((c) => csvCell(c.key)).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c.key])).join(','))].join('\n');

/* ---------------------------------------------------------------- the doc */

const lines = [];
const out = (...l) => lines.push(...l);
const anchor = (s) => s.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').trim().replace(/ /g, '-');
const sportName = (s) => t(s.labelKey);

out(
  '# Sport templates — table formats and rules',
  '',
  '<!-- Generated by scripts/sport-guide.mjs from the sport catalogue. Edit the script, not this file. -->',
  '',
  'A reference for **Add → From a sport template…** in the data panel ([User Guide §12, Sport templates](USER-GUIDE.md#sport-templates)). It lists every sport, the rule sets it offers, the clocks and scoring each rule set brings, and the columns of each table, with examples — what a Google Sheet or a JSON feed needs to carry to drive the same graphics.',
  '',
  'Every rule set links to the governing body\'s own rules, which is where its period lengths, clocks and scoring come from. Rules change between seasons: if your competition plays to different numbers, change the clock on the layer and the period count in the game row — nothing in Breeze is locked to the preset.',
  '',
  '**How to read the tables.** *Type* is what the column holds: `number`, `string` or `boolean` (`true` / `false`). A *required* column must be present for the source check to pass; the others can be left out or left blank. A closed list (`home`, `away`) means any other value is flagged. Columns the template does not know are fine — they are kept and can be bound like any other.',
  '',
  '**Where the rows come from.** Typed into Breeze (five manual tables), one Google Sheet with a tab per table named `teams`, `players`, `coaches`, `venue` and `game`, or a CSV or JSON URL per table. A JSON feed returns an array of row objects — `[{ "side": "home", "name": "Phoenix", … }]` — with column names as keys.',
  '',
  '**Columns the Game block works out.** Some game columns are calculated from others when the operator scores from the control panel: an AFL `12.9.81`, a GAA `1-12`, cricket overs and run rates, a tennis `40` or `AD`. They are marked *Worked out* below. A feed that drives the game row itself sends them too, already worked out.',
  '',
  '## Contents',
  '',
  '- [Tables every sport shares](#tables-every-sport-shares)',
);
for (const s of SPORT_TEMPLATES) out(`- [${sportName(s)}](#${anchor(sportName(s))})`);
out('');

/* Shared tables, shown once, with the first team sport's examples. */
const teamSport = SPORT_TEMPLATES.find((s) => !s.individual);
const racket = SPORT_TEMPLATES.find((s) => s.individual);
out('## Tables every sport shares', '');
out(
  'Teams, players, coaches and venue have the same columns in every sport, plus a few statistics of the sport\'s own, listed under each sport below. Racket sports (tennis, badminton, table tennis, pickleball) treat a "team" as a player or a pair, so their teams table has `country` and `seed` instead of `record`, `rank` and `coach`, and `abbr` is optional.',
  '',
);
for (const table of ['teams', 'players', 'coaches', 'venue']) {
  const cols = sportTableColumns(teamSport, teamSport.rulesets[0], table);
  const base = table === 'teams' ? cols.filter((c) => !teamSport.teamStats.includes(c)) : table === 'players' ? cols.filter((c) => !teamSport.playerStats.includes(c)) : cols;
  out(`### ${t(`schema.sport.table.${table}`)}`, '');
  if (table === 'teams') out('One row per side.', '');
  if (table === 'players') out('One row per player. `team` matches the team\'s `abbr` (racket sports: `home` or `away`).', '');
  if (table === 'coaches') out('One row per coach. `team` matches the team\'s `abbr`.', '');
  if (table === 'venue') out('One row.', '');
  out(columnTable(teamSport, base), '');
  out('Example:', '', '```csv', csv(base, [Object.fromEntries(base.map((c) => [c.key, exampleOf(c)]))]), '```', '');
}
{
  const cols = sportTableColumns(racket, racket.rulesets[0], 'teams').filter((c) => !racket.teamStats.includes(c));
  out('Racket sports\' teams table:', '', '```csv', csv(cols, [Object.fromEntries(cols.map((c) => [c.key, exampleOf(c)]))]), '```', '');
}
out(
  '### Game',
  '',
  'One row: the live state of the game. Every sport\'s game table starts with these columns; the sport adds its own after them (listed under each sport).',
  '',
);
{
  const r = teamSport.rulesets[0];
  const cols = sportTableColumns(teamSport, r, 'game').filter((c) => !teamSport.gameColumns.includes(c));
  out(columnTable(teamSport, cols, { derived: true }), '');
  out(
    'The line score has one column per period of the rule set — `home1`…`home4` for four quarters — plus `homeOT` for overtime, or `homeX` for extra innings. The racket sports keep a line score per set or game; soccer, both rugby codes, Gaelic games and cricket have none.',
    '',
    '`periodLabel` is how a broadcast writes the period: `3rd`, `OT`, `2OT`, `SO`, `2nd Half`, `Top 7th`, `Set 3`, `Game 2`, `2nd innings`.',
    '',
  );
}

/* One section per sport. */
for (const s of SPORT_TEMPLATES) {
  out('---', '', `## ${sportName(s)}`, '');
  out(`*${t(`schema.sport.group.${s.group}`)}* · source ids start \`${s.prefix}-\` (\`${s.prefix}-teams\`, \`${s.prefix}-game\`…)`, '');

  out('### Rule sets', '');
  const withScoring = s.rulesets.some((r) => scoringText(s, r));
  out(`| Rule set | Periods | Clocks offered |${withScoring ? ' Scoring |' : ''} Rules |`, `|---|---|---|${withScoring ? '---|' : ''}---|`);
  for (const r of s.rulesets) {
    const src = sourcesFor(s.id, r.id).map((x) => `[${cell(x.title)}](${x.url})`).join('<br>');
    const timers = r.timers.map(timerText).join('<br>') || '— (none offered)';
    out(`| ${cell(t(r.labelKey))} | ${r.periods} ${PLURAL[r.periodName]} | ${cell(timers)} |${withScoring ? ` ${cell(scoringText(s, r))} |` : ''} ${src} |`);
  }
  out('');
  const general = RULE_NOTES[`${s.id}/*`];
  const notes = s.rulesets.map((r) => [r, RULE_NOTES[`${s.id}/${r.id}`]]).filter(([, n]) => n);
  if (general) out(`- ${general}`);
  for (const [r, n] of notes) out(`- **${cell(t(r.labelKey)).split(' — ')[0]}:** ${n}`);
  if (general || notes.length) out('');

  out('### Scoring', '');
  if (s.actions.length) {
    const kinds = s.actions.map((a) => {
      const adds = Object.entries(a.adds);
      const what = s.scoring === 'cricket'
        ? [adds.find(([k]) => k === 'Runs') ? `${adds.find(([k]) => k === 'Runs')[1]} run${adds.find(([k]) => k === 'Runs')[1] === 1 ? '' : 's'}` : null, a.adds.Wickets ? 'a wicket' : null, a.adds.Extras ? 'an extra' : null, a.ball ? 'a ball' : 'no ball'].filter(Boolean).join(', ')
        : `+${a.adds.Score ?? 0}`;
      return a.label === what ? `**${a.label}**` : `**${a.label}** (${what})`;
    });
    const undo = s.scoring === 'points' ? ` **−** takes one **${s.actions[0].label}** back.` : '';
    out(`Game block buttons, one set per side: ${kinds.join(' · ')}.${undo}`, '');
  } else if (s.scoring === 'tennis') {
    out('A **Point** button per side. Points run 0, 15, 30, 40, deuce and advantage; games, sets and tiebreaks follow the rule set.', '');
  } else if (s.scoring === 'sideout') {
    out('A **Point** button per side. Only the serving side scores; a rally lost by the server passes the serve (to the second server first, in doubles).', '');
  } else {
    out('A **Point** button per side. Every rally scores; games and the match follow the rule set.', '');
  }

  const tStats = s.teamStats;
  const pStats = s.playerStats;
  out('### Teams and players', '');
  if (tStats.length) out(`Statistics added to the [teams table](#teams): ${tStats.map((c) => `${code(c.key)} (${c.type})`).join(', ')}.`, '');
  if (pStats.length) out(`Statistics added to the [players table](#players): ${pStats.map((c) => `${code(c.key)} (${c.type})`).join(', ')}.`, '');

  const r0 = s.rulesets[0];
  const gcols = sportTableColumns(s, r0, 'game');
  const own = gcols.filter((c) => LINE.test(c.key) || s.gameColumns.includes(c));
  const derivedShared = ['homeScore', 'awayScore'].map((k) => derivedNote(s, k)).find(Boolean);
  out('### Game table', '');
  out(`The [shared game columns](#game) (\`status\`, \`period\`, \`periodLabel\`, \`homeScore\`, \`awayScore\`, \`possession\`)${s.lineScore ? ', a line score,' : ''} and the sport's own:`, '');
  if (derivedShared) out(`\`homeScore\` and \`awayScore\`: ${derivedShared}`, '');
  out(columnTable(s, own, { derived: true }), '');
  if (s.lineScore && s.rulesets.length > 1 && new Set(s.rulesets.map((r) => r.periods)).size > 1) {
    out(`The line score shown is for **${cell(t(r0.labelKey)).split(' — ')[0]}**; it has one column per period of the rule set you pick.`, '');
  }
  out(`Example — a game in progress (${cell(t(r0.labelKey)).split(' — ')[0]}):`, '', '```csv', csv(gcols, [exampleGameRow(s, r0, gcols)]), '```', '');
}

const doc = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== doc) {
    console.error('docs/SPORT-TEMPLATES.md is out of date — run `node scripts/sport-guide.mjs`.');
    process.exit(1);
  }
  console.log('docs/SPORT-TEMPLATES.md is up to date.');
} else {
  fs.writeFileSync(OUT, doc);
  console.log(`Wrote ${path.relative(root, OUT)} (${lines.length} lines).`);
}
