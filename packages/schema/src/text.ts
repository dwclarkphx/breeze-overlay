// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Long text as rows (Phase 9 Wave R, ROLLS.md §3).
 *
 * Lyrics, credits, a statement: one body of text, split into the rows a roll
 * scrolls, a table pages or a crawl rotates. Three markup rules, kept to three
 * so they can be printed under the text box and remembered:
 *
 *   `# Directed by`       a heading
 *   `Camera | Dave Clark` a pair (a tab between the two works too)
 *   a blank line          a gap — a verse break in `stanzas` mode
 *
 * Anything else is a plain line. `\#` at the start of a line is a literal `#`,
 * and with `markup: false` nothing is read at all — for lyrics that really do
 * start with a hash. A `|` with no spaces round it is text (`AC|DC`), so a
 * pipe in a name does not split it.
 *
 * Pure, so the server adapter, the editor's preview and the tests share it.
 */

import {
  TEXT_BODY_MAX_BYTES,
  TEXT_COLUMNS,
  TEXT_ROWS_MAX,
  type DataRow,
  type DataSet,
  type TextKind,
  type TextSplit,
} from './data.js';

export interface TextParseOptions {
  /** Default `lines`. */
  split?: TextSplit;
  /** Default true. */
  markup?: boolean;
}

/** UTF-8 length of a string, without a TextEncoder (not every host the schema runs in has one). */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      // A surrogate pair is one four-byte character.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Why a body cannot be a text source, or null when it can. */
export function textBodyProblem(body: string): string | null {
  const bytes = utf8Bytes(body);
  if (bytes > TEXT_BODY_MAX_BYTES) {
    return `text is ${Math.ceil(bytes / 1024)} KB — the limit is ${TEXT_BODY_MAX_BYTES / 1024} KB`;
  }
  return null;
}

interface Line {
  kind: Exclude<TextKind, 'gap'>;
  text: string;
  left: string;
  right: string;
}

const HEADING = /^#{1,6}\s+(.*)$/;
const PAIR = /\t| \| /;

/** One non-blank line, read through the markup. */
export function readTextLine(raw: string, markup = true): Line {
  const line = raw.trim();
  if (!markup) return { kind: 'line', text: line, left: '', right: '' };
  if (line.startsWith('\\#')) return { kind: 'line', text: line.slice(1), left: '', right: '' };
  const heading = HEADING.exec(line);
  if (heading) return { kind: 'heading', text: heading[1]!.trim(), left: '', right: '' };
  const at = raw.search(PAIR);
  if (at > 0) {
    const sep = raw[at] === '\t' ? 1 : 3;
    const left = raw.slice(0, at).trim();
    const right = raw.slice(at + sep).trim();
    if (left && right) return { kind: 'pair', text: `${left} ${right}`, left, right };
  }
  return { kind: 'line', text: line, left: '', right: '' };
}

/** Normalise line endings and drop a byte-order mark. */
export function normaliseText(body: string): string {
  return body.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * Split a body into rows.
 *
 * Leading and trailing blank lines are dropped and a run of blank lines is one
 * gap: a roll should not scroll a screenful of nothing because someone pressed
 * Enter four times. Throws when the body or the row count is over the limit —
 * named, rather than truncated, because a credits roll that silently stops at
 * the 5,000th name is worse than one that will not load.
 */
export function parseTextBody(id: string, body: string, opts: TextParseOptions = {}): DataSet {
  const problem = textBodyProblem(body);
  if (problem) throw new Error(problem);
  const markup = opts.markup !== false;
  const lines = normaliseText(body).split('\n');

  // Blocks of consecutive non-blank lines.
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const raw of lines) {
    if (raw.trim() === '') {
      if (current.length) blocks.push(current);
      current = [];
    } else {
      current.push(raw);
    }
  }
  if (current.length) blocks.push(current);

  const rows: DataRow[] = [];
  let n = 0;
  const push = (row: DataRow): void => {
    if (rows.length >= TEXT_ROWS_MAX) {
      throw new Error(`text makes more than ${TEXT_ROWS_MAX} rows — split it into two sources`);
    }
    rows.push(row);
  };

  blocks.forEach((block, b) => {
    const section = b + 1;
    if (opts.split === 'stanzas') {
      const read = block.map((raw) => readTextLine(raw, markup));
      n += 1;
      const kind: TextKind = read.length === 1 ? read[0]!.kind : 'line';
      push({
        n,
        section,
        kind,
        text: read.map((l) => l.text).join('\n'),
        left: read.length === 1 ? read[0]!.left : '',
        right: read.length === 1 ? read[0]!.right : '',
      });
      return;
    }
    if (b > 0) push({ n: null, section, kind: 'gap', text: '', left: '', right: '' });
    for (const raw of block) {
      const line = readTextLine(raw, markup);
      n += 1;
      push({ n, section, kind: line.kind, text: line.text, left: line.left, right: line.right });
    }
  });

  return { id, columns: TEXT_COLUMNS, rows };
}
