// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { TEXT_ANIM_PRESET_IDS } from '@breeze/schema';

import {
  TEXT_ANIM_PRESETS,
  resolveTextAnim,
  staggerToFit,
  textAnimDuration,
  textAnimPresetById,
} from '../textanim.js';

describe('the preset gallery', () => {
  it('covers every id the schema accepts', () => {
    // The schema validates ids against this list, so a preset the schema lets
    // through with no definition here would save cleanly and then animate
    // nothing on air.
    expect(TEXT_ANIM_PRESETS.map((p) => p.id)).toEqual([...TEXT_ANIM_PRESET_IDS]);
  });

  it('is the two axes it claims to be', () => {
    // chars/words/lines × rise/fade. A gallery that drifts from the grid stops
    // being predictable, which is the whole argument for having one.
    const grid = TEXT_ANIM_PRESETS.map((p) => `${p.unit}:${p.from.yPercent ? 'rise' : 'fade'}`);
    expect(new Set(grid).size).toBe(TEXT_ANIM_PRESETS.length);
    expect(new Set(TEXT_ANIM_PRESETS.map((p) => p.unit))).toEqual(
      new Set(['chars', 'words', 'lines']),
    );
  });

  it('gives every preset a usable default duration and a label', () => {
    for (const preset of TEXT_ANIM_PRESETS) {
      expect(preset.duration, preset.id).toBeGreaterThan(0);
      expect(preset.stagger, preset.id).toBeGreaterThanOrEqual(0);
      expect(preset.label.length, preset.id).toBeGreaterThan(0);
    }
  });

  it('staggers larger units more than smaller ones', () => {
    /*
     * Not decoration: a 0.02s stagger reads clearly across forty characters and
     * is invisible across four lines. Scaling the defaults per unit is what lets
     * an author swap presets on a strap with a fixed hold and get a comparable
     * total each time.
     */
    const by = (id: string) => textAnimPresetById(id)!;
    expect(by('lines-up').stagger).toBeGreaterThan(by('words-up').stagger);
    expect(by('words-up').stagger).toBeGreaterThan(by('chars-up').stagger);
  });

  it('rises from below its resting place, not from nowhere', () => {
    // Positive yPercent, and short of a full height: a full height only reads
    // well behind a per-piece mask, which Fit Width would then measure through.
    for (const preset of TEXT_ANIM_PRESETS.filter((p) => p.from.yPercent !== undefined)) {
      expect(preset.from.yPercent, preset.id).toBeGreaterThan(0);
      expect(preset.from.yPercent, preset.id).toBeLessThan(100);
    }
  });
});

describe('resolveTextAnim', () => {
  it('returns the preset defaults when nothing is overridden', () => {
    const resolved = resolveTextAnim({ id: 'chars-up' })!;
    const def = textAnimPresetById('chars-up')!;
    expect(resolved.stagger).toBe(def.stagger);
    expect(resolved.duration).toBe(def.duration);
    expect(resolved.ease).toBe(def.ease);
  });

  it('applies overrides', () => {
    const resolved = resolveTextAnim({
      id: 'words-fade', stagger: 0.2, duration: 1, ease: 'bounce.out',
    })!;
    expect(resolved.stagger).toBe(0.2);
    expect(resolved.duration).toBe(1);
    expect(resolved.ease).toBe('bounce.out');
  });

  it('keeps the preset defaults alongside the overrides', () => {
    // The editor needs both to show what a value is departing from.
    const resolved = resolveTextAnim({ id: 'lines-up', stagger: 0.5 })!;
    expect(resolved.stagger).toBe(0.5);
    expect(resolved.defaults.stagger).toBe(textAnimPresetById('lines-up')!.stagger);
  });

  it('honours a zero stagger rather than treating it as absent', () => {
    // "All pieces together" is a legitimate look, and `0 || default` would
    // silently overrule it.
    expect(resolveTextAnim({ id: 'chars-up', stagger: 0 })!.stagger).toBe(0);
  });

  it('falls back on a duration that could not animate', () => {
    const def = textAnimPresetById('chars-up')!;
    expect(resolveTextAnim({ id: 'chars-up', duration: 0 })!.duration).toBe(def.duration);
    expect(resolveTextAnim({ id: 'chars-up', duration: -1 })!.duration).toBe(def.duration);
  });

  it('clamps a negative stagger instead of running the reveal backwards', () => {
    expect(resolveTextAnim({ id: 'chars-up', stagger: -0.5 })!.stagger).toBe(0);
  });

  it('is null for no preset', () => {
    expect(resolveTextAnim(undefined)).toBeNull();
    expect(resolveTextAnim(null)).toBeNull();
  });

  it('is null for an unknown id', () => {
    /*
     * The schema rejects these, but a document can reach the runtime from an
     * export, an older project file or a hand edit. Animating nothing is the
     * right outcome — the text still appears, just without the reveal — and it
     * must not throw, because that would take the whole graphic off air.
     */
    expect(resolveTextAnim({ id: 'chars-sideways' as never })).toBeNull();
  });
});

describe('textAnimDuration', () => {
  const anim = resolveTextAnim({ id: 'chars-up', stagger: 0.05, duration: 0.4 })!;

  it('is one piece worth of duration when there is one piece', () => {
    expect(textAnimDuration(anim, 1)).toBeCloseTo(0.4, 9);
  });

  it('adds the stagger for every piece after the first', () => {
    // The last piece starts at stagger × (count − 1) and then takes duration
    // itself — the arithmetic that surprises authors whose reveal overruns.
    expect(textAnimDuration(anim, 10)).toBeCloseTo(0.4 + 0.45, 9);
  });

  it('is zero for no pieces', () => {
    // Empty text: nothing to reveal, and no phantom duration on the timeline.
    expect(textAnimDuration(anim, 0)).toBe(0);
    expect(textAnimDuration(anim, -3)).toBe(0);
  });

  it('grows with the length of the name, which is the on-air risk', () => {
    const short = textAnimDuration(anim, 8);
    const long = textAnimDuration(anim, 40);
    expect(long).toBeGreaterThan(short);
    // A 40-character name at a 0.05s stagger overruns a 1.5s hold.
    expect(long).toBeGreaterThan(1.5);
  });
});

describe('staggerToFit', () => {
  const anim = resolveTextAnim({ id: 'chars-up', duration: 0.4 })!;

  it('spreads the pieces across the budget exactly', () => {
    const stagger = staggerToFit(anim, 11, 1.4);
    expect(stagger).toBeCloseTo(0.1, 9);
    expect(textAnimDuration({ ...anim, stagger }, 11)).toBeCloseTo(1.4, 9);
  });

  it('is zero when even an un-staggered reveal overruns', () => {
    // The honest answer: no stagger can rescue a duration that is already too
    // long, and pretending otherwise would just hide the overrun.
    expect(staggerToFit(anim, 20, 0.3)).toBe(0);
  });

  it('is zero for a single piece, which cannot stagger against anything', () => {
    expect(staggerToFit(anim, 1, 5)).toBe(0);
  });
});
