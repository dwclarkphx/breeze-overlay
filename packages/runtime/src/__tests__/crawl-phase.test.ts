// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * A ticker's phase (0.75.0) — its copy and how far into a pass it is — so a
 * page joining late scrolls in step with the output it joined, showing the copy
 * that output shows rather than whatever the feed says now.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { CrawlLoop, type CrawlAnimator } from '../crawl.js';

let clock = 0;

function build(items: string[], onCopy?: () => void) {
  const viewport = document.createElement('div');
  const track = document.createElement('div');
  viewport.appendChild(track);
  document.body.appendChild(viewport);

  let onComplete: (() => void) | null = null;
  const sets: Array<Record<string, unknown>> = [];
  const animator: CrawlAnimator = {
    set: (_t, vars) => { sets.push(vars); },
    to: (_t, vars) => {
      onComplete = vars['onComplete'] as () => void;
      return { kill: () => {} };
    },
  };
  const loop = new CrawlLoop({
    viewport,
    track,
    speed: 100, // px per second
    direction: 'left',
    separator: ' • ',
    animator,
    // 10px a character; the viewport is 100px so a block never needs repeating.
    measure: (el) => (el === viewport ? 100 : (el.textContent ?? '').length * 10),
    now: () => clock,
    ...(onCopy ? { onCopy } : {}),
  });
  loop.setItems(items);
  return { loop, track, sets, completePass: () => onComplete?.() };
}

beforeEach(() => {
  document.body.innerHTML = '';
  clock = 1_000_000;
});

describe('phase', () => {
  it('is null until the crawl rotates', () => {
    const { loop } = build(['Flood Watch']);
    expect(loop.phase).toBeNull();
  });

  it('reports the copy and how far into the pass it is', () => {
    const { loop } = build(['Flood Watch']); // "Flood Watch • " = 14 chars = 140px = 1.4 s a pass
    loop.start();
    clock += 500;
    expect(loop.phase).toEqual({ text: 'Flood Watch • ', staged: null, offsetMs: 500, passMs: 1400 });
  });

  it('starts the next pass when the last was due to end, not when its callback ran', () => {
    const { loop, completePass } = build(['Flood Watch']);
    loop.start();
    clock += 1_400 + 30; // the completion frame arrived 30 ms late
    completePass();
    expect(loop.phase!.offsetMs).toBe(30);
  });
});

describe('startAt', () => {
  it('takes up another output’s position, aged', () => {
    const { loop, sets } = build(['Flood Watch']);
    loop.startAt({ text: 'Flood Watch • ', staged: null, offsetMs: 300, passMs: 1400 }, 200);
    expect(loop.phase!.offsetMs).toBe(500);
    // 0.5 s at 100 px/s: placed 50px into the pass.
    expect(sets.at(-1)).toEqual({ x: -50 });
  });

  it('skips whole passes a stale report has run past', () => {
    const { loop } = build(['Flood Watch']);
    loop.startAt({ text: 'Flood Watch • ', staged: null, offsetMs: 300, passMs: 1400 }, 2_900);
    expect(loop.phase!.offsetMs).toBe(400); // 3.2 s is two passes and 0.4 s
  });

  it('shows the copy the other output shows, not the newer copy this page holds', () => {
    const { loop, completePass } = build(['Flood Watch', 'Heat Warning']);
    // The other output is still rotating the old copy.
    loop.startAt({ text: 'Flood Watch • ', staged: null, offsetMs: 0, passMs: 1400 });
    expect(loop.currentText).toBe('Flood Watch • ');
    // The newer copy is queued, and scrolls in on the next pass as it will there.
    expect(loop.pendingItems).toBe(true);
    completePass();
    expect(loop.stagedText).toBe('Flood Watch • Heat Warning • ');
  });

  it('carries copy that is part-way in', () => {
    const { loop } = build(['Flood Watch']);
    loop.startAt({ text: 'Flood Watch • ', staged: 'Heat Warning • ', offsetMs: 100, passMs: 1400 });
    expect(loop.phase).toMatchObject({ text: 'Flood Watch • ', staged: 'Heat Warning • ' });
  });
});

describe('onCopy', () => {
  it('fires when new copy begins scrolling in and again when it has arrived', () => {
    let calls = 0;
    const { loop, completePass } = build(['Flood Watch'], () => { calls += 1; });
    loop.start();
    expect(calls).toBe(0);
    loop.setItems(['Heat Warning']);
    completePass(); // staged into the incoming block
    expect(calls).toBe(1);
    completePass(); // adopted
    expect(calls).toBe(2);
    completePass(); // nothing new
    expect(calls).toBe(2);
  });
});
