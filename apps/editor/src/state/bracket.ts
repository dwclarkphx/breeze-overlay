// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Bracket rules for the manual-table grid.
 *
 * Extracted from the panel because these are the two decisions worth being sure
 * about — is this a bracket, and is this cell one the operator owns — and a
 * decision buried in a component is a decision nobody tests.
 */

import { ADVANCE_DEFAULTS, type AdvanceTransform, type DataColumn, type DataRow } from '@breeze/schema';

/**
 * Is this manual table a bracket?
 *
 * A `slot` and a `round` column, nothing cleverer. Guessing harder would mean
 * every standings table in the project sprouting a bracket control, and the
 * cost of a miss (rename a column) is far below the cost of a false positive.
 */
export function isBracketTable(columns: DataColumn[]): boolean {
  const keys = new Set(columns.map((c) => c.key));
  return keys.has(ADVANCE_DEFAULTS.slot) && keys.has(ADVANCE_DEFAULTS.round);
}

/**
 * The transform the grid previews with: the defaults, plus whichever score
 * columns happen to exist.
 *
 * This is a preview of the shape, not a second place to configure it. The real
 * `advance` lives on the table layer that consumes the source — putting a
 * second copy here would give an operator two answers to the same question.
 */
export function previewAdvance(columns: DataColumn[]): AdvanceTransform | null {
  if (!isBracketTable(columns)) return null;
  const keys = new Set(columns.map((c) => c.key));
  const t: AdvanceTransform = { op: 'advance' };
  if (keys.has('homeScore') && keys.has('awayScore')) {
    t.scores = { home: 'homeScore', away: 'awayScore' };
    if (keys.has('homePens') && keys.has('awayPens')) {
      t.scores.shootout = { home: 'homePens', away: 'awayPens' };
    }
  }
  return t;
}

/** The round an operator seeds by hand — the first one that appears. */
export function firstRound(rows: DataRow[]): string {
  const found = rows.find((r) => {
    const v = r[ADVANCE_DEFAULTS.round];
    return v !== null && v !== undefined && String(v).trim() !== '';
  });
  return found ? String(found[ADVANCE_DEFAULTS.round]) : '';
}

/** Columns `advance` writes, given the defaults the preview uses. */
export function carriedColumns(): Set<string> {
  const out = new Set<string>();
  for (const f of ADVANCE_DEFAULTS.fields) {
    out.add(`home${f}`);
    out.add(`away${f}`);
  }
  return out;
}

/**
 * Would `advance` write this cell?
 *
 * If so the operator must not be able to type into it. We have made this
 * mistake once already — a binding on a fetched source let PLAY push an
 * authored snapshot over live data — and a resolved bracket slot is the same
 * shape: something downstream owns the value, so an edit that appears to stick
 * and then vanishes is worse than a field that refuses the keystroke.
 */
export function isFedCell(row: DataRow, key: string, seedRound: string, carried: Set<string>): boolean {
  if (!carried.has(key)) return false;
  return String(row[ADVANCE_DEFAULTS.round] ?? '') !== seedRound;
}
