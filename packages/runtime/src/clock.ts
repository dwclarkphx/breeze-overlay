// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Wall-clock text, ticked locally.
 *
 * Two things live here: a token formatter, and a shared ticker that drives
 * every clock layer in one runtime off a single timer.
 *
 * **Why the formatter goes through Intl rather than Date arithmetic.** Getting
 * `America/Phoenix` from a `Date` by hand means knowing that Arizona does not
 * observe DST, that the Navajo Nation inside it does, and that both facts are
 * revisions of a database rather than constants. `Intl.DateTimeFormat` already
 * holds that database and the host keeps it current. So the formatter asks Intl
 * for the *parts* in the target zone and only does the string assembly itself —
 * the part nothing else can do, because no locale in Intl produces exactly the
 * layout a designer typed.
 *
 * **Why the ticker is shared.** One `setInterval` per runtime, not per layer.
 * A bug with a clock and a date is two layers; a rundown with eight graphics
 * loaded is sixteen timers, all firing at slightly different offsets, each one
 * capable of forcing a layout. One timer, one pass, one refit.
 */

import { CLOCK_TOKENS, type ClockToken, type TextClock } from '@breeze/schema';

/* --------------------------------------------------------------- formatter */

/**
 * The Intl parts we need, extracted once per format call.
 *
 * `hour12: true` is requested separately from the 24-hour read because a single
 * formatter cannot give both, and a format string may legitimately want `HH`
 * and `A` together (a 24-hour clock that still says AM is unusual, but a
 * date-and-time strap mixing `HH:mm` with `ddd` is not, and the cost of asking
 * twice is one cached formatter).
 */
interface ClockParts {
  H: string;   // 00-23
  h: string;   // 1-12
  m: string;   // 00-59
  s: string;   // 00-59
  A: string;   // AM / PM
  D: string;   // 1-31
  M: string;   // 1-12
  MMM: string; // Jan
  MMMM: string;// January
  ddd: string; // Mon
  dddd: string;// Monday
  YYYY: string;// 2026
}

/**
 * Formatters are expensive to construct and are rebuilt every tick otherwise.
 * Keyed by zone; the option sets are fixed, so two per zone is the whole cache.
 */
const numericCache = new Map<string, Intl.DateTimeFormat>();
const nameCache = new Map<string, Intl.DateTimeFormat>();
const shortCache = new Map<string, Intl.DateTimeFormat>();

function numericFormatter(locale: string, timeZone: string | undefined): Intl.DateTimeFormat {
  const key = `${locale}\u0000${timeZone ?? ''}`;
  let f = numericCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, {
      ...(timeZone ? { timeZone } : {}),
      hour12: true,
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
    });
    numericCache.set(key, f);
  }
  return f;
}

function nameFormatter(locale: string, timeZone: string | undefined): Intl.DateTimeFormat {
  const key = `${locale}\u0000${timeZone ?? ''}`;
  let f = nameCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, {
      ...(timeZone ? { timeZone } : {}),
      hour12: false,
      hour: '2-digit',
      weekday: 'long',
      month: 'long',
    });
    nameCache.set(key, f);
  }
  return f;
}

/**
 * The abbreviated weekday and month, asked for rather than derived.
 *
 * `ddd` and `MMM` used to be the long name sliced to three characters, which
 * is an English rule wearing a general disguise: it happens to give `Mon` and
 * `Aug`, and it gives German `Mon` where the abbreviation is `Mo`, Japanese
 * `月曜日` where nothing was abbreviated at all, and Arabic `الا`. Invisible
 * while the formatter was pinned to `en-US`; wrong the moment a graphic could
 * choose its own language. `Intl` already knows every one of these.
 */
function shortFormatter(locale: string, timeZone: string | undefined): Intl.DateTimeFormat {
  const key = `${locale}\u0000${timeZone ?? ''}`;
  let f = shortCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, {
      ...(timeZone ? { timeZone } : {}),
      weekday: 'short',
      month: 'short',
    });
    shortCache.set(key, f);
  }
  return f;
}

function partsOf(date: Date, locale: string, timeZone: string | undefined): ClockParts {
  const numeric = new Map<string, string>();
  for (const p of numericFormatter(locale, timeZone).formatToParts(date)) numeric.set(p.type, p.value);

  const named = new Map<string, string>();
  for (const p of nameFormatter(locale, timeZone).formatToParts(date)) named.set(p.type, p.value);

  const short = new Map<string, string>();
  for (const p of shortFormatter(locale, timeZone).formatToParts(date)) short.set(p.type, p.value);

  const h12 = numeric.get('hour') ?? '12';
  /*
   * `hour12: false` gives 00-23 in every modern engine, but historically some
   * returned 24 for midnight. Normalized here rather than trusted.
   */
  const h24raw = Number(named.get('hour') ?? '0');
  const h24 = h24raw === 24 ? 0 : h24raw;

  const monthLong = named.get('month') ?? '';

  return {
    H: String(h24).padStart(2, '0'),
    h: h12,
    m: numeric.get('minute') ?? '00',
    s: numeric.get('second') ?? '00',
    A: (numeric.get('dayPeriod') ?? 'AM').toUpperCase().replace(/\./g, ''),
    D: numeric.get('day') ?? '1',
    M: numeric.get('month') ?? '1',
    MMM: short.get('month') ?? monthLong.slice(0, 3),
    MMMM: monthLong,
    ddd: short.get('weekday') ?? (named.get('weekday') ?? '').slice(0, 3),
    dddd: named.get('weekday') ?? '',
    YYYY: numeric.get('year') ?? '',
  };
}

/** Token → the string it expands to, given the resolved parts. */
const EXPANDERS: Record<ClockToken, (p: ClockParts) => string> = {
  YYYY: (p) => p.YYYY,
  YY: (p) => p.YYYY.slice(-2),
  MMMM: (p) => p.MMMM,
  MMM: (p) => p.MMM,
  MM: (p) => p.M.padStart(2, '0'),
  M: (p) => p.M,
  dddd: (p) => p.dddd,
  ddd: (p) => p.ddd,
  DD: (p) => p.D.padStart(2, '0'),
  D: (p) => p.D,
  HH: (p) => p.H,
  H: (p) => String(Number(p.H)),
  hh: (p) => p.h.padStart(2, '0'),
  h: (p) => p.h,
  mm: (p) => p.m,
  m: (p) => String(Number(p.m)),
  ss: (p) => p.s,
  s: (p) => String(Number(p.s)),
  A: (p) => p.A,
  a: (p) => p.A.toLowerCase(),
};

/**
 * Characters between tokens are copied through, so `h:mm A` keeps its colon and
 * its space. Square brackets escape a literal that would otherwise tokenise —
 * `[Day] D` is the only way to get a capital D on screen next to a day number.
 */
export function formatClock(date: Date, clock: TextClock): string {
  /*
   * `en-US` when the graphic does not say otherwise, which is what every clock
   * rendered before `locale` existed. Deliberately *not* the server's
   * BREEZE_LOCALE — see TextClock.locale and I18N.md §5.3: the language on air
   * belongs to the graphic, not to whoever is looking at the editor.
   */
  const parts = partsOf(date, clock.locale ?? 'en-US', clock.timezone);
  const format = clock.format;
  let out = '';
  let i = 0;

  outer: while (i < format.length) {
    if (format[i] === '[') {
      const end = format.indexOf(']', i + 1);
      if (end !== -1) {
        out += format.slice(i + 1, end);
        i = end + 1;
        continue;
      }
    }
    // CLOCK_TOKENS is ordered longest-first, so `mm` is matched before `m`.
    for (const token of CLOCK_TOKENS) {
      if (format.startsWith(token, i)) {
        out += EXPANDERS[token](parts);
        i += token.length;
        continue outer;
      }
    }
    out += format[i];
    i += 1;
  }

  return out;
}

/**
 * How often a format needs to be re-rendered.
 *
 * A clock showing `h:mm A` changes 24 times a day at the minute boundary, so
 * waking every second to write the identical string is 59 wasted comparisons a
 * minute on a machine that is also compositing video. The tick still runs at
 * 1s when seconds are shown, and drops to 5s otherwise — not 60s, because the
 * tick is not aligned to the minute boundary and a 60s period would show a
 * minute change up to a minute late.
 */
export function tickIntervalFor(clock: TextClock): number {
  if (clock.tickSeconds !== undefined) return Math.max(0.05, clock.tickSeconds) * 1000;
  return /(^|[^[])s/.test(clock.format.replace(/\[[^\]]*\]/g, '')) ? 1000 : 5000;
}

/* ------------------------------------------------------------------ ticker */

export interface ClockTarget {
  /** Element whose textContent carries the time. */
  write: (text: string) => void;
  clock: TextClock;
}

/**
 * Drives every clock layer in one runtime off one timer.
 *
 * `onChange` fires only when at least one target actually produced new text.
 * The runtime uses it to re-run Fit Width — which forces a synchronous layout,
 * so firing it every second regardless would be the expensive part of an
 * otherwise free feature. `12:59` → `1:00` genuinely does change width, which
 * is why the refit cannot simply be skipped.
 *
 * **`once` writes the time and never starts a timer.** A still is one paused
 * frame, and a frame does not need a clock — but it does need the *right* time
 * on it. That distinction is why this is a mode rather than "skip clocks in a
 * still": freezing the layer outright would leave the authored placeholder on
 * screen, and `PLACEHOLDER` in a thumbnail is worse than a time a few minutes
 * stale. `add()` already writes immediately, so the only thing `once` removes
 * is the interval. Twenty clock thumbnails were twenty timers, each capable of
 * forcing a layout in a panel that is not even animating.
 */
export class ClockTicker {
  private targets = new Map<string, ClockTarget>();
  private last = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private period = 0;

  constructor(
    private readonly onChange: () => void,
    /** Injected for tests; defaults to the real clock. */
    private readonly now: () => Date = () => new Date(),
    /**
     * Write on `add()` and on an explicit `tick()`, but never on a timer.
     *
     * `tick()` stays callable deliberately: a cached thumbnail that is being
     * refreshed wants a new time without also wanting a subscription to every
     * second between now and whenever the panel unmounts.
     */
    private readonly once = false,
  ) {}

  add(id: string, target: ClockTarget): void {
    this.targets.set(id, target);
    this.writeOne(id, target);
    this.restart();
  }

  remove(id: string): void {
    this.targets.delete(id);
    this.last.delete(id);
    this.restart();
  }

  get size(): number {
    return this.targets.size;
  }

  /** Render every target now. Returns true if any text changed. */
  tick(): boolean {
    let changed = false;
    for (const [id, target] of this.targets) {
      if (this.writeOne(id, target)) changed = true;
    }
    return changed;
  }

  private writeOne(id: string, target: ClockTarget): boolean {
    const text = formatClock(this.now(), target.clock);
    if (this.last.get(id) === text) return false;
    this.last.set(id, text);
    target.write(text);
    return true;
  }

  /**
   * One interval at the finest period any target needs.
   *
   * Restarted rather than adjusted, because the alternative — a timer per
   * distinct period — reintroduces the drift between them that having one timer
   * exists to avoid.
   */
  private restart(): void {
    // A tick-once ticker has no period to compute and nothing to restart. Kept
    // here rather than at every `add`/`remove` call site so there is exactly one
    // place a timer can be created, and one guard in front of it.
    if (this.once) return;

    const wanted = this.targets.size
      ? Math.min(...[...this.targets.values()].map((t) => tickIntervalFor(t.clock)))
      : 0;

    if (wanted === this.period && this.timer) return;
    this.stop();
    this.period = wanted;
    if (!wanted) return;

    this.timer = setInterval(() => {
      if (this.tick()) this.onChange();
    }, wanted);
    // Node only: never hold the process open for a clock. No-op in browsers.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  destroy(): void {
    this.stop();
    this.targets.clear();
    this.last.clear();
  }
}
