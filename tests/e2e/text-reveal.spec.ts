// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 5 acceptance: an animated name strap with one-click
 * presets, and a news ticker.
 *
 * The unit tests cover the preset table and the wiring in happy-dom. What only a
 * real browser can settle is the part that depends on layout: whether the pieces
 * are where the text is, whether `lines` splitting finds the lines a fallback
 * font would have got wrong, and whether the reveal composes with the layer's own
 * keyframes rather than fighting them.
 */

const REVEAL = '/play/demo/l3rd-reveal';

async function open(page: Page, url = `${REVEAL}?autoplay=0`) {
  await page.goto(url);
  await page.waitForFunction(() => Boolean((window as { breeze?: unknown }).breeze));
}

const seek = (page: Page, time: number) =>
  page.evaluate((t) => (window as any).breeze.runtime.seek(t), time);

/**
 * Every animated piece of a text layer, in document order.
 *
 * `inline` is the piece's own inline opacity — empty until a tween touches it —
 * reported separately from the computed value. The distinction is the whole
 * assertion for staggering: a piece the reveal has not reached yet computes to
 * opacity 1, exactly like a piece that has finished. Reading only the computed
 * value makes "not started" and "done" indistinguishable, which is how an earlier
 * version of this test managed to assert that a staggered reveal was not
 * staggered.
 */
const pieces = (page: Page, layerId: string) =>
  page.$$eval(
    `[data-layer-id="${layerId}"] .bz-text-inner div div, [data-layer-id="${layerId}"] .bz-text-inner > div`,
    (els) =>
      els
        .filter((el) => !el.querySelector('div'))
        .map((el) => ({
          text: el.textContent ?? '',
          opacity: Number(getComputedStyle(el).opacity),
          inline: (el as HTMLElement).style.opacity,
          started: (el as HTMLElement).style.opacity !== '',
        })),
  );

test.describe('the name strap reveals character by character', () => {
  test('splits the name into pieces', async ({ page }) => {
    await open(page);
    const parts = await pieces(page, 'name');
    // "JANE DOE" — seven characters, the space is not a piece.
    expect(parts.length).toBe(7);
    expect(parts.map((p) => p.text).join('')).toBe('JANEDOE');
  });

  test('staggers them: the first is under way before the last has begun', async ({ page }) => {
    await open(page);
    // The layer's in-point is 0.45; a little past it the reveal is under way.
    await seek(page, 0.55);

    const parts = await pieces(page, 'name');
    const first = parts[0]!;
    const last = parts[parts.length - 1]!;

    expect(first.started).toBe(true);
    expect(first.opacity).toBeGreaterThan(0);
    expect(first.opacity).toBeLessThan(1);
    // Untouched, not finished — the two are identical to `getComputedStyle`.
    expect(last.started).toBe(false);
  });

  test('ends with every character fully visible', async ({ page }) => {
    await open(page);
    await seek(page, 1.5);

    for (const part of await pieces(page, 'name')) {
      expect(part.opacity, part.text).toBeCloseTo(1, 2);
    }
  });

  test('composes with the layer keyframes instead of fighting them', async ({ page }) => {
    /*
     * The reveal animates the pieces inside the layer; the authored keyframes
     * animate the layer itself. Two owners of two different elements, which is
     * what lets a strap fade out as a whole while its characters stay put.
     */
    await open(page);
    await seek(page, 1.5);
    const held = await page.evaluate(
      () => Number(getComputedStyle(document.querySelector('[data-layer-id="name"]')!).opacity),
    );
    expect(held).toBeCloseTo(1, 2);

    await seek(page, 1.95);
    const gone = await page.evaluate(
      () => Number(getComputedStyle(document.querySelector('[data-layer-id="name"]')!).opacity),
    );
    expect(gone).toBeLessThan(0.1);

    // The characters themselves are still revealed — the layer took them out.
    for (const part of await pieces(page, 'name')) {
      expect(part.opacity, part.text).toBeCloseTo(1, 2);
    }
  });

  test('the pieces sit where the text sits', async ({ page }) => {
    // A split that reflows the text would move the strap's copy off its bar.
    await open(page);
    await seek(page, 1.5);

    const boxes = await page.evaluate(() => {
      const layer = document.querySelector('[data-layer-id="name"]')!.getBoundingClientRect();
      const first = document.querySelector('[data-layer-id="name"] .bz-text-inner div div')!
        .getBoundingClientRect();
      return { layer: { left: layer.left, right: layer.right }, first: { left: first.left } };
    });

    expect(boxes.first.left).toBeGreaterThanOrEqual(boxes.layer.left - 1);
    expect(boxes.first.left).toBeLessThan(boxes.layer.right);
  });
});

test.describe('the title reveals by words', () => {
  test('splits on words, not characters', async ({ page }) => {
    await open(page);
    const parts = await pieces(page, 'title');
    // "Senior Correspondent" — two words.
    expect(parts.length).toBe(2);
    expect(parts.map((p) => p.text.trim())).toEqual(['Senior', 'Correspondent']);
  });

  test('fades rather than rises', async ({ page }) => {
    await open(page);
    await seek(page, 0.75);
    const transform = await page.evaluate(
      () =>
        getComputedStyle(
          document.querySelector('[data-layer-id="title"] .bz-text-inner > div')!,
        ).transform,
    );
    // A fade preset writes opacity and leaves the position alone.
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(transform);
  });
});

test.describe('a reveal under live update', () => {
  test('keeps the new name and re-splits it', async ({ page }) => {
    /*
     * The on-air case, and the one with a trap in it: SplitText.revert() restores
     * the markup it recorded when it split, so reverting after writing would put
     * the old name back and discard what the operator just typed.
     */
    await open(page);
    await page.evaluate(() => (window as any).breeze.update({ name: 'ALEX MORGAN' }));

    const parts = await pieces(page, 'name');
    expect(parts.map((p) => p.text).join('')).toBe('ALEXMORGAN');
  });

  test('leaves a corrected name visible when it arrives during the hold', async ({ page }) => {
    // Nobody may retype a name on air and watch it vanish.
    await open(page);
    await seek(page, 1.5);
    await page.evaluate(() => (window as any).breeze.update({ name: 'CORRECTED' }));

    for (const part of await pieces(page, 'name')) {
      expect(part.opacity, part.text).toBeCloseTo(1, 2);
    }
  });

  test('a long name still fits its strap', async ({ page }) => {
    /*
     * Fit Width and the reveal act on the same text, and the order matters.
     *
     * 0.37 fitted the plain text and then split it. Splitting replaces the
     * shaped text with a row of per-character inline-blocks that measures wider,
     * because the kerning between the characters is gone — so this test failed at
     * 704.3px inside a 700px strap. Four pixels, and four pixels of copy hanging
     * off the end of the bar. The fit now runs over the split boxes, which are
     * what actually goes to air.
     *
     * The 1px tolerance is for `offsetWidth` rounding to whole pixels, and no
     * more than that: a looser bound here would let the overrun back in.
     */
    await open(page);
    await page.evaluate(() =>
      (window as any).breeze.update({ name: 'BARTHOLOMEW CUTHBERTSON-WEATHERSBY' }),
    );
    await seek(page, 1.5);

    const fits = await page.evaluate(() => {
      const inner = document.querySelector<HTMLElement>('[data-layer-id="name"] .bz-text-inner')!;
      const layer = document.querySelector<HTMLElement>('[data-layer-id="name"]')!;
      return {
        // Post-transform, so this is what the audience sees.
        width: inner.getBoundingClientRect().width,
        transform: inner.style.transform,
        // Fit Width stopped at its floor: a different failure, and one the author
        // is warned about rather than one the runtime can fix.
        flaggedOverflow: layer.dataset['fitOverflow'] === '1',
      };
    });

    expect(fits.transform).toContain('scaleX');
    expect(fits.flaggedOverflow).toBe(false);
    expect(fits.width).toBeLessThanOrEqual(700 + 1);
  });
});

test('the ticker still crawls, with its items bound', async ({ page }) => {
  // The other half of the Phase 5 acceptance criterion.
  await page.goto('/play/demo/ticker?autoplay=1');
  await page.waitForFunction(() => Boolean((window as { breeze?: unknown }).breeze));
  await page.waitForFunction(
    () => (window as any).breeze.runtime.playbackState === 'holding',
    undefined,
    { timeout: 8000 },
  );

  const crawl = await page.evaluate(async () => {
    const track = document.querySelector<HTMLElement>('[data-layer-id="ticker-text"] .bz-crawl-track');
    if (!track) return null;
    const at = () => getComputedStyle(track).transform;
    const before = at();
    await new Promise((r) => setTimeout(r, 350));
    return { before, after: at(), filled: track.textContent ?? '', blocks: track.children.length };
  });

  expect(crawl).not.toBeNull();
  // Filled at all: fonts.ready used to destroy the loop and remove both blocks,
  // which emptied the track mid-show and never rebuilt it.
  expect(crawl!.blocks).toBe(2);
  expect(crawl!.filled.length).toBeGreaterThan(0);
  /*
   * Moving. Compared as "not where it was" rather than "further left": a pass can
   * complete inside the sample window and reset the track to the seam, which is
   * a legitimate crawl doing its job and would read as traveling backwards.
   */
  expect(crawl!.after).not.toBe(crawl!.before);
});
