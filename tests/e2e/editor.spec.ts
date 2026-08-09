// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { expect, test, type Page } from '@playwright/test';

/**
 * Editor smoke tests — Phase 2 + 3 acceptance.
 *
 * These drive the real UI against the real server and the real runtime. The
 * point is not pixel comparison but that the loop closes: an edit changes the
 * document, the document rebuilds the preview, and undo puts it back.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/editor/');
  // The layers panel only renders once a project has loaded over the API.
  await expect(page.locator('.layer-row').first()).toBeVisible({ timeout: 15_000 });
});

async function layerNames(page: Page): Promise<string[]> {
  return page.$$eval('.layer-row .layer-name', (els) => els.map((el) => el.textContent ?? ''));
}

test('loads the demo project and lists its layers top-of-stack first', async ({ page }) => {
  const names = await layerNames(page);
  // Authored order is bar, accent, name, badge, title — panels show the
  // topmost paint layer first, so the list is reversed.
  expect(names[0]).toBe('Title');
  expect(names).toContain('Bar');
});

test('mounts the real runtime as the preview', async ({ page }) => {
  // Same DOM contract the output page produces — proof it is not a mock.
  await expect(page.locator('.stage-host [data-layer-id="bar"]')).toBeAttached();
  await expect(page.locator('.stage-host [data-layer-id="badge/chip"]')).toBeAttached();
});

test('selecting a layer shows its properties', async ({ page }) => {
  await page.locator('.layer-row', { hasText: 'Name' }).first().click();
  await expect(page.locator('.properties-panel .panel-header')).toContainText('Name');
  await expect(page.locator('.prop-section', { hasText: 'Text' })).toBeVisible();
});

test('editing a property updates the document and marks it dirty', async ({ page }) => {
  await page.locator('.layer-row', { hasText: 'Bar' }).first().click();

  const opacity = page.locator('.prop-field', { hasText: 'Opacity' }).locator('input');
  await opacity.fill('0.5');
  await opacity.blur();

  await expect(page.locator('.dirty-dot')).toBeVisible();
});

test('undo reverts an edit and redo reapplies it', async ({ page }) => {
  await page.locator('.layer-row', { hasText: 'Bar' }).first().click();

  const radius = page.locator('.prop-field', { hasText: 'Radius' }).locator('input');
  const original = await radius.inputValue();
  await radius.fill('20');
  await radius.blur();
  await expect(radius).toHaveValue('20');

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(radius).toHaveValue(original);

  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(radius).toHaveValue('20');
});

test('adding a layer puts it on the stage and in the timeline', async ({ page }) => {
  const before = (await layerNames(page)).length;

  await page.locator('select.add-layer').selectOption('shape');

  await expect(page.locator('.layer-row .layer-name')).toHaveCount(before + 1);
  // A new layer is selected, so the stage shows transform handles for it.
  // The preview rebuild is debounced, so this only passes if the viewport
  // re-derives its target once the new runtime exists.
  await expect(page.locator('.moveable-control-box')).toBeAttached();
});

test('transform handles survive an edit rather than pointing at a dead node', async ({ page }) => {
  // Regression: the Moveable target was derived from the runtime with no
  // signal for when the runtime was rebuilt, so after an edit the handles
  // referenced a DOM node the rebuild had already destroyed.
  await page.locator('.layer-row', { hasText: 'Bar' }).first().click();
  await expect(page.locator('.moveable-control-box')).toBeAttached();

  const radius = page.locator('.prop-field', { hasText: 'Radius' }).locator('input');
  await radius.fill('12');
  await radius.blur();

  await expect(page.locator('.moveable-control-box')).toBeAttached();

  // And it must be attached to the *live* element, not an orphan.
  const targetIsLive = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.stage-host [data-layer-id="bar"]');
    return Boolean(el && el.isConnected);
  });
  expect(targetIsLive).toBe(true);
});

test.describe('selection is discoverable', () => {
  /**
   * The demo's accent bar is 14px wide — about 6px on screen at default zoom —
   * and sits directly on top of the 900px main bar. Moveable's handles alone
   * collapse into an invisible sliver there, which reads as "this layer cannot
   * be selected".
   */
  const selected = (page: Page, layerId: string) =>
    page.locator(`.stage-host [data-layer-id="${layerId}"][data-selected="1"]`);

  test('marks a thin layer as selected so it can be outlined', async ({ page }) => {
    await page.locator('.layer-row', { hasText: 'Accent' }).first().click();
    await expect(selected(page, 'accent')).toHaveCount(1);
  });

  test('draws a visible outline, sized independently of stage zoom', async ({ page }) => {
    await page.locator('.layer-row', { hasText: 'Accent' }).first().click();

    /**
     * Read through a locator, not `page.evaluate` + `querySelector`.
     *
     * The bare version raced the re-render: if the selection had not painted
     * yet the query returned null and `getComputedStyle` threw. React 19
     * batches the state update more aggressively than 18 did, so the window was
     * wide enough to fail intermittently. `locator.evaluate` auto-waits for the
     * element instead of asserting it is already there.
     */
    const outline = page.locator('.stage-host [data-selected="1"]').first();

    const read = () =>
      outline.evaluate((el) => ({
        width: parseFloat(getComputedStyle(el).outlineWidth),
        style: getComputedStyle(el).outlineStyle,
      }));

    const atDefaultZoom = await read();
    expect(atDefaultZoom.style).toBe('solid');
    expect(atDefaultZoom.width).toBeGreaterThan(0);

    // Zooming in must shrink the stage-space width, keeping it constant on
    // screen — otherwise the outline is hairline at low zoom and fat at high.
    await page.locator('.stage-toolbar button[title="Zoom in"]').click();
    const zoomedIn = await read();
    expect(zoomedIn.width).toBeLessThan(atDefaultZoom.width);
  });

  test('marks every layer type, not just wide ones', async ({ page }) => {
    for (const [label, id] of [['Bar', 'bar'], ['Name', 'name'], ['Accent', 'accent']] as const) {
      await page.locator('.layer-row', { hasText: label }).first().click();
      await expect(selected(page, id)).toHaveCount(1);
    }
  });

  test('clears the mark from the previously selected layer', async ({ page }) => {
    await page.locator('.layer-row', { hasText: 'Accent' }).first().click();
    await expect(selected(page, 'accent')).toHaveCount(1);

    await page.locator('.layer-row', { hasText: 'Name' }).first().click();

    await expect(selected(page, 'accent')).toHaveCount(0);
    await expect(selected(page, 'name')).toHaveCount(1);
  });

  test('says so when the selected layer is off-stage at the playhead', async ({ page }) => {
    // The page loads with the playhead at 0, where the accent sits at
    // x=-960 — entirely off the left of the stage.
    await page.locator('.layer-row', { hasText: 'Accent' }).first().click();

    await expect(page.locator('.selection-hint')).toContainText('off-stage');
  });

  test('drops the hint once the layer animates on stage', async ({ page }) => {
    await page.locator('.layer-row', { hasText: 'Accent' }).first().click();
    await expect(page.locator('.selection-hint')).toBeVisible();

    /*
     * The accent is only on stage between roughly 0.68s and 1.5s — it slides
     * in, holds at the STOP marker, then leaves again. Scrubbing to a fraction
     * of the ruler width lands wherever the current zoom happens to put it; at
     * the default 240px/s, 55% of the track was ~2.06s, which is *after* the
     * outro, so the hint correctly stayed up and the test was wrong.
     *
     * Pin it to a real time instead, and assert we landed in the window before
     * asserting on the hint, so a future zoom-default change fails loudly here
     * rather than confusingly below.
     */
    const ruler = page.locator('.timeline-ruler');
    const box = (await ruler.boundingBox())!;
    const PX_PER_SECOND = 240;
    await page.mouse.click(box.x + PX_PER_SECOND * 1.0, box.y + 10);

    await expect(page.locator('.timecode')).toHaveText(/^00:0[01]:/);

    await expect(page.locator('.selection-hint')).toHaveCount(0);
  });

  test('brings the hint back when the layer leaves again in the outro', async ({ page }) => {
    // The accent exits from 1.5s, so by ~2.1s it is off-stage once more. The
    // hint has to track the playhead, not latch on first evaluation.
    await page.locator('.layer-row', { hasText: 'Accent' }).first().click();

    const ruler = page.locator('.timeline-ruler');
    const box = (await ruler.boundingBox())!;
    await page.mouse.click(box.x + 240 * 1.0, box.y + 10);
    await expect(page.locator('.selection-hint')).toHaveCount(0);

    await page.mouse.click(box.x + 240 * 2.2, box.y + 10);
    await expect(page.locator('.selection-hint')).toContainText('off-stage');
  });

  test('says so when the selected layer is outside its in/out window', async ({ page }) => {
    // The badge sub-composition has in: 0.3, so at t=0 it is not rendered.
    await page.locator('.layer-row', { hasText: 'Live badge' }).first().click();
    await expect(page.locator('.selection-hint')).toContainText('not shown');
  });
});

test.describe('dragging on the stage', () => {
  const layerX = (page: Page, id: string) =>
    page.evaluate((layerId) => {
      const el = document.querySelector<HTMLElement>(`.stage-host [data-layer-id="${layerId}"]`)!;
      return new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
    }, id);

  /**
   * Drag the selected layer by a screen-space delta.
   *
   * Aims at the layer element on the stage, not `.moveable-control-box` — that
   * has a zero-size bounding box with its handles positioned by transform, so
   * its "center" is the element's origin corner, i.e. a resize handle. Earlier
   * runs were performing resizes and reporting them as failed drags.
   */
  async function dragBy(page: Page, dx: number, dy: number) {
    // `.moveable-area` is the overlay spanning the selection bounds. Not
    // `.moveable-control-box` (zero-size, so its center is a corner handle),
    // and not the layer element itself (another layer may cover the point).
    const area = page.locator('.moveable-area').first();
    await expect(area).toBeVisible();
    const box = (await area.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    /*
     * Check what is actually under the point before pressing it.
     *
     * `toBeVisible` and `boundingBox` both describe the overlay in isolation and
     * say nothing about whether it is where the layer is, or even over the stage.
     * When the handles went stale this helper pressed x=20 — inside the layers
     * panel — and the only symptom was a property that failed to change, which
     * reads like a dozen unrelated bugs. Naming what was hit turns a silent miss
     * into the diagnosis.
     */
    const hit = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return {
          onOverlay: Boolean(el?.closest('.moveable-control-box, .moveable-area')),
          hit: el ? `${el.tagName.toLowerCase()}.${String(el.getAttribute('class') ?? '')}` : 'nothing',
        };
      },
      { x: cx, y: cy },
    );
    expect(hit, `press at ${Math.round(cx)},${Math.round(cy)} missed the drag overlay`)
      .toMatchObject({ onOverlay: true });

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    // Several moves: a single jump can be treated as a click rather than a drag.
    await page.mouse.move(cx + dx / 2, cy + dy / 2, { steps: 5 });
    await page.mouse.move(cx + dx, cy + dy, { steps: 5 });
    await page.mouse.up();
  }

  test('moves a layer that has no keyframes', async ({ page }) => {
    await page.locator('select.add-layer').selectOption('text');
    await expect(page.locator('.moveable-control-box')).toBeAttached();

    const before = await page.locator('.prop-field', { hasText: 'X' }).first().locator('input').inputValue();
    await dragBy(page, 120, 0);

    const after = await page.locator('.prop-field', { hasText: 'X' }).first().locator('input').inputValue();
    expect(Number(after)).toBeGreaterThan(Number(before));
  });

  test('moves the layer by the distance dragged, in stage pixels', async ({ page }) => {
    /*
     * The root cause, finally measured rather than guessed at: Moveable's
     * `beforeTranslate` is the new ABSOLUTE translate in the element's own
     * coordinates, not a screen-space delta. The old code added the starting
     * position again and divided by the stage zoom, so a layer at x=660 nudged
     * a few pixels at 45% zoom jumped to 660 + 660/0.45 = 2126.
     *
     * Asserting the actual expected distance, rather than a loose upper bound,
     * is what distinguishes "works" from "less broken than before" — an earlier
     * version of this test only required the movement be under 2000px, and
     * passed 2059 through as a near miss.
     */
    await page.locator('select.add-layer').selectOption('text');
    await expect(page.locator('.moveable-control-box')).toBeAttached();

    const zoom = Number((await page.locator('.zoom-readout').textContent())!.replace('%', '')) / 100;
    expect(zoom).toBeGreaterThan(0);

    const xField = page.locator('.prop-field', { hasText: 'X' }).first().locator('input');
    const before = Number(await xField.inputValue());

    const SCREEN_PX = 120;
    await dragBy(page, SCREEN_PX, 0);

    const moved = Number(await xField.inputValue()) - before;
    const expected = SCREEN_PX / zoom;

    // Generous tolerance for pointer rounding, tight enough to catch a
    // doubling — never mind a ×7 or a ×2000.
    expect(moved).toBeGreaterThan(expected * 0.7);
    expect(moved).toBeLessThan(expected * 1.4);
  });

  test('a layer can be dragged again without being reselected', async ({ page }) => {
    /*
     * Reported: drag a layer once and it will not drag again until you deselect
     * it and select it back. Reproduced on Title, Name and Bar alike.
     *
     * Ending a gesture rebuilds the runtime, which destroys and recreates every
     * layer node. Moveable was handed the new element through `target`, and its
     * control box moved to the right place — but the `dragArea` overlay, the
     * surface you actually grab, was left sized 0×0. `updateRect()` repositions
     * that overlay, it does not resize it.
     *
     * The press then fell through to the nw resize handle sitting at that point.
     * That is why this needs asserting carefully: the old behavior still
     * changed x, because resizing from the north-west corner moves the origin.
     * "The layer moved" is therefore not evidence of anything. What separates a
     * move from a resize is the *width*, and what separates a live drag surface
     * from a collapsed one is what is under the press.
     */
    await page.locator('.layer-row', { hasText: 'Name' }).first().click();
    await expect(page.locator('.moveable-control-box')).toBeAttached();

    const area = page.locator('.moveable-area').first();
    const layer = page.locator('.stage-host [data-layer-id="name"]');

    const start = (await area.boundingBox())!;
    const widthBefore = (await layer.boundingBox())!.width;
    expect(start.width).toBeGreaterThan(0);

    await dragBy(page, 120, 0);

    /*
     * Wait for the debounced rebuild — the thing that used to break the overlay
     * — rather than sleeping past it and hoping.
     *
     * The box is read defensively because the rebuild destroys and recreates
     * every layer node, so both the layer and the overlay are legitimately
     * absent for a frame. A bare `(await …)!` throws there and the poll never
     * gets its retry.
     */
    const boxOf = async (l: typeof area) => (await l.boundingBox()) ?? null;

    await expect
      .poll(async () => Math.round((await boxOf(area))?.x ?? -1), { timeout: 5000 })
      .toBeGreaterThan(Math.round(start.x) + 50);

    const afterFirst = (await area.boundingBox())!;
    expect(afterFirst.width, 'the drag surface collapsed after the rebuild').toBeCloseTo(
      start.width,
      0,
    );

    // What is actually under the point a second drag would press.
    const under = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return el ? `${el.tagName.toLowerCase()}.${String(el.getAttribute('class') ?? '')}` : 'nothing';
      },
      { x: afterFirst.x + afterFirst.width / 2, y: afterFirst.y + afterFirst.height / 2 },
    );
    expect(under, 'the press would land on a resize handle, not the drag surface').toContain(
      'moveable-area',
    );

    // And the second drag really is a move: same width, further right.
    const xField = page.locator('.prop-field', { hasText: 'X' }).first().locator('input');
    const xBefore = Number(await xField.inputValue());
    await dragBy(page, 120, 0);

    expect(Number(await xField.inputValue())).toBeGreaterThan(xBefore + 50);
    await expect
      .poll(async () => {
        const b = await boxOf(layer);
        return b ? Math.round(b.width) : null;
      }, { timeout: 5000 })
      .toBe(Math.round(widthBefore));
  });

  test('the handles follow the layer when the playhead moves', async ({ page }) => {
    /*
     * Moveable measures its target once and caches the rect, and everything that
     * moves a layer on screen here happens outside its knowledge: a seek
     * repositions it through GSAP, a rebuild replaces the node, a zoom changes
     * the ancestor transform. So the handles stayed where the layer was when it
     * was selected.
     *
     * Bar is the sharpest case in the demo. Selected at t=0 it is at x=-960 and
     * mostly off-stage left; at 0.97s it is at x=120 and on stage. The overlay
     * you have to grab was 1080 stage px from the layer you can see.
     *
     * This went unnoticed because at the old fixed 45% zoom the stale overlay
     * still fell inside the canvas, so a drag aimed at its center worked by luck.
     * Fitting the stage to its viewport moved it into the layers panel and the
     * press stopped reaching the stage at all — the fit did not break the drag,
     * it removed the coincidence that was hiding this.
     */
    await page.locator('.layer-row', { hasText: 'Bar' }).first().click();

    const rulerBox = (await page.locator('.timeline-ruler').boundingBox())!;
    await page.mouse.click(rulerBox.x + 240 * 1.0, rulerBox.y + 10);
    await expect(page.locator('.timecode')).not.toHaveText('00:00:00');

    const offset = await page.evaluate(() => {
      const layer = document.querySelector<HTMLElement>('.stage-host [data-layer-id="bar"]');
      const area = document.querySelector<HTMLElement>('.moveable-area');
      if (!layer || !area) return null;
      const l = layer.getBoundingClientRect();
      const a = area.getBoundingClientRect();
      return {
        dx: Math.round(a.left + a.width / 2 - (l.left + l.width / 2)),
        dy: Math.round(a.top + a.height / 2 - (l.top + l.height / 2)),
      };
    });

    expect(offset).not.toBeNull();
    /*
     * A couple of pixels of rounding is fine; a stale rect is out by hundreds.
     * Reported as a pass/fail pair carrying the measured offset, so the failure
     * message says *how far* the handles are from the layer rather than just
     * that a number was too big.
     */
    expect({
      alignedX: Math.abs(offset!.dx) <= 2,
      alignedY: Math.abs(offset!.dy) <= 2,
      offset,
    }).toEqual({ alignedX: true, alignedY: true, offset });
  });

  test('dragging an animated layer writes a keyframe instead of doing nothing', async ({ page }) => {
    /*
     * Regression: dragging wrote transform.x, which the planner ignores once a
     * keyframe track exists — so dragging bar, accent, name or title in the
     * demo silently had no effect at all.
     */
    await page.locator('.layer-row', { hasText: 'Bar' }).first().click();

    // Park the playhead somewhere with no existing keyframe. Bar has keys at
    // 0, 0.6, 1.5 and 2.1 — landing on one of those would overwrite rather
    // than add, and the count would not change for a completely different
    // reason. Assert we actually moved before drawing conclusions.
    const ruler = page.locator('.timeline-ruler');
    const rulerBox = (await ruler.boundingBox())!;
    await page.mouse.click(rulerBox.x + 240 * 1.0, rulerBox.y + 10);

    const timecode = await page.locator('.timecode').textContent();
    expect(timecode).not.toBe('00:00:00');

    const titles = () =>
      page.$$eval('.keyframe', (els) => els.map((el) => el.getAttribute('title') ?? ''));

    const xField = page.locator('.prop-field', { hasText: 'X' }).first().locator('input');
    const xBefore = await xField.inputValue();
    const before = await titles();

    await dragBy(page, 100, 0);

    /*
     * Check the drag committed at all before drawing conclusions about
     * keyframes. A count that does not move has two very different causes —
     * the gesture never engaged, or it wrote the static baseline instead of a
     * keyframe — and the previous version of this test could not tell them
     * apart.
     */
    expect(await xField.inputValue()).not.toBe(xBefore);

    const after = await titles();
    const added = after.filter((t) => !before.includes(t));
    expect(added.length).toBeGreaterThan(0);
    // And it must be on the x track, at the playhead rather than at t=0.
    expect(added.some((t) => t.startsWith('x =') && !t.includes('@ 0.000s'))).toBe(true);
  });

  test('a whole drag is a single undo step', async ({ page }) => {
    const undoButton = page.getByRole('button', { name: 'Undo' });
    const depth = async () => Number(await undoButton.getAttribute('data-undo-depth'));

    await page.locator('select.add-layer').selectOption('text');
    const xField = page.locator('.prop-field', { hasText: 'X' }).first().locator('input');
    const before = await xField.inputValue();
    const depthBefore = await depth();

    await dragBy(page, 140, 60);
    expect(await xField.inputValue()).not.toBe(before);

    /*
     * Assert the history structure directly. Checking only that one undo
     * restores the old value cannot tell "coalescing broke into N entries"
     * apart from "undo restored the wrong snapshot" — a previous run came back
     * with exactly the post-drag value, which fits the second and not the
     * first, and the test could not say so.
     */
    // Report the entries, not just the count: twenty "Move layer" rows means
    // the coalescing window is being missed, while an interleaved command means
    // adjacency is broken. Different bugs, different fixes.
    const labels = await undoButton.getAttribute('data-undo-labels');
    expect({ depth: await depth(), labels }).toEqual({ depth: depthBefore + 1, labels });

    await undoButton.click();
    expect(await xField.inputValue()).toBe(before);
    expect(await depth()).toBe(depthBefore);
  });
});

test.describe('layer lifetime bars', () => {
  const inField = (page: Page) =>
    page.locator('.prop-field', { hasText: 'In' }).first().locator('input');

  /** Drag a layer's lifetime bar, or one of its trim handles, by screen px. */
  async function dragBar(page: Page, handle: '' | '.trim-in' | '.trim-out', dx: number) {
    const bar = page.locator('.timeline-row.layer-row .lifetime').last();
    // A newly added layer's row sits below the visible timeline panel, and
    // boundingBox() happily returns coordinates for rows that are scrolled out
    // of view — so the drag landed on whatever was actually at those pixels.
    await bar.scrollIntoViewIfNeeded();
    const grip = handle ? bar.locator(handle) : bar;
    const box = (await grip.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx / 2, cy, { steps: 5 });
    await page.mouse.move(cx + dx, cy, { steps: 5 });
    await page.mouse.up();
  }

  /** Add a layer with the playhead parked late, as reported. */
  async function addLateLayer(page: Page) {
    const ruler = page.locator('.timeline-ruler');
    const box = (await ruler.boundingBox())!;
    await page.mouse.click(box.x + 240 * 2.0, box.y + 10);
    await page.locator('select.add-layer').selectOption('text');
  }

  test('a layer added late starts late', async ({ page }) => {
    await addLateLayer(page);
    expect(Number(await inField(page).inputValue())).toBeGreaterThan(1);
  });

  test('dragging its bar left brings a stranded layer back to the start', async ({ page }) => {
    /*
     * The reported trap: a layer added while the playhead sat near the end had
     * a sliver of a bar at the far right, no way to drag it, and no obvious
     * route back short of deleting the layer and starting again.
     */
    await addLateLayer(page);
    expect(Number(await inField(page).inputValue())).toBeGreaterThan(1);

    await dragBar(page, '', -900);

    expect(Number(await inField(page).inputValue())).toBe(0);
  });

  test('the bar stays grabbable however short the lifetime', async ({ page }) => {
    // A sub-pixel bar cannot be dragged, which is what made this unrecoverable.
    await addLateLayer(page);
    const box = (await page.locator('.timeline-row.layer-row .lifetime').last().boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(10);
  });

  test('trimming the left edge moves only the in-point', async ({ page }) => {
    await page.locator('.layer-row', { hasText: 'Title' }).first().click();
    const before = await inField(page).inputValue();

    await dragBar(page, '.trim-in', 60);

    expect(Number(await inField(page).inputValue())).toBeGreaterThan(Number(before));
  });

  test('a whole lifetime drag is one undo step', async ({ page }) => {
    const undoButton = page.getByRole('button', { name: 'Undo' });
    const depth = async () => Number(await undoButton.getAttribute('data-undo-depth'));

    await addLateLayer(page);
    const started = Number(await inField(page).inputValue());
    const depthBefore = await depth();

    await dragBar(page, '', -400);
    expect(Number(await inField(page).inputValue())).toBeLessThan(started);
    // Report the entries, not just the count: twenty "Move layer" rows means
    // the coalescing window is being missed, while an interleaved command means
    // adjacency is broken. Different bugs, different fixes.
    const labels = await undoButton.getAttribute('data-undo-labels');
    expect({ depth: await depth(), labels }).toEqual({ depth: depthBefore + 1, labels });

    await undoButton.click();
    expect(Number(await inField(page).inputValue())).toBeCloseTo(started, 2);
  });

  test('dragging the bar moves the layer without changing its length', async ({ page }) => {
    /*
     * The reported bug: grabbing a lifetime bar and dragging it stretched the
     * layer instead of moving it.
     *
     * A layer is created without an explicit out-point, meaning "runs to the end
     * of the composition" — so moving only the in-point left the right edge
     * pinned to the end and the window changed length on nearly every drag.
     * Measured on the bar itself: the width IS the duration, so a move that
     * changes it is visible here and nowhere else.
     */
    await addLateLayer(page);
    const bar = page.locator('.timeline-row.layer-row .lifetime').last();
    const before = (await bar.boundingBox())!;
    // Guard the measurement: MIN_LIFETIME_PX floors a sliver's width, which
    // would make two different durations compare equal.
    expect(before.width).toBeGreaterThan(40);

    await dragBar(page, '', -200);

    const after = (await bar.boundingBox())!;
    expect(after.x).toBeLessThan(before.x - 150);
    // Within a pixel of rounding, not exactly: the drag snaps to whole frames.
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(2);
  });

  test('dragging out and back in one gesture returns the bar to where it started', async ({ page }) => {
    /*
     * The reported bug: drag a bar away and back without releasing, and the
     * right edge would not return — you had to let go and drag again to get the
     * end back where it was.
     *
     * A layer created without an out-point already ends at the composition end,
     * so the move clamp correctly refuses to shift it right. But the first left
     * move materialises a real out-point, and the guard that skips a zero-delta
     * move was still measuring against the open-ended window the gesture started
     * with — so coming back to the origin dispatched nothing and the bar stayed
     * where the last leftward move had put it.
     *
     * Measured on both edges, because the left one came back on its own and the
     * right one is what the report was about.
     */
    await addLateLayer(page);
    const bar = page.locator('.timeline-row.layer-row .lifetime').last();
    // Same trap as dragBar: an unscrolled row still reports a bounding box, and
    // the drag then lands on whatever is really at those pixels — which makes
    // this test pass by doing nothing at all.
    await bar.scrollIntoViewIfNeeded();

    const before = (await bar.boundingBox())!;
    expect(before.width).toBeGreaterThan(40);

    const cx = before.x + before.width / 2;
    const cy = before.y + before.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 200, cy, { steps: 5 });

    // Prove the gesture is really driving the bar before asserting it comes
    // back, or a drag that silently missed would satisfy the test.
    const moved = (await bar.boundingBox())!;
    expect(moved.x).toBeLessThan(before.x - 150);

    // Back to the grab point, still holding the button — this is the half that
    // used to do nothing.
    await page.mouse.move(cx, cy, { steps: 5 });
    await page.mouse.up();

    const after = (await bar.boundingBox())!;
    const rightBefore = before.x + before.width;
    const rightAfter = after.x + after.width;
    // Within a pixel or two: the drag snaps to whole frames.
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(rightAfter - rightBefore)).toBeLessThanOrEqual(2);
  });

  test('a grab that never moves the layer leaves it open-ended', async ({ page }) => {
    /*
     * The invariant the zero-delta guard exists for, kept honest now that the
     * guard also has to let a return-to-origin through: clicking a bar, or
     * jittering on it by less than a frame, must not quietly convert "runs to
     * the end of the composition" into a concrete out-point.
     */
    await addLateLayer(page);
    const outField = page.locator('.prop-field', { hasText: 'Out' }).first().locator('input');
    expect(await outField.inputValue()).toBe('');

    // Park the selection elsewhere first. The grab re-selects, so selection
    // landing back on the late layer is the proof that the pointer actually hit
    // the bar — without it a drag that missed would satisfy this test by
    // changing nothing, which is precisely what it claims to be checking.
    await page.locator('.layer-row', { hasText: 'Title' }).first().click();

    const row = page.locator('.timeline-row.layer-row').last();
    const bar = row.locator('.lifetime');
    await bar.scrollIntoViewIfNeeded();
    const box = (await bar.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 1, cy);
    await page.mouse.move(cx, cy);
    await page.mouse.up();

    await expect(row).toHaveClass(/selected/);
    expect(await outField.inputValue()).toBe('');
  });

  test('moving an open-ended layer gives it a concrete out-point', async ({ page }) => {
    // The mechanism behind the fix. "Runs to the end" cannot survive a move
    // without stretching, so a move resolves it — and the properties panel is
    // where that has to be visible, or the two views disagree.
    await addLateLayer(page);
    const outField = page.locator('.prop-field', { hasText: 'Out' }).first().locator('input');
    expect(await outField.inputValue()).toBe('');

    await dragBar(page, '', -200);

    const out = Number(await outField.inputValue());
    const inPoint = Number(await inField(page).inputValue());
    expect(out).toBeGreaterThan(inPoint);
  });

  test('the bar always keeps a region that means "move"', async ({ page }) => {
    /*
     * The trim handles used to reach outside the bar, so on a short bar they met
     * in the middle and covered every pixel of it — every grab trimmed an edge.
     * Below MIN_TRIMMABLE_PX the handles are dropped instead.
     */
    await addLateLayer(page);
    const bar = page.locator('.timeline-row.layer-row .lifetime').last();

    const geometry = await bar.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const handles = Array.from(el.querySelectorAll<HTMLElement>('.trim'));
      return {
        width: box.width,
        trimmable: el.dataset['trimmable'],
        // Widest span of the bar not covered by a handle.
        covered: handles.reduce((sum, h) => sum + h.getBoundingClientRect().width, 0),
        outside: handles.some((h) => {
          const b = h.getBoundingClientRect();
          return b.left < box.left - 0.5 || b.right > box.right + 0.5;
        }),
      };
    });

    expect(geometry.outside).toBe(false);
    expect(geometry.width - geometry.covered).toBeGreaterThanOrEqual(10);
    if (geometry.trimmable === '0') expect(geometry.covered).toBe(0);
  });
});

test.describe('every draggable returns to where it started', () => {
  /*
   * 0.41 fixed a lifetime bar that could not come back within a single gesture:
   * the handler measured every move against a frozen start, so it could not tell
   * "this gesture has not moved anything" from "this gesture moved and has
   * returned", and skipped the dispatch on both.
   *
   * Reading the other handlers says they are built differently — the stage,
   * markers, trim handles and easing points all compute an absolute value from
   * the pointer, and the keyframe drag tracks its current position rather than
   * its origin — so none of them should have the same flaw. That is an argument,
   * not evidence. These drive each one out and back and check where it lands.
   *
   * Each test asserts the far end of the gesture actually moved something before
   * asserting the return, because "it ended where it started" is otherwise
   * satisfied by a drag that never happened.
   */

  /** Press at (cx, cy), travel by dx, run `atFarEnd`, come back, release. */
  async function outAndBack(
    page: Page,
    cx: number,
    cy: number,
    dx: number,
    atFarEnd: () => Promise<void>,
  ) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    // Several steps: a single jump can be read as a click rather than a drag.
    await page.mouse.move(cx + dx / 2, cy, { steps: 3 });
    await page.mouse.move(cx + dx, cy, { steps: 3 });
    await atFarEnd();
    await page.mouse.move(cx + dx / 2, cy, { steps: 3 });
    await page.mouse.move(cx, cy, { steps: 3 });
    await page.mouse.up();
  }

  /** Left edge of an element in page coordinates, or null if it has gone. */
  const leftOf = async (page: Page, selector: string): Promise<number> => {
    const box = (await page.locator(selector).first().boundingBox())!;
    return box.x;
  };

  test('a layer dragged across the stage and back keeps its original x', async ({ page }) => {
    await page.locator('select.add-layer').selectOption('text');
    await expect(page.locator('.moveable-control-box')).toBeAttached();

    const xField = page.locator('.prop-field', { hasText: 'X' }).first().locator('input');
    const before = Number(await xField.inputValue());

    const area = page.locator('.moveable-area').first();
    await expect(area).toBeVisible();
    const box = (await area.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Same guard the stage drag tests use: naming what is under the press turns
    // a silent miss into a diagnosis.
    const hit = await page.evaluate(
      ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.moveable-control-box, .moveable-area')),
      { x: cx, y: cy },
    );
    expect(hit, `press at ${Math.round(cx)},${Math.round(cy)} missed the drag overlay`).toBe(true);

    await outAndBack(page, cx, cy, 150, async () => {
      expect(Number(await xField.inputValue())).toBeGreaterThan(before + 50);
    });

    // The stage drag writes absolute values, so this should be exact bar
    // rounding to 2dp.
    expect(Number(await xField.inputValue())).toBeCloseTo(before, 1);
  });

  test('a keyframe follows the pointer for the whole drag, not just the first move', async ({ page }) => {
    /*
     * Found while checking the out-and-back behavior below, and the worse bug
     * of the two: a keyframe's React key is its time, so the first move of a
     * drag unmounted the element holding the pointer capture. Every later move
     * in that gesture went somewhere else, and the keyframe stopped dead after
     * one step — 0.000s to 0.080s and then nothing, however far the pointer
     * went. Capture now lives on the lane, which outlives the remount.
     *
     * Asserted as distance traveled rather than "it moved", because the old
     * behavior did move it — once.
     */
    await page.locator('.layer-row', { hasText: 'Bar' }).first().click();
    const kf = page.locator('.keyframe').first();
    await expect(kf).toBeVisible();

    const before = await leftOf(page, '.keyframe');
    const box = (await kf.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(cx + i * 20, cy);
    await page.mouse.up();

    // 120px asked for; one frame of snapping slack allowed.
    expect(await leftOf(page, '.keyframe')).toBeGreaterThan(before + 110);
  });

  test('a keyframe dragged along its lane and back keeps its original time', async ({ page }) => {
    await page.locator('.layer-row', { hasText: 'Bar' }).first().click();
    const kf = page.locator('.keyframe').first();
    await expect(kf).toBeVisible();
    await kf.scrollIntoViewIfNeeded();

    const before = await leftOf(page, '.keyframe');
    const box = (await kf.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await outAndBack(page, cx, cy, 120, async () => {
      expect(await leftOf(page, '.keyframe')).toBeGreaterThan(before + 60);
    });

    // Snapping is to whole frames, so allow a frame's worth of slack.
    expect(Math.abs((await leftOf(page, '.keyframe')) - before)).toBeLessThanOrEqual(4);
  });

  test('a marker dragged along the lane and back keeps its original time', async ({ page }) => {
    const marker = page.locator('.marker-lane .marker.stop').first();
    await expect(marker).toBeVisible();

    const before = await leftOf(page, '.marker-lane .marker.stop');
    const box = (await marker.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await outAndBack(page, cx, cy, 120, async () => {
      expect(await leftOf(page, '.marker-lane .marker.stop')).toBeGreaterThan(before + 60);
    });

    expect(Math.abs((await leftOf(page, '.marker-lane .marker.stop')) - before)).toBeLessThanOrEqual(4);
  });

  test('a trimmed edge dragged out and back leaves the bar its original width', async ({ page }) => {
    /*
     * Both trim modes go through the same handler as the move that was broken,
     * so they are the closest neighbors to the bug. They differ in that trimIn
     * and trimOut always build a new window rather than ever handing back the
     * one they were given, so the zero-delta skip cannot trigger — which is the
     * thing being confirmed here.
     */
    await page.locator('.layer-row', { hasText: 'Title' }).first().click();
    const bar = page.locator('.timeline-row.layer-row .lifetime').first();
    await bar.scrollIntoViewIfNeeded();

    const before = (await bar.boundingBox())!;
    const handle = bar.locator('.trim-in');
    await expect(handle).toBeVisible();
    const box = (await handle.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await outAndBack(page, cx, cy, 80, async () => {
      const mid = (await bar.boundingBox())!;
      expect(mid.x).toBeGreaterThan(before.x + 40);
    });

    /*
     * Half a frame of slack, not zero. Trimming quantises to whole frames and
     * the demo's authored in-point need not sit on one, so returning the pointer
     * to the grab point lands on the nearest frame — up to half a frame away, or
     * about 4.2px at 240px/s and 30fps. That is the snapping working, not the
     * edge failing to return; a stranded edge would be off by a whole drag step.
     */
    const halfFrame = 5;
    const after = (await bar.boundingBox())!;
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(halfFrame);
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(halfFrame);
  });

  test('a bezier handle dragged out and back keeps its original curve', async ({ page }) => {
    await page.locator('.keyframe').first().dblclick();
    const dialog = page.locator('.easing-dialog');
    await expect(dialog).toBeVisible();

    /*
     * The control points only exist once the ease is a custom curve — a named
     * GSAP preset has nothing to drag.
     *
     * "Ease" specifically, because its points are inside the unit square. The
     * overshoot presets put a control point outside it (Anticipate's first is
     * y=-0.55, which lands at y=443 in a 340px graph), and an SVG viewport
     * clips its overflow — so those handles are drawn nowhere, cannot be
     * pressed, and a press aimed at them falls through to the backdrop and
     * closes the dialog. That is a real bug, tracked separately; it is not what
     * this test is about.
     */
    await page.getByRole('button', { name: 'Ease', exact: true }).click();

    const curve = dialog.locator('.graph-curve');
    const before = await curve.getAttribute('d');

    const handle = dialog.locator('circle.handle').first();
    await expect(handle).toBeVisible();
    const box = (await handle.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await outAndBack(page, cx, cy, 40, async () => {
      expect(await curve.getAttribute('d')).not.toBe(before);
    });

    expect(await curve.getAttribute('d')).toBe(before);
  });
});

test.describe('resizable panels', () => {
  const leftPanel = (page: Page) => page.locator('.app-body > aside.left');
  const rightPanel = (page: Page) => page.locator('.app-body > aside.right');
  const timeline = (page: Page) => page.locator('footer.app-timeline');

  const splitter = (page: Page, label: string) => page.getByRole('separator', { name: label });

  const widthOf = async (l: ReturnType<typeof leftPanel>) => (await l.boundingBox())!.width;

  /** Drag a splitter by a screen delta. */
  async function dragSplitter(page: Page, label: string, dx: number, dy = 0) {
    const handle = splitter(page, label);
    const box = (await handle.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx / 2, cy + dy / 2, { steps: 3 });
    await page.mouse.move(cx + dx, cy + dy, { steps: 3 });
    await page.mouse.up();
  }

  test('dragging the layers splitter widens the panel', async ({ page }) => {
    const before = await widthOf(leftPanel(page));
    await dragSplitter(page, 'Resize layers panel', 80);
    expect(await widthOf(leftPanel(page))).toBeCloseTo(before + 80, 0);
  });

  test('the properties panel grows when its splitter is dragged left', async ({ page }) => {
    // Inverted axis: this is the one an off-by-a-sign would get backwards, and
    // the symptom would be a panel that shrinks as you pull it open.
    const before = await widthOf(rightPanel(page));
    await dragSplitter(page, 'Resize properties panel', -70);
    expect(await widthOf(rightPanel(page))).toBeCloseTo(before + 70, 0);
  });

  test('the timeline grows when its splitter is dragged up', async ({ page }) => {
    const before = (await timeline(page).boundingBox())!.height;
    await dragSplitter(page, 'Resize timeline', 0, -60);
    expect((await timeline(page).boundingBox())!.height).toBeCloseTo(before + 60, 0);
  });

  test('a panel cannot be dragged away to nothing', async ({ page }) => {
    await dragSplitter(page, 'Resize layers panel', -900);
    // The minimum from LAYOUT_LIMITS, not zero.
    expect(await widthOf(leftPanel(page))).toBe(180);
  });

  test('sizes survive a reload', async ({ page }) => {
    await dragSplitter(page, 'Resize layers panel', 60);
    const resized = await widthOf(leftPanel(page));
    expect(resized).toBeGreaterThan(300);

    await page.reload();
    await expect(page.locator('.layer-row').first()).toBeVisible({ timeout: 15_000 });

    expect(await widthOf(leftPanel(page))).toBe(resized);
  });

  test('double-clicking a splitter restores its default', async ({ page }) => {
    const original = await widthOf(leftPanel(page));
    await dragSplitter(page, 'Resize layers panel', 90);
    expect(await widthOf(leftPanel(page))).not.toBe(original);

    await splitter(page, 'Resize layers panel').dblclick();

    expect(await widthOf(leftPanel(page))).toBe(260);
  });

  test('a splitter can be adjusted from the keyboard', async ({ page }) => {
    const before = await widthOf(leftPanel(page));
    await splitter(page, 'Resize layers panel').focus();
    await page.keyboard.press('ArrowRight');
    expect(await widthOf(leftPanel(page))).toBe(before + 16);
  });

  test('resizing the timeline does not break dragging on the stage', async ({ page }) => {
    /*
     * The stage measures itself to fit, and the splitters change the space it
     * has. If the canvas does not re-measure, the transform handles end up
     * somewhere other than the layer — the failure mode the handles-follow-the-
     * layer test already exists for, reached from a new direction.
     */
    await dragSplitter(page, 'Resize timeline', 0, -80);
    await page.locator('.layer-row', { hasText: 'Name' }).first().click();
    await expect(page.locator('.moveable-control-box')).toBeAttached();

    const area = page.locator('.moveable-area').first();
    const layer = page.locator('.stage-host [data-layer-id="name"]');
    const areaBox = (await area.boundingBox())!;
    const layerBox = (await layer.boundingBox())!;

    expect(Math.abs(areaBox.x - layerBox.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(areaBox.y - layerBox.y)).toBeLessThanOrEqual(2);
  });
});

test.describe('keyframe button', () => {
  test('appears only for animated properties', async ({ page }) => {
    await page.locator('.layer-row', { hasText: 'Bar' }).first().click();

    // Bar animates x but not rotation.
    await expect(page.locator('.prop-field', { hasText: 'X' }).first().locator('.add-key')).toBeVisible();
    await expect(page.locator('.prop-field', { hasText: 'Rotation' }).locator('.add-key')).toHaveCount(0);
  });

  test('drops a keyframe at the playhead holding the current value', async ({ page }) => {
    await page.locator('.layer-row', { hasText: 'Bar' }).first().click();

    const ruler = page.locator('.timeline-ruler');
    const box = (await ruler.boundingBox())!;
    await page.mouse.click(box.x + 240 * 1.0, box.y + 10);

    const xField = page.locator('.prop-field', { hasText: 'X' }).first();
    const valueBefore = await xField.locator('input').inputValue();
    const countBefore = await page.locator('.keyframe').count();

    await xField.locator('.add-key').click();

    expect(await page.locator('.keyframe').count()).toBe(countBefore + 1);
    // A hold keyframe: the value must not change, only be pinned.
    expect(await xField.locator('input').inputValue()).toBe(valueBefore);
  });

  test('marks itself when a keyframe already sits at the playhead', async ({ page }) => {
    await page.locator('.layer-row', { hasText: 'Bar' }).first().click();
    // The playhead starts at 0, where bar already has an x keyframe.
    await expect(
      page.locator('.prop-field', { hasText: 'X' }).first().locator('.add-key'),
    ).toHaveClass(/on/);
  });
});

test('deleting a layer removes it from the preview', async ({ page }) => {
  await page.locator('.layer-row', { hasText: 'Accent' }).first().click();
  await expect(page.locator('.stage-host [data-layer-id="accent"]')).toBeAttached();

  await page.locator('.panel-actions button[title="Delete selected"]').click();

  await expect(page.locator('.stage-host [data-layer-id="accent"]')).toHaveCount(0);
});

test('hiding a layer hides it in the live preview', async ({ page }) => {
  const row = page.locator('.layer-row', { hasText: 'Bar' }).first();
  await row.locator('button[title="Hide"]').click();

  await expect(page.locator('.stage-host [data-layer-id="bar"]')).toHaveAttribute('data-hidden', '1');
});

test('the timeline shows keyframe lanes for animated properties', async ({ page }) => {
  // The demo lower third animates bar.x, so a lane and its keyframes exist.
  await expect(page.locator('.timeline-label.lane', { hasText: 'x' }).first()).toBeVisible();
  expect(await page.locator('.keyframe').count()).toBeGreaterThan(0);
});

test('the STOP marker from the demo appears in the marker lane', async ({ page }) => {
  await expect(page.locator('.marker-lane .marker.stop')).toHaveCount(1);
});

test('scrubbing the ruler moves the playhead and the timecode', async ({ page }) => {
  const ruler = page.locator('.timeline-ruler');
  const box = (await ruler.boundingBox())!;

  const before = await page.locator('.timecode').textContent();
  await page.mouse.move(box.x + 40, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 10);
  await page.mouse.up();

  await expect(page.locator('.timecode')).not.toHaveText(before ?? '');
});

test.describe('preview transport', () => {
  const state = (page: Page) =>
    page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.stage-host [data-layer-id="bar"]');
      return el ? new DOMMatrixReadOnly(getComputedStyle(el).transform).m41 : null;
    });

  test('plays straight through STOP markers by default', async ({ page }) => {
    // Holds are an on-air concern; while building you want to see the whole
    // animation without pressing play at every marker.
    await expect(page.locator('.timeline-toolbar .toggle input')).not.toBeChecked();

    await page.locator('.timeline-toolbar button[title="Play preview"]').click();
    // Past the 1.5s hold and into the outro, where the bar leaves again.
    await page.waitForTimeout(2600);

    expect(await state(page)).toBeLessThan(-500);
  });

  test('pauses at holds when the toggle is on', async ({ page }) => {
    await page.locator('.timeline-toolbar .toggle input').check();

    await page.locator('.timeline-toolbar button[title="Play preview"]').click();
    await page.waitForTimeout(2600);

    // Parked at the hold with the bar on stage, exactly as it will be on air.
    expect(await state(page)).toBeCloseTo(120, 0);
  });
});

test.describe('timeline layout', () => {
  test('every label row lines up with its track row', async ({ page }) => {
    // Regression: the labels column had a head aligned with the ruler but no
    // row for the marker lane, so every layer sat 22px below its own name.
    const drift = await page.evaluate(() => {
      // Select the label rows themselves, not the per-layer wrapper divs that
      // group a layer with its property lanes — `.timeline-labels > *` returns
      // the wrappers and compares 7 of them against 13 rows.
      const labels = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.timeline-labels .timeline-label-head, .timeline-labels .timeline-label',
        ),
      );
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('.timeline-ruler, .timeline-row'),
      );

      const pairs = labels.map((label, i) => {
        const row = rows[i];
        if (!row) return { label: label.textContent ?? '', offset: Number.NaN };
        const a = label.getBoundingClientRect();
        const b = row.getBoundingClientRect();
        return {
          label: label.textContent ?? '',
          offset: (a.top + a.height / 2) - (b.top + b.height / 2),
        };
      });

      return {
        labelCount: labels.length,
        rowCount: rows.length,
        worst: Math.max(0, ...pairs.map((p) => Math.abs(p.offset || 0))),
        misaligned: pairs.filter((p) => !(Math.abs(p.offset) <= 1)).map((p) => p.label),
      };
    });

    // One label row per track row: ruler, marker lane, then each layer and its
    // property lanes.
    expect(drift.labelCount).toBe(drift.rowCount);
    expect(drift.misaligned).toEqual([]);
    expect(drift.worst).toBeLessThanOrEqual(1);
  });

  test('the time ruler stays put while the layer list scrolls', async ({ page }) => {
    await page.locator('.layer-row', { hasText: 'Title' }).first().click();
    for (const field of ['Scale X', 'Rotation', 'Skew X', 'Skew Y']) {
      await page.locator('.prop-field', { hasText: field }).locator('button.stopwatch').click();
    }

    const ruler = page.locator('.timeline-ruler');
    const before = (await ruler.boundingBox())!.y;

    await page.locator('.timeline-body').evaluate((el) => { el.scrollTop = el.scrollHeight; });

    const after = (await ruler.boundingBox())!.y;
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
    await expect(ruler).toBeInViewport();
  });

  test('rows stay rendered when the track list outgrows the panel', async ({ page }) => {
    /*
     * Regression: .timeline-tracks clipped vertically as well as horizontally,
     * so adding a lane silently cut off every row below the visible panel.
     * Clipping does not change layout geometry, so this has to be checked by
     * visibility, not by measuring rectangles.
     */
    await page.locator('.layer-row', { hasText: 'Title' }).first().click();

    // Animate several properties to push the track list past the panel height.
    for (const field of ['Scale X', 'Rotation', 'Skew X', 'Skew Y']) {
      await page.locator('.prop-field', { hasText: field }).locator('button.stopwatch').click();
    }

    const rows = page.locator('.timeline-row');
    const last = rows.last();
    await last.scrollIntoViewIfNeeded();

    await expect(last).toBeInViewport();
    expect(await rows.count()).toBeGreaterThan(await page.locator('.timeline-label.lane').count());
  });

  test('the playhead head stays at the top of the timeline while it scrolls', async ({ page }) => {
    /*
     * The reported bug: the red triangle at the top of the playhead scrolled
     * away with the first layer row, leaving the sticky ruler crossed by a red
     * line with nothing to say which line it was.
     *
     * Enough lanes to make the panel scroll first — a timeline that fits has
     * nothing to prove.
     */
    await page.locator('.layer-row', { hasText: 'Title' }).first().click();
    for (const field of ['Scale X', 'Rotation', 'Skew X', 'Skew Y']) {
      await page.locator('.prop-field', { hasText: field }).locator('button.stopwatch').click();
    }

    const head = page.locator('.playhead-head');
    const ruler = page.locator('.timeline-ruler');
    const before = (await head.boundingBox())!;

    const scrolled = await page.locator('.timeline-body').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    // Assert the premise: a panel that did not scroll would pass everything
    // below without exercising the fix at all.
    expect(scrolled).toBeGreaterThan(20);

    const after = (await head.boundingBox())!;
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);

    // And it is pinned to the ruler, where the time it marks is legible.
    const rulerBox = (await ruler.boundingBox())!;
    expect(after.y).toBeGreaterThanOrEqual(rulerBox.y - 1);
    expect(after.y).toBeLessThan(rulerBox.y + rulerBox.height);
    await expect(head).toBeInViewport();
  });

  test('the head tracks the playhead horizontally', async ({ page }) => {
    // Sticky positioning must not detach the head from the line it belongs to.
    const rulerBox = (await page.locator('.timeline-ruler').boundingBox())!;
    await page.mouse.click(rulerBox.x + 300, rulerBox.y + 10);

    const line = (await page.locator('.playhead').boundingBox())!;
    const head = (await page.locator('.playhead-head').boundingBox())!;
    const centre = head.x + head.width / 2;
    expect(Math.abs(centre - (line.x + line.width / 2))).toBeLessThanOrEqual(1.5);
  });
});

test.describe('the stage scales to the viewport it is given', () => {
  /**
   * Wait for the fit to stop moving.
   *
   * A resize reaches the stage through a ResizeObserver and a React render, so
   * measuring immediately after setViewportSize reads the previous scale. Poll
   * for a stable measurement rather than guessing a timeout.
   */
  async function settled(page: Page) {
    let last = Number.NaN;
    for (let i = 0; i < 20; i++) {
      const width = (await page.locator('.stage-checker').boundingBox())!.width;
      if (Math.abs(width - last) < 0.5) return;
      last = width;
      await page.waitForTimeout(50);
    }
  }

  /** On-screen size of the stage rectangle, and of the panel holding it. */
  async function boxes(page: Page) {
    await settled(page);
    const canvas = (await page.locator('.stage-canvas').boundingBox())!;
    const stage = (await page.locator('.stage-checker').boundingBox())!;
    return { canvas, stage };
  }

  test.describe('on a tablet-sized viewport', () => {
    // A 10" tablet in landscape. The zoom used to be a hardcoded 0.45, which
    // puts a 1080p stage at 864×486 — wider than the panel left over after two
    // side panels, so the preview was cropped and Fit put it straight back.
    test.use({ viewport: { width: 1024, height: 768 } });

    test('fits inside the canvas', async ({ page }) => {
      const { canvas, stage } = await boxes(page);
      expect(stage.width).toBeLessThanOrEqual(canvas.width + 1);
      expect(stage.height).toBeLessThanOrEqual(canvas.height + 1);
    });

    test('uses the space rather than sitting at an arbitrary scale', async ({ page }) => {
      // Fitting is only half the requirement: a stage scaled to 5% also "fits".
      const { canvas, stage } = await boxes(page);
      const filled = Math.max(stage.width / canvas.width, stage.height / canvas.height);
      expect(filled).toBeGreaterThan(0.8);
    });

    test('reports a zoom that is following the viewport', async ({ page }) => {
      const readout = page.locator('.zoom-readout');
      await expect(readout).toHaveAttribute('data-fitted', '1');
      // Whatever the fit is on this viewport, it is not the old constant.
      expect(await readout.textContent()).not.toBe('45%');
    });
  });

  test('is measured and fitted on a desktop viewport too', async ({ page }) => {
    /*
     * The regression 0.33 shipped: the canvas was never measured at all. The
     * ResizeObserver was attached in a mount effect against a ref, but this
     * component renders "No composition loaded" until the project arrives over
     * the API — so the effect found nothing, never ran again, and the zoom sat on
     * its 0.45 fallback for the whole session.
     *
     * Every tablet assertion caught it and every desktop one missed it, because
     * 0.45 happens to fit a 1920 viewport. Asserting the fit *here* is what makes
     * "the measurement happened" testable rather than incidental.
     */
    const { canvas, stage } = await boxes(page);
    const filled = Math.max(stage.width / canvas.width, stage.height / canvas.height);
    expect(filled).toBeGreaterThan(0.8);
  });

  test('re-fits when the device rotates', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    const landscape = await boxes(page);

    await page.setViewportSize({ width: 768, height: 1024 });
    const portrait = await boxes(page);

    expect(portrait.stage.width).toBeLessThanOrEqual(portrait.canvas.width + 1);
    expect(portrait.stage.width).toBeLessThan(landscape.stage.width);
  });

  test('keeps a zoom the operator chose through a resize', async ({ page }) => {
    /*
     * The other half of the requirement, and the reason the zoom is "the
     * operator's value, or null for follow-the-fit" rather than one number: a
     * resize must re-fit an untouched viewport without discarding a zoom
     * somebody set deliberately mid-edit.
     */
    await page.setViewportSize({ width: 1024, height: 768 });
    const readout = page.locator('.zoom-readout');

    await page.getByRole('button', { name: '+', exact: true }).first().click();
    await expect(readout).toHaveAttribute('data-fitted', '0');
    const chosen = await readout.textContent();

    await page.setViewportSize({ width: 900, height: 700 });
    await settled(page);
    expect(await readout.textContent()).toBe(chosen);

    // Fit hands it back, and it starts tracking again.
    await page.getByRole('button', { name: 'Fit' }).first().click();
    await expect(readout).toHaveAttribute('data-fitted', '1');
  });

  test('fits a stage larger than any viewport', async ({ page }) => {
    // Nothing here may produce a zero or negative scale: the stage must stay
    // visible even on a viewport far smaller than the composition.
    await page.setViewportSize({ width: 700, height: 560 });
    const { canvas, stage } = await boxes(page);
    expect(stage.width).toBeGreaterThan(20);
    expect(stage.width).toBeLessThanOrEqual(canvas.width + 1);
  });
});

test.describe('timeline zoom', () => {
  /** Left edge of the first ruler tick, relative to the track area. */
  const firstTickOffset = (page: Page) =>
    page.evaluate(() => {
      const tick = document.querySelector<HTMLElement>('.timeline-ruler .tick');
      const tracks = document.querySelector<HTMLElement>('.timeline-tracks');
      if (!tick || !tracks) return null;
      return tick.getBoundingClientRect().left - tracks.getBoundingClientRect().left;
    });

  const scrollOverflow = (page: Page) =>
    page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('.timeline-body')!;
      return {
        x: body.scrollWidth - body.clientWidth,
        y: body.scrollHeight - body.clientHeight,
      };
    });

  /**
   * Overflow once it has stopped changing.
   *
   * Fit grows the panel through React state and then re-fits the width in a
   * layout effect, so the measurement is only meaningful after both have
   * landed. Polling on the horizontal figure — the one the fix is about — and
   * then reading both keeps this from racing the second render.
   */
  const pollOverflow = async (page: Page) => {
    await expect.poll(async () => (await scrollOverflow(page)).x).toBeLessThanOrEqual(1);
    return scrollOverflow(page);
  };

  test('zoom in undoes zoom out', async ({ page }) => {
    // Regression: zoomAround clamped start at 0 on the way out but honoured a
    // stale anchor on the way back in, so the view crept right every cycle.
    const before = await firstTickOffset(page);

    await page.locator('.timeline-toolbar button[title="Zoom out"]').click();
    await page.locator('.timeline-toolbar button[title="Zoom in"]').click();

    expect(await firstTickOffset(page)).toBeCloseTo(before!, 0);
  });

  test('survives repeated zoom cycles without drifting', async ({ page }) => {
    const before = await firstTickOffset(page);

    for (let i = 0; i < 5; i++) {
      await page.locator('.timeline-toolbar button[title="Zoom out"]').click();
      await page.locator('.timeline-toolbar button[title="Zoom in"]').click();
    }

    expect(await firstTickOffset(page)).toBeCloseTo(before!, 0);
  });

  /**
   * Offset of the earliest keyframe's center from the left edge of the track
   * column. Negative means the view has scrolled past it — which is the state
   * both clipping tests below exist to examine.
   */
  const earliestKeyframeOffset = (page: Page) =>
    page.evaluate(() => {
      const kf = document.querySelector<HTMLElement>('.keyframe');
      const tracks = document.querySelector<HTMLElement>('.timeline-tracks');
      if (!kf || !tracks) return null;
      const r = kf.getBoundingClientRect();
      return r.left + r.width / 2 - tracks.getBoundingClientRect().left;
    });

  /**
   * Zoom in until content actually scrolls out of the left of the view.
   *
   * Previously these tests clicked "Zoom in" twice and assumed that scrolled the
   * view. It did — while the view was stuck at a placeholder 900px width. With
   * the width correctly measured the panel is wider, two clicks no longer scroll
   * anything, and both tests would have gone on passing while examining a view
   * with nothing scrolled out of it. A test that cannot fail is worse than no
   * test, so the premise is now established rather than assumed.
   */
  async function zoomUntilScrolled(page: Page, limit = 10) {
    const zoomIn = page.locator('.timeline-toolbar button[title="Zoom in"]');
    for (let i = 0; i < limit; i++) {
      await zoomIn.click();
      const offset = await earliestKeyframeOffset(page);
      if (offset !== null && offset < 0) return;
    }
    throw new Error(
      `the view never scrolled after ${limit} zoom-in clicks — this test is not examining what it claims to`,
    );
  }

  test('timeline content never intercepts clicks on the layer names', async ({ page }) => {
    /*
     * Hit-test the label column rather than comparing rectangles.
     *
     * Two earlier versions of this test measured geometry and both were wrong.
     * `getBoundingClientRect` reports layout and ignores `overflow: hidden`, so
     * it cannot see clipping at all. Comparing element centers against the
     * track edge then forbade something legitimate: once zoomed in, keyframes
     * before the view start *should* sit at negative offsets — they are
     * scrolled out of view, clipped, and harmless.
     *
     * What actually matters is whether timeline content can steal a click in
     * the label column. `elementFromPoint` answers exactly that and respects
     * clipping, so it tests the behavior instead of a proxy for it.
     */
    await zoomUntilScrolled(page);

    const intercepted = await page.evaluate(() => {
      const labels = document.querySelector<HTMLElement>('.timeline-labels')!;
      const r = labels.getBoundingClientRect();
      const offenders: string[] = [];

      for (let y = r.top + 4; y < r.bottom - 4; y += 6) {
        for (let x = r.left + 4; x < r.right - 4; x += 16) {
          const el = document.elementFromPoint(x, y);
          if (el?.closest('.keyframe, .marker, .lifetime, .playhead')) {
            offenders.push(`${Math.round(x)},${Math.round(y)}`);
          }
        }
      }
      return offenders;
    });

    expect(intercepted).toEqual([]);
  });

  test('scrolled-out keyframes are clipped, not merely hidden', async ({ page }) => {
    // Zoom in until the view scrolls, then confirm nothing outside the track area
    // is hit-testable — which is what stops it interfering with the labels.
    await zoomUntilScrolled(page);

    const leaking = await page.evaluate(() => {
      const bounds = document.querySelector<HTMLElement>('.timeline-tracks')!
        .getBoundingClientRect();

      return Array.from(document.querySelectorAll<HTMLElement>('.keyframe'))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;

          if (cx >= bounds.left) return false; // inside the track area, fine
          // Off the viewport entirely — there is nothing it could leak onto.
          if (cx < 0 || cy < 0) return false;

          // `elementFromPoint` returns null for an empty point, and the earlier
          // `hit?.closest(...) !== null` read that as `undefined !== null`,
          // i.e. true — counting "nothing there" as a leak.
          const hit = document.elementFromPoint(cx, cy);
          return hit?.closest('.keyframe') != null;
        }).length;
    });

    expect(leaking).toBe(0);
  });

  test('the earliest keyframe stays clickable', async ({ page }) => {
    // Regression: the t=0 keyframe's center fell outside the track area, so
    // the label column intercepted every click on it.
    const first = page.locator('.keyframe').first();
    await expect(first).toHaveAttribute('title', /@ 0\.000s/);

    await first.dblclick({ timeout: 5000 });
    await expect(page.locator('.easing-dialog')).toBeVisible();
  });

  test('the ruler is ticked across the panel it is actually in', async ({ page }) => {
    /*
     * The timeline had the same inert-measurement bug as the stage: its
     * ResizeObserver was attached in a mount effect against a ref, before a
     * project had loaded, so the view kept its placeholder 900px width forever.
     *
     * Nothing looked wrong — timeToPx draws and hit-tests through the same
     * number, so content stayed self-consistent — but everything derived from the
     * width was off: Fit scaled the composition to 900px instead of the panel,
     * and clampView bounded scrolling by a viewport that did not exist.
     *
     * Ticks are generated out to the edge of the *view*, so a view narrower than
     * its panel leaves a trailing band of ruler with no ticks in it. That gap is
     * the measurement error, made visible.
     */
    const ruler = await page.evaluate(() => {
      const tracks = document.querySelector<HTMLElement>('.timeline-tracks')!.getBoundingClientRect();
      const offsets = Array.from(document.querySelectorAll<HTMLElement>('.timeline-ruler .tick'))
        .map((t) => t.getBoundingClientRect().left - tracks.left);
      if (offsets.length < 2) return null;
      return {
        width: tracks.width,
        spacing: offsets[1]! - offsets[0]!,
        trailing: tracks.width - offsets[offsets.length - 1]!,
      };
    });

    expect(ruler).not.toBeNull();
    // Under one tick of blank ruler at the right-hand edge, plus a pixel of
    // rounding. A stuck 900px view on a wider panel leaves hundreds.
    expect(ruler!.trailing).toBeLessThanOrEqual(ruler!.spacing + 2);
  });

  test('Fit shows the whole composition from the start', async ({ page }) => {
    await page.locator('.timeline-toolbar button[title="Zoom in"]').click();
    await page.locator('.timeline-toolbar button[title="Fit the whole composition"]').click();

    // First tick sits at or after the left edge, so nothing is scrolled off.
    expect(await firstTickOffset(page)).toBeGreaterThanOrEqual(-1);
    await expect(page.locator('.marker-lane .marker.stop')).toBeVisible();
  });

  test('Fit leaves no scrollbar on either axis', async ({ page }) => {
    /*
     * Reported: Fit scaled the columns to span the full width and then put
     * scrollbars on the frame anyway.
     *
     * Two independent causes, which is why it looked self-contradictory.
     * Horizontally, `.timeline-tracks` clipped nothing, and two absolutely
     * positioned things reach past the right edge — a ruler tick's label sits
     * 3px right of its line, and the playhead head is a 10px triangle centered
     * on a 1px line. Neither is inside a `.timeline-row`, so the row-level
     * clipping never caught them and both counted towards scrollWidth; Fit made
     * it worse by moving the last tick exactly to the edge. Vertically, Fit
     * simply never considered the rows at all.
     *
     * Asserted on the scrollport rather than on the tick geometry, because the
     * scrollbar is the thing being complained about and either cause returning
     * would show up here.
     */
    await page.locator('.timeline-toolbar button[title="Zoom in"]').click();
    await page.locator('.timeline-toolbar button[title="Fit the whole composition"]').click();

    const overflow = await pollOverflow(page);
    expect(overflow.x).toBeLessThanOrEqual(1);
    expect(overflow.y).toBeLessThanOrEqual(1);
  });

  test('Fit adds no horizontal scrollbar even when it cannot grow enough', async ({ page }) => {
    /*
     * The degradation path, and the more important half of the promise.
     *
     * The timeline may only grow to a share of the window height, so on a short
     * window a composition with this many lanes keeps its vertical scrollbar —
     * that is deliberate, because the alternative is squeezing out the stage.
     * What must not survive is the *horizontal* scrollbar: whatever height Fit
     * settles on, the scale has to be computed from the track column that
     * results from it, including the ~15px the remaining vertical scrollbar
     * takes. Fitting to the pre-Fit width is what put the two scrollbars there
     * in the first place.
     *
     * 400px tall puts the cap well below what the rows need, so the clamp is
     * guaranteed to bite rather than depending on how many lanes the demo has.
     */
    await page.setViewportSize({ width: 1280, height: 400 });
    await page.locator('.timeline-toolbar button[title="Fit the whole composition"]').click();

    const overflow = await pollOverflow(page);
    expect(overflow.x).toBeLessThanOrEqual(1);

    // The composition still spans the column rather than being left short.
    expect(await firstTickOffset(page)).toBeGreaterThanOrEqual(-1);
  });
});

test('adding a STOP marker at the playhead writes it to the document', async ({ page }) => {
  await page.getByRole('button', { name: '+ STOP' }).click();
  await expect(page.locator('.marker-lane .marker.stop')).toHaveCount(2);
});

test('double-clicking a STOP marker removes it', async ({ page }) => {
  /*
   * Previously uncovered, and the marker is the one draggable that takes pointer
   * capture on pointer-down. That is safe only because it captures *itself*, so
   * the following pointerup still targets the marker and the browser can still
   * derive a dblclick from it — capture taken on any other element would retarget
   * the up and silently kill this. The keyframe drag hit exactly that and lost
   * its double-click; markers must not regress the same way.
   */
  const markers = page.locator('.marker-lane .marker.stop');
  await expect(markers).toHaveCount(1);

  await markers.first().dblclick();

  await expect(markers).toHaveCount(0);
});

test('a marker stays deletable after being dragged', async ({ page }) => {
  // The drag and the double-click share an element and a pointer-capture call,
  // so exercising them in sequence is the case that would catch one breaking
  // the other.
  const markers = page.locator('.marker-lane .marker.stop');
  const box = (await markers.first().boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy, { steps: 3 });
  await page.mouse.up();
  expect((await markers.first().boundingBox())!.x).toBeGreaterThan(box.x + 30);

  await markers.first().dblclick();
  await expect(markers).toHaveCount(0);
});

test('the stopwatch turns a static property into an animated one', async ({ page }) => {
  await page.locator('.layer-row', { hasText: 'Title' }).first().click();

  const rotationField = page.locator('.prop-field', { hasText: 'Rotation' });
  await rotationField.locator('button.stopwatch').click();

  await expect(rotationField.locator('button.stopwatch')).toHaveClass(/on/);
  await expect(page.locator('.timeline-label.lane', { hasText: 'rotation' })).toBeVisible();
});

test('double-clicking a keyframe opens the easing editor with a live curve', async ({ page }) => {
  await page.locator('.keyframe').first().dblclick();

  await expect(page.locator('.easing-dialog')).toBeVisible();
  // The curve is drawn from the runtime's own solver, so it must have a path.
  const d = await page.locator('.graph-curve').getAttribute('d');
  expect(d).toBeTruthy();
  expect(d!.length).toBeGreaterThan(50);
});

test.describe('overshoot curves are editable, not just applicable', () => {
  /*
   * The graph maps a y range wider than the unit square. It has to: a control
   * point's y is deliberately free so overshoot and anticipation are possible,
   * and an SVG viewport clips anything outside it. Mapping only 0..1 put
   * Anticipate's first control point (y = -0.55) at y=443 in a 340px box, where
   * it was invisible, unpressable, and a press aimed at it fell through to the
   * backdrop and closed the dialog.
   *
   * Note what does NOT catch this: `getBoundingClientRect` reports layout and
   * ignores SVG clipping, so the handles measure as present and `toBeVisible`
   * agrees — the same trap the timeline clipping tests carry a comment about.
   * These assert containment within the viewport explicitly.
   */
  const openWithAnticipate = async (page: Page) => {
    await page.locator('.keyframe').first().dblclick();
    await expect(page.locator('.easing-dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Anticipate' }).click();
    await expect(page.locator('.bezier-readout')).toContainText('cubic-bezier(0.680, -0.550');
  };

  test('both handles of an overshoot preset sit inside the graph', async ({ page }) => {
    await openWithAnticipate(page);

    const inside = await page.evaluate(() => {
      const svg = document.querySelector<SVGSVGElement>('.easing-graph')!;
      const box = svg.getBoundingClientRect();
      return Array.from(document.querySelectorAll<SVGCircleElement>('.easing-graph circle.handle')).map(
        (c) => {
          const r = c.getBoundingClientRect();
          return {
            within:
              r.top >= box.top && r.bottom <= box.bottom && r.left >= box.left && r.right <= box.right,
            // Reported so a failure says how far out it was, not merely "false".
            overflowY: Math.round(Math.max(box.top - r.top, r.bottom - box.bottom)),
          };
        },
      );
    });

    expect(inside).toHaveLength(2);
    expect(inside).toEqual([
      { within: true, overflowY: inside[0]!.overflowY },
      { within: true, overflowY: inside[1]!.overflowY },
    ]);
  });

  test('an overshoot handle can be grabbed and moved', async ({ page }) => {
    await openWithAnticipate(page);

    const curve = page.locator('.graph-curve');
    const before = await curve.getAttribute('d');

    const handle = page.locator('.easing-graph circle.handle').first();
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 3 });
    await page.mouse.up();

    // The dialog surviving the press is half the assertion: the old geometry
    // closed it, because the press landed on the backdrop instead of the handle.
    await expect(page.locator('.easing-dialog')).toBeVisible();
    expect(await curve.getAttribute('d')).not.toBe(before);
  });
});

test('choosing a bezier preset writes a custom ease onto the keyframe', async ({ page }) => {
  await page.locator('.keyframe').first().dblclick();
  await page.getByRole('button', { name: 'Anticipate' }).click();

  await expect(page.locator('.bezier-readout')).toContainText('cubic-bezier(0.680, -0.550');
});

test.describe('text reveal gallery', () => {
  /** Select the demo's name strap, which is a text layer. */
  async function selectName(page: Page) {
    await page.locator('.layer-row', { hasText: 'Name' }).first().click();
  }

  const presetSelect = (page: Page) => page.locator('select.reveal-preset');

  test('offers the gallery on a text layer and nothing on a shape', async ({ page }) => {
    await selectName(page);
    await expect(presetSelect(page)).toBeVisible();
    // Six presets plus None.
    await expect(presetSelect(page).locator('option')).toHaveCount(7);

    await page.locator('.layer-row', { hasText: 'Bar' }).first().click();
    await expect(presetSelect(page)).toHaveCount(0);
  });

  test('choosing a preset writes only its id, so timings follow the preset', async ({ page }) => {
    /*
     * A preset that copied its defaults into the document would freeze them
     * there: tuning a default later would not reach any graphic already built,
     * and every layer would carry three numbers nobody chose.
     */
    await selectName(page);
    await presetSelect(page).selectOption('words-up');

    /*
     * Asserted through the fields, which is where it is observable: an empty
     * value with the default offered as a placeholder means the document carries
     * no number of its own. Checking the document itself would need the store
     * exposed on `window`, and a test that reaches for an object that may not be
     * there — and shrugs when it is not — proves nothing.
     */
    for (const label of ['Stagger', 'Duration']) {
      const field = page.locator('.prop-field', { hasText: label }).locator('input');
      await expect(field).toHaveValue('');
      await expect(field).toHaveAttribute('placeholder', /\d/);
    }
    // Ease likewise defers, and names the preset's choice in the option label.
    await expect(
      page.locator('.prop-field', { hasText: 'Ease' }).locator('select'),
    ).toHaveValue('');
  });

  test('reports how many pieces the reveal animates', async ({ page }) => {
    // Measured by the runtime, not guessed from the document — for `lines` the
    // count depends on the real font in the real box.
    await selectName(page);
    await presetSelect(page).selectOption('chars-up');

    const readout = page.locator('.reveal-readout');
    await expect(readout).toBeVisible();
    // "JANE DOE" is seven characters.
    await expect(readout).toHaveAttribute('data-pieces', '7', { timeout: 5000 });
    await expect(readout).toContainText('chars');
  });

  test('warns when the reveal overruns the hold', async ({ page }) => {
    /*
     * The failure this exists to catch: the strap is still assembling itself when
     * the director cuts away, which looks like dropped frames rather than a
     * timing mistake. A 1s stagger over seven characters cannot fit any hold.
     */
    await selectName(page);
    await presetSelect(page).selectOption('chars-up');
    await page.locator('.prop-field', { hasText: 'Stagger' }).locator('input').fill('1');

    const warning = page.locator('[data-warning="reveal-overrun"]');
    await expect(warning).toBeVisible({ timeout: 5000 });
    await expect(warning).toContainText('still be assembling');
  });

  test('a preset is one undo step, and undo removes it', async ({ page }) => {
    const undoButton = page.getByRole('button', { name: 'Undo' });
    const depth = async () => Number(await undoButton.getAttribute('data-undo-depth'));

    await selectName(page);
    const before = await depth();
    await presetSelect(page).selectOption('lines-fade');

    await expect(presetSelect(page)).toHaveValue('lines-fade');
    expect(await depth()).toBe(before + 1);

    await undoButton.click();
    await expect(presetSelect(page)).toHaveValue('');
  });

  test('the preview animates the reveal it was given', async ({ page }) => {
    // The editor preview IS the runtime, so choosing a preset must split the
    // text on the stage — not just record an intention in the document.
    await selectName(page);
    await presetSelect(page).selectOption('chars-up');

    const chars = page.locator('.stage-host [data-layer-id="name"] .bz-text-inner div div');
    await expect(chars.first()).toBeAttached({ timeout: 5000 });
    expect(await chars.count()).toBe(7);
  });
});

test.describe('crawl authoring', () => {
  /*
   * The schema and the runtime have supported speed, direction, a bound item
   * list and live append since Phase 1, but the panel had no controls for any of
   * it — a crawl added in the editor was stuck on its factory defaults. Found by
   * auditing Phase 5 against the roadmap, not by a report.
   */
  test.beforeEach(async ({ page }) => {
    await page.locator('select.add-layer').selectOption('crawl');
  });

  test('exposes speed, direction, separator and items', async ({ page }) => {
    for (const label of ['Speed', 'Direction', 'Separator', 'Items']) {
      await expect(page.locator('.prop-field', { hasText: label }).first()).toBeVisible();
    }
  });

  test('editing the item list reaches the ticker on the stage', async ({ page }) => {
    const items = page.locator('.prop-field', { hasText: 'Items' }).locator('textarea');
    await items.fill('FIRST HEADLINE\nSECOND HEADLINE');

    const track = page.locator('.stage-host .bz-crawl-track');
    await expect(track).toContainText('FIRST HEADLINE', { timeout: 5000 });
    await expect(track).toContainText('SECOND HEADLINE');
  });

  test('drops blank lines rather than rendering empty items', async ({ page }) => {
    // An empty item renders as two separators with nothing between them.
    const items = page.locator('.prop-field', { hasText: 'Items' }).locator('textarea');
    await items.fill('ONE\n\n\nTWO\n');

    await expect(items).toHaveValue('ONE\nTWO');
  });

  test('reverses the crawl direction', async ({ page }) => {
    const direction = page.locator('.prop-field', { hasText: 'Direction' }).locator('select');
    await expect(direction).toHaveValue('left');
    await direction.selectOption('right');
    await expect(direction).toHaveValue('right');
  });
});

test('the output URL points at the transparent play page', async ({ page }) => {
  const href = await page.locator('.output-link').getAttribute('href');
  expect(href).toMatch(/^\/play\/demo\//);
});

test.describe('data sources panel', () => {
  /*
   * The left column stacks three panels now — layers, data sources, assets —
   * so these read every one of them rather than assuming the column is layers
   * plus data. The invariants under test did not change: folding a panel gives
   * its space to the layer list, and nothing is left floating in a gap. Only
   * the arithmetic did.
   */
  const heights = (page: Page) =>
    page.evaluate(() => {
      const left = document.querySelector<HTMLElement>('.left')!;
      const layers = document.querySelector<HTMLElement>('.left > .layers-panel')!;
      const data = document.querySelector<HTMLElement>('.left > .data-panel')!;
      const assets = document.querySelector<HTMLElement>('.left > .asset-bin')!;
      return {
        column: left.getBoundingClientRect().height,
        layers: layers.getBoundingClientRect().height,
        data: data.getBoundingClientRect().height,
        assets: assets.getBoundingClientRect().height,
        dataBottom: data.getBoundingClientRect().bottom,
        assetsTop: assets.getBoundingClientRect().top,
        assetsBottom: assets.getBoundingClientRect().bottom,
        columnBottom: left.getBoundingClientRect().bottom,
      };
    });

  const toggle = (page: Page) =>
    page.locator('.data-panel .panel-toggle');

  test('collapsing it gives the space back to the layers', async ({ page }) => {
    /*
     * Reported: folding the data sources away did not give the layer list any
     * more room.
     *
     * `.panel` sets `height: 100%`, and for a `flex: 0 0 auto` item in a column
     * that height is the flex-basis — so the panel claimed the whole column,
     * `max-height: 55%` trimmed it back, and whether it had any content was
     * never part of the calculation. Collapsed it reserved exactly as much as
     * expanded.
     */
    const open = await heights(page);
    await toggle(page).click();
    await expect(page.locator('.data-panel .source-list')).toHaveCount(0);
    const shut = await heights(page);

    // The bar is now a fraction of what it was, and the layers took the rest.
    expect(shut.data).toBeLessThan(open.data);
    expect(shut.data).toBeLessThan(shut.column * 0.2);
    expect(shut.layers).toBeGreaterThan(open.layers);

    // Nothing was lost between them: the three panels still fill the column.
    // A pixel of tolerance for sub-pixel layout rounding, not for a real gap.
    expect(Math.abs(shut.layers + shut.data + shut.assets - shut.column)).toBeLessThanOrEqual(1);
  });

  test('the collapsed bars stack flush on the bottom edge of the column', async ({ page }) => {
    /*
     * With two foldable panels under the layer list, "sits on the bottom edge"
     * became two claims: the stack ends at the column's edge, and the folded
     * bars are flush against each other. The second is the one a naive fix
     * breaks — an auto margin on both panels pins each to the bottom of its own
     * free space and opens a gap between them.
     */
    await toggle(page).click();
    const { dataBottom, assetsTop, assetsBottom, columnBottom } = await heights(page);

    expect(Math.abs(assetsBottom - columnBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(assetsTop - dataBottom)).toBeLessThanOrEqual(1);
  });

  test('expanding it again restores the split', async ({ page }) => {
    // The collapse is a layout override, not a one-way door — a stuck override
    // would be the obvious way to get this wrong.
    const open = await heights(page);
    await toggle(page).click();
    await toggle(page).click();
    await expect(page.locator('.data-panel .source-list')).toHaveCount(1);

    const reopened = await heights(page);
    expect(Math.abs(reopened.data - open.data)).toBeLessThanOrEqual(1);
    expect(Math.abs(reopened.layers - open.layers)).toBeLessThanOrEqual(1);
  });
});

test.describe('asset bin', () => {
  const bin = (page: Page) => page.locator('.asset-bin');

  test('is present and folded by default, so it costs the layer list nothing', async ({ page }) => {
    // An author reaches for the layer list constantly and for assets a few
    // times a session, so the column's default has to favor the list.
    await expect(bin(page)).toHaveCount(1);
    await expect(bin(page)).toHaveAttribute('data-collapsed', '1');
    await expect(page.locator('.asset-list')).toHaveCount(0);
  });

  test('opens to show the drop target and the empty state', async ({ page }) => {
    await bin(page).locator('.panel-toggle').click();
    await expect(page.locator('.asset-list')).toHaveCount(1);
    await expect(page.locator('.asset-drop')).toBeVisible();
    // The demo project ships no uploaded assets, so this is the state a new
    // user meets and it has to say how to get out of it.
    await expect(page.locator('.asset-empty')).toContainText('No assets yet');
  });

  test('uploads a file and lists it', async ({ page }) => {
    await bin(page).locator('.panel-toggle').click();
    await page.locator('.asset-bin input[type=file]').setInputFiles({
      name: 'Test Logo.png',
      mimeType: 'image/png',
      buffer: Buffer.from('fake-png-bytes'),
    });

    const row = page.locator('.asset-row').filter({ hasText: 'Test Logo.png' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('image');
  });

  test('offers the uploaded file to an image layer as a picker', async ({ page }) => {
    /*
     * The point of the bin. Before it, this field was free text and the only
     * way to fill it correctly was to know what had been copied into the
     * project directory by hand — which an operator with no shell on the
     * graphics box cannot.
     */
    await bin(page).locator('.panel-toggle').click();
    await page.locator('.asset-bin input[type=file]').setInputFiles({
      name: 'picked.png',
      mimeType: 'image/png',
      buffer: Buffer.from('picked-bytes'),
    });
    await expect(page.locator('.asset-row').filter({ hasText: 'picked.png' })).toHaveCount(1);

    await page.locator('.add-layer').selectOption('image');
    const picker = page.locator('.properties-panel select').filter({ hasText: 'picked.png' });
    await expect(picker).toHaveCount(1);
  });
});

/**
 * The asset library modal (Phase 7.5 Wave B).
 *
 * The docked bin stays a picker; this is where browsing, filing and tagging
 * happen, because facets, a grid, bulk edit and a detail panel do not fit in
 * one column of a three-panel stack without making the layer list unusable.
 */
test.describe('safe-area guides', () => {
  /** The stage toolbar's Guides toggle. Timeline holds the other `label.toggle`. */
  const guides = (page: Page) =>
    page.locator('.stage-toolbar label.toggle', { hasText: 'Guides' }).locator('input');

  /** Second select in the app bar; the first is the project picker. */
  const compositions = (page: Page) => page.locator('.app-bar select').nth(1);

  test('are on for a full frame and off for an element-sized stage', async ({ page }) => {
    /*
     * `SAFE_AREAS` are fractions of the stage, so they only describe anything
     * real when the stage *is* the broadcast raster. The demo's `badge` is
     * 120×40 — title-safe works out at 12px — and it used to open with guides
     * on, because `showGuides` was `useState(true)` evaluated once for whatever
     * composition the editor happened to load first and never revisited.
     *
     * Asserting the 1920×1080 case first is what stops this passing vacuously:
     * the guides also hide themselves in a narrow pane, so "unchecked on the
     * badge" only means anything once "checked on the lower third" has been
     * shown in the same viewport.
     */
    await compositions(page).selectOption('l3rd-name');
    await expect(guides(page)).toBeChecked();

    await compositions(page).selectOption('badge');
    await expect(guides(page)).not.toBeChecked();
  });

  test('can still be switched on for an element, and switching back resets', async ({ page }) => {
    // A default, not a lock — the center lines are useful for lining something
    // up inside a small element, so the box stays live.
    await compositions(page).selectOption('badge');
    await expect(guides(page)).not.toBeChecked();

    await guides(page).check();
    await expect(guides(page)).toBeChecked();

    // Leaving and returning re-applies the default rather than remembering the
    // override, which is what makes the rule predictable per composition.
    await compositions(page).selectOption('l3rd-name');
    await compositions(page).selectOption('badge');
    await expect(guides(page)).not.toBeChecked();
  });
});

test.describe('asset library', () => {
  const openLibrary = async (page: Page) => {
    await page.locator('.asset-bin .asset-browse').click();
    await expect(page.locator('.lib-dialog')).toBeVisible();
  };

  /**
   * Upload through the docked bin's fast path, which does not need the modal.
   *
   * The bin has to be *opened* first. Its file input is mounted whatever the
   * fold state — dropping onto the folded bar is a supported gesture — but
   * `.asset-row` lives inside the collapsed region, so a folded bin accepts the
   * upload and shows no row for it. Guarded on `data-collapsed` rather than
   * clicked blindly, because a second call would fold it again.
   */
  const uploadViaBin = async (page: Page, name: string, bytes: string) => {
    const bin = page.locator('.asset-bin');
    if (await bin.getAttribute('data-collapsed')) await bin.locator('.panel-toggle').click();

    await page.locator('.asset-bin input[type=file]').setInputFiles({
      name,
      mimeType: 'image/png',
      buffer: Buffer.from(bytes),
    });
    await expect(page.locator('.asset-row').filter({ hasText: name })).toHaveCount(1);
  };

  /**
   * Commit the composition to disk.
   *
   * The editor does not autosave — the app bar's button is the only path, and
   * `save()` is otherwise bound to Ctrl+S. Anything asserting on what the
   * *server* thinks, as the usage index does, has to go through it: a layer
   * added in the editor and never saved does not exist to `/assets/:id/usage`.
   */
  const save = async (page: Page) => {
    const button = page.getByRole('button', { name: 'Save', exact: true });
    await button.click();
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  };

  test('opens from the bin and closes on Escape', async ({ page }) => {
    await openLibrary(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.lib-dialog')).toHaveCount(0);
  });

  test('shows uploaded assets as cards and filters them by search', async ({ page }) => {
    await uploadViaBin(page, 'sponsor-plate.png', 'sponsor-bytes');
    await uploadViaBin(page, 'clock-face.png', 'clock-bytes');
    await openLibrary(page);

    /*
     * Asserted by name, not by count. The data directory is thrown away once
     * per run rather than per test, so every earlier test's uploads are still
     * in the demo project's bin — an absolute count here would pass today and
     * break the moment anyone adds a test above this one.
     */
    const cards = page.locator('.lib-card');
    await expect(cards.filter({ hasText: 'sponsor-plate.png' })).toHaveCount(1);
    await expect(cards.filter({ hasText: 'clock-face.png' })).toHaveCount(1);

    // A term unique to one of them, so "exactly one" is a claim about the
    // filter rather than about how many files happen to be in the bin.
    await page.locator('.lib-search').fill('sponsor-plate');
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText('sponsor-plate.png');

    // Clearing restores the rest, rather than leaving a filter nobody can see.
    await page.locator('.lib-search').fill('');
    await expect(cards.filter({ hasText: 'clock-face.png' })).toHaveCount(1);
  });

  test('files an asset into a folder, which then appears as a facet', async ({ page }) => {
    await uploadViaBin(page, 'filed.png', 'filed-bytes');
    await openLibrary(page);

    await page.locator('.lib-card').filter({ hasText: 'filed.png' }).click();
    await expect(page.locator('.lib-detail')).toBeVisible();

    // Normalized on the way in: "Game Scene" becomes `game-scene`, which is
    // what stops one folder becoming three.
    const folder = page.locator('.lib-detail label', { hasText: 'Folder' }).locator('input');
    await folder.fill('Game Scene');
    await folder.blur();

    await expect(
      page.locator('.lib-facet', { hasText: 'Folder' }).locator('button', { hasText: 'game-scene' }),
    ).toHaveCount(1);
  });

  test('reports where an asset is used, across compositions', async ({ page }) => {
    /*
     * The question the docked bin could never answer. Its "in use" marker only
     * ever saw the composition currently open, so it declined to claim more —
     * this is the claim the usage index makes possible.
     *
     * **This test brings its own project, and it is the only one here that
     * does.** The usage index is computed server-side from the *saved* project,
     * so proving it needs a real save — and the e2e data directory is thrown
     * away once per run rather than per test. Saving into the shared demo left
     * an extra image layer in `l3rd-name` that `lower-third.spec.ts` then found
     * while asserting the composition's exact top-level layer list. A test that
     * writes has to own what it writes to.
     */
    const projectId = `usage-e2e-${Date.now()}`;
    const created = await page.request.post('/api/projects', {
      data: { name: 'Usage e2e', id: projectId },
    });
    expect(created.status()).toBe(201);

    try {
      // Reload so the picker lists it. `listProjects` sorts by `updatedAt`, and
      // the editor opens the first — which is the one just created.
      await page.goto('/editor/');
      await expect(page.locator('.app-bar select').first()).toHaveValue(projectId);

      await uploadViaBin(page, 'used-here.png', 'used-here-bytes');

      await page.locator('.add-layer').selectOption('image');
      await page
        .locator('.properties-panel select')
        .filter({ hasText: 'used-here.png' })
        .selectOption({ label: 'used-here.png' });

      await save(page);

      await openLibrary(page);
      await page.locator('.lib-card').filter({ hasText: 'used-here.png' }).click();

      const usage = page.locator('.lib-usage');
      await expect(usage).not.toContainText('No composition');
      await expect(usage).toContainText('Untitled');
    } finally {
      // Removed whatever happened above, so the demo is the newest project
      // again and the tests after this one open it as they expect.
      await page.request.delete(`/api/projects/${projectId}`);
    }
  });

  test('switches to the bulk panel once more than one card is ticked', async ({ page }) => {
    await uploadViaBin(page, 'bulk-a.png', 'bulk-a-bytes');
    await uploadViaBin(page, 'bulk-b.png', 'bulk-b-bytes');
    await openLibrary(page);

    // Ctrl-click builds a selection without opening the detail panel.
    await page.locator('.lib-card').filter({ hasText: 'bulk-a.png' }).click({ modifiers: ['Control'] });
    await page.locator('.lib-card').filter({ hasText: 'bulk-b.png' }).click({ modifiers: ['Control'] });

    await expect(page.locator('.lib-bulk')).toBeVisible();
    await expect(page.locator('.lib-bulk header')).toContainText('2 selected');
    // Bulk delete is deliberately absent — see AssetLibrary.tsx.
    await expect(page.locator('.lib-bulk .lib-delete')).toHaveCount(0);
  });
});

test.describe('transcoding', () => {
  test('the transcode control agrees with what the server can actually do', async ({ page }) => {
    /*
     * Asserted against the server's own capability report rather than against a
     * fixed expectation, because whether ffmpeg is installed is a property of
     * the machine running the suite — not of the code under test.
     *
     * The first version of this test hardcoded `toBeDisabled()`, which passed
     * only because the validation container had no ffmpeg. Installing ffmpeg
     * there broke it instantly, and a test that reports a failure when the
     * environment improves is worse than no test.
     *
     * The invariant that actually matters holds either way: the control is
     * always present, and it is enabled exactly when the server says it can
     * transcode. A hidden button teaches nobody that transcoding exists; a
     * disabled one carrying the server's own reason is what turns a dead
     * control into an install.
     */
    const caps = await page.evaluate(() =>
      fetch('/api/media/capabilities').then((r) => r.json()),
    );

    await page.locator('.asset-bin .panel-toggle').click();
    await page.locator('.asset-bin input[type=file]').setInputFiles({
      name: 'stinger.mov',
      mimeType: 'video/quicktime',
      buffer: Buffer.from('not-really-a-mov'),
    });

    const row = page.locator('.asset-row').filter({ hasText: 'stinger.mov' });
    const button = row.locator('.asset-transcode');

    await expect(button).toHaveCount(1);

    if (caps.available) {
      await expect(button).toBeEnabled();
      await expect(button).toHaveAttribute('title', /transcode/i);
      expect(caps.reason).toBeNull();
    } else {
      await expect(button).toBeDisabled();
      // The reason is the whole point: without it a greyed-out button gets
      // reported as a bug instead of installing ffmpeg.
      await expect(button).toHaveAttribute('title', /ffmpeg|transcod/i);
      expect(caps.reason).toBeTruthy();
    }
  });

  test('offers no transcode on a file that is already WebM', async ({ page }) => {
    // WebM is the output format. Offering to convert one is offering a no-op
    // that costs minutes of CPU.
    await page.locator('.asset-bin .panel-toggle').click();
    await page.locator('.asset-bin input[type=file]').setInputFiles({
      name: 'already.webm',
      mimeType: 'video/webm',
      buffer: Buffer.from('fake-webm'),
    });

    const row = page.locator('.asset-row').filter({ hasText: 'already.webm' });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.asset-transcode')).toHaveCount(0);
  });

  test('warns on a video layer pointing at a format with no alpha', async ({ page }) => {
    /*
     * The defect this phase exists to prevent, and it is otherwise completely
     * silent: an MP4 stinger looks right in the editor, over the editor's own
     * background, and goes to air as a black box over live pictures.
     */
    await page.locator('.add-layer').selectOption('video');
    await page.locator('.properties-panel input[placeholder="assets/logo.png"]')
      .fill('assets/stinger.mp4');
    await expect(page.locator('.properties-panel')).toContainText('cannot carry an alpha channel');
  });

  test('a video layer chooses what happens at the end, unless it loops', async ({ page }) => {
    await page.locator('.add-layer').selectOption('video');

    // Located by their field labels rather than by position: the properties
    // panel grows controls over time, and an index-based locator silently
    // starts pointing at a different input the next time one is added above.
    const field = (name: string) =>
      page.locator('.properties-panel .prop-field').filter({ hasText: name });

    await expect(field('At end').locator('select')).toHaveCount(1);
    await expect(field('At end').locator('select')).toHaveValue('hold');

    // A loop has no end, so the control would do nothing. A dead field is how
    // an author concludes a setting is broken.
    await field('Loop').locator('input[type=checkbox]').check();
    await expect(field('At end')).toHaveCount(0);
  });
});

/**
 * Replace — the same-name upload prompt and what answering it does (0.60.0).
 *
 * The defect underneath is silent by construction: before this, re-uploading a
 * corrected `logo.png` produced a second bin row with the same label and left
 * every graphic pointing at the first. The operator sees the new file appear,
 * concludes the job is done, and the old logo goes to air.
 *
 * **Every test here brings its own project, and gives it back in `afterEach`.**
 * Replace rewrites compositions, and the e2e data directory is thrown away once
 * per run rather than per test — so replacing inside the shared demo would
 * leave rewritten layers behind for `lower-third.spec.ts` to trip over.
 *
 * The cleanup is an `afterEach` rather than a `try/finally` per test because a
 * leaked project does not fail the test that leaked it: `listProjects` sorts by
 * `updatedAt` and the editor opens the first, so an abandoned empty project
 * becomes what *every following test in the file* loads, and they all fail in
 * the shared `beforeEach` waiting for a `.layer-row` that a project with no
 * layers will never render. That is a long way from the cause, and a
 * `try/finally` only helps the tests that remember to write one.
 *
 * **The assertions read the server, not just the screen.** A replace that
 * updated the editor and not `project.json` is exactly the bug this feature is
 * for, and the editor's own copy cannot detect it.
 */
test.describe('replacing an asset', () => {
  const dialog = (page: Page) => page.locator('.conflict-dialog');

  /** Set by `ownProject`, torn down below whether the test passed or not. */
  let ownedProject: string | null = null;

  test.afterEach(async ({ page }) => {
    if (!ownedProject) return;
    await page.request.delete(`/api/projects/${ownedProject}`);
    ownedProject = null;
  });

  /**
   * A project of this test's own, opened in the editor.
   *
   * `listProjects` sorts by `updatedAt` and the editor opens the first, so a
   * reload after creation lands on it.
   */
  async function ownProject(page: Page, label: string): Promise<string> {
    const projectId = `${label}-${Date.now()}`;
    const created = await page.request.post('/api/projects', {
    data: { name: label, id: projectId },
    });
    expect(created.status()).toBe(201);
    ownedProject = projectId;

    await page.goto('/editor/');
    await expect(page.locator('.app-bar select').first()).toHaveValue(projectId);
    return projectId;
  }

  /** Open the bin if it is folded — `.asset-row` lives inside the folded region. */
  async function openBin(page: Page): Promise<void> {
    const bin = page.locator('.asset-bin');
    if (await bin.getAttribute('data-collapsed')) await bin.locator('.panel-toggle').click();
  }

  /** Pick files without asserting anything, so a conflict is free to appear. */
  async function pick(page: Page, files: Array<{ name: string; bytes: string }>): Promise<void> {
    await openBin(page);
    await page.locator('.asset-bin input[type=file]').setInputFiles(
    files.map((f) => ({
      name: f.name,
      mimeType: 'image/png',
      buffer: Buffer.from(f.bytes),
    })),
    );
  }

  /** Upload expecting no prompt, and wait for the row so the next step is not racing it. */
  async function upload(page: Page, name: string, bytes: string): Promise<void> {
    await pick(page, [{ name, bytes }]);
    await expect(page.locator('.asset-row').filter({ hasText: name })).toHaveCount(1);
  }

  const save = async (page: Page) => {
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  };

  /** Every asset path the saved project references, straight from the API. */
  async function savedSrcs(page: Page, projectId: string): Promise<string[]> {
    const project = await (await page.request.get(`/api/projects/${projectId}`)).json();
    const out: string[] = [];
    const walk = (layers: Array<Record<string, unknown>>): void => {
    for (const layer of layers) {
      if (typeof layer['src'] === 'string' && layer['src']) out.push(layer['src'] as string);
      if (Array.isArray(layer['children'])) walk(layer['children'] as typeof layers);
    }
    };
    for (const comp of project.compositions) walk(comp.layers);
    return out;
  }

  /** The path field on the selected layer — what the layer actually points at. */
  const pathField = (page: Page) =>
    page.locator('.properties-panel input[placeholder="assets/logo.png"]');

  test('asks only when the name matches and the bytes differ', async ({ page }) => {
    /*
     * The pairing is what stops this passing vacuously. If the dialog never
     * rendered at all, the first half fails; if it rendered unconditionally,
     * the second half fails. Either assertion alone is satisfied by a broken
     * implementation.
     */
    await ownProject(page, 'replace-asks');
    await upload(page, 'bug.png', 'v1');

    // Same name, different bytes — a corrected logo, the case worth asking about.
    await pick(page, [{ name: 'bug.png', bytes: 'v2' }]);
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('already here');
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();

    // A name nobody has used goes straight through, with no prompt at all.
    await pick(page, [{ name: 'unrelated.png', bytes: 'x' }]);
    await expect(page.locator('.asset-row').filter({ hasText: 'unrelated.png' })).toHaveCount(1);
    await expect(dialog(page)).toHaveCount(0);
  });

  test('re-dropping identical bytes still asks, and Replace is then a no-op', async ({ page }) => {
    /*
     * The browser cannot know the content hash without reading the whole file,
     * which for a 400 MB stinger costs more than the click it would save — so
     * the prompt is about names and a genuine re-drop does raise it.
     *
     * What has to hold is that answering it is harmless. This drives the
     * server's identical-bytes guard through the UI: nothing is retired,
     * nothing is reported as rewritten, and the bin still has one row.
     */
    await ownProject(page, 'replace-noop');
    await upload(page, 'same.png', 'unchanged');

    await pick(page, [{ name: 'same.png', bytes: 'unchanged' }]);
    await expect(dialog(page)).toBeVisible();
    // The one cheap signal the browser does have, surfaced so the operator can
    // usually tell on sight.
    await expect(dialog(page)).toContainText('same size');

    await dialog(page).getByRole('button', { name: /^Upload 1 file$/ }).click();
    await expect(dialog(page)).toHaveCount(0);

    const rows = page.locator('.asset-row').filter({ hasText: 'same.png' });
    await expect(rows).toHaveCount(1);
    await expect(rows.filter({ hasText: 'retired' })).toHaveCount(0);
    // No replacement happened, so nothing claims one did.
    await expect(page.locator('.asset-replaced')).toHaveCount(0);
  });

  test('canceling uploads nothing at all', async ({ page }) => {
    // The drop is held before the first byte leaves, so cancel has to be total
    // — not "the colliding one was skipped and the rest went".
    await ownProject(page, 'replace-cancel');
    await upload(page, 'held.png', 'v1');

    await pick(page, [
      { name: 'held.png', bytes: 'v2' },
      { name: 'tagalong.png', bytes: 'y' },
    ]);
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('1 other file');

    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toHaveCount(0);

    await expect(page.locator('.asset-row').filter({ hasText: 'held.png' })).toHaveCount(1);
    // The clean file in the same drop must not have landed either.
    await expect(page.locator('.asset-row').filter({ hasText: 'tagalong.png' })).toHaveCount(0);
  });

  test('Replace repoints the layer that was using the old file', async ({ page }) => {
    const projectId = await ownProject(page, 'replace-repoints');

    await upload(page, 'logo.png', 'v1');

    await page.locator('.add-layer').selectOption('image');
    await page
      .locator('.properties-panel select')
      .filter({ hasText: 'logo.png' })
      .selectOption({ label: 'logo.png' });

    const before = await pathField(page).inputValue();
    expect(before).toMatch(/^assets\/logo-[0-9a-f]{8}\.png$/);
    await save(page);

    // Proves the starting state rather than assuming it — without this the
    // "not contain before" assertion below could hold because the layer
    // never referenced anything.
    expect(await savedSrcs(page, projectId)).toContain(before);

    await pick(page, [{ name: 'logo.png', bytes: 'v2' }]);
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole('button', { name: /^Upload 1 file$/ }).click();

    // The editor's own copy moved, without a save and without a reload.
    await expect(pathField(page)).not.toHaveValue(before);
    const after = await pathField(page).inputValue();
    expect(after).toMatch(/^assets\/logo-[0-9a-f]{8}\.png$/);

    // And so did the document on disk, which is the claim that matters.
    const srcs = await savedSrcs(page, projectId);
    expect(srcs).toContain(after);
    expect(srcs).not.toContain(before);

    // Said out loud, because the rewrite can reach compositions off screen.
    await expect(page.locator('.asset-replaced')).toContainText('repointed 1 layer');
  });

  test('the superseded file is retired, not deleted, and leaves the picker', async ({ page }) => {
    const projectId = await ownProject(page, 'replace-retires');

    await upload(page, 'sponsor.png', 'v1');
    await pick(page, [{ name: 'sponsor.png', bytes: 'v2' }]);
    await dialog(page).getByRole('button', { name: /^Upload 1 file$/ }).click();
    await expect(dialog(page)).toHaveCount(0);

    // Both rows survive — the point of retiring rather than deleting is that
    // a replace done to the wrong file before a show is recoverable.
    const rows = page.locator('.asset-row').filter({ hasText: 'sponsor.png' });
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'retired' })).toHaveCount(1);

    // The bytes are still served, not just listed.
    const assets = await (await page.request.get(`/api/projects/${projectId}/assets`)).json();
    const retired = assets.assets.find((a: { state?: string }) => a.state === 'retired');
    expect(retired).toBeTruthy();
    expect((await page.request.get(`/assets/${projectId}/${retired.path.replace('assets/', '')}`)).status())
      .toBe(200);

    /*
     * But the picker offers one of them, not two. Two options with the same
     * label — one of them the file just superseded — is the confusion this
     * whole feature exists to end.
     */
    await page.locator('.add-layer').selectOption('image');
    const options = page.locator('.properties-panel select option', { hasText: 'sponsor.png' });
    await expect(options).toHaveCount(1);
  });

  test('Upload as new keeps both files and leaves the layer where it was', async ({ page }) => {
    /*
     * The control for the repoint test. Without it, that one could pass because
     * *any* upload rewrote references — this is what pins the rewrite to the
     * Replace choice specifically.
     */
    const projectId = await ownProject(page, 'replace-keeps-both');

    await upload(page, 'plate.png', 'v1');

    await page.locator('.add-layer').selectOption('image');
    await page
      .locator('.properties-panel select')
      .filter({ hasText: 'plate.png' })
      .selectOption({ label: 'plate.png' });
    const before = await pathField(page).inputValue();
    await save(page);

    await pick(page, [{ name: 'plate.png', bytes: 'v2' }]);
    await dialog(page).locator('.conflict-modes label', { hasText: 'Upload as new' }).click();
    await dialog(page).getByRole('button', { name: /^Upload 1 file$/ }).click();
    await expect(dialog(page)).toHaveCount(0);

    // Two live rows, and the layer is untouched.
    const rows = page.locator('.asset-row').filter({ hasText: 'plate.png' });
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'retired' })).toHaveCount(0);
    await expect(pathField(page)).toHaveValue(before);
    expect(await savedSrcs(page, projectId)).toContain(before);

    // No replace happened, so there is nothing to report.
    await expect(page.locator('.asset-replaced')).toHaveCount(0);
  });

  test('asks once for a whole drop, and honours a per-file override', async ({ page }) => {
    /*
     * The reason the batch choice is the headline: an operator re-exporting a
     * set of corrected sponsor logos means the same thing about all of them,
     * and a modal per file is how a feature gets worked around — by renaming
     * files, which is the mess this exists to prevent.
     */
    await ownProject(page, 'replace-batch');

    await upload(page, 'alpha.png', 'a1');
    await upload(page, 'beta.png', 'b1');

    await pick(page, [
      { name: 'alpha.png', bytes: 'a2' },
      { name: 'beta.png', bytes: 'b2' },
    ]);

    // One dialog, two rows — not two dialogs.
    await expect(dialog(page)).toHaveCount(1);
    const items = dialog(page).locator('.conflict-list li');
    await expect(items).toHaveCount(2);
    // Asserted per row: `toHaveAttribute` against a multi-element locator is a
    // strict-mode violation, not a claim about every match.
    await expect(items.filter({ hasText: 'alpha.png' })).toHaveAttribute('data-choice', 'replace');
    await expect(items.filter({ hasText: 'beta.png' })).toHaveAttribute('data-choice', 'replace');

    // Override just beta: the batch stays Replace, this one becomes new.
    const beta = items.filter({ hasText: 'beta.png' });
    await beta.locator('.conflict-override').click();
    await expect(beta).toHaveAttribute('data-choice', 'new');
    await expect(items.filter({ hasText: 'alpha.png' })).toHaveAttribute('data-choice', 'replace');
    await expect(dialog(page)).toContainText('1 of 2 will be replaced');

    await dialog(page).getByRole('button', { name: /^Upload 2 files$/ }).click();
    await expect(dialog(page)).toHaveCount(0);

    // alpha was replaced — one retired. beta was not — two live rows.
    const alphaRows = page.locator('.asset-row').filter({ hasText: 'alpha.png' });
    const betaRows = page.locator('.asset-row').filter({ hasText: 'beta.png' });
    await expect(alphaRows).toHaveCount(2);
    await expect(alphaRows.filter({ hasText: 'retired' })).toHaveCount(1);
    await expect(betaRows).toHaveCount(2);
    await expect(betaRows.filter({ hasText: 'retired' })).toHaveCount(0);
  });

  test('rewrites a reference inside a group, not just at the top level', async ({ page }) => {
    /*
     * A group is the container a flat walk misses — a badge inside a standings
     * row is the realistic case — and the reference is invisible from the top
     * of the layer list.
     *
     * The nesting is seeded over the API because the editor has no
     * group-the-selection command: `addLayer('group')` makes an empty one and
     * re-parenting is a drag. The *replace* still goes through the UI, so the
     * editor's own in-memory rewrite is under test — that is the half a
     * server-side unit test cannot reach.
     */
    const projectId = await ownProject(page, 'replace-grouped');

    await upload(page, 'badge.png', 'g1');

    const assets = await (await page.request.get(`/api/projects/${projectId}/assets`)).json();
    const before = assets.assets.find(
      (a: { originalName?: string }) => a.originalName === 'badge.png',
    ).path;

    const project = await (await page.request.get(`/api/projects/${projectId}`)).json();
    const comp = project.compositions[0];
    const saved = await page.request.put(
      `/api/projects/${projectId}/compositions/${comp.id}`,
      {
        data: {
          ...comp,
          layers: [
            {
              id: 'wrapper',
              type: 'group',
              name: 'Wrapper',
              children: [{ id: 'nested-badge', type: 'image', name: 'Nested badge', src: before }],
            },
          ],
        },
      },
    );
    expect(saved.status()).toBe(200);

    // Reload so the editor is holding the nested document, then select the
    // child — the assertion below is about the panel, so it has to be shown.
    await page.goto('/editor/');
    await page.locator('.layer-row', { hasText: 'Nested badge' }).first().click();
    await expect(pathField(page)).toHaveValue(before);

    await pick(page, [{ name: 'badge.png', bytes: 'g2' }]);
    await dialog(page).getByRole('button', { name: /^Upload 1 file$/ }).click();
    await expect(page.locator('.asset-replaced')).toContainText('repointed 1 layer');

    // The editor's copy of a layer one level down moved...
    await expect(pathField(page)).not.toHaveValue(before);

    // ...and so did the document on disk.
    const srcs = await savedSrcs(page, projectId);
    expect(srcs).toHaveLength(1);
    expect(srcs).not.toContain(before);
  });
});
