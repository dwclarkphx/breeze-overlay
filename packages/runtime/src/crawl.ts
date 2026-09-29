// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Ticker / crawl loop.
 *
 * A crawl is an endless rotation, and changing its headlines must not disturb
 * what is currently on screen. Two earlier attempts got this wrong in different
 * ways:
 *
 * 1. Replacing the text and restarting the tween from x=0 snapped the scroll
 *    position back mid flight — a visible jump the moment an operator added a
 *    line.
 * 2. Queueing the copy and swapping *both* blocks at the loop seam fixed the
 *    jump but not the rewrite. At the seam the viewport is showing the head of
 *    the second block, so rewriting both blocks there repaints live pixels: the
 *    new copy appeared in place instead of scrolling in. With an appended item
 *    the two blocks share a prefix and diverge only at the old repeat boundary,
 *    so what an operator saw was a few characters mutating mid-line — small
 *    enough to look like a rendering glitch rather than a swap.
 *
 * The rule that actually holds is narrower than "swap at the seam":
 *
 *   **Never write to a block that is on screen.**
 *
 * At x=0 the viewport shows the head of the first block, so the second is off
 * screen; at x=-w it shows the head of the second, so the first is off screen.
 * Adopting new copy therefore takes two passes. The block that scrolls in
 * during the next pass is rewritten at the *start* of that pass, so the new
 * copy enters by scrolling — the way a ticker is supposed to update. Its
 * counterpart is rewritten at the *end* of that pass, once it is off screen,
 * which leaves both blocks identical again so the position reset stays
 * invisible.
 *
 * The cost is that new headlines appear one rotation later than they were
 * typed. That is correct for a ticker: copy arrives when the loop comes round,
 * and nothing an operator does is ever visible as a repaint.
 *
 * A `$data` push from a feed goes through the same `setItems` and inherits the
 * same guarantee — which is the point of routing both through one call.
 */

import {
  applyTransforms,
  type CrawlLayer,
  type DataSet,
  type TransformContext,
} from '@breeze/schema';

export interface CrawlAnimator {
  to(target: unknown, vars: Record<string, unknown>): { kill(): void };
  set(target: unknown, vars: Record<string, unknown>): void;
}

export interface CrawlLoopOptions {
  /** Container whose width the content must at least fill. */
  viewport: HTMLElement;
  /** Element that is translated; holds the two content blocks. */
  track: HTMLElement;
  speed: number;
  direction: 'left' | 'right';
  separator: string;
  animator: CrawlAnimator;
  /**
   * Width of an element in layout pixels. Injected so the loop can be tested
   * without a layout engine — every headless DOM reports `offsetWidth` as 0,
   * which makes the loop correctly refuse to animate and therefore impossible
   * to exercise.
   */
  measure?: (el: HTMLElement) => number;
  /** Wall clock, epoch ms. Injected for tests; `Date.now` otherwise. */
  now?: () => number;
  /**
   * The copy on screen changed: new copy began scrolling in, or finished
   * doing so (0.75.0). An output page reports then, so a page joining late
   * takes up the copy that is actually showing.
   */
  onCopy?: () => void;
}

/**
 * Where a crawl is, in a form another output can take up (0.75.0).
 *
 * Time rather than pixels: a pass lasts `passMs` and this one is `offsetMs`
 * into it. Two outputs rendering the same copy in the same faces measure the
 * same width, so the same time is the same pixel — and a time, unlike a pixel
 * offset, can be aged by however old the report is.
 */
export interface CrawlPhase {
  /** The copy rotating in both blocks. */
  text: string;
  /** Copy written into the incoming block and scrolling in this pass, if any. */
  staged: string | null;
  offsetMs: number;
  passMs: number;
}

/** One pass of the item list, with a trailing separator so it joins its repeat. */
export function crawlBlockText(items: string[], separator: string): string {
  const cleaned = items.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return '';
  return cleaned.join(separator) + separator;
}

/**
 * One column of a DataSet as ticker items — the Wave-2 RSS-feeds-a-ticker path.
 *
 * Two decisions worth stating, both about what *not* to put on air:
 *
 *  - **Empty cells are dropped.** A crawl joins its items with a separator, so a
 *    blank item renders as "• •" — two bullets with nothing between them, which
 *    reads as a broken ticker rather than as a missing headline. Feeds carry
 *    untitled entries often enough for this to matter.
 *  - **An empty result falls back to the authored items.** Rule 1 of the data
 *    layer applied here: a dead feed never blanks a graphic. The server already
 *    retains last-good rows across an origin outage, but a feed that answers
 *    *successfully* with zero entries gets past that, and an empty crawl is a
 *    blank strip on screen.
 */
export function crawlItemsFrom(data: DataSet, layer: CrawlLayer, ctx: TransformContext = {}): string[] {
  if (!layer.column) return layer.items;
  const column = layer.column;
  const shaped = applyTransforms(data, layer.transforms ?? [], ctx);
  const items = shaped.rows
    .map((row) => {
      const value = row[column];
      return value === null || value === undefined ? '' : String(value).trim();
    })
    .filter(Boolean);
  return items.length > 0 ? items : layer.items;
}

/**
 * How many times a block must repeat to be at least as wide as the viewport.
 *
 * A single short headline otherwise loops in a blink, because the loop length
 * is the content length. Real tickers pad until the content spans the screen.
 */
export function repeatsToFill(blockWidth: number, viewportWidth: number): number {
  if (blockWidth <= 0 || viewportWidth <= 0) return 1;
  return Math.max(1, Math.ceil(viewportWidth / blockWidth));
}

export class CrawlLoop {
  private readonly opts: CrawlLoopOptions;
  private readonly first: HTMLElement;
  private readonly second: HTMLElement;

  /** Text currently rotating in both blocks. */
  private current = '';
  /** Text an operator has submitted, not yet written into any block. */
  private queued: string | null = null;
  /** Text written into the incoming block, awaiting adoption by the other. */
  private staged: string | null = null;

  private tween: { kill(): void } | null = null;
  private running = false;
  /**
   * When the current pass began, epoch ms, and how long it lasts.
   *
   * Each pass begins exactly where the last one was due to end, not whenever
   * its completion callback happened to run. A tween's `onComplete` lands on
   * the first frame after the pass ends, and starting the next from *that*
   * frame lost up to a frame per pass — invisible on one output, but two
   * outputs rolled in together drifted apart over a long show. Solved from the
   * clock, like a cycle's pages and a sprite's frames.
   */
  private passStart = 0;
  private passMs = 0;
  /** Set when a pass staged new copy; `startPass` signals it once the pass is placed. */
  private copyChanged = false;

  constructor(options: CrawlLoopOptions) {
    this.opts = options;

    const doc = options.track.ownerDocument;
    this.first = doc.createElement('span');
    this.second = doc.createElement('span');
    this.first.className = 'bz-crawl-block';
    this.second.className = 'bz-crawl-block';

    options.track.textContent = '';
    options.track.append(this.first, this.second);
  }

  /**
   * The block that scrolls into view during a pass, and so the one new copy is
   * written into. Leftward crawls run [first][second] and reveal the second;
   * rightward ones travel back through the first, revealing it from the left.
   */
  private get incoming(): HTMLElement {
    return this.opts.direction === 'left' ? this.second : this.first;
  }

  /** Its counterpart — off screen at the end of a pass, so safe to rewrite. */
  private get trailing(): HTMLElement {
    return this.opts.direction === 'left' ? this.first : this.second;
  }

  /** Replace the headlines. Takes effect by scrolling in, not by repainting. */
  setItems(items: string[]): void {
    const text = crawlBlockText(items, this.opts.separator);

    if (!this.current) {
      // Nothing rotating yet, so there is nothing on screen to protect.
      this.current = text;
      this.fill(this.first, text);
      this.fill(this.second, text);
      if (this.running) this.startPass();
      return;
    }

    // Ignore a submission that matches whatever is already lined up — including
    // copy still working its way in, or an operator re-sending the same text.
    const latest = this.queued ?? this.staged ?? this.current;
    if (text === latest) return;
    this.queued = text;
  }

  /** True while new copy is queued or part-way through being adopted. */
  get pendingItems(): boolean {
    return this.queued !== null || this.staged !== null;
  }

  /** The copy rotating in both blocks. New copy reaches this a pass later. */
  get currentText(): string {
    return this.current;
  }

  /** The copy written into the incoming block, if a swap is in flight. */
  get stagedText(): string | null {
    return this.staged;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.fill(this.first, this.current);
    this.fill(this.second, this.current);
    this.startPass();
  }

  /**
   * Start at another output's position — the late join (0.75.0).
   *
   * Takes that output's copy as well as its position, because a ticker adopts
   * new copy a pass late on purpose (see the header): an output mid-way through
   * adopting a feed change is showing the *old* copy, and a page joining it with
   * the new one would be right about the feed and wrong about the screen.
   * Copy this page already has beyond that stays queued, and scrolls in at the
   * next pass as it will on the other output.
   *
   * `ageMs` is how old the phase is. The pass is placed so it began
   * `offsetMs + ageMs` ago; where that runs past the end of a pass, whole
   * passes are skipped, as they would have been had this page been rotating.
   */
  startAt(phase: CrawlPhase, ageMs = 0): void {
    this.stop();
    this.running = true;
    const latest = this.queued ?? this.staged ?? this.current;
    this.current = phase.text;
    this.staged = phase.staged !== null && phase.staged !== phase.text ? phase.staged : null;
    this.fill(this.first, this.current);
    this.fill(this.second, this.current);
    if (this.staged !== null) this.fill(this.incoming, this.staged);
    const target = this.staged ?? this.current;
    this.queued = latest && latest !== target ? latest : null;
    this.startPass(this.now() - Math.max(0, phase.offsetMs) - Math.max(0, ageMs), { stage: false });
  }

  /** Where this crawl is now, or null when it is not rotating. */
  get phase(): CrawlPhase | null {
    if (!this.running || this.passMs <= 0) return null;
    return {
      text: this.current,
      staged: this.staged,
      offsetMs: Math.max(0, this.now() - this.passStart),
      passMs: this.passMs,
    };
  }

  stop(): void {
    this.running = false;
    this.tween?.kill();
    this.tween = null;
  }

  /** True while a pass is running. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Re-pad both blocks against current font metrics.
   *
   * Called when the real faces land: a block padded against fallback metrics is
   * repeated the wrong number of times, so it can fail to span the viewport and
   * show a gap at the seam.
   *
   * Deliberately a no-op while running. `startPass` re-measures the block on
   * every pass, so a rotating crawl corrects itself at the next seam — where the
   * viewport is parked on identical copy and the change cannot show. Rewriting
   * the blocks mid-pass is precisely the visible jump 0.29 fixed.
   */
  remeasure(): void {
    if (this.running || !this.current) return;
    this.fill(this.first, this.current);
    this.fill(this.second, this.current);
  }

  destroy(): void {
    this.stop();
    this.first.remove();
    this.second.remove();
  }

  /**
   * End of a pass. The viewport is showing the head of the block that just
   * scrolled in, so its counterpart is off screen and can take the new copy —
   * leaving the two identical again, which is what makes the position reset at
   * the start of the next pass invisible. Exposed for tests.
   */
  onPassComplete(): void {
    const adopted = this.staged !== null;
    if (adopted) {
      this.current = this.staged!;
      this.staged = null;
      this.fill(this.trailing, this.current);
    }
    // The next pass begins when this one was due to end — see `passStart`.
    if (this.running) this.startPass(this.passMs > 0 ? this.passStart + this.passMs : undefined);
    // After the next pass is placed, so a report made on this reads its phase.
    if (adopted) this.opts.onCopy?.();
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private measure(el: HTMLElement): number {
    return (this.opts.measure ?? ((e: HTMLElement) => e.offsetWidth))(el);
  }

  /** Write text into one block, padded out to at least the viewport width. */
  private fill(el: HTMLElement, text: string): void {
    const viewportWidth = this.measure(this.opts.viewport);
    el.textContent = text;
    const single = this.measure(el);
    el.textContent = text.repeat(repeatsToFill(single, viewportWidth));
  }

  /**
   * Move queued copy into the incoming block. Only ever called with that block
   * off screen. Returns whether anything was written, because rightward crawls
   * have to re-anchor afterwards.
   */
  private stageQueued(): boolean {
    if (this.queued === null) return false;
    this.staged = this.queued;
    this.queued = null;
    this.fill(this.incoming, this.staged);
    this.copyChanged = true;
    return true;
  }

  /**
   * Run one pass, begun at `begin` (epoch ms; now when absent).
   *
   * A pass begun in the past starts partway, at the position it would have
   * reached — a completion callback that ran a frame late, or a page joining
   * another output mid-pass. One begun more than a whole pass ago (a hidden tab
   * that drew no frames) skips the passes it missed rather than playing them
   * all out at once. Copy is staged only when `stage` allows it; a join has
   * already written the blocks it needs.
   */
  private startPass(begin?: number, opts: { stage?: boolean } = {}): void {
    this.copyChanged = false;
    this.placePass(begin, opts);
    if (this.copyChanged) {
      this.copyChanged = false;
      this.opts.onCopy?.();
    }
  }

  private placePass(begin?: number, opts: { stage?: boolean } = {}): void {
    this.tween?.kill();
    this.tween = null;

    const { animator, track, direction } = this.opts;
    const speed = Math.max(1, Math.abs(this.opts.speed));
    const stage = opts.stage !== false;
    const now = this.now();
    let start = begin ?? now;

    /** How far into the pass `start` puts us, in pixels, skipping whole passes missed. */
    const place = (distance: number): number => {
      this.passMs = (distance / speed) * 1000;
      let into = now - start;
      if (this.passMs > 0 && into >= this.passMs) {
        const skipped = Math.floor(into / this.passMs);
        start += skipped * this.passMs;
        into -= skipped * this.passMs;
      }
      this.passStart = start;
      return Math.min(distance, (Math.max(0, into) / 1000) * speed);
    };

    if (direction === 'left') {
      /*
       * Reset first. The seam was showing the head of the second block; x=0
       * shows the head of the first, which is identical copy in the same place.
       * Only after that is the second block off screen and safe to rewrite.
       */
      animator.set(track, { x: 0 });
      if (stage) this.stageQueued();

      const distance = this.measure(this.first);
      if (distance <= 0) return;
      // Partway when the pass began in the past: a late callback, or a join.
      const travelled = place(distance);
      if (travelled > 0) animator.set(track, { x: -travelled });
      this.tween = animator.to(track, {
        x: -distance,
        duration: (distance - travelled) / speed,
        ease: 'none',
        onComplete: () => this.onPassComplete(),
      });
      return;
    }

    /*
     * Rightward enters from the left, so the block that scrolls in is the first
     * one — the same block whose width sets the start offset. Rewriting it
     * moves the second block, so the offset has to be recomputed and reapplied.
     * Both happen while the viewport is parked on the second block's head,
     * which does not move and is not being written to, so neither step shows.
     */
    let distance = this.measure(this.first);
    animator.set(track, { x: -distance });

    if (stage && this.stageQueued()) {
      distance = this.measure(this.first);
      animator.set(track, { x: -distance });
    }

    if (distance <= 0) return;
    const travelled = place(distance);
    if (travelled > 0) animator.set(track, { x: -distance + travelled });
    this.tween = animator.to(track, {
      x: 0,
      duration: (distance - travelled) / speed,
      ease: 'none',
      onComplete: () => this.onPassComplete(),
    });
  }
}
