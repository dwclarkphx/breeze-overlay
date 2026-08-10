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
  /** Sprite-only: the box carrying the sheet as a background. */
  sprite?: HTMLElement;
}

export interface BuildContext {
  doc: Document;
  /** Resolves `assets/logo.png` to a URL the page can load. */
  resolveAsset: (src: string) => string;
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

function buildShape(layer: ShapeLayer, ctx: BuildContext): HTMLElement {
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

export function composeFilter(
  layer: Layer,
  animated: { blur?: number; brightness?: number },
): string {
  const fx = layer.effects ?? {};
  const parts: string[] = [];
  const blur = animated.blur ?? fx.blur;
  const brightness = animated.brightness ?? fx.brightness;

  if (blur) parts.push(`blur(${blur}px)`);
  if (brightness !== undefined && brightness !== 1) parts.push(`brightness(${brightness})`);
  if (fx.contrast !== undefined && fx.contrast !== 1) parts.push(`contrast(${fx.contrast})`);
  if (fx.saturate !== undefined && fx.saturate !== 1) parts.push(`saturate(${fx.saturate})`);
  if (fx.hueRotate) parts.push(`hue-rotate(${fx.hueRotate}deg)`);
  if (fx.grayscale) parts.push(`grayscale(${fx.grayscale})`);
  if (fx.sepia) parts.push(`sepia(${fx.sepia})`);
  if (fx.dropShadow) {
    const d = fx.dropShadow;
    parts.push(`drop-shadow(${d.offsetX}px ${d.offsetY}px ${d.blur}px ${d.color})`);
  }
  return parts.length ? parts.join(' ') : 'none';
}
