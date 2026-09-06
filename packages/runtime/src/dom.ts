// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Composition JSON → DOM. Nothing here animates; the timeline layer owns motion.
 *
 * Each call builds exactly ONE layer element. Nesting is resolved upstream in
 * `expand.ts`, and the runtime assembles the tree by parent id — so groups and
 * nested compositions cannot end up with different id or offset rules here
 * than the timeline planner used.
 *
 *   <div class="bz-layer">        ← GSAP transform/opacity/filter target
 *     <div class="bz-content">    ← type-specific content, or child layers
 */

import {
  DEFAULT_TRANSFORM,
  type CrawlLayer,
  type Fill,
  type ImageLayer,
  type Layer,
  type ShapeLayer,
  type SpriteLayer,
  type TextLayer,
  type TextStyle,
  type VideoLayer,
} from '@breeze/schema';

import type { LayerInstance } from './expand.js';

export interface LayerNodes {
  instance: LayerInstance;
  layer: Layer;
  /** Outer element — animation target. */
  el: HTMLElement;
  /** Inner content wrapper; child layers are appended here. */
  content: HTMLElement;
  /** Text-only: the span carrying the glyphs (fit-scaled). */
  textInner?: HTMLElement;
  /** Crawl-only: the scrolling track. */
  crawlTrack?: HTMLElement;
  media?: HTMLImageElement | HTMLVideoElement;
  video?: HTMLVideoElement;
  /**
   * Video-in-a-still only: the `<img>` standing in for the element.
   *
   * Mutually exclusive with `video` — a still never builds one — which is what
   * lets the runtime decide between `VideoSync` and `PosterSync` by asking
   * which of the two is set rather than by re-reading its own mode.
   */
  poster?: HTMLImageElement;
  /** Sprite-only: the box carrying the sheet as a background. */
  sprite?: HTMLElement;
}

export interface BuildContext {
  doc: Document;
  /** Resolves `assets/logo.png` to a URL the page can load. */
  resolveAsset: (src: string) => string;
  /**
   * Building one paused frame — see `RuntimeOptions.still`.
   *
   * Only video reads it today: a still shows a captured poster frame instead of
   * instantiating media. Everything else builds identically, which is the
   * property `still.dom.test.ts` guards.
   */
  still?: boolean;
}

export function fillToCss(fill: Fill | undefined, fallback = 'transparent'): string {
  if (!fill) return fallback;
  if (typeof fill === 'string') return fill;
  const stops = fill.stops
    .slice()
    .sort((a, b) => a.pos - b.pos)
    .map((s) => `${s.color} ${(s.pos * 100).toFixed(2)}%`)
    .join(', ');
  if (fill.type === 'radial') return `radial-gradient(circle at 50% 50%, ${stops})`;
  return `linear-gradient(${fill.angle ?? 180}deg, ${stops})`;
}

function applyTextStyle(el: HTMLElement, style: TextStyle): void {
  const s = el.style;
  s.fontFamily = style.fontFamily;
  s.fontSize = `${style.fontSize}px`;
  if (style.fontWeight !== undefined) s.fontWeight = String(style.fontWeight);
  if (style.fontStyle) s.fontStyle = style.fontStyle;
  if (style.letterSpacing !== undefined) s.letterSpacing = `${style.letterSpacing}px`;
  s.lineHeight = style.lineHeight !== undefined ? String(style.lineHeight) : '1.15';
  if (style.textTransform) s.textTransform = style.textTransform;

  // Gradient text needs background-clip; flat color is a plain fill.
  if (style.fill && typeof style.fill !== 'string') {
    s.backgroundImage = fillToCss(style.fill);
    s.setProperty('background-clip', 'text');
    s.setProperty('-webkit-background-clip', 'text');
    s.color = 'transparent';
  } else {
    s.color = (style.fill as string | undefined) ?? '#ffffff';
  }

  if (style.stroke && style.stroke.width > 0) {
    // -webkit-text-stroke is supported in every CEF build vMix/OBS ship with.
    s.setProperty('-webkit-text-stroke-width', `${style.stroke.width}px`);
    s.setProperty('-webkit-text-stroke-color', style.stroke.color);
    s.setProperty('paint-order', 'stroke fill');
  }

  if (style.shadow) {
    const sh = style.shadow;
    s.textShadow = `${sh.offsetX}px ${sh.offsetY}px ${sh.blur}px ${sh.color}`;
  }
}

function alignToFlex(align: TextStyle['align']): string {
  if (align === 'center') return 'center';
  if (align === 'right') return 'flex-end';
  return 'flex-start';
}

function vAlignToFlex(v: TextStyle['verticalAlign']): string {
  if (v === 'middle') return 'center';
  if (v === 'bottom') return 'flex-end';
  return 'flex-start';
}

/* ------------------------------------------------------------ layer types */

function buildShape(layer: ShapeLayer, ctx: BuildContext): Element {
  if (layer.shape === 'path') return buildPathShape(layer, ctx);

  const el = ctx.doc.createElement('div');
  el.className = 'bz-shape';
  el.style.background = fillToCss(layer.fill, '#ffffff');
  if (layer.shape === 'ellipse') {
    el.style.borderRadius = '50%';
  } else if (layer.cornerRadius) {
    el.style.borderRadius = `${layer.cornerRadius}px`;
  }
  if (layer.stroke && layer.stroke.width > 0) {
    el.style.border = `${layer.stroke.width}px solid ${layer.stroke.color}`;
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Unique enough for one document; SVG ids are document-global. */
let gradientCounter = 0;

/**
 * A path shape — the one shape CSS cannot draw (MASKS.md §5).
 *
 * Rendered as a real `<svg>` rather than as a `clip-path: path()` on the
 * existing div, which was the cheaper-looking option and is wrong: a clipped
 * div can carry a fill but its border is still a rectangle, so a stroked path
 * — a drawn line, an underline, a pointer — would have had no outline at all.
 * A line is most of what a pen tool is for.
 *
 * **No `viewBox`, and `overflow: visible`.** One user unit is one layer pixel
 * that way, so `d` is authored in exactly the coordinates the panel shows and
 * the pen tool drags. And geometry outside the layer's own box still paints,
 * which is the same rule Wave A settled for masks: the box only has to exist,
 * the geometry lives in the shape.
 */
function buildPathShape(layer: ShapeLayer, ctx: BuildContext): SVGSVGElement {
  const svg = ctx.doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'bz-shape bz-path');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.style.overflow = 'visible';

  const path = ctx.doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', layer.path ?? '');

  /*
   * Unlike a rect, a path with no authored fill is left unfilled rather than
   * defaulted to white: an open path is a line, and SVG would otherwise close
   * it implicitly and paint the area under it.
   */
  if (layer.fill === undefined) {
    path.setAttribute('fill', 'none');
  } else if (typeof layer.fill === 'string') {
    path.setAttribute('fill', layer.fill);
  } else {
    path.setAttribute('fill', svgGradient(layer.fill, svg, ctx));
  }

  if (layer.stroke && layer.stroke.width > 0) {
    path.setAttribute('stroke', layer.stroke.color);
    path.setAttribute('stroke-width', String(layer.stroke.width));
    // Round joins and caps because a drawn path is usually organic; a mitre
    // spike on a tight corner reads as a rendering fault rather than a choice.
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');
  }

  svg.appendChild(path);
  return svg;
}

/**
 * An SVG gradient def for a path's fill, returned as a `url(#…)` reference.
 *
 * A path cannot take `fillToCss`'s output — `linear-gradient()` is a CSS image
 * and SVG's `fill` wants a paint — so the same `Gradient` is re-expressed as a
 * def inside the layer's own `<svg>`, where it is destroyed with the layer and
 * needs no separate bookkeeping.
 *
 * **The angle is converted through the bounding box, not through CSS's
 * corner-projection rule.** CSS sizes a gradient line so its ends project onto
 * the corners; this maps the angle onto a line across the box instead. The two
 * agree exactly at 0/90/180/270° — which is every gradient anyone authors on a
 * strap — and differ slightly in where the stops land on the diagonals. Worth
 * stating because the same fill on a rect and on a path is then very slightly
 * different at 45°, and that is a real if minor divergence rather than a bug to
 * go hunting later.
 */
function svgGradient(fill: Exclude<Fill, string>, svg: SVGSVGElement, ctx: BuildContext): string {
  gradientCounter += 1;
  const id = `bz-grad-${gradientCounter}`;

  const defs = ctx.doc.createElementNS(SVG_NS, 'defs');
  const stops = [...fill.stops].sort((a, b) => a.pos - b.pos);

  let node: SVGElement;
  if (fill.type === 'radial') {
    node = ctx.doc.createElementNS(SVG_NS, 'radialGradient');
    node.setAttribute('cx', '50%');
    node.setAttribute('cy', '50%');
    node.setAttribute('r', '50%');
  } else {
    node = ctx.doc.createElementNS(SVG_NS, 'linearGradient');
    // CSS convention: 0deg points to the top, angles run clockwise.
    const rad = ((fill.angle ?? 180) * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    node.setAttribute('x1', String(0.5 - dx / 2));
    node.setAttribute('y1', String(0.5 - dy / 2));
    node.setAttribute('x2', String(0.5 + dx / 2));
    node.setAttribute('y2', String(0.5 + dy / 2));
  }
  node.setAttribute('id', id);

  for (const stop of stops) {
    const el = ctx.doc.createElementNS(SVG_NS, 'stop');
    el.setAttribute('offset', `${stop.pos * 100}%`);
    el.setAttribute('stop-color', stop.color);
    node.appendChild(el);
  }

  defs.appendChild(node);
  svg.appendChild(defs);
  return `url(#${id})`;
}

function buildText(layer: TextLayer, ctx: BuildContext): { el: HTMLElement; inner: HTMLElement } {
  const el = ctx.doc.createElement('div');
  el.className = 'bz-text';
  el.style.justifyContent = alignToFlex(layer.style.align);
  el.style.alignItems = vAlignToFlex(layer.style.verticalAlign);
  if (layer.style.background) {
    el.style.background = fillToCss(layer.style.background);
  }
  if (layer.style.padding) {
    el.style.padding = `${layer.style.padding}px`;
  }

  const inner = ctx.doc.createElement('span');
  inner.className = 'bz-text-inner';
  applyTextStyle(inner, layer.style);
  inner.style.transformOrigin =
    layer.style.align === 'center' ? 'center center'
    : layer.style.align === 'right' ? 'right center'
    : 'left center';
  inner.textContent = layer.text;

  el.appendChild(inner);
  return { el, inner };
}

function buildImage(layer: ImageLayer, ctx: BuildContext): HTMLImageElement {
  const img = ctx.doc.createElement('img');
  img.className = 'bz-image';
  img.draggable = false;
  img.style.objectFit = layer.fit ?? 'contain';
  if (layer.src) img.src = ctx.resolveAsset(layer.src);
  return img;
}

/**
 * A sprite sheet renders as a box with a `background-image`, not an `<img>`.
 *
 * An `<img>` can only show a whole file, so stepping frames would mean either
 * a clipping wrapper with the image offset by `transform` — which collides
 * head-on with the rule that GSAP owns the transform of anything it animates,
 * since it rewrites the whole string — or a canvas, which costs a draw per
 * frame and a second surface to keep in sync with the timeline.
 * `background-position` is a property nothing else on the layer touches.
 *
 * `background-size` states the *sheet* size as a multiple of the layer box, so
 * one cell exactly fills the box regardless of the sheet's pixel dimensions.
 * That means the frame solver only ever writes percentages, and a sheet
 * re-exported at twice the resolution needs no change to the layer.
 */
function buildSprite(layer: SpriteLayer, ctx: BuildContext): HTMLElement {
  const el = ctx.doc.createElement('div');
  el.className = 'bz-sprite';
  el.style.backgroundRepeat = 'no-repeat';
  el.style.backgroundSize = `${layer.cols * 100}% ${layer.rows * 100}%`;
  if (layer.src) el.style.backgroundImage = `url("${ctx.resolveAsset(layer.src)}")`;
  // Frame 0 up front rather than waiting for the first tick: a graphic that is
  // built but not yet playing — the editor canvas, a still, a page holding
  // before its trigger — should show the first frame, not the whole sheet.
  applySpriteFrame(el, layer, 0);
  return el;
}

/**
 * Point a sprite element at frame `index`.
 *
 * The percentage form of `background-position` divides by `n - 1`, not by `n`:
 * at 100% the *image's* right edge meets the *box's* right edge, so with a
 * 6-wide sheet the six columns land at 0%, 20%, 40%, 60%, 80%, 100%. Dividing
 * by `cols` instead is the off-by-one that shows the last frame half-cropped
 * with the neighbouring column bleeding in beside it.
 *
 * A single-column or single-row grid divides by zero under that rule, so it is
 * pinned to 0% — one column has nowhere to scroll to.
 */
export function applySpriteFrame(el: HTMLElement, layer: SpriteLayer, index: number): void {
  const col = index % layer.cols;
  const row = Math.floor(index / layer.cols);
  const x = layer.cols > 1 ? (col / (layer.cols - 1)) * 100 : 0;
  const y = layer.rows > 1 ? (row / (layer.rows - 1)) * 100 : 0;
  el.style.backgroundPosition = `${x}% ${y}%`;
}

function buildVideo(layer: VideoLayer, ctx: BuildContext): HTMLVideoElement {
  const video = ctx.doc.createElement('video');
  video.className = 'bz-video';
  // Muted by default and always playsInline: an unmuted autoplaying video is
  // blocked outright by Chromium's autoplay policy, which in a browser source
  // means a stinger that silently never starts.
  video.muted = layer.muted ?? true;
  video.loop = layer.loop ?? false;
  video.playsInline = true;
  video.preload = 'auto';
  video.autoplay = false;
  video.style.objectFit = layer.fit ?? 'contain';
  if (layer.src) video.src = ctx.resolveAsset(layer.src);
  return video;
}

/**
 * A video layer in a still: an `<img>` waiting for a captured frame.
 *
 * No `src` yet, and that is on purpose — an `<img>` with no source renders as
 * nothing, where one pointed at an `.mp4` renders the browser's broken-image
 * icon. `PosterSync` fills it in once the composition has been posed and it
 * knows which frame to take. Same class as a real video so the stylesheet does
 * not need to know the difference, and the same `object-fit`, so a poster is
 * cropped exactly the way the clip would have been.
 */
function buildVideoPoster(layer: VideoLayer, ctx: BuildContext): HTMLImageElement {
  const img = ctx.doc.createElement('img');
  img.className = 'bz-video';
  img.draggable = false;
  img.alt = '';
  img.style.objectFit = layer.fit ?? 'contain';
  return img;
}

function buildCrawl(layer: CrawlLayer, ctx: BuildContext): { el: HTMLElement; track: HTMLElement } {
  const el = ctx.doc.createElement('div');
  el.className = 'bz-crawl';

  const track = ctx.doc.createElement('div');
  track.className = 'bz-crawl-track';
  applyTextStyle(track, layer.style);
  el.appendChild(track);

  // Content is owned by `CrawlLoop`, which fills the track with the two blocks
  // its seam-swap depends on. Seeding text here would only be overwritten.
  return { el, track };
}

/* ----------------------------------------------------------------- build */

/** Build one layer element. Children are appended by the caller. */
export function buildLayerElement(instance: LayerInstance, ctx: BuildContext): LayerNodes {
  const layer = instance.layer;

  const el = ctx.doc.createElement('div');
  el.className = 'bz-layer';
  el.dataset['layerId'] = instance.id;
  el.dataset['type'] = layer.type;
  if (instance.depth > 0) el.dataset['depth'] = String(instance.depth);

  const size = layer.size ?? { width: 0, height: 0 };
  if (size.width) el.style.width = `${size.width}px`;
  if (size.height) el.style.height = `${size.height}px`;

  const t = { ...DEFAULT_TRANSFORM, ...(layer.transform ?? {}) };
  el.style.transformOrigin = `${(t.anchorX * 100).toFixed(4)}% ${(t.anchorY * 100).toFixed(4)}%`;

  if (layer.blendMode) el.style.mixBlendMode = layer.blendMode;
  if (layer.visible === false) el.dataset['hidden'] = '1';

  const content = ctx.doc.createElement('div');
  content.className = 'bz-content';
  el.appendChild(content);

  const nodes: LayerNodes = { instance, layer, el, content };

  switch (layer.type) {
    case 'shape':
      content.appendChild(buildShape(layer, ctx));
      break;
    case 'text': {
      const { el: textEl, inner } = buildText(layer, ctx);
      content.appendChild(textEl);
      nodes.textInner = inner;
      break;
    }
    case 'image': {
      const img = buildImage(layer, ctx);
      content.appendChild(img);
      nodes.media = img;
      break;
    }
    case 'video': {
      if (ctx.still) {
        const poster = buildVideoPoster(layer, ctx);
        content.appendChild(poster);
        nodes.poster = poster;
        break;
      }
      const video = buildVideo(layer, ctx);
      content.appendChild(video);
      nodes.media = video;
      nodes.video = video;
      break;
    }
    case 'sprite': {
      const sprite = buildSprite(layer, ctx);
      content.appendChild(sprite);
      nodes.sprite = sprite;
      break;
    }
    case 'crawl': {
      const { el: crawlEl, track } = buildCrawl(layer, ctx);
      content.appendChild(crawlEl);
      nodes.crawlTrack = track;
      break;
    }
    case 'table':
      // Rows are owned by `TableBlock`, which clones the template row into this
      // element once it has data. Building anything here would only be torn out.
      content.classList.add('bz-table');
      break;
    case 'group':
      content.classList.add('bz-group');
      break;
    case 'composition':
      // Children are the referenced composition's layers, appended by the
      // runtime from the expanded instance list.
      content.classList.add('bz-nested');
      content.dataset['ref'] = layer.ref;
      break;
    default: {
      const exhaustive: never = layer;
      throw new Error(`unknown layer type ${JSON.stringify(exhaustive)}`);
    }
  }

  applyStaticEffects(el, layer);

  return nodes;
}

/** Static CSS filter baseline. Keyframed blur/brightness are re-composed at runtime. */
export function applyStaticEffects(el: HTMLElement, layer: Layer): void {
  el.style.filter = composeFilter(layer, {});
}

/**
 * Filter props a timeline can drive. `dropShadow` is deliberately absent —
 * MASKS.md §3.2: a keyframe track is a track of scalars, a drop shadow is a
 * 4-tuple, and it stays a static baseline read straight from `fx` below.
 */
export interface AnimatedFilterProps {
  blur?: number;
  brightness?: number;
  contrast?: number;
  saturate?: number;
  hueRotate?: number;
  grayscale?: number;
  sepia?: number;
}

export function composeFilter(layer: Layer, animated: AnimatedFilterProps): string {
  const fx = layer.effects ?? {};
  const parts: string[] = [];
  const blur = animated.blur ?? fx.blur;
  const brightness = animated.brightness ?? fx.brightness;
  const contrast = animated.contrast ?? fx.contrast;
  const saturate = animated.saturate ?? fx.saturate;
  const hueRotate = animated.hueRotate ?? fx.hueRotate;
  const grayscale = animated.grayscale ?? fx.grayscale;
  const sepia = animated.sepia ?? fx.sepia;

  if (blur) parts.push(`blur(${blur}px)`);
  if (brightness !== undefined && brightness !== 1) parts.push(`brightness(${brightness})`);
  if (contrast !== undefined && contrast !== 1) parts.push(`contrast(${contrast})`);
  if (saturate !== undefined && saturate !== 1) parts.push(`saturate(${saturate})`);
  if (hueRotate) parts.push(`hue-rotate(${hueRotate}deg)`);
  if (grayscale) parts.push(`grayscale(${grayscale})`);
  if (sepia) parts.push(`sepia(${sepia})`);
  if (fx.dropShadow) {
    const d = fx.dropShadow;
    parts.push(`drop-shadow(${d.offsetX}px ${d.offsetY}px ${d.blur}px ${d.color})`);
  }
  return parts.length ? parts.join(' ') : 'none';
}
