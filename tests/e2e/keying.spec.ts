// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Switcher-friendly outputs (Phase 9 Wave C): `?bg=` and `?matte=1`.
 *
 * What a headless browser can prove is the maths: on the same frame, a matte
 * page's grey level at every pixel is the fill page's alpha there, so a luma
 * key cut from it reproduces the fill's edges exactly. What it cannot prove is
 * the key itself — that needs an ATEM and two HDMI outputs, and the PHASE9.md
 * accept criterion says so.
 */

const CHANNEL = 'demo-1iixd/l3rd-name-2a94g';
const PLAY = `/play/${CHANNEL}`;

async function open(browser: Browser, query = ''): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`${PLAY}${query}`);
  await page.waitForFunction(() => Boolean((window as { breeze?: unknown }).breeze));
  return page;
}

const state = (page: Page) => page.evaluate(() => (window as any).breeze.runtime.playbackState as string);

/**
 * Compare a fill screenshot with a matte screenshot, inside the browser.
 *
 * Both PNGs are decoded and walked in the page, and only the counts come back.
 * Returning the raw pixels instead — four million numbers per half frame —
 * makes Playwright serialise each one as its own object, which blocks the test
 * runner's event loop for minutes, long enough that the test's own timeout
 * never gets a chance to fire.
 */
async function compareMatte(page: Page, fillPng: Buffer, mattePng: Buffer) {
  return page.evaluate(async ([fillB64, matteB64]) => {
    const decode = async (b64: string) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })!;
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    };
    const f = await decode(fillB64);
    const m = await decode(matteB64);
    const out = { sameSize: f.width === m.width && f.height === m.height, opaque: 0, partial: 0, worst: 0, notGrey: 0, notOpaque: 0 };
    for (let i = 0; i < f.data.length; i += 4) {
      const alpha = f.data[i + 3]!;
      const r = m.data[i]!, g = m.data[i + 1]!, b = m.data[i + 2]!;
      if (m.data[i + 3] !== 255) out.notOpaque += 1;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 1) out.notGrey += 1;
      out.worst = Math.max(out.worst, Math.abs(r - alpha));
      if (alpha === 255) out.opaque += 1;
      else if (alpha > 0) out.partial += 1;
    }
    return out;
  }, [fillPng.toString('base64'), mattePng.toString('base64')] as const);
}

/** One pixel of a PNG, decoded in the page. */
async function firstPixel(page: Page, png: Buffer): Promise<number[]> {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })!;
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  }, png.toString('base64'));
}

/**
 * Soft edges over nothing, added to the stage of a page.
 *
 * The demo strap cannot supply them: its text and its badge's feathered mask
 * all sit on top of the opaque bar, so the composited alpha there is 255 and a
 * comparison against it would pass whatever the matte did with partial alpha.
 * This probe is the same markup on both pages, inside `#breeze-stage` where the
 * matte filter applies: a feathered mask, a blurred shadow, a half-opacity
 * shape and rotated text, none of them over anything opaque, and clear of the
 * strap so they stay over transparency.
 */
async function addSoftProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stage = document.getElementById('breeze-stage')!;
    const probe = document.createElement('div');
    probe.id = 'keying-probe';
    probe.style.cssText = 'position:absolute;left:1300px;top:600px;width:560px;height:420px;pointer-events:none';
    probe.innerHTML =
      '<div style="position:absolute;left:0;top:0;width:300px;height:120px;background:#ffd400;' +
      '-webkit-mask-image:linear-gradient(90deg,transparent,#000 35%,#000 65%,transparent);' +
      'mask-image:linear-gradient(90deg,transparent,#000 35%,#000 65%,transparent)"></div>' +
      '<div style="position:absolute;left:20px;top:170px;width:360px;height:50px;background:#222;filter:blur(12px);opacity:.6"></div>' +
      '<div style="position:absolute;left:320px;top:40px;width:220px;height:220px;border-radius:50%;background:rgba(40,200,90,.45)"></div>' +
      '<div style="position:absolute;left:10px;top:290px;font:700 54px system-ui,sans-serif;color:#fff;' +
      'transform:rotate(-3deg) skewX(-8deg);white-space:nowrap">Soft edges</div>';
    stage.appendChild(probe);
  });
}

test.afterEach(async ({ request }) => {
  await request.post(`/api/control/${CHANNEL}/clear`);
});

test('a matte page is the fill page’s alpha, pixel for pixel, on the same hold', async ({ browser }) => {
  const fill = await open(browser);
  const matte = await open(browser, '?matte=1');

  await fill.request.post(`/api/control/${CHANNEL}/play`);
  await expect.poll(() => state(fill), { timeout: 10_000 }).toBe('holding');
  await expect.poll(() => state(matte), { timeout: 10_000 }).toBe('holding');
  await addSoftProbe(fill);
  await addSoftProbe(matte);
  // Let any last settle-in finish on both before reading them.
  await fill.waitForTimeout(300);

  // Clip to the lower half, where the strap is: a third of the pixels to compare.
  const clip = { x: 0, y: 540, width: 1920, height: 540 };
  const fillPng = await fill.screenshot({ clip, omitBackground: true });
  const mattePng = await matte.screenshot({ clip });
  const result = await compareMatte(fill, fillPng, mattePng);
  expect(result.sameSize).toBe(true);
  expect(result.notOpaque).toBe(0); // the matte page is opaque everywhere
  // Not vacuous: the strap is on screen (solid), and the probe gives tens of
  // thousands of partial-alpha pixels over transparency to get right.
  expect(result.opaque).toBeGreaterThan(10_000);
  expect(result.partial).toBeGreaterThan(5_000);
  expect(result.notGrey).toBe(0);
  // Rounding through the compositor and the canvas, and nothing more.
  expect(result.worst).toBeLessThanOrEqual(3);

  await fill.close();
  await matte.close();
});

test('?bg= paints an opaque background behind the graphic', async ({ browser }) => {
  const page = await open(browser, '?bg=00ff00');
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 32, height: 32 }, omitBackground: true });
  expect(await firstPixel(page, png)).toEqual([0, 255, 0, 255]);
  await page.close();
});

test('a matte output is listed as one, and the panel checks it against its fill', async ({ browser, context }) => {
  const fill = await open(browser);
  const matte = await open(browser, '?matte=1');

  const res = await fill.request.get(`/api/control/${CHANNEL}/state?data=0`);
  const sources = (await res.json()).state.sources as Array<{ signal?: string }>;
  expect(sources.map((s) => s.signal ?? 'fill').sort()).toEqual(['fill', 'matte']);

  const panel = await context.newPage();
  await panel.goto(`/control/${CHANNEL}`);
  await panel.getByRole('button', { name: 'PLAY' }).click();
  await expect.poll(() => state(matte), { timeout: 10_000 }).toBe('holding');
  await panel.locator('#preview-toggle').click();
  await expect(panel.locator('#key-pairs')).toContainText(/Key pair in step — fill Output \d, matte Output \d/, {
    timeout: 10_000,
  });

  // The matte misses a command — as if its page had been reloaded with ?sync=off.
  await matte.evaluate(() => (window as any).breeze.runtime.clear());
  await expect(panel.locator('#key-pairs')).toContainText('Key pair out of step', { timeout: 10_000 });

  await panel.close();
  await fill.close();
  await matte.close();
});
