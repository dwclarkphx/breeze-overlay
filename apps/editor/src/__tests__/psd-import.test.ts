// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * PSD decomposition.
 *
 * The planner is a pure function over an ag-psd-shaped document precisely so
 * these can be plain objects: asserting that a text layer with a drop shadow
 * gets rasterised should not require a browser, a canvas or a .psd fixture.
 *
 * The cases that matter are the boundaries of "stays editable text". Getting
 * that wrong in the permissive direction produces a strap that renders at the
 * wrong size; getting it wrong in the strict direction produces a lower third
 * nobody can bind a name to, which is most of what Breeze is for.
 */

import { describe, expect, it } from 'vitest';
import type { TextLayer } from '@breeze/schema';

import { fontFrom, planPsdImport, rasterReasonFor, type PsdLayerLike } from '../state/psd-import.js';

const textLayer = (over: Partial<PsdLayerLike> = {}): PsdLayerLike => ({
  name: 'Title',
  left: 100,
  top: 50,
  right: 700,
  bottom: 120,
  text: {
    text: 'Jane Doe',
    style: { font: { name: 'Inter-Bold' }, fontSize: 48, fillColor: { r: 255, g: 255, b: 255 } },
    paragraphStyle: { justification: 'left' },
  },
  ...over,
});

const pixelLayer = (over: Partial<PsdLayerLike> = {}): PsdLayerLike => ({
  name: 'Plate',
  left: 0,
  top: 0,
  right: 1920,
  bottom: 200,
  canvas: {},
  ...over,
});

describe('rasterReasonFor', () => {
  it('keeps ordinary text editable', () => {
    expect(rasterReasonFor(textLayer())).toBeNull();
  });

  it('rasterises text carrying layer effects', () => {
    expect(rasterReasonFor(textLayer({ effects: {} }))).toMatch(/effects/);
  });

  it('rasterises text drawn through a scale', () => {
    // A text layer that ignored the matrix would render at the wrong size in
    // the right place, which reads as a bug rather than a limitation.
    expect(rasterReasonFor(textLayer({
      text: { ...textLayer().text!, transform: [2, 0, 0, 2, 0, 0] },
    }))).toMatch(/scaled|rotated|skewed/);
  });

  it('accepts a pure translation, which the box already accounts for', () => {
    expect(rasterReasonFor(textLayer({
      text: { ...textLayer().text!, transform: [1, 0, 0, 1, 320, 64] },
    }))).toBeNull();
  });

  it('rasterises when no font could be read', () => {
    expect(rasterReasonFor(textLayer({
      text: { text: 'x', style: { fontSize: 12 } },
    }))).toMatch(/font/);
  });

  it('has no opinion about a layer that is not text', () => {
    expect(rasterReasonFor(pixelLayer())).toBeNull();
  });
});

describe('fontFrom', () => {
  it('splits a PostScript name into family and weight', () => {
    const f = fontFrom('Inter-Bold');
    expect(f.family).toMatch(/^Inter,/);
    expect(f.weight).toBe(700);
    expect(f.italic).toBe(false);
  });

  it('reads slant out of the suffix', () => {
    expect(fontFrom('Inter-BoldItalic').italic).toBe(true);
    expect(fontFrom('MyriadPro-It').italic).toBe(true);
  });

  it('prefers the more specific weight when suffixes overlap', () => {
    // "SemiBold" contains "Bold"; matching Bold first would give 700 for every
    // semibold face in the document.
    expect(fontFrom('SourceSans-SemiBold').weight).toBe(600);
    expect(fontFrom('SourceSans-ExtraBold').weight).toBe(800);
  });

  it('spaces a camel-cased family', () => {
    expect(fontFrom('HelveticaNeue-Medium').family).toMatch(/^Helvetica Neue,/);
  });

  it('always appends a fallback stack', () => {
    // The font is almost certainly not installed on the graphics box either. A
    // strap in the wrong face is fixable; a silent fall back to Times is not.
    expect(fontFrom('Whatever').family).toContain('sans-serif');
  });
});

describe('planPsdImport', () => {
  const psd = { width: 1920, height: 1080 };

  it('maps a text layer to a text layer with its box', () => {
    const plan = planPsdImport({ ...psd, children: [textLayer()] });
    expect(plan.layers).toHaveLength(1);
    const layer = plan.layers[0]!;
    expect(layer.type).toBe('text');
    expect(layer.transform).toMatchObject({ x: 100, y: 50 });
    expect(layer.size).toEqual({ width: 600, height: 70 });
  });

  it('carries the font, size, colour and alignment across', () => {
    const plan = planPsdImport({
      ...psd,
      children: [textLayer({ text: { ...textLayer().text!, paragraphStyle: { justification: 'center' } } })],
    });
    /*
     * Narrowed through the discriminant rather than cast at the shape.
     *
     * `plan.layers[0]` is a `Layer`, and asserting it into `{ style: … }`
     * is rejected outright — `VideoLayer` has no `style`, so the two types do
     * not overlap and TypeScript refuses the conversion. Checking `type` first
     * narrows the union honestly and makes the assertion say what it means:
     * this layer should be text, and text layers carry a style.
     */
    const layer = plan.layers[0]!;
    expect(layer.type).toBe('text');
    const { style } = layer as TextLayer;

    expect(style.fontSize).toBe(48);
    expect(style.fill).toBe('#ffffff');
    expect(style.align).toBe('center');
    expect(style.fontWeight).toBe(700);
  });

  it('queues a raster for a pixel layer and leaves its src empty', () => {
    const plan = planPsdImport({ ...psd, children: [pixelLayer()] });
    expect(plan.layers[0]!.type).toBe('image');
    expect((plan.layers[0] as { src: string }).src).toBe('');
    expect(plan.rasters).toHaveLength(1);
    expect(plan.rasters[0]!.layerId).toBe(plan.layers[0]!.id);
    expect(plan.rasters[0]!.name).toMatch(/\.png$/);
  });

  it('reverses Photoshop order so the panel reads top-down', () => {
    // Photoshop lists bottom-first. Importing without reversing puts the
    // background at the top of the layers panel and the title at the bottom.
    const plan = planPsdImport({
      ...psd,
      children: [pixelLayer({ name: 'Background' }), textLayer({ name: 'Title' })],
    });
    expect(plan.layers.map((l) => l.name)).toEqual(['Title', 'Background']);
  });

  it('nests a group', () => {
    const plan = planPsdImport({
      ...psd,
      children: [{ name: 'Lower Third', children: [pixelLayer(), textLayer()] }],
    });
    expect(plan.layers[0]!.type).toBe('group');
    expect((plan.layers[0] as { children: unknown[] }).children).toHaveLength(2);
    // A raster inside a group still has to be uploaded.
    expect(plan.rasters).toHaveLength(1);
  });

  it('preserves hidden as visible:false rather than dropping the layer', () => {
    const plan = planPsdImport({ ...psd, children: [textLayer({ hidden: true })] });
    expect(plan.layers[0]!.visible).toBe(false);
  });

  it('reports why a text layer was flattened', () => {
    const plan = planPsdImport({ ...psd, children: [textLayer({ effects: {}, canvas: {} })] });
    expect(plan.layers[0]!.type).toBe('image');
    expect(plan.rasterReasons[0]).toMatchObject({ name: 'Title' });
  });

  it('skips a clipping mask rather than importing it flat', () => {
    // Imported as an ordinary layer it would cover what it was masking —
    // visually the opposite of what the designer built, and silently so.
    const plan = planPsdImport({ ...psd, children: [pixelLayer({ clipping: true })] });
    expect(plan.layers).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toMatch(/clipping/);
  });

  it('skips a layer with no pixels and no text', () => {
    const plan = planPsdImport({ ...psd, children: [{ name: 'Empty', left: 0, top: 0, right: 0, bottom: 0 }] });
    expect(plan.layers).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
  });

  it('gives every layer a distinct id', () => {
    const plan = planPsdImport({
      ...psd,
      children: [pixelLayer({ name: 'a' }), pixelLayer({ name: 'b' }), textLayer({ name: 'c' })],
    });
    const ids = plan.layers.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
