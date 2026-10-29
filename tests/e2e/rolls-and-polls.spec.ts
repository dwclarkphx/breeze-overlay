// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 9 Wave R in a real browser: the Rolls, Polls & Charts demo.
 *
 * The unit tests settle the arithmetic in happy-dom, which measures every
 * element as 0. What only a browser settles is the part that depends on
 * layout: that a roll is measured and actually moves on the page, that the
 * operator's transport reaches a page that is on air through the hub, and that
 * driven bars, slices, meters and plotted lines land where the data says.
 */

const P = 'rolls-polls-7k2qd';

async function open(page: Page, comp: string, query = 'autoplay=0'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  // A dark page behind the shots, so white type shows; the tests themselves read the transparent page.
  const shots = process.env['BREEZE_E2E_SHOTS'] ? '&bg=1b2733' : '';
  await page.goto(`/play/${P}/${comp}?${query}${shots}`);
  await page.waitForFunction(() => Boolean((window as { breeze?: unknown }).breeze));
  return errors;
}

const control = (page: Page, comp: string, verb: string, data?: Record<string, unknown>) =>
  page.request.post(`/api/control/${P}/${comp}/${verb}`, data ? { data } : {});

const poll = (page: Page, data: Record<string, unknown>) =>
  page.request.post(`/api/projects/${P}/datasources/poll/poll`, { data });

/**
 * Wait for the graphic to park on its hold. With `BREEZE_E2E_SHOTS=<dir>` set,
 * a frame of each graphic on hold is saved there for a person to look at.
 */
async function holding(page: Page) {
  await page.waitForFunction(() => (window as any).breeze.runtime.state === 'holding', undefined, { timeout: 10_000 });
  const dir = process.env['BREEZE_E2E_SHOTS'];
  if (dir) {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${dir}/${new URL(page.url()).pathname.split('/').pop()}.png` });
  }
}

const travel = (page: Page) => page.evaluate(() => (window as any).breeze.runtime.scrollStates[0]?.travel as number);

const width = (page: Page, sel: string) =>
  page.evaluate((s) => [...document.querySelectorAll(s)].map((el) => Math.round(el.getBoundingClientRect().width)), sel);

async function resetPoll(page: Page) {
  await poll(page, { type: 'set', option: 'yes', value: 412 });
  await poll(page, { type: 'set', option: 'no', value: 287 });
  await poll(page, { type: 'set', option: 'unsure', value: 96 });
  await poll(page, { type: 'open' });
}

test.describe.configure({ mode: 'serial' });

test('a credits roll moves on PLAY, and the operator pauses, reverses and speeds it', async ({ page }) => {
  const errors = await open(page, 'credits-roll-4m8tq');
  await expect(page.locator('.bz-roll-row').first()).toBeAttached();
  await control(page, 'credits-roll-4m8tq', 'play');
  await holding(page);

  // Running forward at the designer's speed: travel grows with the clock.
  const t0 = await travel(page);
  await page.waitForTimeout(600);
  const t1 = await travel(page);
  expect(t1).toBeGreaterThan(t0 + 0.3);
  const report = await page.evaluate(() => (window as any).breeze.runtime.scrollStates[0]);
  expect(report.extent).toBeGreaterThan(5);

  // Pause holds it still.
  expect((await control(page, 'credits-roll-4m8tq', 'scroll', { action: 'pause' })).ok()).toBe(true);
  await page.waitForTimeout(250);
  const p0 = await travel(page);
  await page.waitForTimeout(500);
  expect(Math.abs((await travel(page)) - p0)).toBeLessThan(0.05);

  // Backward runs it the other way.
  await control(page, 'credits-roll-4m8tq', 'scroll', { action: 'backward' });
  await page.waitForTimeout(250);
  const b0 = await travel(page);
  await page.waitForTimeout(500);
  expect(await travel(page)).toBeLessThan(b0 - 0.2);

  // Faster is a step up the ladder from the designer's speed.
  await control(page, 'credits-roll-4m8tq', 'scroll', { action: 'forward' });
  const faster = await control(page, 'credits-roll-4m8tq', 'scroll', { action: 'faster' });
  expect((await faster.json()).scroll.state.rate).toBe(1.25);
  await expect.poll(() => page.evaluate(() => (window as any).breeze.runtime.scrollStates[0].rate)).toBe(1.25);

  // The rows are really laid out: a heading, then credit pairs side by side.
  const pair = page.locator('.bz-roll-pair').first();
  const halves = await pair.locator('span').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().left));
  expect(halves[1]).toBeGreaterThan(halves[0]! + 100);
  expect(errors).toEqual([]);
});

test('lyrics show a verse a page, and NEXT turns it', async ({ page }) => {
  const errors = await open(page, 'lyrics-verse-8p2hw');
  await control(page, 'lyrics-verse-8p2hw', 'play');
  await holding(page);
  const verse = page.locator('.bz-table-row .bz-text-inner').first();
  await expect(verse).toContainText('Morning on the river road');
  await control(page, 'lyrics-verse-8p2hw', 'next');
  await expect(page.locator('.bz-table-row .bz-text-inner').filter({ hasText: 'Carry me' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('poll bars are as wide as their share, and follow the votes', async ({ page }) => {
  await resetPoll(page);
  const errors = await open(page, 'poll-bars-6v3nj');
  await control(page, 'poll-bars-6v3nj', 'play');
  await holding(page);
  const bars = '[data-layer-id$="/pb-bar"]';
  // 412 / 287 / 96 of 795 is 52 / 36 / 12 per cent of a 640 px track.
  await expect.poll(() => width(page, bars)).toEqual([333, 230, 77]);
  await expect(page.locator('[data-layer-id$="/pb-pct"] .bz-text-inner')).toHaveText(['52%', '36%', '12%']);
  await expect(page.locator('[data-layer-id="pb-final"]')).toBeHidden();

  await poll(page, { type: 'set', option: 'unsure', value: 412 });
  // 412 / 287 / 412 of 1111: 37 / 26 / 37.
  await expect.poll(() => width(page, bars), { timeout: 5000 }).toEqual([237, 166, 237]);
  await poll(page, { type: 'close' });
  await expect(page.locator('[data-layer-id="pb-final"]')).toBeVisible();
  await resetPoll(page);
  expect(errors).toEqual([]);
});

test('donut slices start where the one before ends', async ({ page }) => {
  await resetPoll(page);
  const errors = await open(page, 'poll-donut-3x9kr');
  await control(page, 'poll-donut-3x9kr', 'play');
  await holding(page);
  const slices = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-layer-id$="/pd-slice"]')].map((el) => {
        const m = new DOMMatrix(getComputedStyle(el).transform);
        return { rotation: Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI), d: el.querySelector('path')?.getAttribute('d') ?? '' };
      }),
    );
  // Shares 51.8 / 36.1 / 12.1 start at 0°, 186.5° and 316.4° (atan2 reads past 180° as negative).
  await expect.poll(async () => (await slices()).map((s) => s.rotation), { timeout: 5000 }).toEqual([0, -174, -44]);
  for (const s of await slices()) expect(s.d).not.toBe('');
  await expect(page.locator('[data-layer-id$="/pd-total-n"] .bz-text-inner')).toHaveText('795');
  expect(errors).toEqual([]);
});

test('the giving meter fills to its share of the goal', async ({ page }) => {
  const errors = await open(page, 'giving-meter-5t7bn');
  await control(page, 'giving-meter-5t7bn', 'play');
  await holding(page);
  // 31,250 of 50,000 is 62.5 % of 580 px, grown from the bottom.
  const fill = page.locator('[data-layer-id$="/gm-fill"]');
  await expect.poll(async () => Math.round((await fill.boundingBox())!.height), { timeout: 5000 }).toBe(363);
  const tube = (await page.locator('[data-layer-id$="/gm-tube"]').boundingBox())!;
  const box = (await fill.boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(Math.round(tube.y + tube.height - 10));
  await expect(page.locator('[data-layer-id$="/gm-raised"] .bz-text-inner')).toHaveText('$31250');
  expect(errors).toEqual([]);
});

test('the temperature line is plotted from the rows, with a label under every point', async ({ page }) => {
  const errors = await open(page, 'temps-line-9c4dm');
  await control(page, 'temps-line-9c4dm', 'play');
  await holding(page);
  const d = await page.locator('[data-layer-id="tl-line"] path').getAttribute('d');
  expect(d).toMatch(/^M0 /);
  expect((d!.match(/C/g) ?? []).length).toBe(7);
  const xs = await page.evaluate(() =>
    [...document.querySelectorAll('[data-layer-id$="/tl-hour"]')].map((el) => Math.round(el.getBoundingClientRect().left)),
  );
  expect(xs).toHaveLength(8);
  // Each label centred on its point, the first one whole inside the table's box.
  expect(xs[0]).toBe(300);
  for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThan(160);
  await expect(page.locator('[data-layer-id$="/tl-temp"] .bz-text-inner').first()).toHaveText('88°');
  expect(errors).toEqual([]);
});

test('the gauge sweeps to the value an operator sets', async ({ page }) => {
  const errors = await open(page, 'gauge-arc-2w6yh');
  await control(page, 'gauge-arc-2w6yh', 'update', { value: 50 });
  await control(page, 'gauge-arc-2w6yh', 'play');
  await holding(page);
  await expect(page.locator('[data-layer-id="ga-number"] .bz-text-inner')).toHaveText('50%', { timeout: 5000 });
  const arc = page.locator('[data-layer-id="ga-value"] path');
  await expect.poll(() => arc.getAttribute('d')).not.toBe('');
  const half = await arc.getAttribute('d');
  await control(page, 'gauge-arc-2w6yh', 'update', { value: 100 });
  await expect(page.locator('[data-layer-id="ga-number"] .bz-text-inner')).toHaveText('100%', { timeout: 5000 });
  await expect.poll(() => arc.getAttribute('d')).not.toBe(half);
  expect(errors).toEqual([]);
});
