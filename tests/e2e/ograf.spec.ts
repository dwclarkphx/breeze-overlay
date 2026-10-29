// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, test, type Page } from '@playwright/test';

/**
 * OGraf interop (Phase 9 Wave D), in a real browser against the real server.
 *
 *  - **D2**: a page on another origin plays the part of an OGraf renderer. It
 *    imports the pointer package's `graphic.mjs` from the server — cross-origin,
 *    so CORS and the module itself are both under test — and drives it through
 *    the OGraf Graphic API. The graphic it frames must hold, show the name it
 *    was given, and leave.
 *  - **D1**: an OGraf controller's calls, made with the request API, drive a
 *    Breeze channel; the output page plays and the control panel shows it.
 *
 * What this cannot do is stand in for SPX or the OGraf DevTool themselves;
 * PHASE9.md's accept criterion names both, and they are run by hand.
 */

const PROJECT = 'demo-1iixd';
const LT = 'l3rd-name-2a94g';
const GRAPHIC = `${PROJECT}~${LT}`;
/**
 * The renderer's own page, served by a little HTTP server of the test's own on
 * another port — another origin, as an SPX renderer is to Breeze. A real
 * loopback server rather than `page.route`: a routed page has no address, so
 * Chromium's Local Network Access rules treat it as public and refuse it the
 * module on 127.0.0.1, which is not the situation under test — a renderer and
 * Breeze share a LAN.
 */
let renderer: http.Server;
let rendererUrl = '';

test.beforeAll(async ({ baseURL }) => {
  const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent}</style></head>
<body><div id="layer" style="position:relative;width:1920px;height:1080px"></div>
<script type="module">
  const { default: Graphic } = await import(${JSON.stringify(`${baseURL}/ograf/package/${encodeURIComponent(GRAPHIC)}/graphic.mjs`)});
  customElements.define('breeze-pointer', Graphic);
  window.graphic = document.createElement('breeze-pointer');
  document.getElementById('layer').appendChild(window.graphic);
  window.imported = true;
</script></body></html>`;
  renderer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise<void>((resolve) => renderer.listen(0, '127.0.0.1', resolve));
  rendererUrl = `http://127.0.0.1:${(renderer.address() as AddressInfo).port}/`;
});

test.afterAll(async () => {
  await new Promise((resolve) => renderer.close(resolve));
});

/** Open the renderer page and wait for the pointer graphic's module to load. */
async function rendererPage(page: Page, server: string): Promise<void> {
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[renderer] ${m.text()}`);
  });
  await page.goto(rendererUrl);
  expect(new URL(page.url()).origin).not.toBe(new URL(server).origin);
  await page.waitForFunction(() => (window as { imported?: boolean }).imported === true, undefined, { timeout: 10_000 });
}

type G = { graphic: Record<string, (p?: unknown) => Promise<Record<string, unknown>>> };

test.describe('D2: the pointer package in a renderer on another origin', () => {
  test('loads, plays to the hold with the name it was given, updates, and steps out', async ({ page, baseURL }) => {
    await rendererPage(page, baseURL!);

    const loaded = await page.evaluate(() =>
      (window as unknown as G).graphic.load!({ data: { name: 'Jane Doe' }, renderType: 'realtime', renderCharacteristics: {} }),
    );
    expect(loaded).toEqual({ statusCode: 200 });

    const frame = page.frameLocator('breeze-pointer iframe');
    // The page in the frame is this server's own output page, in OGraf mode.
    await expect(page.locator('breeze-pointer iframe')).toHaveAttribute('src', new RegExp(`/play/${PROJECT}/${LT}\\?hub=data&ograf=1`));

    const played = await page.evaluate(() => (window as unknown as G).graphic.playAction!({}));
    expect(played).toEqual({ statusCode: 200, currentStep: 0 });
    const name = frame.locator('[data-layer-id="name"] .bz-text-inner');
    await expect(name).toHaveText(/jane doe/i);

    expect(await page.evaluate(() => (window as unknown as G).graphic.updateAction!({ data: { name: 'Ann Poe' } }))).toEqual({
      statusCode: 200,
    });
    await expect(name).toHaveText(/ann poe/i);

    // Past the last step is the end: the outro runs and the promise waits for it.
    expect(await page.evaluate(() => (window as unknown as G).graphic.playAction!({ delta: 1 }))).toEqual({ statusCode: 200 });

    expect(await page.evaluate(() => (window as unknown as G).graphic.dispose!({}))).toEqual({ statusCode: 200 });
    await expect(page.locator('breeze-pointer iframe')).toHaveCount(0);
  });

  test('cuts on skipAnimation, both ways', async ({ page, baseURL }) => {
    await rendererPage(page, baseURL!);
    await page.evaluate(() => (window as unknown as G).graphic.load!({ data: {}, renderType: 'realtime', renderCharacteristics: {} }));
    // The frame is see-through: no backdrop painted behind a cross-origin page.
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: 8, height: 8 } });
    const alpha = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return Math.max(...Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data).filter((_, i) => i % 4 === 3));
    }, png.toString('base64'));
    expect(alpha).toBe(0);
    const started = Date.now();
    expect(await page.evaluate(() => (window as unknown as G).graphic.playAction!({ skipAnimation: true }))).toEqual({
      statusCode: 200,
      currentStep: 0,
    });
    expect(await page.evaluate(() => (window as unknown as G).graphic.stopAction!({ skipAnimation: true }))).toEqual({ statusCode: 200 });
    // Well under the strap's 1.5 s intro: nothing was animated.
    expect(Date.now() - started).toBeLessThan(1_200);
  });

  test('is not driven by the channel it reads its data from', async ({ page, baseURL, request }) => {
    await rendererPage(page, baseURL!);
    await page.evaluate(() => (window as unknown as G).graphic.load!({ data: {}, renderType: 'realtime', renderCharacteristics: {} }));
    // An operator plays the Breeze copy of the same graphic.
    await request.post(`/api/control/${PROJECT}/${LT}/play`);
    await page.waitForTimeout(500);
    const state = await page
      .frameLocator('breeze-pointer iframe')
      .locator('body')
      .evaluate(() => (window as unknown as { breeze: { runtime: { playbackState: string } } }).breeze.runtime.playbackState);
    expect(state).toBe('idle');
    await request.post(`/api/control/${PROJECT}/${LT}/clear`);
  });

  test('says so when the server cannot be reached', async ({ page, baseURL }) => {
    test.setTimeout(40_000);
    await rendererPage(page, baseURL!);
    const result = await page.evaluate(() =>
      (window as unknown as G).graphic.load!({ data: {}, renderType: 'realtime', renderCharacteristics: {}, v_breezeServer: 'http://127.0.0.1:9' }),
    );
    expect(result).toMatchObject({ statusCode: 504, statusMessage: expect.stringContaining('127.0.0.1:9') });
  });
});

test.describe('D1: an OGraf controller drives a Breeze channel', () => {
  test('load, play, update and stop reach the output, and the control panel shows them', async ({ browser, request }) => {
    const output = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await output.goto(`/play/${PROJECT}/${LT}`);
    await output.waitForFunction(() => Boolean((window as { breeze?: unknown }).breeze));
    const panel = await browser.newPage();
    await panel.goto(`/control/${PROJECT}/${LT}`);
    await expect(panel.locator('#playback')).toHaveText('idle');

    const base = `/ograf/v1/renderers/${PROJECT}/target/graphicInstance`;
    const renderTarget = { channel: LT };
    const load = await request.post(`${base}/load`, { data: { renderTarget, graphicId: GRAPHIC, params: { data: { name: 'Mary Major' } } } });
    expect(await load.json()).toMatchObject({ graphicInstanceId: LT, statusCode: 200 });

    const play = await request.post(`${base}/playAction`, { data: { renderTarget, graphicInstanceId: LT, params: {} } });
    // Answered once the output reported the hold — so the step is what is on air.
    expect(await play.json()).toMatchObject({ statusCode: 200, currentStep: 0, v_delivered: 1 });
    expect(await output.evaluate(() => (window as any).breeze.runtime.playbackState)).toBe('holding');
    await expect(output.locator('[data-layer-id="name"] .bz-text-inner')).toHaveText(/mary major/i);
    await expect(panel.locator('#playback')).toHaveText('holding');

    await request.post(`${base}/updateAction`, { data: { renderTarget, graphicInstanceId: LT, params: { data: { name: 'Kim Lee' } } } });
    await expect(output.locator('[data-layer-id="name"] .bz-text-inner')).toHaveText(/kim lee/i);

    const stop = await request.post(`${base}/stopAction`, { data: { renderTarget, graphicInstanceId: LT, params: {} } });
    expect(stop.status()).toBe(200);
    expect(await output.evaluate(() => (window as any).breeze.runtime.playbackState)).toBe('finished');
    await expect(panel.locator('#playback')).toHaveText('finished');

    await request.post(`/api/control/${PROJECT}/${LT}/clear`);
    await output.close();
    await panel.close();
  });

  test('a graphic loaded onto an output is mounted there and played by step', async ({ browser, request }) => {
    const out = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await out.goto(`/out/${PROJECT}/ograf-e2e`);
    await out.waitForFunction(() => Boolean((window as { breezeOutput?: unknown }).breezeOutput));

    const base = `/ograf/v1/renderers/${PROJECT}/target/graphicInstance`;
    const renderTarget = { channel: '@ograf-e2e' };
    const load = await request.post(`${base}/load`, { data: { renderTarget, graphicId: GRAPHIC, params: { data: { name: 'Pat Doe' } } } });
    const { graphicInstanceId } = await load.json();
    expect(graphicInstanceId).toBe(`@ograf-e2e~${LT}`);
    await out.waitForFunction((lt) => (window as any).breezeOutput.mounted().includes(lt), LT);
    // Mounted, not played.
    expect(await out.evaluate((lt) => (window as any).breezeOutput.get(lt).playbackState, LT)).toBe('idle');

    await request.post(`${base}/playAction`, { data: { renderTarget, graphicInstanceId, params: { skipAnimation: true } } });
    await out.waitForFunction((lt) => (window as any).breezeOutput.get(lt).playbackState === 'holding', LT);
    await expect(out.locator(`[data-breeze-channel="@ograf-e2e~${LT}"] [data-layer-id="name"] .bz-text-inner`)).toHaveText(/pat doe/i);

    const cleared = await request.put(`${base}/clear`, { data: { filters: [{ renderTarget }] } });
    expect((await cleared.json()).graphicInstances).toHaveLength(1);
    await out.waitForFunction((lt) => !(window as any).breezeOutput.mounted().includes(lt), LT);
    await out.close();
  });
});
