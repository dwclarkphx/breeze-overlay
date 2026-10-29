// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Rolls: long text scrolling under the operator's control (Phase 9 Wave R,
 * ROLLS.md).
 *
 * Two parts. `RollBlock` lays one roll's rows out in its track and says where
 * the track sits for a given travel. `RollSync` holds the hub's scroll state
 * for every roll in the graphic and moves them all, from one ticker that runs
 * only while something is moving — a paused credits roll costs nothing.
 *
 * **The position is solved, never accumulated.** Each frame works out where
 * the text is from the hub's anchor (`scrollTravel`) against the hub's clock,
 * the timer's rule (timer.ts). Two outputs agree; a browser source reloaded
 * mid-roll comes back on the right line; a frame that fires late lands where it
 * should rather than a frame behind.
 *
 * **Geometry.** Text moves toward the edge it *exits* by: up and left move the
 * track negative, down and right positive. `from: 'enter'` puts it just past
 * the edge it enters from; `top`, with its leading edge at the exit edge (the
 * first lines already showing). `to: 'exit'` runs until the trailing edge has
 * gone; `bottom`, until it reaches the entering edge (the last lines parked in
 * view). A loop renders the copy twice with `loopGap` between and wraps by one
 * copy's length, so the seam is never on screen.
 */

import {
  DEFAULT_CRAWL_SEPARATOR,
  TEXT_KINDS,
  applyTransforms,
  clampTravel,
  resolveScroll,
  scrollIdOf,
  scrollTravel,
  type DataRow,
  type DataSet,
  type RollLayer,
  type ScrollInfo,
  type ScrollReport,
  type ScrollState,
  type ScrollsPayload,
  type TextKind,
  type TextStyle,
  type TransformContext,
} from '@breeze/schema';

import { applyTextStyle } from './dom.js';

export interface RollAnimator {
  set(target: unknown, vars: Record<string, unknown>): void;
}

export interface RollTicker {
  add(fn: () => void): void;
  remove(fn: () => void): void;
}

/** One row as the roll draws it. */
export interface RollRowView {
  kind: TextKind;
  text: string;
  left: string;
  right: string;
}

const KINDS = new Set<string>(TEXT_KINDS);

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** The rows a roll shows: its source's (through its transforms), else its authored placeholder. */
export function rollRows(layer: RollLayer, source: DataSet | undefined, ctx: TransformContext = {}): DataRow[] {
  const base = source ?? (layer.data ? { id: layer.id, columns: layer.data.columns, rows: layer.data.rows } : undefined);
  if (!base) return [];
  return applyTransforms(base, layer.transforms ?? [], ctx).rows;
}

/**
 * Rows as views. A text source's `kind`, `left` and `right` columns are read
 * when present; any other source — a manual table, an RSS feed — is lines of
 * its `column`, so a roll can scroll anything with text in it.
 */
export function rollRowViews(rows: readonly DataRow[], layer: RollLayer): RollRowView[] {
  const column = layer.column ?? 'text';
  return rows.map((row) => {
    const raw = str(row['kind']);
    const kind = (KINDS.has(raw) ? raw : 'line') as TextKind;
    const left = str(row['left']);
    const right = str(row['right']);
    if (kind === 'pair' && left && right) return { kind, text: str(row[column]), left, right };
    return { kind: kind === 'pair' ? 'line' : kind, text: str(row[column]), left: '', right: '' };
  });
}

/** Up and left move the track toward negative; down and right toward positive. */
export function rollSign(layer: Pick<RollLayer, 'direction'>): -1 | 1 {
  return layer.direction === 'up' || layer.direction === 'left' ? -1 : 1;
}

export function rollVertical(layer: Pick<RollLayer, 'direction'>): boolean {
  return layer.direction === 'up' || layer.direction === 'down';
}

export interface RollGeometry {
  /** Track position at travel 0, px. */
  start: number;
  /** Track position at the end of travel, px (not used by a loop). */
  end: number;
  /** Px travelled from start to end, or one copy and its gap for a loop. */
  distance: number;
}

/**
 * Where the track starts and ends for a window `win` px long holding `content`
 * px of text — see the file header for the four cases. `fromOverride` lets a
 * still pose a roll that enters from off screen with its first lines showing.
 */
export function rollGeometry(
  layer: Pick<RollLayer, 'direction' | 'from' | 'to' | 'end' | 'loopGap'>,
  win: number,
  content: number,
  gap: number,
  fromOverride?: RollLayer['from'],
): RollGeometry {
  const m = rollSign(layer);
  const from = fromOverride ?? layer.from ?? 'enter';
  const to = layer.to ?? 'exit';
  const start = m < 0 ? (from === 'enter' ? win : 0) : from === 'enter' ? -content : win - content;
  if (layer.end === 'loop') return { start, end: start, distance: content + gap };
  const end = m < 0 ? (to === 'exit' ? -content : win - content) : to === 'exit' ? win : 0;
  return { start, end, distance: Math.max(0, m * (end - start)) };
}

export interface RollBlockOptions {
  layer: RollLayer;
  window: HTMLElement;
  track: HTMLElement;
  animator: RollAnimator;
  /** Content length along the travel, px. Injected for tests: a headless DOM measures 0. */
  measure?: (el: HTMLElement, vertical: boolean) => number;
}

/** One roll's rows, laid out, and its track placed for a given travel. */
export class RollBlock {
  readonly layer: RollLayer;
  private readonly opts: RollBlockOptions;
  private readonly doc: Document;
  private copies: HTMLElement[] = [];
  private content = 0;
  private signature = '';
  private lastPosition: number | null = null;

  constructor(options: RollBlockOptions) {
    this.opts = options;
    this.layer = options.layer;
    this.doc = options.track.ownerDocument;
    options.window.dataset['axis'] = rollVertical(options.layer) ? 'y' : 'x';
  }

  get id(): string {
    return scrollIdOf(this.layer);
  }

  private get vertical(): boolean {
    return rollVertical(this.layer);
  }

  private get windowLength(): number {
    const size = this.layer.size ?? { width: 0, height: 0 };
    return this.vertical ? size.height : size.width;
  }

  /** Px between the end of the text and its repeat, for a loop. */
  private get gap(): number {
    if (this.layer.loopGap !== undefined) return this.layer.loopGap;
    const style = this.layer.style;
    return this.vertical ? style.fontSize * (style.lineHeight ?? 1.15) : style.fontSize * 2;
  }

  /** Replace the rows. Returns true when the text on screen changed. */
  setRows(views: readonly RollRowView[]): boolean {
    const signature = JSON.stringify(views);
    if (signature === this.signature) return false;
    this.signature = signature;
    for (const copy of this.copies) copy.remove();
    this.copies = [];
    const count = this.layer.end === 'loop' ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const copy = this.buildCopy(views);
      if (i > 0) {
        if (this.vertical) copy.style.paddingTop = `${this.gap}px`;
        else copy.style.paddingLeft = `${this.gap}px`;
      }
      this.opts.track.appendChild(copy);
      this.copies.push(copy);
    }
    this.lastPosition = null;
    this.remeasure();
    return true;
  }

  private headingStyle(): TextStyle {
    const s = this.layer.style;
    return this.layer.headingStyle ?? { ...s, fontWeight: 700, fontSize: Math.round(s.fontSize * 1.25) };
  }

  private styled(tag: string, className: string, style: TextStyle, text: string): HTMLElement {
    const el = this.doc.createElement(tag);
    el.className = className;
    applyTextStyle(el, style);
    if (style.align) el.style.textAlign = style.align;
    el.textContent = text;
    return el;
  }

  private buildCopy(views: readonly RollRowView[]): HTMLElement {
    const copy = this.doc.createElement('div');
    copy.className = 'bz-roll-copy';
    const layer = this.layer;
    const spacing = layer.spacing ?? 0;
    const lineHeight = layer.style.fontSize * (layer.style.lineHeight ?? 1.15);

    if (!this.vertical) {
      // One line: each row's text, the separator between. Gaps are only breaks.
      const sep = layer.separator ?? DEFAULT_CRAWL_SEPARATOR;
      const shown = views.filter((v) => v.kind !== 'gap');
      shown.forEach((view, i) => {
        if (i > 0) copy.appendChild(this.styled('span', 'bz-roll-sep', layer.style, sep));
        const style = view.kind === 'heading' ? this.headingStyle() : layer.style;
        copy.appendChild(this.styled('span', 'bz-roll-row', style, view.kind === 'pair' ? `${view.left} ${view.right}` : view.text));
      });
      return copy;
    }

    views.forEach((view, i) => {
      let row: HTMLElement;
      if (view.kind === 'gap') {
        row = this.doc.createElement('div');
        row.className = 'bz-roll-row bz-roll-gap';
        row.style.height = `${layer.gapSize ?? lineHeight}px`;
      } else if (view.kind === 'pair') {
        const pair = layer.pairStyle ?? {};
        const split = pair.split ?? 0.5;
        const gutter = pair.gutter ?? 24;
        row = this.doc.createElement('div');
        row.className = 'bz-roll-row bz-roll-pair';
        const left = this.styled('span', '', pair.left ?? { ...layer.style, align: 'right' }, view.left);
        left.style.flex = `0 0 ${split * 100}%`;
        left.style.paddingRight = `${gutter / 2}px`;
        left.style.boxSizing = 'border-box';
        if (!pair.left?.align) left.style.textAlign = 'right';
        const right = this.styled('span', '', pair.right ?? { ...layer.style, align: 'left' }, view.right);
        right.style.flex = '1 1 0';
        right.style.paddingLeft = `${gutter / 2}px`;
        right.style.boxSizing = 'border-box';
        if (!pair.right?.align) right.style.textAlign = 'left';
        row.append(left, right);
      } else {
        row = this.styled('div', 'bz-roll-row', view.kind === 'heading' ? this.headingStyle() : layer.style, view.text);
      }
      if (spacing > 0 && i < views.length - 1) row.style.paddingBottom = `${spacing}px`;
      copy.appendChild(row);
    });
    return copy;
  }

  /** Measure the text. A roll inside a hidden layer measures 0 and refuses to move until it can. */
  remeasure(): boolean {
    const first = this.copies[0];
    if (!first) {
      const was = this.content;
      this.content = 0;
      return was !== 0;
    }
    const measure = this.opts.measure ?? ((el: HTMLElement, vertical: boolean) => (vertical ? el.offsetHeight : el.offsetWidth));
    const next = measure(first, this.vertical);
    const changed = next !== this.content;
    this.content = next;
    if (changed) this.lastPosition = null;
    return changed;
  }

  get measured(): boolean {
    return this.content > 0 || this.copies.length === 0 || this.signature === '[]';
  }

  get geometry(): RollGeometry {
    return rollGeometry(this.layer, this.windowLength, this.content, this.gap);
  }

  /** Whole travel in seconds at the designer's speed, or undefined until measured. */
  get extent(): number | undefined {
    if (this.content <= 0) return undefined;
    const speed = Math.max(1e-6, this.layer.speed);
    return this.geometry.distance / speed;
  }

  get info(): ScrollInfo {
    const extent = this.extent;
    return {
      ...(extent !== undefined ? { extent } : {}),
      end: this.layer.end ?? 'hold',
      start: this.layer.start ?? 'play',
    };
  }

  /**
   * Place the track at `travel` seconds. With `pose`, a roll that would enter
   * from off screen is shown with its first lines in view instead — the editor
   * canvas and a thumbnail, where an empty box would hide what is being built.
   */
  render(travel: number, pose = false): void {
    const geo = pose ? rollGeometry(this.layer, this.windowLength, this.content, this.gap, 'top') : this.geometry;
    const m = rollSign(this.layer);
    const px = travel * this.layer.speed;
    let position: number;
    if (this.layer.end === 'loop' && geo.distance > 0) {
      const t = ((px % geo.distance) + geo.distance) % geo.distance;
      // Moving positive, the copy that follows is above or before the first.
      position = m < 0 ? geo.start - t : geo.start - geo.distance + t;
    } else {
      position = geo.start + m * Math.min(px, geo.distance);
    }
    const rounded = Math.round(position * 100) / 100;
    if (rounded === this.lastPosition) return;
    this.lastPosition = rounded;
    this.opts.animator.set(this.opts.track, this.vertical ? { x: 0, y: rounded } : { x: rounded, y: 0 });
  }

  destroy(): void {
    for (const copy of this.copies) copy.remove();
    this.copies = [];
  }
}

export interface RollSyncOptions {
  animator: RollAnimator;
  ticker: RollTicker;
  /** Wall clock, epoch ms. Injected for tests. */
  now?: () => number;
  /** One frame and no ticking — a thumbnail. Rolls are posed with their first lines showing. */
  still?: boolean;
  /** Pose rolls with their first lines showing until something plays — the editor canvas. */
  pose?: boolean;
  /** The extent, or the scroll state, changed — an output reports. */
  onChange?: () => void;
  /** A `continue` roll reached its end. */
  onFinished?: () => void;
}

/** Every roll in a graphic, moved from the hub's scroll state. */
export class RollSync {
  private readonly opts: RollSyncOptions;
  private readonly blocks = new Map<string, RollBlock>();
  private payload: ScrollsPayload | undefined;
  /** Hub clock minus ours, ms. */
  private offset = 0;
  /** With no hub at all (`?hub=off`, the editor): when this page itself last played. */
  private localPlayAt: number | undefined;
  private ticking = false;
  private finishedKey = '';
  private readonly tickFn = (): void => this.tick();

  constructor(options: RollSyncOptions) {
    this.opts = options;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private hubNow(): number {
    return this.now() + this.offset;
  }

  add(id: string, block: RollBlock): void {
    this.blocks.set(id, block);
    this.render();
  }

  get size(): number {
    return this.blocks.size;
  }

  block(id: string): RollBlock | undefined {
    return this.blocks.get(id);
  }

  /** Take the hub's state. True when it was a scrolls payload. */
  setPayload(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const p = value as Partial<ScrollsPayload>;
    if (typeof p.clock === 'number' && Number.isFinite(p.clock)) this.offset = p.clock - this.now();
    this.payload = {
      clock: typeof p.clock === 'number' ? p.clock : this.now(),
      scrolls: p.scrolls && typeof p.scrolls === 'object' ? { ...p.scrolls } : {},
      ...(typeof p.playAt === 'number' ? { playAt: p.playAt } : {}),
    };
    this.finishedKey = '';
    this.render();
    this.opts.onChange?.();
    return true;
  }

  /** PLAY on a page with no hub: run `start: 'play'` rolls from now. Ignored once the hub has spoken. */
  played(): void {
    if (this.payload) return;
    this.localPlayAt = this.now();
    this.finishedKey = '';
    this.render();
  }

  /** CLEAR on a page with no hub. */
  cleared(): void {
    if (this.payload) return;
    this.localPlayAt = undefined;
    this.render();
  }

  /** A scroll's state as this page understands it now. */
  state(id: string): ScrollState {
    const block = this.firstBlock(id);
    const view = this.payload ?? { scrolls: {}, ...(this.localPlayAt !== undefined ? { playAt: this.localPlayAt } : {}) };
    return resolveScroll(view, id, block?.layer.start);
  }

  private firstBlock(id: string): RollBlock | undefined {
    for (const block of this.blocks.values()) if (block.id === id) return block;
    return undefined;
  }

  /** Nothing has played and nothing has been sent: show the text, not an empty window. */
  private get posing(): boolean {
    if (this.opts.still) return true;
    return this.opts.pose === true && !this.payload && this.localPlayAt === undefined;
  }

  /** Re-measure every roll — fonts landed, a layer came into view. */
  remeasure(): void {
    let changed = false;
    for (const block of this.blocks.values()) if (block.remeasure()) changed = true;
    if (changed) {
      this.render();
      this.opts.onChange?.();
    }
  }

  /** Re-measure only the rolls that have not managed to yet — cheap enough to call every frame. */
  remeasureUnmeasured(): void {
    let changed = false;
    for (const block of this.blocks.values()) if (!block.measured && block.remeasure()) changed = true;
    if (changed) {
      this.render();
      this.opts.onChange?.();
    }
  }

  /** Put every roll where it should be now, and keep ticking while any is moving. */
  render(): void {
    const now = this.hubNow();
    let moving = false;
    let finished = false;
    for (const block of this.blocks.values()) {
      if (this.posing) {
        block.render(0, true);
        continue;
      }
      const state = this.state(block.id);
      const info = block.info;
      const travel = scrollTravel(state, now);
      block.render(clampTravel(travel, info));
      if (!state.running) continue;
      const extent = info.extent;
      const atEnd = extent !== undefined && info.end !== 'loop' && (state.rate >= 0 ? travel >= extent : travel <= 0);
      if (!atEnd || extent === undefined) moving = true;
      if (atEnd && info.end === 'continue' && state.rate > 0) {
        const key = `${block.id}|${state.anchor}|${state.base}|${state.rate}`;
        if (key !== this.finishedKey) {
          this.finishedKey = key;
          finished = true;
        }
      }
    }
    this.setTicking(moving && !this.opts.still);
    if (finished) this.opts.onFinished?.();
  }

  private tick(): void {
    // A roll that has never measured (its layer was hidden) gets another try each frame.
    this.remeasureUnmeasured();
    this.render();
  }

  private setTicking(on: boolean): void {
    if (on === this.ticking) return;
    this.ticking = on;
    if (on) this.opts.ticker.add(this.tickFn);
    else this.opts.ticker.remove(this.tickFn);
  }

  /** Whether a `continue` roll has run to its end since the last PLAY — checked when the graphic reaches a hold. */
  get continueDone(): boolean {
    if (this.posing) return false;
    const now = this.hubNow();
    for (const block of this.blocks.values()) {
      if (block.layer.end !== 'continue') continue;
      const state = this.state(block.id);
      const extent = block.extent;
      if (state.running && state.rate > 0 && extent !== undefined && scrollTravel(state, now) >= extent) return true;
    }
    return false;
  }

  /** What an output reports: one entry per scroll id. */
  get reports(): ScrollReport[] {
    const out = new Map<string, ScrollReport>();
    const now = this.hubNow();
    for (const block of this.blocks.values()) {
      if (out.has(block.id)) continue;
      const state = this.state(block.id);
      const info = block.info;
      out.set(block.id, {
        id: block.id,
        ...info,
        travel: Math.round(clampTravel(scrollTravel(state, now), info) * 1000) / 1000,
        running: state.running,
        rate: state.rate,
      });
    }
    return [...out.values()];
  }

  destroy(): void {
    this.setTicking(false);
    for (const block of this.blocks.values()) block.destroy();
    this.blocks.clear();
  }
}
