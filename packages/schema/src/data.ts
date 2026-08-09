// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Breeze Overlay — Phase 6 data model.
 *
 * DATA-SOURCES.md §1 rule: **one canonical data shape, many adapters.** Every
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

export type DataTransform =
  | { op: 'sort'; key: string; dir?: 'asc' | 'desc' }
  | { op: 'filter'; key: string; cmp: FilterOp; value?: DataValue }
  | { op: 'limit'; n: number }
  | { op: 'offset'; n: number }
  | { op: 'rank'; as?: string }
  | AdvanceTransform;

/** Column `rank` writes into when no `as` is given. */
export const DEFAULT_RANK_KEY = 'rank';

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

function matches(value: DataValue, cmp: FilterOp, against: DataValue | undefined): boolean {
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
export function applyTransforms(data: DataSet, transforms: DataTransform[] = []): DataSet {
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
   * Source defs are exported and shared; credentials are not (DATA-SOURCES §6).
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
  label: string;
  /** Where the data may be used. `non-commercial` gates the editor. */
  commercialUse: 'yes' | 'non-commercial-only';
  /** Credit line the license obliges, or null where none is required. */
  attribution: string | null;
  /** Link the license obliges to sit next to the data, if any. */
  attributionUrl: string | null;
  licenseUrl: string;
  /** Poll floor in seconds — see the note on WEATHER_POLL_FLOOR below. */
  pollFloor: number;
  /** Rough coverage, for the picker. */
  coverage: string;
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
    label: 'NWS — api.weather.gov',
    commercialUse: 'yes',
    // A work of the US federal government: public domain, no credit obliged.
    // Crediting anyway is good practice, which is why the adapter still fills
    // the `attribution` column.
    attribution: 'Data from the US National Weather Service',
    attributionUrl: null,
    licenseUrl: 'https://www.weather.gov/disclaimer',
    pollFloor: 300,
    coverage: 'United States and territories only',
    needsBaseUrl: false,
    needsContact: true,
    supportsModelSelection: false,
  },
  'open-meteo': {
    id: 'open-meteo',
    label: 'Open-Meteo — hosted (non-commercial)',
    commercialUse: 'non-commercial-only',
    attribution: 'Weather data by Open-Meteo.com',
    attributionUrl: 'https://open-meteo.com/',
    licenseUrl: 'https://open-meteo.com/en/licence',
    pollFloor: 900,
    coverage: 'Worldwide',
    needsBaseUrl: false,
    needsContact: false,
    supportsModelSelection: true,
  },
  'open-meteo-self': {
    id: 'open-meteo-self',
    label: 'Open-Meteo — self-hosted',
    // The non-commercial term binds the *hosted service*, not the data: the
    // data stays CC BY 4.0, which permits commercial use with credit. Running
    // your own instance therefore removes the commercial restriction but not
    // the attribution obligation.
    commercialUse: 'yes',
    attribution: 'Weather data by Open-Meteo.com',
    attributionUrl: 'https://open-meteo.com/',
    licenseUrl: 'https://open-meteo.com/en/licence',
    pollFloor: 60,
    coverage: 'Worldwide',
    needsBaseUrl: true,
    needsContact: false,
    supportsModelSelection: true,
  },
  /*
   * Wave 4. Both exist to answer the same problem: before them, the only free
   * commercially-usable option outside the United States was a *self-hosted*
   * Open-Meteo — a single point of failure, and one that needs a box to run on.
   */
  'met-norway': {
    id: 'met-norway',
    label: 'MET Norway — Locationforecast',
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
    coverage: 'Worldwide; sharpest in the Nordics and Arctic',
    needsBaseUrl: false,
    // "If we cannot contact you in case of problems, you risk being blocked
    // without warning" — their terms, near enough verbatim.
    needsContact: true,
    supportsModelSelection: false,
  },
  brightsky: {
    id: 'brightsky',
    label: 'Bright Sky — DWD (Germany)',
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
    coverage: 'Germany and immediate surroundings only',
    needsBaseUrl: false,
    needsContact: false,
    supportsModelSelection: false,
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
  { key: 'time', label: 'Time', type: 'string' },
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

export const WEATHER_MODES = ['current', 'hourly', 'daily'] as const;
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
  latitude: number;
  longitude: number;
  /** Shown on the graphic; never sent to the provider. */
  place?: string;
  units?: WeatherUnits;
  /** `current` is a one-row DataSet; `hourly`/`daily` are forecast tables. */
  mode?: WeatherMode;
  /** Rows to return in `hourly`/`daily` mode. Ignored for `current`. */
  count?: number;
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
   * SFTP. Never the credential itself (DATA-SOURCES §6).
   */
  secretId?: string;
  /* Parser options, mirroring the HTTP adapters field for field. */
  delimiter?: string;
  header?: boolean;
  rowPath?: string;
  columns?: DataColumn[];
}

export type DataSourceDef =
  | ManualDataSource
  | HttpJsonDataSource
  | HttpCsvDataSource
  | RssDataSource
  | XmlDataSource
  | SheetsDataSource
  | WeatherDataSource
  | FtpDataSource;

/** Defs that address an origin by URL — everything the shared fetcher can take. */
export type UrlDataSource = HttpJsonDataSource | HttpCsvDataSource | RssDataSource | XmlDataSource;

export function isUrlSource(def: DataSourceDef): def is UrlDataSource {
  return (
    def.type === 'http-json' ||
    def.type === 'http-csv' ||
    def.type === 'rss' ||
    def.type === 'xml'
  );
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
  /** Consecutive failures; drives the backoff. */
  failures?: number;
  revision: number;
  rowCount: number;
}

/**
 * Reserved `update()` key carrying data-source payloads.
 *
 * DATA-SOURCES §1 sketched the tick as `{ sourceId, revision }` with the page
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
