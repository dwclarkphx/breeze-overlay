// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The on-stage bezier surface (D′, MASKS.md §5.1).
 *
 * Written to the four rules the stage's earlier drag defects left behind:
 * every press is hit-tested before it is made, so a drag cannot pass by
 * landing on something else; every gesture is asserted mid-flight, not only at
 * the end; the return leg of a drag is driven back onto the start; and each
 * test owns the project it writes to, so nothing here can leak into the demo
 * that other specs assert on exactly.
 */

let owned: string | null = null;

test.afterEach(async ({ page }) => {
  if (!owned) return;
  await page.request.delete(`/api/projects/${owned}`);
  owned = null;
});

const SHAPE_KIND = '.properties-panel select:has(option[value="ellipse"]):not(:has(option[value="none"]))';
const MASK_TYPE = '.properties-panel select:has(option[value="image"]):has(option[value="none"])';
const anchors = (page: Page) => page.locator('.path-handles .path-anchor');

/** A scratch project with one path shape — the seed triangle — selected. */
async function pathLayer(page: Page): Promise<void> {
  const id = `path-e2e-${Date.now()}`;
  const created = await page.request.post('/api/projects', { data: { name: 'Path handles e2e', id } });
  expect(created.status()).toBe(201);
  owned = id;

  await page.goto('/editor/');
  await expect(page.locator('.app-bar select').first()).toHaveValue(id);
  await page.locator('.add-layer').selectOption('shape');
  await page.locator(SHAPE_KIND).selectOption('path');
  await expect(anchors(page)).toHaveCount(3);
  /*
   * The anchors are drawn from the document, at once; the preview is rebuilt
   * from it 60 ms later (StageViewport's debounce). Until then the selected
   * layer is still the old rect, and the rebuild detaches it from under any
   * measurement — `boundingBox()` then answers null (2026-10-26, Windows run).
   * The rebuilt layer is the one with a path in it.
   */
  await expect(page.locator('.stage-host [data-selected="1"] path')).toBeAttached();
}

/**
 * A layer's box once the preview has stopped rebuilding it: two reads a frame
 * apart that agree. A rebuild replaces the element, so a single read can land
 * on one that is about to be detached.
 */
async function settledBox(loc: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let last: { x: number; y: number; width: number; height: number } | null = null;
  await expect
    .poll(async () => {
      const box = await loc.boundingBox();
      const same = box !== null && last !== null && ['x', 'y', 'width', 'height'].every(
        (k) => Math.abs(box[k as 'x'] - last![k as 'x']) < 0.5,
      );
      last = box;
      return same;
    }, { intervals: [50] })
    .toBe(true);
  return last!;
}

/**
 * The centre of `loc` on screen, after checking that a press there would land
 * on `loc` itself. `toBeVisible` says nothing about what is drawn on top, and
 * a press that lands on Moveable's box instead passes a drag test by doing
 * nothing at all.
 */
async function aim(page: Page, loc: Locator): Promise<{ x: number; y: number }> {
  const box = (await loc.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const same = await loc.evaluate(
    (el, p) => document.elementFromPoint(p.x, p.y) === el,
    at,
  );
  expect(same, 'the press would land on something drawn over the target').toBe(true);
  return at;
}

async function centreOf(loc: Locator): Promise<{ x: number; y: number }> {
  const box = (await loc.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const shapeData = (page: Page) => page.locator('.properties-panel textarea.path-data').first().inputValue();
const stageZoom = (page: Page) =>
  page.$eval('.stage-transform', (el) => new DOMMatrix(getComputedStyle(el).transform).a);

test('anchors sit on the layer they belong to, rotated or not', async ({ page }) => {
  await pathLayer(page);

  /*
   * Checked against the layer's own bounding box rather than against the
   * mapping the overlay uses — the seed triangle's anchors are three corners
   * of that box, so this holds whatever `getScreenCTM` does or does not include.
   */
  const layer = page.locator('.stage-host [data-selected="1"]');
  const near = (p: { x: number; y: number }, x: number, y: number) => {
    expect(Math.abs(p.x - x), `x ${p.x} vs ${x}`).toBeLessThan(1.5);
    expect(Math.abs(p.y - y), `y ${p.y} vs ${y}`).toBeLessThan(1.5);
  };

  let box = await settledBox(layer);
  near(await centreOf(anchors(page).nth(0)), box.x, box.y + box.height);
  near(await centreOf(anchors(page).nth(1)), box.x + box.width / 2, box.y);
  near(await centreOf(anchors(page).nth(2)), box.x + box.width, box.y + box.height);

  // A quarter turn clockwise: the bottom-left corner swings round to the top-left.
  const rotation = page
    .locator('.properties-panel .prop-field')
    .filter({ has: page.locator('.prop-label', { hasText: /^Rotation$/ }) })
    .locator('input')
    .first();
  await rotation.fill('90');
  await rotation.press('Tab');
  await expect.poll(async () => (await layer.boundingBox())?.height ?? 0).toBeGreaterThan(box.height + 1);
  box = await settledBox(layer);
  near(await centreOf(anchors(page).nth(0)), box.x, box.y);
  near(await centreOf(anchors(page).nth(2)), box.x, box.y + box.height);
});

test('dragging an anchor moves it live, comes back on the return leg, and undoes in one step', async ({ page }) => {
  await pathLayer(page);
  const before = await shapeData(page);
  const zoom = await stageZoom(page);
  const top = anchors(page).nth(1);

  const start = await aim(page, top);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 20, start.y + 15, { steps: 4 });

  // Mid-gesture: the anchor has followed the pointer and the document says so.
  await expect(page.locator('.path-handles')).toHaveAttribute('data-dragging', '1');
  const mid = await centreOf(top);
  expect(Math.abs(mid.x - (start.x + 20))).toBeLessThan(1.5);
  expect(await shapeData(page)).not.toBe(before);

  // The return leg: back onto the start must land exactly on the start.
  await page.mouse.move(start.x, start.y, { steps: 4 });
  expect(await shapeData(page)).toBe(before);

  await page.mouse.move(start.x + 40, start.y + 30, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.path-handles')).not.toHaveAttribute('data-dragging', '1');

  // The seed triangle's apex is (width/2, 0); 40×30 screen px is 40/zoom × 30/zoom layer px.
  const apex = /L ([\d.-]+) ([\d.-]+)/.exec(await shapeData(page))!;
  const [bx, by] = /L ([\d.-]+) ([\d.-]+)/.exec(before)!.slice(1).map(Number) as [number, number];
  expect(Number(apex[1])).toBeCloseTo(bx + 40 / zoom, 0);
  expect(Number(apex[2])).toBeCloseTo(by + 30 / zoom, 0);

  await page.keyboard.press('Control+z');
  expect(await shapeData(page)).toBe(before);
});

test('double-click makes a curve, and its handle bends without moving the anchor', async ({ page }) => {
  await pathLayer(page);
  const top = anchors(page).nth(1);
  await top.dblclick();
  await expect(top).toHaveAttribute('data-smooth', '1');
  await expect(page.locator('.path-handles .path-handle')).toHaveCount(2);

  const anchorAt = await centreOf(top);
  const handle = page.locator('.path-handles .path-handle[data-part="out"]');
  const start = await aim(page, handle);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 25, { steps: 4 });

  // Mid-gesture: the handle moved, its anchor did not.
  expect((await centreOf(handle)).y).toBeGreaterThan(start.y + 20);
  const still = await centreOf(top);
  expect(Math.abs(still.x - anchorAt.x)).toBeLessThan(0.5);
  expect(Math.abs(still.y - anchorAt.y)).toBeLessThan(0.5);
  await page.mouse.up();

  await top.dblclick();
  await expect(top).not.toHaveAttribute('data-smooth', '1');
  await expect(page.locator('.path-handles .path-handle')).toHaveCount(0);
});

test('double-click on a straight segment adds a point; Alt-click removes one', async ({ page }) => {
  await pathLayer(page);
  const segment = page.locator('.path-handles .path-segment[data-after="0"]');
  const at = await aim(page, segment);
  await page.mouse.dblclick(at.x, at.y);
  await expect(anchors(page)).toHaveCount(4);

  const added = await aim(page, anchors(page).nth(1));
  await page.keyboard.down('Alt');
  await page.mouse.click(added.x, added.y);
  await page.keyboard.up('Alt');
  await expect(anchors(page)).toHaveCount(3);
});

test('the layer body still moves the whole layer — the overlay only owns its own marks', async ({ page }) => {
  await pathLayer(page);
  const layer = page.locator('.stage-host [data-selected="1"]');
  const box = await settledBox(layer);
  // Inside the triangle, away from every anchor and edge.
  const at = { x: box.x + box.width / 2, y: box.y + box.height * 0.7 };
  const target = await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.className.toString() ?? '', at);
  expect(target).toContain('moveable-area');

  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 60, at.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await layer.boundingBox())?.x ?? -Infinity).toBeGreaterThan(box.x + 50);
});

test('a locked layer offers no handles, and says why', async ({ page }) => {
  await pathLayer(page);
  await page.locator('.layer-row.selected .layer-icon-btn[title="Lock"]').click();
  await expect(anchors(page)).toHaveCount(0);
  await expect(page.locator('.selection-hint[data-state="locked"]')).toBeVisible();

  await page.locator('.layer-row.selected .layer-icon-btn[title="Unlock"]').click();
  await expect(anchors(page)).toHaveCount(3);
  await expect(page.locator('.selection-hint[data-state="locked"]')).toHaveCount(0);
});

test('a path mask is edited in place, offset and all, and the toolbar picks between mask and shape', async ({ page }) => {
  await pathLayer(page);
  await page.locator(MASK_TYPE).selectOption('path');

  // Both a path shape and a path mask: the toolbar chooses, shape first.
  const kinds = page.locator('.stage-toolbar .path-kind button');
  await expect(kinds).toHaveCount(2);
  await expect(page.locator('.path-handles')).toHaveAttribute('data-kind', 'shape');
  await kinds.nth(1).click();
  await expect(page.locator('.path-handles')).toHaveAttribute('data-kind', 'mask');

  const maskData = () => page.locator('.properties-panel textarea.path-data').last().inputValue();
  const before = await maskData();
  const start = await aim(page, anchors(page).nth(0));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 15, start.y - 10, { steps: 4 });
  expect(await maskData()).not.toBe(before);
  // The shape's own geometry is untouched by a mask drag.
  expect(await shapeData(page)).toMatch(/^M 0 /);
  await page.mouse.up();
});
