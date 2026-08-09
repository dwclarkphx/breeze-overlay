// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Ease resolution.
 *
 * We deliberately avoid GSAP's CustomEase plugin: GSAP accepts a plain
 * `(p: number) => number` function as an ease, and a self-contained cubic
 * bezier solver gives the editor's curve preview and the runtime playback
 * *identical* math. One source of truth, no plugin registration, no divergence
 * between preview and playout.
 */

import type { Ease } from '@breeze/schema';

export type EaseFn = (p: number) => number;

const NEWTON_ITERATIONS = 4;
const NEWTON_MIN_SLOPE = 0.001;
const SUBDIVISION_PRECISION = 1e-7;
const SUBDIVISION_MAX_ITERATIONS = 10;

const A = (a1: number, a2: number) => 1 - 3 * a2 + 3 * a1;
const B = (a1: number, a2: number) => 3 * a2 - 6 * a1;
const C = (a1: number) => 3 * a1;

const calcBezier = (t: number, a1: number, a2: number) =>
  ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t;

const getSlope = (t: number, a1: number, a2: number) =>
  3 * A(a1, a2) * t * t + 2 * B(a1, a2) * t + C(a1);

function binarySubdivide(x: number, lo: number, hi: number, x1: number, x2: number): number {
  let a = lo;
  let b = hi;
  let currentX: number;
  let currentT: number;
  let i = 0;
  do {
    currentT = a + (b - a) / 2;
    currentX = calcBezier(currentT, x1, x2) - x;
    if (currentX > 0) b = currentT;
    else a = currentT;
    i += 1;
  } while (Math.abs(currentX) > SUBDIVISION_PRECISION && i < SUBDIVISION_MAX_ITERATIONS);
  return currentT;
}

function newtonRaphson(x: number, guess: number, x1: number, x2: number): number {
  let t = guess;
  for (let i = 0; i < NEWTON_ITERATIONS; i++) {
    const slope = getSlope(t, x1, x2);
    if (slope === 0) return t;
    t -= (calcBezier(t, x1, x2) - x) / slope;
  }
  return t;
}

/**
 * CSS-compatible cubic-bezier easing. `x1`/`x2` are clamped to 0..1 as the
 * spec requires; `y1`/`y2` are free so overshoot/anticipation curves work.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
  const cx1 = Math.min(1, Math.max(0, x1));
  const cx2 = Math.min(1, Math.max(0, x2));

  if (cx1 === y1 && cx2 === y2) return (p) => p; // linear shortcut

  const sampleCount = 11;
  const sampleStep = 1 / (sampleCount - 1);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) samples[i] = calcBezier(i * sampleStep, cx1, cx2);

  const tForX = (x: number): number => {
    let interval = 0;
    for (let i = 1; i < sampleCount; i++) {
      if (samples[i]! <= x) interval = i;
    }
    const start = interval * sampleStep;
    const dist = (x - samples[interval]!) / (samples[Math.min(interval + 1, sampleCount - 1)]! - samples[interval]! || 1);
    const guess = start + dist * sampleStep;
    const slope = getSlope(guess, cx1, cx2);
    if (slope >= NEWTON_MIN_SLOPE) return newtonRaphson(x, guess, cx1, cx2);
    if (slope === 0) return guess;
    return binarySubdivide(x, start, start + sampleStep, cx1, cx2);
  };

  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    return calcBezier(tForX(p), y1, y2);
  };
}

/** Discrete step ease; `steps(1)` is a pure hold until the next keyframe. */
export function steppedEase(steps: number): EaseFn {
  const n = Math.max(1, Math.floor(steps));
  return (p) => {
    if (p >= 1) return 1;
    return Math.floor(p * n) / n;
  };
}

/**
 * Turn a schema `Ease` into something GSAP accepts.
 * Strings pass straight through to GSAP's ease registry ("power3.out", …);
 * structured eases become functions.
 */
export function resolveEase(ease: Ease | undefined): string | EaseFn {
  if (ease === undefined) return 'none';
  if (typeof ease === 'string') return ease;
  if (ease.type === 'cubicBezier') {
    const [x1, y1, x2, y2] = ease.points;
    return cubicBezier(x1, y1, x2, y2);
  }
  if (ease.type === 'stepped') return steppedEase(ease.steps);
  return 'none';
}

/**
 * Sample an ease to `n` points — used by the editor's curve preview and by
 * tests that assert preview and playback agree.
 */
export function sampleEase(ease: Ease | undefined, n = 32): number[] {
  const resolved = resolveEase(ease);
  const fn: EaseFn = typeof resolved === 'function' ? resolved : linearFallback(resolved);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(fn(i / (n - 1)));
  return out;
}

/** Named GSAP eases can't be evaluated without GSAP loaded; preview them linearly. */
function linearFallback(_name: string): EaseFn {
  return (p) => p;
}
