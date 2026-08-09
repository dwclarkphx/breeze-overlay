// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Crawl loop. The behavior that matters is that new headlines never repaint
 * what is currently on screen — they scroll in. An operator typing into the
 * control panel mid-show must not be visible to the audience, either as a jump
 * (the scroll position moving) or as a rewrite (characters changing in place).
 *
 * The animator is injected so a pass can be completed on demand rather than by
 * waiting on a real tween.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { CrawlLoop, crawlBlockText, repeatsToFill, type CrawlAnimator } from '../crawl.js';

/** Records tweens and lets a test finish a pass deliberately. */
function fakeAnimator() {
  const sets: Array<Record<string, unknown>> = [];
  let onComplete: (() => void) | null = null;
  let destination = 0;
  let killed = 0;

  const animator: CrawlAnimator = {
    set: (_t, vars) => { sets.push(vars); },
    to: (_t, vars) => {
      onComplete = vars['onComplete'] as () => void;
      destination = vars['x'] as number;
      return { kill: () => { killed += 1; } };
    },
  };

  return {
    animator,
    sets,
    killed: () => killed,
    destination: () => destination,
    completePass: () => onComplete?.(),
    hasTween: () => onComplete !== null,
  };
}

function build(items: string[], direction: 'left' | 'right' = 'left') {
  const viewport = document.createElement('div');
  const track = document.createElement('div');
  viewport.appendChild(track);
  document.body.appendChild(viewport);

  const fake = fakeAnimator();
  const loop = new CrawlLoop({
    viewport,
    track,
    speed: 120,
    direction,
    separator: ' • ',
    animator: fake.animator,
    // Stand-in for layout: the viewport is 800px and text is 10px per
    // character. happy-dom has no layout engine and reports every width as 0,
    // which would make the loop correctly decline to animate.
    measure: (el) => (el === viewport ? 800 : (el.textContent ?? '').length * 10),
  });
  loop.setItems(items);
  return { loop, track, ...fake };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('crawlBlockText', () => {
  it('joins items and leaves a trailing separator so the block tiles', () => {
    expect(crawlBlockText(['One', 'Two'], ' • ')).toBe('One • Two • ');
  });

  it('drops blank lines, which an operator produces constantly', () => {
    expect(crawlBlockText(['One', '  ', '', 'Two'], ' • ')).toBe('One • Two • ');
  });

  it('returns nothing for an empty list rather than a lone separator', () => {
    expect(crawlBlockText([], ' • ')).toBe('');
    expect(crawlBlockText(['  '], ' • ')).toBe('');
  });
});

describe('repeatsToFill', () => {
  it('repeats a short block until it spans the viewport', () => {
    // A single headline otherwise loops in a blink.
    expect(repeatsToFill(100, 1000)).toBe(10);
    expect(repeatsToFill(300, 1000)).toBe(4);
  });

  it('never repeats less than once', () => {
    expect(repeatsToFill(2000, 1000)).toBe(1);
    expect(repeatsToFill(0, 1000)).toBe(1);
    expect(repeatsToFill(100, 0)).toBe(1);
  });
});

describe('updating headlines', () => {
  it('does not change the visible copy immediately', () => {
    const { loop } = build(['First run']);
    loop.start();

    loop.setItems(['Replacement']);

    // Still rotating the old copy — this is the jump being avoided.
    expect(loop.currentText).toBe('First run • ');
    expect(loop.pendingItems).toBe(true);
  });

  it('stages new copy into the incoming block, then adopts it a pass later', () => {
    const { loop, completePass } = build(['First run']);
    loop.start();
    loop.setItems(['Replacement']);

    // First seam: the new copy is written into the block that is about to
    // scroll in. It is on its way in, but not yet what is rotating.
    completePass();
    expect(loop.stagedText).toBe('Replacement • ');
    expect(loop.currentText).toBe('First run • ');

    // Second seam: it has scrolled in, so the other block can adopt it too.
    completePass();
    expect(loop.currentText).toBe('Replacement • ');
    expect(loop.stagedText).toBeNull();
    expect(loop.pendingItems).toBe(false);
  });

  it('keeps rotating when nothing new has arrived', () => {
    const { loop, completePass } = build(['Steady']);
    loop.start();

    completePass();
    completePass();

    expect(loop.currentText).toBe('Steady • ');
  });

  it('keeps only the latest of several rapid edits', () => {
    // An operator types, corrects, types again before a pass finishes.
    const { loop, completePass } = build(['First']);
    loop.start();

    loop.setItems(['Second']);
    loop.setItems(['Third']);
    loop.setItems(['Fourth']);
    completePass();
    completePass();

    expect(loop.currentText).toBe('Fourth • ');
  });

  it('ignores an update identical to what is already showing', () => {
    const { loop } = build(['Same']);
    loop.start();
    loop.setItems(['Same']);
    expect(loop.pendingItems).toBe(false);
  });

  it('ignores a resend of copy that is already on its way in', () => {
    // The panel re-sending the same payload must not cost another rotation.
    const { loop, completePass } = build(['First']);
    loop.start();
    loop.setItems(['Second']);
    completePass();

    loop.setItems(['Second']);

    expect(loop.stagedText).toBe('Second • ');
    completePass();
    expect(loop.currentText).toBe('Second • ');
    expect(loop.pendingItems).toBe(false);
  });

  it('lets an operator revert to the copy that is still rotating', () => {
    const { loop, completePass } = build(['First']);
    loop.start();
    loop.setItems(['Second']);
    completePass();

    // Changed their mind while 'Second' was scrolling in.
    loop.setItems(['First']);
    completePass();
    completePass();

    expect(loop.currentText).toBe('First • ');
    expect(loop.pendingItems).toBe(false);
  });

  it('applies the first content immediately, since there is nothing on screen', () => {
    const { loop } = build([]);
    expect(loop.currentText).toBe('');

    loop.setItems(['Opening headline']);

    expect(loop.currentText).toBe('Opening headline • ');
    expect(loop.pendingItems).toBe(false);
  });
});

/**
 * The regression that prompted the two-phase swap.
 *
 * Writing to a block while it is on screen repaints live pixels. It was easy to
 * miss because the two blocks share a prefix when a line is *appended*, so only
 * the region from the old repeat boundary onward changes — a handful of
 * characters mutating mid-line, which reads as a rendering glitch rather than a
 * swap. So this asserts the invariant directly rather than the symptom.
 */
describe('never repaints what is on screen', () => {
  function probe(direction: 'left' | 'right') {
    const viewport = document.createElement('div');
    const track = document.createElement('div');
    viewport.appendChild(track);
    document.body.appendChild(viewport);

    const violations: string[] = [];
    let onComplete: (() => void) | null = null;
    let destination = 0;
    let watching = false;
    // x=0 shows the head of the first block; anything else shows the head of
    // the second. True for both directions — only the travel differs.
    let x = 0;

    const animator: CrawlAnimator = {
      set: (_t, vars) => { x = vars['x'] as number; },
      to: (_t, vars) => {
        onComplete = vars['onComplete'] as () => void;
        destination = vars['x'] as number;
        return { kill: () => {} };
      },
    };

    const loop = new CrawlLoop({
      viewport,
      track,
      speed: 120,
      direction,
      separator: ' | ',
      animator,
      measure: (el) => (el === viewport ? 800 : (el.textContent ?? '').length * 10),
    });

    // happy-dom defines textContent somewhere up the prototype chain; find the
    // real accessor rather than assuming which prototype owns it.
    let proto: object | null = Object.getPrototypeOf(track);
    let descriptor: PropertyDescriptor | undefined;
    while (proto && !descriptor) {
      const d = Object.getOwnPropertyDescriptor(proto, 'textContent');
      if (d?.get && d?.set) descriptor = d;
      proto = Object.getPrototypeOf(proto);
    }
    if (!descriptor) throw new Error('no textContent accessor to instrument');

    const blocks = [...track.children] as HTMLElement[];
    const names = ['first', 'second'];
    blocks.forEach((el, i) => {
      Object.defineProperty(el, 'textContent', {
        get() { return descriptor.get!.call(this); },
        set(value: string) {
          const onScreen = x === 0 ? 'first' : 'second';
          if (watching && onScreen === names[i]) {
            violations.push(`wrote to the ${names[i]} block while it was on screen at x=${x}`);
          }
          descriptor.set!.call(this, value);
        },
        configurable: true,
      });
    });

    return {
      loop,
      violations,
      watch: () => { watching = true; },
      completePass: () => { x = destination; onComplete?.(); },
    };
  }

  for (const direction of ['left', 'right'] as const) {
    it(`${direction}: an appended line never rewrites live pixels`, () => {
      const p = probe(direction);
      p.loop.setItems(['AAA', 'BBB']);
      p.loop.start();

      // Only the initial render is allowed to write to a visible block; there
      // is nothing on air yet at that point.
      p.watch();
      p.loop.setItems(['AAA', 'BBB', 'CCC']);

      p.completePass();
      p.completePass();
      p.completePass();

      expect(p.violations).toEqual([]);
      expect(p.loop.currentText).toBe('AAA | BBB | CCC | ');
    });

    it(`${direction}: a wholesale replacement never rewrites live pixels either`, () => {
      // No shared prefix, so a repaint here would be unmissable on air.
      const p = probe(direction);
      p.loop.setItems(['AAA', 'BBB']);
      p.loop.start();
      p.watch();

      p.loop.setItems(['ZZZ']);
      p.completePass();
      p.completePass();
      p.completePass();

      expect(p.violations).toEqual([]);
      expect(p.loop.currentText).toBe('ZZZ | ');
    });
  }
});

describe('lifecycle', () => {
  it('does not animate until started', () => {
    const { hasTween } = build(['Headline']);
    expect(hasTween()).toBe(false);
  });

  it('kills its tween on stop', () => {
    const { loop, killed } = build(['Headline']);
    loop.start();
    loop.stop();
    expect(killed()).toBeGreaterThan(0);
  });

  it('does not begin another pass after being stopped', () => {
    const { loop, completePass } = build(['Headline']);
    loop.start();
    loop.stop();

    loop.setItems(['Next']);
    completePass();

    // Nothing restarts, so there is no pass to stage the new copy into and the
    // ticker is still holding the copy it stopped on.
    expect(loop.currentText).toBe('Headline • ');
    expect(loop.pendingItems).toBe(true);
  });

  it('picks the pending copy up when started again', () => {
    const { loop, completePass } = build(['Headline']);
    loop.start();
    loop.stop();
    loop.setItems(['Next']);

    loop.start();
    completePass();

    expect(loop.currentText).toBe('Next • ');
  });

  it('starting twice does not stack tweens', () => {
    const { loop, killed } = build(['Headline']);
    loop.start();
    const before = killed();
    loop.start();
    expect(killed()).toBe(before);
  });

  it('removes its blocks on destroy', () => {
    const { loop, track } = build(['Headline']);
    loop.start();
    loop.destroy();
    expect(track.querySelectorAll('.bz-crawl-block')).toHaveLength(0);
  });
});

describe('direction', () => {
  it('starts a leftward crawl at zero offset', () => {
    const { loop, sets } = build(['Headline'], 'left');
    loop.start();
    expect(sets.at(-1)).toMatchObject({ x: 0 });
  });

  it('starts a rightward crawl offset so content enters from the left', () => {
    const { loop, sets } = build(['Headline'], 'right');
    loop.start();
    expect(sets.at(-1)).toHaveProperty('x');
  });

  it('re-anchors a rightward crawl when the incoming block changes width', () => {
    // The block that scrolls in is also the one whose width sets the offset, so
    // staging new copy has to move the track with it or the seam tears.
    const { loop, sets, completePass } = build(['Headline'], 'right');
    loop.start();
    loop.setItems(['A much longer headline than before']);

    const before = sets.length;
    completePass();

    // Two positions set during the staging pass: anchor, then re-anchor.
    expect(sets.length - before).toBe(2);
    expect(sets.at(-1)).not.toEqual(sets.at(-2));
  });
});

describe('remeasure', () => {
  /*
   * Fonts land after first paint, and a block padded against fallback metrics is
   * repeated the wrong number of times. The runtime used to handle that by
   * destroying every loop and clearing its map, on the assumption that "nothing
   * has scrolled yet — the graphic has not been played". That was wrong twice,
   * and both were on air: the editor never plays on its own, so its ticker
   * preview was left permanently empty; and with autoplay, or an operator hitting
   * PLAY on a cold browser source, it ran on a rotating crawl and the ticker
   * vanished mid-show. These pin the replacement.
   */
  it('keeps the blocks in the track', () => {
    const { loop, track } = build(['Headline']);
    loop.remeasure();
    expect(track.children.length).toBe(2);
    expect(track.textContent?.length).toBeGreaterThan(0);
  });

  it('re-pads a stopped loop against the new metrics', () => {
    const { loop, track } = build(['Headline']);
    // Shrink the blocks by hand, as fallback metrics would have.
    for (const block of [...track.children] as HTMLElement[]) block.textContent = 'x';

    loop.remeasure();

    for (const block of [...track.children] as HTMLElement[]) {
      expect(block.textContent).toContain('Headline');
    }
  });

  it('leaves a running crawl alone rather than rewriting it mid-pass', () => {
    /*
     * A rotating crawl re-measures at its next seam by itself — `startPass` reads
     * the block width every pass — and the seam is the only place the copy can
     * change without showing. Rewriting the blocks mid-pass is the visible jump
     * 0.29 fixed.
     */
    const { loop, track, killed, hasTween } = build(['Headline']);
    loop.start();
    const before = [...track.children].map((el) => el.textContent);
    const killsBefore = killed();

    loop.remeasure();

    expect([...track.children].map((el) => el.textContent)).toEqual(before);
    expect(killed()).toBe(killsBefore);
    expect(hasTween()).toBe(true);
  });

  it('reports whether it is running', () => {
    const { loop } = build(['Headline']);
    expect(loop.isRunning).toBe(false);
    loop.start();
    expect(loop.isRunning).toBe(true);
    loop.stop();
    expect(loop.isRunning).toBe(false);
  });
});
