// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 4 acceptance (ROADMAP §4): an operator fires a name strap into an
 * output and edits it live on air.
 *
 * Two real pages in two tabs — the operator panel and the transparent output
 * page — talking over the real WebSocket hub. Nothing is mocked, so this is the
 * closest thing to the vMix workflow that can be automated.
 */

const PLAY = '/play/demo/l3rd-name?autoplay=0';
const CONTROL = '/control/demo/l3rd-name';

async function openOutput(page: Page) {
  await page.goto(PLAY);
  await page.waitForFunction(() => Boolean((window as { breeze?: unknown }).breeze));
}

const playbackState = (page: Page) =>
  page.evaluate(() => (window as any).breeze.runtime.playbackState as string);

const nameText = (page: Page) =>
  page.locator('[data-layer-id="name"] .bz-text-inner').textContent();

test('the panel reports when an output is connected', async ({ context, page }) => {
  await page.goto(CONTROL);
  await expect(page.locator('#status')).toContainText('no output', { timeout: 10_000 });

  const output = await context.newPage();
  await openOutput(output);

  await expect(page.locator('#status')).toContainText('1 output', { timeout: 10_000 });
  await expect(page.locator('#dot')).toHaveClass(/live/);
});

test('PLAY on the panel rolls the graphic on the output', async ({ context, page }) => {
  const output = await context.newPage();
  await openOutput(output);

  await page.goto(CONTROL);
  await expect(page.locator('#status')).toContainText('1 output', { timeout: 10_000 });

  await page.getByRole('button', { name: 'PLAY' }).click();

  await output.waitForFunction(
    () => (window as any).breeze.runtime.playbackState === 'holding',
    undefined,
    { timeout: 10_000 },
  );
  expect(await playbackState(output)).toBe('holding');
});

test('typing a name and hitting PLAY puts that name on air', async ({ context, page }) => {
  // The headline workflow: no separate update step.
  const output = await context.newPage();
  await openOutput(output);

  await page.goto(CONTROL);
  await expect(page.locator('#status')).toContainText('1 output', { timeout: 10_000 });

  await page.locator('input[data-binding="name"]').fill('Alex Rivera');
  await page.getByRole('button', { name: 'PLAY' }).click();

  await expect
    .poll(() => nameText(output), { timeout: 10_000 })
    .toBe('Alex Rivera');
});

test('edits reach the graphic while it is holding on air', async ({ context, page }) => {
  const output = await context.newPage();
  await openOutput(output);

  await page.goto(CONTROL);
  await expect(page.locator('#status')).toContainText('1 output', { timeout: 10_000 });
  await page.getByRole('button', { name: 'PLAY' }).click();
  await output.waitForFunction(
    () => (window as any).breeze.runtime.playbackState === 'holding',
    undefined,
    { timeout: 10_000 },
  );

  await page.locator('input[data-binding="name"]').fill('Corrected Name');
  await page.getByRole('button', { name: 'UPDATE ON AIR' }).click();

  await expect.poll(() => nameText(output), { timeout: 10_000 }).toBe('Corrected Name');
  // Correcting a name must not disturb playback.
  expect(await playbackState(output)).toBe('holding');
});

test('repeated PLAY walks the graphic forward', async ({ context, page }) => {
  /*
   * One-button workflow: PLAY steps in → hold → out. The demo lower third has a
   * single hold, so the second press runs the outro.
   */
  const output = await context.newPage();
  await openOutput(output);

  await page.goto(CONTROL);
  await expect(page.locator('#status')).toContainText('1 output', { timeout: 10_000 });

  await page.getByRole('button', { name: 'PLAY' }).click();
  await output.waitForFunction(
    () => (window as any).breeze.runtime.playbackState === 'holding',
    undefined,
    { timeout: 10_000 },
  );

  await page.getByRole('button', { name: 'PLAY' }).click();
  await output.waitForFunction(
    () => (window as any).breeze.runtime.playbackState === 'finished',
    undefined,
    { timeout: 10_000 },
  );

  // And it must still come back afterwards rather than wedging.
  await page.getByRole('button', { name: 'PLAY' }).click();
  await output.waitForFunction(
    () => (window as any).breeze.runtime.playbackState === 'holding',
    undefined,
    { timeout: 10_000 },
  );
});

test('STOP takes the graphic off air', async ({ context, page }) => {
  const output = await context.newPage();
  await openOutput(output);

  await page.goto(CONTROL);
  await expect(page.locator('#status')).toContainText('1 output', { timeout: 10_000 });
  await page.getByRole('button', { name: 'PLAY' }).click();
  await output.waitForFunction(
    () => (window as any).breeze.runtime.playbackState === 'holding',
    undefined,
    { timeout: 10_000 },
  );

  await page.getByRole('button', { name: 'STOP' }).click();

  await output.waitForFunction(
    () => (window as any).breeze.runtime.playbackState === 'finished',
    undefined,
    { timeout: 10_000 },
  );
});

test('STOP pressed twice does not wedge the graphic', async ({ context, page }) => {
  /*
   * Reported from the operator panel: STOP, STOP again, and PLAY was dead until
   * CLEAR. Pressing a button twice out of caution is exactly what an operator
   * does when they are not certain it registered.
   */
  const output = await context.newPage();
  await openOutput(output);

  await page.goto(CONTROL);
  await expect(page.locator('#status')).toContainText('1 output', { timeout: 10_000 });

  await page.getByRole('button', { name: 'PLAY' }).click();
  await output.waitForFunction(
    () => (window as any).breeze.runtime.playbackState === 'holding',
    undefined,
    { timeout: 10_000 },
  );

  await page.getByRole('button', { name: 'STOP' }).click();
  await output.waitForFunction(
    () => (window as any).breeze.runtime.playbackState === 'finished',
    undefined,
    { timeout: 10_000 },
  );

  await page.getByRole('button', { name: 'STOP' }).click();
  expect(await playbackState(output)).toBe('finished');

  // The graphic must still come back without a CLEAR.
  await page.getByRole('button', { name: 'PLAY' }).click();
  await output.waitForFunction(
    () => (window as any).breeze.runtime.playbackState === 'holding',
    undefined,
    { timeout: 10_000 },
  );
});

test('updating a ticker does not jump the scroll position', async ({ context, page }) => {
  /*
   * Reported: adding a line to the news ticker from the panel caused a visible
   * reload/jump. New headlines must join the rotation at the loop seam, not
   * replace the content under the operator mid-pass.
   */
  const output = await context.newPage();
  await output.goto('/play/demo/ticker?autoplay=0');
  await output.waitForFunction(() => Boolean((window as any).breeze));

  await page.goto('/control/demo/ticker');
  await expect(page.locator('#status')).toContainText('1 output', { timeout: 10_000 });
  await page.getByRole('button', { name: 'PLAY' }).click();

  const trackX = () =>
    output.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.bz-crawl-track')!;
      return new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
    });

  // Let it travel far enough that a reset to zero would be unmistakable.
  await output.waitForTimeout(600);
  const before = await trackX();
  expect(Math.abs(before)).toBeGreaterThan(0);

  await page.locator('textarea[data-binding="headlines"]').fill('Added mid show\nSecond line');
  await page.getByRole('button', { name: 'UPDATE ON AIR' }).click();
  await output.waitForTimeout(150);

  // The scroll must have carried on past where it was, not snapped back.
  const after = await trackX();
  expect(Math.abs(after)).toBeGreaterThanOrEqual(Math.abs(before) - 1);
});

test('the panel shows what the graphic is doing', async ({ context, page }) => {
  const output = await context.newPage();
  await openOutput(output);

  await page.goto(CONTROL);
  await expect(page.locator('#status')).toContainText('1 output', { timeout: 10_000 });
  await page.getByRole('button', { name: 'PLAY' }).click();

  await expect(page.locator('#playback')).toHaveText('holding', { timeout: 10_000 });
  await expect(page.locator('#step')).toHaveText('1/1');
});

test('a REST trigger drives the output, for Stream Deck and Companion', async ({ context, page }) => {
  await openOutput(page);

  const response = await context.request.post('/api/control/demo/l3rd-name/play');
  expect(response.ok()).toBe(true);
  // At least one: the count reflects however many outputs are open on this
  // channel, which a single test cannot assert exclusively. The value that
  // matters to an operator is that it is not zero.
  expect((await response.json()).delivered).toBeGreaterThanOrEqual(1);

  await page.waitForFunction(
    () => (window as any).breeze.runtime.playbackState === 'holding',
    undefined,
    { timeout: 10_000 },
  );
});

test('a GET trigger with query fields works from a URL alone', async ({ context, page }) => {
  await openOutput(page);

  await context.request.get('/api/control/demo/l3rd-name/update?name=From%20A%20URL');

  await expect.poll(() => nameText(page), { timeout: 10_000 }).toBe('From A URL');
});

test('an output that reconnects comes back with the current name', async ({ context, page }) => {
  /*
   * The reason the hub retains state. A browser source drops for dull reasons
   * mid-show; it must return showing what the operator typed, not the
   * placeholder baked into the composition.
   */
  await page.goto(CONTROL);
  await page.locator('input[data-binding="name"]').fill('Set Before Connect');
  await page.getByRole('button', { name: 'UPDATE ON AIR' }).click();

  const output = await context.newPage();
  await openOutput(output);

  await expect.poll(() => nameText(output), { timeout: 10_000 }).toBe('Set Before Connect');
});

test('two outputs stay in step', async ({ context, page }) => {
  // Preview and program, or two machines showing the same strap.
  const a = await context.newPage();
  const b = await context.newPage();
  await openOutput(a);
  await openOutput(b);

  await page.goto(CONTROL);
  await expect(page.locator('#status')).toContainText('2 outputs', { timeout: 10_000 });

  await page.locator('input[data-binding="name"]').fill('Both Screens');
  await page.getByRole('button', { name: 'PLAY' }).click();

  await expect.poll(() => nameText(a), { timeout: 10_000 }).toBe('Both Screens');
  await expect.poll(() => nameText(b), { timeout: 10_000 }).toBe('Both Screens');
});
