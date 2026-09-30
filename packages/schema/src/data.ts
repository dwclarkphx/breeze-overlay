// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Breeze Overlay — Phase 6 data model.
 *
 * One rule: **one canonical data shape, many adapters.** Every
 * source — a pasted table, an HTTP feed, later a scoreboard serial port —
 * normalizes into a `DataSet` before anything downstream sees it. Layers bind to
 * `DataSet` columns and never learn where the rows came from.
 *
 * This module lives in `@breeze/schema` rather than the server because all three
 * consumers need it and none may disagree about it:
 *  - the server normalizes into it and caches it,
 *  - the runtime renders it,
 *  - the editor previews it.
 *
 * It is deliberately free of I/O. Fetching, polling and parsing are the server's
 * job; the shape and the transform pipeline are the contract, and a contract
 * that imports `node:http` cannot go in a browser bundle.
 */

/* ------------------------------------------------------------------ DataSet */

import type { MediaCheck, MediaSummary } from './media.js';
import { parseTemplate, renderTemplate, templateUsesClock } from './compose.js';
import { addDays, localParts, readTime } from './time.js';

export const COLUMN_TYPES = ['string', 'number', 'boolean', 'date'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export interface DataColumn {
  /** Machine key — what a table cell binds to. */
  key: string;
  /** Human label, for headers and the editor. Defaults to `key`. */
  label?: string;
  type: ColumnType;
}

export type DataValue = string | number | boolean | null;
export type DataRow = Record<string, DataValue>;

export interface DataSet {
  id: string;
  columns: DataColumn[];
  rows: DataRow[];
  /** ISO timestamp of the fetch that produced these rows. */
  fetchedAt?: string;
  /**
   * Bumped only when the content hash changes — not on every poll. A graphic on
   * air re-renders on a revision change, so a feed that is polled every five
   * seconds and never changes must not re-render every five seconds.
   */
  revision?: number;
}

/**
 * Scalar sources — weather, a scoreboard clock — are a one-row DataSet rather
 * than a second shape. One shape means one transform pipeline, one binding kind
 * and one preview UI.
 */
export function scalarDataSet(id: string, values: Record<string, DataValue>): DataSet {
  return {
    id,
    columns: Object.entries(values).map(([key, v]) => ({ key, type: inferType(v) })),
    rows: [values],
  };
}

export function emptyDataSet(id: string): DataSet {
  return { id, columns: [], rows: [] };
}

function inferType(v: DataValue): ColumnType {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'string';
}

/**
 * Best-effort column list for rows that arrived without one (a JSON feed, a
 * pasted block). Keys are collected in first-seen order across *all* rows, not
 * just the first: a feed whose first entry omits an optional field would
 * otherwise drop that column for every row behind it.
 */
export function inferColumns(rows: DataRow[]): DataColumn[] {
  const seen = new Map<string, ColumnType>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      const type = inferType(value);
      const prior = seen.get(key);
      if (prior === undefined) seen.set(key, type);
      // A column that is a number in one row and text in another is text.
      else if (prior !== type && value !== null) seen.set(key, 'string');
    }
  }
  return [...seen].map(([key, type]) => ({ key, type }));
}

/** Coerce a raw cell to the column's declared type. Parse failures stay as text. */
export function coerce(value: unknown, type: ColumnType): DataValue {
  if (value === null || value === undefined) return null;
  if (type === 'number') {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    // Thousands separators and a stray currency symbol are normal in pasted
    // spreadsheet data and must not turn a whole column into text.
    const n = Number(String(value).replace(/[,\s$£€]/g, ''));
    return Number.isFinite(n) ? n : String(value);
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === '0') return false;
    return String(value);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Apply a column list to loosely-typed rows, dropping keys no column declares. */
export function conform(rows: DataRow[], columns: DataColumn[]): DataRow[] {
  return rows.map((row) => {
    const out: DataRow = {};
    for (const col of columns) out[col.key] = coerce(row[col.key], col.type);
    return out;
  });
}

/* --------------------------------------------------------------- transforms */

export const FILTER_OPS = [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
  'contains', 'startsWith', 'endsWith',
  'empty', 'notEmpty',
] as const;

export type FilterOp = (typeof FILTER_OPS)[number];

/**
 * Resolve a knockout bracket: read each match's winner and write it into the
 * slot it advances to.
 *
 * This is a transform and not a layer feature on purpose. Advancement is a pure
 * function over rows — no DOM, no GSAP, no measurement — so it belongs in the
 * same pipeline as sort and rank, where it can be tested without a browser and
 * where the *consumer* decides whether to apply it. Drawing a bracket needs
 * nothing new: ten row-tables and a spreadsheet already do it (see
 * `examples/world-cup-bracket.json`). Resolving one is the part no motion
 * graphics editor gives you.
 *
 * The operator types teams into the first round and scores as matches finish.
 * Everything downstream fills itself.
 */
export interface AdvanceTransform {
  op: 'advance';
  /** Column holding each row's slot id. Default `slot`. */
  slot?: string;
  /**
   * Column grouping rows into rounds. Default `round`.
   *
   * Rounds run in order of first appearance, which makes the pipeline's
   * order-sensitivity work *for* the author: sort the rows the way the bracket
   * reads and the rounds are already right.
   */
  round?: string;
  /**
   * Per-row routing override for the winner, `"<slot>:home"` or `"<slot>:away"`.
   * Default column `feeds`.
   *
   * Absent or empty falls back to the implied topology — position `p` of one
   * round feeds position `floor(p / 2)` of the next, on the `home` line when
   * `p` is even. That covers an ordinary single-elimination bracket with no
   * routing columns at all; the override exists for the cases it cannot
   * express, which are real: FIFA's third-placed-team lottery, any reseeding,
   * and a left/right split like the demo's.
   */
  feeds?: string;
  /**
   * Per-row routing for the *loser*. Default column `feedsLoser`.
   *
   * There is no implied form — a losers' route is not derivable from position —
   * so this is how a third-place play-off gets filled and the only way a loser
   * ever moves.
   */
  feedsLoser?: string;
  /**
   * Column naming the winning side. Default `winner`.
   *
   * Accepts either the literal `home`/`away`, or the winning side's value in
   * the first `fields` column — because "Spain" is what an operator actually
   * types into a column called Winner, and refusing it would push everyone
   * onto the score path for a match that has already been decided.
   */
  winner?: string;
  /**
   * Fallback when `winner` is empty: compare these score columns.
   *
   * Convenience, not the primary path. A drawn match is not a decided match,
   * and extra time and shoot-outs mean a score comparison alone is wrong often
   * enough that the explicit column stays in charge.
   */
  scores?: {
    home: string;
    away: string;
    /** Shoot-out columns, consulted first and only when they disagree. */
    shootout?: { home: string; away: string };
  };
  /**
   * Side-prefixed column suffixes carried forward. Default `['Team']` — that
   * is, `homeTeam` and `awayTeam`.
   *
   * Listing more carries them together: `['Team', 'Code', 'Flag']` moves a
   * team's name, its three-letter code and its badge in one step, which is
   * what stops a bracket graphic needing a second lookup table.
   */
  fields?: string[];
}

/**
 * Wide rows to long ones (CYCLE.md, Wave 4).
 *
 * A sheet laid out for people — `City | Mon | Tue | Wed` — becomes one row per
 * city and day: `City | key | value`. That is the shape a table, a follower or
 * a Cycle wants, and the one a person typing into a spreadsheet never makes.
 */
export interface UnpivotTransform {
  op: 'unpivot';
  /** Columns to fold into rows. Absent: every column not in `keep`. */
  columns?: string[];
  /** Columns carried onto every folded row unchanged. Absent: every column not in `columns`. */
  keep?: string[];
  /** Column naming which folded column a row came from. Default `key`; holds that column's label. */
  key?: string;
  /** Column holding the folded value. Default `value`. */
  value?: string;
}

/**
 * Keep the rows whose date or time falls in a window of the clock (Wave 7):
 * today, tomorrow, this week, still to come — in a named zone, so a graphics
 * machine in UTC agrees with the station about what "today" is.
 */
export interface DateTransform {
  op: 'date';
  /** The column holding the date or time. See `readTime` for what it reads. */
  column: string;
  /**
   * `days` — rows on the calendar days `from` … `from + days - 1` (0 today, 1
   * tomorrow, -1 yesterday). `upcoming` — rows not yet past: a time at or after
   * now, a date today or later. `past` — the rest.
   */
  keep: DateKeep;
  from?: number;
  days?: number;
  /** IANA zone. Absent: the zone of the machine showing the graphic. */
  timezone?: string;
}

export const DATE_KEEPS = ['days', 'upcoming', 'past'] as const;
export type DateKeep = (typeof DATE_KEEPS)[number];

/**
 * Bring columns across from another source by a matching key (Wave 7) — the
 * city's display name, region and background from a Cities table, onto each
 * forecast row. Keys match trimmed and case-insensitively; the first match
 * wins. A matched row takes the other source's values, empty ones included;
 * a row with no match keeps a column it already had and gets null for the rest.
 */
export interface LookupTransform {
  op: 'lookup';
  source: string;
  /** Column in these rows. */
  key: string;
  /** Column in the other source to match it with. Default: the same name. */
  on?: string;
  /** Columns to bring. Default: every column of the other source but `on`. */
  columns?: string[];
}

/**
 * Append another source's rows (Wave 7) — a feed's alerts and the station's
 * own typed announcements in one crawl. Columns are the union of both; a value
 * one side does not have is empty.
 */
export interface UnionTransform {
  op: 'union';
  source: string;
}

export type DataTransform =
  | { op: 'sort'; key: string; dir?: 'asc' | 'desc' }
  | { op: 'filter'; key: string; cmp: FilterOp; value?: DataValue }
  | { op: 'limit'; n: number }
  | { op: 'offset'; n: number }
  | { op: 'rank'; as?: string }
  | AdvanceTransform
  | UnpivotTransform
  | DateTransform
  | LookupTransform
  | UnionTransform
  | ComposeTransform;

/**
 * What a transform may read besides its own rows: the clock, for `date`, and
 * other sources, for `lookup` and `union`. Both optional — without a clock it
 * is now; without sources a lookup finds nothing and a union adds nothing.
 */
/**
 * Build a text column from a template that reads other columns.
 *
 * One row in, one row out, with `as` added: `The NWS has issued a {event} for
 * the following {areaKind}: {areas|list}; from {onset|when} until {ends|when}`
 * becomes a single sentence per alert that a ticker or a text cell can show.
 * The template language, and what each modifier does, is in `compose.ts`.
 */
export interface ComposeTransform {
  op: 'compose';
  /** The column written. An existing column of that name is replaced. */
  as: string;
  /** Text with `{column}` and `{column|modifier}` fields. */
  template: string;
  /** IANA zone for `when` and `time:` fields. Absent: the zone of the machine showing the graphic. */
  timezone?: string;
}

export interface TransformContext {
  now?: Date;
  source?: (id: string) => DataSet | undefined;
}

/** Whether a pipeline depends on the clock — a graphic showing it must re-run it as time passes. */
export function transformsUseClock(transforms: readonly DataTransform[] | undefined): boolean {
  return (transforms ?? []).some((t) => t.op === 'date' || (t.op === 'compose' && templateUsesClock(t.template)));
}

/** The other sources a pipeline reads — it must re-run when any of them changes. */
export function transformSources(transforms: readonly DataTransform[] | undefined): string[] {
  const out = new Set<string>();
  for (const t of transforms ?? []) if (t.op === 'lookup' || t.op === 'union') out.add(t.source);
  return [...out];
}

/** Column `rank` writes into when no `as` is given. */
export const DEFAULT_RANK_KEY = 'rank';

/** Defaults for `unpivot`. */
export const UNPIVOT_DEFAULTS = { key: 'key', value: 'value' } as const;

/**
 * Fold columns into rows.
 *
 * Exported apart from `applyTransforms` so the editor can preview the column
 * list it produces. Rows are emitted row-major — every folded column of the
 * first row, then the second — so "one city's week" stays together and a table
 * paging five rows at a time shows one city per page.
 *
 * The value column's type is the folded columns' common type, or text when
 * they disagree: `Mon` numeric and `Tue` holding "n/a" is a text column, not a
 * number column with a hole in it.
 */
export function unpivot(data: DataSet, t: UnpivotTransform): DataSet {
  const keyName = t.key ?? UNPIVOT_DEFAULTS.key;
  const valueName = t.value ?? UNPIVOT_DEFAULTS.value;
  const keep = new Set(t.keep ?? []);
  const folded = t.columns
    ? data.columns.filter((c) => t.columns!.includes(c.key))
    : data.columns.filter((c) => !keep.has(c.key));
  const foldedKeys = new Set(folded.map((c) => c.key));
  const carried = data.columns.filter(
    (c) => !foldedKeys.has(c.key) && (t.keep === undefined || keep.has(c.key)) && c.key !== keyName && c.key !== valueName,
  );

  const types = new Set(folded.map((c) => c.type));
  const valueType: ColumnType = types.size === 1 ? [...types][0]! : 'string';

  const rows: DataRow[] = [];
  for (const row of data.rows) {
    for (const col of folded) {
      const out: DataRow = {};
      for (const c of carried) out[c.key] = row[c.key] ?? null;
      out[keyName] = col.label ?? col.key;
      out[valueName] = row[col.key] ?? null;
      rows.push(out);
    }
  }

  return {
    ...data,
    columns: [...carried, { key: keyName, type: 'string' }, { key: valueName, type: valueType }],
    rows,
  };
}

/** A row test for `date`, bound to one moment so every row is judged by the same clock. */
function dateKeeper(t: DateTransform, now: Date): (row: DataRow) => boolean {
  const today = localParts(t.timezone, now).date;
  const nowMs = now.getTime();
  if (t.keep === 'days') {
    const first = addDays(today, Math.trunc(t.from ?? 0));
    const last = addDays(first, Math.max(1, Math.trunc(t.days ?? 1)) - 1);
    return (row) => {
      const at = readTime(row[t.column], t.timezone);
      return at !== null && at.date >= first && at.date <= last;
    };
  }
  const upcoming = t.keep === 'upcoming';
  return (row) => {
    const at = readTime(row[t.column], t.timezone);
    if (at === null) return false;
    // A date alone is upcoming for the whole of its day; a time until it passes.
    const ahead = at.ms === undefined ? at.date >= today : at.ms >= nowMs;
    return upcoming ? ahead : !ahead;
  };
}

const lookupKey = (v: DataValue | undefined): string => String(v ?? '').trim().toLowerCase();

/** `lookup`, apart from the pipeline so it is testable on its own. */
export function lookup(data: DataSet, t: LookupTransform, other: DataSet | undefined): DataSet {
  const on = t.on ?? t.key;
  const wanted = t.columns ?? (other?.columns.map((c) => c.key).filter((k) => k !== on) ?? []);
  const known = new Map(data.columns.map((c) => [c.key, c] as const));
  const added: DataColumn[] = wanted
    .filter((k) => !known.has(k))
    .map((k) => other?.columns.find((c) => c.key === k) ?? { key: k, type: 'string' as const });

  const index = new Map<string, DataRow>();
  for (const row of other?.rows ?? []) {
    const key = lookupKey(row[on]);
    if (key && !index.has(key)) index.set(key, row);
  }
  const rows = data.rows.map((row) => {
    const match = index.get(lookupKey(row[t.key]));
    const out: DataRow = { ...row };
    for (const k of wanted) out[k] = match?.[k] ?? (known.has(k) && !match ? row[k] ?? null : null);
    return out;
  });
  return { ...data, columns: [...data.columns, ...added], rows };
}

/** Defaults for `advance`, exported so the editor's picker can seed a new one. */
export const ADVANCE_DEFAULTS = {
  slot: 'slot',
  round: 'round',
  feeds: 'feeds',
  feedsLoser: 'feedsLoser',
  winner: 'winner',
  fields: ['Team'],
} as const;

export const BRACKET_SIDES = ['home', 'away'] as const;
export type BracketSide = (typeof BRACKET_SIDES)[number];

function compareValues(a: DataValue, b: DataValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return Number(a) - Number(b);
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Sort comparator. Nulls are settled here rather than inside `compareValues`,
 * *outside* the direction multiplier.
 *
 * Deciding them in the comparison meant "null is large", which reverses along
 * with everything else — so descending put every team with no result yet at the
 * top of the table. An absent value is not a large value; it is absent, and it
 * belongs at the bottom either way.
 *
 * `compareValues` keeps its null-free contract because the filter operators use
 * it too, where a null genuinely is just a value to compare.
 */
function sortCompare(a: DataValue, b: DataValue, dir: 1 | -1): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  return compareValues(a, b) * dir;
}

/** The table filter's comparison — shared with layer rules (`rules.ts`). */
export function matchesFilter(value: DataValue, cmp: FilterOp, against: DataValue | undefined): boolean {
  return matches(value, cmp, against);
}

function matches(value: DataValue, cmp: FilterOp, against: DataValue | undefined): boolean {
  /*
   * An absent value is not greater or less than anything. Compared as text it
   * was: "null" sorts after "100", so `gt 100` kept every row with no value
   * and a rule on a field nobody had set yet fired at load.
   */
  if ((value === null || value === '') && (cmp === 'gt' || cmp === 'gte' || cmp === 'lt' || cmp === 'lte')) return false;
  switch (cmp) {
    case 'empty': return value === null || value === '';
    case 'notEmpty': return value !== null && value !== '';
    case 'eq': return String(value) === String(against ?? '');
    case 'ne': return String(value) !== String(against ?? '');
    case 'gt': return compareValues(value, against ?? null) > 0;
    case 'gte': return compareValues(value, against ?? null) >= 0;
    case 'lt': return compareValues(value, against ?? null) < 0;
    case 'lte': return compareValues(value, against ?? null) <= 0;
    case 'contains': return String(value).toLowerCase().includes(String(against ?? '').toLowerCase());
    case 'startsWith': return String(value).toLowerCase().startsWith(String(against ?? '').toLowerCase());
    case 'endsWith': return String(value).toLowerCase().endsWith(String(against ?? '').toLowerCase());
    default: {
      const exhaustive: never = cmp;
      throw new Error(`unknown filter op ${String(exhaustive)}`);
    }
  }
}

/* ----------------------------------------------------------------- advance */

const isBlank = (v: DataValue | undefined): boolean =>
  v === null || v === undefined || String(v).trim() === '';

/** `"QFL-1:home"` → `['QFL-1', 'home']`. Anything malformed resolves to null. */
function parseRoute(value: DataValue | undefined): [string, BracketSide] | null {
  if (isBlank(value)) return null;
  const [slot, side] = String(value).split(':');
  if (!slot || (side !== 'home' && side !== 'away')) return null;
  return [slot, side];
}

/**
 * Which side won, or null if the match has not been decided.
 *
 * Null is a first-class answer here. Half a bracket is unplayed for most of a
 * tournament, and an unresolved slot must render blank rather than guess — the
 * sort comparator already puts nulls at the bottom in both directions for the
 * same reason.
 */
function winningSide(row: DataRow, t: AdvanceTransform, firstField: string): BracketSide | null {
  const declared = row[t.winner ?? ADVANCE_DEFAULTS.winner];
  if (!isBlank(declared)) {
    const s = String(declared).trim();
    const lower = s.toLowerCase();
    if (lower === 'home' || lower === 'away') return lower;
    for (const side of BRACKET_SIDES) {
      const name = row[`${side}${firstField}`];
      if (!isBlank(name) && String(name).trim() === s) return side;
    }
    // A winner was named and it matches neither side. Refusing to guess is the
    // only safe answer: advancing the wrong team is worse than advancing none.
    return null;
  }

  if (!t.scores) return null;
  const { shootout } = t.scores;
  if (shootout) {
    const h = row[shootout.home];
    const a = row[shootout.away];
    if (!isBlank(h) && !isBlank(a) && Number(h) !== Number(a)) {
      return Number(h) > Number(a) ? 'home' : 'away';
    }
  }
  const h = row[t.scores.home];
  const a = row[t.scores.away];
  if (isBlank(h) || isBlank(a)) return null;
  // A draw is not a result. Without a shoot-out column there is nothing left to
  // separate them, so the slot stays open.
  if (Number(h) === Number(a)) return null;
  return Number(h) > Number(a) ? 'home' : 'away';
}

/**
 * Walk the bracket forward, filling each slot from the round before it.
 *
 * One pass, rounds in order, so a round is always complete before anything
 * reads it. Writes that would land in the current round or an earlier one are
 * dropped rather than applied — a routing column can point backwards and a
 * graphic on air must not loop over bad data.
 */
function advance(rows: DataRow[], t: AdvanceTransform): DataRow[] {
  const slotKey = t.slot ?? ADVANCE_DEFAULTS.slot;
  const roundKey = t.round ?? ADVANCE_DEFAULTS.round;
  const feedsKey = t.feeds ?? ADVANCE_DEFAULTS.feeds;
  const feedsLoserKey = t.feedsLoser ?? ADVANCE_DEFAULTS.feedsLoser;
  const fields = t.fields?.length ? t.fields : [...ADVANCE_DEFAULTS.fields];
  const firstField = fields[0]!;

  const out = rows.map((r) => ({ ...r }));

  // Slot index. First definition wins; a duplicated slot id is an authoring
  // mistake the validator reports, not something to resolve here by guessing.
  const bySlot = new Map<string, number>();
  out.forEach((row, i) => {
    const id = row[slotKey];
    if (!isBlank(id) && !bySlot.has(String(id))) bySlot.set(String(id), i);
  });

  // Rounds in order of first appearance, each holding its rows' indices.
  const roundOrder: string[] = [];
  const roundRows = new Map<string, number[]>();
  const roundOfRow: string[] = [];
  out.forEach((row, i) => {
    const key = isBlank(row[roundKey]) ? '' : String(row[roundKey]);
    roundOfRow[i] = key;
    let list = roundRows.get(key);
    if (!list) {
      list = [];
      roundRows.set(key, list);
      roundOrder.push(key);
    }
    list.push(i);
  });

  const write = (targetIndex: number, side: BracketSide, from: DataRow, fromSide: BracketSide) => {
    const target = out[targetIndex]!;
    for (const field of fields) target[`${side}${field}`] = from[`${fromSide}${field}`] ?? null;
  };

  for (const [r, roundName] of roundOrder.entries()) {
    const indices = roundRows.get(roundName)!;
    const next = roundOrder[r + 1];
    const nextIndices = next === undefined ? undefined : roundRows.get(next);

    for (const [p, i] of indices.entries()) {
      const row = out[i]!;
      const won = winningSide(row, t, firstField);
      if (!won) continue;
      const lost: BracketSide = won === 'home' ? 'away' : 'home';

      /*
       * The winner's route: the override column, else the implied next slot.
       *
       * A *present but unreadable* override routes nowhere rather than falling
       * back to the implied slot. Blank means "no opinion, use the tree"; a
       * typo means the author had an opinion and it did not parse, and quietly
       * substituting the convention would put a team in a slot nobody asked
       * for — the one outcome worse than an empty slot.
       */
      const rawRoute = row[feedsKey];
      const overridden = !isBlank(rawRoute);
      let route = overridden ? parseRoute(rawRoute) : null;
      if (!overridden && nextIndices) {
        const parent = nextIndices[Math.floor(p / 2)];
        if (parent !== undefined) {
          const id = out[parent]![slotKey];
          if (!isBlank(id)) route = [String(id), p % 2 === 0 ? 'home' : 'away'];
        }
      }
      const loserRoute = parseRoute(row[feedsLoserKey]);

      for (const [dest, fromSide] of [
        [route, won],
        [loserRoute, lost],
      ] as const) {
        if (!dest) continue;
        const targetIndex = bySlot.get(dest[0]);
        if (targetIndex === undefined) continue;
        // Forward only. `roundOrder.indexOf` on a handful of rounds is cheaper
        // than the map it would take to avoid it.
        if (roundOrder.indexOf(roundOfRow[targetIndex]!) <= r) continue;
        write(targetIndex, dest[1], row, fromSide);
      }
    }
  }

  return out;
}

/**
 * Run the declarative pipeline over a DataSet.
 *
 * Pure and order-sensitive — `limit` then `sort` is not `sort` then `limit`, and
 * the author controls which they get. Stored with the *consumer* (the table
 * layer), not the source, so two graphics can slice one feed differently.
 *
 * `rank` is placed deliberately: it stamps the position rows hold *at the moment
 * it runs*, so `sort(points, desc) → rank() → sort(team, asc)` gives an
 * alphabetical table that still shows league position. That is the whole reason
 * it is a pipeline step rather than a table option.
 *
 * `advance` has the same property and the opposite pressure: it needs every
 * round present, so it belongs at the *front*. `filter(round = 'QF') → advance`
 * resolves nothing, because the rounds it advances from were dropped before it
 * ran. The bracket demo's ten tables each run `advance` first and narrow after.
 */
export function applyTransforms(data: DataSet, transforms: DataTransform[] = [], ctx: TransformContext = {}): DataSet {
  let rows = data.rows;
  let columns = data.columns;
  let copied = false;

  const mutable = (): DataRow[] => {
    if (!copied) {
      rows = rows.slice();
      copied = true;
    }
    return rows;
  };

  for (const t of transforms) {
    switch (t.op) {
      case 'sort': {
        const dir: 1 | -1 = t.dir === 'desc' ? -1 : 1;
        // Decorate with the original index so equal keys keep author order —
        // Array#sort is stable in modern V8, but the rank column depends on it
        // hard enough to be explicit rather than to rely on it.
        rows = mutable()
          .map((row, i) => ({ row, i }))
          .sort((a, b) => {
            const c = sortCompare(a.row[t.key] ?? null, b.row[t.key] ?? null, dir);
            return c !== 0 ? c : a.i - b.i;
          })
          .map((d) => d.row);
        copied = true;
        break;
      }
      case 'filter':
        rows = mutable().filter((row) => matches(row[t.key] ?? null, t.cmp, t.value));
        copied = true;
        break;
      case 'offset':
        rows = mutable().slice(Math.max(0, Math.floor(t.n)));
        copied = true;
        break;
      case 'limit':
        rows = mutable().slice(0, Math.max(0, Math.floor(t.n)));
        copied = true;
        break;
      case 'rank': {
        const key = t.as ?? DEFAULT_RANK_KEY;
        rows = mutable().map((row, i) => ({ ...row, [key]: i + 1 }));
        copied = true;
        if (!columns.some((c) => c.key === key)) {
          columns = [...columns, { key, label: '#', type: 'number' }];
        }
        break;
      }
      case 'advance': {
        rows = advance(rows, t);
        copied = true;
        // Carried fields are columns a cell can bind to, so declare any the
        // snapshot did not — same contract `rank` has, for the same reason:
        // the table validator checks cells against declared columns.
        const fields = t.fields?.length ? t.fields : [...ADVANCE_DEFAULTS.fields];
        // Field-outer, so the added columns read `homeTeam, awayTeam, homeCode,
        // awayCode` — the pairs an editor grid wants side by side.
        for (const field of fields) {
          for (const side of BRACKET_SIDES) {
            const key = `${side}${field}`;
            if (!columns.some((c) => c.key === key)) {
              columns = [...columns, { key, type: 'string' }];
            }
          }
        }
        break;
      }
      case 'unpivot': {
        const out = unpivot({ ...data, columns, rows }, t);
        rows = out.rows;
        columns = out.columns;
        copied = true;
        break;
      }
      case 'date':
        rows = mutable().filter(dateKeeper(t, ctx.now ?? new Date()));
        copied = true;
        break;
      case 'lookup': {
        const out = lookup({ ...data, columns, rows }, t, ctx.source?.(t.source));
        rows = out.rows;
        columns = out.columns;
        copied = true;
        break;
      }
      case 'compose': {
        const parsed = parseTemplate(t.template);
        const now = ctx.now ?? new Date();
        rows = mutable().map((row) => ({ ...row, [t.as]: renderTemplate(parsed, row, { timezone: t.timezone, now }) }));
        copied = true;
        if (!columns.some((c) => c.key === t.as)) columns = [...columns, { key: t.as, type: 'string' }];
        break;
      }
      case 'union': {
        const other = ctx.source?.(t.source);
        if (!other) break;
        const known = new Set(columns.map((c) => c.key));
        columns = [...columns, ...other.columns.filter((c) => !known.has(c.key))];
        // Every row carries every column — empty where its side had none — so
        // a filter or sort after the union sees null, never a missing key.
        const fill = (row: DataRow): DataRow => {
          const out: DataRow = { ...row };
          for (const c of columns) out[c.key] = row[c.key] ?? null;
          return out;
        };
        rows = [...rows.map(fill), ...other.rows.map(fill)];
        copied = true;
        break;
      }
      default: {
        const exhaustive: never = t;
        throw new Error(`unknown transform ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  if (rows === data.rows && columns === data.columns) return data;
  return { ...data, columns, rows };
}

/* ------------------------------------------------------------ source defs */

export const DATA_SOURCE_TYPES = [
  'manual',
  'http-json',
  'http-csv',
  // Wave 2.
  'rss',
  'xml',
  'sheets',
  // Wave 3.
  'weather',
  'ftp',
  // Phase 8.6 Wave 3 (CYCLE.md).
  'cap',
  'air-quality',
] as const;
export type DataSourceType = (typeof DATA_SOURCE_TYPES)[number];

/** Poll floor, seconds. One slow origin must not be able to starve the loop. */
export const MIN_POLL_INTERVAL = 5;
export const DEFAULT_POLL_INTERVAL = 30;

export interface DataSourceBase {
  id: string;
  name: string;
  type: DataSourceType;
  /** Seconds between polls. Clamped to `MIN_POLL_INTERVAL` server-side. */
  pollInterval?: number;
  /** A disabled source keeps its last-good rows and stops fetching. */
  enabled?: boolean;
  /**
   * Seconds after the last successful fetch at which cached rows stop being
   * shown. Absent keeps last-good rows for ever — the rule every source has had
   * since Phase 6, and still the right one for scores and schedules.
   *
   * Exists for data whose publisher forbids showing it stale: AirNow's terms
   * require "the most current data", and an air-quality reading from yesterday
   * morning presented as current is exactly what they rule out. When it
   * expires the rows are emptied (the columns stay), so a bound cell renders
   * blank rather than wrong.
   */
  expireAfter?: number;
  /**
   * Checks a fetch must pass before its rows replace last-good (CYCLE.md,
   * Wave 5). A fetch that fails them is treated exactly like one that failed
   * to connect: last-good stays on air, the status says why. Not offered on a
   * manual source — its rows are typed, not fetched.
   */
  guard?: DataGuard;
  /**
   * Another source in this project whose rows go on air, under this source's
   * id, when this one has nothing fit to show — the backup. See `fallbackOn`
   * for when. A manual source makes a good one: a canned "temporarily
   * unavailable" row is better on air than a blank.
   */
  fallback?: string;
  /**
   * When the backup takes over. `expired` (default): only when this source has
   * nothing to show — `expireAfter` ran out, the guard's `maxUnchanged` says
   * the content is frozen, or it never loaded at all. `failing`: as soon as a
   * fetch fails or is refused, back again on the next good one — for a primary
   * whose stale data is worse than a backup's fresh data.
   */
  fallbackOn?: FallbackTrigger;
  /**
   * Check every row's media — a list of cameras — and add the result as
   * columns (`MEDIA_COLUMNS`), CYCLE.md Wave 8. See `MediaCheck`.
   */
  media?: MediaCheck;
}

/* ------------------------------------------------------------------ guard */

/** When a backup source takes over. */
export const FALLBACK_TRIGGERS = ['expired', 'failing'] as const;
export type FallbackTrigger = (typeof FALLBACK_TRIGGERS)[number];

/** What a row failing the guard does. */
export const GUARD_BAD_ROWS = ['refuse', 'drop'] as const;
export type GuardBadRows = (typeof GUARD_BAD_ROWS)[number];

/** An operator's choice of rows: automatic, this source's own, or its backup. */
export const SOURCE_USES = ['auto', 'primary', 'backup'] as const;
export type SourceUse = (typeof SOURCE_USES)[number];

/** Numeric bounds on one column. Either end may be left open. */
export interface GuardRange {
  column: string;
  min?: number;
  max?: number;
}

/**
 * What a fetch has to look like to go on air.
 *
 * Written for feeds that answer 200 with the wrong thing: a sheet someone is
 * halfway through editing, an API returning an empty list during a deploy, a
 * sensor reporting 212° — data that loads perfectly and is wrong on air.
 */
export interface DataGuard {
  /** Fewer rows than this (after any dropped) refuses the fetch. */
  minRows?: number;
  /**
   * Losing more than this percentage of the last-good rows in one fetch
   * refuses it — 50 refuses 40 rows falling to 19. A drop that holds for
   * `GUARD_DROP_CONFIRMATIONS` fetches in a row is accepted as real.
   */
  maxDropPercent?: number;
  /** Columns every row must have a value in. */
  required?: string[];
  /** Numeric bounds. A value outside — or one that is not a number — is a bad row; an empty cell is left to `required`. */
  ranges?: GuardRange[];
  /** A bad row refuses the whole fetch (default), or is dropped with the rest kept. */
  badRows?: GuardBadRows;
  /**
   * Seconds the content may go without changing before it counts as frozen —
   * a sheet whose updater died still answers, with the same rows for ever.
   * Frozen content is treated as expired: blank, or the backup.
   */
  maxUnchanged?: number;
}

/** Consecutive identical fetches after which a refused row-count drop is believed. */
export const GUARD_DROP_CONFIRMATIONS = 3;

export type GuardResult =
  | { ok: true; data: DataSet; dropped: number }
  | { ok: false; kind: 'rows' | 'min'; reason: string }
  /** A drop carries what would have gone on air, so a drop that holds can be accepted. */
  | { ok: false; kind: 'drop'; reason: string; data: DataSet; dropped: number };

function guardEmpty(value: DataValue | undefined): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** Why a row fails the guard, or null when it passes. */
function badRowReason(guard: DataGuard, row: DataRow): string | null {
  for (const column of guard.required ?? []) {
    if (guardEmpty(row[column])) return `"${column}" is empty`;
  }
  for (const range of guard.ranges ?? []) {
    const raw = row[range.column];
    if (guardEmpty(raw)) continue;
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
    if (!Number.isFinite(value)) return `"${range.column}" is ${JSON.stringify(raw)}, not a number`;
    if (range.min !== undefined && value < range.min) return `"${range.column}" is ${value}, below the minimum of ${range.min}`;
    if (range.max !== undefined && value > range.max) return `"${range.column}" is ${value}, above the maximum of ${range.max}`;
  }
  return null;
}

/**
 * Check a fetched DataSet against a guard.
 *
 * `prior` is the source's own last-good, for `maxDropPercent`. Pure, so the
 * editor's preview and the registry apply the same rules. `maxUnchanged` is a
 * matter of time, not content, and lives in the registry.
 */
export function applyGuard(guard: DataGuard | undefined, data: DataSet, prior?: DataSet): GuardResult {
  if (!guard) return { ok: true, data, dropped: 0 };
  let rows = data.rows;
  let dropped = 0;

  if (guard.required?.length || guard.ranges?.length) {
    const kept: DataRow[] = [];
    for (const [i, row] of rows.entries()) {
      const reason = badRowReason(guard, row);
      if (reason === null) {
        kept.push(row);
        continue;
      }
      if ((guard.badRows ?? 'refuse') === 'refuse') return { ok: false, kind: 'rows', reason: `row ${i + 1}: ${reason}` };
      dropped += 1;
    }
    rows = kept;
  }

  if (guard.minRows !== undefined && rows.length < guard.minRows) {
    return {
      ok: false,
      kind: 'min',
      reason: `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}${dropped ? ` after dropping ${dropped}` : ''}, fewer than the minimum of ${guard.minRows}`,
    };
  }

  const before = prior?.rows.length ?? 0;
  if (guard.maxDropPercent !== undefined && before > 0 && rows.length < before) {
    const lost = ((before - rows.length) / before) * 100;
    if (lost > guard.maxDropPercent) {
      return {
        ok: false,
        kind: 'drop',
        reason: `rows fell from ${before} to ${rows.length} (${Math.round(lost)}%), more than the ${guard.maxDropPercent}% allowed`,
        data: dropped ? { ...data, rows } : data,
        dropped,
      };
    }
  }

  return { ok: true, data: dropped ? { ...data, rows } : data, dropped };
}

/* ----------------------------------------------------------------- places */

/**
 * Upper bound on places in one source.
 *
 * Every place is its own request (two or three for NWS) on every poll, so the
 * cap is a courtesy to the provider as much as a guard on the server. Fifty
 * covers a statewide rotation with room to spare.
 */
export const MAX_PLACES = 50;

/**
 * One place a multi-place source reports on.
 *
 * Which fields matter depends on the provider: coordinate providers read
 * `latitude`/`longitude`, AirNow's feeds read `area` (a reporting-area id —
 * `111` is Phoenix), and NWS's observed mode takes an optional `station` to pin
 * one instead of using the nearest.
 */
export interface PlaceRef {
  /** Shown on the graphic, in the `place` column. */
  name: string;
  /** Short code for the `placeKey` column — `PHX`. A Cycle key column can use it. */
  key?: string;
  latitude?: number;
  longitude?: number;
  area?: string;
  station?: string;
}

/**
 * Places read from another source's rows — a Cities table.
 *
 * Each field names a column in that source. Unset fields fall back to the
 * obvious header (`name`, `key`, `latitude`/`lat`, `longitude`/`lon`/`lng`,
 * `area`, `station`), so a table typed with ordinary headers needs no mapping.
 *
 * The table is read from the registry's cache, and a change to it re-fetches
 * this source at once: adding Flagstaff to the list is visible on the next
 * page, not fifteen minutes later.
 */
export interface PlacesFrom {
  /** Id of the source holding the places. */
  source: string;
  name?: string;
  key?: string;
  latitude?: string;
  longitude?: string;
  area?: string;
  station?: string;
}

/** Column-name fallbacks for `PlacesFrom`, tried in order after the explicit one. */
export const PLACE_COLUMN_ALIASES = {
  name: ['name', 'place', 'city'],
  key: ['key', 'code', 'id'],
  latitude: ['latitude', 'lat'],
  longitude: ['longitude', 'lon', 'lng', 'long'],
  area: ['area', 'areaId', 'reportingArea'],
  station: ['station', 'stationId', 'icao'],
} as const;

/**
 * Read places out of a table's rows.
 *
 * Pure, so the server and the editor's preview agree on what a Cities table
 * means. A row with no name is skipped — a blank line at the bottom of a sheet
 * is the normal case, not an error — and numbers typed as text (`"33.45"`, as
 * any CSV or Sheets range delivers them) are read as numbers.
 */
export function placesFromRows(rows: DataRow[], map: Omit<PlacesFrom, 'source'> = {}): PlaceRef[] {
  const pick = (row: DataRow, field: keyof typeof PLACE_COLUMN_ALIASES): DataValue | undefined => {
    const explicit = map[field];
    if (explicit) return row[explicit];
    for (const alias of PLACE_COLUMN_ALIASES[field]) {
      if (row[alias] !== undefined && row[alias] !== null && row[alias] !== '') return row[alias];
    }
    return undefined;
  };
  const text = (v: DataValue | undefined): string | undefined => {
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    return s === '' ? undefined : s;
  };
  const number = (v: DataValue | undefined): number | undefined => {
    const s = text(v);
    if (s === undefined) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };

  const places: PlaceRef[] = [];
  for (const row of rows) {
    const name = text(pick(row, 'name'));
    if (!name) continue;
    const place: PlaceRef = { name };
    const key = text(pick(row, 'key'));
    const latitude = number(pick(row, 'latitude'));
    const longitude = number(pick(row, 'longitude'));
    const area = text(pick(row, 'area'));
    const station = text(pick(row, 'station'));
    if (key !== undefined) place.key = key;
    if (latitude !== undefined) place.latitude = latitude;
    if (longitude !== undefined) place.longitude = longitude;
    if (area !== undefined) place.area = area;
    if (station !== undefined) place.station = station;
    places.push(place);
    if (places.length >= MAX_PLACES) break;
  }
  return places;
}

/**
 * The table editor UI *is* this adapter. Rows live in the project rather than
 * behind a fetch, so a graphic built on a manual table needs no connectivity at
 * all — and the same grid is the preview surface every other adapter reuses.
 */
export interface ManualDataSource extends DataSourceBase {
  type: 'manual';
  columns: DataColumn[];
  rows: DataRow[];
}

export interface HttpDataSourceBase extends DataSourceBase {
  url: string;
  /**
   * Names a secret in the server's config file — never the secret itself.
   * Source defs are exported and shared; credentials are not.
   */
  secretId?: string;
  /** Non-secret headers only, e.g. the User-Agent api.weather.gov requires. */
  headers?: Record<string, string>;
}

export interface HttpJsonDataSource extends HttpDataSourceBase {
  type: 'http-json';
  /** Dot/bracket path to the row array, e.g. `data.standings[0].teams`. Empty = root. */
  rowPath?: string;
  /** Declared columns. Omit to infer from the payload. */
  columns?: DataColumn[];
}

export interface HttpCsvDataSource extends HttpDataSourceBase {
  type: 'http-csv';
  /** Defaults to `,`; use `\t` for the TSV a spreadsheet copies. */
  delimiter?: string;
  /** First row is the header. Default true. */
  header?: boolean;
  columns?: DataColumn[];
}

/* ------------------------------------------------------------ Wave 2 defs */

/**
 * RSS 2.0, RSS 1.0/RDF or Atom, normalized to one fixed column set.
 *
 * No `rowPath` on purpose. The adapter knows where a feed's entries live in all
 * three dialects, and its whole value is that a graphic bound to `title` keeps
 * working when a station changes feed software. A path field here would be an
 * invitation to defeat that.
 */
export interface RssDataSource extends HttpDataSourceBase {
  type: 'rss';
  columns?: DataColumn[];
}

/** Any other XML: a path selects the repeating element, its fields the columns. */
export interface XmlDataSource extends HttpDataSourceBase {
  type: 'xml';
  /** Slash path to the repeating element, e.g. `results/game`. Blank = guess. */
  rowPath?: string;
  columns?: DataColumn[];
}

/**
 * Google Sheets API v4 — for sheets that must stay private.
 *
 * Carries a spreadsheet id rather than a URL because it does not address one:
 * the endpoint is constructed from the id and the range, and letting a def
 * supply a full URL would hand an operator a way to point the credential at
 * something that is not Sheets. Published sheets should still use `http-csv`.
 */
export interface SheetsDataSource extends DataSourceBase {
  type: 'sheets';
  /** Spreadsheet id, or the browser URL it was copied from. */
  spreadsheet: string;
  /** A1 notation — `Standings!A1:F30`. Defaults to the first sheet's A1:Z1000. */
  range?: string;
  /**
   * Names the server-side credential: an API key for a link-shared sheet, or a
   * service-account JSON for a private one. Never the credential itself.
   */
  secretId?: string;
  header?: boolean;
  columns?: DataColumn[];
}

/* ------------------------------------------------------------ Wave 3 defs */

/**
 * Weather providers, keyed by the license they put the operator under.
 *
 * `open-meteo` and `open-meteo-self` are the same software and the same wire
 * format, and it would be tempting to collapse them into one provider with an
 * optional `baseUrl`. They are separate on purpose: the hosted service is
 * **non-commercial only** and rate-limited, a self-hosted instance is neither.
 * That difference decides whether a station may legally put the graphic on air,
 * so it is a value written in the file and validated — not something inferred
 * from whether another field happens to be filled in.
 */
export const WEATHER_PROVIDERS = [
  'nws',
  'open-meteo',
  'open-meteo-self',
  'met-norway',
  'brightsky',
] as const;
export type WeatherProvider = (typeof WEATHER_PROVIDERS)[number];

export interface WeatherProviderInfo {
  id: WeatherProvider;
  /**
   * Catalogue key for the picker label, not the label itself.
   *
   * `@breeze/schema` carries identifiers and values; it does not carry English
   * (I18N.md §2.1). The key is a literal here rather than derived from `id` so
   * that `i18n:check` can find it by reading the source, and so a typo fails as
   * an orphan-key error instead of rendering the key on screen.
   */
  labelKey: string;
  /**
   * Catalogue key for the provider's bare name — "NWS", not
   * "NWS — api.weather.gov".
   *
   * Exists because the panel used to derive it by splitting `label` on an em
   * dash. That works in English and nowhere else: a translator may use a
   * different dash, may not use one at all, or may put the qualifier first, and
   * the split would then quietly render half a sentence. Two keys is the fix;
   * string surgery on display text never is.
   */
  shortNameKey: string;
  /** Where the data may be used. `non-commercial` gates the editor. */
  commercialUse: 'yes' | 'non-commercial-only';
  /** Credit line the license obliges, or null where none is required. */
  attribution: string | null;
  /** Link the license obliges to sit next to the data, if any. */
  attributionUrl: string | null;
  licenseUrl: string;
  /** Poll floor in seconds — see the note on WEATHER_POLL_FLOOR below. */
  pollFloor: number;
  /** Catalogue key for the coverage note shown under the picker. */
  coverageKey: string;
  /** True when the def must carry a `baseUrl`. */
  needsBaseUrl: boolean;
  /**
   * True when the provider blocks or throttles traffic that does not carry a
   * contact address in the User-Agent.
   *
   * A capability flag rather than a list of provider ids in the panel: NWS and
   * MET Norway both demand this, for the same stated reason — they want to be
   * able to reach you before they block you — and a third provider that demands
   * it should not need the editor changed to say so.
   */
  needsContact: boolean;
  /**
   * True when the provider lets the caller name a numerical model.
   *
   * Only Open-Meteo does. The field used to be gated on `provider !== 'nws'`,
   * which quietly meant "everything that is not NWS is Open-Meteo" — true when
   * there were three providers and wrong the moment there were five.
   */
  supportsModelSelection: boolean;
  /**
   * Modes the provider can answer.
   *
   * `observed` is the reason this exists: a measured value from a station is a
   * different product from a model's idea of "now", and only NWS and Bright Sky
   * publish one. Offering the mode for the rest would mean quietly serving a
   * forecast under an observation's name.
   */
  modes: readonly WeatherMode[];
}

/**
 * Poll floors are a license and good-manners constraint, not a performance one.
 *
 * Open-Meteo's free tier allows 10,000 calls/day and 300,000/month. At the
 * 900-second floor one source costs ~96 calls/day, so a server can run about a
 * hundred weather sources and stay inside the daily allowance — and none of
 * this matters anyway, because no provider here recomputes faster than hourly.
 * A five-second weather poll is 720 requests for one changed number.
 *
 * A self-hosted instance answers to nobody but its own CPU, so it gets a floor
 * of 60s: still pointless to go below, but the operator's problem if they do.
 */
export const WEATHER_PROVIDER_INFO: Record<WeatherProvider, WeatherProviderInfo> = {
  nws: {
    id: 'nws',
    labelKey: 'schema.weather.provider.nws.label',
    shortNameKey: 'schema.weather.provider.nws.shortName',
    commercialUse: 'yes',
    // A work of the US federal government: public domain, no credit obliged.
    // Crediting anyway is good practice, which is why the adapter still fills
    // the `attribution` column.
    attribution: 'Data from the US National Weather Service',
    attributionUrl: null,
    licenseUrl: 'https://www.weather.gov/disclaimer',
    pollFloor: 300,
    coverageKey: 'schema.weather.provider.nws.coverage',
    needsBaseUrl: false,
    needsContact: true,
    supportsModelSelection: false,
    modes: ['current', 'observed', 'hourly', 'daily'],
  },
  'open-meteo': {
    id: 'open-meteo',
    labelKey: 'schema.weather.provider.open-meteo.label',
    shortNameKey: 'schema.weather.provider.open-meteo.shortName',
    commercialUse: 'non-commercial-only',
    attribution: 'Weather data by Open-Meteo.com',
    attributionUrl: 'https://open-meteo.com/',
    licenseUrl: 'https://open-meteo.com/en/licence',
    pollFloor: 900,
    coverageKey: 'schema.weather.provider.open-meteo.coverage',
    needsBaseUrl: false,
    needsContact: false,
    supportsModelSelection: true,
    modes: ['current', 'hourly', 'daily'],
  },
  'open-meteo-self': {
    id: 'open-meteo-self',
    labelKey: 'schema.weather.provider.open-meteo-self.label',
    shortNameKey: 'schema.weather.provider.open-meteo-self.shortName',
    // The non-commercial term binds the *hosted service*, not the data: the
    // data stays CC BY 4.0, which permits commercial use with credit. Running
    // your own instance therefore removes the commercial restriction but not
    // the attribution obligation.
    commercialUse: 'yes',
    attribution: 'Weather data by Open-Meteo.com',
    attributionUrl: 'https://open-meteo.com/',
    licenseUrl: 'https://open-meteo.com/en/licence',
    pollFloor: 60,
    coverageKey: 'schema.weather.provider.open-meteo-self.coverage',
    needsBaseUrl: true,
    needsContact: false,
    supportsModelSelection: true,
    modes: ['current', 'hourly', 'daily'],
  },
  /*
   * Wave 4. Both exist to answer the same problem: before them, the only free
   * commercially-usable option outside the United States was a *self-hosted*
   * Open-Meteo — a single point of failure, and one that needs a box to run on.
   */
  'met-norway': {
    id: 'met-norway',
    labelKey: 'schema.weather.provider.met-norway.label',
    shortNameKey: 'schema.weather.provider.met-norway.shortName',
    // NLOD 2.0 + CC BY 4.0. Commercial use is permitted with credit; what is
    // *not* permitted is passing your service off as Yr, NRK or MET Norway, so
    // the credit line names them as the source rather than as a partner.
    commercialUse: 'yes',
    attribution: 'Weather data from MET Norway',
    attributionUrl: 'https://www.met.no/',
    licenseUrl: 'https://api.met.no/doc/License',
    /*
     * MET publish no per-client rate limit — the ceiling is 20 requests/second
     * per *application*, which one graphic will never approach. 900s matches
     * the hosted Open-Meteo floor and their own guidance: don't repeat a
     * request before the `Expires` header says to, and Nordic forecasts update
     * hourly at best.
     */
    pollFloor: 900,
    coverageKey: 'schema.weather.provider.met-norway.coverage',
    needsBaseUrl: false,
    // "If we cannot contact you in case of problems, you risk being blocked
    // without warning" — their terms, near enough verbatim.
    needsContact: true,
    supportsModelSelection: false,
    modes: ['current', 'hourly', 'daily'],
  },
  brightsky: {
    id: 'brightsky',
    labelKey: 'schema.weather.provider.brightsky.label',
    shortNameKey: 'schema.weather.provider.brightsky.shortName',
    /*
     * Bright Sky itself is "free-to-use for all purposes"; the data underneath
     * is DWD open data, whose terms permit commercial use with a source
     * reference. So: commercial yes, credit obligatory.
     */
    commercialUse: 'yes',
    attribution: 'Weather data from Deutscher Wetterdienst (DWD), via Bright Sky',
    attributionUrl: 'https://brightsky.dev/',
    licenseUrl: 'https://www.dwd.de/EN/service/legal_notice/legal_notice.html',
    // No published limit and no key. 900s is politeness towards a service one
    // person runs and funds — MOSMIX updates hourly, so nothing is lost.
    pollFloor: 900,
    coverageKey: 'schema.weather.provider.brightsky.coverage',
    needsBaseUrl: false,
    needsContact: false,
    supportsModelSelection: false,
    // Its `current` already *is* a station observation (see weather.ts), so
    // `observed` reads the same endpoint and says so honestly.
    modes: ['current', 'observed', 'hourly', 'daily'],
  },
};

/**
 * One fixed column set across every provider.
 *
 * Same argument as the RSS adapter in Wave 2, and it bites harder here: a
 * station that switches from NWS to a self-hosted Open-Meteo — because it opened
 * a bureau outside the US, or because it went commercial — must not have to
 * rebuild the graphic. Fields a provider does not supply come back null rather
 * than absent, so a bound cell renders empty instead of throwing.
 */
export const WEATHER_COLUMNS: DataColumn[] = [
  // Which place the row is about. One-place sources fill it from `place`;
  // many-place sources from each place's name, so a Cycle can key on it.
  { key: 'place', label: 'Place', type: 'string' },
  { key: 'placeKey', label: 'Place Key', type: 'string' },
  { key: 'time', label: 'Time', type: 'string' },
  // The provider's own name for the period — NWS's "Tonight", "Tuesday".
  { key: 'period', label: 'Period', type: 'string' },
  { key: 'temp', label: 'Temp', type: 'number' },
  { key: 'tempMin', label: 'Low', type: 'number' },
  { key: 'tempMax', label: 'High', type: 'number' },
  { key: 'feelsLike', label: 'Feels Like', type: 'number' },
  { key: 'condition', label: 'Condition', type: 'string' },
  { key: 'icon', label: 'Icon', type: 'string' },
  { key: 'precipProb', label: 'Precip %', type: 'number' },
  { key: 'precipAmount', label: 'Precip', type: 'number' },
  { key: 'windSpeed', label: 'Wind', type: 'number' },
  { key: 'windGust', label: 'Gust', type: 'number' },
  { key: 'windDir', label: 'Wind Dir', type: 'string' },
  { key: 'humidity', label: 'Humidity', type: 'number' },
  { key: 'pressure', label: 'Pressure', type: 'number' },
  { key: 'uvIndex', label: 'UV', type: 'number' },
  { key: 'isDay', label: 'Daytime', type: 'boolean' },
  // Observed mode. `ageMinutes` is as of the fetch — how old the reading was
  // when it arrived — and `station` names what measured it.
  { key: 'dewPoint', label: 'Dew Point', type: 'number' },
  { key: 'visibility', label: 'Visibility', type: 'number' },
  { key: 'station', label: 'Station', type: 'string' },
  { key: 'ageMinutes', label: 'Age (min)', type: 'number' },
  // Carried per row rather than held once on the DataSet so a graphic can bind
  // the credit line with no plumbing beyond the binding it already has. For the
  // one-row `current` mode — the common case for a weather bug — that is exactly
  // one string in exactly the place a designer needs it.
  { key: 'attribution', label: 'Attribution', type: 'string' },
];

/**
 * Canonical icon vocabulary.
 *
 * Providers disagree about everything here: NWS ships icon *URLs* and a prose
 * `shortForecast`, Open-Meteo ships WMO code numbers. Neither is bindable to a
 * designer's own icon set, so both are mapped onto this list and the graphic
 * maps this list onto its artwork once.
 */
export const WEATHER_ICONS = [
  'clear',
  'mostly-clear',
  'partly-cloudy',
  'cloudy',
  'overcast',
  'fog',
  'drizzle',
  'rain',
  'freezing-rain',
  'showers',
  'snow',
  'sleet',
  'thunderstorm',
  'hail',
  'windy',
  'unknown',
] as const;
export type WeatherIcon = (typeof WEATHER_ICONS)[number];

/**
 * `current` is the provider's "now" — for NWS, the first forecast period.
 * `observed` is a measurement from a station, with its age (Phase 8.6 Wave 3).
 */
export const WEATHER_MODES = ['current', 'observed', 'hourly', 'daily'] as const;
export type WeatherMode = (typeof WEATHER_MODES)[number];

export const WEATHER_UNITS = ['metric', 'imperial'] as const;
export type WeatherUnits = (typeof WEATHER_UNITS)[number];

/** Default poll for a new weather source — 15 minutes, one model update. */
export const DEFAULT_WEATHER_POLL_INTERVAL = 900;

/**
 * A location and a provider, not a URL.
 *
 * Deliberately not a preset over `http-json`. The endpoint, the query string,
 * the User-Agent api.weather.gov demands, the two-step gridpoint lookup it
 * needs, the rate floor and the attribution are all consequences of the
 * *provider* — and if the operator could edit the URL, none of them could be
 * enforced. Same reasoning as the Sheets def taking a spreadsheet id.
 */
export interface WeatherDataSource extends DataSourceBase {
  type: 'weather';
  provider: WeatherProvider;
  /** Self-hosted origin, e.g. `http://localhost:8282`. Only for `open-meteo-self`. */
  baseUrl?: string;
  /**
   * One place. Optional since Phase 8.6: a source may instead list `places` or
   * read them from a table with `placesFrom` — the validator requires one of
   * the three.
   */
  latitude?: number;
  longitude?: number;
  /** Shown on the graphic; never sent to the provider. */
  place?: string;
  /** Several places, one fetch each, rows tagged with `place`. */
  places?: PlaceRef[];
  /** Places read from another source's rows — a Cities table. */
  placesFrom?: PlacesFrom;
  /**
   * NWS observed mode: pin a station (`KPHX`) instead of taking the nearest.
   * For many places, `PlaceRef.station` does the same per place.
   */
  station?: string;
  units?: WeatherUnits;
  /** `current` and `observed` are one row per place; `hourly`/`daily` are forecast tables. */
  mode?: WeatherMode;
  /** Rows per place in `hourly`/`daily` mode. Ignored for `current`/`observed`. */
  count?: number;
  /**
   * NWS daily mode: pair each day with the night after it into one row —
   * `tempMax` from the day, `tempMin` from the night — the way every other
   * provider's daily mode already reads.
   *
   * Opt-in because NWS daily has always returned the half-day periods, and a
   * graphic built on "Tonight" being row two would break if that changed under
   * it. The editor turns it on for new sources.
   */
  pairDayNight?: boolean;
  /**
   * Daily mode: from this local hour (0–23) at the place, drop today's row and
   * start at tomorrow. An evening forecast strip that still leads with today's
   * high is showing a number that has already happened.
   */
  startTomorrowAfter?: number;
  /**
   * Open-Meteo model id(s), comma-separated — `ncep_gfs_seamless`.
   *
   * Blank means Open-Meteo's `best_match`, which is right against the hosted
   * API and often wrong against a self-hosted one: `best_match` picks from the
   * models Open-Meteo *knows about*, while an instance only holds the models
   * its operator has actually synced. Pinning the model is therefore the normal
   * configuration self-hosted and the rare one hosted.
   *
   * Not an enum — the model list is long and grows, and an enum here would
   * reject a valid new model until the schema caught up.
   */
  models?: string;
  /**
   * IANA zone or offset name for the returned timestamps. Defaults to `auto`,
   * which resolves from the coordinates — usually what a weather bug wants,
   * since the times on screen should be the times where the weather is.
   */
  timezone?: string;
  /**
   * Who to name in the outgoing `User-Agent` — `mystation.com,
   * ops@mystation.com`. Overrides the server's `BREEZE_CONTACT`.
   *
   * api.weather.gov *requires* a User-Agent and documents that a more unique
   * one is less likely to be caught by someone else's security event. Breeze's
   * built-in fallback is shared by every install, so a station running on it is
   * downstream of every other station's behavior and uncontactable when
   * something goes wrong. Not a secret, so it lives in the def rather than the
   * secret store — but it is per-*deployment* rather than per-source, which is
   * why the server-wide setting is the one to reach for first.
   */
  contact?: string;
}

/* ------------------------------------------------------------------- FTP */

export const FTP_PROTOCOLS = ['ftp', 'ftps', 'sftp'] as const;
export type FtpProtocol = (typeof FTP_PROTOCOLS)[number];

/** How to read the file once it has been pulled down. */
export const FTP_FORMATS = ['csv', 'json', 'xml', 'rss'] as const;
export type FtpFormat = (typeof FTP_FORMATS)[number];

/**
 * The league-office results drop: a directory that gains a file, not an endpoint.
 *
 * The adapter's whole job is to turn "newest file in this directory matching
 * this pattern" into a body, and then hand that body to the parsers the HTTP
 * adapters already use. It deliberately owns no parsing of its own — a results
 * CSV arriving over SFTP and the same CSV served over HTTPS must produce an
 * identical DataSet, or a station that changes delivery method rebuilds its
 * graphics for nothing.
 */
export interface FtpDataSource extends DataSourceBase {
  type: 'ftp';
  protocol: FtpProtocol;
  host: string;
  port?: number;
  /** Directory to poll. */
  path: string;
  /** Glob for the wanted file — `results-*.csv`. Newest mtime wins. */
  pattern: string;
  format: FtpFormat;
  /** Not a secret: an operator has to be able to see which account is in use. */
  username?: string;
  /**
   * Names the server-side credential — a password, or a PEM private key for
   * SFTP. Never the credential itself.
   */
  secretId?: string;
  /* Parser options, mirroring the HTTP adapters field for field. */
  delimiter?: string;
  header?: boolean;
  rowPath?: string;
  columns?: DataColumn[];
}

/* ------------------------------------------------------------------- CAP */

/** CAP 1.2 severities, least to most. The order is the `severityRank` column. */
export const CAP_SEVERITIES = ['Unknown', 'Minor', 'Moderate', 'Severe', 'Extreme'] as const;
export type CapSeverity = (typeof CAP_SEVERITIES)[number];

/**
 * How to read an alert's times.
 *
 * `exact` believes the offsets as written. `local-day` keeps only the calendar
 * date of `effective` and `expires` and treats the alert as running from the
 * start of the first to the end of the last, in the place's own day — for
 * publishers whose offsets are wrong. AirNow's CAP feed stamps a Texas action
 * day `-06:00` in September, when Texas is on `-05:00`; read exactly, the alert
 * would switch off at 11 pm.
 */
export const CAP_TIME_MODES = ['exact', 'local-day'] as const;
export type CapTimeMode = (typeof CAP_TIME_MODES)[number];

/**
 * Alerts in the Common Alerting Protocol — NWS warnings, AirNow action days,
 * any agency that publishes CAP.
 *
 * URL-addressed and fetched like any feed. The reader takes a single CAP
 * `<alert>`, an Atom or RSS feed whose entries carry CAP fields (NWS and AirNow
 * both publish that shape), or the NWS alerts API's GeoJSON — the three forms
 * CAP actually arrives in. Expired, cancelled, test and exercise messages are
 * dropped before anything else sees them: an alert strip must never show a
 * warning that has ended.
 */
export interface CapDataSource extends HttpDataSourceBase {
  type: 'cap';
  /**
   * Keep alerts whose area description contains any of these, comma-separated
   * and case-insensitive — `Maricopa, Phoenix`. Blank keeps every area.
   */
  area?: string;
  /** Keep alerts carrying any of these SAME or UGC codes — `004013, AZZ537`. */
  codes?: string;
  /** Keep alerts whose event contains any of these — `Heat, Dust, Ozone`. */
  events?: string;
  /** Drop anything less severe. */
  minSeverity?: CapSeverity;
  /** Default `exact`. */
  times?: CapTimeMode;
  /**
   * IANA zone that `local-day` times are read in — `America/Phoenix`. Defaults
   * to the server's zone.
   */
  timezone?: string;
  /** Who to name in the User-Agent; NWS requires one. Overrides BREEZE_CONTACT. */
  contact?: string;
}

/** One row per alert, most severe first. */
export const CAP_COLUMNS: DataColumn[] = [
  { key: 'id', label: 'Id', type: 'string' },
  { key: 'event', label: 'Event', type: 'string' },
  { key: 'headline', label: 'Headline', type: 'string' },
  { key: 'description', label: 'Description', type: 'string' },
  { key: 'instruction', label: 'Instruction', type: 'string' },
  { key: 'severity', label: 'Severity', type: 'string' },
  { key: 'severityRank', label: 'Severity Rank', type: 'number' },
  { key: 'urgency', label: 'Urgency', type: 'string' },
  { key: 'certainty', label: 'Certainty', type: 'string' },
  { key: 'category', label: 'Category', type: 'string' },
  { key: 'msgType', label: 'Message Type', type: 'string' },
  { key: 'areaDesc', label: 'Area', type: 'string' },
  // `areaDesc` without the state suffixes — `Pima; Pinal` for `Pima, AZ; Pinal, AZ`. Reads well through `{areas|list}`.
  { key: 'areas', label: 'Areas', type: 'string' },
  // `counties` when every area is a county, otherwise `areas` — from the UGC codes, so a sentence can say which.
  { key: 'areaKind', label: 'Area Kind', type: 'string' },
  { key: 'codes', label: 'Codes', type: 'string' },
  { key: 'sender', label: 'Sender', type: 'string' },
  { key: 'senderName', label: 'Sender Name', type: 'string' },
  { key: 'effective', label: 'Effective', type: 'string' },
  { key: 'onset', label: 'Onset', type: 'string' },
  { key: 'expires', label: 'Expires', type: 'string' },
  { key: 'ends', label: 'Ends', type: 'string' },
  // True once the alert has started; a watch for tomorrow is listed but false.
  { key: 'active', label: 'In Effect', type: 'boolean' },
  { key: 'web', label: 'Link', type: 'string' },
];

/* ----------------------------------------------------------- air quality */

export const AIR_QUALITY_PROVIDERS = ['airnow-feed', 'open-meteo', 'open-meteo-self'] as const;
export type AirQualityProvider = (typeof AIR_QUALITY_PROVIDERS)[number];

/**
 * `current` is one row per place — the highest pollutant's index, which is how
 * an overall AQI is defined. `pollutants` is one row per pollutant.
 * `forecast` is one row per day.
 */
export const AIR_QUALITY_MODES = ['current', 'pollutants', 'forecast'] as const;
export type AirQualityMode = (typeof AIR_QUALITY_MODES)[number];

/** Index scale. AirNow is US only; Open-Meteo computes both from CAMS. */
export const AQI_SCALES = ['us', 'eu'] as const;
export type AqiScale = (typeof AQI_SCALES)[number];

export interface AirQualityProviderInfo {
  id: AirQualityProvider;
  labelKey: string;
  shortNameKey: string;
  commercialUse: 'yes' | 'non-commercial-only';
  /** Fixed credit, or null where the feed names its own agency per row. */
  attribution: string | null;
  attributionUrl: string | null;
  licenseUrl: string;
  pollFloor: number;
  coverageKey: string;
  needsBaseUrl: boolean;
  /** `area` — AirNow reporting-area ids; `coordinates` — latitude/longitude. */
  placeKind: 'area' | 'coordinates';
  scales: readonly AqiScale[];
}

export const AIR_QUALITY_PROVIDER_INFO: Record<AirQualityProvider, AirQualityProviderInfo> = {
  /*
   * EnviroFlash's public RSS feeds — AirNow observations and forecasts per
   * reporting area, no key. EPA-sponsored and run for it by Sonoma Technology.
   *
   * The feeds publish no terms of their own (checked 2026-09-27); the AirNow
   * Data Exchange Guidelines cover "all AirNow data portals" and are what bind
   * whoever shows this data:
   *  - credit the reporting agency first, then AirNow → `agency`, `attribution`;
   *  - observations are preliminary and must say so → `preliminary`;
   *  - values, forecasts and advisory text go out as received → the adapter
   *    passes the feed's own category and pollutant names through verbatim
   *    and never recomputes or rounds them;
   *  - show only the most current data → `expireAfter`;
   *  - tell the agencies about products using it → the station's job, which
   *    the user guide says next to the source.
   */
  'airnow-feed': {
    id: 'airnow-feed',
    labelKey: 'schema.airQuality.provider.airnow-feed.label',
    shortNameKey: 'schema.airQuality.provider.airnow-feed.shortName',
    commercialUse: 'yes',
    attribution: null,
    attributionUrl: 'https://www.airnow.gov/',
    licenseUrl: 'https://docs.airnowapi.org/docs/DataUseGuidelines.pdf',
    // Observations are hourly and published around half past; ten minutes is
    // plenty to catch each one without asking again for the same hour.
    pollFloor: 600,
    coverageKey: 'schema.airQuality.provider.airnow-feed.coverage',
    needsBaseUrl: false,
    placeKind: 'area',
    scales: ['us'],
  },
  'open-meteo': {
    id: 'open-meteo',
    labelKey: 'schema.airQuality.provider.open-meteo.label',
    shortNameKey: 'schema.airQuality.provider.open-meteo.shortName',
    // Same hosted-service terms as the weather API: non-commercial without a key.
    commercialUse: 'non-commercial-only',
    attribution: 'Air quality from CAMS (Copernicus Atmosphere Monitoring Service), via Open-Meteo.com',
    attributionUrl: 'https://open-meteo.com/',
    licenseUrl: 'https://open-meteo.com/en/licence',
    pollFloor: 900,
    coverageKey: 'schema.airQuality.provider.open-meteo.coverage',
    needsBaseUrl: false,
    placeKind: 'coordinates',
    scales: ['us', 'eu'],
  },
  'open-meteo-self': {
    id: 'open-meteo-self',
    labelKey: 'schema.airQuality.provider.open-meteo-self.label',
    shortNameKey: 'schema.airQuality.provider.open-meteo-self.shortName',
    // CAMS data is free for commercial use with credit; the restriction was the
    // hosted service's, so a self-hosted instance lifts it.
    commercialUse: 'yes',
    attribution: 'Air quality from CAMS (Copernicus Atmosphere Monitoring Service), via Open-Meteo.com',
    attributionUrl: 'https://open-meteo.com/',
    licenseUrl: 'https://open-meteo.com/en/licence',
    pollFloor: 60,
    coverageKey: 'schema.airQuality.provider.open-meteo-self.coverage',
    needsBaseUrl: true,
    placeKind: 'coordinates',
    scales: ['us', 'eu'],
  },
};

/** Default poll for a new air-quality source — observations are hourly. */
export const DEFAULT_AIR_QUALITY_POLL_INTERVAL = 900;

/**
 * Three hours: an AirNow reading older than that is no longer "current" in any
 * sense a viewer would accept, and the hourly feed has missed two updates.
 */
export const DEFAULT_AIR_QUALITY_EXPIRY = 3 * 60 * 60;

export interface AqiCategory {
  /** Highest index value in the band, inclusive. */
  max: number;
  /** 1-based band number — `categoryIndex`. */
  index: number;
  /** The band's published name. Data, not interface text: it is what the agency says. */
  name: string;
  /** The band's published colour. */
  color: string;
}

/**
 * Published bands and colours.
 *
 * US: EPA's AQI technical assistance document. EU: the European Environment
 * Agency's index, with the bands Open-Meteo documents (0–20 good … over 100
 * extremely poor).
 */
export const AQI_CATEGORIES: Record<AqiScale, readonly AqiCategory[]> = {
  us: [
    { max: 50, index: 1, name: 'Good', color: '#00E400' },
    { max: 100, index: 2, name: 'Moderate', color: '#FFFF00' },
    { max: 150, index: 3, name: 'Unhealthy for Sensitive Groups', color: '#FF7E00' },
    { max: 200, index: 4, name: 'Unhealthy', color: '#FF0000' },
    { max: 300, index: 5, name: 'Very Unhealthy', color: '#8F3F97' },
    { max: Number.POSITIVE_INFINITY, index: 6, name: 'Hazardous', color: '#7E0023' },
  ],
  eu: [
    { max: 20, index: 1, name: 'Good', color: '#50F0E6' },
    { max: 40, index: 2, name: 'Fair', color: '#50CCAA' },
    { max: 60, index: 3, name: 'Moderate', color: '#F0E641' },
    { max: 80, index: 4, name: 'Poor', color: '#FF5050' },
    { max: 100, index: 5, name: 'Very Poor', color: '#960032' },
    { max: Number.POSITIVE_INFINITY, index: 6, name: 'Extremely Poor', color: '#7D2181' },
  ],
};

/** The band an index value falls in, or null for no value. */
export function aqiCategory(scale: AqiScale, aqi: number | null | undefined): AqiCategory | null {
  if (aqi === null || aqi === undefined || !Number.isFinite(aqi) || aqi < 0) return null;
  return AQI_CATEGORIES[scale].find((band) => aqi <= band.max) ?? null;
}

/** Display names of the scales, for the `scale` column. */
export const AQI_SCALE_NAMES: Record<AqiScale, string> = { us: 'US AQI', eu: 'EU AQI' };

export interface AirQualityDataSource extends DataSourceBase {
  type: 'air-quality';
  provider: AirQualityProvider;
  /** Self-hosted Open-Meteo origin. Only for `open-meteo-self`. */
  baseUrl?: string;
  /** One AirNow reporting area — `111` is Phoenix. */
  area?: string;
  /** One place by coordinates, for Open-Meteo. */
  latitude?: number;
  longitude?: number;
  /** Shown on the graphic for a one-place source. */
  place?: string;
  places?: PlaceRef[];
  placesFrom?: PlacesFrom;
  mode?: AirQualityMode;
  /** Default `us`. AirNow publishes US AQI only. */
  scale?: AqiScale;
  /** Forecast days per place. */
  count?: number;
  /** IANA zone for Open-Meteo's timestamps; defaults to `auto`. */
  timezone?: string;
  contact?: string;
}

/**
 * One fixed column set across providers, for the same reason as the weather
 * columns: switching from AirNow to CAMS must not mean rebuilding the graphic.
 */
export const AIR_QUALITY_COLUMNS: DataColumn[] = [
  { key: 'place', label: 'Place', type: 'string' },
  { key: 'placeKey', label: 'Place Key', type: 'string' },
  { key: 'time', label: 'Time', type: 'string' },
  // Forecast rows: the publisher's own day name — "Today", "Tomorrow", "Tuesday".
  { key: 'period', label: 'Period', type: 'string' },
  { key: 'aqi', label: 'AQI', type: 'number' },
  { key: 'category', label: 'Category', type: 'string' },
  { key: 'categoryIndex', label: 'Category #', type: 'number' },
  { key: 'color', label: 'Color', type: 'string' },
  { key: 'pollutant', label: 'Pollutant', type: 'string' },
  { key: 'scale', label: 'Scale', type: 'string' },
  // AirNow's terms: observations are preliminary and must be shown as such.
  { key: 'preliminary', label: 'Preliminary', type: 'boolean' },
  { key: 'ageMinutes', label: 'Age (min)', type: 'number' },
  { key: 'agency', label: 'Agency', type: 'string' },
  { key: 'attribution', label: 'Attribution', type: 'string' },
];

export type DataSourceDef =
  | ManualDataSource
  | HttpJsonDataSource
  | HttpCsvDataSource
  | RssDataSource
  | XmlDataSource
  | SheetsDataSource
  | WeatherDataSource
  | FtpDataSource
  | CapDataSource
  | AirQualityDataSource;

/** Defs that address an origin by URL — everything the shared fetcher can take. */
export type UrlDataSource =
  | HttpJsonDataSource
  | HttpCsvDataSource
  | RssDataSource
  | XmlDataSource
  | CapDataSource;

export function isUrlSource(def: DataSourceDef): def is UrlDataSource {
  return (
    def.type === 'http-json' ||
    def.type === 'http-csv' ||
    def.type === 'rss' ||
    def.type === 'xml' ||
    def.type === 'cap'
  );
}

/** Sources whose places can come from another source's rows. */
export function placesSourceOf(def: DataSourceDef): string | undefined {
  if (def.type === 'weather' || def.type === 'air-quality') return def.placesFrom?.source;
  return undefined;
}

/**
 * Poll floor for a def, in seconds.
 *
 * Weather overrides the global floor because its constraint is the provider's
 * license rather than this server's scheduler — see WEATHER_PROVIDER_INFO.
 */
export function pollFloor(def: DataSourceDef): number {
  if (def.type === 'weather') {
    return WEATHER_PROVIDER_INFO[def.provider]?.pollFloor ?? DEFAULT_WEATHER_POLL_INTERVAL;
  }
  if (def.type === 'air-quality') {
    return AIR_QUALITY_PROVIDER_INFO[def.provider]?.pollFloor ?? DEFAULT_AIR_QUALITY_POLL_INTERVAL;
  }
  /*
   * NWS asks alert consumers not to poll faster than every thirty seconds, and
   * nothing publishing CAP updates more often than that.
   */
  if (def.type === 'cap') return 30;
  return MIN_POLL_INTERVAL;
}

/** Sources the poller drives. Manual rows are the definition; nothing to fetch. */
export function isPolledSource(def: DataSourceDef): boolean {
  return def.type !== 'manual';
}

/** Per-source health, surfaced in the editor so a dead feed is diagnosed there. */
export interface DataSourceStatus {
  id: string;
  /** Last completed fetch, success or not. */
  lastFetch?: string;
  /** Last fetch whose content hash differed — i.e. the last real change. */
  lastChange?: string;
  lastError?: string;
  /**
   * A fetch that succeeded in part — two of ten places failed and kept their
   * last-good rows. Not an error: the source is working. Cleared by the next
   * fetch that succeeds in full.
   */
  warning?: string;
  /** Last fetch that succeeded, in full or in part. `expireAfter` counts from here. */
  lastSuccess?: string;
  /** True while `expireAfter` has emptied the rows. */
  expired?: boolean;
  /** True while the guard's `maxUnchanged` says the content has been frozen too long. */
  stuck?: boolean;
  /** Rows the guard dropped from the last fetch. */
  dropped?: number;
  /** The rows on air are this other source's — the backup is serving. */
  serving?: string;
  /** An operator's override. Absent is automatic. */
  use?: 'primary' | 'backup';
  /** Consecutive failures; drives the backoff. */
  failures?: number;
  /** The media checks, when the source has them. */
  media?: MediaSummary;
  revision: number;
  rowCount: number;
}

/**
 * Reserved `update()` key carrying data-source payloads.
 *
 * The tick was originally sketched as `{ sourceId, revision }` with the page
 * holding rows from an earlier full push. We push the whole DataSet instead, for
 * one reason: the hub retains channel data and replays it on reconnect, which is
 * the property that stops a browser source coming back blank mid-show. A
 * revision-only tick would leave the reconnecting page holding a number and no
 * rows. Payloads are a few kB and only sent when the content hash changes.
 */
export const DATA_UPDATE_KEY = '$data';

export type DataPushPayload = Record<string, DataSet>;

export function isDataPush(key: string): boolean {
  return key === DATA_UPDATE_KEY;
}
