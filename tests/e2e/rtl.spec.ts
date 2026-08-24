// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Right-to-left, against `ar-XB` — I18N.md §6.
 *
 * `ar-XB` is the RTL pseudo-locale: English words, Arabic direction. That is
 * exactly what this spec wants, because every assertion here is about *layout*,
 * and asserting on layout is much easier when you can still read the labels.
 *
 * **This spec runs its own server.** The locale is an installation setting
 * resolved once at boot (§4.4), so there is no way to ask the suite's shared
 * server for a different one — and adding a per-request override to make
 * testing easier is precisely the thing §4.4 refused. A second process on its
 * own port and its own data directory is the honest way to test a boot setting.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/*
 * `__dirname`, not `import.meta.url`. There is no `"type": "module"` anywhere
 * above `tests/`, so Playwright transpiles a spec to CommonJS and `import.meta`
 * is a syntax error before a single test runs — `playwright.config.ts` already
 * uses `__dirname` for the same reason. Vitest is the opposite: the server and
 * package suites run as ESM, so `import.meta.dirname` is right *there*.
 */
const repoRoot = path.resolve(__dirname, '..', '..');

/*
 * Offset from the suite's own port rather than hardcoded, so the two servers
 * cannot collide and BREEZE_E2E_PORT still moves both — see the config's note
 * about Hyper-V reserving ranges on Windows.
 */
const PORT = String(Number(process.env['BREEZE_E2E_PORT'] ?? '7399') + 1);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), 'breeze-e2e-rtl');

let server: ChildProcess | null = null;

/** Poll `/healthz` rather than sleeping: the first boot also seeds the demos. */
async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${ORIGIN}/healthz`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`no server on ${ORIGIN} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test.beforeAll(async () => {
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  /*
   * `dist/` is already built: Playwright starts the suite's webServer — whose
   * command is `build && start` — before any spec runs. Building again here
   * would double a slow step for nothing.
   */
  server = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'dist', 'index.js')], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      BREEZE_PORT: PORT,
      BREEZE_HOST: '127.0.0.1',
      BREEZE_LOG_LEVEL: 'warn',
      BREEZE_DATA_DIR: DATA_DIR,
      BREEZE_LOCALE: 'ar-XB',
    },
  });
  await waitForServer();
});

test.afterAll(async () => {
  server?.kill();
  server = null;
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

/** Computed `direction` for the first match — what the browser actually applied. */
const directionOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => getComputedStyle(el).direction);

test.describe('the shell mirrors', () => {
  test('the server-rendered pages declare the resolved locale and direction', async ({ page }) => {
    for (const url of ['/', '/backup', '/activity', '/docs']) {
      await page.goto(`${ORIGIN}${url}`);
      const html = page.locator('html');
      await expect(html, url).toHaveAttribute('dir', 'rtl');
      await expect(html, url).toHaveAttribute('lang', 'ar-XB');
    }
  });

  test('the control panel mirrors', async ({ page }) => {
    await page.goto(`${ORIGIN}/control/demo/l3rd-name`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    expect(await directionOf(page, 'fieldset')).toBe('rtl');
  });

  test('/play does not mirror, whatever the server is set to', async ({ page }) => {
    /*
     * The frozen surface (§2). A graphic does not mirror — the composition's
     * coordinates are absolute and the output has to be byte-identical on every
     * install — so `/play` keeps `lang="en"` and never gains a `dir`.
     */
    await page.goto(`${ORIGIN}/play/demo/l3rd-name?autoplay=0`);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', 'en');
    expect(await html.getAttribute('dir')).toBeNull();
    expect(await directionOf(page, 'html')).toBe('ltr');
  });
});

test.describe('the workspace does not', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${ORIGIN}/editor/`);
    // Same wait the other editor specs use: the panels render placeholders
    // until a project has loaded over the API, and a placeholder has no
    // timeline or stage to measure.
    await expect(page.locator('.layer-row').first()).toBeVisible({ timeout: 15_000 });
  });

  test('the editor chrome mirrors', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    expect(await directionOf(page, '.layers-panel')).toBe('rtl');
  });

  test('the timeline body stays left-to-right', async ({ page }) => {
    /*
     * The assertion this whole spec exists for. Time runs left to right in
     * every non-linear editor on earth, including the Arabic-localised ones;
     * a mirrored timeline puts 00:00 on the right and reads timecode backwards.
     */
    expect(await directionOf(page, '.timeline-body')).toBe('ltr');
  });

  test('the stage canvas stays left-to-right', async ({ page }) => {
    // The stage is a 1:1 preview of what goes to air, and the graphic does not
    // mirror — so a mirrored preview would be lying about the output.
    expect(await directionOf(page, '.stage-canvas')).toBe('ltr');
  });

  test('the ruler still runs earlier-to-later across the screen', async ({ page }) => {
    /*
     * `direction: ltr` on the container is necessary but not sufficient: the
     * ticks are absolutely positioned from `timeToPx`, and a regression that
     * converted those to logical properties would flip them while leaving the
     * computed direction alone. So this measures where they actually land.
     */
    const ticks = page.locator('.timeline-ruler .tick');
    const count = await ticks.count();
    expect(count, 'the ruler should have ticks to measure').toBeGreaterThan(1);

    const xs: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const box = await ticks.nth(i).boundingBox();
      if (box) xs.push(box.x);
    }
    const ascending = xs.every((x, i) => i === 0 || x >= xs[i - 1]!);
    expect(ascending, `tick positions were ${JSON.stringify(xs)}`).toBe(true);
  });
});

test.describe('script-sensitive typography', () => {
  test('drops tracking and capitals for an RTL script', async ({ page }) => {
    /*
     * §6.3. `letter-spacing` on Arabic breaks the cursive join — the glyphs
     * separate and the text stops reading as words — and `text-transform:
     * uppercase` does nothing in Arabic or Hebrew and is wrong in Turkish.
     * Both go through custom properties keyed on `lang`, so this checks the
     * switch rather than any one declaration.
     */
    await page.goto(`${ORIGIN}/`);
    const tracking = await page
      .locator('html')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--ui-tracking').trim());
    const caps = await page
      .locator('html')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--ui-caps').trim());
    expect(tracking).toBe('0');
    expect(caps).toBe('none');
  });
});
