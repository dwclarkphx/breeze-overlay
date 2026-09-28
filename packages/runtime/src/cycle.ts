// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Cycle — which page a self-paging table should be showing, and until when.
 *
 * Pure arithmetic over an anchor, no DOM and no timers, so the part of the
 * feature that decides what is on air can be tested without either.
 *
 * **The page is solved, not counted.** A cycle remembers one fact — "page N
 * started at instant T" — and every question after that is answered by walking
 * page durations forward from it. That is the sprite layer's rule for frames
 * and it is here for the same reasons: a timer that fires late lands on the
 * right page instead of one behind; a tab that was throttled in the background
 * catches up in one step instead of replaying every page it missed; and two
 * outputs given the same anchor agree by construction.
 */

import type { DataRow, TableCycle, TableCycleEnd } from '@breeze/schema';

/** Where a cycle is counted from. `at` is epoch milliseconds. */
export interface CycleAnchor {
  page: number;
  at: number;
}

export interface CyclePosition {
  /** Page that should be on screen at `now`. */
  page: number;
  /** Epoch ms of the next turn, or null when nothing more will happen. */
  nextAt: number | null;
  /** A `hold` or `continue` cycle that has shown its last page in full. */
  done: boolean;
}

/**
 * Shortest page a cycle will show, in seconds.
 *
 * A zero or garbage duration in a feed must not turn a table into a strobe —
 * or, with a timer re-arming itself at 0 ms, into a busy loop on the playout
 * machine. Half a second is shorter than anything anyone means and long
 * enough to be harmless.
 */
export const MIN_PAGE_SECONDS = 0.5;

/** A cycle that will actually turn pages: present, with a positive dwell. */
export function cycleEnabled(cycle: TableCycle | undefined): cycle is TableCycle {
  return !!cycle && Number.isFinite(cycle.dwell) && cycle.dwell > 0;
}

function asSeconds(value: unknown, unit: 's' | 'ms'): number | null {
  const n =
    typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value)
    : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return unit === 'ms' ? n / 1000 : n;
}

/**
 * Seconds each page stays up.
 *
 * With a duration column, a page lasts as long as its longest row — a page is
 * one moment on air, and the row that needs the most time sets it. Rows with
 * no usable value fall back to the table's dwell rather than to zero.
 */
export function pageDurations(pages: DataRow[][], cycle: TableCycle): number[] {
  const fallback = Math.max(MIN_PAGE_SECONDS, cycle.dwell);
  const column = cycle.durationColumn;
  const unit = cycle.durationUnit ?? 's';
  return pages.map((rows) => {
    if (!column) return fallback;
    let longest: number | null = null;
    for (const row of rows) {
      const s = asSeconds(row[column], unit);
      if (s !== null && (longest === null || s > longest)) longest = s;
    }
    return Math.max(MIN_PAGE_SECONDS, longest ?? fallback);
  });
}

/**
 * The page on screen at `now`, walking forward from `anchor`.
 *
 * A `loop` skips whole cycles arithmetically before walking, so a graphic that
 * has held for a week costs the same to ask as one that held for a minute.
 * `hold` and `continue` stop on the last page; they are `done` once it has
 * had its full time, which is the moment a `continue` cycle hands the graphic
 * on to its next marker.
 *
 * `now` earlier than the anchor is treated as the anchor itself. Clocks do
 * step backwards (NTP, a VM resuming), and the right answer then is "still on
 * the anchored page", not a negative index.
 */
export function cyclePosition(
  durations: number[],
  anchor: CycleAnchor,
  now: number,
  end: TableCycleEnd = 'loop',
): CyclePosition {
  const count = durations.length;
  if (count === 0) return { page: 0, nextAt: null, done: false };

  const start = ((Math.floor(anchor.page) % count) + count) % count;
  if (count === 1) {
    // Nothing to turn to. A `continue` single page still has to leave once its
    // time is up, or a round-up with one page of results would never go.
    if (end === 'loop') return { page: 0, nextAt: null, done: false };
    const endsAt = anchor.at + durations[0]! * 1000;
    return now >= endsAt
      ? { page: 0, nextAt: null, done: true }
      : { page: 0, nextAt: endsAt, done: false };
  }

  let elapsed = Math.max(0, now - anchor.at);
  let at = anchor.at;

  if (end === 'loop') {
    const total = durations.reduce((sum, d) => sum + d * 1000, 0);
    const laps = Math.floor(elapsed / total);
    at += laps * total;
    elapsed -= laps * total;
  }

  let page = start;
  for (;;) {
    const endsAt = at + durations[page]! * 1000;
    if (now < endsAt) return { page, nextAt: endsAt, done: false };

    const last = page === count - 1;
    if (last && end !== 'loop') return { page, nextAt: null, done: true };

    at = endsAt;
    page = (page + 1) % count;
  }
}

/**
 * Normalise a page key for matching: trimmed, case-insensitive.
 *
 * An operator typing `c` on a Stream Deck button means Group C; making them
 * match the capitalisation of a feed they cannot see is a trap, not a rule.
 */
export function normalisePageKey(key: unknown): string {
  if (key === null || key === undefined) return '';
  return String(key).trim().toLowerCase();
}
