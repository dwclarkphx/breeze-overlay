// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 6 Wave 1 acceptance: a standings table driven
 * by a data source, re-sorting live on air.
 *
 * The unit tests cover the transform pipeline, the paging arithmetic and the
 * FLIP bookkeeping in happy-dom. What only a real browser settles is everything
 * that depends on layout and on the real socket: that the rows are where the
 * geometry says, that a change pushed through the server reaches a page that is
 * already on air, and that the row elements survive the re-sort instead of being
 * rebuilt under it.
 */

const PLAY = '/play/demo/standings?autoplay=0';
const TABLE = '[data-layer-id="panel/table"]';

async function open(page: Page, url = PLAY) {
  await page.goto(url);
  await page.waitForFunction(() => Boolean((window as { breeze?: unknown }).breeze));
}

const seek = (page: Page, time: number) =>
  page.evaluate((t) => (window as any).breeze.runtime.seek(t), time);

/** Every visible row's team and its y, top to bottom by geometry. */
async function rows(page: Page): Promise<Array<{ team: string; y: number; key: string }>> {
  return page.evaluate((sel) => {
    const host = document.querySelector(sel)!;
    return [...host.querySelectorAll('.bz-table-row')]
      .map((el) => {
        const box = el.getBoundingClientRect();
        const team = el.querySelector('[data-layer-id$="/team"] .bz-text-inner')?.textContent ?? '';
        return { team, y: Math.round(box.top), key: (el as HTMLElement).dataset['rowKey'] ?? '' };
      })
      .sort((a, b) => a.y - b.y);
  }, TABLE);
}

const CANONICAL = [
  { team: 'Mesa Marlins', w: 11, l: 2, pct: '.846' },
  { team: 'Chandler Chargers', w: 9, l: 4, pct: '.692' },
  { team: 'Tempe Thunderbirds', w: 8, l: 5, pct: '.615' },
  { team: 'Gilbert Grizzlies', w: 7, l: 6, pct: '.538' },
  { team: 'Scottsdale Scorpions', w: 5, l: 8, pct: '.385' },
  { team: 'Peoria Pioneers', w: 3, l: 10, pct: '.231' },
];

async function pushRows(
  page: Page,
  data: Array<Record<string, unknown>>,
): Promise<void> {
  const response = await page.request.post('/api/control/demo/standings/update', {
    data: {
      standings: {
        columns: [
          { key: 'team', label: 'Team', type: 'string' },
          { key: 'w', label: 'W', type: 'number' },
          { key: 'l', label: 'L', type: 'number' },
          { key: 'pct', label: 'PCT', type: 'string' },
        ],
        rows: data,
      },
    },
  });
  expect(response.ok()).toBe(true);
}

/*
 * The hub retains channel data, so a push in one test is still on air in the
 * next. That is the behavior the whole resync design depends on, and it makes
 * these tests order-dependent unless each starts from a known state — so every
 * one of them re-establishes the seeded rows first.
 */
test.beforeEach(async ({ page }) => {
  await pushRows(page, CANONICAL);
});

test('the table renders one row per data row, in transform order', async ({ page }) => {
  await open(page);
  await seek(page, 1.4);

  const visible = await rows(page);
  // Six teams in the source, five rows to a page.
  expect(visible).toHaveLength(5);

  // Sorted by wins descending, per the composition's transform pipeline.
  expect(visible.map((r) => r.team)).toEqual([
    'Mesa Marlins',
    'Chandler Chargers',
    'Tempe Thunderbirds',
    'Gilbert Grizzlies',
    'Scottsdale Scorpions',
  ]);
});

test('rows are one pitch apart, and the last one fits the box', async ({ page }) => {
  await open(page);
  await seek(page, 1.4);

  const visible = await rows(page);
  const pitch = visible[1]!.y - visible[0]!.y;
  expect(pitch).toBe(70); // 64px row + 6px gap

  const host = await page.locator(TABLE).boundingBox();
  expect(visible.at(-1)!.y + 64).toBeLessThanOrEqual(Math.round(host!.y + host!.height) + 1);
});

test('the rank transform numbers rows by wins, not by source order', async ({ page }) => {
  await open(page);
  await seek(page, 1.4);

  const positions = await page.locator(`${TABLE} [data-layer-id$="/pos"] .bz-text-inner`).allTextContents();
  expect(positions).toEqual(['1', '2', '3', '4', '5']);
});

test('an update re-sorts the table without rebuilding its rows', async ({ page }) => {
  /*
   * The standings shuffle, end to end. Peoria goes from last to first; the same
   * row element must end up at the top, because a rebuild would mean there is
   * nothing for the FLIP to animate and the change would land as a flicker.
   */
  await open(page);
  await seek(page, 1.4);

  const before = await rows(page);
  expect(before[0]!.team).toBe('Mesa Marlins');
  const peoriaKey = 'team:Peoria Pioneers';

  await pushRows(page, [
    ...CANONICAL.slice(0, 5),
    { team: 'Peoria Pioneers', w: 20, l: 1, pct: '.952' },
  ]);

  await page.waitForFunction(
    (sel) => {
      const host = document.querySelector(sel)!;
      const first = [...host.querySelectorAll('.bz-table-row')]
        .map((el) => ({ el, top: el.getBoundingClientRect().top }))
        .sort((a, b) => a.top - b.top)[0];
      const team = first?.el.querySelector('[data-layer-id$="/team"] .bz-text-inner');
      return team?.textContent?.includes('Peoria') ?? false;
    },
    TABLE,
    { timeout: 10_000 },
  );

  const after = await rows(page);
  expect(after[0]!.team).toBe('Peoria Pioneers');
  // Same element, moved — not a new one.
  expect(after[0]!.key).toBe(peoriaKey);
  expect(before.some((r) => r.key === peoriaKey)).toBe(false); // it was on page 2 before
  expect(after.map((r) => r.team)).not.toContain('Scottsdale Scorpions');
});

test('a re-sort animates rather than snapping', async ({ page }) => {
  await open(page);
  await seek(page, 1.4);

  await pushRows(page, [
    { team: 'Mesa Marlins', w: 1, l: 12, pct: '.077' },
    ...CANONICAL.slice(1, 5),
  ]);

  // Mid-flight, Mesa is neither where it was nor where it is going.
  await page.waitForTimeout(200);
  const midflight = await rows(page);
  const mesa = midflight.find((r) => r.team === 'Mesa Marlins')!;
  const top = Math.min(...midflight.map((r) => r.y));
  expect(mesa.y).toBeGreaterThan(top);

  await page.waitForTimeout(700);
  const settled = await rows(page);
  expect(settled.at(-1)!.team).toBe('Mesa Marlins');
});

test('NEXT pages the table while the graphic holds', async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as any).breeze.play());
  await page.waitForFunction(
    () => (window as any).breeze.runtime.playbackState === 'holding',
    undefined,
    { timeout: 10_000 },
  );

  expect((await rows(page))[0]!.team).toBe('Mesa Marlins');

  await page.evaluate(() => (window as any).breeze.next());
  await page.waitForTimeout(100);

  // Page two: the sixth team, alone.
  const second = await rows(page);
  expect(second).toHaveLength(1);
  expect(second[0]!.team).toBe('Peoria Pioneers');

  // Pages are not steps — a step is a STOP marker, so paging leaves the count
  // alone and the control panel still reads one hold.
  const steps = await page.evaluate(() => (window as any).breeze.runtime.stepCount as number);
  expect(steps).toBe(1);

  // And the graphic did not move off its hold to do it.
  expect(
    await page.evaluate(() => (window as any).breeze.runtime.playbackState as string),
  ).toBe('holding');
});

test('a browser source opening late gets the current rows, not the snapshot', async ({
  context,
  page,
}) => {
  /*
   * The reconnect guarantee, applied to data. A source added to OBS after the
   * operator has already edited the table must come up showing what is on air —
   * not the rows the composition was authored with.
   */
  await open(page);
  await pushRows(page, [
    { team: 'Late Arrivals FC', w: 99, l: 0, pct: '1.000' },
    CANONICAL[1]!,
  ]);
  await page.waitForTimeout(300);

  const late = await context.newPage();
  await open(late);
  await seek(late, 1.4);

  await expect
    .poll(async () => (await rows(late)).map((r) => r.team), { timeout: 10_000 })
    .toEqual(['Late Arrivals FC', 'Chandler Chargers']);
});

test('the data API serves the seeded source with its health', async ({ request }) => {
  const response = await request.get('/api/projects/demo/datasources');
  expect(response.ok()).toBe(true);

  const body = (await response.json()) as {
    sources: Array<{ def: { id: string; type: string }; status: { revision: number }; rowCount: number }>;
    minPollInterval: number;
  };

  const standings = body.sources.find((s) => s.def.id === 'standings');
  expect(standings).toBeDefined();
  expect(standings!.def.type).toBe('manual');
  expect(standings!.rowCount).toBe(6);
  expect(standings!.status.revision).toBeGreaterThan(0);
  expect(body.minPollInterval).toBe(5);
});

test('the fetcher refuses a private address', async ({ request }) => {
  // This server sits on the same LAN as the switcher; "fetch any URL" is a
  // request forgery primitive without this guard.
  const response = await request.post('/api/projects/demo/datasources-preview', {
    data: { def: { id: 'probe', name: 'probe', type: 'http-json', url: 'http://192.168.0.1/' } },
  });

  const body = (await response.json()) as { ok: boolean; error?: string };
  expect(body.ok).toBe(false);
  expect(body.error).toMatch(/private address/);
});

test('the control panel renders a grid for the dataset binding', async ({ page }) => {
  await page.goto('/control/demo/standings');

  const grid = page.locator('.grid').first();
  await expect(grid).toBeVisible();
  await expect(grid.locator('th').first()).toHaveText('Team');
  // One row per team, plus the header.
  await expect(grid.locator('tr')).toHaveCount(7);
});
