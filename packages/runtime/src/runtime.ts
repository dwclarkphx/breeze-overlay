// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * @breeze/runtime — the single renderer.
 *
 * The project's first rule: the editor preview and the served /play page both
 * instantiate THIS class. There is no second rendering path, so what the
 * operator saw in the editor is bit-for-bit what goes to air.
 *
 * Control surface is play / stop / next / update — the verb set broadcast
 * operators already know, borrowed from CasparCG's template contract.
 * Lifecycle: idle → (play) → playing-in → holding at STOP marker → (stop or
 * next) → playing-out → finished.
 */

import { gsap } from 'gsap';
import { SplitText } from 'gsap/SplitText';
import {
  DATA_UPDATE_KEY,
  DEFAULT_CRAWL_SEPARATOR,
  collectBindings,
  stepCount as schemaStepCount,
  type AnimatableProp,
  type BindingData,
  type Composition,
  type DataRow,
  type DataSet,
  type Ease,
  type Layer,
  type PlaybackState,
} from '@breeze/schema';

import { ClockTicker } from './clock.js';
import { resolveEase } from './ease.js';
import { applyTextFit, type FitResult } from './fit.js';
import { CrawlLoop, crawlItemsFrom, type CrawlAnimator } from './crawl.js';
import {
  buildLayerElement,
  composeFilter,
  type BuildContext,
  type LayerNodes,
} from './dom.js';
import type { ExpandWarning } from './expand.js';
import { applyMaskReference, createMask, createMaskHost, type MaskHandle } from './mask.js';
import { buildPlan, layerMotion, nextHoldAfter, type TimelinePlan } from './plan.js';
import { injectRuntimeStyles } from './styles.js';
import {
  TableBlock,
  resolveRowAnim,
  toDataSet,
  type ResolvedRowAnim,
  type TableAnimator,
} from './table.js';
import { resolveTextAnim, type ResolvedTextAnim } from './textanim.js';
import { VideoSync } from './video.js';

/*
 * SplitText ships in the public gsap package and is free under the standard
 * license as of 3.13. Registered once at module scope: registering per instance
 * is harmless but pointless, and a graphic may build several runtimes.
 */
gsap.registerPlugin(SplitText);

/** A table and the row reveal parented into the main timeline at its in-point. */
interface TableHandle {
  block: TableBlock;
  anim: ResolvedRowAnim | null;
  /** Where in the timeline the reveal starts — the layer's in-point. */
  start: number;
  /** Child timeline, for the same reason the text reveals use one. */
  track: gsap.core.Timeline | null;
  /**
   * Second child timeline carrying the template cells' own keyframes.
   *
   * Separate from `track` because the two answer to different things: the
   * reveal is a preset the table owns, the cell motion is authored per cell and
   * can be refilled without disturbing the reveal that is mid-flight above it.
   */
  cellTrack: gsap.core.Timeline | null;
  /** The row set changed — the track no longer targets what is on screen. */
  stale: boolean;
}

/** A split text layer and the reveal built over its pieces. */
interface TextAnimHandle {
  anim: ResolvedTextAnim;
  split: SplitText;
  /** Where in the timeline the reveal starts — the layer's in-point. */
  start: number;
  /**
   * Child timeline holding the reveal, parented into the main timeline at
   * `start`.
   *
   * A child timeline rather than a bare tween so that live text can be
   * re-revealed without touching the main timeline: `clear()` and refill leaves
   * its position in the parent untouched, where killing and re-adding a tween
   * mid-show has to reconstruct that position from scratch.
   */
  track: gsap.core.Timeline | null;
  /** The split no longer matches the DOM — the text changed under it. */
  stale: boolean;
}

/**
 * What to ask SplitText for.
 *
 * Chars are split with words as well: without them a character-split line wraps
 * mid-word, because every char becomes its own inline-block and the browser
 * loses any reason to keep a word together.
 */
const SPLIT_TYPE: Record<ResolvedTextAnim['unit'], string> = {
  chars: 'chars,words',
  words: 'words',
  lines: 'lines',
};

export type RuntimeEvent =
  | 'ready'
  | 'play'
  | 'hold'
  | 'stop'
  | 'finished'
  | 'update'
  | 'timeupdate';

export type RuntimeListener = (payload: RuntimePayload) => void;

export interface RuntimePayload {
  state: PlaybackState;
  time: number;
  step: number;
  data: BindingData;
}

export interface RuntimeOptions {
  container: HTMLElement;
  composition: Composition;
  /**
   * Resolves a `composition` layer's `ref`. Without it, nested compositions
   * render nothing and report a warning rather than failing the whole graphic.
   */
  resolveComposition?: (id: string) => Composition | undefined;
  /** Maps `assets/foo.png` to a loadable URL. Defaults to identity. */
  resolveAsset?: (src: string) => string;
  /** Initial dynamic-field values. */
  data?: BindingData;
  /** 'none' renders 1:1 (playout). 'contain' scales the stage into the container (editor). */
  scaleMode?: 'none' | 'contain';
  /** Skip style injection when the host page already includes the CSS. */
  injectStyles?: boolean;
  /** Start paused at t=0 without calling play(). Default true. */
  autoPlay?: boolean;
  /**
   * Build for one paused frame rather than for playback.
   *
   * Intended for composition and scene thumbnails — anything that seeks once,
   * paints, and never plays.
   *
   * What it skips is the text *animation* scaffolding, not the text.
   * `buildTextAnims` splits a span into a row of per-character or per-word
   * inline-blocks so a reveal can stagger them, and the `fonts.ready` handler
   * re-splits so the stagger lands on the right line boundaries. Neither is
   * observable in a frame that never moves, and together they are most of what
   * `build()` costs on a text-heavy graphic: the normal path runs `refit` →
   * split → `refit`, then on fonts.ready `refit` → re-split → `refit` again.
   * A still runs one `refit`, and one more when the fonts land.
   *
   * **Fitting is deliberately kept.** Fit Width is the difference between a
   * strap that reads and one with copy hanging off the end of its bar, and that
   * is just as wrong in a still as on air. Table blocks keep their fit for the
   * same reason — a long team name overruns its column either way.
   *
   * Cosmetically identical to a normal runtime for any graphic with no
   * `textAnimPreset`, and identical *at rest* for one that has: a reveal's
   * whole job is to be finished by the first stop marker, which is where a
   * thumbnail poses it.
   */
  still?: boolean;
}

/** Which schema props map straight onto GSAP transform/opacity properties. */
const GSAP_PROP: Partial<Record<AnimatableProp, string>> = {
  x: 'x',
  y: 'y',
  scaleX: 'scaleX',
  scaleY: 'scaleY',
  rotation: 'rotation',
  skewX: 'skewX',
  skewY: 'skewY',
  opacity: 'opacity',
};

interface FilterProxy {
  blur: number;
  brightness: number;
  maskOffset: number;
}

let instanceCounter = 0;

export class BreezeRuntime {
  readonly composition: Composition;
  readonly plan: TimelinePlan;

  private readonly container: HTMLElement;
  private readonly doc: Document;
  private readonly resolveAsset: (src: string) => string;
  private readonly scaleMode: 'none' | 'contain';
  /** Built for one paused frame — see `RuntimeOptions.still`. */
  readonly still: boolean;
  private readonly uid: string;

  private root!: HTMLElement;
  private stage!: HTMLElement;
  private maskHost!: SVGSVGElement;
  private tl!: gsap.core.Timeline;

  private nodes = new Map<string, LayerNodes>();
  private proxies = new Map<string, FilterProxy>();
  private masks = new Map<string, MaskHandle>();
  private fitResults = new Map<string, FitResult>();
  private videos = new VideoSync();
  private crawls = new Map<string, CrawlLoop>();
  private tables = new Map<string, TableHandle>();
  private textAnims = new Map<string, TextAnimHandle>();
  /**
   * One timer for every clock layer in this graphic. Built lazily in `build()`
   * because a composition with no clock should not own a timer at all.
   */
  private clocks: ClockTicker | null = null;
  private listeners = new Map<RuntimeEvent, Set<RuntimeListener>>();
  /** Last DataSet seen per source id, so a late-built table can catch up. */
  private datasets = new Map<string, DataSet>();

  private state: PlaybackState = 'idle';
  private pendingHold: number | null = null;
  private data: BindingData = {};
  private destroyed = false;

  constructor(options: RuntimeOptions) {
    instanceCounter += 1;
    this.uid = `r${instanceCounter}`;
    this.container = options.container;
    this.doc = options.container.ownerDocument;
    this.composition = options.composition;
    this.resolveAsset = options.resolveAsset ?? ((s) => s);
    this.scaleMode = options.scaleMode ?? 'none';
    this.still = options.still ?? false;
    this.plan = buildPlan(options.composition, { resolve: options.resolveComposition });
    this.data = { ...(options.data ?? {}) };

    /*
     * Datasets are unpacked from the boot payload *before* `build()`, not left
     * to the `update()` call below it.
     *
     * `build()` is where crawl loops and table blocks are first filled, and it
     * runs first — so a source-fed layer that waited for the update would be
     * built from its authored placeholder and only correct itself a moment
     * later. For a table that is a visible flash of the wrong standings; for a
     * crawl it was worse, because a stopped ticker had no pass in which to swap
     * the real headlines in. The /play page inlines current datasets into its
     * boot payload precisely so a graphic is never briefly wrong on load, and
     * that only pays off if they are available this early.
     */
    this.seedDatasets();

    if (options.injectStyles !== false) injectRuntimeStyles(this.doc);

    this.build();
    if (Object.keys(this.data).length) this.update(this.data, { silent: true });
    this.emit('ready');

    if (options.autoPlay) this.play();
  }

  /* --------------------------------------------------------------- build */

  private build(): void {
    this.root = this.doc.createElement('div');
    this.root.className = 'bz-root';
    this.root.style.width = `${this.composition.stage.width}px`;
    this.root.style.height = `${this.composition.stage.height}px`;
    if (this.composition.stage.background !== 'transparent') {
      this.root.style.background = this.composition.stage.background;
    }

    this.maskHost = createMaskHost(this.doc);
    this.root.appendChild(this.maskHost);

    this.stage = this.doc.createElement('div');
    this.stage.className = 'bz-stage';
    this.root.appendChild(this.stage);

    const ctx: BuildContext = { doc: this.doc, resolveAsset: this.resolveAsset };

    /**
     * Instances arrive parent-before-child from the expander, so appending to
     * the parent's content element in order builds the whole tree in one pass
     * — no recursion here, and no chance of the DOM tree disagreeing with the
     * timeline about which layer is nested where.
     */
    for (const instance of this.plan.instances) {
      const nodes = buildLayerElement(instance, ctx);
      this.nodes.set(instance.id, nodes);

      const parent = instance.parentId ? this.nodes.get(instance.parentId) : undefined;
      (parent ? parent.content : this.stage).appendChild(nodes.el);

      if (instance.layer.mask) {
        const handle = createMask(
          this.doc,
          this.maskHost,
          `${this.uid}-${instance.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
          instance.layer.mask,
          instance.layer.size ?? { width: this.composition.stage.width, height: this.composition.stage.height },
          this.resolveAsset,
        );
        applyMaskReference(nodes.el, handle.reference);
        this.masks.set(instance.id, handle);
      }

      if (nodes.video && instance.layer.type === 'video') {
        this.videos.add({ el: nodes.video, layer: instance.layer, offset: instance.offset });
      }
    }

    // Seed values pinned by an enclosing composition layer's overrides.
    for (const instance of this.plan.instances) {
      if (!Object.keys(instance.overrides).length) continue;
      const nodes = this.nodes.get(instance.id);
      if (!nodes) continue;
      const layer = instance.layer;
      if (!('binding' in layer) || !layer.binding) continue;
      if (!(layer.binding in instance.overrides)) continue;
      this.applyBinding(nodes, instance.overrides[layer.binding]);
    }

    if (this.plan.warnings.length) {
      for (const warning of this.plan.warnings) {
        console.warn(`[breeze] ${warning.layerId}: ${warning.message}`);
      }
    }

    this.container.appendChild(this.root);
    if (this.scaleMode === 'contain') this.fitToContainer();

    // Build crawl loops now the tree is in the document and can be measured, so
    // a ticker shows its headlines before anything is played — an editor
    // preview sitting at frame 0 should not look empty.
    for (const [id, node] of this.nodes) {
      if (node.layer.type === 'crawl') this.crawlFor(id);
    }

    /*
     * Clocks, before the first paint rather than on the first tick.
     *
     * `add()` writes immediately, so a graphic cued and held for ten minutes
     * before air shows the real time the moment it is built — not the authored
     * placeholder until the next interval fires. The placeholder exists for the
     * editor canvas and for a still export, and should never reach a renderer.
     */
    for (const [id, node] of this.nodes) {
      const layer = node.layer;
      if (layer.type !== 'text' || !layer.clock || !node.textInner) continue;
      const inner = node.textInner;
      this.clockTicker().add(id, {
        clock: layer.clock,
        write: (text) => {
          /*
           * Revert the split before writing, then mark it stale — the same
           * ordering `applyBinding` needs and for the same reason: SplitText
           * restores the markup it recorded at split time, so reverting after
           * the write puts the previous minute back on screen.
           */
          const handle = this.textAnims.get(id);
          if (handle) {
            handle.split.revert();
            handle.stale = true;
          }
          inner.textContent = text;
        },
      });
    }

    /*
     * Tables, for the same reason and one more: a table with no rows is
     * indistinguishable from a table that failed to build, so the authored
     * snapshot has to be on screen before anything is played. That snapshot is
     * also what an export embeds and what covers a source outage — exports
     * snapshot, they do not stream.
     */
    for (const [id, node] of this.nodes) {
      if (node.layer.type !== 'table') continue;
      const block = new TableBlock({
        layer: node.layer,
        host: node.content,
        ctx,
        animator: gsap as unknown as TableAnimator,
        layerId: id,
      });
      const window = this.plan.windows.find((w) => w.layerId === id);
      this.tables.set(id, {
        block,
        anim: resolveRowAnim(node.layer.rowAnim),
        start: window?.in ?? 0,
        track: null,
        cellTrack: null,
        stale: false,
      });
    }

    /*
     * Split, then fit what is actually rendered.
     *
     * Splitting turns the text span's contents into a row of inline-blocks, and
     * that measures a few pixels wider than the shaped text it replaced because
     * the per-character boxes lose the kerning between them. On a 700px strap the
     * difference is about four pixels — small, and still four pixels of copy
     * hanging off the end of the bar.
     *
     * 0.37 fitted before splitting, on the argument that plain text is the
     * authored truth. It is, but it is not what goes to air: fitting has to
     * measure the boxes that will be on screen. So the split happens first and
     * the fit runs over the result.
     *
     * The pre-split fit is kept because it costs one layout and covers the case
     * where the split cannot run at all. Note the transform Fit Width writes is a
     * scale, which does not affect layout — so it cannot influence where
     * SplitText decides the lines fall, and the two passes cannot oscillate.
     */
    /*
     * A still fits once and stops.
     *
     * The split is what the second `refit` exists to correct for, so with no
     * split there is nothing for it to correct — running it again would be one
     * more forced layout for an identical answer.
     */
    this.refit();
    if (!this.still) {
      this.buildTextAnims();
      this.refit();
    }

    this.buildTimeline();
    // A freshly built timeline has never rendered, so the DOM still carries no
    // transforms. Paint frame 0 now or the graphic flashes un-animated for one
    // frame when it goes on air.
    this.renderAt(0);
    this.applyVisibilityWindows(0);
    this.videos.syncTo(0);

    /**
     * Fonts land after first paint. Straps mis-measure until then, and a crawl
     * sized against fallback metrics runs at the wrong speed and seams
     * visibly at the loop point — so both are recomputed once the real faces
     * are available.
     */
    const fontSet = (this.doc as Document & { fonts?: FontFaceSet }).fonts;
    if (fontSet?.ready) {
      void fontSet.ready.then(() => {
        if (this.destroyed) return;
        this.refit();

        /*
         * A still stops here.
         *
         * The refit above is kept and is the reason this handler still runs at
         * all: a strap measured against a fallback face overruns its bar, and
         * that is exactly as wrong in a thumbnail as on air. Everything below
         * exists so a *reveal* staggers correctly once the real metrics are
         * known — the crawl re-pad so a loop does not seam, the re-split so the
         * stagger lands on real line boundaries. A frame that never moves has
         * no stagger and no seam.
         *
         * Table blocks are the exception and fit below regardless: a cell
         * overruns its column in a still just as it does on air.
         */
        if (this.still) {
          for (const handle of this.tables.values()) handle.block.refit();
          return;
        }

        /*
         * Re-pad the crawls against the real faces — do NOT destroy them.
         *
         * This used to `destroy()` every loop and clear the map, on the
         * assumption that "nothing has scrolled yet — the graphic has not been
         * played". That assumption is false twice over, and both were on air:
         *
         *  - `destroy()` removes the two block elements, and nothing rebuilds a
         *    loop until something calls `crawlFor` again. In the editor, which
         *    never plays on its own, that left the ticker preview permanently
         *    empty — an empty `.bz-crawl-track` for the rest of the session.
         *  - With `?autoplay=1`, or an operator hitting PLAY on a cold browser
         *    source, play() happens before the fonts resolve. So this ran on a
         *    *rotating* crawl, killed its tween, removed its blocks, and the
         *    ticker vanished mid-show and never came back.
         *
         * `remeasure()` re-pads only a stopped loop; a running one re-measures at
         * its next seam by itself.
         */
        for (const loop of this.crawls.values()) loop.remeasure();
        /*
         * Re-split for the same reason, and it matters most for `lines`: where
         * the lines fall is a function of the real font's metrics, so a split
         * measured against a fallback face can group the words wrongly and the
         * reveal staggers by lines that do not exist on air.
         */
        this.markTextAnimsStale();
        this.resplitTextAnims();
        // The real faces change both the split and the width it occupies.
        this.refit();
        // Table cells fit against their own columns and are not in `refit`'s
        // node map — a long team name mis-measured against a fallback face
        // overruns its column exactly the way a strap does.
        for (const handle of this.tables.values()) handle.block.refit();
      });
    }
  }

  /* ------------------------------------------------------- text reveals */

  /**
   * Split every text layer that carries a reveal preset.
   *
   * Runs with the tree already in the document: SplitText has to measure to
   * decide where lines fall, and an element that is not laid out has no lines.
   */
  private buildTextAnims(): void {
    for (const [id, node] of this.nodes) {
      const layer = node.layer;
      if (layer.type !== 'text' || !node.textInner) continue;

      const preset = layer.textAnimPreset;
      const anim = resolveTextAnim(preset);
      if (!anim) {
        if (preset) {
          // Not silent: a preset that does not exist is an authoring mistake, and
          // the symptom on air — text that simply appears — looks like nothing
          // is wrong.
          console.warn(
            `[breeze] ${id}: unknown text preset "${String(preset.id)}" — the text will appear without a reveal`,
          );
        }
        continue;
      }

      const window = this.plan.windows.find((w) => w.layerId === id);
      this.textAnims.set(id, {
        anim,
        split: new SplitText(node.textInner, { type: SPLIT_TYPE[anim.unit] }),
        start: window?.in ?? 0,
        track: null,
        stale: false,
      });
    }
  }

  /** The pieces a preset animates, in document order. */
  private textAnimTargets(handle: TextAnimHandle): Element[] {
    const { split, anim } = handle;
    const pieces =
      anim.unit === 'chars' ? split.chars : anim.unit === 'words' ? split.words : split.lines;
    return pieces ?? [];
  }

  /**
   * Fill a reveal's child timeline.
   *
   * `from`, not `fromTo`: after the reveal the pieces sit at their natural
   * values, so text re-split later — by a live update, or by fonts arriving —
   * needs no end state applied to look right. It is already correct.
   *
   * `immediateRender: false` for the same reason the keyframe tweens use it, and
   * one more: a from-tween applies its start state the moment it is created, so
   * refilling this track while a graphic holds on air would blank the very text
   * the operator just typed.
   */
  private fillTextAnimTrack(handle: TextAnimHandle): void {
    const track = handle.track;
    if (!track) return;

    const targets = this.textAnimTargets(handle);
    if (!targets.length) return;

    track.from(
      targets,
      {
        ...handle.anim.from,
        duration: handle.anim.duration,
        ease: resolveEase(handle.anim.ease as Ease),
        stagger: handle.anim.stagger,
        immediateRender: false,
      },
      0,
    );
  }

  private markTextAnimsStale(): void {
    for (const handle of this.textAnims.values()) handle.stale = true;
  }

  /**
   * Re-fit after text content changed under us.
   *
   * Two passes normally: the split boxes are what will be on screen and they
   * measure a few pixels wider than the plain text they replaced, so the fit
   * has to run over the result. A still never splits, so the second pass is a
   * forced layout that can only produce the answer the first one already did.
   *
   * `resplitTextAnims` is itself a no-op in a still — `textAnims` is empty,
   * because `buildTextAnims` never ran — so this guard is about the *refit*,
   * which is the part that costs a layout.
   */
  private refitAfterTextChange(): void {
    this.refit();
    if (this.still) return;
    this.resplitTextAnims();
    this.refit();
  }

  /**
   * Re-split any text whose content changed, and rebuild its reveal.
   *
   * The caller re-fits afterwards: the split boxes are what will be on screen,
   * and they measure slightly wider than the plain text they replaced.
   */
  private resplitTextAnims(): void {
    for (const [id, handle] of this.textAnims) {
      if (!handle.stale) continue;
      const node = this.nodes.get(id);
      if (!node?.textInner) continue;

      handle.split = new SplitText(node.textInner, { type: SPLIT_TYPE[handle.anim.unit] });
      handle.stale = false;

      if (handle.track) {
        handle.track.clear();
        this.fillTextAnimTrack(handle);
      }
    }
  }

  /* -------------------------------------------------------------- tables */

  /**
   * Fill a table's row-reveal track.
   *
   * `from`, `immediateRender: false` — identical reasoning to the text reveals.
   * A from-tween applies its start state the instant it is created, so refilling
   * this track while a graphic holds on air would blank the rows an operator is
   * looking at.
   *
   * Row elements are addressed live rather than captured: the data behind a
   * table changes, and a track holding stale element references would animate
   * rows that have been removed from the DOM.
   */
  private fillTableTrack(handle: TableHandle): void {
    const track = handle.track;
    if (!track || !handle.anim) return;

    const targets = handle.block.rowElements;
    if (!targets.length) return;

    track.from(
      targets,
      {
        ...handle.anim.from,
        duration: handle.anim.duration,
        ease: resolveEase(handle.anim.ease as Ease),
        stagger: handle.anim.stagger,
        immediateRender: false,
      },
      0,
    );
  }

  /**
   * Fill a table's per-cell keyframe track.
   *
   * **One tween per cell per property, not one timeline per cell per row.**
   * That distinction is the whole reason this is affordable. Every row's copy
   * of a template cell goes into one target array and GSAP's own `stagger`
   * supplies the per-row offset, so a twenty-row standings table costs exactly
   * what a one-row table costs. The naive shape — a child timeline per cell per
   * row — is what kept this feature on the "later" pile.
   *
   * **Cell time zero is the row's arrival, not the table's.** The stagger below
   * is the row reveal's, deliberately: with a 0.05s row stagger and a cell
   * keyframe at 0.2s, row 20's cell would otherwise fire while row 20 is still
   * off-screen waiting its turn, spending the motion on empty space. A table
   * with no reveal has stagger 0 and every row moves together, which is the
   * same rule with nothing to offset.
   *
   * Baselines go on with a plain `gsap.set` for the same reason the composition's
   * do — a zero-duration tween at position 0 is reverted when the playhead is
   * rendered backwards onto 0, and an operator scrubbing to the top would find
   * the cells unstyled.
   */
  private fillCellTrack(handle: TableHandle): void {
    const track = handle.cellTrack;
    if (!track) return;

    const stagger = handle.anim?.stagger ?? 0;

    for (const cell of handle.block.animatedCells) {
      const targets = handle.block.cellElements(cell.id);
      if (!targets.length) continue;

      const motion = layerMotion(cell);

      /*
       * Every animated property is seeded, including the ones with no
       * keyframes. An animated cell is excluded from `staticTransform` in
       * `TableBlock.buildRow` — GSAP owns its transform outright — so if the
       * baseline for, say, `x` were not written here, a cell that keyframes
       * only its opacity would lose its authored horizontal position.
       */
      const baseline: Record<string, number> = {};
      for (const s of motion.sets) {
        const gsapProp = GSAP_PROP[s.prop];
        if (gsapProp) baseline[gsapProp] = s.value;
      }
      if (Object.keys(baseline).length) gsap.set(targets, baseline);

      for (const tw of motion.tweens) {
        const gsapProp = GSAP_PROP[tw.prop];
        // Filter properties are driven through a per-layer proxy, which has no
        // per-row equivalent — one proxy cannot hold twenty rows' blur values.
        // Transform and opacity cover every cell effect anyone has asked for.
        if (!gsapProp) continue;

        track.fromTo(
          targets,
          { [gsapProp]: tw.from },
          {
            [gsapProp]: tw.to,
            duration: tw.duration,
            ease: resolveEase(tw.ease as Ease),
            stagger,
            immediateRender: false,
          },
          tw.start,
        );
      }
    }
  }

  /**
   * Rebuild the reveal tracks of tables whose rows changed.
   *
   * Only rebuilds while the graphic has not yet played that part of the
   * timeline. Once the reveal is behind the playhead the rows are at rest, and
   * refilling the track would re-apply a `from` state to rows already on air —
   * the table would blink every time the feed ticked. Rows arriving late animate
   * themselves, on their own clock, inside `TableBlock.render`.
   *
   * The boundary is `<=`, not `<`. A table with no in-point has `start === 0`,
   * and the constructor's own seed `update()` runs with the playhead at exactly
   * 0 — so a strict comparison skipped the very first refill and left the track
   * holding the authored rows, which had just been replaced and removed from the
   * DOM. The reveal then animated nothing and the seeded rows appeared with no
   * stagger at all.
   */
  private refreshTableTracks(): void {
    let refilled = false;

    for (const handle of this.tables.values()) {
      if (!handle.stale) continue;
      handle.stale = false;
      if (!handle.track) continue;
      if (this.tl.time() > handle.start + 1e-4) continue;
      handle.track.clear();
      this.fillTableTrack(handle);
      /*
       * The cell track is refilled on the same condition and for the same
       * reason. It also has a second obligation the reveal does not: a rebuilt
       * row is a *new* element with no transform on it at all, because animated
       * cells are skipped by `staticTransform`. Refilling re-applies the
       * baselines, so a re-sort cannot leave a cell stacked at the row origin.
       */
      handle.cellTrack?.clear();
      this.fillCellTrack(handle);
      refilled = true;
    }

    /*
     * Re-render so the refilled `from` state actually lands on the new rows.
     *
     * `immediateRender: false` means a from-tween applies nothing until the
     * timeline renders through it — which is what stops a live update blanking
     * text on air, and is also why the seeded rows were appearing fully visible
     * with no stagger: the constructor renders frame 0 before its own seed
     * `update()` runs, so nothing had rendered since the track was rebuilt.
     *
     * Only while paused. A running timeline renders on its next tick by itself,
     * and forcing a seek under it would fight the playhead.
     */
    if (refilled && this.tl.paused()) this.renderAt(this.tl.time());
  }

  /** Push a DataSet to every table bound to `sourceId`. */
  /**
   * The DataSet currently held for a source, if any.
   *
   * Read-only view of the cache. A table's rows can be read back off the DOM,
   * but a crawl's cannot — it adopts new copy a rotation later, so between a
   * push and the next loop seam the only honest answer to "did that data
   * arrive?" lives here. The debug overlay and the e2e suite both need to ask.
   */
  datasetFor(sourceId: string): DataSet | undefined {
    return this.datasets.get(sourceId);
  }

  /** Source ids this runtime has received data for. */
  get dataSourceIds(): string[] {
    return [...this.datasets.keys()];
  }

  /**
   * Populate the DataSet cache from the initial `$data` payload, without
   * touching any layers — nothing is built yet when this runs.
   */
  private seedDatasets(): void {
    const push = this.data[DATA_UPDATE_KEY];
    if (!push || typeof push !== 'object') return;
    for (const [sourceId, value] of Object.entries(push as Record<string, unknown>)) {
      const set = toDataSet(value, sourceId);
      if (set) this.datasets.set(sourceId, set);
    }
  }

  private applyDataSet(sourceId: string, data: DataSet): void {
    this.datasets.set(sourceId, data);
    for (const [id, handle] of this.tables) {
      const layer = this.nodes.get(id)?.layer;
      if (layer?.type !== 'table' || layer.source !== sourceId) continue;
      if (handle.block.setDataSet(data)) handle.stale = true;
    }

    /*
     * Crawls bound to the same source. An RSS feed's natural consumer is a
     * ticker, so this is the Wave-2 path that makes a headline crawl work
     * without an operator retyping anything.
     *
     * `setItems` queues rather than applies — the loop swaps the new list in at
     * the seam — so a feed that updates mid-rotation does not make the ticker
     * jump. That is the same guarantee an operator edit already had; a data push
     * gets it for free by going through the same call.
     */
    for (const [id, node] of this.nodes) {
      const layer = node.layer;
      if (layer.type !== 'crawl' || layer.source !== sourceId || !layer.column) continue;
      this.crawlFor(id)?.setItems(crawlItemsFrom(data, layer));
    }
  }

  private proxyFor(layerId: string): FilterProxy {
    let p = this.proxies.get(layerId);
    if (!p) {
      p = { blur: 0, brightness: 1, maskOffset: 0 };
      this.proxies.set(layerId, p);
    }
    return p;
  }

  private buildTimeline(): void {
    this.tl = gsap.timeline({
      paused: true,
      onUpdate: () => this.onTick(),
      onComplete: () => this.onComplete(),
    });

    /**
     * Baselines are applied with a plain `gsap.set()` rather than `tl.set(…, 0)`.
     * A zero-duration tween sitting at position 0 gets *reverted* when the
     * playhead is rendered backwards onto 0, which left the graphic unstyled
     * whenever an operator scrubbed or replayed from the top. Applying them
     * outside the timeline makes frame 0 stable; tweens carry explicit `from`
     * values, so scrubbing still resolves every property correctly.
     */
    for (const s of this.plan.sets) {
      const node = this.nodes.get(s.layerId);
      if (!node) continue;
      const gsapProp = GSAP_PROP[s.prop];

      if (s.at > 0) {
        if (gsapProp) this.tl.set(node.el, { [gsapProp]: s.value }, s.at);
        else {
          const proxy = this.proxyFor(s.layerId);
          this.tl.set(proxy, { [s.prop]: s.value, onUpdate: () => this.applyProxy(s.layerId) }, s.at);
        }
        continue;
      }

      if (gsapProp) {
        gsap.set(node.el, { [gsapProp]: s.value });
      } else {
        const proxy = this.proxyFor(s.layerId);
        proxy[s.prop as keyof FilterProxy] = s.value;
        this.applyProxy(s.layerId);
      }
    }

    for (const tw of this.plan.tweens) {
      const node = this.nodes.get(tw.layerId);
      if (!node) continue;
      const ease = resolveEase(tw.ease as Ease);
      const gsapProp = GSAP_PROP[tw.prop];

      if (gsapProp) {
        this.tl.fromTo(
          node.el,
          { [gsapProp]: tw.from },
          { [gsapProp]: tw.to, duration: tw.duration, ease, immediateRender: false },
          tw.start,
        );
      } else {
        const proxy = this.proxyFor(tw.layerId);
        this.tl.fromTo(
          proxy,
          { [tw.prop]: tw.from },
          {
            [tw.prop]: tw.to,
            duration: tw.duration,
            ease,
            immediateRender: false,
            onUpdate: () => this.applyProxy(tw.layerId),
          },
          tw.start,
        );
      }
    }

    /*
     * Text reveals, each in its own child timeline parented at the layer's
     * in-point. Authored keyframes on the same layer still move the layer as a
     * whole; the reveal moves the pieces inside it, so the two compose rather
     * than fight — a strap can slide in while its characters rise.
     */
    for (const handle of this.textAnims.values()) {
      handle.track = gsap.timeline();
      this.fillTextAnimTrack(handle);
      this.tl.add(handle.track, handle.start);
    }

    /*
     * Table row reveals, parented the same way. The table layer's own keyframes
     * still move the table as a whole, so a standings panel can slide in with
     * its rows rising inside it — the two compose rather than fight.
     */
    for (const handle of this.tables.values()) {
      handle.track = gsap.timeline();
      this.fillTableTrack(handle);
      this.tl.add(handle.track, handle.start);

      /*
       * Cell keyframes, parented at the same point and added second so they
       * paint over the reveal rather than under it. A table whose cells carry
       * no keyframes gets an empty timeline and costs nothing — the whole
       * feature is inert for every table that does not use it.
       */
      handle.cellTrack = gsap.timeline();
      this.fillCellTrack(handle);
      this.tl.add(handle.cellTrack, handle.start);
    }

    // Pad the timeline so a composition whose last keyframe is early still
    // holds its final frame for the authored duration.
    if (this.plan.duration > this.tl.duration()) {
      this.tl.set({}, {}, this.plan.duration);
    }
  }

  /**
   * Force a render at `time`.
   *
   * GSAP skips work when the requested time equals the current one, so seeking
   * to a position the timeline is already parked at is a no-op — which leaves
   * a never-rendered timeline showing unstyled DOM. Nudging past the target and
   * back guarantees a paint at exactly `time`.
   */
  private renderAt(time: number): void {
    const target = Math.max(0, Math.min(time, this.tl.duration()));
    this.tl.time(target + 1e-5, false);
    this.tl.time(target, false);
  }

  private applyProxy(layerId: string): void {
    const node = this.nodes.get(layerId);
    const proxy = this.proxies.get(layerId);
    if (!node || !proxy) return;

    node.el.style.filter = composeFilter(node.layer, {
      blur: proxy.blur,
      brightness: proxy.brightness,
    });

    this.masks.get(layerId)?.setOffset(proxy.maskOffset);
  }

  /* ------------------------------------------------------------ playback */

  private onTick(): void {
    const t = this.tl.time();

    this.applyVisibilityWindows(t);

    if (this.state === 'playing-in' && this.pendingHold !== null && t >= this.pendingHold - 1e-4) {
      const holdAt = this.pendingHold;
      // State flips BEFORE the seek: `time()` renders synchronously and
      // re-enters onTick, which would otherwise fire a second `hold` event.
      this.state = 'holding';
      this.pendingHold = null;
      this.tl.pause();
      this.tl.time(holdAt, false);
      this.videos.tick(holdAt);
      this.emit('hold');
      return;
    }

    if (this.videos.size) this.videos.tick(t);
    this.emit('timeupdate');
  }

  private onComplete(): void {
    this.state = 'finished';
    this.stopCrawls();
    this.videos.pause();
    this.emit('finished');
  }

  private applyVisibilityWindows(time: number): void {
    for (const w of this.plan.windows) {
      const node = this.nodes.get(w.layerId);
      if (!node) continue;
      if (node.layer.visible === false) {
        node.el.dataset['hidden'] = '1';
        continue;
      }
      const inside = time >= w.in && time <= w.out;
      if (inside) delete node.el.dataset['hidden'];
      else node.el.dataset['hidden'] = '1';
    }
  }

  /** Start the intro, or resume toward the next STOP marker. */
  play(): void {
    if (this.destroyed) return;

    /*
     * PLAY walks the graphic forward.
     *
     * From a hold it resumes toward the next STOP marker; with no marker left
     * it runs the outro, so repeated PLAY steps a graphic all the way through
     * in → hold → out. That is the one-button workflow, and it is what an
     * operator pressing the same key expects.
     *
     * A graphic already rolling in is left alone, so a double-press cannot
     * stutter the intro. Everything else rewinds first — including anything
     * parked at the very end, which is what stops the runtime wedging in a
     * state it cannot play out of.
     *
     * "Already rolling" means the timeline is actually running, not merely that
     * `state` still says `playing-in`. `seek()` deliberately leaves the state
     * alone — scrubbing must not take a graphic off air — so the editor
     * pausing mid-intro parks a paused timeline in `playing-in`. Testing
     * the state alone made this guard swallow the next PLAY entirely: the
     * transport read as playing while the clock never moved. Ask the timeline.
     */
    if (this.state === 'playing-in' && !this.tl.paused()) return;

    const atEnd = this.tl.time() >= this.tl.duration() - 1e-4;
    if (this.state === 'finished' || this.state === 'idle' || this.state === 'playing-out' || atEnd) {
      this.tl.pause();
      this.renderAt(0);
      this.applyVisibilityWindows(0);
    }
    this.pendingHold = nextHoldAfter(this.plan, this.tl.time());
    this.state = 'playing-in';
    this.startCrawls();
    this.videos.play(this.tl.time());
    this.tl.play();
    this.emit('play');
  }

  /**
   * Run the outro. Remaining STOP markers are ignored — an operator hitting
   * STOP wants the graphic off, not the next step.
   */
  stop(): void {
    if (this.destroyed) return;

    /*
     * Nothing to take off air when it is already off, or already on its way.
     *
     * Previously only `idle` was guarded, so a second STOP from `finished`
     * flipped the state to `playing-out` and called `play()` on a timeline
     * parked at its end. Nothing ran, `onComplete` never fired again, and the
     * runtime sat in `playing-out` — from which `play()` refused to rewind. The
     * graphic could not be brought back without a CLEAR, which is exactly the
     * sort of dead end an operator hits by pressing STOP twice out of caution.
     */
    if (this.state === 'idle' || this.state === 'finished' || this.state === 'playing-out') return;

    this.pendingHold = null;
    this.state = 'playing-out';
    this.videos.play(this.tl.time());
    this.tl.play();
    this.emit('stop');
  }

  /** Advance to the next STOP marker; behaves like stop() when none remain. */
  next(): void {
    if (this.destroyed) return;

    /*
     * A table with more rows than fit consumes NEXT before the timeline sees it.
     *
     * Only while holding. Pages are not steps — a step is a STOP marker, so
     * `stepCount()` stays marker-only — and the graphic
     * advances internally on the same verb an operator is already pressing.
     * Gated on `holding` because during the intro NEXT means "skip to the next
     * marker", and a table quietly eating that press would strand the graphic
     * mid-animation with no way forward.
     */
    if (this.state === 'holding' && this.advanceTables()) {
      this.emit('update');
      return;
    }

    const upcoming = nextHoldAfter(this.plan, this.tl.time());
    if (upcoming === null) {
      this.stop();
      return;
    }
    this.pendingHold = upcoming;
    this.state = 'playing-in';
    this.startCrawls();
    this.videos.play(this.tl.time());
    this.tl.play();
    this.emit('play');
  }

  /**
   * Preview transport: run from the playhead to the end, ignoring STOP markers.
   *
   * Authoring and playout want different things from a play button. On air the
   * holds are the point; while building an animation they are an interruption —
   * you want to watch the whole thing. This is the editor's ▶, kept separate
   * from `play()` so neither has to compromise.
   */
  playThrough(): void {
    if (this.destroyed) return;

    if (this.tl.time() >= this.tl.duration() - 1e-4) {
      this.tl.pause();
      this.renderAt(0);
      this.applyVisibilityWindows(0);
    }

    this.pendingHold = null;
    this.state = 'playing-in';
    this.startCrawls();
    this.videos.play(this.tl.time());
    this.tl.play();
    this.emit('play');
  }

  /** Hard reset to frame 0, nothing on screen. */
  clear(): void {
    this.state = 'idle';
    this.pendingHold = null;
    this.tl.pause();
    this.renderAt(0);
    this.stopCrawls();
    this.videos.syncTo(0);
    this.applyVisibilityWindows(0);
    this.emit('stop');
  }

  /** Seek without changing playback state — editor scrubbing, thumbnails. */
  seek(time: number): void {
    this.tl.pause();
    this.renderAt(time);
    this.applyVisibilityWindows(this.tl.time());
    this.videos.syncTo(this.tl.time());
    this.emit('timeupdate');
  }

  /* -------------------------------------------------------- dynamic data */

  /** Replace bound field values live. Safe to call while on air. */
  update(data: BindingData, opts: { silent?: boolean } = {}): void {
    if (this.destroyed) return;
    this.data = { ...this.data, ...data };

    /*
     * Data-source pushes ride the same verb as operator field edits — one
     * rebind path, no second socket protocol. The reserved
     * `$data` key carries `{ [sourceId]: DataSet }`; everything else is a
     * dynamic field and falls through to the layer loop below.
     */
    if (DATA_UPDATE_KEY in data) {
      const push = data[DATA_UPDATE_KEY];
      if (push && typeof push === 'object') {
        for (const [sourceId, value] of Object.entries(push as Record<string, unknown>)) {
          const set = toDataSet(value, sourceId);
          if (set) this.applyDataSet(sourceId, set);
        }
      }
    }

    for (const node of this.nodes.values()) {
      const layer = node.layer;
      if (!('binding' in layer) || !layer.binding) continue;
      if (!(layer.binding in data)) continue;

      // A nested instance whose enclosing composition layer pinned this field
      // keeps its override — that is what makes the same badge reusable with
      // different text in the same graphic.
      if (node.instance.pinnedBindings.has(layer.binding)) continue;

      this.applyBinding(node, data[layer.binding]);
    }

    this.refitAfterTextChange();
    this.refreshTableTracks();
    if (!opts.silent) this.emit('update');
  }

  /**
   * The shared clock timer, created on first use.
   *
   * `onChange` runs the same post-write pass an operator edit does. It is not
   * `update()` — a clock tick is not a dynamic-field change, must not merge
   * into `this.data`, and must not emit `update` to listeners: the editor
   * treats that as a document change and would mark the project dirty once a
   * second forever.
   */
  private clockTicker(): ClockTicker {
    if (!this.clocks) {
      this.clocks = new ClockTicker(() => {
        if (this.destroyed) return;
        this.refitAfterTextChange();
      });
    }
    return this.clocks;
  }

  private applyBinding(node: LayerNodes, value: unknown): void {
    const layer = node.layer;
    switch (layer.type) {
      case 'text': {
        if (!node.textInner) break;
        /*
         * Revert the split BEFORE writing, then mark it for re-splitting.
         *
         * Order is not cosmetic here. SplitText.revert() restores the markup it
         * recorded when it split — so reverting *after* writing new text would
         * put the old name back and quietly discard what the operator just typed,
         * live on air.
         */
        const handle = this.textAnims.get(node.instance.id);
        if (handle) {
          handle.split.revert();
          handle.stale = true;
        }
        node.textInner.textContent = stringify(value);
        break;
      }
      case 'image':
      case 'video':
        if (node.media && typeof value === 'string' && value) {
          node.media.src = this.resolveAsset(value);
        }
        break;
      case 'crawl': {
        // Queued, not applied: the loop swaps it in at the seam so the ticker
        // never jumps under an operator mid-show.
        const items = Array.isArray(value) ? value.map(stringify) : [stringify(value)];
        this.crawlFor(node.instance.id)?.setItems(items);
        break;
      }
      case 'table': {
        const handle = this.tables.get(node.instance.id);
        if (!handle) break;
        // Declared columns win over inferred ones: a playout server pushing
        // bare rows must not be able to retype a numeric column as text and
        // send the standings into alphabetical order on air.
        const set = toDataSet(value, layer.source ?? node.instance.id, layer.data?.columns);
        if (set && handle.block.setDataSet(set)) handle.stale = true;
        break;
      }
      default:
        break;
    }
  }

  /**
   * Re-run Fit Width on every text layer. Cheap; called after data changes.
   * Returns the layers whose text still overflows after scaling, so the editor
   * (Phase 2) and the debug overlay can warn about a strap that is too short
   * for the name it has been given.
   */
  refit(): Map<string, FitResult> {
    const results = new Map<string, FitResult>();

    for (const [id, node] of this.nodes) {
      if (node.layer.type !== 'text' || !node.textInner) continue;

      /*
       * Un-hide for the measurement, then put it back.
       *
       * A layer outside its visibility window is `display: none`, and nothing
       * inside a display:none subtree has a width. Fit Width therefore measured 0
       * and concluded the text fitted — so a name typed in before the graphic
       * went on air, which is the normal workflow, was never scaled and overran
       * its strap the moment the layer appeared. The bug was invisible in the
       * demos because their straps have no in-point.
       *
       * Inline `display` outranks the attribute selector that hides it. This
       * forces a synchronous layout, which is why it happens on update and build
       * rather than per frame. A layer hidden by an *ancestor* — a nested
       * composition outside its own window — still measures 0 and is caught by
       * the guard in `applyTextFit`.
       */
      const hidden = node.el.dataset['hidden'] === '1';
      if (hidden) node.el.style.display = 'block';
      const result = applyTextFit(node.textInner, node.layer.fit, node.layer.size?.width ?? 0);
      if (hidden) node.el.style.display = '';

      results.set(id, result);

      if (result.overflow) node.el.dataset['fitOverflow'] = '1';
      else delete node.el.dataset['fitOverflow'];
    }

    this.fitResults = results;
    return results;
  }

  /**
   * How many pieces a text layer's reveal animates, or 0 if it has no reveal.
   *
   * Only the runtime can answer this: the count depends on where the lines fall,
   * which depends on the real font and the real box. The editor needs it to show
   * what a preset actually costs in time — a stagger that reads well on a
   * one-word strap can overrun the hold on a full name.
   */
  textAnimPieces(layerId: string): number {
    const handle = this.textAnims.get(layerId);
    if (!handle) return 0;
    return this.textAnimTargets(handle).length;
  }

  /** Piece counts for every text layer carrying a reveal. */
  get textAnimPieceCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, handle] of this.textAnims) out[id] = this.textAnimTargets(handle).length;
    return out;
  }

  /** Text layers whose content is wider than their box even after scaling. */
  get overflowingTextLayers(): string[] {
    return [...this.fitResults.entries()].filter(([, r]) => r.overflow).map(([id]) => id);
  }

  getFitResult(layerId: string): FitResult | undefined {
    return this.fitResults.get(layerId);
  }

  /* --------------------------------------------------------- table pages */

  /**
   * Step every paged table on. True when at least one had somewhere to go.
   *
   * All of them together, not one at a time: two tables in a graphic are two
   * halves of one readout (conference East and West), and paging them out of
   * step would show page 2 beside page 1.
   */
  private advanceTables(): boolean {
    let advanced = false;
    for (const handle of this.tables.values()) {
      if (handle.block.nextPage()) advanced = true;
    }
    return advanced;
  }

  /** Current page and page count per table layer, for the operator panel. */
  get tablePages(): Record<string, { page: number; pageCount: number; rows: number }> {
    const out: Record<string, { page: number; pageCount: number; rows: number }> = {};
    for (const [id, handle] of this.tables) {
      out[id] = {
        page: handle.block.currentPage,
        pageCount: handle.block.pageCount,
        rows: handle.block.totalRows,
      };
    }
    return out;
  }

  /** Table layers holding more rows than their page shows. */
  get overflowingTables(): string[] {
    return [...this.tables.entries()].filter(([, h]) => h.block.overflow).map(([id]) => id);
  }

  /** Rows a table currently renders — what the editor previews and tests assert. */
  getTableRows(layerId: string): DataRow[] {
    return this.tables.get(layerId)?.block.visibleRows ?? [];
  }

  /* --------------------------------------------------------------- crawl */

  /**
   * Crawls own their own clock, deliberately.
   *
   * A ticker rotates continuously regardless of where the composition playhead
   * sits — it is not keyframed, and tying it to the timeline would make it stop
   * whenever the graphic holds on air.
   */
  private crawlFor(layerId: string): CrawlLoop | undefined {
    const existing = this.crawls.get(layerId);
    if (existing) return existing;

    const node = this.nodes.get(layerId);
    if (!node?.crawlTrack || node.layer.type !== 'crawl') return undefined;

    const loop = new CrawlLoop({
      viewport: node.crawlTrack.parentElement ?? node.el,
      track: node.crawlTrack,
      speed: node.layer.speed,
      direction: node.layer.direction,
      separator: node.layer.separator ?? DEFAULT_CRAWL_SEPARATOR,
      animator: gsap as unknown as CrawlAnimator,
    });

    /*
     * A source-bound crawl starts from the DataSet if one has already arrived —
     * which, on a /play page, it has: the server inlines current datasets into
     * the boot payload precisely so a graphic is never briefly wrong on load.
     * Falling back to `items` covers the authoring case and the feed that has
     * not answered yet.
     */
    const layer = node.layer;
    const seeded = layer.source && layer.column ? this.datasets.get(layer.source) : undefined;
    loop.setItems(seeded ? crawlItemsFrom(seeded, layer) : layer.items);

    this.crawls.set(layerId, loop);
    return loop;
  }

  private startCrawls(): void {
    for (const [id, node] of this.nodes) {
      if (node.layer.type !== 'crawl') continue;
      this.crawlFor(id)?.start();
    }
  }

  private stopCrawls(): void {
    for (const loop of this.crawls.values()) loop.stop();
  }

  /* --------------------------------------------------------- view / info */

  /** Scale the stage to fit its container (editor preview). */
  fitToContainer(): number {
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    if (!cw || !ch) return 1;
    const scale = Math.min(cw / this.composition.stage.width, ch / this.composition.stage.height);
    this.root.style.transform = `scale(${scale})`;
    return scale;
  }

  setViewportScale(scale: number): void {
    this.root.style.transform = `scale(${scale})`;
  }

  get element(): HTMLElement {
    return this.root;
  }

  get currentTime(): number {
    return this.tl.time();
  }

  get duration(): number {
    return this.tl.duration();
  }

  get playbackState(): PlaybackState {
    return this.state;
  }

  get stepCount(): number {
    return schemaStepCount(this.composition);
  }

  /** 0 before the first STOP marker, 1 after it, and so on. */
  get currentStep(): number {
    const t = this.tl.time();
    return this.plan.holds.filter((h) => t >= h - 1e-4).length;
  }

  get bindings() {
    return collectBindings(this.composition);
  }

  /** Unresolved refs, cycles and depth cut-offs found while expanding. */
  get warnings(): ExpandWarning[] {
    return this.plan.warnings;
  }

  /** Namespaced ids of every layer, nested compositions expanded. */
  get layerIds(): string[] {
    return this.plan.order;
  }

  getLayerElement(layerId: string): HTMLElement | undefined {
    return this.nodes.get(layerId)?.el;
  }

  /**
   * The first on-screen copy of a row-template cell, in any table.
   *
   * A cell has no entry in `nodes`: it is not one element but one per data row,
   * built by `TableBlock` under a synthetic instance id. The editor still needs
   * *an* element to point at so a selected cell can be outlined on the stage —
   * without this, clicking a cell in the layers panel highlighted nothing and
   * the selection looked broken.
   *
   * Deliberately the first row's copy and deliberately read-only. It is a
   * representative, not the layer: whatever the editor does with it must not be
   * written back through it, because the same authored cell is also the other
   * nineteen rows, and its transform belongs to GSAP or to
   * `TableBlock.staticTransform` — never to a third writer.
   *
   * Rebuilt from the live DOM on every call, like `cellElements` itself: a
   * re-sort, a page turn or a feed tick replaces row elements, and a cached
   * node would be one that has already left the document.
   */
  getCellElement(cellLayerId: string): HTMLElement | undefined {
    for (const handle of this.tables.values()) {
      const [first] = handle.block.cellElements(cellLayerId);
      if (first) return first;
    }
    return undefined;
  }

  getLayer(layerId: string): Layer | undefined {
    return this.nodes.get(layerId)?.layer;
  }

  /* -------------------------------------------------------------- events */

  on(event: RuntimeEvent, listener: RuntimeListener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  private emit(event: RuntimeEvent): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    const payload: RuntimePayload = {
      state: this.state,
      time: this.tl ? this.tl.time() : 0,
      step: this.currentStep,
      data: this.data,
    };
    for (const listener of set) listener(payload);
  }

  /* ------------------------------------------------------------- cleanup */

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopCrawls();
    // Before the tree goes: an interval holding a closure over a removed
    // element is the editor's rebuild-per-keystroke leak, one timer at a time.
    this.clocks?.destroy();
    this.clocks = null;
    this.videos.destroy();
    for (const mask of this.masks.values()) mask.destroy();
    this.masks.clear();
    /*
     * Revert the splits before the tree goes.
     *
     * The root is removed a few lines below, so nothing here is visible — but the
     * editor rebuilds a runtime on every edit, and a SplitText left un-reverted
     * keeps its own listeners and its record of the original markup alive. Over a
     * session of typing that is a leak per keystroke.
     */
    for (const handle of this.textAnims.values()) {
      handle.track?.kill();
      handle.split.revert();
    }
    this.textAnims.clear();
    for (const handle of this.tables.values()) {
      handle.track?.kill();
      handle.block.destroy();
    }
    this.tables.clear();
    this.datasets.clear();
    this.tl.kill();
    this.listeners.clear();
    this.nodes.clear();
    this.proxies.clear();
    this.root.remove();
  }
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

