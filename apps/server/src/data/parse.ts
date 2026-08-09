// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Payload → DataSet. Pure, no I/O — every adapter's parsing half lives here so
 * it can be tested against real-world payload shapes without a network.
 */

import {
  conform,
  inferColumns,
  type ColumnType,
  type DataColumn,
  type DataRow,
  type DataSet,
  type DataValue,
} from '@breeze/schema';

/* -------------------------------------------------------------------- CSV */

/**
 * RFC 4180 CSV, minus the parts nothing emits.
 *
 * Written rather than depended on because the requirement is narrow and the
 * failure modes are specific: Google Sheets' "publish to web" CSV is the target,
 * and it quotes fields containing commas or newlines and escapes a quote by
 * doubling it. A regex split on commas gets a team called "Smith, Jr." wrong,
 * and a naive line split breaks on any address field.
 */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  // A UTF-8 BOM survives Excel's "save as CSV" and would otherwise become part
  // of the first column's key — a column named "﻿team" that no cell binds to.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i]!;

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // Swallow CRLF as one break; a lone CR is a break too.
      if (text[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  // A trailing newline must not produce a phantom empty row, but a genuine
  // final field without one must survive.
  if (field !== '' || row.length) endRow();

  return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '');
}

/** Guess the delimiter of a pasted block. Spreadsheets copy TSV. */
export function sniffDelimiter(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  const tabs = (line.match(/\t/g) ?? []).length;
  const commas = (line.match(/,/g) ?? []).length;
  const semis = (line.match(/;/g) ?? []).length;
  if (tabs >= commas && tabs >= semis && tabs > 0) return '\t';
  if (semis > commas) return ';';
  return ',';
}

/**
 * Turn a header cell into a stable column key.
 *
 * Cells bind to keys, so a key that changes when someone retitles "W" to "Wins"
 * silently empties a column on air. Nothing can prevent that entirely, but
 * normalising kills the *accidental* churn — a trailing space, a case change,
 * the non-breaking space Sheets leaves behind.
 */
export function headerToKey(header: string, index: number): string {
  const key = header
    .replace(/ /g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key || `col${index + 1}`;
}

/**
 * A column's type, guessed from up to 50 non-empty sample values.
 *
 * Text-format adapters — CSV, and now XML — get *every* value as a string, so
 * the JS-typeof inference in `@breeze/schema` would call every column a string
 * and a standings table would sort 10 before 9 on air. Sampling the text is the
 * only way to recover the type these formats threw away.
 */
export function inferTypeFromText(samples: string[]): ColumnType {
  const values = samples.map((v) => v.trim()).filter((v) => v !== '').slice(0, 50);
  if (values.length === 0) return 'string';
  if (values.every((v) => Number.isFinite(Number(v.replace(/[,\s$£€%]/g, ''))))) return 'number';
  if (values.every((v) => /^(true|false|yes|no)$/i.test(v))) return 'boolean';
  return 'string';
}

/** Column types guessed from the sample rows — numbers must sort as numbers. */
export function inferColumnsFromRows(headers: string[], rows: string[][]): DataColumn[] {
  return headers.map((header, i) => {
    const key = headerToKey(header, i);
    return {
      key,
      label: header.trim() || key,
      type: inferTypeFromText(rows.map((r) => r[i] ?? '')),
    };
  });
}

/**
 * Columns for object rows whose values are all text — the XML adapter's case.
 *
 * Keys are collected across *every* row in first-seen order, not just the
 * first: an export whose opening record omits an optional field would otherwise
 * drop that column for every record behind it. (Same reasoning as
 * `inferColumns` in the schema package; this one differs only in typing from
 * the text rather than from `typeof`.)
 */
export function inferColumnsFromTextRows(rows: DataRow[]): DataColumn[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }

  return keys.map((key) => ({
    key,
    type: inferTypeFromText(rows.map((r) => (r[key] === null ? '' : String(r[key] ?? '')))),
  }));
}

export interface CsvParseOptions {
  delimiter?: string;
  /** First row is the header. Default true. */
  header?: boolean;
  /** Declared columns win over anything inferred from the payload. */
  columns?: DataColumn[];
}

/**
 * Grid of cells → DataSet.
 *
 * Split out from `csvToDataSet` because the Sheets API v4 adapter arrives at
 * exactly this point by a different road: `values.get` returns
 * `{ values: [[…], […]] }`, already a grid, and re-serialising it to CSV so it
 * could be re-parsed would be a round trip through a format neither end wanted —
 * one that reintroduces quoting bugs on cells that never had them.
 */
export function gridToDataSet(
  id: string,
  grid: string[][],
  opts: Omit<CsvParseOptions, 'delimiter'> = {},
): DataSet {
  if (grid.length === 0) return { id, columns: opts.columns ?? [], rows: [] };

  const useHeader = opts.header !== false;
  const headers = useHeader ? grid[0]! : grid[0]!.map((_, i) => `col${i + 1}`);
  const body = useHeader ? grid.slice(1) : grid;

  const columns = opts.columns?.length ? opts.columns : inferColumnsFromRows(headers, body);

  const rows: DataRow[] = body.map((cells) => {
    const row: DataRow = {};
    columns.forEach((col, i) => {
      row[col.key] = (cells[i] ?? '') as DataValue;
    });
    return row;
  });

  return { id, columns, rows: conform(rows, columns) };
}

export function csvToDataSet(id: string, text: string, opts: CsvParseOptions = {}): DataSet {
  const delimiter = opts.delimiter ?? sniffDelimiter(text);
  return gridToDataSet(id, parseDelimited(text, delimiter), {
    ...(opts.header !== undefined ? { header: opts.header } : {}),
    ...(opts.columns ? { columns: opts.columns } : {}),
  });
}

/* ------------------------------------------------------------------- JSON */

/**
 * Resolve a dot/bracket path against a parsed payload.
 *
 * Deliberately not JSONPath. The whole requirement is "point at the array in
 * this response" — `data.standings[0].teams` — and a full expression language
 * would be a filter engine competing with the transform pipeline that already
 * exists, plus a parser to get wrong.
 */
export function resolvePath(value: unknown, path: string | undefined): unknown {
  if (!path || path.trim() === '') return value;

  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean);

  let current: unknown = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Find the row array in a payload nobody described.
 *
 * A first-run convenience for the editor's path picker, not a runtime
 * behaviour: a saved source always carries an explicit `rowPath`, because a feed
 * that grows a second array would otherwise silently start reading the wrong one.
 */
export function guessRowPath(value: unknown, maxDepth = 4): string | undefined {
  const isRowArray = (v: unknown): boolean =>
    Array.isArray(v) && v.length > 0 && v.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r));

  if (isRowArray(value)) return '';

  const walk = (node: unknown, prefix: string, depth: number): string | undefined => {
    if (depth > maxDepth || node === null || typeof node !== 'object') return undefined;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isRowArray(child)) return path;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const found = walk(child, prefix ? `${prefix}.${key}` : key, depth + 1);
      if (found) return found;
    }
    return undefined;
  };

  return walk(value, '', 0);
}

/** Flatten one level of nesting so `{team:{name}}` yields a `team_name` column. */
function flattenRow(value: unknown): DataRow {
  const out: DataRow = {};
  if (value === null || typeof value !== 'object') return { value: value as DataValue };

  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || typeof v !== 'object') {
      out[key] = v as DataValue;
      continue;
    }
    if (Array.isArray(v)) {
      // Arrays inside a row are joined rather than dropped: a `tags` array is
      // legitimate table content, and an object column that renders
      // "[object Object]" on air is worse than a comma-separated string.
      out[key] = v.map((x) => (x === null || typeof x !== 'object' ? String(x) : JSON.stringify(x))).join(', ');
      continue;
    }
    for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
      if (v2 === null || typeof v2 !== 'object') out[`${key}_${k2}`] = v2 as DataValue;
    }
  }
  return out;
}

export interface JsonParseOptions {
  rowPath?: string;
  columns?: DataColumn[];
}

export function jsonToDataSet(id: string, payload: unknown, opts: JsonParseOptions = {}): DataSet {
  const target = resolvePath(payload, opts.rowPath);

  let rows: DataRow[];
  if (Array.isArray(target)) {
    rows = target.map(flattenRow);
  } else if (target && typeof target === 'object') {
    // A single object is a one-row set — the scalar-source shape (weather now,
    // a scoreboard clock later).
    rows = [flattenRow(target)];
  } else {
    rows = [];
  }

  const columns = opts.columns?.length ? opts.columns : inferColumns(rows);
  return { id, columns, rows: conform(rows, columns) };
}
