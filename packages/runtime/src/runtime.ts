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
  MODE_UPDATE_KEY,
  transformSources,
  transformsUseClock,
  resolveRules,
  type RuleContext,
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
  type TableCycle,
} from '@breeze/schema';

import { ClockTicker } from './clock.js';
import {
  cycleEnabled,
  cyclePosition,
  pageDurations,
  type CycleAnchor,
} from './cycle.js';
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
import { playerOf, stopMediaIn } from './media.js';
import { applyMaskReference, createMask, createMaskHost, type MaskHandle } from './mask.js';
import { buildPlan, defaultFor, layerMotion, nextHoldAfter, type TimelinePlan } from './plan.js';
import { applyRuleResult, setRuleBaseSrc } from './rules.js';
import { injectRuntimeStyles } from './styles.js';
import {
  TableBlock,
  resolveRowAnim,
  toDataSet,
  type ResolvedRowAnim,
  type TableAnimator,
} from './table.js';
import { resolveTextAnim, type ResolvedTextAnim } from './textanim.js';
import { SpriteSync } from './sprite.js';
import { PosterSync } from './poster.js';
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
  /** Self-paging state; null for a table with no `cycle`. */
  cycle: CycleState | null;
  /**
   * The table this one follows (CYCLE.md, Wave 4), resolved once after the
   * build; null when it follows nothing or its leader could not be found.
   */
  leader: string | null;
}

/**
 * Where a self-paging table is in its cycle.
 *
 * `anchor` is null until the graphic first reaches a hold: cycling runs only
 * while a graphic holds on air, and anchoring at that moment is what makes the
 * first page an audience sees the first page.
 */
interface CycleState {
  config: TableCycle;
  anchor: CycleAnchor | null;
  /** Frozen by an operator. The anchor is kept; `resume` re-anchors. */
  held: boolean;
  /** A `hold` / `continue` cycle that has finished its last page. */
  done: boolean;
  /**
   * The page on screen and when it arrived, so a data change can re-anchor on
   * the page the audience is looking at without restarting its time.
   */
  shown: CycleAnchor;
}

/**
 * One table's paging, as a control surface sees it.
 *
 * `table` is the address a caller aims commands with — the binding, or
 * `<mount>.<binding>` inside a nested composition, or the layer id for a table
 * with no binding — so what a panel reads back is exactly what it can send.
 */
export interface TableState {
  table: string;
  layerId: string;
  page: number;
  pageCount: number;
  rows: number;
  /** The page's name (see `TableCycle.keyColumn`), or null when it has none. */
  key: string | null;
  /** A cycle is configured — whether hold and resume mean anything here. */
  hasCycle: boolean;
  /** Actually turning pages right now: enabled, more than one page, on air, not held. */
  cycling: boolean;
  held: boolean;
  /** Seconds to the next turn while cycling; null otherwise. */
  secondsLeft: number | null;
  group?: string;
  /** The address of the table this one follows, when it follows one. */
  follows?: string;
}

/** Where `goToPage` should go: a 1-based page number, or a page key. */
export interface PageTarget {
  n?: number;
  key?: string;
}

/**
 * What another output said it was showing — the playback report an output page
 * sends the hub — for `joinAt` to take up (0.74.1).
 *
 * The same shape as the report, so the hub relays it untouched, plus how old it
 * is. Reports are sent on events (play, hold, page turn), not on a timer, so a
 * report can be several seconds old when it is read; the cycle is solved from
 * an anchor, so an age is all it takes to land on the page that output is on
 * now rather than the page it was on then.
 */
export interface JoinReport {
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
  /** Milliseconds between the report being made and now. Absent is 0. */
  ageMs?: number;
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
  | 'timeupdate'
  /** A table turned a page — by its cycle or by a command. */
  | 'page';

export type RuntimeListener = (payload: RuntimePayload) => void;

export interface RuntimePayload {
  state: PlaybackState;
  time: number;
  step: number;
  data: BindingData;
}

/** How long before a cycle's turn its next page's media is fetched (Wave 8). */
const MEDIA_PRELOAD_LEAD_MS = 4000;

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
  /**
   * Where hls.js can be loaded from, for a media layer playing an HLS stream
   * in a browser that cannot play HLS itself (Wave 8). Absent: such a stream
   * fails, and the layer does what its `onError` says.
   */
  hlsScript?: string;
  /**
   * Play media layers while the graphic is off air too. The editor's stage
   * wants the picture while authoring; an output must not hold camera
   * connections — or make sound — for a graphic nobody has taken to air.
   */
  mediaWhenIdle?: boolean;
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

/**
 * Filter/mask props that ride the GSAP proxy path rather than a real CSS
 * property — see `proxyFor`. Kept as one list so the proxy's shape and its
 * defaults cannot drift apart (MASKS.md §3.3).
 */
const FILTER_PROXY_PROPS = [
  'blur', 'brightness', 'contrast', 'saturate', 'hueRotate', 'grayscale', 'sepia', 'maskOffset',
] as const satisfies readonly AnimatableProp[];

type FilterProxyProp = (typeof FILTER_PROXY_PROPS)[number];

type FilterProxy = Record<FilterProxyProp, number>;

let instanceCounter = 0;

export class BreezeRuntime {
  readonly composition: Composition;
  readonly plan: TimelinePlan;

  private readonly container: HTMLElement;
  private readonly doc: Document;
  private readonly resolveAsset: (src: string) => string;
  private readonly hlsScript: string | undefined;
  private readonly mediaWhenIdle: boolean;
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
  /**
   * Video layers in a still, which are `<img>` elements rather than media.
   *
   * Always empty on a playing runtime and `videos` is always empty on a still,
   * so the two never both have work to do — but both are asked, because the
   * alternative is a `this.still` branch at every one of the five places a
   * playhead moves.
   */
  private posters = new PosterSync();
  private sprites = new SpriteSync();
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

  private stateValue: PlaybackState = 'idle';
  /**
   * Every change of playback state goes through here, so live media follows
   * the graphic on and off air (Wave 8) without each transition having to
   * remember to tell it.
   */
  private get state(): PlaybackState {
    return this.stateValue;
  }
  private set state(next: PlaybackState) {
    const was = this.mediaLive();
    this.stateValue = next;
    if (this.mediaLive() !== was) this.syncMediaLive();
  }
  private pendingHold: number | null = null;
  /**
   * One timer for every self-paging table, armed for the soonest turn.
   *
   * Not a ticker: a cycle's next turn is known exactly, so waking every frame to
   * ask would be sixty questions a second with one answer. Null whenever the
   * graphic is not holding, which is the only state cycles run in.
   */
  private cycleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Warms the next page's media ahead of a cycle's turn (Wave 8). */
  private preloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive `skip`s per table since anything last played. */
  private readonly mediaSkips = new Map<string, number>();
  /** Re-runs `date` transforms as the clock moves — see `startClockTransforms`. */
  private transformTimer: ReturnType<typeof setInterval> | null = null;
  private data: BindingData = {};
  /** The channel's mode (Wave 6) — what `mode` rule conditions read. '' is none. */
  private modeValue = '';
  private destroyed = false;

  constructor(options: RuntimeOptions) {
    instanceCounter += 1;
    this.uid = `r${instanceCounter}`;
    this.container = options.container;
    this.doc = options.container.ownerDocument;
    this.composition = options.composition;
    this.resolveAsset = options.resolveAsset ?? ((s) => s);
    this.hlsScript = options.hlsScript;
    this.mediaWhenIdle = options.mediaWhenIdle === true;
    this.scaleMode = options.scaleMode ?? 'none';
    this.still = options.still ?? false;
    this.plan = buildPlan(options.composition, { resolve: options.resolveComposition });
    this.data = { ...(options.data ?? {}) };
    // Read before `build()`, like the datasets below: a cell rule on the mode is
    // evaluated as its first row is written.
    if (MODE_UPDATE_KEY in this.data) this.modeValue = String(this.data[MODE_UPDATE_KEY] ?? '');

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
    else this.refreshRules();
    this.startClockTransforms();
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

    const ctx: BuildContext = {
      doc: this.doc,
      resolveAsset: this.resolveAsset,
      still: this.still,
      ...(this.hlsScript ? { hlsScript: this.hlsScript } : {}),
      isLive: () => this.mediaLive(),
    };

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
          /*
           * Always the stage, never `instance.layer.size`.
           *
           * `maskUnits` is `userSpaceOnUse`, so the region and the mask shape
           * share one coordinate space and the region's only job is to be big
           * enough — the shape carries the geometry (MASKS.md §2.3). Deriving
           * it from the layer used to make a mask on an unsized layer (text
           * has no `size`) fall back to the stage and look right by accident,
           * then cut off square the moment the same mask was given to a sized
           * layer. Measuring the element instead would be worse: a layer with
           * an in-point is `display:none` at build time and measures
           * `offsetWidth 0`, which would mask a not-yet-visible layer to
           * nothing the instant it entered.
           */
          { width: this.composition.stage.width, height: this.composition.stage.height },
          this.resolveAsset,
        );
        applyMaskReference(nodes.el, handle.reference);
        this.masks.set(instance.id, handle);
      }

      if (nodes.video && instance.layer.type === 'video') {
        this.videos.add({ el: nodes.video, layer: instance.layer, offset: instance.offset });
      }

      /*
       * The still counterpart. `buildLayerElement` sets exactly one of `video`
       * and `poster`, so these two branches cannot both run for a layer.
       *
       * Registered even with no `src`, matching the live path where an empty
       * `<video>` still joins `VideoSync` and can be given a source later by a
       * binding. `PosterSync` skips a sourceless entry until it has one.
       */
      if (nodes.poster && instance.layer.type === 'video') {
        this.posters.add(instance.id, {
          img: nodes.poster,
          layer: instance.layer,
          offset: instance.offset,
          src: instance.layer.src ? this.resolveAsset(instance.layer.src) : '',
        });
      }

      if (nodes.sprite && instance.layer.type === 'sprite') {
        this.sprites.add({ el: nodes.sprite, layer: instance.layer, offset: instance.offset });
      }
    }

    if (this.plan.warnings.length) {
      for (const warning of this.plan.warnings) {
        console.warn(`[breeze] ${warning.layerId}: ${warning.message}`);
      }
    }

    this.container.appendChild(this.root);
    if (this.scaleMode === 'contain') {
      this.fitToContainer();
      this.watchContainerSize();
    }

    /*
     * Seed values pinned by an enclosing composition layer's overrides.
     *
     * **After the tree is in the document, deliberately.** This ran before the
     * append until 0.71.0, and for a crawl that was the
     * measures-zero-while-detached trap all over again: `applyBinding` reaches a
     * ticker through `crawlFor`, which *constructs* the loop on first call, and
     * a loop built against a detached element measures a viewport of 0 and
     * correctly refuses to animate — so overriding a nested ticker's items
     * froze it. The dedicated crawl pass below sits after the append for exactly
     * this reason and says so; this one was front-running it.
     *
     * Still before `refit()`, which is what a text override needs: Fit Width has
     * to measure the copy that will actually be on screen, not the copy this
     * mount is replacing.
     */
    for (const instance of this.plan.instances) {
      if (!Object.keys(instance.overrides).length) continue;
      const nodes = this.nodes.get(instance.id);
      if (!nodes) continue;
      const layer = instance.layer;
      if (!('binding' in layer) || !layer.binding) continue;
      if (!(layer.binding in instance.overrides)) continue;
      this.applyBinding(nodes, instance.overrides[layer.binding]);
    }

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
     * editor canvas, and should never reach a renderer.
     *
     * A still takes this write and nothing after it: `clockTicker()` builds a
     * tick-once ticker, so the loop below costs one `formatClock` per clock
     * layer and no timer. That is why the still case is a mode on the ticker
     * rather than a `continue` here — a thumbnail wants the time, just not a
     * subscription to it.
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
        onRowsBuilt: () => this.settleCells(id),
        ruleContext: () => this.ruleContext(node.instance),
        transformSource: (sourceId) => this.datasets.get(sourceId),
        onMediaFail: (rowKey) => this.skipFailedMedia(id, rowKey),
        onMediaPlay: () => this.mediaPlayed(id),
      });
      const window = this.plan.windows.find((w) => w.layerId === id);
      const cycle = node.layer.cycle;
      this.tables.set(id, {
        block,
        anim: resolveRowAnim(node.layer.rowAnim),
        start: window?.in ?? 0,
        track: null,
        cellTrack: null,
        stale: false,
        cycle: cycleEnabled(cycle)
          ? { config: cycle, anchor: null, held: false, done: false, shown: { page: 0, at: 0 } }
          : null,
        leader: null,
      });
    }

    // Followers find their leaders once every table exists, and take their
    // first key now — before the timeline is built over their rows, and before
    // the first paint, so a tile never shows every city for a frame.
    this.resolveFollowers();
    this.syncFollowers({ instant: true });

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
    this.posters.syncTo(0);
    this.sprites.syncTo(0);

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

  /* --------------------------------------------------------------- rules */

  /** The channel's mode, as last set. '' is none. */
  get mode(): string {
    return this.modeValue;
  }

  /**
   * Set the mode on this page alone — host scripting and tests. On air the
   * server sets it for every graphic in the project (`/api/projects/:id/mode`).
   */
  setMode(mode: string): void {
    this.update({ [MODE_UPDATE_KEY]: mode });
  }

  /**
   * What rules read. A field is read through a nested mount's overrides
   * first, so a rule inside the AWAY badge sees AWAY's value.
   */
  private ruleContext(instance?: { id: string; overrides: Record<string, unknown> }): Omit<RuleContext, 'row'> {
    // The mount this instance sits in, for a live `<mount>.<binding>` value —
    // which is what the operator sets for one mount, and must win over the
    // mount's authored override just as it does on screen.
    let mount = '';
    if (instance) for (const m of this.mountIds()) if (instance.id.startsWith(`${m}/`) && m.length > mount.length) mount = m;
    const overrides = instance?.overrides ?? {};
    return {
      source: (id) => this.datasets.get(id),
      field: (name) => {
        const addressed = mount ? `${mount}.${name}` : '';
        if (addressed && addressed in this.data) return this.data[addressed];
        return name in overrides ? overrides[name] : this.data[name];
      },
      mode: this.modeValue,
    };
  }

  /** Re-evaluate every layer and cell rule — after data, a field or the mode changed. */
  private refreshRules(): void {
    for (const node of this.nodes.values()) {
      const rules = node.layer.rules;
      if (!rules?.length) continue;
      applyRuleResult(node, resolveRules(rules, this.ruleContext(node.instance)), this.resolveAsset);
    }
    for (const handle of this.tables.values()) handle.block.reapplyRules();
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
      if (layer?.type !== 'table') continue;
      if (layer.source === sourceId) {
        if (handle.block.setDataSet(data)) handle.stale = true;
      } else if (transformSources(layer.transforms).includes(sourceId)) {
        // A lookup or union reads this source: same rows of its own, new result.
        if (handle.block.refreshTransforms()) handle.stale = true;
      }
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
      if (layer.type !== 'crawl' || !layer.source || !layer.column || this.crawlPinned(node)) continue;
      if (layer.source !== sourceId && !transformSources(layer.transforms).includes(sourceId)) continue;
      const own = this.datasets.get(layer.source);
      if (own) this.crawlFor(id)?.setItems(crawlItemsFrom(own, layer, this.transformContext()));
    }
  }

  /**
   * A crawl whose mount overrides its binding says what the override says —
   * `crawlFor` builds it that way, and neither a feed nor the clock replaces it.
   */
  private crawlPinned(node: LayerNodes): boolean {
    const layer = node.layer;
    return 'binding' in layer && layer.binding !== undefined && layer.binding in node.instance.overrides;
  }

  /** What transforms read besides their rows: now, and the other sources. */
  private transformContext(): { now: Date; source: (id: string) => DataSet | undefined } {
    return { now: new Date(), source: (id) => this.datasets.get(id) };
  }

  /**
   * Re-run the clock-bound transforms (`date`) as time passes — "today" has to
   * become tomorrow at midnight on a graphic that has been on air all day, and
   * "upcoming" has to lose the 3 pm game at 3 pm. Every thirty seconds, and
   * only when a table or crawl in this graphic has one.
   */
  private startClockTransforms(): void {
    // A still is one frame: its transforms ran against now when it was built.
    if (this.still) return;
    const clocked = [...this.nodes.values()].some(
      (n) => (n.layer.type === 'table' || n.layer.type === 'crawl') && transformsUseClock(n.layer.transforms),
    );
    if (!clocked) return;
    this.transformTimer = setInterval(() => {
      if (this.destroyed) return;
      let changed = false;
      for (const [id, handle] of this.tables) {
        const layer = this.nodes.get(id)?.layer;
        if (layer?.type !== 'table' || !transformsUseClock(layer.transforms)) continue;
        if (handle.block.refreshTransforms()) {
          handle.stale = true;
          changed = true;
        }
      }
      for (const [id, node] of this.nodes) {
        const layer = node.layer;
        if (layer.type !== 'crawl' || !layer.source || !layer.column || !transformsUseClock(layer.transforms)) continue;
        if (this.crawlPinned(node)) continue;
        const own = this.datasets.get(layer.source);
        if (own) this.crawlFor(id)?.setItems(crawlItemsFrom(own, layer, this.transformContext()));
      }
      // The same follow-through a data push gets: followers, tracks, cycles, rules.
      if (changed) this.update({}, { silent: true });
    }, 30_000);
  }

  private proxyFor(layerId: string): FilterProxy {
    let p = this.proxies.get(layerId);
    if (!p) {
      /*
       * Built FROM `defaultFor` rather than written out as a literal.
       *
       * The literal used to read `{ blur: 0, brightness: 1, maskOffset: 0 }`,
       * agreeing with `defaultFor` only because someone kept the two in sync
       * by hand. `layerMotion` only emits a baseline `set` when it differs
       * from `defaultFor(prop)`, so a proxy constructed with the wrong
       * default resets a layer's static effect to that wrong value the first
       * time the timeline ticks — visible only while playing (MASKS.md §3.3).
       * One list removes the chance to disagree.
       */
      p = Object.fromEntries(
        FILTER_PROXY_PROPS.map((prop) => [prop, defaultFor(prop)]),
      ) as FilterProxy;
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
      contrast: proxy.contrast,
      saturate: proxy.saturate,
      hueRotate: proxy.hueRotate,
      grayscale: proxy.grayscale,
      sepia: proxy.sepia,
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
      this.sprites.tick(holdAt);
      this.startCycles();
      this.emit('hold');
      return;
    }

    if (this.videos.size) this.videos.tick(t);
    if (this.sprites.size) this.sprites.tick(t);
    this.emit('timeupdate');
  }

  private onComplete(): void {
    this.state = 'finished';
    this.stopCycleTimer();
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
      /*
       * A fresh run of a self-paging graphic starts on its first page, not on
       * whichever page its last run was cycling through when it went off air.
       * Not from `idle`: that is either a graphic that has never run or one a
       * CLEAR already reset — and in both cases any page it is on now was
       * chosen by an operator for it to open on.
       */
      if (this.state !== 'idle') this.resetCycles();
      this.tl.pause();
      this.renderAt(0);
      // Pages reset above rebuilt rows the reveal no longer targets.
      this.refreshTableTracks();
      this.applyVisibilityWindows(0);
    }
    this.stopCycleTimer();
    this.pendingHold = nextHoldAfter(this.plan, this.tl.time());
    this.state = 'playing-in';
    this.startCrawls();
    this.videos.play(this.tl.time());
    this.sprites.syncTo(this.tl.time());
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

    this.stopCycleTimer();
    this.pendingHold = null;
    this.state = 'playing-out';
    this.videos.play(this.tl.time());
    this.sprites.syncTo(this.tl.time());
    this.tl.play();
    this.emit('stop');
  }

  /**
   * Advance to the next STOP marker; behaves like stop() when none remain.
   *
   * With `table`, only that table (and its cycle group) turns a page, and the
   * timeline is never touched — a caller aiming at a table has asked for a page,
   * and a single-page table answering by running the outro would be a very
   * surprising way to learn it had only one.
   */
  next(table?: string): void {
    if (this.destroyed) return;

    if (table !== undefined) {
      if (this.turnTables(this.tablesFor(table), +1)) this.afterPageCommand();
      return;
    }

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
      this.afterPageCommand();
      return;
    }

    this.advanceTimeline();
  }

  /**
   * The mirror of `next()`: back a page while holding, otherwise back to the
   * previous hold.
   *
   * The previous hold is reached by a cut, not by playing the timeline
   * backwards. An intro run in reverse is not a graphic anyone designed, and
   * the operator pressing PREV wants the earlier state on screen, not a
   * rewind effect. With no earlier hold it does nothing — PREV must never be
   * the button that takes a graphic off air.
   */
  prev(table?: string): void {
    if (this.destroyed) return;

    if (table !== undefined) {
      if (this.turnTables(this.tablesFor(table), -1)) this.afterPageCommand();
      return;
    }

    if (this.state === 'holding' && this.turnTables([...this.tables.keys()], -1)) {
      this.afterPageCommand();
      return;
    }

    if (this.state !== 'holding' && this.state !== 'playing-in') return;
    const now = this.tl.time();
    // Strictly before where we are — from a hold, that is the one before it.
    const earlier = this.plan.holds.filter((h) => h < now - 1e-3);
    const target = earlier.length ? earlier[earlier.length - 1]! : null;
    if (target === null) return;

    this.stopCycleTimer();
    this.pendingHold = null;
    this.tl.pause();
    this.renderAt(target);
    this.applyVisibilityWindows(target);
    this.videos.syncTo(target);
    this.sprites.syncTo(target);
    this.state = 'holding';
    this.startCycles();
    this.emit('hold');
  }

  /**
   * Go to a page — 1-based `n`, or the page whose key matches `key`.
   *
   * Works in any state. Choosing Group C before rolling a graphic in is a real
   * operator move, and the cycle then anchors on the page it finds itself on,
   * so the graphic opens on Group C. True when any table moved.
   */
  goToPage(target: PageTarget, table?: string): boolean {
    if (this.destroyed) return false;
    const animate = this.state === 'holding';
    let moved = false;
    for (const id of this.tablesFor(table)) {
      const handle = this.tables.get(id)!;
      const block = handle.block;
      let page = -1;
      if (target.key !== undefined) page = block.findPage(target.key, handle.cycle?.config.keyColumn);
      else if (target.n !== undefined && Number.isFinite(target.n)) page = Math.floor(target.n) - 1;
      if (page < 0 || page >= block.pageCount) continue;
      if (block.turnTo(page, { animate })) {
        moved = true;
        if (!animate) handle.stale = true;
      }
      this.anchorCycle(handle);
    }
    if (moved) this.afterPageCommand();
    else this.scheduleCycles();
    return moved;
  }

  /**
   * Freeze self-paging tables on the page they show (`hold`), or set them going
   * again from that page with its full time (`resume`).
   *
   * A hold survives the graphic leaving air and coming back: an operator who
   * froze Group C for an interview meant it until they say otherwise, not
   * until the next time somebody pressed PLAY.
   */
  setCycle(state: 'hold' | 'resume', table?: string): boolean {
    if (this.destroyed) return false;
    let changed = false;
    for (const id of this.tablesFor(table)) {
      const handle = this.tables.get(id)!;
      if (!handle.cycle) continue;
      const held = state === 'hold';
      if (handle.cycle.held !== held) changed = true;
      handle.cycle.held = held;
      if (!held) {
        handle.cycle.done = false;
        this.anchorCycle(handle);
      }
    }
    this.scheduleCycles();
    if (changed) this.emit('page');
    return changed;
  }

  /**
   * Take up where another output is — the late-join (0.74.1).
   *
   * An output page opened while its graphic is already on air used to sit
   * blank until the next PLAY, because commands are events and it had missed
   * them: a browser source reloaded mid-show, or a panel's preview switched on
   * mid-hold. The hub keeps what each output last reported, and this puts this
   * runtime in the same place:
   *
   * - **holding** — a cut to that hold, never the intro played again: the
   *   audience is already looking at the held frame on the other output, and
   *   this one arriving is not an event they should see. Crawls start, and each
   *   paged table goes to the reported page with the reported time left, aged
   *   by how long ago the report was made, so a rejoined output turns its pages
   *   on the same second as the one it joined.
   * - **playing-in** — from the reported time on towards its next hold.
   * - anything else — nothing. An output leaving air, finished or never played
   *   has nothing on screen to match.
   *
   * Only from `idle`, unless `force`: a page that has already been told what to
   * do by a live command knows better than a report about someone else.
   * True when it joined.
   */
  joinAt(report: JoinReport, opts: { force?: boolean } = {}): boolean {
    if (this.destroyed) return false;
    if (this.state !== 'idle' && !opts.force) return false;
    if (report.state !== 'holding' && report.state !== 'playing-in') return false;

    const ageMs = Math.max(0, report.ageMs ?? 0);
    const now = Date.now();
    const duration = this.tl.duration();

    /*
     * The hold is found by step, not by the reported time. A hold's time is
     * exact on the output that reported it and exact here — same composition —
     * so there is nothing to round; the step is simply the sturdier of the two
     * facts when the time has picked up a float's worth of drift.
     */
    const holdAt = report.state === 'holding'
      ? (report.step > 0 ? this.plan.holds[report.step - 1] : undefined) ?? report.time
      : report.time + ageMs / 1000;
    const target = Math.max(0, Math.min(holdAt, duration));

    this.stopCycleTimer();
    this.tl.pause();
    this.renderAt(target);
    this.applyVisibilityWindows(target);
    this.videos.syncTo(target);
    this.posters.syncTo(target);
    this.sprites.syncTo(target);

    this.joinTables(report.tables ?? [], now - ageMs);

    if (report.state === 'holding') {
      this.pendingHold = null;
      this.state = 'holding';
      this.startCrawls();
      // A self-paging table the report did not mention — one page when it was
      // made, or a report from a renderer older than table reports — starts its
      // time now, as it would on reaching the hold.
      for (const handle of this.tables.values()) {
        if (handle.cycle && !handle.cycle.anchor) this.anchorCycle(handle, now);
      }
      this.scheduleCycles();
      this.emit('hold');
      return true;
    }

    this.pendingHold = nextHoldAfter(this.plan, target);
    this.state = 'playing-in';
    this.startCrawls();
    this.videos.play(target);
    this.tl.play();
    this.emit('play');
    return true;
  }

  /**
   * Put each reported table on its page, anchored so its time left matches.
   *
   * `reportedAt` is when the other output made the report, in this machine's
   * epoch: the anchor is set back from it by however far into the page that
   * output was, and the cycle's own arithmetic walks it forward to now. Leaders
   * first, then followers — moving a leader re-keys its followers and sends
   * them to their own first page, so a follower's reported page is only right
   * once its leader has moved.
   */
  private joinTables(reports: NonNullable<JoinReport['tables']>, reportedAt: number): void {
    if (!reports.length || !this.tables.size) return;
    const byAddress = new Map<string, string>();
    for (const id of this.tables.keys()) byAddress.set(this.tableAddress(id), id);

    const place = (entry: NonNullable<JoinReport['tables']>[number]): void => {
      const id = byAddress.get(entry.table);
      const handle = id !== undefined ? this.tables.get(id) : undefined;
      if (!handle || !Number.isFinite(entry.page)) return;
      const page = Math.floor(entry.page);
      if (page >= 0 && page < handle.block.pageCount && handle.block.turnTo(page)) handle.stale = true;
      const cycle = handle.cycle;
      if (!cycle) return;
      cycle.held = entry.held === true;
      cycle.done = false;
      const shown = handle.block.currentPage;
      const dwell = this.cycleDurations(handle)[shown];
      const left = typeof entry.secondsLeft === 'number' && Number.isFinite(entry.secondsLeft) ? entry.secondsLeft : null;
      // Into the page by its dwell less the time it had left; with no time
      // left reported (held, or not cycling), the page simply starts now.
      const into = left !== null && dwell !== undefined ? Math.max(0, dwell - left) * 1000 : 0;
      const at = left !== null ? reportedAt - into : Date.now();
      cycle.anchor = { page: shown, at };
      cycle.shown = { page: shown, at };
      /*
       * A `hold` or `continue` cycle that had already run its course reports
       * no time left and is not cycling. Mark it done, or it would start its
       * last page over.
       */
      const end = cycle.config.end ?? 'loop';
      if (end !== 'loop' && !cycle.held && entry.cycling === false && shown === handle.block.pageCount - 1) cycle.done = true;
    };

    const leaders = reports.filter((r) => !r.follows);
    const followers = reports.filter((r) => r.follows);
    for (const entry of leaders) place(entry);
    this.syncFollowers({});
    for (const entry of followers) place(entry);
    // Turned without motion: the reveal is behind the playhead, so the rows
    // are simply at rest — `refreshTableTracks` leaves a passed reveal alone.
    this.refreshTableTracks();
  }

  /** Everything `next()` does to the timeline, without the table step. */
  private advanceTimeline(): void {
    const upcoming = nextHoldAfter(this.plan, this.tl.time());
    if (upcoming === null) {
      this.stop();
      return;
    }
    this.stopCycleTimer();
    this.pendingHold = upcoming;
    this.state = 'playing-in';
    this.startCrawls();
    this.videos.play(this.tl.time());
    this.sprites.syncTo(this.tl.time());
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
      this.resetCycles();
      this.refreshTableTracks();
    }

    this.stopCycleTimer();
    this.pendingHold = null;
    this.state = 'playing-in';
    this.startCrawls();
    this.videos.play(this.tl.time());
    this.sprites.syncTo(this.tl.time());
    this.tl.play();
    this.emit('play');
  }

  /** Hard reset to frame 0, nothing on screen. */
  clear(): void {
    this.state = 'idle';
    this.pendingHold = null;
    this.tl.pause();
    this.renderAt(0);
    this.resetCycles();
    this.refreshTableTracks();
    this.stopCrawls();
    this.videos.syncTo(0);
    this.posters.syncTo(0);
    this.sprites.syncTo(0);
    this.applyVisibilityWindows(0);
    this.emit('stop');
  }

  /** Seek without changing playback state — editor scrubbing, thumbnails. */
  seek(time: number): void {
    this.tl.pause();
    this.renderAt(time);
    this.applyVisibilityWindows(this.tl.time());
    this.videos.syncTo(this.tl.time());
    this.posters.syncTo(this.tl.time());
    this.sprites.syncTo(this.tl.time());
    this.emit('timeupdate');
  }

  /* -------------------------------------------------------- dynamic data */

  /** Replace bound field values live. Safe to call while on air. */
  update(data: BindingData, opts: { silent?: boolean } = {}): void {
    if (this.destroyed) return;
    this.data = { ...this.data, ...data };
    if (MODE_UPDATE_KEY in data) this.modeValue = String(data[MODE_UPDATE_KEY] ?? '');

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

    /*
     * Addressed fields — `<mount instance id>.<binding>`, from
     * `collectOverrideBindings`.
     *
     * An overridden field is pinned against the loop below, which is what lets
     * one badge composition mount twice showing different teams. That same pin
     * left an operator with no way to change either of them live, so an
     * override now also publishes an address, and an address reaches exactly
     * one mount — the HOME badge without touching AWAY.
     *
     * Matched against known mount ids rather than by splitting on the first
     * dot: a binding name is operator data and may itself contain one, and a
     * field called `home.score` must not be mistaken for an address.
     */
    for (const mountId of this.mountIds()) {
      const prefix = `${mountId}.`;
      for (const [key, value] of Object.entries(data)) {
        if (!key.startsWith(prefix)) continue;
        const binding = key.slice(prefix.length);
        for (const node of this.nodes.values()) {
          const layer = node.layer;
          if (!('binding' in layer) || layer.binding !== binding) continue;
          if (!node.instance.id.startsWith(`${mountId}/`)) continue;
          this.applyBinding(node, value);
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

    this.refreshRules();
    this.refitAfterTextChange();
    // New data can rename the page a leader is on (the rotation's third city
    // is now Yuma), so followers are re-keyed before the tracks are refreshed.
    this.syncFollowers({ animate: this.state === 'holding' });
    this.refreshTableTracks();
    this.reconcileCycles();
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
   *
   * **A still gets a tick-once ticker.** `add()` still writes the real time
   * before the first paint — a thumbnail showing `PLACEHOLDER` would be worse
   * than one a few minutes stale — but no interval is started, so twenty clock
   * thumbnails are twenty writes rather than twenty timers. `onChange` is then
   * unreachable, which is fine: the write happens before `build()`'s `refit()`,
   * so the one time a still shows is fitted like any other text.
   */
  private clockTicker(): ClockTicker {
    if (!this.clocks) {
      this.clocks = new ClockTicker(
        () => {
          if (this.destroyed) return;
          this.refitAfterTextChange();
        },
        // `undefined` takes the real clock; the third argument is the one being
        // set, and TypeScript has no way to skip the middle one.
        undefined,
        this.still,
      );
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
        if (typeof value !== 'string' || !value) break;
        /*
         * In a still the element is an `<img>` holding a captured frame, so the
         * URL cannot simply be assigned — an `<img src="clip.mp4">` is the
         * browser's broken-image icon. `PosterSync` re-captures instead.
         *
         * `node.media` is deliberately unset for a still video, so this is not
         * a guard that can be forgotten: the assignment below has nothing to
         * write to on that path.
         */
        if (node.poster) {
          this.posters.setSrc(node.instance.id, this.resolveAsset(value));
          break;
        }
        // Under an image rule, the field's new picture waits for the rule to end.
        if (node.media && !setRuleBaseSrc(node.el, this.resolveAsset(value))) node.media.src = this.resolveAsset(value);
        break;
      case 'media':
        // A URL typed on the control panel; empty stops the layer.
        node.mediaPlayer?.show(typeof value === 'string' ? value : value == null ? '' : String(value));
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
    return this.turnTables([...this.tables.keys()], +1);
  }

  /**
   * Turn the given tables one page forward or back. True when any had a page to
   * turn to. Animated only on air — a page chosen while idle or mid-intro is a
   * setup move, not something an audience watches.
   */
  private turnTables(ids: string[], step: 1 | -1): boolean {
    const animate = this.state === 'holding';
    let turned = false;
    for (const id of ids) {
      const handle = this.tables.get(id);
      if (!handle) continue;
      const block = handle.block;
      const ok = step > 0 ? block.nextPage({ animate }) : block.prevPage({ animate });
      if (!ok) continue;
      turned = true;
      // Off air the rows were rebuilt with no motion, and the intro's reveal
      // still targets the old ones; `afterPageCommand` refills it.
      if (!animate) handle.stale = true;
      // An operator's turn restarts that page's full time; `done` clears so a
      // round-up stepped back from its last page carries on from there.
      if (handle.cycle) handle.cycle.done = false;
      this.anchorCycle(handle);
    }
    return turned;
  }

  /** After an operator page command: move followers, tell listeners, re-arm the timer. */
  private afterPageCommand(): void {
    this.syncFollowers({ animate: this.state === 'holding' });
    this.refreshTableTracks();
    this.scheduleCycles();
    this.emit('page');
    // Older listeners learned of a page turn through `update`, which is what
    // `next()` emitted before pages had an event of their own.
    this.emit('update');
  }

  /**
   * The table layers a command is aimed at, with their cycle groups.
   *
   * No target is every table. Otherwise the target is matched, in order, as a
   * binding name, as a `<mount>.<binding>` address, or as a layer id — the
   * namespaced instance id or the authored id at the end of it. Nothing matching
   * is an empty list: a command aimed at a table this graphic does not have
   * does nothing, rather than guessing which one was meant.
   *
   * Then groups: a table that names a group brings the rest of the group with
   * it, because the whole point of a group is that its members never disagree
   * about the page.
   */
  private tablesFor(target: string | undefined): string[] {
    if (target === undefined || target === '') return [...this.tables.keys()];

    const matched = new Set<string>(this.matchTables(target));

    const groups = new Set<string>();
    for (const id of matched) {
      const group = this.tables.get(id)?.cycle?.config.group;
      if (group) groups.add(group);
    }
    if (groups.size) {
      for (const [id, handle] of this.tables) {
        const group = handle.cycle?.config.group;
        if (group && groups.has(group)) matched.add(id);
      }
    }
    return [...matched];
  }

  /** Tables a name matches — binding, `<mount>.<binding>`, or layer id — without group expansion. */
  private matchTables(target: string): string[] {
    const out: string[] = [];
    for (const id of this.tables.keys()) {
      const layer = this.nodes.get(id)?.layer;
      if (!layer || layer.type !== 'table') continue;
      if (
        this.tableAddress(id) === target ||
        (layer.binding !== undefined && layer.binding === target) ||
        id === target ||
        id.endsWith(`/${target}`)
      ) {
        out.push(id);
      }
    }
    return out;
  }

  /* --------------------------------------------------------------- follow */

  /**
   * Find each follower's leader (CYCLE.md, Wave 4).
   *
   * Among several tables answering to the name, the one sharing the longest
   * mount path with the follower wins: six copies of a tile composition each
   * containing a `rotation` table should each follow their own. A chain that
   * loops back on itself is broken where it closes, with a warning — two
   * tables following each other would each filter on the other's key and
   * settle on whichever happened to render first.
   */
  private resolveFollowers(): void {
    const depth = (a: string, b: string): number => {
      const pa = a.split('/');
      const pb = b.split('/');
      let n = 0;
      while (n < pa.length - 1 && n < pb.length - 1 && pa[n] === pb[n]) n += 1;
      return n;
    };

    for (const [id, handle] of this.tables) {
      const layer = this.nodes.get(id)?.layer;
      const follow = layer?.type === 'table' ? layer.follow : undefined;
      if (!follow) continue;
      const candidates = this.matchTables(follow.table).filter((c) => c !== id);
      if (candidates.length === 0) {
        console.warn(`[breeze] table ${id} follows "${follow.table}", which this graphic does not contain`);
        continue;
      }
      candidates.sort((a, b) => depth(b, id) - depth(a, id));
      if (candidates.length > 1 && depth(candidates[0]!, id) === depth(candidates[1]!, id)) {
        console.warn(
          `[breeze] table ${id} follows "${follow.table}", which names ${candidates.length} tables equally near; ` +
            `it follows ${this.tableAddress(candidates[0]!)} — use a mount.binding address to choose`,
        );
      }
      handle.leader = candidates[0]!;
    }

    for (const [id, handle] of this.tables) {
      const seen = new Set<string>([id]);
      let at = handle.leader;
      while (at !== null) {
        // Back to where the walk began: this table closes a loop, so it lets go.
        if (at === id) {
          console.warn(`[breeze] table ${id} is part of a follow loop; it will not follow`);
          handle.leader = null;
          break;
        }
        // A loop further up that this table only hangs off. Its own members
        // break it when their turn comes; this table keeps its leader.
        if (seen.has(at)) break;
        seen.add(at);
        at = this.tables.get(at)?.leader ?? null;
      }
    }
  }

  /**
   * Re-key every follower from its leader's current page.
   *
   * Cheap and idempotent — a follower whose key has not changed does nothing
   * — so it runs after anything that could have moved a leader: a command, a
   * cycle turn, new data, a reset. Repeats until nothing changes, so a chain
   * (a follower that is itself followed) settles in one call whatever order the
   * tables were built in. True when any follower moved.
   */
  private syncFollowers(opts: { animate?: boolean; instant?: boolean }): boolean {
    let any = false;
    /** Followers with a running cycle that were re-keyed — anchored together below. */
    const restarted = new Set<string>();
    for (let pass = 0; pass <= this.tables.size; pass += 1) {
      let changed = false;
      for (const [id, handle] of this.tables) {
        if (handle.leader === null) continue;
        const layer = this.nodes.get(id)?.layer;
        const follow = layer?.type === 'table' ? layer.follow : undefined;
        const leader = this.tables.get(handle.leader);
        if (!follow || !leader) continue;
        const column =
          follow.leaderColumn ??
          leader.cycle?.config.keyColumn ??
          (leader.block.hasColumn(follow.column) ? follow.column : undefined);
        const key = leader.block.pageKey(leader.block.currentPage, column);
        if (!handle.block.setFollow(follow.column, key, opts)) continue;
        changed = true;
        if (!opts.animate) handle.stale = true;
        // Its own pages are new, so a cycling follower starts its time again.
        if (handle.cycle) {
          handle.cycle.done = false;
          if (handle.cycle.anchor) restarted.add(id);
        }
      }
      if (!changed) break;
      any = true;
    }

    /*
     * One timestamp for every restarted follower, and its cycle group comes
     * with it: a group exists so its members never show different pages, and
     * a follower sent back to page one beside a partner left on page two is
     * exactly that. The partner goes back to page one and starts again too.
     */
    if (restarted.size) {
      const at = Date.now();
      const groups = new Set<string>();
      for (const id of restarted) {
        const group = this.tables.get(id)?.cycle?.config.group;
        if (group) groups.add(group);
      }
      for (const [id, handle] of this.tables) {
        const cycle = handle.cycle;
        if (!cycle?.anchor) continue;
        const inGroup = cycle.config.group !== undefined && groups.has(cycle.config.group);
        if (!restarted.has(id) && !inGroup) continue;
        if (!restarted.has(id) && handle.block.turnTo(0, opts.animate ? { animate: true } : {}) && !opts.animate) handle.stale = true;
        cycle.done = false;
        this.anchorCycle(handle, at);
      }
    }
    return any;
  }

  /**
   * What a caller should send to reach this table: the 0.72 field-address
   * shape, so tables and override fields are aimed at the same way.
   */
  private tableAddress(id: string): string {
    const layer = this.nodes.get(id)?.layer;
    const binding = layer && layer.type === 'table' ? layer.binding : undefined;
    if (!binding) return id;
    let mount = '';
    for (const m of this.mountIds()) {
      if (id.startsWith(`${m}/`) && m.length > mount.length) mount = m;
    }
    return mount ? `${mount}.${binding}` : binding;
  }

  /* ---------------------------------------------------------------- cycle */

  /** Anchor a table's cycle on the page it shows, from now. */
  private anchorCycle(handle: TableHandle, at = Date.now()): void {
    if (!handle.cycle) return;
    const page = handle.block.currentPage;
    handle.cycle.anchor = { page, at };
    handle.cycle.shown = { page, at };
  }

  /**
   * The graphic reached a hold: anchor every self-paging table that is not
   * already anchored, all on one timestamp.
   *
   * One `Date.now()` for all of them is what keeps a group — and tables that
   * merely share a dwell — turning on the same frame. Tables anchored before
   * this hold (a page chosen while idle, a return to a hold via PREV) keep
   * their page but restart its time, because the audience has only just
   * started looking at it.
   */
  private startCycles(): void {
    const at = Date.now();
    for (const handle of this.tables.values()) {
      if (!handle.cycle) continue;
      handle.cycle.done = false;
      this.anchorCycle(handle, at);
    }
    this.scheduleCycles();
  }

  /** Back to page one with no anchor — a fresh run, or a CLEAR. */
  private resetCycles(): void {
    this.stopCycleTimer();
    for (const handle of this.tables.values()) {
      if (!handle.cycle) continue;
      if (handle.block.turnTo(0)) handle.stale = true;
      handle.cycle.anchor = null;
      handle.cycle.done = false;
    }
    // Tracks are refilled by the caller once the playhead is back at the
    // start — `refreshTableTracks` only refills a reveal that is still ahead.
    this.syncFollowers({});
  }

  private stopCycleTimer(): void {
    if (this.cycleTimer !== null) clearTimeout(this.cycleTimer);
    this.cycleTimer = null;
    if (this.preloadTimer !== null) clearTimeout(this.preloadTimer);
    this.preloadTimer = null;
  }

  /**
   * A media cell failed on air and says `skip` (Wave 8): turn its table on to
   * the next page, as NEXT would — only while that table's cycle is running,
   * only for a row the audience is looking at, and not round and round a
   * rotation where nothing plays: after a whole lap of failures it rests
   * until something plays again.
   */
  private skipFailedMedia(tableId: string, rowKey: string): void {
    const handle = this.tables.get(tableId);
    if (!handle?.cycle || this.destroyed) return;
    if (![...this.runningCycles()].some(([id]) => id === tableId)) return;
    if (!handle.block.showsRow(rowKey)) return;
    const skips = (this.mediaSkips.get(tableId) ?? 0) + 1;
    if (skips > handle.block.pageCount) return;
    this.mediaSkips.set(tableId, skips);
    // A group turns together — a skip must not leave its members on different pages.
    const group = handle.cycle.config.group;
    const ids = group
      ? [...this.tables].filter(([, h]) => h.cycle?.config.group === group).map(([id]) => id)
      : [tableId];
    // Asynchronously: the failure can arrive inside the render that built the row.
    setTimeout(() => {
      if (this.destroyed || !handle.block.showsRow(rowKey)) return;
      if (![...this.runningCycles()].some(([id]) => id === tableId)) return;
      if (this.turnTables(ids, +1)) this.afterPageCommand();
    }, 0);
  }

  /** Whether media layers should be playing: the graphic is on air, or the host asked for always. */
  private mediaLive(): boolean {
    const s = this.stateValue;
    return this.mediaWhenIdle || s === 'playing-in' || s === 'holding' || s === 'playing-out';
  }

  /** Tell every player the graphic went on or off air. */
  private syncMediaLive(): void {
    if (this.destroyed || !this.root) return;
    const live = this.mediaLive();
    this.root.querySelectorAll<HTMLElement>('.bz-media').forEach((host) => playerOf(host)?.setLive(live));
  }

  /** Something played: the next failure starts a fresh lap. */
  private mediaPlayed(tableId: string): void {
    this.mediaSkips.delete(tableId);
  }

  /** Durations for a cycling table's current pages. */
  private cycleDurations(handle: TableHandle): number[] {
    return pageDurations(handle.block.pages, handle.cycle!.config);
  }

  /** Tables whose cycle should be turning right now. */
  private *runningCycles(): Iterable<[string, TableHandle]> {
    if (this.state !== 'holding' || this.destroyed || this.still) return;
    for (const entry of this.tables) {
      const cycle = entry[1].cycle;
      if (!cycle || cycle.held || cycle.done || !cycle.anchor) continue;
      if (entry[1].block.pageCount <= 1 && (cycle.config.end ?? 'loop') === 'loop') continue;
      yield entry;
    }
  }

  /**
   * Bring every running cycle to the page it should be on, then arm the timer
   * for the soonest next turn.
   *
   * Idempotent, and called from everywhere that could have moved the answer —
   * a timer firing, an operator command, data arriving — because asking "which
   * page now?" of an anchor is cheap and always right, and trying to work out
   * which of those callers actually needed it is neither.
   */
  private scheduleCycles(): void {
    this.stopCycleTimer();
    const now = Date.now();
    let soonest: number | null = null;
    let turned = false;
    let finish = false;

    /*
     * Solved in passes until nothing turns. A leader's turn re-keys its
     * followers, which re-anchors any that cycle and can change which tables
     * are running at all (a city with one page, the next with three) — so
     * their next turn is only known after the sync, and the timer must be
     * armed from the second look, not the first.
     *
     * Within a pass, a table whose leader (or a leader further up) is turning
     * is left alone: its anchor is about to be replaced, and turning it on the
     * old one first would start a half-turn the sync then cuts off on air.
     */
    for (let pass = 0; pass <= this.tables.size + 1; pass += 1) {
      soonest = null;
      finish = false;
      const running = [...this.runningCycles()];
      const solved = running.map(([id, handle]) => {
        const cycle = handle.cycle!;
        const durations = this.cycleDurations(handle);
        const end = cycle.config.end ?? 'loop';
        return { id, handle, durations, end, pos: cyclePosition(durations, cycle.anchor!, now, end) };
      });
      const turning = new Set(solved.filter((s) => s.pos.page !== s.handle.block.currentPage).map((s) => s.id));
      const ledByTurning = (handle: TableHandle): boolean => {
        const seen = new Set<string>();
        for (let at = handle.leader; at !== null && !seen.has(at); at = this.tables.get(at)?.leader ?? null) {
          if (turning.has(at)) return true;
          seen.add(at);
        }
        return false;
      };

      let movedThisPass = false;
      for (const { id, handle, durations, pos } of solved) {
        if (!turning.has(id) || ledByTurning(handle)) continue;
        handle.block.turnTo(pos.page, { animate: true });
        movedThisPass = true;
        // The page began at its boundary, not when this timer happened to fire.
        const began = pos.nextAt !== null ? pos.nextAt - durations[pos.page]! * 1000 : now;
        handle.cycle!.shown = { page: pos.page, at: began };
      }

      if (movedThisPass) {
        turned = true;
        this.syncFollowers({ animate: true });
        continue;
      }

      // Settled: nothing left to turn, so what was solved is what stands.
      for (const { handle, end, pos } of solved) {
        if (pos.done) {
          handle.cycle!.done = true;
          if (end === 'continue') finish = true;
        }
        if (pos.nextAt !== null && (soonest === null || pos.nextAt < soonest)) soonest = pos.nextAt;
      }
      break;
    }

    if (turned) this.emit('page');

    /*
     * A `continue` cycle that has shown its last page hands the graphic on.
     * Deferred a tick so the listeners told about the last page are told first,
     * and so `advanceTimeline` never runs inside the loop that decided to.
     */
    if (finish) {
      setTimeout(() => {
        if (!this.destroyed && this.state === 'holding') this.advanceTimeline();
      }, 0);
      return;
    }

    if (soonest !== null) this.armPreload(soonest, now);

    if (soonest !== null) {
      // A few ms past the boundary, so the position is unambiguously the new page.
      const delay = Math.max(16, soonest - now + 5);
      this.cycleTimer = setTimeout(() => {
        this.cycleTimer = null;
        this.scheduleCycles();
      }, delay);
    }
  }

  /**
   * A few seconds before the soonest turn, fetch what the next page will show
   * (Wave 8) — the snapshot is in the cache when the page arrives, and a
   * camera that is down is already known to be, so `skip` passes it at once.
   */
  private armPreload(soonest: number, now: number): void {
    const at = soonest - MEDIA_PRELOAD_LEAD_MS;
    const fire = (): void => {
      this.preloadTimer = null;
      if (this.destroyed) return;
      const when = Date.now();
      for (const [, handle] of this.runningCycles()) {
        if (!handle.block.hasMediaCells) continue;
        const durations = this.cycleDurations(handle);
        const end = handle.cycle!.config.end ?? 'loop';
        const pos = cyclePosition(durations, handle.cycle!.anchor!, when, end);
        if (pos.nextAt === null || pos.nextAt - when > MEDIA_PRELOAD_LEAD_MS + 50) continue;
        const next = cyclePosition(durations, handle.cycle!.anchor!, pos.nextAt + 5, end).page;
        if (next !== pos.page) handle.block.preloadPage(next, pos.nextAt);
      }
    };
    if (![...this.tables.values()].some((h) => h.cycle && h.block.hasMediaCells)) return;
    if (at <= now) fire();
    else this.preloadTimer = setTimeout(fire, at - now);
  }

  /**
   * Data changed under a cycle: stay on the page the audience is looking at.
   *
   * The anchor moves to the shown page and the moment it arrived, so a feed tick
   * neither restarts the page's time nor lets a changed page count re-solve the
   * cycle onto some other page. A page that no longer exists has already been
   * wrapped to the first by `TableBlock`, and starts its time now.
   */
  private reconcileCycles(): void {
    let any = false;
    for (const handle of this.tables.values()) {
      const cycle = handle.cycle;
      if (!cycle?.anchor) continue;
      any = true;
      const page = handle.block.currentPage;
      if (page === cycle.shown.page) cycle.anchor = { ...cycle.shown };
      else this.anchorCycle(handle);
    }
    if (any) this.scheduleCycles();
  }

  /**
   * Put a table's keyframed cells at rest on rows built after its reveal played.
   *
   * A keyframed cell hands its transform to GSAP outright (`TableBlock.buildRow`),
   * so a row built by a page turn or a feed tick mid-hold arrives with none —
   * and the cell track that would have placed it is behind the playhead, where
   * `refreshTableTracks` deliberately leaves it alone. Without this, page two's
   * animated cells stacked at the row origin.
   *
   * At rest means each animated property's value at the end of its last tween,
   * or its set value for a property that only has one.
   */
  private settleCells(id: string): void {
    const handle = this.tables.get(id);
    if (!handle || !this.tl) return;
    if (this.tl.time() <= handle.start + 1e-4) return;

    for (const cell of handle.block.animatedCells) {
      const targets = handle.block.cellElements(cell.id);
      if (!targets.length) continue;
      const motion = layerMotion(cell);
      const rest: Record<string, { value: number; at: number }> = {};
      for (const s of motion.sets) {
        const prop = GSAP_PROP[s.prop];
        if (prop && (!rest[prop] || s.at >= rest[prop]!.at)) rest[prop] = { value: s.value, at: s.at };
      }
      for (const tw of motion.tweens) {
        const prop = GSAP_PROP[tw.prop];
        const end = tw.start + tw.duration;
        if (prop && (!rest[prop] || end >= rest[prop]!.at)) rest[prop] = { value: tw.to, at: end };
      }
      const values = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v.value]));
      if (Object.keys(values).length) gsap.set(targets, values);
    }
  }

  /** Every table's paging and cycle, for control surfaces and the output page's report. */
  get tableStates(): TableState[] {
    const now = Date.now();
    const running = new Set([...this.runningCycles()].map(([id]) => id));
    const out: TableState[] = [];
    for (const [id, handle] of this.tables) {
      const block = handle.block;
      const cycle = handle.cycle;
      const cycling = running.has(id);
      let secondsLeft: number | null = null;
      if (cycling) {
        const pos = cyclePosition(
          this.cycleDurations(handle),
          cycle!.anchor!,
          now,
          cycle!.config.end ?? 'loop',
        );
        if (pos.nextAt !== null) secondsLeft = Math.max(0, Math.round((pos.nextAt - now) / 100) / 10);
      }
      out.push({
        table: this.tableAddress(id),
        layerId: id,
        page: block.currentPage,
        pageCount: block.pageCount,
        rows: block.totalRows,
        key: block.pageKey(block.currentPage, cycle?.config.keyColumn),
        hasCycle: cycle !== null,
        cycling,
        held: cycle?.held ?? false,
        secondsLeft,
        ...(cycle?.config.group ? { group: cycle.config.group } : {}),
        ...(handle.leader !== null ? { follows: this.tableAddress(handle.leader) } : {}),
      });
    }
    return out;
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
  /**
   * Instance ids of every composition layer in the expanded tree — the
   * addressable mounts.
   *
   * Computed once: the plan is immutable for the life of a runtime, and
   * `update()` runs on every operator keystroke and every data push.
   */
  private mountIds(): string[] {
    if (!this.mountIdCache) {
      this.mountIdCache = this.plan.instances
        .filter((i) => i.layer.type === 'composition')
        .map((i) => i.id);
    }
    return this.mountIdCache;
  }

  private mountIdCache: string[] | null = null;

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
     * What this ticker starts rotating, in precedence order.
     *
     * 1. An enclosing composition layer's `overrides`, because that is authored
     *    configuration for *this mount* — the HOME/AWAY case, and the same
     *    reason `pinnedBindings` makes it deaf to a parent `update()`.
     * 2. A source-bound DataSet if one has already arrived — which, on a /play
     *    page, it has: the server inlines current datasets into the boot payload
     *    precisely so a graphic is never briefly wrong on load.
     * 3. The authored `items`, covering the authoring case and the feed that has
     *    not answered yet.
     *
     * **The override has to be chosen here rather than applied afterwards**, and
     * that is the whole point of this arm. `setItems` treats every call after
     * the first as a live operator edit and *queues* it for the next loop seam,
     * so seeding the authored copy and then pushing the override left a nested
     * ticker showing the copy it was overriding — for a full rotation if the
     * loop was running, and forever if it was not, because a queue with no seam
     * coming never drains. The override is not an edit arriving mid-show; it is
     * what this ticker was built to say.
     */
    const layer = node.layer;
    const overrides = node.instance.overrides;
    const overridden =
      layer.binding !== undefined && layer.binding in overrides
        ? overrides[layer.binding]
        : undefined;
    const seeded = layer.source && layer.column ? this.datasets.get(layer.source) : undefined;

    loop.setItems(
      overridden !== undefined
        ? (Array.isArray(overridden) ? overridden.map(stringify) : [stringify(overridden)])
        : seeded
          ? crawlItemsFrom(seeded, layer, this.transformContext())
          : layer.items,
    );

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

  /**
   * Re-fit whenever the container changes size.
   *
   * `scaleMode: 'contain'` promises the graphic fits its container, and until
   * 0.72.1 it kept that promise exactly once — at build. Resize the window and
   * the stage held the scale it was given, so a graphic went on showing at the
   * old size inside a new box: cropped, or adrift in the corner, until the page
   * was reloaded. That is the whole of "the preview needs a refresh after a
   * resize".
   *
   * Only installed for `contain`, which is `/play?scale=contain` and nothing
   * else. A browser source in vMix or OBS runs 1:1 and never asks for this, and
   * the editor's thumbnails scale from the outside with `scaleMode: 'none'` —
   * an observer each would be a cost the thumbnail phase spent real effort
   * removing.
   *
   * No feedback loop: the fit writes a `transform` on the root, and a transform
   * does not change layout, so re-fitting cannot resize the box being observed.
   */
  private watchContainerSize(): void {
    const view = this.doc.defaultView as (Window & typeof globalThis) | null;
    // Absent in a headless DOM, and a graphic must build there regardless — the
    // still renderer and every unit test run without one.
    if (!view?.ResizeObserver) return;

    this.fitObserver = new view.ResizeObserver(() => {
      if (this.destroyed) return;
      this.fitToContainer();
    });
    this.fitObserver.observe(this.container);
  }

  private fitObserver: ResizeObserver | null = null;

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
    this.stopCycleTimer();
    if (this.transformTimer !== null) clearInterval(this.transformTimer);
    this.transformTimer = null;
    this.fitObserver?.disconnect();
    this.fitObserver = null;
    this.stopCrawls();
    // Before the tree goes: an interval holding a closure over a removed
    // element is the editor's rebuild-per-keystroke leak, one timer at a time.
    this.clocks?.destroy();
    this.clocks = null;
    this.videos.destroy();
    // A capture in flight holds a `<video>` of its own. Cancelling drops its
    // source now rather than whenever the decode happens to finish, which for a
    // panel that rebuilds per keystroke is the difference between one element
    // alive and one per render.
    this.posters.destroy();
    this.sprites.destroy();
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
    // Streams and embeds hold connections until they are let go of — before
    // the tree goes, or an editor rebuilding per keystroke leaks one per edit.
    stopMediaIn(this.root);
    this.root.remove();
  }
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

