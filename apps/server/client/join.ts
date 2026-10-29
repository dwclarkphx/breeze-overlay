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
    key?: string | null;
  }>;
  /** Rotating tickers: copy and position. Absent from outputs older than 0.75.0. */
  crawls?: Array<{ layer: string; text: string; staged: string | null; offsetMs: number; passMs: number }>;
  /** Rolls (Wave R): extent and position per scroll. */
  scrolls?: Array<{ id: string; extent?: number; end?: 'hold' | 'loop' | 'continue'; start?: 'play' | 'operator'; travel: number; running: boolean; rate: number }>;
}

export interface SourceLike {
  id: string;
  page?: string;
  label: string;
  ip: string;
  /** `matte` for a key-signal page (`?matte=1`, Phase 9 Wave C); absent for a fill. */
  signal?: 'matte';
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

/**
 * How old the channel's playback report is, in seconds — by the hub's own
 * clock at both ends, so the viewer's clock being wrong does not matter.
 *
 * A report says a page has so many seconds left *as of when it was made*. The
 * hub replays its last report to every panel on each command, and since 0.75.0
 * does not relay a heartbeat that only aged, so the replayed one can be many
 * seconds old. Read as though it were made just now, it puts every countdown
 * back by however long the report had been sitting there. Zero when either
 * clock is missing, or when they disagree the wrong way round.
 */
export function reportAgeSeconds(state: { reportedAt?: number | null; now?: number } | null | undefined): number {
  if (!state || typeof state.now !== 'number' || typeof state.reportedAt !== 'number') return 0;
  const age = (state.now - state.reportedAt) / 1000;
  return Number.isFinite(age) && age > 0 ? age : 0;
}

export type JoinTarget = PlaybackLike & { ageMs: number };

export const SYNC_AUTO = 'auto';
export const SYNC_OFF = 'off';
/**
 * The control panel's third preview mode in cue → take (Phase 9 Wave A): the
 * frame has no socket and shows the panel's cued values, not air. Never sent
 * to an output page as `?sync=`; the panel turns it into `?hub=off`.
 */
export const SYNC_CUED = 'cued';

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

/* ------------------------------------------------------------ reports */

/** What `reportOf` reads — the runtime's public getters, so this stays DOM-free. */
export interface RuntimeLike {
  playbackState: string;
  currentTime: number;
  currentStep: number;
  stepCount: number;
  tableStates: Array<{
    table: string;
    page: number;
    pageCount: number;
    key: string | null;
    hasCycle: boolean;
    cycling: boolean;
    held: boolean;
    secondsLeft: number | null;
    group?: string;
    follows?: string;
  }>;
  crawlStates?: Array<{ layer: string; text: string; staged: string | null; offsetMs: number; passMs: number }>;
  /** Rolls (Wave R): each scroll's extent and position, for the hub's clamp and a panel's position bar. */
  scrollStates?: Array<{ id: string; extent?: number; end?: 'hold' | 'loop' | 'continue'; start?: 'play' | 'operator'; travel: number; running: boolean; rate: number }>;
}

/**
 * The playback report an output page sends the hub — built in one place so the
 * output page, and the panel checking its own preview against an output, build
 * the same thing.
 *
 * Only tables that page are listed: one that shows every row it has is nothing
 * a control surface can act on.
 */
export function reportOf(runtime: RuntimeLike): PlaybackLike & { stepCount: number } {
  const tables = runtime.tableStates
    .filter((s) => s.pageCount > 1 || s.cycling || s.held)
    .map((s) => ({
      table: s.table,
      page: s.page,
      pageCount: s.pageCount,
      key: s.key,
      hasCycle: s.hasCycle,
      cycling: s.cycling,
      held: s.held,
      secondsLeft: s.secondsLeft,
      ...(s.group ? { group: s.group } : {}),
      ...(s.follows ? { follows: s.follows } : {}),
    }));
  const crawls = runtime.crawlStates ?? [];
  const scrolls = runtime.scrollStates ?? [];
  return {
    state: runtime.playbackState,
    time: runtime.currentTime,
    step: runtime.currentStep,
    stepCount: runtime.stepCount,
    tables,
    ...(crawls.length ? { crawls } : {}),
    ...(scrolls.length ? { scrolls } : {}),
  };
}

/* ------------------------------------------------------------ checking */

/** Tolerances: how far apart two outputs may be and still read as in step. */
export const SYNC_TOLERANCE = {
  /** A page's time left, seconds. Reports round to a tenth; a frame or two of network either way. */
  pageSeconds: 0.6,
  /** A ticker's position, milliseconds of scroll. A quarter second at 100 px/s is 25 px. */
  crawlMs: 250,
} as const;

export type CheckKind = 'playback' | 'table' | 'crawl';

/** One side of a check — the fields that apply to its kind. The panel words it. */
export interface SyncSide {
  state?: string;
  step?: number;
  key?: string | null;
  page?: number;
  pageCount?: number;
  /** A table's time left, aged to the moment of the check. */
  secondsLeft?: number | null;
  /** A ticker's copy — what is scrolling in when copy is part-way in. */
  text?: string;
}

export interface SyncCheck {
  kind: CheckKind;
  /** The table's address or the ticker's layer id; empty for playback. */
  name: string;
  ok: boolean;
  output: SyncSide;
  /** Null when the preview has no such table or ticker. */
  preview: SyncSide | null;
  /** A ticker on the same copy: preview minus output, milliseconds of scroll. */
  driftMs?: number;
}

/** Signed difference a − b on a loop of `period`, in (−period/2, period/2]. */
function loopDelta(a: number, b: number, period: number): number {
  if (!(period > 0)) return a - b;
  let d = (a - b) % period;
  if (d > period / 2) d -= period;
  if (d <= -period / 2) d += period;
  return d;
}

/**
 * Is the preview showing what the output shows?
 *
 * `output` is that output's report and `ageMs` how old it is *now* — the hub's
 * `now - reportedAt` plus however long ago the panel fetched it — so its
 * seconds-left and its ticker offsets can be aged forward to the moment the
 * preview was read. Compared: playback state and step; each paged table's page
 * and time left; each ticker's copy and position. Items the output did not
 * report (an older renderer) are not checked rather than failed.
 */
export function compareReports(output: PlaybackLike, ageMs: number, preview: PlaybackLike): SyncCheck[] {
  const checks: SyncCheck[] = [];
  const age = Math.max(0, ageMs);

  checks.push({
    kind: 'playback',
    name: '',
    ok: output.state === preview.state && output.step === preview.step,
    output: { state: output.state, step: output.step },
    preview: { state: preview.state, step: preview.step },
  });

  const previewTables = new Map((preview.tables ?? []).map((t) => [t.table, t]));
  for (const t of output.tables ?? []) {
    const mine = previewTables.get(t.table);
    // Aged to now. A report old enough that its page has turned since says
    // nothing about which page the output is on: that output reports on every
    // turn, so a fresher report is on its way, and calling it a mismatch until
    // then would flash a false alarm at every turn.
    const left = typeof t.secondsLeft === 'number' ? t.secondsLeft - age / 1000 : null;
    const side = (x: typeof t, secondsLeft: number | null | undefined): SyncSide => ({
      key: x.key ?? null,
      page: x.page,
      ...(x.pageCount !== undefined ? { pageCount: x.pageCount } : {}),
      secondsLeft: typeof secondsLeft === 'number' && secondsLeft > 0 ? secondsLeft : null,
    });
    if (!mine) {
      checks.push({ kind: 'table', name: t.table, ok: false, output: side(t, left), preview: null });
      continue;
    }
    const turnedSince = left !== null && left <= 0;
    let ok = turnedSince || mine.page === t.page;
    if (!turnedSince && ok && left !== null && typeof mine.secondsLeft === 'number') {
      ok = Math.abs(left - mine.secondsLeft) <= SYNC_TOLERANCE.pageSeconds;
    }
    checks.push({ kind: 'table', name: t.table, ok, output: side(t, left), preview: side(mine, mine.secondsLeft) });
  }

  const previewCrawls = new Map((preview.crawls ?? []).map((c) => [c.layer, c]));
  for (const c of output.crawls ?? []) {
    const mine = previewCrawls.get(c.layer);
    const output: SyncSide = { text: c.staged ?? c.text };
    if (!mine) {
      checks.push({ kind: 'crawl', name: c.layer, ok: false, output, preview: null });
      continue;
    }
    const sameCopy = mine.text === c.text && mine.staged === c.staged;
    const driftMs = loopDelta(mine.offsetMs, c.offsetMs + age, c.passMs);
    checks.push({
      kind: 'crawl',
      name: c.layer,
      ok: sameCopy && Math.abs(driftMs) <= SYNC_TOLERANCE.crawlMs,
      output,
      preview: { text: mine.staged ?? mine.text },
      ...(sameCopy ? { driftMs } : {}),
    });
  }
  return checks;
}

/* ------------------------------------------------------------ key pairs */

/**
 * A matte output and the fill it keys (Phase 9 Wave C).
 *
 * A switcher keying fill + matte from two pages needs the two to be showing
 * the same moment of the same graphic; if the matte page reloaded and missed a
 * PLAY, the key cuts a hole where nothing is, or nothing where the strap is.
 * Both pages run the same runtime and late-join the same way, so they should
 * agree. This is what checks that they do.
 *
 * `fill` is null when a matte has nothing to pair with — worth saying, because
 * a key with no fill is a key cutting black into the programme.
 */
export interface KeyPair {
  matte: SourceLike;
  fill: SourceLike | null;
}

/**
 * Pair every matte output with a fill.
 *
 * A fill on the same machine first: the two browser sources keyed together sit
 * in one vMix or OBS, so they share an address. Failing that, any fill — two
 * machines feeding one switcher is unusual, not wrong. Among candidates, the
 * one that reported most recently, the same rule `joinTarget` uses for
 * "newest". Several mattes may share one fill.
 */
export function keyPairs(sources: SourceLike[]): KeyPair[] {
  const fills = sources.filter((s) => s.signal !== 'matte');
  const newest = (pool: SourceLike[]): SourceLike | null =>
    pool.reduce<SourceLike | null>((a, b) => (!a || (b.reportedAt ?? -1) > (a.reportedAt ?? -1) ? b : a), null);
  return sources
    .filter((s) => s.signal === 'matte')
    .map((matte) => {
      const sameMachine = fills.filter((f) => f.ip === matte.ip);
      return { matte, fill: newest(sameMachine.length ? sameMachine : fills) };
    });
}

/** One row of a key-pair check: the same row as `SyncCheck`, with its sides named for what they are. */
export interface KeyPairCheck {
  kind: CheckKind;
  name: string;
  ok: boolean;
  fill: SyncSide | null;
  matte: SyncSide | null;
  /** A ticker on the same copy: matte minus fill, milliseconds of scroll. */
  driftMs?: number;
}

/**
 * Are a fill and its matte showing the same thing?
 *
 * Two reports made at different moments, so the older one is aged to the
 * newer one's moment — by the hub's clock at both ends — and compared with
 * `compareReports`, the same rules and tolerances as preview against output.
 * Null when either has not reported yet: nothing to compare is not a mismatch.
 */
export function compareKeyPair(
  fill: SourceLike,
  matte: SourceLike,
): { ok: boolean; apartMs: number; checks: KeyPairCheck[] } | null {
  if (!fill.playback || !matte.playback || fill.reportedAt === null || matte.reportedAt === null) return null;
  const apartMs = Math.abs(fill.reportedAt - matte.reportedAt);
  const fillOlder = fill.reportedAt <= matte.reportedAt;
  const raw = fillOlder
    ? compareReports(fill.playback, apartMs, matte.playback)
    : compareReports(matte.playback, apartMs, fill.playback);
  const checks = raw.map((c): KeyPairCheck => ({
    kind: c.kind,
    name: c.name,
    ok: c.ok,
    fill: fillOlder ? c.output : c.preview,
    matte: fillOlder ? c.preview : c.output,
    // `driftMs` is always the newer side minus the older.
    ...(typeof c.driftMs === 'number' ? { driftMs: fillOlder ? c.driftMs : -c.driftMs } : {}),
  }));
  return { ok: checks.every((c) => c.ok), apartMs, checks };
}
