// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Sprite-layer schema and semantics.
 *
 * The two rules worth having are the ones JSON Schema cannot state: a
 * `frameCount` above the grid, and a binding on a multi-frame sheet. Both
 * describe a relation between sibling fields, and both fail invisibly at
 * playout if they are allowed through.
 */

import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION, type Composition, type SpriteLayer } from '../types.js';

import { assetReferences, rewriteAssetReferences } from '../assets.js';
import { collectBindings } from '../bindings.js';
import { createLayer } from '../factory.js';
import { validateComposition, validateCompositionSemantics } from '../validate.js';

function sprite(over: Partial<SpriteLayer> = {}): SpriteLayer {
  return { id: 'spr1', type: 'sprite', src: 'assets/burst.png', cols: 6, rows: 5, fps: 30, ...over } as SpriteLayer;
}

/*
 * A complete document, not a minimal one.
 *
 * The first draft of this fixture omitted `formatVersion` and
 * `stage.background`, which made every "refuses X" case below pass on those two
 * errors instead of the sprite rule they name — a suite that cannot fail. The
 * positive cases are what caught it, which is the argument for asserting both
 * directions of a validator rather than only the rejections.
 */
function comp(layers: SpriteLayer[]): Composition {
  return {
    formatVersion: FORMAT_VERSION,
    id: 'c1',
    name: 'C',
    stage: { width: 1920, height: 1080, fps: 30, background: 'transparent' },
    duration: 5,
    layers,
  } as Composition;
}

describe('sprite schema', () => {
  it('accepts a well-formed sheet', () => {
    expect(validateComposition(comp([sprite()])).valid).toBe(true);
  });

  it('refuses a zero-column grid', () => {
    // A division by zero in the frame solver, which reaches air as a blank box.
    expect(validateComposition(comp([sprite({ cols: 0 })])).valid).toBe(false);
  });

  it('refuses a zero or negative fps', () => {
    expect(validateComposition(comp([sprite({ fps: 0 })])).valid).toBe(false);
  });

  it('refuses unknown properties', () => {
    expect(
      validateComposition(comp([sprite({ atlas: 'sheet.json' } as unknown as Partial<SpriteLayer>)])).valid,
    ).toBe(false);
  });

  it('creates a valid layer from the factory', () => {
    const made = createLayer('sprite');
    expect(made.type).toBe('sprite');
    expect(validateComposition(comp([made as SpriteLayer])).valid).toBe(true);
  });
});

describe('sprite semantics', () => {
  it('names a frameCount that overruns the grid', () => {
    const issues = validateCompositionSemantics(comp([sprite({ cols: 4, rows: 2, frameCount: 12 })]));
    // Named rather than clamped: the number is nearly always a typo or a sheet
    // re-exported at a different grid, and both are worth saying out loud while
    // the operator still has the export open.
    expect(issues.some((i) => i.message.includes('exceeds'))).toBe(true);
  });

  it('accepts a frameCount that leaves the last row padded', () => {
    expect(validateCompositionSemantics(comp([sprite({ cols: 6, rows: 6, frameCount: 30 })]))).toEqual([]);
  });

  it('refuses a binding on a multi-frame sheet', () => {
    const issues = validateCompositionSemantics(comp([sprite({ binding: 'logo' })]));
    expect(issues.some((i) => i.path.endsWith('/binding'))).toBe(true);
  });

  it('allows a binding on a 1×1 sheet, which is just an image', () => {
    expect(validateCompositionSemantics(comp([sprite({ cols: 1, rows: 1, binding: 'logo' })]))).toEqual([]);
  });

  it('binds as an image kind so the panel offers an image picker', () => {
    const bindings = collectBindings(comp([sprite({ cols: 1, rows: 1, binding: 'logo' })]));
    expect(bindings[0]?.kind).toBe('image');
  });
});

describe('sprite asset references', () => {
  it('is found by the usage walk', () => {
    // Delete confirmation, orphan detection and Replace are all unbuildable
    // without this — a sheet the walk cannot see is one an operator deletes out
    // from under a graphic.
    const refs = assetReferences([sprite()]);
    expect(refs.map((r) => r.src)).toEqual(['assets/burst.png']);
  });

  it('is repointed by the rewrite walk', () => {
    // The paired half. A reference the reader finds and the rewriter misses is
    // a graphic that reports itself up to date and goes to air stale.
    const { layers, count } = rewriteAssetReferences([sprite()], 'assets/burst.png', 'assets/burst-v2.png');
    expect(count).toBe(1);
    expect((layers[0] as SpriteLayer).src).toBe('assets/burst-v2.png');
  });

  it('keeps the grid when the sheet is repointed', () => {
    const { layers } = rewriteAssetReferences([sprite()], 'assets/burst.png', 'assets/burst-v2.png');
    expect((layers[0] as SpriteLayer).cols).toBe(6);
    expect((layers[0] as SpriteLayer).rows).toBe(5);
  });
});
