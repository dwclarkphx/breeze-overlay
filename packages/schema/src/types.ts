// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Breeze Overlay — Composition format v1.
 *
 * This file is the human-readable source of truth for the composition document.
 * `schema.ts` holds the JSON Schema used for validation; the two are kept in
 * sync by tests in `src/__tests__/schema.test.ts`.
 *
 * Design rules:
 *  - Composition JSON is the product. Editor, runtime and every exporter
 *    read/write this and nothing else.
 *  - Times are ALWAYS in seconds (floats), never frames. `stage.fps` is a
 *    display/authoring hint and a target for playout, not a time unit.
 *  - Only GPU-friendly properties are animatable by default (transform,
 *    opacity, filter). Layout properties are deliberately excluded.
 */

import type { DataColumn, DataRow, DataTransform } from './data.js';

export const FORMAT_VERSION = 1 as const;

/* ------------------------------------------------------------------ easing */

/**
 * GSAP named eases we expose in the editor picker. Runtime accepts any string
 * GSAP understands, so this list is a UI convenience, not a hard constraint.
 */
export const NAMED_EASES = [
  'none',
  'power1.in', 'power1.out', 'power1.inOut',
  'power2.in', 'power2.out', 'power2.inOut',
  'power3.in', 'power3.out', 'power3.inOut',
  'power4.in', 'power4.out', 'power4.inOut',
  'back.in', 'back.out', 'back.inOut',
  'elastic.in', 'elastic.out', 'elastic.inOut',
  'bounce.in', 'bounce.out', 'bounce.inOut',
  'circ.in', 'circ.out', 'circ.inOut',
  'expo.in', 'expo.out', 'expo.inOut',
  'sine.in', 'sine.out', 'sine.inOut',
] as const;

export type NamedEase = (typeof NAMED_EASES)[number];

/** A user-drawn cubic-bezier curve. p1/p2 are the two control points. */
export interface CubicBezierEase {
  type: 'cubicBezier';
  /** [x1, y1, x2, y2] — CSS `cubic-bezier()` ordering. x values clamp to 0..1. */
  points: [number, number, number, number];
}

/** Step/hold interpolation — value snaps at the keyframe, no tween. */
export interface SteppedEase {
  type: 'stepped';
  /** Number of discrete steps across the segment. 1 == pure hold. */
  steps: number;
}

export type Ease = NamedEase | string | CubicBezierEase | SteppedEase;

/* -------------------------------------------------------------- keyframes */

/** Properties that can carry a keyframe track. */
export const ANIMATABLE_PROPS = [
  'x', 'y',
  'scaleX', 'scaleY',
  'rotation',
  'opacity',
  'skewX', 'skewY',
  'blur',
  'brightness',
  'maskOffset',
] as const;

export type AnimatableProp = (typeof ANIMATABLE_PROPS)[number];

export interface Keyframe {
  /** Time in seconds, relative to composition start. */
  t: number;
  /** Numeric value of the property at `t`. */
  v: number;
  /**
   * Ease applied on the segment LEAVING this keyframe (i.e. from this
   * keyframe to the next). The last keyframe's ease is ignored.
   */
  ease?: Ease;
}

export type KeyframeTracks = Partial<Record<AnimatableProp, Keyframe[]>>;

/* ------------------------------------------------------------------ layers */

export type LayerType =
  | 'shape'
  | 'text'
  | 'image'
  | 'video'
  | 'sprite'
  | 'crawl'
  | 'table'
  | 'composition'
  | 'group';

/** Static (non-animated) transform baseline. Keyframes override per property. */
export interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  skewX: number;
  skewY: number;
  /** Transform origin as a 0..1 fraction of the layer box. */
  anchorX: number;
  anchorY: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Stroke {
  color: string;
  width: number;
}

export interface Shadow {
  color: string;
  offsetX: number;
  offsetY: number;
  blur: number;
}

export interface GradientStop {
  /** 0..1 position along the gradient. */
  pos: number;
  color: string;
}

export interface Gradient {
  type: 'linear' | 'radial';
  /** Degrees, CSS convention (0 = to top). Ignored for radial. */
  angle?: number;
  stops: GradientStop[];
}

export type Fill = string | Gradient;

export interface LayerBase {
  id: string;
  name?: string;
  type: LayerType;
  visible?: boolean;
  locked?: boolean;
  /** Base opacity 0..1, multiplied into the `opacity` keyframe track. */
  opacity?: number;
  transform?: Partial<Transform>;
  size?: Size;
  keyframes?: KeyframeTracks;
  /**
   * Optional lifetime window in seconds. Outside it the layer is display:none.
   * Defaults to the whole composition.
   */
  in?: number;
  out?: number;
  /** CSS mix-blend-mode. */
  blendMode?: string;
  /** Layer-level CSS filter effects (static baseline; `blur`/`brightness` keyframable). */
  effects?: LayerEffects;
  /** Optional mask applied to this layer. */
  mask?: LayerMask;
  /**
   * Column key this layer renders when it sits inside a table row template.
   * Ignored everywhere else. Text layers show the cell's value, image layers
   * load it as `src`; every other type just inherits the row's data for a
   * future conditional.
   */
  cell?: string;
}

export interface LayerEffects {
  blur?: number;
  brightness?: number;
  contrast?: number;
  saturate?: number;
  hueRotate?: number;
  grayscale?: number;
  sepia?: number;
  dropShadow?: Shadow;
}

export interface LayerMask {
  /** Reserved for Phase 7. Only `rect` is honoured by the Phase-1 runtime. */
  type: 'rect' | 'ellipse' | 'image';
  x: number;
  y: number;
  width: number;
  height: number;
  feather?: number;
  invert?: boolean;
  /** Asset path when `type: 'image'`. */
  src?: string;
}

export interface ShapeLayer extends LayerBase {
  type: 'shape';
  shape: 'rect' | 'ellipse';
  fill?: Fill;
  stroke?: Stroke;
  /** Corner radius in px; ignored for ellipse. */
  cornerRadius?: number;
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight?: number | string;
  fontStyle?: 'normal' | 'italic';
  fill?: Fill;
  stroke?: Stroke;
  shadow?: Shadow;
  letterSpacing?: number;
  lineHeight?: number;
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  align?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  /** Background box behind the text. */
  background?: Fill;
  padding?: number;
}

export interface TextFit {
  /** `width` scales the glyphs down to fit `maxWidth`; `none` lets it overflow. */
  mode: 'none' | 'width';
  maxWidth?: number;
  /** Never scale below this fraction of the authored size. */
  minScale?: number;
}

/**
 * The text reveal gallery (Phase 5).
 *
 * Two axes — what the text is split into, and how each piece arrives — which
 * keeps the set predictable to author against and to test. The ids live here
 * rather than in the runtime because the schema validates them: a typo should
 * fail on save, where the author is looking, rather than silently not animating
 * on air.
 */
export const TEXT_ANIM_PRESET_IDS = [
  'chars-up', 'chars-fade',
  'words-up', 'words-fade',
  'lines-up', 'lines-fade',
] as const;

export type TextAnimPresetId = (typeof TEXT_ANIM_PRESET_IDS)[number];

export interface TextAnimPreset {
  id: TextAnimPresetId;
  /** Seconds between consecutive pieces. 0 animates them together. */
  stagger?: number;
  /** Seconds each individual piece takes. */
  duration?: number;
  ease?: Ease;
}

/**
 * Wall-clock readout on a text layer.
 *
 * The runtime owns this, not the server and not the operator, and that is the
 * whole design. A clock driven by `update()` on a one-second timer is a
 * websocket frame per second per channel that freezes the moment the network
 * blips — and a frozen clock on air is worse than no clock, because nobody
 * notices. Ticking locally means a browser source that has lost the server
 * still shows the right time.
 *
 * It is a property of a text layer rather than a layer type of its own so that
 * everything text layers already do — Fit Width, styling, reveals, masks — works
 * on it for free.
 */
export interface TextClock {
  /**
   * Token string: `h:mm A` → `6:42 PM`.
   *
   * Tokens are resolved through `Intl.DateTimeFormat` parts rather than by
   * arithmetic on a Date, which is what makes `timezone` and DST correct
   * instead of approximately correct twice a year. See CLOCK_TOKENS.
   */
  format: string;
  /**
   * IANA zone — `America/Phoenix`. Omitted means the render host's local zone,
   * which is what a station bug wants: the machine driving the wall is in the
   * market whose time is on screen.
   */
  timezone?: string;
  /**
   * Seconds between ticks. Omitted derives it from the format — a clock with no
   * seconds token has no reason to wake up 59 times for nothing.
   */
  tickSeconds?: number;
}

/**
 * The token vocabulary, longest-first — the order the formatter matches in, so
 * `mm` is never read as two `m`s.
 *
 * Deliberately the moment/day.js spelling. It is the one every motion designer
 * and every broadcast template author already has in their fingers, and
 * inventing a fourth convention buys nothing.
 */
export const CLOCK_TOKENS = [
  'YYYY', 'MMMM', 'dddd',
  'MMM', 'ddd', 'YY',
  'HH', 'hh', 'mm', 'ss', 'MM', 'DD',
  'H', 'h', 'm', 's', 'M', 'D', 'A', 'a',
] as const;

export type ClockToken = (typeof CLOCK_TOKENS)[number];

export interface TextLayer extends LayerBase {
  type: 'text';
  text: string;
  /** Dynamic-field name; `update({ [binding]: value })` replaces `text`. */
  binding?: string;
  style: TextStyle;
  fit?: TextFit;
  textAnimPreset?: TextAnimPreset;
  /**
   * Turns this layer into a live clock. `text` stays as the authoring
   * placeholder — it is what the editor canvas and a still export show — and is
   * overwritten on the first tick.
   *
   * A layer carrying both `clock` and `binding` is an authoring mistake: the
   * clock would win a fraction of a second after the operator typed. The
   * validator rejects it rather than letting it be discovered on air.
   */
  clock?: TextClock;
}

export interface ImageLayer extends LayerBase {
  type: 'image';
  /** Asset-relative path, e.g. `assets/logo.png`. */
  src: string;
  binding?: string;
  fit?: 'contain' | 'cover' | 'fill';
}

export interface VideoLayer extends LayerBase {
  type: 'video';
  src: string;
  binding?: string;
  loop?: boolean;
  muted?: boolean;
  /** Composition time at which playback starts. */
  startAt?: number;
  fit?: 'contain' | 'cover' | 'fill';
  /**
   * What the layer shows once the media has played out. Ignored when `loop`.
   *
   * `hold` freezes on the last frame — right for a background plate or an
   * end-card that has to stay up while the graphic around it holds at a STOP
   * marker. `clear` hides the element instead, which is what a stinger wants:
   * a transition that has finished should leave nothing behind, and holding its
   * final frame parks whatever that frame happened to be over live pictures.
   *
   * `hold` is the default only because it is what the runtime already did
   * before this field existed, and changing it would alter every graphic built
   * so far.
   */
  onEnd?: 'hold' | 'clear';
}

/**
 * A sprite sheet — one image holding a uniform grid of frames, stepped through
 * on the composition timeline.
 *
 * This is a layer type rather than a flag on `ImageLayer` because the two
 * render through different mechanisms and share almost nothing at playout: an
 * image is an `<img>` with `object-fit`, a sprite is a box with a
 * `background-image` offset every frame. Folding them together would mean an
 * `ImageLayer` whose `fit` silently stops meaning anything the moment a second
 * field is set, which is the kind of invalidation that is discovered on air.
 *
 * The grid is uniform by construction and there is no atlas-descriptor import.
 * A per-frame rect file would be a second parser on an upload path, and the
 * non-uniform sheets it exists to serve are a games problem — a broadcast
 * burst, sting or animated bug comes off an After Effects or sprite-tool
 * export as an even grid.
 */
export interface SpriteLayer extends LayerBase {
  type: 'sprite';
  /** Asset-relative path to the sheet, e.g. `assets/burst.png`. */
  src: string;
  binding?: string;
  /** Grid columns. */
  cols: number;
  /** Grid rows. */
  rows: number;
  /**
   * Frames actually used, read left-to-right then top-to-bottom.
   *
   * Separate from `cols * rows` because the last row of a sheet is usually
   * padded — a 30-frame burst on a 6×6 grid has six empty cells, and stepping
   * through them plays six frames of nothing at the end of the animation.
   * Defaults to `cols * rows` when absent.
   */
  frameCount?: number;
  /**
   * Playback rate. Intrinsic to the sheet rather than derived from the layer's
   * lifetime: an animation authored at 30fps looks wrong at any other rate, and
   * tying it to `in`/`out` would silently retime it whenever the operator
   * dragged the layer's bar.
   */
  fps: number;
  /** Composition time at which frame 0 shows. Mirrors `VideoLayer.startAt`. */
  startAt?: number;
  loop?: boolean;
  /**
   * What the layer shows once the sequence has played out. Ignored when `loop`.
   * Same argument as `VideoLayer.onEnd`, and the same default for the same
   * reason: `hold` is what the runtime did before the field existed.
   */
  onEnd?: 'hold' | 'clear';
}

/**
 * What a ticker prints between items, and again between the last and the first.
 *
 * Defined here rather than in the editor because three places have to agree on
 * it: the factory that creates a crawl layer, the runtime that falls back when
 * `separator` is absent, and the panel that offers it. They were three separate
 * string literals, which is two too many.
 *
 * The padding is part of the value, not styling around it. A separator is
 * rendered inside one continuous text run, so the only way to get air either
 * side of the glyph is to include it — and a bullet with no breathing room is
 * the single most common way a ticker looks amateur.
 */
export const DEFAULT_CRAWL_SEPARATOR = '   •   ';

export interface CrawlSeparatorPreset {
  /** Shown in the picker. */
  label: string;
  value: string;
}

/**
 * The separators broadcast tickers actually use. Not exhaustive — the panel
 * keeps a Custom option — but these cover the overwhelming majority, and
 * picking from a list beats typing a character most keyboards cannot produce.
 */
export const CRAWL_SEPARATOR_PRESETS: CrawlSeparatorPreset[] = [
  { label: 'Bullet  •', value: DEFAULT_CRAWL_SEPARATOR },
  { label: 'Diamond  ◆', value: '   ◆   ' },
  { label: 'Square  ■', value: '   ■   ' },
  { label: 'Em dash  —', value: '   —   ' },
  { label: 'Pipe  |', value: '   |   ' },
  { label: 'Slash  /', value: '   /   ' },
  { label: 'Arrow  ▶', value: '   ▶   ' },
  { label: 'Star  ★', value: '   ★   ' },
  /*
   * Wide gap, no glyph — a clean look that relies on spacing alone. Plain
   * spaces are safe here only because `.bz-crawl-block` is `white-space: pre`;
   * without that this preset would collapse to a single space and be no gap at
   * all. Same reason every preset above can pad with spaces rather than margin.
   */
  { label: 'Wide gap (no glyph)', value: '        ' },
];

export interface CrawlLayer extends LayerBase {
  type: 'crawl';
  /** Pixels per second. */
  speed: number;
  direction: 'left' | 'right';
  /** Static items; replaced wholesale by `update({ [binding]: string[] })`. */
  items: string[];
  binding?: string;
  separator?: string;
  style: TextStyle;
  /**
   * Data-source id feeding this ticker, and which column of it to read.
   *
   * An RSS feed *is* a ticker — that is the shape of the thing — so Wave 2 lets
   * a crawl take one column of a DataSet as its items instead of requiring
   * somebody to copy headlines into `items` by hand. Both fields together or
   * neither: a source without a column has no way to know which of `title`,
   * `link` and `description` to crawl.
   *
   * `items` stays as the authoring placeholder and the offline fallback, on the
   * same principle as a table layer's `data` — a feed that has not answered yet
   * must not put an empty ticker on air.
   */
  source?: string;
  /** Column key within `source` supplying each item. */
  column?: string;
  /** Sort/filter/limit pipeline over the source, applied before reading `column`. */
  transforms?: DataTransform[];
}

/**
 * Row reveal gallery — the Phase-5 preset axes applied to table rows.
 *
 * Same two-axis idea as the text presets (what moves × how it arrives), so an
 * author who has learned one has learned the other. `none` is explicit rather
 * than implied by omission: "this table deliberately does not animate its rows"
 * is a decision worth being able to state.
 */
export const ROW_ANIM_PRESET_IDS = ['none', 'rows-up', 'rows-fade', 'rows-slide'] as const;

export type RowAnimPresetId = (typeof ROW_ANIM_PRESET_IDS)[number];

export interface RowAnimPreset {
  id: RowAnimPresetId;
  /** Seconds between consecutive rows. 0 animates them together. */
  stagger?: number;
  /** Seconds each row takes. */
  duration?: number;
  ease?: Ease;
}

/**
 * How rows move when a re-sort changes their order — the standings shuffle.
 *
 * FLIP rather than a re-render: the rows are already on screen and only their
 * positions change, so measuring first/last and tweening the delta animates the
 * real elements instead of cross-fading two versions of the table.
 */
export interface RowFlipOptions {
  /** 0 disables the animation and snaps to the new order. */
  duration?: number;
  ease?: Ease;
}

/**
 * The template row — a group of cells the runtime clones once per data row.
 *
 * Cells are ordinary layers carrying `cell: '<columnKey>'`, which is what keeps
 * tables inside the existing layer system: fit-width, styling and (later) masks
 * work per-cell for free because a cell *is* a layer.
 *
 * Template layers' keyframe tracks **are** played, once per row.
 *
 * Cell time zero is the moment that row reveals, not the table's in-point: the
 * cell rides its row's reveal stagger. The alternative spends row twenty's
 * animation while row twenty is still off-screen waiting its turn.
 *
 * This costs one tween per cell per property regardless of row count — every
 * row's copy of a cell is one target array and GSAP's `stagger` supplies the
 * per-row offset. The shape originally imagined for this, one child timeline
 * per cell per row, is what made it look too expensive to build.
 *
 * A cell that carries keyframes hands its transform and opacity to GSAP
 * outright; one that does not keeps a cheap hand-written `style.transform` and
 * costs nothing. See `TableBlock.buildRow`.
 */
export interface TableRowTemplate {
  /** Row pitch in px — the y-step between consecutive rows. */
  height: number;
  /** Extra px between rows, on top of `height`. */
  gap?: number;
  /** Cell layers, positioned relative to the row box. */
  cells: Layer[];
}

export interface TableLayer extends LayerBase {
  type: 'table';
  /**
   * Data-source id feeding this table. The server pushes matching DataSets
   * under the reserved `$data` update key.
   */
  source?: string;
  /**
   * Dynamic-field name. `update({ [binding]: rows })` replaces the data
   * wholesale, which is how an operator edits a manual table on air and how a
   * REST caller or host script drives one.
   */
  binding?: string;
  /**
   * Rows carried in the composition itself — the authoring placeholder and the
   * offline fallback when a fetched source answers with nothing.
   */
  data?: { columns: DataColumn[]; rows: DataRow[] };
  /** Sort/filter/limit/rank pipeline, applied in order. */
  transforms?: DataTransform[];
  row: TableRowTemplate;
  /** 0 or omitted shows every row that fits the layer box. */
  rowsPerPage?: number;
  /**
   * Row placement. `rows` — a single column at a fixed pitch — is the only
   * mode, and the default.
   *
   * A `bracket` mode was reserved here and never built. It is gone rather than
   * still reserved: drawing a playoff tree needs nothing from the table layer
   * that it does not already have — one table per round column, pitch doubling
   * per tier, does it (`examples/world-cup-bracket.json` is the full 32-team
   * proof) — while a bracket mode would have had to emit connector geometry the
   * author never wrote and quietly refuse `flip` and `rowsPerPage`, neither of
   * which means anything on a tree. The part of a bracket that is genuinely
   * hard is resolving it, and that is `{ op: 'advance' }` in the data pipeline.
   */
  layout?: 'rows';
  rowAnim?: RowAnimPreset;
  flip?: RowFlipOptions;
}

export interface CompositionLayer extends LayerBase {
  type: 'composition';
  /** id of another composition in the same project. */
  ref: string;
  /** Binding values pushed into the nested composition on load. */
  overrides?: Record<string, unknown>;
  /**
   * Mount this reference as its own independently triggered graphic instead of
   * inlining it into the parent timeline (SCENES.md §2).
   *
   * Absent or false is the original behavior and stays the default: the child
   * is flattened into the parent's timeline at `in`, which is what a reusable
   * badge inside a lower third wants — the badge should animate as part of the
   * strap. True makes it a sibling graphic that shares the page and nothing
   * else: its own timeline, its own play/stop, its own control channel.
   *
   * A composition holding independent children is what the user guide calls a
   * scene. It is not a distinct document type and carries no marker of its own;
   * a scene is simply a composition whose children happen to be independent.
   */
  independent?: boolean;
  /**
   * Control channel for an independent element. Defaults to `ref`.
   *
   * Two jobs. It disambiguates repeated instances — the HOME/AWAY badge that
   * `overrides` already supports would otherwise put both copies on
   * `<project>/badge` and fire both on every trigger. And it gives an element a
   * short operator-facing address that survives the referenced composition
   * being rebuilt, since the default is that composition's generated id.
   *
   * Ignored — and rejected by the validator — unless `independent` is true. A
   * field that silently does nothing is worse than a refused save.
   */
  channel?: string;
}

export interface GroupLayer extends LayerBase {
  type: 'group';
  children: Layer[];
}

export type Layer =
  | ShapeLayer
  | TextLayer
  | ImageLayer
  | VideoLayer
  | SpriteLayer
  | CrawlLayer
  | TableLayer
  | CompositionLayer
  | GroupLayer;

/* ------------------------------------------------------------ composition */

export interface Stage {
  width: number;
  height: number;
  fps: number;
  /** 'transparent' for playout; a CSS color is useful for editor previews only. */
  background: string;
}

export interface Marker {
  /**
   * `stop` — playback holds here awaiting `stop()`/`next()`. Multiple stop
   * markers define the steps of a multi-state graphic.
   * `cue` — informational label, no playback effect.
   */
  type: 'stop' | 'cue';
  time: number;
  id?: string;
  name?: string;
}

export interface Composition {
  formatVersion: typeof FORMAT_VERSION;
  id: string;
  name: string;
  /** Explicit total length in seconds. Omit to derive from the last keyframe. */
  duration?: number;
  stage: Stage;
  markers?: Marker[];
  layers: Layer[];
  /** Free-form authoring metadata; never read by the runtime. */
  meta?: Record<string, unknown>;
}

/** A project is one or more compositions plus an asset manifest. */
export interface Project {
  formatVersion: typeof FORMAT_VERSION;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  compositions: Composition[];
  /**
   * **Legacy — read on migration, never written.** The asset index moved to a
   * sibling `assets.json` in Phase 7.5 (ASSETS.md §6) because `registerAsset`
   * rewrote the whole project document, compositions included, on every upload.
   * The key stays in the type so a project written before the split still
   * parses; `readAssets` lifts it into `assets.json` on first read and the next
   * project write drops it.
   */
  assets?: AssetRef[];
}

/**
 * One file in a project's asset bin.
 *
 * Grouped by who fills each field in, which is the distinction that matters
 * (ASSETS.md §4): technical fields are derived at ingest and must never be
 * hand-edited, descriptive and rights fields are manual and must never be
 * guessed. Everything past `kind` is optional, so an `AssetRef` written before
 * Phase 7.5 is still valid.
 */
export interface AssetRef {
  /** Content hash prefix. The bytes *are* the identity. */
  id: string;
  /** Path relative to the project's `assets/` folder. */
  path: string;
  kind: 'image' | 'video' | 'font' | 'audio' | 'other';

  /* technical — derived at ingest, never hand-edited */
  originalName?: string;
  bytes?: number;
  /** ISO 8601. Absent on assets uploaded before Phase 7.5. */
  addedAt?: string;
  width?: number;
  height?: number;
  /** Seconds. Video and audio only. */
  duration?: number;
  /**
   * Whether the file carries transparency.
   *
   * Persisted rather than re-probed because it is the single fact that decides
   * whether a video works as a stinger, and `inspect()` was already computing
   * it on demand and throwing it away. Note the VP9 subtlety:
   * ffprobe reports this server's own alpha output as
   * `yuv420p`, because a VP9 alpha channel rides alongside the primary stream
   * rather than in it. `inspect()` reads the container's `alpha_mode` tag too.
   */
  hasAlpha?: boolean;
  codec?: string;

  /* descriptive — manual */
  /** Display name. The UI falls back to `originalName`; this is not defaulted on disk. */
  title?: string;
  description?: string;
  tags?: string[];
  /**
   * Organizing label — typically a composition name, since a "scene" is a
   * composition (SCENES.md).
   *
   * A label, deliberately not a directory and not a foreign key. As a path it
   * would break content addressing, and it would land inside every referencing
   * layer's `src`, so re-filing an asset would blank the graphic (ASSETS.md §3).
   */
  folder?: string;

  /* administrative */
  state?: 'draft' | 'approved' | 'retired';
  notes?: string;

  /* rights */
  /** Who supplied the file. */
  source?: string;
  usage?: 'unrestricted' | 'licensed' | 'single-use';
  /** ISO date. Sponsor packages expire; graphics referencing them do not know. */
  expiresAt?: string;

  /* provenance */
  /** Set when the file was copied in from the shared store (ASSETS.md §3). */
  origin?: AssetOrigin;
  /** Previous asset id, set by Replace. */
  supersedes?: string;

  /** For fonts: the family name to use in `TextStyle.fontFamily`. */
  fontFamily?: string;
}

/**
 * Where a copied asset came from.
 *
 * The shared store copies bytes rather than linking them, so a central delete
 * cannot reach a project that is on air. `slug` is the stable identity and
 * `hash` is the identity of the bytes copied — stale means *same slug,
 * different hash*, which is the whole rebrand story.
 */
export interface AssetOrigin {
  store: 'shared';
  slug: string;
  hash: string;
}

/* -------------------------------------------------------------- defaults */

export const DEFAULT_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  skewX: 0,
  skewY: 0,
  anchorX: 0,
  anchorY: 0,
};

export const DEFAULT_STAGE: Stage = {
  width: 1920,
  height: 1080,
  fps: 60,
  background: 'transparent',
};

/* -------------------------------------------------------- control surface */

/** The four control verbs every consumer of the runtime implements. */
export type ControlVerb = 'play' | 'stop' | 'next' | 'update';

/** Payload for `update()` — dynamic-field name to value. */
export type BindingData = Record<string, unknown>;

/** Runtime playback states. */
export type PlaybackState = 'idle' | 'playing-in' | 'holding' | 'playing-out' | 'finished';
