// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * PSD → Breeze layers.
 *
 * The last item in Phase 7, and the one place a format parser was deliberately
 * kept **out** of the server. Every other import this project accepts arrives as
 * a raw body precisely so nothing has to parse it before a filesystem write
 * (Wave 0), and PSD is a far richer surface than the zip that earned the one
 * exception. Running ag-psd in the browser means a malformed PSD costs the
 * operator a tab, not the machine feeding the switcher — and it buys two things
 * the server could not offer anyway: per-layer progress, and a plan the operator
 * can look at before anything is written.
 *
 * **What this file is.** The decomposition, as a pure function over an
 * ag-psd-shaped document. It returns layers with empty `src` fields plus a list
 * of canvases to upload; the caller uploads, then patches each `src` by id.
 * Split that way so the mapping decisions below are testable without a browser,
 * a canvas or a network.
 *
 * **Fidelity is explicitly not the goal.** A Photoshop comp that round-trips
 * pixel-identically would have to be entirely rasterised, and a rasterised lower
 * third cannot take a name from the control panel — which is most of what Breeze
 * is for. So text becomes real text wherever the mapping is safe, and falls back
 * to pixels where it is not. The import is a starting point an operator adjusts,
 * and `rasterReasons` exists so they are told which layers were flattened and
 * why rather than discovering it when a binding does not appear.
 */

import { makeId } from '@breeze/schema';
import type { GroupLayer, ImageLayer, Layer, TextLayer } from '@breeze/schema';

/* -------------------------------------------------------------- ag-psd shape */

/**
 * The subset of ag-psd's `Layer` this reads.
 *
 * Structural rather than imported so the planner can be tested with plain
 * objects. ag-psd's own types are wider than anything here needs, and taking a
 * dependency on them in the signature would mean constructing a full `Psd` to
 * assert that a text layer with a drop shadow gets rasterised.
 */
export interface PsdLayerLike {
  name?: string;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  hidden?: boolean;
  opacity?: number;
  blendMode?: string;
  children?: PsdLayerLike[];
  canvas?: unknown;
  effects?: unknown;
  clipping?: boolean;
  text?: {
    text?: string;
    transform?: number[];
    style?: {
      font?: { name?: string };
      fontSize?: number;
      fillColor?: { r?: number; g?: number; b?: number };
      fauxBold?: boolean;
      fauxItalic?: boolean;
    };
    paragraphStyle?: { justification?: string };
  };
}

export interface PsdLike {
  width: number;
  height: number;
  children?: PsdLayerLike[];
}

/** A layer whose pixels have to be uploaded before its `src` means anything. */
export interface PlannedRaster {
  /** Matches the id of the layer in `layers` whose `src` this fills. */
  layerId: string;
  /** Filename offered to the asset bin. */
  name: string;
  /** ag-psd's rendered canvas for this layer. */
  canvas: unknown;
}

export interface PsdPlan {
  layers: Layer[];
  rasters: PlannedRaster[];
  /** Layer name → why it could not stay editable text. Shown to the operator. */
  rasterReasons: Array<{ name: string; reason: string }>;
  /** Layers dropped entirely, with the reason. */
  skipped: Array<{ name: string; reason: string }>;
}

/* ------------------------------------------------------------------ helpers */

const IDENTITY = [1, 0, 0, 1, 0, 0];

/**
 * Is this text laid out in a way a CSS text layer can reproduce?
 *
 * ag-psd exposes a 2×3 affine for text. Translation is fine — it is already
 * accounted for by the layer's box — but any scale, rotation or skew means
 * Photoshop is drawing glyphs through a matrix, and a text layer that ignored
 * it would render at the wrong size in the right place, which reads as a bug
 * rather than as a limitation.
 */
function textTransformIsPlain(transform: number[] | undefined): boolean {
  if (!transform) return true;
  const [a, b, c, d] = transform;
  return (
    Math.abs((a ?? IDENTITY[0]!) - 1) < 1e-6 &&
    Math.abs(b ?? 0) < 1e-6 &&
    Math.abs(c ?? 0) < 1e-6 &&
    Math.abs((d ?? IDENTITY[3]!) - 1) < 1e-6
  );
}

/** Photoshop's 0..255 triples to `#rrggbb`. */
function toHex(color: { r?: number; g?: number; b?: number } | undefined): string {
  const part = (n: number | undefined): string =>
    Math.max(0, Math.min(255, Math.round(n ?? 0))).toString(16).padStart(2, '0');
  return `#${part(color?.r)}${part(color?.g)}${part(color?.b)}`;
}

function alignOf(justification: string | undefined): 'left' | 'center' | 'right' {
  if (justification === 'center') return 'center';
  if (justification === 'right') return 'right';
  return 'left';
}

/**
 * Why this text layer cannot stay text, or null if it can.
 *
 * Returned as a reason string rather than a boolean because the operator is
 * shown it. "3 layers were flattened" invites a bug report; "Title — has layer
 * effects" invites deleting the effect and re-importing.
 */
export function rasterReasonFor(layer: PsdLayerLike): string | null {
  if (!layer.text?.text) return null;
  if (layer.effects) return 'has layer effects (stroke, shadow or glow)';
  if (!textTransformIsPlain(layer.text.transform)) return 'the text is scaled, rotated or skewed';
  if (!layer.text.style?.font?.name) return 'no font could be read from the layer';
  if (!layer.text.style.fontSize) return 'no font size could be read from the layer';
  return null;
}

/** Pixel box, defaulting to empty when Photoshop gave no bounds. */
function boxOf(layer: PsdLayerLike): { x: number; y: number; width: number; height: number } {
  const x = layer.left ?? 0;
  const y = layer.top ?? 0;
  return { x, y, width: Math.max(0, (layer.right ?? x) - x), height: Math.max(0, (layer.bottom ?? y) - y) };
}

/**
 * A Photoshop font string to a CSS stack.
 *
 * `MyriadPro-BoldIt` is a PostScript name, not a family, and no browser has it.
 * The suffix is where the weight and slant live, so it is read and dropped —
 * and a generic fallback goes on the end because the font almost certainly is
 * not installed on the graphics box either. A strap in the wrong face is
 * fixable; one that silently falls back to Times is how a show goes out wrong.
 */
export function fontFrom(psdFont: string): { family: string; weight?: number; italic: boolean } {
  const [rawFamily = psdFont, suffix = ''] = psdFont.split('-');
  const family = rawFamily.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  const italic = /it(alic)?$/i.test(suffix);
  const weights: Array<[RegExp, number]> = [
    [/black|heavy/i, 900],
    [/extrabold|ultrabold/i, 800],
    [/semibold|demibold/i, 600],
    [/bold/i, 700],
    [/medium/i, 500],
    [/light/i, 300],
    [/thin|hairline/i, 100],
  ];
  const weight = weights.find(([re]) => re.test(suffix))?.[1];
  return { family: `${family}, Arial, sans-serif`, ...(weight ? { weight } : {}), italic };
}

/* ------------------------------------------------------------------ planner */

/**
 * Turn a parsed PSD into Breeze layers plus the pixels still to upload.
 *
 * Order is reversed on purpose. Photoshop lists layers bottom-first and Breeze
 * paints in array order with later layers on top — the same convention — but
 * the *layers panel* shows the array top-down, so importing without reversing
 * puts the background at the top of the panel and the title at the bottom, and
 * every operator's first act is to drag them all back.
 */
export function planPsdImport(psd: PsdLike, opts: { nameHint?: string } = {}): PsdPlan {
  const plan: PsdPlan = { layers: [], rasters: [], rasterReasons: [], skipped: [] };
  let rasterIndex = 0;

  const visit = (source: PsdLayerLike[]): Layer[] => {
    const out: Layer[] = [];

    for (const layer of source) {
      const name = layer.name?.trim() || 'Layer';
      const box = boxOf(layer);

      // A group is a group whether or not Photoshop calls it one; `children`
      // is the only signal ag-psd gives.
      if (layer.children?.length) {
        const children = visit(layer.children);
        if (children.length === 0) {
          plan.skipped.push({ name, reason: 'the group is empty' });
          continue;
        }
        const group: GroupLayer = {
          id: makeId('grp'),
          type: 'group',
          name,
          children,
          transform: { x: 0, y: 0 },
          opacity: layer.opacity ?? 1,
          ...(layer.hidden ? { visible: false } : {}),
        } as GroupLayer;
        out.push(group);
        continue;
      }

      /*
       * A clipping layer is dropped rather than imported flat.
       *
       * In Photoshop it masks to the layer beneath; imported as an ordinary
       * layer it would cover it instead — visually the opposite of what the
       * designer built, and silently so. Naming it in `skipped` is more use
       * than a wrong graphic.
       */
      if (layer.clipping) {
        plan.skipped.push({ name, reason: 'clipping masks are not imported — flatten it in Photoshop first' });
        continue;
      }

      const reason = rasterReasonFor(layer);

      if (layer.text?.text && !reason) {
        const style = layer.text.style!;
        const font = fontFrom(style.font!.name!);
        const text: TextLayer = {
          id: makeId('txt'),
          type: 'text',
          name,
          text: layer.text.text.replace(/\r/g, '\n'),
          size: { width: box.width, height: box.height },
          transform: { x: box.x, y: box.y },
          opacity: layer.opacity ?? 1,
          ...(layer.hidden ? { visible: false } : {}),
          style: {
            fontFamily: font.family,
            fontSize: style.fontSize!,
            ...(font.weight ? { fontWeight: font.weight } : {}),
            ...(font.italic || style.fauxItalic ? { fontStyle: 'italic' as const } : {}),
            fill: toHex(style.fillColor),
            align: alignOf(layer.text.paragraphStyle?.justification),
          },
        } as TextLayer;
        out.push(text);
        continue;
      }

      if (layer.text?.text && reason) plan.rasterReasons.push({ name, reason });

      if (!layer.canvas || box.width === 0 || box.height === 0) {
        plan.skipped.push({ name, reason: 'the layer has no pixels' });
        continue;
      }

      const image: ImageLayer = {
        id: makeId('img'),
        type: 'image',
        name,
        // Filled in by the caller once the canvas has been uploaded. An empty
        // `src` is a layer the properties panel already explains — "not in the
        // asset bin" — so a failed upload degrades to something legible.
        src: '',
        size: { width: box.width, height: box.height },
        transform: { x: box.x, y: box.y },
        opacity: layer.opacity ?? 1,
        // `fill` rather than `contain`: the box is the layer's own bounds, so
        // the pixels already fit it exactly, and `contain` would letterbox on
        // any rounding.
        fit: 'fill',
        ...(layer.hidden ? { visible: false } : {}),
      } as ImageLayer;

      out.push(image);
      plan.rasters.push({
        layerId: image.id,
        name: `${opts.nameHint ? `${opts.nameHint}-` : ''}${String(rasterIndex++).padStart(2, '0')}-${
          name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'layer'
        }.png`,
        canvas: layer.canvas,
      });
    }

    return out.reverse();
  };

  plan.layers = visit(psd.children ?? []);
  return plan;
}
