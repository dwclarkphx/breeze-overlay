// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Text reveal presets — the pure half. No DOM, no GSAP.
 *
 * A preset is a split unit plus the state each piece animates *from*, and the
 * gallery is that pair over two axes: chars/words/lines × slide-up/fade. Two
 * axes rather than a pile of one-off effects, so an author can predict what
 * `lines-fade` does from having seen `chars-fade`, and so every timing control
 * is exercised against every split mode.
 *
 * The table and the timing arithmetic live here because they have exact answers
 * and are worth testing without a browser. Splitting and tweening — the parts
 * that need real text measurement — are in `runtime.ts`.
 */

import { TEXT_ANIM_PRESET_IDS, type Ease, type TextAnimPreset, type TextAnimPresetId } from '@breeze/schema';

export type SplitUnit = 'chars' | 'words' | 'lines';

/** The transform/opacity state a piece starts from. GSAP `from` vars. */
export interface PieceFrom {
  /** Percentage of the piece's own height. Positive starts below its resting place. */
  yPercent?: number;
  opacity?: number;
}

export interface TextAnimPresetDef {
  id: TextAnimPresetId;
  /** Shown in the editor gallery. */
  label: string;
  unit: SplitUnit;
  from: PieceFrom;
  /** Defaults, all overridable per layer. */
  stagger: number;
  duration: number;
  ease: Ease;
}

/**
 * Slide distance for the "up" family, as a percentage of the piece's height.
 *
 * Deliberately short of 100%. A full height means the piece starts exactly
 * outside its own box, which only reads well behind a mask — and masking every
 * piece adds a wrapper element per char that Fit Width would then have to
 * measure through. At 60% with a fade the movement reads as a rise rather than
 * as something sliding in from nowhere, with no extra markup.
 */
const RISE_PERCENT = 60;

/**
 * Larger units get more time and more space between them.
 *
 * A 0.02s stagger across forty characters is a 0.8s reveal; the same stagger
 * across four lines is imperceptible. The defaults are scaled per unit so every
 * preset lands in roughly the same total, which is what makes them
 * interchangeable on a strap with a fixed hold.
 */
const PRESETS: Record<TextAnimPresetId, TextAnimPresetDef> = {
  'chars-up': {
    id: 'chars-up', label: 'Characters rise', unit: 'chars',
    from: { yPercent: RISE_PERCENT, opacity: 0 },
    stagger: 0.02, duration: 0.45, ease: 'power3.out',
  },
  'chars-fade': {
    id: 'chars-fade', label: 'Characters fade', unit: 'chars',
    from: { opacity: 0 },
    stagger: 0.015, duration: 0.4, ease: 'power1.out',
  },
  'words-up': {
    id: 'words-up', label: 'Words rise', unit: 'words',
    from: { yPercent: RISE_PERCENT, opacity: 0 },
    stagger: 0.06, duration: 0.5, ease: 'power3.out',
  },
  'words-fade': {
    id: 'words-fade', label: 'Words fade', unit: 'words',
    from: { opacity: 0 },
    stagger: 0.05, duration: 0.45, ease: 'power1.out',
  },
  'lines-up': {
    id: 'lines-up', label: 'Lines rise', unit: 'lines',
    from: { yPercent: RISE_PERCENT, opacity: 0 },
    stagger: 0.12, duration: 0.55, ease: 'power3.out',
  },
  'lines-fade': {
    id: 'lines-fade', label: 'Lines fade', unit: 'lines',
    from: { opacity: 0 },
    stagger: 0.1, duration: 0.5, ease: 'power1.out',
  },
};

/** The gallery, in display order. */
export const TEXT_ANIM_PRESETS: readonly TextAnimPresetDef[] =
  TEXT_ANIM_PRESET_IDS.map((id) => PRESETS[id]);

export function textAnimPresetById(id: string): TextAnimPresetDef | undefined {
  return (PRESETS as Record<string, TextAnimPresetDef | undefined>)[id];
}

/** A preset with the layer's overrides folded in and the timings made safe. */
export interface ResolvedTextAnim extends TextAnimPresetDef {
  /** The preset's own defaults, for an editor showing what it is overriding. */
  defaults: { stagger: number; duration: number; ease: Ease };
}

/**
 * Merge a layer's `textAnimPreset` onto its preset definition.
 *
 * Returns `null` for no preset and for an unknown id. Unknown ids are rejected
 * by the schema, but a document can reach the runtime from an export, an older
 * project file or a hand edit — and in that case animating nothing is the right
 * outcome: the text still appears, just without the reveal.
 *
 * A zero or negative duration is a document that would render the reveal
 * instantly (or, in GSAP, not at all), so it falls back to the preset's own.
 * Zero stagger is left alone: "all pieces together" is a legitimate look.
 */
export function resolveTextAnim(preset: TextAnimPreset | undefined | null): ResolvedTextAnim | null {
  if (!preset) return null;
  const def = textAnimPresetById(preset.id);
  if (!def) return null;

  const stagger = Number.isFinite(preset.stagger) ? Math.max(0, preset.stagger as number) : def.stagger;
  const duration =
    Number.isFinite(preset.duration) && (preset.duration as number) > 0
      ? (preset.duration as number)
      : def.duration;

  return {
    ...def,
    stagger,
    duration,
    ease: preset.ease ?? def.ease,
    defaults: { stagger: def.stagger, duration: def.duration, ease: def.ease },
  };
}

/**
 * Wall-clock length of the whole reveal.
 *
 * The last piece starts after `stagger × (count − 1)` and then takes `duration`
 * itself — the arithmetic authors get wrong when they wonder why a 0.05s stagger
 * on a forty-character name overruns a 1.5s hold. The editor uses this to show
 * the real cost of a preset before it goes to air.
 */
export function textAnimDuration(anim: ResolvedTextAnim, pieces: number): number {
  if (pieces <= 0) return 0;
  return anim.duration + anim.stagger * (pieces - 1);
}

/**
 * Longest stagger that keeps a reveal inside `budget` seconds.
 *
 * Returns 0 when even the un-staggered reveal is too long — the honest answer,
 * since no stagger can fix a duration that already overruns.
 */
export function staggerToFit(anim: ResolvedTextAnim, pieces: number, budget: number): number {
  if (pieces <= 1) return 0;
  const room = budget - anim.duration;
  if (room <= 0) return 0;
  return room / (pieces - 1);
}
