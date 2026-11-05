// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Finding a table's columns in a header row (0.79.1).
 *
 * Shared by the server's readers — a Sheet, a CSV URL, an FTP drop — and the
 * editor's manual-table paste, so a header means the same thing however the
 * rows arrive. Pure: no DOM, no I/O.
 */

import { coerce, type ColumnType, type DataColumn, type DataRow, type DataValue } from './data.js';

/**
 * How a table's declared columns found their places in a header row.
 *
 * Reported rather than thrown: a column that has gone missing reads as blank
 * and the rest of the sheet keeps working, but somebody has to be told, or the
 * first anyone hears of it is a blank score on air.
 */
export interface ColumnMatch {
  /** Declared columns no header names. They read as blank. */
  missing: string[];
  /**
   * No declared column named any header, so the columns were read by position.
   * That is how every declared column was read before 0.79.1, and it is kept
   * for a source whose declared keys deliberately rename a sheet's headers
   * (decided 2026-11-03: read by position, don't refuse).
   */
  positional: boolean;
}

/**
 * The name a header and a declared column are compared by.
 *
 * Looser than a column key on purpose. A sport template declares camelCase
 * keys (`homeScore`) and a person typing a sheet writes `Home Score`,
 * `home_score` or `HOME SCORE`; all four have to find each other. Letters and
 * digits of any script survive, so a header in Greek or Japanese still matches
 * its own key; everything else goes.
 */
export function columnMatchName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Which header cell each declared column reads from.
 *
 * Before 0.79.1 a declared column read the cell at its own position and the
 * header row was ignored. Every sheet or CSV source made from a sport template
 * declares its columns, so a sheet listing `awayScore` before `homeScore` put
 * the score on air reversed, and the format check passed because every value
 * was still a number. A column inserted anywhere shifted everything after it.
 *
 * Each column is looked up by its key and then its label. Every key is tried
 * before any label, so one column's label cannot take the header another
 * column's key names, and a header is used once: a repeated header after the
 * first is ignored. Position is used only when no declared column names any
 * header at all, and the report says so.
 */
export function matchDeclaredColumns(
  headers: readonly string[],
  columns: readonly DataColumn[],
): { index: Array<number | undefined>; match: ColumnMatch } {
  const byName = new Map<string, number>();
  headers.forEach((header, i) => {
    const name = columnMatchName(header);
    if (name && !byName.has(name)) byName.set(name, i);
  });
  const index: Array<number | undefined> = columns.map(() => undefined);
  const used = new Set<number>();
  const claim = (i: number, name: string | undefined): void => {
    if (!name || index[i] !== undefined) return;
    const at = byName.get(columnMatchName(name));
    if (at === undefined || used.has(at)) return;
    index[i] = at;
    used.add(at);
  };
  columns.forEach((col, i) => claim(i, col.key));
  columns.forEach((col, i) => claim(i, col.label));
  if (used.size === 0) {
    return { index: columns.map((_, i) => i), match: { missing: [], positional: true } };
  }
  const missing = columns.filter((_, i) => index[i] === undefined).map((c) => c.key);
  return { index, match: { missing, positional: false } };
}

/* ------------------------------------------------------------------ paste */

export interface PasteOptions {
  /** The cell the paste landed in. */
  row: number;
  column: number;
  /**
   * The block's first line is a header row and the block replaces the table —
   * a paste into the first cell. Otherwise the block is cells, written from
   * the cell it landed in, the way a spreadsheet pastes.
   */
  headers: boolean;
  /**
   * The table's columns are fixed: a sport-template table, whose keys the
   * Game block and every binding read. A header paste maps onto them by name
   * and never replaces them.
   */
  lockColumns: boolean;
}

export interface PasteResult {
  columns: DataColumn[];
  rows: DataRow[];
  /** Pasted headers that name no column of a locked table. Their cells were not pasted. */
  unmatched: string[];
  /** A locked table's columns the paste had no header for. They are blank in the pasted rows. */
  blank: string[];
  /**
   * A locked table, and the block's first line named none of its columns: the
   * whole block was pasted as data, by position, from the first column.
   */
  asData: boolean;
}

/** The key a pasted header becomes on an unlocked table. Frozen: graphics bind to it. */
function pastedKey(header: string, index: number, taken: Set<string>): string {
  const base =
    header
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || `col${index + 1}`;
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
  taken.add(key);
  return key;
}

/** One pasted cell as the value a column of this type stores. A blank cell stays blank. */
function cellValue(cell: string, type: ColumnType): DataValue {
  if (cell.trim() === '') return '';
  if (type === 'number' || type === 'boolean') return coerce(cell, type);
  return cell;
}

/**
 * Paste a block copied from a spreadsheet (TSV) into a manual table.
 *
 * - **Into a cell** (`headers: false`): cells are written from that cell, right
 *   and down, rows added as needed. Columns don't change.
 * - **Into the first cell** (`headers: true`), the block replaces the table:
 *   - on a **locked** table its header row is matched to the table's columns
 *     by name (`matchDeclaredColumns`). The columns never change; a column the
 *     paste has no header for is blank, a pasted header no column has is left
 *     out, and both are reported. A first line that names none of the columns
 *     is taken as data rather than as headers.
 *   - on an **unlocked** table the header row becomes the columns. A header
 *     that names an existing column keeps that column's key, label and type,
 *     so bindings to it survive the paste; new headers get new keys.
 */
export function pasteBlock(
  columns: readonly DataColumn[],
  rows: readonly DataRow[],
  text: string,
  opts: PasteOptions,
): PasteResult {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  const grid = lines.filter((l, i) => l !== '' || i < lines.length - 1).map((l) => l.split('\t'));
  const none: Pick<PasteResult, 'unmatched' | 'blank' | 'asData'> = { unmatched: [], blank: [], asData: false };
  if (grid.length === 0) return { columns: [...columns], rows: [...rows], ...none };

  if (!opts.headers) {
    const out = rows.map((r) => ({ ...r }));
    grid.forEach((cells, r) => {
      const target = opts.row + r;
      while (out.length <= target) out.push({});
      const row = out[target]!;
      cells.forEach((cell, c) => {
        const col = columns[opts.column + c];
        if (col) row[col.key] = cellValue(cell, col.type);
      });
    });
    return { columns: [...columns], rows: out, ...none };
  }

  const headers = grid[0]!;
  const body = grid.slice(1);

  if (opts.lockColumns) {
    const { index, match } = matchDeclaredColumns(headers, columns);
    if (match.positional) {
      // Nothing in the first line is one of this table's columns: it is a row.
      const out = grid.map((cells) =>
        Object.fromEntries(columns.map((col, c) => [col.key, cellValue(cells[c] ?? '', col.type)])),
      );
      return { columns: [...columns], rows: out, unmatched: [], blank: [], asData: true };
    }
    const used = new Set(index.filter((i): i is number => i !== undefined));
    const unmatched = headers.filter((h, i) => !used.has(i) && h.trim() !== '').map((h) => h.trim());
    const out = body.map((cells) =>
      Object.fromEntries(
        columns.map((col, c) => {
          const at = index[c];
          return [col.key, at === undefined ? null : cellValue(cells[at] ?? '', col.type)];
        }),
      ),
    );
    return { columns: [...columns], rows: out, unmatched, blank: match.missing, asData: false };
  }

  // Unlocked: the header row is the table. Existing columns it names survive.
  const taken = new Set<string>();
  const kept = new Set<number>();
  const firstRow = body[0] ?? [];
  const next: DataColumn[] = headers.map((header, i) => {
    const name = columnMatchName(header);
    const existing = name
      ? columns.findIndex((c, ci) => !kept.has(ci) && (columnMatchName(c.key) === name || columnMatchName(c.label ?? '') === name))
      : -1;
    if (existing >= 0 && !taken.has(columns[existing]!.key)) {
      kept.add(existing);
      taken.add(columns[existing]!.key);
      return { ...columns[existing]! };
    }
    return {
      key: pastedKey(header, i, taken),
      // A column's label renders on air: DataSet content, frozen English like a new source's name.
      label: header.trim() || `Column ${i + 1}`,
      // Typed from the first data row: a column that is text here sorts as text on air.
      type: /^-?[\d.,]+$/.test((firstRow[i] ?? '').trim()) ? 'number' : 'string',
    };
  });
  const out = body.map((cells) =>
    Object.fromEntries(next.map((col, c) => [col.key, cellValue(cells[c] ?? '', col.type)])),
  );
  return { columns: next, rows: out, ...none };
}
