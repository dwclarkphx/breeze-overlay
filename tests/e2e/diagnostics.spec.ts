// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { test } from '@playwright/test';

/**
 * Diagnostics, not assertions.
 *
 * These record what actually happens during a stage drag and print it. They
 * pass unconditionally — their only job is to turn a guess into data.
 *
 * Run with:  pnpm test:e2e:only diagnostics --reporter=list
 *
 * The config lives in `tests/`, which Playwright does not auto-discover, so a
 * bare `pnpm exec playwright test diagnostics` finds no tests. The script above
 * carries the `-c` flag; spelled out it is
 * `pnpm exec playwright test -c tests/playwright.config.ts diagnostics`.
 *
 * Three attempts to fix stage dragging have each been based on a theory rather
 * than a measurement, and the last one produced results identical to the build
 * before it, proving the theory wrong. This captures the facts needed to stop
 * that: where the pointer actually lands, how many gestures Moveable reports,
 * and what deltas it hands back.
 */

test('capture what a stage drag actually does', async ({ page }) => {
  await page.goto('/editor/');
  await page.locator('.layer-row').first().waitFor({ timeout: 15_000 });

  await page.locator('select.add-layer').selectOption('text');
  await page.locator('.moveable-control-box').first().waitFor();

  // Instrument the page: record every Moveable-driven document change.
  await page.evaluate(() => {
    (window as any).__dragLog = [];
    const log = (window as any).__dragLog as unknown[];

    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
      window.addEventListener(
        type,
        (e) => {
          const pe = e as PointerEvent;
          const el = pe.target as HTMLElement | null;
          log.push({
            type,
            x: Math.round(pe.clientX),
            y: Math.round(pe.clientY),
            target: el?.className || el?.tagName,
          });
        },
        true,
      );
    }
  });

  const control = page.locator('.moveable-control-box').first();
  const box = (await control.boundingBox())!;
  const stage = (await page.locator('.stage-host').boundingBox())!;
  const zoom = (await page.locator('.zoom-readout').textContent())!;

  const xField = page.locator('.prop-field', { hasText: 'X' }).first().locator('input');
  const yField = page.locator('.prop-field', { hasText: 'Y' }).first().locator('input');
  const before = { x: await xField.inputValue(), y: await yField.inputValue() };

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy, { steps: 5 });
  await page.mouse.move(cx + 120, cy, { steps: 5 });
  await page.mouse.up();

  const after = { x: await xField.inputValue(), y: await yField.inputValue() };
  const events = (await page.evaluate(() => (window as any).__dragLog)) as Array<{
    type: string;
    x: number;
    y: number;
    target: string;
  }>;

  const historyDepth = await page.evaluate(() => {
    // The store is not exposed globally; count undo steps by clicking instead.
    return null;
  });

  console.log('\n──────── stage drag diagnostics ────────');
  console.log('zoom readout        :', zoom);
  console.log('stage host box      :', JSON.stringify(stage));
  console.log('control box         :', JSON.stringify(box));
  console.log('pointer start       :', { cx: Math.round(cx), cy: Math.round(cy) });
  console.log('X before → after    :', before.x, '→', after.x);
  console.log('Y before → after    :', before.y, '→', after.y);
  console.log('expected ΔX (120/z) :', (120 / (Number(zoom.replace('%', '')) / 100)).toFixed(1));
  console.log('actual ΔX           :', (Number(after.x) - Number(before.x)).toFixed(1));
  console.log('pointerdown target  :', events.find((e) => e.type === 'pointerdown')?.target);
  console.log('pointer event count :', events.length);
  console.log('history probe       :', historyDepth);
  console.log('────────────────────────────────────────\n');
});
