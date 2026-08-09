// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Table layer — the template-row renderer.
 *
 * The designer styles one row; the runtime clones it per data row. That is the
 * whole design, and it is what keeps tables inside the existing layer system
 * rather than beside it: a cell is an ordinary layer, so it is built by the same
 * `buildLayerElement`, styled by the same code and fitted by the same Fit Width
 * as any other text on the stage.
 *
 * Three motions, deliberately distinct:
 *  - **enter** — the reveal stagger, owned by the main timeline (the table is
 *    part of the graphic's intro),
 *  - **re-sort** — a FLIP, owned by this module and running on its own clock
 *    because it is triggered by data arriving, not by the playhead,
 *  - **paging** — an instant swap on `next()`, again data-driven.
 *
 * Mixing those into the timeline was the first thing tried and it does not work:
 * a standings feed changing while the graphic holds at its STOP marker has no
 * playhead time to animate over. Re-sorts therefore never touch `this.tl`.
 */

import {
  DEFAULT_TRANSFORM,
  ROW_ANIM_PRESET_IDS,
  applyTransforms,
  conform,
  inferColumns,
  type DataColumn,
  type DataRow,
  type DataSet,
  type Ease,
  type Layer,
  type RowAnimPreset,
  type RowAnimPresetId,
  type TableLayer,
} from '@breeze/schema';

import { buildLayerElement, type BuildContext, type LayerNodes } from './dom.js';
import type { LayerInstance } from './expand.js';
import { applyTextFit } from './fit.js';
import { hasKeyframes } from './plan.js';

/* ------------------------------------------------------------------- pure */

export interface RowAnimDef {
  id: RowAnimPresetId;
  label: string;
  /** GSAP `from` vars applied to each row element. */
  from: { yPercent?: number; xPercent?: number; opacity?: number };
  stagger: number;
  duration: number;
  ease: Ease;
}

/**
 * Row rise distance, as a percentage of the row's own height.
 *
 * Full height would start each row exactly in its neighbor's place, so a
 * staggered table looks like the rows are shuffling through each other rather
 * than arriving. Half a row reads as a rise and keeps the stagger legible.
 */
const ROW_RISE_PERCENT = 50;

const ROW_PRESETS: Record<Exclude<RowAnimPresetId, 'none'>, RowAnimDef> = {
  'rows-up': {
    id: 'rows-up', label: 'Rows rise',
    from: { yPercent: ROW_RISE_PERCENT, opacity: 0 },
    stagger: 0.06, duration: 0.45, ease: 'power3.out',
  },
  'rows-fade': {
    id: 'rows-fade', label: 'Rows fade',
    from: { opacity: 0 },
    stagger: 0.05, duration: 0.4, ease: 'power1.out',
  },
  'rows-slide': {
    id: 'rows-slide', label: 'Rows slide in',
    from: { xPercent: -20, opacity: 0 },
    stagger: 0.05, duration: 0.5, ease: 'power3.out',
  },
};

export const ROW_ANIM_PRESETS: RowAnimDef[] = ROW_ANIM_PRESET_IDS.filter(
  (id): id is Exclude<RowAnimPresetId, 'none'> => id !== 'none',
).map((id) => ROW_PRESETS[id]);

export interface ResolvedRowAnim extends RowAnimDef {}

/** null for `none`, an omitted preset, or an id the gallery does not contain. */
export function resolveRowAnim(preset: RowAnimPreset | undefined): ResolvedRowAnim | null {
  if (!preset || preset.id === 'none') return null;
  const def = ROW_PRESETS[preset.id as Exclude<RowAnimPresetId, 'none'>];
  if (!def) return null;
  return {
    ...def,
    ...(preset.stagger !== undefined ? { stagger: preset.stagger } : {}),
    ...(preset.duration !== undefined ? { duration: preset.duration } : {}),
    ...(preset.ease !== undefined ? { ease: preset.ease } : {}),
  };
}

/** Total seconds a reveal occupies — the editor warns when it overruns the hold. */
export function rowAnimDuration(anim: ResolvedRowAnim | null, rowCount: number): number {
  if (!anim || rowCount <= 0) return 0;
  return anim.duration + anim.stagger * Math.max(0, rowCount - 1);
}

/** y offset of row `index`, in stage px. */
export function rowOffset(index: number, height: number, gap = 0): number {
  return index * (height + gap);
}

/**
 * Rows that fit the layer box.
 *
 * The last row must fit *whole*. Half a row peeking out of the bottom of a
 * standings table reads as a rendering fault, not as "there is more" — and on
 * air there is no scrollbar to explain it.
 */
export function rowsThatFit(boxHeight: number, rowHeight: number, gap = 0): number {
  if (rowHeight <= 0 || boxHeight <= 0) return 0;
  const pitch = rowHeight + gap;
  // The final row needs no trailing gap, so the box only has to cover
  // n*pitch - gap.
  return Math.max(0, Math.floor((boxHeight + gap) / pitch));
}

export interface Paging {
  /** Rows shown at once. */
  perPage: number;
  pageCount: number;
  /** More rows than one page holds. */
  overflow: boolean;
}

export function paging(
  totalRows: number,
  boxHeight: number,
  rowHeight: number,
  gap = 0,
  rowsPerPage?: number,
): Paging {
  const fits = rowsThatFit(boxHeight, rowHeight, gap);
  /*
   * An explicit `rowsPerPage` wins even when it overflows the box.
   *
   * It is an authoring instruction, and honouring the box instead would silently
   * drop rows the author asked for — the failure being invisible until the one
   * show where the feed is long. The overflow flag says so in the properties
   * panel instead.
   */
  const perPage = rowsPerPage && rowsPerPage > 0 ? Math.floor(rowsPerPage) : fits;
  if (perPage <= 0) {
    return { perPage: totalRows, pageCount: 1, overflow: false };
  }
  const pageCount = Math.max(1, Math.ceil(totalRows / perPage));
  const boxOverflow = fits > 0 && perPage > fits;
  return { perPage, pageCount, overflow: pageCount > 1 || boxOverflow };
}

/**
 * Stable identity for a data row, so a re-sort can be animated rather than
 * re-rendered.
 *
 * FLIP needs to know that "Mesa on line 3" and "Mesa on line 1" are the same
 * element moving. Without an identity every re-sort is a teardown and the
 * standings shuffle — the entire point of the feature — degrades into a flicker.
 *
 * The first string column is the key by convention: in every tabular graphic
 * this targets that is the team, the driver, the constituency. Falling back to
 * the whole row is correct but inert — identical rows simply do not animate.
 */
export function rowKey(row: DataRow, columns: DataColumn[]): string {
  const idCol = columns.find((c) => c.type === 'string') ?? columns[0];
  if (idCol) {
    const v = row[idCol.key];
    if (v !== undefined && v !== null && v !== '') return `${idCol.key}:${String(v)}`;
  }
  return JSON.stringify(row);
}

/**
 * Coerce whatever arrived on an `update()` into a DataSet.
 *
 * Operators, REST callers and playout servers all push different shapes at this
 * — a bare array of objects from a JSON feed, a `{columns, rows}` object from
 * our own control panel, occasionally a single object for a scalar source. All
 * three are accepted rather than rejected: refusing a payload live on air helps
 * nobody, and the shapes are unambiguous.
 */
export function toDataSet(value: unknown, id: string, declared?: DataColumn[]): DataSet | null {
  if (!value) return null;

  if (Array.isArray(value)) {
    const rows = value.filter((r): r is DataRow => typeof r === 'object' && r !== null);
    const columns = declared?.length ? declared : inferColumns(rows);
    return { id, columns, rows: conform(rows, columns) };
  }

  if (typeof value === 'object') {
    const candidate = value as Partial<DataSet>;
    if (Array.isArray(candidate.rows)) {
      const columns =
        candidate.columns?.length ? candidate.columns
        : declared?.length ? declared
        : inferColumns(candidate.rows);
      return {
        id: candidate.id ?? id,
        columns,
        rows: conform(candidate.rows, columns),
        ...(candidate.fetchedAt ? { fetchedAt: candidate.fetchedAt } : {}),
        ...(candidate.revision !== undefined ? { revision: candidate.revision } : {}),
      };
    }
    // A lone object is a one-row set — the scalar-source shape.
    const rows = [value as DataRow];
    const columns = declared?.length ? declared : inferColumns(rows);
    return { id, columns, rows: conform(rows, columns) };
  }

  return null;
}

/* -------------------------------------------------------------------- DOM */

/** The slice of GSAP this module uses, injected so it can be tested headless. */
export interface TableAnimator {
  to(target: unknown, vars: Record<string, unknown>): { kill(): void };
  set(target: unknown, vars: Record<string, unknown>): void;
}

export interface TableBlockOptions {
  layer: TableLayer;
  /** The table layer's `.bz-content` element; rows are appended here. */
  host: HTMLElement;
  ctx: BuildContext;
  animator: TableAnimator;
  /** Namespaced id of the table layer, for row element ids and warnings. */
  layerId: string;
}

interface RowHandle {
  key: string;
  el: HTMLElement;
  /** Cell nodes, so a data change rewrites text without rebuilding the row. */
  cells: Array<{ nodes: LayerNodes; column: string | undefined }>;
  /** Current y, in stage px — the FLIP "first" position. */
  y: number;
}

/**
 * Compose a cell layer's static transform into a CSS string.
 *
 * Written directly rather than through GSAP for cells that never move: letting
 * GSAP own the transform of every cell in a twenty-row table means twenty times
 * the cell count of tracked targets for values that never change.
 *
 * Cells that *do* carry keyframes are excluded from this — see `buildRow`.
 * GSAP caches an element's transform and rewrites the whole string, so a
 * hand-written `style.transform` on an element GSAP also animates is not a
 * baseline, it is a value about to be silently discarded.
 */
function staticTransform(layer: Layer): string {
  const t = { ...DEFAULT_TRANSFORM, ...(layer.transform ?? {}) };
  const parts = [`translate(${t.x}px, ${t.y}px)`];
  if (t.rotation) parts.push(`rotate(${t.rotation}deg)`);
  if (t.scaleX !== 1 || t.scaleY !== 1) parts.push(`scale(${t.scaleX}, ${t.scaleY})`);
  if (t.skewX || t.skewY) parts.push(`skew(${t.skewX}deg, ${t.skewY}deg)`);
  return parts.join(' ');
}

export class TableBlock {
  private readonly opts: TableBlockOptions;
  private readonly doc: Document;

  private rows = new Map<string, RowHandle>();
  /** Render order, so FLIP and the reveal see rows top-to-bottom. */
  private order: string[] = [];

  private source: DataSet | null = null;
  private view: DataSet = { id: '', columns: [], rows: [] };
  private page = 0;
  private paging: Paging = { perPage: 0, pageCount: 1, overflow: false };
  private destroyed = false;

  constructor(options: TableBlockOptions) {
    this.opts = options;
    this.doc = options.host.ownerDocument;
    this.opts.host.classList.add('bz-table');

    const authored = options.layer.data;
    if (authored) {
      this.source = {
        id: options.layer.source ?? options.layerId,
        columns: authored.columns,
        rows: conform(authored.rows, authored.columns),
      };
    }
    this.render({ animate: false });
  }

  /* ------------------------------------------------------------- data in */

  /** Replace the data. Returns true when the rendered view actually changed. */
  setDataSet(data: DataSet | null): boolean {
    if (this.destroyed) return false;
    this.source = data;
    const before = this.signature();
    // Page 0 on new data: a feed that shrinks below the current page would
    // otherwise leave the table parked on a page that no longer exists.
    if (this.page >= this.pageCount) this.page = 0;
    this.render({ animate: true });
    return this.signature() !== before;
  }

  get dataSet(): DataSet | null {
    return this.source;
  }

  /** The transformed, paged rows currently on screen. */
  get visibleRows(): DataRow[] {
    return this.pageRows();
  }

  /**
   * Every row's copy of one template cell, in render order.
   *
   * The unit a cell tween targets. One array, one tween, `stagger` doing the
   * per-row offset — which is what keeps the cost of this feature independent
   * of row count instead of one timeline per cell per row.
   *
   * Rebuilt from the live DOM on each call rather than cached: a re-sort, a
   * page turn or a feed tick replaces row elements, and a cached array would
   * animate nodes that are no longer on screen.
   */
  cellElements(cellLayerId: string): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const key of this.order) {
      const handle = this.rows.get(key);
      if (!handle) continue;
      const found = handle.cells.find((c) => c.nodes.layer.id === cellLayerId);
      if (found) out.push(found.nodes.el);
    }
    return out;
  }

  /** Template cells carrying keyframes — the ones the runtime builds tracks for. */
  get animatedCells(): Layer[] {
    return this.opts.layer.row.cells.filter(hasKeyframes);
  }

  get rowElements(): HTMLElement[] {
    return this.order.map((k) => this.rows.get(k)!.el).filter(Boolean);
  }

  get pageCount(): number {
    return this.paging.pageCount;
  }

  get currentPage(): number {
    return this.page;
  }

  /** More rows than the page holds — surfaced at build time, not on air. */
  get overflow(): boolean {
    return this.paging.overflow;
  }

  get totalRows(): number {
    return this.view.rows.length;
  }

  /* -------------------------------------------------------------- paging */

  /**
   * Advance one page, wrapping to the first.
   *
   * Returns false when there is only one page, which is how the runtime knows
   * `next()` was *not* consumed and should fall through to the STOP-marker
   * behavior. Pages are not steps: a step is a STOP marker, so `stepCount()`
   * stays marker-only (DATA-SOURCES §2).
   */
  nextPage(): boolean {
    if (this.destroyed || this.paging.pageCount <= 1) return false;
    this.page = (this.page + 1) % this.paging.pageCount;
    this.render({ animate: true });
    return true;
  }

  setPage(page: number): void {
    if (this.destroyed) return;
    const next = Math.max(0, Math.min(Math.floor(page), this.paging.pageCount - 1));
    if (next === this.page) return;
    this.page = next;
    this.render({ animate: true });
  }

  /* -------------------------------------------------------------- render */

  private pageRows(): DataRow[] {
    const perPage = this.paging.perPage;
    if (perPage <= 0) return this.view.rows;
    const start = this.page * perPage;
    return this.view.rows.slice(start, start + perPage);
  }

  /** Cheap identity of what is on screen, for change detection. */
  private signature(): string {
    return `${this.page}|${JSON.stringify(this.pageRows())}`;
  }

  /**
   * Rebuild the row list against the current data.
   *
   * Reuses row elements by key so a re-sort moves the elements that are already
   * on screen. `animate` is false on construction and true afterwards — the
   * first render must not FLIP from nowhere.
   */
  render(opts: { animate?: boolean } = {}): void {
    if (this.destroyed) return;

    const layer = this.opts.layer;
    const gap = layer.row.gap ?? 0;
    const height = layer.row.height;

    this.view = this.source
      ? applyTransforms(this.source, layer.transforms)
      : { id: '', columns: [], rows: [] };

    this.paging = paging(
      this.view.rows.length,
      layer.size?.height ?? 0,
      height,
      gap,
      layer.rowsPerPage,
    );
    if (this.page >= this.paging.pageCount) this.page = 0;

    const rows = this.pageRows();
    const nextOrder: string[] = [];
    const kept = new Set<string>();
    const entering: HTMLElement[] = [];
    const moving: Array<{ el: HTMLElement; from: number; to: number }> = [];

    rows.forEach((row, index) => {
      // Duplicate identities (two rows for the same team) would otherwise
      // collapse into one element; suffixing keeps them distinct without
      // giving up FLIP for the rest of the table.
      let key = rowKey(row, this.view.columns);
      if (kept.has(key)) key = `${key}#${index}`;
      kept.add(key);
      nextOrder.push(key);

      const y = rowOffset(index, height, gap);
      let handle = this.rows.get(key);

      if (!handle) {
        handle = this.buildRow(key, y);
        this.rows.set(key, handle);
        entering.push(handle.el);
      } else if (handle.y !== y) {
        moving.push({ el: handle.el, from: handle.y, to: y });
      }

      this.writeRow(handle, row);
      handle.y = y;

      if (!opts.animate || entering.includes(handle.el)) {
        this.opts.animator.set(handle.el, { y });
      }
    });

    // Rows that left the view. Removed outright rather than faded: a row that
    // dropped off the bottom of a limit() is not "exiting", it is not in the
    // data, and holding a ghost of it on screen is worse than a hard cut.
    for (const [key, handle] of [...this.rows]) {
      if (kept.has(key)) continue;
      handle.el.remove();
      this.rows.delete(key);
    }

    this.order = nextOrder;

    if (!opts.animate) return;

    const flip = layer.flip;
    const flipDuration = flip?.duration ?? 0.5;
    if (flipDuration > 0) {
      for (const m of moving) {
        /*
         * GSAP owns `y` outright — absolute row position, not a delta.
         *
         * The earlier shape kept the row's resting place in the element's own
         * `style.transform` and used `y` for the offset, baking the result back
         * into the inline transform when the tween finished. That fought itself
         * twice over. GSAP caches an element's transform and rewrites the whole
         * string, so the `set(y: 0)` that followed the bake wiped the very
         * position it had just written and every re-sorted row snapped back to
         * the top of the table. And a second re-sort arriving mid-tween measured
         * from a baseline the first had already moved.
         *
         * One owner, absolute values, no bake step. `overwrite: 'auto'` lets a
         * tick that lands mid-flight retarget the running tween rather than
         * racing it.
         */
        this.opts.animator.to(m.el, {
          y: m.to,
          duration: flipDuration,
          ease: flip?.ease ?? 'power2.inOut',
          overwrite: 'auto',
        });
      }
    } else {
      for (const m of moving) {
        this.opts.animator.set(m.el, { y: m.to });
      }
    }

    /*
     * Rows arriving into a table that is already on screen fade in on their own
     * clock. The timeline's reveal covers the graphic's intro; a feed adding a
     * team at 19:58 has no timeline time left to animate over.
     */
    if (entering.length && this.rows.size > entering.length) {
      const anim = resolveRowAnim(layer.rowAnim);
      if (anim) {
        this.opts.animator.set(entering, { ...anim.from });
        this.opts.animator.to(entering, {
          yPercent: 0,
          xPercent: 0,
          opacity: 1,
          duration: anim.duration,
          ease: anim.ease,
          stagger: anim.stagger,
        });
      }
    }
  }

  private buildRow(key: string, y: number): RowHandle {
    const layer = this.opts.layer;
    const el = this.doc.createElement('div');
    el.className = 'bz-table-row';
    el.dataset['rowKey'] = key;
    el.style.height = `${layer.row.height}px`;
    // Position goes through the animator, never `style.transform` — see the
    // FLIP note in `render`. The caller places it immediately after this.
    this.opts.animator.set(el, { y });

    const cells: RowHandle['cells'] = [];

    layer.row.cells.forEach((cellLayer, i) => {
      /*
       * A synthetic instance, so cells go through `buildLayerElement` exactly as
       * top-level layers do. Reusing the real builder is the point: a cell gets
       * the same text styling, gradients, strokes and image fitting as anything
       * else on the stage, and there is no second implementation to drift.
       */
      const instance: LayerInstance = {
        id: `${this.opts.layerId}/${key}/${cellLayer.id}`,
        layer: cellLayer,
        parentId: null,
        offset: 0,
        depth: 0,
        pinnedBindings: new Set(),
        overrides: {},
      };
      const nodes = buildLayerElement(instance, this.opts.ctx);
      nodes.el.style.zIndex = String(i);

      /*
       * An animated cell hands its transform and opacity to GSAP entirely.
       *
       * The runtime seeds the baseline with `gsap.set` when it fills the cell
       * track (`fillCellTrack`), so writing them here as well would not be
       * belt-and-braces — it would be a second owner of the same string, and
       * GSAP's cache means the loser is whoever wrote first.
       *
       * `data-cell` is what lets the runtime find these again after a re-sort
       * or a page turn rebuilds the row.
       */
      nodes.el.dataset['cell'] = cellLayer.id;
      if (!hasKeyframes(cellLayer)) {
        nodes.el.style.transform = staticTransform(cellLayer);
        if (cellLayer.opacity !== undefined && cellLayer.opacity !== 1) {
          nodes.el.style.opacity = String(cellLayer.opacity);
        }
      }

      if (cellLayer.visible === false) nodes.el.dataset['hidden'] = '1';
      el.appendChild(nodes.el);
      cells.push({ nodes, column: cellLayer.cell });
    });

    this.opts.host.appendChild(el);
    return { key, el, cells, y };
  }

  /** Write one data row into an existing row element's cells. */
  private writeRow(handle: RowHandle, row: DataRow): void {
    for (const cell of handle.cells) {
      if (!cell.column) continue;
      const value = row[cell.column];
      const layer = cell.nodes.layer;

      if (layer.type === 'text' && cell.nodes.textInner) {
        const text = value === null || value === undefined ? '' : String(value);
        if (cell.nodes.textInner.textContent === text) continue;
        cell.nodes.textInner.textContent = text;
        // Per-cell Fit Width. This is the reason cells are layers: a long team
        // name squeezes into its column with no extra machinery.
        applyTextFit(cell.nodes.textInner, layer.fit, layer.size?.width ?? 0);
      } else if (layer.type === 'image' && cell.nodes.media) {
        const src = value === null || value === undefined ? '' : String(value);
        if (src) cell.nodes.media.src = this.opts.ctx.resolveAsset(src);
      }
    }
  }

  /** Re-run Fit Width on every cell — after fonts land, like the text layers. */
  refit(): void {
    for (const handle of this.rows.values()) {
      for (const cell of handle.cells) {
        const layer = cell.nodes.layer;
        if (layer.type !== 'text' || !cell.nodes.textInner) continue;
        applyTextFit(cell.nodes.textInner, layer.fit, layer.size?.width ?? 0);
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const handle of this.rows.values()) handle.el.remove();
    this.rows.clear();
    this.order = [];
  }
}
