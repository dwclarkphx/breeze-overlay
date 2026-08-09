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

import { applyTransforms, type CrawlLayer, type DataSet } from '@breeze/schema';

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
export function crawlItemsFrom(data: DataSet, layer: CrawlLayer): string[] {
  if (!layer.column) return layer.items;
  const column = layer.column;
  const shaped = applyTransforms(data, layer.transforms ?? []);
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
    if (this.staged !== null) {
      this.current = this.staged;
      this.staged = null;
      this.fill(this.trailing, this.current);
    }
    if (this.running) this.startPass();
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
    return true;
  }

  private startPass(): void {
    this.tween?.kill();
    this.tween = null;

    const { animator, track, direction } = this.opts;
    const speed = Math.max(1, Math.abs(this.opts.speed));

    if (direction === 'left') {
      /*
       * Reset first. The seam was showing the head of the second block; x=0
       * shows the head of the first, which is identical copy in the same place.
       * Only after that is the second block off screen and safe to rewrite.
       */
      animator.set(track, { x: 0 });
      this.stageQueued();

      const distance = this.measure(this.first);
      if (distance <= 0) return;
      this.tween = animator.to(track, {
        x: -distance,
        duration: distance / speed,
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

    if (this.stageQueued()) {
      distance = this.measure(this.first);
      animator.set(track, { x: -distance });
    }

    if (distance <= 0) return;
    this.tween = animator.to(track, {
      x: 0,
      duration: distance / speed,
      ease: 'none',
      onComplete: () => this.onPassComplete(),
    });
  }
}
