// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Layer thumbnails — the pure half.
 *
 * Deliberately **not** a DOM-to-bitmap render. html2canvas is heavy, blocks on
 * layout, and lies about fonts — a preview that shows the wrong typeface is
 * worse than a glyph, because it invites an author to trust it.
 *
 * Instead each layer type gets a descriptor a component can render cheaply and
 * faithfully: the asset itself for images, an SVG swatch built from the layer's
 * real fill and radius for shapes, an "Ag" sample in the layer's own font for
 * text. All are pure functions of the layer object, so they memoise on it and
 * are unit-testable without a browser.
 */

import type { Fill, Layer } from '@breeze/schema';

export type LayerThumb =
  | { kind: 'image'; src: string; fit: string }
  | { kind: 'video'; src: string }
  | { kind: 'sprite'; src: string; cols: number; rows: number }
  | { kind: 'composition'; ref: string; glyph: string }
  | { kind: 'shape'; fill: string; stroke?: { color: string; width: number }; radius: number; ellipse: boolean }
  | { kind: 'text'; sample: string; fontFamily: string; color: string; weight: string; italic: boolean }
  | { kind: 'stack'; children: LayerThumb[]; count: number }
  | { kind: 'table'; columns: string[]; rows: number }
  | { kind: 'glyph'; glyph: string };

/** Fallback marker, and what a thumbnail degrades to while an asset loads. */
export const TYPE_GLYPH: Record<Layer['type'], string> = {
  shape: '▢',
  text: 'T',
  image: '▣',
  video: '▶',
  sprite: '⊞',
  crawl: '⇄',
  table: '▦',
  composition: '⧉',
  group: '▤',
};

/** Flatten a Fill to something a swatch can paint. Gradients keep their angle. */
export function fillToCss(fill: Fill | undefined, fallback = 'transparent'): string {
  if (!fill) return fallback;
  if (typeof fill === 'string') return fill;
  const stops = [...fill.stops]
    .sort((a, b) => a.pos - b.pos)
    .map((s) => `${s.color} ${(s.pos * 100).toFixed(1)}%`) // i18n-ignore — CSS gradient stop
    .join(', ');
  return fill.type === 'radial'
    ? `radial-gradient(circle at 50% 50%, ${stops})` // i18n-ignore — CSS value
    : `linear-gradient(${fill.angle ?? 180}deg, ${stops})`; // i18n-ignore — CSS value
}

/** How many children a stacked thumbnail samples. Three reads; six is noise. */
const STACK_SAMPLE = 3;

export function layerThumb(layer: Layer): LayerThumb {
  switch (layer.type) {
    case 'image':
      return layer.src
        ? { kind: 'image', src: layer.src, fit: layer.fit ?? 'contain' }
        : { kind: 'glyph', glyph: TYPE_GLYPH.image };

    case 'video':
      return layer.src
        ? { kind: 'video', src: layer.src }
        : { kind: 'glyph', glyph: TYPE_GLYPH.video };

    /*
     * A sprite thumbnails as its *first frame*, not as the sheet.
     *
     * Rendering the whole sheet shrunk into a 32px box is a grey smear that
     * cannot be told apart from any other sheet, which fails the test Phase 7.6
     * set for thumbnails — two graphics that look the same in the panel have
     * failed at the only job they have. The frame maths is the same percentage
     * form `applySpriteFrame` writes, so the panel and the stage agree by
     * construction rather than by two implementations that happen to match.
     */
    case 'sprite':
      return layer.src
        ? { kind: 'sprite', src: layer.src, cols: layer.cols, rows: layer.rows }
        : { kind: 'glyph', glyph: TYPE_GLYPH.sprite };

    case 'shape':
      return {
        kind: 'shape',
        fill: fillToCss(layer.fill, '#1f6feb'),
        ...(layer.stroke && layer.stroke.width > 0 ? { stroke: layer.stroke } : {}),
        radius: layer.shape === 'ellipse' ? 50 : Math.min(50, layer.cornerRadius ?? 0),
        ellipse: layer.shape === 'ellipse',
      };

    case 'text':
    case 'crawl': {
      const style = layer.style;
      return {
        kind: 'text',
        // The layer's own opening characters where there are any: a strap that
        // says "Jane Doe" is identified faster by "Jan" than by "Ag".
        sample: sampleFrom(layer.type === 'text' ? layer.text : layer.items[0] ?? ''),
        fontFamily: style.fontFamily,
        color: typeof style.fill === 'string' ? style.fill : '#ffffff',
        weight: String(style.fontWeight ?? 400),
        italic: style.fontStyle === 'italic',
      };
    }

    case 'table':
      return {
        kind: 'table',
        columns: (layer.data?.columns ?? []).slice(0, 4).map((c) => c.label ?? c.key),
        rows: layer.data?.rows.length ?? 0,
      };

    case 'group':
      return {
        kind: 'stack',
        children: layer.children.slice(0, STACK_SAMPLE).map(layerThumb),
        count: layer.children.length,
      };

    /*
     * A composition names the graphic to render; it cannot render it here.
     *
     * This module is pure — it decides what a thumbnail *is* from the layer
     * alone — and a nested composition needs the project to resolve `ref`, a
     * DOM to build into, and a runtime to pose. All three belong to
     * `LayerThumb.tsx`, so the decision stops at "render this ref as a still"
     * and the impure half acts on it. Same split as `image` naming a `src` it
     * does not load.
     *
     * The glyph survives as the fallback for a ref that resolves to nothing —
     * and for scenes, which a single runtime renders wrongly rather than not at
     * all (see `composition-thumb.ts`).
     */
    case 'composition':
      return { kind: 'composition', ref: layer.ref, glyph: TYPE_GLYPH.composition };

    default: {
      const exhaustive: never = layer;
      throw new Error(`unknown layer type ${JSON.stringify(exhaustive)}`); // i18n-ignore — exhaustiveness guard, never reaches a user
    }
  }
}

/**
 * Up to three printable characters, or "Ag" for empty text.
 *
 * "Ag" is the typographer's sample for a reason — a cap height and a descender
 * in two glyphs — and it is the honest answer for a layer with no content yet.
 */
export function sampleFrom(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'Ag';
  return [...trimmed].slice(0, 3).join('');
}
