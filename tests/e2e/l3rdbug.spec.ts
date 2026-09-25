// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 6.5 acceptance: two graphics from **one** browser source, triggering
 * independently, with `clear-all` taking the page down in one call.
 *
 * The last acceptance criterion in the project that unit and route tests could
 * not reach. `scenes.test.ts` proves the hub filters by channel and `expand.ts`
 * proves an `independent` layer is not flattened — but both run through
 * `app.inject`, which never mounts a runtime and never opens a socket. What is
 * only true in a browser is that `player.ts` builds *separate live surfaces*
 * and that a per-channel dispatch reaches exactly one of them.
 *
 * **The assertion trap this file exists to avoid.** An element that has never
 * played and one that has finished its outro both compute to `opacity: 0`. So
 * "the bug is invisible after I played the lower third" is a statement that is
 * true whether or not the bug was wrongly triggered, and a test built on it
 * cannot fail. Independence is therefore asserted on `playbackState` — `idle`
 * versus `finished` are different words for the same pixels — and backed by the
 * *inline* style, which the runtime only writes once it has touched an element.
 *
 * The scene is `demo-1iixd / l3rdbug-97rif`, seeded from `examples/breeze-demo.json`.
 * Its two children take no explicit `channel`, so each answers on its own
 * `ref`: `l3rd-name-2a94g` and `screen-bug-8vctv`.
 */

const SCENE_URL = '/play/demo-1iixd/l3rdbug-97rif?autoplay=0';

const LOWER_THIRD = 'l3rd-name-2a94g';
const BUG = 'screen-bug-8vctv';

/** Playback state of one scene element, by channel. */
async function elementState(page: Page, channel: string): Promise<string> {
  return page.evaluate((ch) => {
    const globals = (window as any).breeze?.elements?.get(ch);
    if (!globals) throw new Error(`no scene element on channel "${ch}"`);
    return globals.runtime.playbackState as string;
  }, channel);
}

/**
 * Playhead of one scene element, in seconds.
 *
 * The second signal, alongside `playbackState`. An element that has never been
 * triggered sits at 0; one that has played is somewhere past it. Together the
 * two say "not started" in a way neither says alone.
 *
 * **This replaced an inline-style check, which was wrong here.** The Phase 5
 * lesson is that computed opacity cannot separate "never played" from
 * "finished", and that inline style can — but the mechanism behind that does
 * not transfer to a scene. `build()` ends in `renderAt(0)`, which scrubs the
 * GSAP timeline to zero, and GSAP writes inline styles whenever it renders. So
 * on a scene page *every* layer of *every* element carries an inline opacity
 * from mount onward, and "has an inline style" answers "has this been built",
 * not "has this been played". The rule survives; the proxy for it did not.
 */
async function elementTime(page: Page, channel: string): Promise<number> {
  return page.evaluate((ch) => {
    const globals = (window as any).breeze?.elements?.get(ch);
    if (!globals) throw new Error(`no scene element on channel "${ch}"`);
    return globals.runtime.currentTime as number;
  }, channel);
}

/** Drive one element through the control API, the way a Stream Deck would. */
async function control(page: Page, channel: string, verb: string): Promise<void> {
  const res = await page.request.post(`/api/control/demo-1iixd/${channel}/${verb}`);
  expect(res.ok(), `${verb} on ${channel} should be accepted`).toBe(true);
}

/**
 * Wait until an element's playhead has actually advanced.
 *
 * **State leads time by a frame, and the gap is observable.** `play()` sets
 * `playbackState` to `playing-in` and starts the timeline synchronously, but
 * `currentTime` reads the GSAP timeline, which stays at 0 until the first tick
 * renders. Waiting only for the state and then *sampling* the time is a race
 * that a fast machine loses — it passed locally every run and failed on CI,
 * where headless Chromium's frame scheduling is less generous.
 *
 * Polled rather than slept: the wait is over when the thing being waited for is
 * true, not when a guessed interval expires.
 */
async function waitForRolling(page: Page, channel: string): Promise<void> {
  await page.waitForFunction(
    (ch) => {
      const runtime = (window as any).breeze?.elements?.get(ch)?.runtime;
      return Boolean(runtime) && runtime.playbackState !== 'idle' && runtime.currentTime > 0;
    },
    channel,
    { timeout: 10_000 },
  );
}

/**
 * Wait until the hub has a renderer registered on every channel named.
 *
 * **A mounted runtime is not a connected one, and the gap is a real race.** The
 * page builds each element's runtime and *then* opens its socket, so
 * `breeze.elements.size === 2` is true a moment before the second element can
 * receive anything. A control POST in that window is accepted — `dispatch`
 * filters renderers by channel and simply finds none — so the request returns
 * 200 and the graphic never moves.
 *
 * It surfaced asymmetrically, which is what made it look like a bug in the app
 * rather than in the test: the lower third mounts first and connects first, so
 * "play the lower third" was reliably fine while its mirror twin timed out.
 *
 * Asked of the *server* rather than the page. Whether a socket is open is the
 * hub's fact, not the browser's, and a client-side flag would be asserting that
 * we asked to connect rather than that anyone is listening.
 */
async function waitForHub(page: Page, channels: string[]): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/status');
        if (!res.ok()) return false;
        const body = (await res.json()) as {
          viewers: { channels: Array<{ channel: string; renderers: number }> };
        };
        const live = new Set(
          body.viewers.channels.filter((c) => c.renderers > 0).map((c) => c.channel),
        );
        return channels.every((c) => live.has(c));
      },
      { timeout: 10_000, message: `hub never registered renderers on ${channels.join(', ')}` },
    )
    .toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.goto(SCENE_URL);
  await page.waitForFunction(() => Boolean((window as any).breeze));
  // Both elements must have mounted before anything is asserted about them;
  // a scene that mounted one runtime would otherwise pass half these tests.
  await page.waitForFunction(() => (window as any).breeze.elements.size === 2);
  // …and be reachable, which is a later moment than being mounted.
  await waitForHub(page, [`demo-1iixd/${LOWER_THIRD}`, `demo-1iixd/${BUG}`, 'demo-1iixd/l3rdbug-97rif']);
});

test.describe('the scene mounts', () => {
  test('builds one runtime per independent element, plus the scene itself', async ({ page }) => {
    const channels = await page.evaluate(() => [...(window as any).breeze.elements.keys()]);
    expect(channels.sort()).toEqual([LOWER_THIRD, BUG].sort());

    // The scene's own runtime is separate from its elements' — it owns whatever
    // is not independent, a shared plate or band.
    const sceneState = await page.evaluate(() => (window as any).breeze.runtime.playbackState);
    expect(sceneState).toBe('idle');
  });

  test('gives each element its own container', async ({ page }) => {
    for (const channel of [LOWER_THIRD, BUG]) {
      await expect(page.locator(`[data-breeze-channel="${channel}"]`)).toHaveCount(1);
    }
  });
});

test.describe('nothing goes to air on load', () => {
  test('opening the scene URL leaves both elements idle', async ({ page }) => {
    // Adding the Browser Source in OBS, or opening the URL to check it, must
    // not put two graphics on air at once.
    await page.goto('/play/demo-1iixd/l3rdbug-97rif');
    await page.waitForFunction(() => (window as any).breeze?.elements?.size === 2);
    await page.waitForTimeout(900); // longer than either intro

    expect(await elementState(page, LOWER_THIRD)).toBe('idle');
    expect(await elementState(page, BUG)).toBe('idle');
    // Parked at the start, not merely invisible.
    expect(await elementTime(page, LOWER_THIRD)).toBe(0);
    expect(await elementTime(page, BUG)).toBe(0);
  });
});

test.describe('the elements trigger independently', () => {
  test('playing the lower third leaves the bug untouched', async ({ page }) => {
    await control(page, LOWER_THIRD, 'play');

    /*
     * The positive control, and it comes first now.
     *
     * Waiting for the lower third to be genuinely rolling is what proves the
     * play arrived — without it the rest of this test would pass on a page
     * where nothing was dispatched at all, which is the vacuous shape the whole
     * file exists to avoid. Making it the wait rather than a later assertion
     * also removes the frame-boundary race: by the time the bug is checked, the
     * scene has definitely ticked.
     */
    await waitForRolling(page, LOWER_THIRD);

    /*
     * `idle`, not "invisible". The bug is invisible either way — before it has
     * played and after it has finished — so only the state distinguishes a
     * scene that dispatched correctly from one that played both.
     */
    expect(await elementState(page, BUG)).toBe('idle');
    expect(await elementTime(page, BUG)).toBe(0);
  });

  test('playing the bug leaves the lower third untouched', async ({ page }) => {
    // The mirror case. Dispatch that happened to favour the first-mounted
    // element would pass the test above and fail this one.
    await control(page, BUG, 'play');
    await waitForRolling(page, BUG);

    expect(await elementState(page, LOWER_THIRD)).toBe('idle');
    expect(await elementTime(page, LOWER_THIRD)).toBe(0);
  });

  test('both can be on air at once, each at its own point', async ({ page }) => {
    await control(page, LOWER_THIRD, 'play');
    // Started deliberately apart, so the two playheads cannot coincide.
    await page.waitForTimeout(250);
    await control(page, BUG, 'play');

    /*
     * Both genuinely rolling before either is read.
     *
     * Waiting only for `playbackState !== 'idle'` would let this sample two
     * playheads that are both still 0 — the same frame-boundary race that broke
     * the sibling test on CI — and `|0 − 0| > 0.05` fails for a reason that has
     * nothing to do with what is being tested.
     */
    await waitForRolling(page, LOWER_THIRD);
    await waitForRolling(page, BUG);

    // Read in one evaluate, so the two are sampled from the same frame: read
    // separately, the gap between the calls is itself part of the difference.
    const [a, b] = await page.evaluate(() => {
      const els = (window as any).breeze.elements;
      return [
        els.get('l3rd-name-2a94g').runtime.currentTime as number,
        els.get('screen-bug-8vctv').runtime.currentTime as number,
      ];
    });

    // The same runtime driving both would report one time for both.
    expect(Math.abs(a - b)).toBeGreaterThan(0.05);
  });
});

test.describe('holding and stepping, per element', () => {
  test('each element holds at its own stop marker', async ({ page }) => {
    /*
     * The half the manual pass did not reach. Both children carry a stop at
     * 1.5s, and a scene that shared one timeline would hold both together —
     * which looks correct until an operator holds one graphic and loses the
     * other.
     */
    await control(page, LOWER_THIRD, 'play');
    await page.waitForFunction(
      (ch) => (window as any).breeze.elements.get(ch).runtime.playbackState === 'holding',
      LOWER_THIRD,
      { timeout: 5000 },
    );

    expect(await elementState(page, LOWER_THIRD)).toBe('holding');
    expect(await elementState(page, BUG)).toBe('idle');
  });

  test('next releases only the element it was sent to', async ({ page }) => {
    await control(page, LOWER_THIRD, 'play');
    await page.waitForFunction(
      (ch) => (window as any).breeze.elements.get(ch).runtime.playbackState === 'holding',
      LOWER_THIRD,
      { timeout: 5000 },
    );
    await control(page, BUG, 'play');
    await page.waitForFunction(
      (ch) => (window as any).breeze.elements.get(ch).runtime.playbackState === 'holding',
      BUG,
      { timeout: 5000 },
    );

    await control(page, LOWER_THIRD, 'next');
    await page.waitForFunction(
      (ch) => (window as any).breeze.elements.get(ch).runtime.playbackState !== 'holding',
      LOWER_THIRD,
    );

    // The bug stays held. Releasing both on one button is the failure an
    // operator discovers with a graphic still on air.
    expect(await elementState(page, BUG)).toBe('holding');
  });
});

test.describe('clear-all', () => {
  test('takes the whole page down in one call', async ({ page }) => {
    await control(page, LOWER_THIRD, 'play');
    await control(page, BUG, 'play');
    await page.waitForFunction(
      () =>
        ['l3rd-name-2a94g', 'screen-bug-8vctv'].every(
          (ch) => (window as any).breeze.elements.get(ch).runtime.playbackState !== 'idle',
        ),
    );

    // Addressed to the scene, not to either element — one operator action.
    const res = await page.request.post('/api/control/demo-1iixd/l3rdbug-97rif/clear-all');
    expect(res.ok()).toBe(true);

    await page.waitForFunction(
      () =>
        ['l3rd-name-2a94g', 'screen-bug-8vctv'].every(
          (ch) => (window as any).breeze.elements.get(ch).runtime.playbackState === 'idle',
        ),
      undefined,
      { timeout: 5000 },
    );

    expect(await elementState(page, LOWER_THIRD)).toBe('idle');
    expect(await elementState(page, BUG)).toBe('idle');
  });

  test('reports which channels it reached', async ({ page }) => {
    await control(page, LOWER_THIRD, 'play');
    const res = await page.request.post('/api/control/demo-1iixd/l3rdbug-97rif/clear-all');
    const body = (await res.json()) as { channels: string[] };

    /*
     * Channels are reported fully qualified — `demo-1iixd/l3rd-name-2a94g`, not
     * `l3rd-name-2a94g`. The key is `${projectId}/${name}` throughout the hub, and
     * the bare form only ever appears in the *URL path*, where the project is
     * already a separate segment. Worth asserting in the qualified form rather
     * than normalising it away: two projects can hold a `screen-bug`, and the
     * prefix is the thing that keeps one show's clear-all off another's air.
     */
    expect(body.channels).toEqual(
      expect.arrayContaining([`demo-1iixd/${LOWER_THIRD}`, `demo-1iixd/${BUG}`]),
    );

    // The scene's own channel too, since it owns whatever is not independent —
    // a shared plate left up by a clear-all is still a graphic on air.
    expect(body.channels).toContain('demo-1iixd/l3rdbug-97rif');
  });
});
