// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import type { Composition, Ease, Project } from '@breeze/schema';

import { cubicBezier, resolveEase, sampleEase, steppedEase } from '../ease.js';
import { buildPlan, evaluatePlan, nextHoldAfter } from '../plan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const examplePath = path.resolve(here, '../../../../examples/lower-third.json');
const project = JSON.parse(readFileSync(examplePath, 'utf8')) as Project;
const lowerThird = project.compositions[0] as Composition;

/** Named GSAP eases can't run outside a browser; treat them as linear here. */
const easeResolver = (ease: Ease) => {
  const resolved = resolveEase(ease);
  return typeof resolved === 'function' ? resolved : (p: number) => p;
};

describe('ease', () => {
  it('is the identity for a linear cubic bezier', () => {
    const fn = cubicBezier(0, 0, 1, 1);
    for (const p of [0, 0.25, 0.5, 0.75, 1]) expect(fn(p)).toBeCloseTo(p, 6);
  });

  it('matches the CSS ease-out reference curve', () => {
    // cubic-bezier(0, 0, 0.58, 1) — solving x(t)=0.5 gives t≈0.6261, and
    // y(t) = 3t² − 2t³ ≈ 0.6846. Verified against the closed-form solution
    // rather than an eyeballed number.
    const fn = cubicBezier(0, 0, 0.58, 1);
    expect(fn(0.5)).toBeCloseTo(0.6846, 3);
  });

  it('agrees with a brute-force parametric solve across the curve', () => {
    const [x1, y1, x2, y2] = [0.25, 0.1, 0.25, 1];
    const fn = cubicBezier(x1, y1, x2, y2);
    const bez = (t: number, a1: number, a2: number) =>
      3 * (1 - t) * (1 - t) * t * a1 + 3 * (1 - t) * t * t * a2 + t * t * t;

    for (let t = 0.05; t < 1; t += 0.05) {
      const x = bez(t, x1, x2);
      expect(fn(x)).toBeCloseTo(bez(t, y1, y2), 4);
    }
  });

  it('clamps to 0 and 1 at the endpoints', () => {
    const fn = cubicBezier(0.68, -0.55, 0.265, 1.55);
    expect(fn(0)).toBe(0);
    expect(fn(1)).toBe(1);
  });

  it('allows overshoot in the middle of a back ease', () => {
    const fn = cubicBezier(0.68, -0.55, 0.265, 1.55);
    expect(fn(0.15)).toBeLessThan(0); // anticipation dips below the start value
    expect(fn(0.85)).toBeGreaterThan(1); // and overshoots before settling
  });

  it('holds the value until the next step', () => {
    const fn = steppedEase(4);
    expect(fn(0)).toBe(0);
    expect(fn(0.24)).toBe(0);
    expect(fn(0.26)).toBe(0.25);
    expect(fn(1)).toBe(1);
  });

  it('samples monotonically for a standard ease-in-out', () => {
    const samples = sampleEase({ type: 'cubicBezier', points: [0.42, 0, 0.58, 1] }, 16);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
  });
});

describe('plan', () => {
  const plan = buildPlan(lowerThird);

  it('uses the authored duration', () => {
    expect(plan.duration).toBe(2.4);
  });

  it('collects stop markers as holds', () => {
    expect(plan.holds).toEqual([1.5]);
  });

  it('lists layers in render order', () => {
    // No resolver here, so the nested badge stays a single unexpanded layer.
    expect(plan.order).toEqual(['bar', 'accent', 'name', 'badge', 'title']);
  });

  it('reports the unresolvable nested composition instead of failing', () => {
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]!.layerId).toBe('badge');
    expect(plan.warnings[0]!.message).toMatch(/unresolved/);
  });

  it('skips zero-length and no-op segments', () => {
    const barTweens = plan.tweens.filter((t) => t.layerId === 'bar' && t.prop === 'x');
    // 4 keyframes → 3 segments, but the flat 0.6→1.5 hold produces no tween.
    expect(barTweens).toHaveLength(2);
    expect(barTweens.map((t) => t.start)).toEqual([0, 1.5]);
  });

  it('emits a baseline set at t=0 for every keyframed property', () => {
    const barSet = plan.sets.find((s) => s.layerId === 'bar' && s.prop === 'x');
    expect(barSet).toEqual({ layerId: 'bar', prop: 'x', value: -960, at: 0 });
  });
});

describe('evaluatePlan', () => {
  const plan = buildPlan(lowerThird);
  const at = (t: number) => evaluatePlan(plan, t, easeResolver);

  it('starts the bar off-stage', () => {
    expect(at(0).get('bar')!.x).toBe(-960);
  });

  it('lands the bar at its resting position after the intro', () => {
    expect(at(0.6).get('bar')!.x).toBe(120);
  });

  it('keeps the bar parked through the hold', () => {
    expect(at(1.0).get('bar')!.x).toBe(120);
    expect(at(1.5).get('bar')!.x).toBe(120);
  });

  it('takes the bar back off-stage during the outro', () => {
    expect(at(2.1).get('bar')!.x).toBe(-960);
  });

  it('holds the name hidden until its reveal starts', () => {
    expect(at(0).get('name')!.opacity).toBe(0);
    expect(at(0.34).get('name')!.opacity).toBe(0);
  });

  it('has the name fully visible at the hold', () => {
    expect(at(1.5).get('name')!.opacity).toBe(1);
  });

  it('fades the name out before the bar leaves', () => {
    expect(at(1.85).get('name')!.opacity).toBe(0);
  });

  it('interpolates mid-segment rather than snapping', () => {
    const mid = at(0.3).get('bar')!.x!;
    expect(mid).toBeGreaterThan(-960);
    expect(mid).toBeLessThan(120);
  });
});

describe('hold lookup', () => {
  const plan = buildPlan(lowerThird);

  it('finds the upcoming stop marker', () => {
    expect(nextHoldAfter(plan, 0)).toBe(1.5);
  });

  it('returns null once every marker is behind the playhead', () => {
    expect(nextHoldAfter(plan, 1.5)).toBeNull();
    expect(nextHoldAfter(plan, 2.0)).toBeNull();
  });
});
