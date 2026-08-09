// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Layer thumbnails.
 *
 * The descriptor is a pure function of the layer, which is the whole reason it
 * is worth having: a preview built by rasterising the stage could not be tested
 * without a browser, and would still be wrong about fonts.
 */

import { describe, expect, it } from 'vitest';
import {
  createShapeLayer,
  createTableLayer,
  createTextLayer,
  type Layer,
} from '@breeze/schema';

import { fillToCss, layerThumb, sampleFrom } from '../state/layer-thumb.js';

describe('sampleFrom', () => {
  it('uses the layer’s own opening characters', () => {
    // "Jan" identifies a strap faster than a generic sample does.
    expect(sampleFrom('Jane Doe')).toBe('Jan');
  });

  it('falls back to Ag for empty text', () => {
    expect(sampleFrom('   ')).toBe('Ag');
  });

  it('counts characters, not code units', () => {
    // Slicing a string would split an emoji or an astral glyph in half.
    expect(sampleFrom('🏆🏆🏆🏆')).toBe('🏆🏆🏆');
  });
});

describe('fillToCss', () => {
  it('passes a flat color through', () => {
    expect(fillToCss('#ff0000')).toBe('#ff0000');
  });

  it('renders a gradient in stop order regardless of how it was authored', () => {
    const css = fillToCss({
      type: 'linear',
      angle: 90,
      stops: [{ pos: 1, color: '#000' }, { pos: 0, color: '#fff' }],
    });
    expect(css).toBe('linear-gradient(90deg, #fff 0.0%, #000 100.0%)');
  });

  it('is the fallback when there is no fill', () => {
    expect(fillToCss(undefined, 'transparent')).toBe('transparent');
  });
});

describe('layerThumb', () => {
  it('describes a shape from its real fill and radius', () => {
    const thumb = layerThumb(
      createShapeLayer({ fill: '#ff0000', shape: 'rect', cornerRadius: 12 }),
    );
    expect(thumb).toMatchObject({ kind: 'shape', fill: '#ff0000', ellipse: false });
  });

  it('marks an ellipse so the swatch is round', () => {
    expect(layerThumb(createShapeLayer({ shape: 'ellipse' }))).toMatchObject({ ellipse: true });
  });

  it('carries a text layer’s own font and color', () => {
    const thumb = layerThumb(
      createTextLayer({ text: 'Jane Doe', style: { fontFamily: 'Georgia', fontSize: 40, fill: '#00ff00' } }),
    );
    expect(thumb).toMatchObject({ kind: 'text', sample: 'Jan', fontFamily: 'Georgia', color: '#00ff00' });
  });

  it('falls back to a glyph for an image with no source yet', () => {
    // A broken-image icon reads as a bug in the editor rather than as an
    // unfilled layer.
    const layer: Layer = { id: 'i', type: 'image', src: '', size: { width: 1, height: 1 } };
    expect(layerThumb(layer)).toMatchObject({ kind: 'glyph' });
  });

  it('summarizes a table by its columns and row count', () => {
    const thumb = layerThumb(createTableLayer());
    expect(thumb).toMatchObject({ kind: 'table', rows: 3 });
    expect((thumb as { columns: string[] }).columns).toEqual(['Team', 'W', 'L']);
  });

  it('stacks a sample of a group’s children', () => {
    const layer: Layer = {
      id: 'g',
      type: 'group',
      children: [createShapeLayer(), createTextLayer(), createShapeLayer(), createShapeLayer()],
    };
    const thumb = layerThumb(layer);
    expect(thumb).toMatchObject({ kind: 'stack', count: 4 });
    // Three reads as a stack; six is noise at 22px.
    expect((thumb as { children: unknown[] }).children).toHaveLength(3);
  });

  it('is defined for every layer type the factory can make', () => {
    // A missing case throws, and it would throw inside the layers panel — the
    // one component that must never fail to render.
    for (const type of ['shape', 'text', 'image', 'video', 'crawl', 'table', 'group', 'composition'] as const) {
      expect(() => layerThumb(makeLayer(type))).not.toThrow();
    }
  });
});

function makeLayer(type: Layer['type']): Layer {
  switch (type) {
    case 'shape': return createShapeLayer();
    case 'text': return createTextLayer();
    case 'table': return createTableLayer();
    case 'image': return { id: 'i', type: 'image', src: 'assets/a.png' };
    case 'video': return { id: 'v', type: 'video', src: 'assets/a.webm' };
    case 'crawl':
      return {
        id: 'c', type: 'crawl', speed: 100, direction: 'left', items: ['One'],
        style: { fontFamily: 'Inter', fontSize: 30 },
      };
    case 'group': return { id: 'g', type: 'group', children: [] };
    default: return { id: 'n', type: 'composition', ref: 'other' };
  }
}
