// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Polls (Phase 9 Wave R, CHARTS.md §5).
 *
 * A poll source is the question, its options and the tally, kept in the
 * project. Votes come from the operator (the panel, REST, Companion) or the
 * poll is a feed laid out by the Poll template; the audience never votes
 * here (decided 2026-10-26). Either way a graphic reads one shape of row, so
 * a lower-third poll and a full-screen results board are interchangeable.
 *
 * Pure: the server's route, the panel and the tests share it.
 */

import {
  POLL_OPTION_ID_PATTERN,
  largestRemainder,
  numericValue,
  type DataColumn,
  type DataRow,
  type DataSet,
  type PollDataSource,
  type PollStatus,
} from './data.js';

/** The columns every poll row carries, in this order. */
export const POLL_COLUMNS: DataColumn[] = [
  { key: 'option', type: 'string' },
  { key: 'label', type: 'string' },
  { key: 'votes', type: 'number' },
  { key: 'percent', label: '%', type: 'number' },
  { key: 'share', type: 'number' },
  { key: 'rank', label: '#', type: 'number' },
  { key: 'leader', type: 'boolean' },
  { key: 'color', type: 'string' },
  { key: 'image', type: 'string' },
  { key: 'question', type: 'string' },
  { key: 'total', type: 'number' },
  { key: 'status', type: 'string' },
];

/**
 * Columns a poll feed must and may carry — the Poll template's format guide
 * (CHARTS.md §5.2). A `share` transform then adds `percent`, and `rank` the
 * rest, so one graphic serves an operator's poll and a fed one.
 */
export const POLL_FEED_COLUMNS: Array<DataColumn & { required: boolean; example: string }> = [
  { key: 'label', type: 'string', required: true, example: 'Yes' },
  { key: 'votes', type: 'number', required: true, example: '42' },
  { key: 'color', type: 'string', required: false, example: '#2E7D32' },
  { key: 'image', type: 'string', required: false, example: 'assets/yes.png' },
];

/** Votes as a whole, non-negative number; anything else counts as 0. */
function count(value: unknown): number {
  const n = numericValue(typeof value === 'number' || typeof value === 'string' ? value : null);
  return n === null || n < 0 ? 0 : Math.floor(n);
}

/**
 * Competition ranking: equal votes share a rank and the next rank skips
 * (1, 1, 3) — the way a results board reads a tie.
 */
export function competitionRanks(values: readonly number[]): number[] {
  return values.map((v) => 1 + values.filter((o) => o > v).length);
}

/** A poll's rows, in authored option order. */
export function pollDataSet(def: PollDataSource): DataSet {
  const votes = def.options.map((o) => count(def.votes?.[o.id]));
  const total = votes.reduce((a, b) => a + b, 0);
  const percents = largestRemainder(votes, 100, 0);
  const ranks = competitionRanks(votes);
  const top = Math.max(0, ...votes);
  const status: PollStatus = def.status ?? 'open';
  const rows: DataRow[] = def.options.map((o, i) => ({
    option: o.id,
    label: o.label,
    votes: votes[i]!,
    percent: percents[i]!,
    share: total > 0 ? votes[i]! / total : 0,
    rank: ranks[i]!,
    // Nobody leads a poll with no votes; everybody tied on top leads one that has some.
    leader: top > 0 && votes[i] === top,
    color: o.color ?? '',
    image: o.image ?? '',
    question: def.question,
    total,
    status,
  }));
  return { id: def.id, columns: POLL_COLUMNS, rows };
}

export const POLL_ACTIONS = ['vote', 'set', 'open', 'close', 'reset'] as const;
export type PollActionType = (typeof POLL_ACTIONS)[number];

export type PollAction =
  | { type: 'vote'; option: string; delta?: number }
  | { type: 'set'; option: string; value: number }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'reset' };

/** Why an action cannot apply to this poll — an i18n error code — or null. */
export function pollActionProblem(def: PollDataSource, action: PollAction): string | null {
  if (action.type === 'vote' || action.type === 'set') {
    if (!def.options.some((o) => o.id === action.option)) return 'error.pollOption';
    const n = action.type === 'vote' ? (action.delta ?? 1) : action.value;
    if (!Number.isFinite(n) || !Number.isInteger(n)) return 'error.pollValue';
    if (action.type === 'set' && n < 0) return 'error.pollValue';
  }
  return null;
}

/**
 * Apply an action, returning the new definition. A vote never takes a count
 * below zero — a −1 on an option with none is a mis-tap, not a debt.
 *
 * Votes still count while the poll is closed: closing it is what the graphic
 * shows ("FINAL"), and an operator correcting the count after the close must
 * be able to.
 */
export function applyPollAction(def: PollDataSource, action: PollAction): PollDataSource {
  const votes = { ...(def.votes ?? {}) };
  switch (action.type) {
    case 'vote':
      votes[action.option] = Math.max(0, count(votes[action.option]) + (action.delta ?? 1));
      return { ...def, votes };
    case 'set':
      votes[action.option] = Math.max(0, Math.floor(action.value));
      return { ...def, votes };
    case 'open':
      return { ...def, status: 'open' };
    case 'close':
      return { ...def, status: 'closed' };
    case 'reset': {
      const { votes: _gone, ...rest } = def;
      return { ...rest, status: 'open' };
    }
  }
}

/** Problems with a poll definition that JSON Schema cannot state. */
export function pollDefProblems(def: PollDataSource): Array<{ path: string; message: string }> {
  const out: Array<{ path: string; message: string }> = [];
  const seen = new Set<string>();
  def.options.forEach((o, i) => {
    if (!POLL_OPTION_ID_PATTERN.test(o.id)) {
      out.push({ path: `options/${i}/id`, message: `option id "${o.id}" — letters, digits, - and _ only, up to 32` });
    }
    if (seen.has(o.id)) out.push({ path: `options/${i}/id`, message: `duplicate option id "${o.id}"` });
    seen.add(o.id);
  });
  for (const id of Object.keys(def.votes ?? {})) {
    if (!seen.has(id)) out.push({ path: `votes/${id}`, message: `votes for "${id}", which is not an option` });
  }
  return out;
}
