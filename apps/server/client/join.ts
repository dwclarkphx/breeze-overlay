// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Which output a page opened late should take up from (0.74.1).
 *
 * Pure and DOM-free: the output page uses it on every channel it joins, the
 * control panel uses `onAirSources` to fill its **Sync to** menu, and the server
 * tests run it without a browser.
 *
 * The choice is the page's `?sync=` value:
 *   - `auto` (absent) — the output that reported most recently, among those on
 *     air. With no output connected, what the channel last heard, so a panel
 *     whose only window is its own preview still picks up where it was.
 *   - `off` — never join; wait for the next command, as every page did before.
 *   - an output's page id (or socket id) — that output. If it has gone, back to
 *     `auto`; if it is there but off air, nothing, because following it means
 *     showing what it shows.
 */

/** The report fields a join reads — a subset of the hub's `PlaybackReport`. */
export interface PlaybackLike {
  state: string;
  time: number;
  step: number;
  tables?: Array<{
    table: string;
    page: number;
    pageCount?: number;
    held?: boolean;
    cycling?: boolean;
    hasCycle?: boolean;
    secondsLeft?: number | null;
    follows?: string;
  }>;
}

export interface SourceLike {
  id: string;
  page?: string;
  label: string;
  ip: string;
  connectedAt: number;
  playback: PlaybackLike | null;
  reportedAt: number | null;
}

export interface ChannelStateLike {
  playback?: PlaybackLike | null;
  reportedAt?: number | null;
  now?: number;
  sources?: SourceLike[];
}

export type JoinTarget = PlaybackLike & { ageMs: number };

export const SYNC_AUTO = 'auto';
export const SYNC_OFF = 'off';

const onAir = (p: PlaybackLike | null | undefined): p is PlaybackLike =>
  !!p && (p.state === 'holding' || p.state === 'playing-in');

/** Outputs worth following, oldest connection first; never this page's own sockets. */
export function onAirSources(state: ChannelStateLike, ownPage?: string): SourceLike[] {
  return (state.sources ?? []).filter(
    (s) => onAir(s.playback) && s.reportedAt !== null && (ownPage === undefined || s.page !== ownPage),
  );
}

/** What to join, or null to wait for the next command. */
export function joinTarget(state: ChannelStateLike, choice: string, ownPage?: string): JoinTarget | null {
  if (choice === SYNC_OFF) return null;
  const now = typeof state.now === 'number' ? state.now : Date.now();
  const target = (p: PlaybackLike, at: number): JoinTarget => ({ ...p, ageMs: Math.max(0, now - at) });

  if (choice !== SYNC_AUTO && choice !== '') {
    const chosen = (state.sources ?? []).find((s) => s.page === choice || s.id === choice);
    if (chosen) return onAir(chosen.playback) && chosen.reportedAt !== null ? target(chosen.playback, chosen.reportedAt) : null;
  }

  const candidates = onAirSources(state, ownPage);
  if (candidates.length) {
    const newest = candidates.reduce((a, b) => ((b.reportedAt ?? 0) > (a.reportedAt ?? 0) ? b : a));
    return target(newest.playback!, newest.reportedAt!);
  }

  // No output on air. A channel with outputs connected but none on air has
  // nothing to show; with none connected at all, the channel's own last word
  // (a preview's, see the hub) is the best answer there is.
  if ((state.sources ?? []).length === 0 && onAir(state.playback) && typeof state.reportedAt === 'number') {
    return target(state.playback, state.reportedAt);
  }
  return null;
}
