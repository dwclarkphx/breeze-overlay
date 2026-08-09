// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 1 acceptance (ROADMAP §4): a hand-written lower-third JSON plays
 * intro → holds → outro correctly in a plain browser page.
 *
 * Assertions read the composited transform matrix rather than any internal
 * runtime state, because that matrix is literally what vMix and OBS capture.
 */

const PLAY_URL = '/play/demo/l3rd-name?autoplay=0';

/** Horizontal translate of a layer, read out of its computed transform. */
async function translateX(page: Page, layerId: string): Promise<number> {
  return page.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`[data-layer-id="${id}"]`);
    if (!el) throw new Error(`layer ${id} not found`);
    const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return matrix.m41;
  }, layerId);
}

async function opacityOf(page: Page, layerId: string): Promise<number> {
  return page.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`[data-layer-id="${id}"]`);
    if (!el) throw new Error(`layer ${id} not found`);
    return Number(getComputedStyle(el).opacity);
  }, layerId);
}

async function runtimeState(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).breeze.runtime.playbackState as string);
}

test.beforeEach(async ({ page }) => {
  await page.goto(PLAY_URL);
  await page.waitForFunction(() => Boolean((window as any).breeze));
});

test.describe('nothing goes to air on load', () => {
  test('the graphic stays idle when the page is simply opened', async ({ page }) => {
    /*
     * Adding a Browser Source in OBS, or opening the URL to check it, must not
     * put a graphic on air. Triggering is the control panel's job.
     */
    await page.goto('/play/demo/l3rd-name');
    await page.waitForFunction(() => Boolean((window as any).breeze));

    // Longer than the intro, so an autoplay would certainly have shown itself.
    await page.waitForTimeout(900);

    expect(await runtimeState(page)).toBe('idle');
    expect(await opacityOf(page, 'name')).toBeCloseTo(0, 2);
  });

  test('the ticker bar sits off screen until played', async ({ page }) => {
    // Reported: the ticker bar was visible the moment the page opened.
    await page.goto('/play/demo/ticker');
    await page.waitForFunction(() => Boolean((window as any).breeze));
    await page.waitForTimeout(900);

    const y = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-layer-id="ticker-bg"]')!;
      return new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
    });

    // Authored off the bottom of a 1080 stage at t=0.
    expect(y).toBeCloseTo(1080, 0);
  });

  test('?autoplay=1 restores cue-on-load for simple workflows', async ({ page }) => {
    await page.goto('/play/demo/l3rd-name?autoplay=1');
    await page.waitForFunction(
      () => ['playing-in', 'holding'].includes((window as any).breeze.runtime.playbackState),
      undefined,
      { timeout: 8000 },
    );
  });
});

test.describe('the ticker plays where the window cannot show it', () => {
  /*
   * Reported as "the ticker does not show when play is pressed, though the
   * scaled debug view does". Neither the demo nor playback is at fault.
   *
   * The output page renders 1:1 because a browser source is a fixed canvas and
   * every pixel must land where the author put it. The ticker is authored at
   * y=1000 in a 1080-tall stage, and a desktop browser window is shorter than
   * 1080 once its tab and bookmark bars are counted — so the graphic holds on air
   * correctly, a hundred pixels below the bottom of the window, and reads as
   * "PLAY did nothing". The lower third at y=820–970 still shows, which is why
   * only the ticker looked broken.
   *
   * These pin the distinction so it is never mistaken for a bug again: it plays,
   * it is outside a short window, and it is inside a window the size of the stage.
   */
  const tickerY = (page: Page) =>
    page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-layer-id="ticker-bg"]')!;
      return new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
    });

  test('it holds on air at its authored position in a short window', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto('/play/demo/ticker?autoplay=1');
    await page.waitForFunction(
      () => (window as any).breeze.runtime.playbackState === 'holding',
      undefined,
      { timeout: 8000 },
    );

    // Played, held, and parked where it was authored — nothing is broken.
    expect(await tickerY(page)).toBeCloseTo(1000, 0);

    // And entirely below a 900px window, which is the whole of the complaint.
    const offscreen = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-layer-id="ticker-bg"]')!;
      return el.getBoundingClientRect().top - window.innerHeight;
    });
    expect(offscreen).toBeGreaterThan(0);
  });

  test('the page says so in the console rather than leaving it a mystery', async ({ page }) => {
    // Console only: this page goes to air, so nothing may draw or move.
    const warnings: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning') warnings.push(msg.text());
    });

    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto('/play/demo/ticker');
    await page.waitForFunction(() => Boolean((window as any).breeze));

    expect(warnings.join('\n')).toContain('outside the window');
  });

  test('a window the size of the stage shows it, and stays quiet', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning') warnings.push(msg.text());
    });

    // The browser-source case: a viewport matching the composition.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/play/demo/ticker?autoplay=1');
    await page.waitForFunction(
      () => (window as any).breeze.runtime.playbackState === 'holding',
      undefined,
      { timeout: 8000 },
    );

    const box = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-layer-id="ticker-bg"]')!;
      const r = el.getBoundingClientRect();
      return { bottom: r.bottom, viewport: window.innerHeight };
    });
    expect(box.bottom).toBeLessThanOrEqual(box.viewport + 1);
    expect(warnings.join('\n')).not.toContain('outside the window');
  });
});

test('page background is fully transparent for browser sources', async ({ page }) => {
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(bg);
});

test('exposes the control verb set on window', async ({ page }) => {
  const verbs = await page.evaluate(() =>
    ['play', 'stop', 'next', 'update'].map((v) => typeof (window as any)[v]),
  );
  expect(verbs).toEqual(['function', 'function', 'function', 'function']);
});

test('builds one DOM node per layer, in author order', async ({ page }) => {
  const ids = await page.$$eval('[data-layer-id]', (els) =>
    els.map((el) => el.getAttribute('data-layer-id')),
  );

  // Assert the top-level order only. Nested expansion is covered by its own
  // tests, and a hard-coded full list silently rots every time the demo
  // project gains a layer — which is exactly how this assertion went stale.
  const topLevel = ids.filter((id) => !id?.includes('/'));
  expect(topLevel).toEqual(['bar', 'accent', 'name', 'badge', 'title']);

  // Whatever the tree contains, every id must be unique or the runtime cannot
  // address layers.
  expect(new Set(ids).size).toBe(ids.length);
});

test('starts off-stage before play()', async ({ page }) => {
  expect(await translateX(page, 'bar')).toBeCloseTo(-960, 0);
  expect(await opacityOf(page, 'name')).toBeCloseTo(0, 2);
});

test('intro animates in and holds at the STOP marker', async ({ page }) => {
  await page.evaluate(() => (window as any).play());

  // The hold sits at 1.5s; give the ticker room and then confirm it parked.
  await page.waitForFunction(
    () => (window as any).breeze.runtime.playbackState === 'holding',
    undefined,
    { timeout: 5000 },
  );

  expect(await runtimeState(page)).toBe('holding');
  expect(await translateX(page, 'bar')).toBeCloseTo(120, 0);
  expect(await opacityOf(page, 'name')).toBeCloseTo(1, 2);

  const timeAtHold = await page.evaluate(() => (window as any).breeze.runtime.currentTime as number);
  expect(timeAtHold).toBeCloseTo(1.5, 1);
});

test('stays parked at the hold instead of running on', async ({ page }) => {
  await page.evaluate(() => (window as any).play());
  await page.waitForFunction(() => (window as any).breeze.runtime.playbackState === 'holding');

  const first = await page.evaluate(() => (window as any).breeze.runtime.currentTime as number);
  await page.waitForTimeout(1000);
  const second = await page.evaluate(() => (window as any).breeze.runtime.currentTime as number);

  expect(second).toBeCloseTo(first, 3);
  expect(await translateX(page, 'bar')).toBeCloseTo(120, 0);
});

test('stop() runs the outro and finishes', async ({ page }) => {
  await page.evaluate(() => (window as any).play());
  await page.waitForFunction(() => (window as any).breeze.runtime.playbackState === 'holding');

  await page.evaluate(() => (window as any).stop());
  await page.waitForFunction(
    () => (window as any).breeze.runtime.playbackState === 'finished',
    undefined,
    { timeout: 5000 },
  );

  expect(await translateX(page, 'bar')).toBeCloseTo(-960, 0);
  expect(await opacityOf(page, 'name')).toBeCloseTo(0, 2);
});

test('update() changes bound text live while holding', async ({ page }) => {
  await page.evaluate(() => (window as any).play());
  await page.waitForFunction(() => (window as any).breeze.runtime.playbackState === 'holding');

  await page.evaluate(() =>
    (window as any).update(JSON.stringify({ name: 'Alex Rivera', title: 'Field Producer' })),
  );

  await expect(page.locator('[data-layer-id="name"] .bz-text-inner')).toHaveText('Alex Rivera');
  await expect(page.locator('[data-layer-id="title"] .bz-text-inner')).toHaveText('Field Producer');

  // Updating data must not disturb playback position.
  expect(await runtimeState(page)).toBe('holding');
  expect(await translateX(page, 'bar')).toBeCloseTo(120, 0);
});

/**
 * Fit Width measurements are font-dependent, and the demo asks for Inter with
 * an Arial fallback — so which font actually resolves varies by machine. These
 * assert the *invariant* (scaled width fits, unless the minScale floor stopped
 * us) rather than hard-coded pixel counts that only hold on one box.
 */
const MAX_WIDTH = 700;
const MIN_SCALE = 0.6; // from examples/lower-third.json

async function measureFit(page: Page) {
  return page.evaluate(() => {
    const inner = document.querySelector<HTMLElement>('[data-layer-id="name"] .bz-text-inner')!;
    const layer = document.querySelector<HTMLElement>('[data-layer-id="name"]')!;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(inner).transform);
    return {
      scale: matrix.a,
      // offsetWidth is layout size and ignores transforms, so this is the
      // natural width in stage pixels — the same number the runtime measures.
      natural: inner.offsetWidth,
      flaggedOverflow: layer.dataset['fitOverflow'] === '1',
    };
  });
}

test('Fit Width leaves a name that already fits untouched', async ({ page }) => {
  await page.evaluate(() => (window as any).update({ name: 'JANE DOE' }));

  const { scale, natural, flaggedOverflow } = await measureFit(page);
  expect(natural).toBeLessThan(MAX_WIDTH);
  expect(scale).toBeCloseTo(1, 3);
  expect(flaggedOverflow).toBe(false);
});

/**
 * Find a name that overflows the box but not past the minScale floor, by
 * measuring instead of guessing. Glyph widths depend on which font the host
 * actually resolves, so a hard-coded fixture would be testing the test machine.
 */
async function nameNeedingScale(page: Page): Promise<string> {
  const base = 'ALEXANDRA CONSTANTINE-WHITFIELD';
  for (let length = 20; length <= base.length; length += 1) {
    const candidate = base.slice(0, length).trim();
    await page.evaluate((name) => (window as any).update({ name }), candidate);
    const { natural } = await measureFit(page);
    const required = MAX_WIDTH / natural;
    if (required < 1 && required > MIN_SCALE) return candidate;
  }
  throw new Error('no candidate name landed between the box width and the minScale floor');
}

test('Fit Width condenses an over-long name to exactly its box', async ({ page }) => {
  await nameNeedingScale(page);

  const { scale, natural, flaggedOverflow } = await measureFit(page);
  const required = MAX_WIDTH / natural;

  expect(scale).toBeCloseTo(required, 3);
  expect(natural * scale).toBeLessThanOrEqual(MAX_WIDTH + 1);
  expect(flaggedOverflow).toBe(false);
});

test('Fit Width stops at minScale rather than squashing a name illegibly', async ({ page }) => {
  await page.evaluate(() =>
    (window as any).update({ name: 'BARTHOLOMEW MAXIMILIAN VON HOHENZOLLERN-SIGMARINGEN III' }),
  );

  const { scale, natural, flaggedOverflow } = await measureFit(page);
  expect(MAX_WIDTH / natural).toBeLessThan(MIN_SCALE); // fixture is absurd on purpose

  // Clamped at the legibility floor, so it deliberately still overflows —
  // and says so, instead of silently going to air mangled.
  expect(scale).toBeCloseTo(MIN_SCALE, 3);
  expect(natural * scale).toBeGreaterThan(MAX_WIDTH);
  expect(flaggedOverflow).toBe(true);

  const reported = await page.evaluate(
    () => (window as any).breeze.runtime.overflowingTextLayers as string[],
  );
  expect(reported).toContain('name');
});

test('Fit Width measures in stage pixels even when the stage is scaled', async ({ page }) => {
  const name = await nameNeedingScale(page);
  const unscaled = await measureFit(page);

  /**
   * Scale the stage explicitly rather than relying on `?scale=contain`: at a
   * 1920×1080 viewport a 1920×1080 stage contains at scale 1, so that route
   * would pass this test without ever scaling anything.
   *
   * With a real ancestor transform, measuring via getBoundingClientRect would
   * halve the perceived text width and compute a completely different fit —
   * the editor preview would disagree with what goes to air.
   */
  await page.evaluate((n) => {
    (window as any).breeze.runtime.setViewportScale(0.5);
    (window as any).update({ name: n });
  }, name);

  const scaled = await measureFit(page);

  expect(scaled.natural).toBe(unscaled.natural);
  expect(scaled.scale).toBeCloseTo(unscaled.scale, 4);
});

test.describe('nested compositions', () => {
  test('expands the badge sub-composition into the graphic', async ({ page }) => {
    const ids = await page.$$eval('[data-layer-id]', (els) =>
      els.map((el) => el.getAttribute('data-layer-id')),
    );

    expect(ids).toContain('badge');
    expect(ids).toContain('badge/chip');
    expect(ids).toContain('badge/label');
  });

  test('reports no unresolved references', async ({ page }) => {
    const warnings = await page.evaluate(
      () => (window as any).breeze.runtime.warnings as unknown[],
    );
    expect(warnings).toEqual([]);
  });

  test('honours the nested in-point on the parent playhead', async ({ page }) => {
    // The badge starts at 0.3s, so its chip is hidden before then.
    await page.evaluate(() => (window as any).seek(0.1));
    await expect(page.locator('[data-layer-id="badge/chip"]')).toBeHidden();

    await page.evaluate(() => (window as any).seek(0.7));
    await expect(page.locator('[data-layer-id="badge/chip"]')).toBeVisible();
  });

  test('keeps an overridden nested field pinned against a parent update', async ({ page }) => {
    await page.evaluate(() => (window as any).update({ badgeText: 'OVERWRITTEN' }));
    await expect(page.locator('[data-layer-id="badge/label"] .bz-text-inner')).toHaveText('LIVE');
  });

  test('renders a real SVG mask with a gaussian feather', async ({ page }) => {
    const mask = await page.evaluate(() => {
      const chip = document.querySelector<HTMLElement>('[data-layer-id="badge/chip"]')!;
      const reference = getComputedStyle(chip).maskImage || chip.style.getPropertyValue('mask-image');
      const blur = document.querySelector('feGaussianBlur');
      return { reference, stdDeviation: blur?.getAttribute('stdDeviation') ?? null };
    });

    expect(mask.reference).toContain('bz-mask-');
    expect(mask.stdDeviation).toBe('3');
  });
});

test('query-string data seeds the graphic before first paint', async ({ page }) => {
  await page.goto('/play/demo/l3rd-name?autoplay=0&name=Query%20Seeded&title=From%20URL');
  await page.waitForFunction(() => Boolean((window as any).breeze));
  await expect(page.locator('[data-layer-id="name"] .bz-text-inner')).toHaveText('Query Seeded');
});

test('seek() places the playhead deterministically', async ({ page }) => {
  await page.evaluate(() => (window as any).seek(0.6));
  expect(await translateX(page, 'bar')).toBeCloseTo(120, 0);

  await page.evaluate(() => (window as any).seek(0));
  expect(await translateX(page, 'bar')).toBeCloseTo(-960, 0);
});

test('a malformed update payload does not take the graphic off air', async ({ page }) => {
  await page.evaluate(() => (window as any).play());
  await page.waitForFunction(() => (window as any).breeze.runtime.playbackState === 'holding');

  await page.evaluate(() => (window as any).update('{not json'));

  expect(await runtimeState(page)).toBe('holding');
  expect(await translateX(page, 'bar')).toBeCloseTo(120, 0);
});
