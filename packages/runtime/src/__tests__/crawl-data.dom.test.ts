// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Crawl layers fed from a data source — the Wave-2 pairing of an RSS feed with
 * a ticker.
 *
 * Two seams, tested separately because they fail differently.
 *
 * `crawlItemsFrom` is the *derivation*: which column, which rows, and what
 * happens when the answer is empty. Pure, so it is tested directly.
 *
 * The runtime tests cover *delivery*: that a DataSet present at build time
 * reaches the ticker before anything plays, and that a push arriving later is
 * queued rather than painted over live copy. That second one is a guarantee
 * worth pinning rather than an implementation detail — it is the whole reason
 * `setItems` exists in the shape it does.
 */

import { describe, expect, it } from 'vitest';
import {
  DATA_UPDATE_KEY,
  createComposition,
  type Composition,
  type CrawlLayer,
  type DataSet,
  type DataTransform,
} from '@breeze/schema';

import { crawlItemsFrom } from '../crawl.js';
import { BreezeRuntime } from '../runtime.js';

const TYPED = ['Typed one', 'Typed two'];

function crawlLayer(overrides: Partial<CrawlLayer> = {}): CrawlLayer {
  return {
    id: 'ticker',
    name: 'Ticker',
    type: 'crawl',
    position: { x: 0, y: 0 },
    size: { width: 800, height: 60 },
    speed: 120,
    direction: 'left',
    separator: ' | ',
    items: [...TYPED],
    style: { fontFamily: 'sans-serif', fontSize: 32, fill: '#fff' },
    ...overrides,
  } as CrawlLayer;
}

const feed = (titles: string[]): DataSet => ({
  id: 'news',
  columns: [
    { key: 'title', type: 'string' },
    { key: 'category', type: 'string' },
  ],
  rows: titles.map((title, i) => ({ title, category: i % 2 === 0 ? 'sport' : 'weather' })),
});

/* ------------------------------------------------------------ derivation */

describe('crawlItemsFrom', () => {
  it('reads the named column', () => {
    const items = crawlItemsFrom(feed(['Mesa wins', 'Tempe rallies']), crawlLayer({ column: 'title' }));
    expect(items).toEqual(['Mesa wins', 'Tempe rallies']);
  });

  it('keeps the typed items until a column is chosen', () => {
    // A half-configured layer must not empty the strip; the properties panel
    // warns about it in the meantime.
    expect(crawlItemsFrom(feed(['Mesa wins']), crawlLayer())).toEqual(TYPED);
  });

  it('applies the transform pipeline before reading the column', () => {
    const transforms: DataTransform[] = [
      { op: 'filter', key: 'category', cmp: 'eq', value: 'sport' },
      { op: 'limit', n: 2 },
    ];
    const items = crawlItemsFrom(
      feed(['A sport', 'B weather', 'C sport', 'D weather', 'E sport']),
      crawlLayer({ column: 'title', transforms }),
    );
    expect(items).toEqual(['A sport', 'C sport']);
  });

  it('skips empty cells rather than crawling a gap between separators', () => {
    // An untitled entry is common in real feeds, and a blank item renders as
    // " |  | " — which reads as a broken ticker, not a missing headline.
    const items = crawlItemsFrom(feed(['Mesa wins', '', '  ', 'Tempe']), crawlLayer({ column: 'title' }));
    expect(items).toEqual(['Mesa wins', 'Tempe']);
  });

  it('skips nulls without printing "null"', () => {
    const data: DataSet = {
      id: 'news',
      columns: [{ key: 'title', type: 'string' }],
      rows: [{ title: 'Real' }, { title: null }],
    };
    expect(crawlItemsFrom(data, crawlLayer({ column: 'title' }))).toEqual(['Real']);
  });

  it('falls back to the authored items when the feed answers with nothing', () => {
    /*
     * Rule 1 of the data layer, applied to the ticker. The server retains
     * last-good rows across an *outage*, but a feed that answers successfully
     * with zero entries gets past that — and an empty crawl is a blank strip
     * on air.
     */
    expect(crawlItemsFrom(feed([]), crawlLayer({ column: 'title' }))).toEqual(TYPED);
  });

  it('falls back when the column exists but every cell is empty', () => {
    expect(crawlItemsFrom(feed(['', '']), crawlLayer({ column: 'title' }))).toEqual(TYPED);
  });

  it('falls back when the named column is not in the DataSet at all', () => {
    // A feed that dropped a field, or a column key typed by hand. Either way
    // the ticker keeps working.
    expect(crawlItemsFrom(feed(['Mesa']), crawlLayer({ column: 'headline' }))).toEqual(TYPED);
  });
});

/* -------------------------------------------------------------- delivery */

function comp(layer: CrawlLayer): Composition {
  return createComposition({ id: 'news', name: 'News', duration: 2, layers: [layer] });
}

function mount(composition: Composition, data?: Record<string, unknown>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const runtime = new BreezeRuntime({
    container,
    composition,
    injectStyles: false,
    ...(data ? { data } : {}),
  });
  return { runtime, container };
}

/** What the ticker is currently showing, as a list of items. */
function headlines(container: HTMLElement): string[] {
  const text = container.querySelector<HTMLElement>('.bz-crawl-block')?.textContent ?? '';
  return text.split(' | ').map((s) => s.trim()).filter(Boolean);
}

describe('crawl delivery', () => {
  it('shows the typed items when no source is set', () => {
    const { runtime, container } = mount(comp(crawlLayer()));
    expect(headlines(container)).toEqual(TYPED);
    runtime.destroy();
  });

  it('is built from a DataSet present in the boot payload', () => {
    /*
     * The regression this exists for: `build()` fills the crawl, and it runs
     * *before* the constructor's `update()` call — so a source-fed ticker was
     * built from its placeholder and then had the real headlines queued behind
     * a rotation that, sitting at frame 0, never came. The /play page inlines
     * current datasets into its boot payload precisely so a graphic is never
     * briefly wrong on load, and that only pays off if they are unpacked before
     * the build rather than after it.
     */
    const layer = crawlLayer({ source: 'news', column: 'title' });
    const { runtime, container } = mount(comp(layer), {
      [DATA_UPDATE_KEY]: { news: feed(['Mesa wins', 'Tempe rallies']) },
    });

    expect(headlines(container)).toEqual(['Mesa wins', 'Tempe rallies']);
    runtime.destroy();
  });

  it('applies transforms to the boot payload too', () => {
    const layer = crawlLayer({
      source: 'news',
      column: 'title',
      transforms: [{ op: 'filter', key: 'category', cmp: 'eq', value: 'sport' }],
    });
    const { runtime, container } = mount(comp(layer), {
      [DATA_UPDATE_KEY]: { news: feed(['A sport', 'B weather', 'C sport']) },
    });

    expect(headlines(container)).toEqual(['A sport', 'C sport']);
    runtime.destroy();
  });

  it('ignores a boot payload for a different source', () => {
    const layer = crawlLayer({ source: 'news', column: 'title' });
    const { runtime, container } = mount(comp(layer), {
      [DATA_UPDATE_KEY]: { standings: feed(['Not mine']) },
    });

    expect(headlines(container)).toEqual(TYPED);
    runtime.destroy();
  });

  it('queues a later push instead of repainting live copy', () => {
    /*
     * A data tick goes through the same `setItems` as an operator edit and
     * inherits the same guarantee: new copy scrolls in at the loop seam, it
     * never appears in place. So the DOM deliberately still shows the old
     * headlines immediately after the push — asserting that it does *not*
     * change is the point of this test, not a limitation of it.
     */
    const layer = crawlLayer({ source: 'news', column: 'title' });
    const { runtime, container } = mount(comp(layer), {
      [DATA_UPDATE_KEY]: { news: feed(['First edition']) },
    });
    expect(headlines(container)).toEqual(['First edition']);

    runtime.update({ [DATA_UPDATE_KEY]: { news: feed(['Second edition']) } });
    expect(headlines(container)).toEqual(['First edition']);

    runtime.destroy();
  });
});
