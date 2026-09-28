// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Late join (0.74.1): a page opened while its graphic is already on air picks
 * up from an output that is — a browser source reloaded mid-show, a panel's
 * preview switched on mid-hold — instead of sitting blank until the next PLAY.
 *
 * The unit tests cover `joinAt` and the hub's per-output reports. What only a
 * real server and real sockets settle is the round trip: output reports, hub
 * keeps it, a second page is welcomed with it and lands on the same hold.
 */

const CHANNEL = 'demo-1iixd/screen-bug-8vctv';
const PLAY = `/play/${CHANNEL}`;

async function open(browser: Browser, query = ''): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`${PLAY}${query}`);
  await page.waitForFunction(() => Boolean((window as { breeze?: unknown }).breeze));
  return page;
}

const playback = (page: Page) =>
  page.evaluate(() => {
    const r = (window as any).breeze.runtime;
    return { state: r.playbackState as string, time: r.currentTime as number, step: r.currentStep as number };
  });

async function channelState(page: Page) {
  const res = await page.request.get(`/api/control/${CHANNEL}/state?data=0`);
  return (await res.json()).state as {
    playback: { state: string } | null;
    sources: Array<{ page?: string; playback: { state: string } | null }>;
  };
}

test.afterEach(async ({ request }) => {
  await request.post(`/api/control/${CHANNEL}/clear`);
});

test('a reloaded output comes back on the hold, not blank', async ({ browser }) => {
  const first = await open(browser);
  await first.request.post(`/api/control/${CHANNEL}/play`);
  await expect.poll(async () => (await playback(first)).state).toBe('holding');

  const second = await open(browser);
  await expect.poll(async () => (await playback(second)).state).toBe('holding');
  expect((await playback(second)).step).toBe((await playback(first)).step);

  // Both outputs listed, both on air.
  const state = await channelState(second);
  expect(state.sources.map((s) => s.playback?.state)).toEqual(['holding', 'holding']);

  await first.close();
  await second.close();
});

test('a preview opened mid-hold joins, and never turns the channel idle', async ({ browser }) => {
  const output = await open(browser);
  await output.request.post(`/api/control/${CHANNEL}/play`);
  await expect.poll(async () => (await playback(output)).state).toBe('holding');

  const preview = await open(browser, '?preview=1&scale=contain');
  await expect.poll(async () => (await playback(preview)).state).toBe('holding');
  expect((await channelState(preview)).playback?.state).toBe('holding');

  await preview.close();
  await output.close();
});

test('?sync=off waits for the next command', async ({ browser }) => {
  const output = await open(browser);
  await output.request.post(`/api/control/${CHANNEL}/play`);
  await expect.poll(async () => (await playback(output)).state).toBe('holding');

  const waiting = await open(browser, '?sync=off');
  // Long enough for the welcome to have arrived and been ignored.
  await waiting.waitForTimeout(750);
  expect((await playback(waiting)).state).toBe('idle');
  // And it is still an output: the channel reads holding, from the other one.
  expect((await channelState(waiting)).playback?.state).toBe('holding');

  await waiting.close();
  await output.close();
});

test('the control panel offers each connected output under Sync to', async ({ browser }) => {
  const output = await open(browser);
  await output.request.post(`/api/control/${CHANNEL}/play`);
  await expect.poll(async () => (await playback(output)).state).toBe('holding');

  const panel = await browser.newPage();
  await panel.goto(`/control/${CHANNEL}`);
  const options = panel.locator('#preview-sync option');
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveText('Newest output');
  await expect(options.nth(1)).toContainText('Output 1');
  await expect(options.nth(2)).toHaveText(/^Off/);

  // Choosing an output reloads the preview with it named in the URL.
  await panel.locator('#preview-toggle').click();
  const value = await options.nth(1).getAttribute('value');
  await panel.locator('#preview-sync').selectOption(value!);
  await expect(panel.locator('#preview-frame iframe')).toHaveAttribute('src', new RegExp(`sync=${value}`));

  await panel.close();
  await output.close();
});
