// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 6 Wave 2 acceptance: a ticker driven by a data
 * source rather than a typed list.
 *
 * The unit tests already cover the RSS and Atom normalization against real feed
 * fixtures, and the derivation of items from a column. What only a real browser
 * and a real server settle is the rest of the path: that the datasets the server
 * inlines into the boot payload are on screen at load rather than one rotation
 * later, that a push over the socket reaches a crawl the way it reaches a table,
 * and that the transform pipeline the layer carries is applied server-side data
 * and client-side alike.
 *
 * The demo source is a *manual* table shaped like a feed, deliberately: the
 * acceptance is about the crawl→dataset wiring, and pointing a CI run at a live
 * RSS URL would make this test a network monitor. Feed parsing is proven in
 * `data-xml.test.ts` against captured RSS 2.0, RSS 1.0/RDF and Atom payloads.
 */

const PLAY = '/play/demo/news-ticker?autoplay=0';
const CRAWL = '[data-layer-id="feed-text"]';

async function open(page: Page, url = PLAY) {
  await page.goto(url);
  await page.waitForFunction(() => Boolean((window as { breeze?: unknown }).breeze));
}

/** The headlines currently written into the ticker, in order. */
async function headlines(page: Page): Promise<string[]> {
  return page.evaluate((sel) => {
    const block = document.querySelector(sel)?.querySelector('.bz-crawl-block');
    return (block?.textContent ?? '')
      .split('•')
      .map((s) => s.trim())
      .filter(Boolean);
  }, CRAWL);
}

const LATEST = 'Marlins clinch the East with a late run';
const OLDEST = 'Grizzlies open their new ballpark Friday';

test.describe('a ticker fed from a data source', () => {
  test('shows feed headlines at load, not the authored placeholder', async ({ page }) => {
    /*
     * The regression worth having an e2e for. The runtime builds crawl loops
     * during `build()`, which runs before the constructor applies its initial
     * data — so a source-fed ticker was built from its placeholder and had the
     * real headlines queued behind a loop rotation. On a page sitting at frame 0
     * that rotation never comes, and an operator opening the output page saw
     * "Waiting for the headline feed…" indefinitely.
     */
    await open(page);
    const items = await headlines(page);

    expect(items).toContain(LATEST);
    expect(items.join(' ')).not.toContain('Waiting for the headline feed');
  });

  test('applies the layer’s transforms to the source rows', async ({ page }) => {
    // The composition sorts by date descending and limits to five. Four rows
    // exist, so the ordering is what is under test.
    await open(page);
    const items = await headlines(page);

    expect(items[0]).toBe(LATEST);
    expect(items.at(-1)).toBe(OLDEST);
  });

  test('a source push reaches a page already on air', async ({ page }) => {
    /*
     * A crawl adopts new copy at the loop seam rather than by repainting, so
     * this asserts on the runtime's pending state rather than on the DOM: the
     * text on screen is *supposed* to be unchanged immediately after a push.
     * Asserting the DOM had changed would be asserting the bug.
     */
    await open(page);

    const response = await page.request.post('/api/control/demo/news-ticker/update', {
      data: {
        $data: {
          headlines: {
            columns: [
              { key: 'title', label: 'Title', type: 'string' },
              { key: 'date', label: 'Date', type: 'string' },
            ],
            rows: [{ title: 'Breaking: pushed mid show', date: '2026-08-02T21:00:00.000Z' }],
          },
        },
      },
    });
    expect(response.ok()).toBe(true);

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const runtime = (window as any).breeze.runtime;
          const set = runtime.datasetFor?.('headlines');
          return set ? set.rows.map((r: Record<string, unknown>) => r.title) : [];
        }),
      )
      .toContain('Breaking: pushed mid show');
  });

  test('the crawl still rotates once played', async ({ page }) => {
    // A source-bound ticker must behave like any other: bound to data is not a
    // different kind of layer, and the loop is the layer's own clock.
    await open(page, '/play/demo/news-ticker?autoplay=1');

    const x = () =>
      page.evaluate((sel) => {
        const track = document.querySelector(sel)?.querySelector<HTMLElement>('.bz-crawl-track');
        return track ? new DOMMatrix(getComputedStyle(track).transform).m41 : 0;
      }, CRAWL);

    const first = await x();
    await page.waitForTimeout(400);
    expect(await x()).not.toBe(first);
  });
});
