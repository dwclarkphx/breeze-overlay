// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Wave 8: the media layer's player, and a media cell in a cycling table — the
 * camera rotation. No network here: loads and failures are dispatched by hand,
 * which is also the only way to make them happen on a known frame.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gsap } from 'gsap';
import {
  DATA_UPDATE_KEY,
  createComposition,
  createLayer,
  createTableLayer,
  type Composition,
  type DataSet,
  type Layer,
  type MediaLayer,
} from '@breeze/schema';

import { MediaPlayer, playerOf, preloadMedia, resetMediaPreloads, snapshotUrl, stopMediaIn } from '../media.js';
import { BreezeRuntime } from '../runtime.js';

function media(overrides: Partial<MediaLayer> = {}): MediaLayer {
  return { ...(createLayer('media') as MediaLayer), id: 'cam', size: { width: 640, height: 360 }, ...overrides };
}

function player(layer: MediaLayer, still = false): { player: MediaPlayer; host: HTMLElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const p = new MediaPlayer({ layer, host, env: { doc: document, resolveAsset: (s) => `/assets/p/${s}`, still } });
  return { player: p, host };
}

const imgs = (host: Element) => [...host.querySelectorAll('img')];
const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
  resetMediaPreloads();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('the player', () => {
  it('double-buffers a refreshing snapshot: the next picture swaps in only once it has loaded', () => {
    const { player: p, host } = player(media({ refresh: 10 }));
    p.show('https://cam.example/snap.jpg');
    expect(p.kind).toBe('image');
    expect(host.dataset['state']).toBe('loading');
    const [a, b] = imgs(host);
    expect(b!.getAttribute('src')).toBe(snapshotUrl('https://cam.example/snap.jpg', 10));
    fire(b!, 'load');
    expect(p.state).toBe('playing');
    expect(b!.className).toBe('bz-media-front');
    expect(a!.className).toBe('bz-media-back');

    vi.advanceTimersByTime(10_000);
    // The next fetch goes to the buffer out of sight, under the next period's URL.
    expect(a!.getAttribute('src')).toBe(snapshotUrl('https://cam.example/snap.jpg', 10));
    expect(a!.getAttribute('src')).not.toBe(b!.getAttribute('src'));
    fire(a!, 'error');
    expect(p.state).toBe('playing');
    vi.advanceTimersByTime(10_000);
    fire(b!, 'error');
    expect(p.state).toBe('failed');
  });

  it('fails a source that shows nothing by its timeout, once, and says why', () => {
    const layer = media({ timeout: 5 });
    const { player: p, host } = player(layer);
    const failed = vi.fn();
    p.onFail = failed;
    p.show('http://cam.example/axis-cgi/mjpg/video.cgi');
    expect(p.kind).toBe('mjpeg');
    vi.advanceTimersByTime(4_900);
    expect(p.state).toBe('loading');
    vi.advanceTimersByTime(200);
    expect(p.state).toBe('failed');
    expect(host.dataset['state']).toBe('failed');
    expect(failed).toHaveBeenCalledTimes(1);
    expect(p.error).toMatch(/5s/);
  });

  it('tries a failed source again when it is shown again', () => {
    const { player: p, host } = player(media());
    p.show('https://cam.example/a.jpg');
    fire(imgs(host)[1]!, 'error');
    expect(p.state).toBe('failed');
    p.show('https://cam.example/a.jpg');
    expect(p.state).toBe('loading');
  });

  it('shows a proxied stream’s last frame while it connects', () => {
    const { player: p, host } = player(media({ fit: 'cover' }));
    p.show('/media/demo/cams/abc123def456/stream');
    expect(host.style.backgroundImage).toContain('/media/demo/cams/abc123def456/snapshot');
    expect(imgs(host)[0]!.getAttribute('src')).toBe('/media/demo/cams/abc123def456/stream');
  });

  it('plays an asset path from the project, and a server path as written', () => {
    const { player: p, host } = player(media());
    p.show('assets/loop.mp4');
    expect(host.querySelector('video')!.getAttribute('src')).toBe('/assets/p/assets/loop.mp4');
    p.show('/media/p/s/k/snapshot');
    expect(imgs(host)[1]!.getAttribute('src')).toBe('/media/p/s/k/snapshot');
  });

  it('embeds YouTube muted with no controls, and fails only on an error it reports', () => {
    const { player: p, host } = player(media({ timeout: 5 }));
    // Out of the document, so the test environment does not try to load the embed.
    host.remove();
    p.show('https://youtu.be/dQw4w9WgXcQ');
    const frame = host.querySelector('iframe')!;
    const src = new URL(frame.getAttribute('src')!);
    expect(src.hostname).toBe('www.youtube-nocookie.com');
    expect(src.pathname).toBe('/embed/dQw4w9WgXcQ');
    expect(src.searchParams.get('mute')).toBe('1');
    expect(src.searchParams.get('controls')).toBe('0');
    expect(src.searchParams.get('playlist')).toBe('dQw4w9WgXcQ');
    // Silence past the timeout is a player that never answered.
    vi.advanceTimersByTime(16_000);
    expect(p.state).toBe('failed');
  });

  it('lets go of the source when stopped — a stream must not stay open', () => {
    const { player: p, host } = player(media());
    p.show('http://cam.example/mjpg/video.mjpg');
    const img = imgs(host)[0]!;
    expect(img.getAttribute('src')).toBeTruthy();
    stopMediaIn(document.body);
    expect(img.hasAttribute('src')).toBe(false);
    expect(host.children).toHaveLength(0);
    expect(playerOf(host)).toBeUndefined();
    void p;
  });

  it('knows a URL a preload found broken, and fails it at once', () => {
    const made: HTMLImageElement[] = [];
    const create = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = create(tag);
      if (tag === 'img') made.push(el as HTMLImageElement);
      return el;
    }) as typeof document.createElement);
    preloadMedia('https://cam.example/dead.jpg', 'image', 10, document);
    spy.mockRestore();
    expect(made[0]!.getAttribute('src')).toBe(snapshotUrl('https://cam.example/dead.jpg', 10));
    made[0]!.onerror?.(new Event('error') as never);

    const { player: p } = player(media());
    p.show('https://cam.example/dead.jpg');
    expect(p.state).toBe('failed');
  });

  it('streams nothing in a still: a snapshot once, a stream’s proxy frame, a YouTube thumbnail', () => {
    const { player: p, host } = player(media({ refresh: 5 }), true);
    p.show('https://cam.example/a.jpg');
    expect(imgs(host).map((i) => i.getAttribute('src'))).toEqual(['https://cam.example/a.jpg']);
    p.show('/media/demo/cams/abc123def456/stream');
    expect(imgs(host).map((i) => i.getAttribute('src'))).toEqual(['/media/demo/cams/abc123def456/snapshot']);
    p.show('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(imgs(host).map((i) => i.getAttribute('src'))).toEqual(['https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg']);
    expect(host.querySelector('iframe, video')).toBeNull();
    p.show('http://cam.example/mjpg/video.mjpg');
    expect(imgs(host)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------- rotation */

const CAMS: DataSet = {
  id: 'cams',
  columns: [
    { key: 'name', type: 'string' },
    { key: 'url', type: 'string' },
  ],
  rows: ['a', 'b', 'c'].map((n) => ({ name: n, url: `https://cam.example/${n}.jpg` })),
};

function rotation(cell: Partial<MediaLayer> = {}, dwell = 10): Composition {
  const table = createTableLayer({
    id: 'rot',
    binding: 'cams',
    source: 'cams',
    size: { width: 640, height: 360 },
    rowsPerPage: 1,
    row: { height: 360, cells: [media({ id: 'pic', cell: 'url', onError: 'skip', timeout: 5, ...cell })] },
    cycle: { dwell },
  });
  return createComposition({ id: 'wx', name: 'wx', duration: 2, markers: [{ type: 'stop', time: 1 }], layers: [table] });
}

let rootTime = 0;
function advance(seconds: number): void {
  rootTime += seconds;
  gsap.updateRoot(rootTime);
}

let runtime: BreezeRuntime | undefined;
function mount(composition: Composition, data: DataSet = CAMS, extra: Record<string, unknown> = {}): BreezeRuntime {
  const container = document.createElement('div');
  document.body.appendChild(container);
  runtime = new BreezeRuntime({
    container,
    composition,
    injectStyles: false,
    data: { [DATA_UPDATE_KEY]: { [data.id]: data }, ...extra },
  });
  return runtime;
}

const shownUrl = () =>
  [...document.querySelectorAll<HTMLImageElement>('.bz-media img')]
    .map((i) => i.getAttribute('src') ?? '')
    .find((s) => s.includes('cam.example'));
const page = (r: BreezeRuntime) => r.getTableRows('rot').map((row) => row['name'])[0];

describe('a camera rotation', () => {
  beforeEach(() => {
    gsap.ticker.lagSmoothing(0);
    rootTime = gsap.globalTimeline.time();
  });
  afterEach(() => {
    runtime?.destroy();
    runtime = undefined;
  });

  function onAir(composition = rotation()): BreezeRuntime {
    const r = mount(composition);
    r.play();
    advance(1.2);
    expect(r.playbackState).toBe('holding');
    return r;
  }

  it('plays each row’s URL as its page comes up', () => {
    const r = onAir();
    expect(page(r)).toBe('a');
    expect(shownUrl()).toBe('https://cam.example/a.jpg');
    vi.advanceTimersByTime(10_010);
    advance(2); // the turn's animation, after which the new row is built
    expect(page(r)).toBe('b');
    expect(shownUrl()).toBe('https://cam.example/b.jpg');
  });

  it('skips a camera that fails, as NEXT would, and not round and round when none plays', () => {
    const r = onAir();
    expect(page(r)).toBe('a');
    const failAndTurn = () => {
      vi.advanceTimersByTime(5_010);
      advance(2);
    };
    failAndTurn();
    expect(page(r)).toBe('b');
    failAndTurn();
    expect(page(r)).toBe('c');
    failAndTurn();
    // A lap of failures: it rests on the page it reached rather than spinning.
    const rested = page(r);
    failAndTurn();
    expect(page(r)).toBe(rested);
  });

  it('starts a fresh lap once something plays', () => {
    const r = onAir();
    vi.advanceTimersByTime(5_010); // a fails → b
    advance(2);
    expect(page(r)).toBe('b');
    const loading = [...document.querySelectorAll<HTMLImageElement>('.bz-media img')].find((i) =>
      i.getAttribute('src')?.startsWith('https://cam.example/b.jpg'),
    )!;
    fire(loading, 'load'); // b plays
    vi.advanceTimersByTime(10_010); // dwell → c
    advance(2);
    expect(page(r)).toBe('c');
    vi.advanceTimersByTime(5_010); // c fails → skip
    advance(2);
    expect(page(r)).not.toBe('c');
  });

  it('does not skip for a row that is leaving mid-turn', () => {
    const r = onAir(rotation({ timeout: 11 }));
    vi.advanceTimersByTime(10_010); // a still loading when its page ends: the turn starts
    expect(page(r)).toBe('b');
    vi.advanceTimersByTime(1_000); // a's timeout lands while it animates out
    advance(2);
    expect(page(r)).toBe('b');
  });

  it('turns a whole cycle group when one member skips', () => {
    const second = createTableLayer({
      id: 'caps',
      binding: 'caps',
      source: 'cams',
      size: { width: 640, height: 40 },
      rowsPerPage: 1,
      row: { height: 40, cells: [] },
      cycle: { dwell: 10, group: 'wall' },
    });
    const comp = rotation();
    const rot = comp.layers[0] as ReturnType<typeof createTableLayer>;
    rot.cycle = { dwell: 10, group: 'wall' };
    comp.layers.push(second);
    const r = onAir(comp);
    vi.advanceTimersByTime(5_010);
    advance(2);
    expect(page(r)).toBe('b');
    expect(r.getTableRows('caps').map((row) => row['name'])).toEqual(['b']);
  });

  it('does not skip in a table that is not cycling', () => {
    const r = onAir(rotation({}, 0));
    vi.advanceTimersByTime(6_000);
    expect(page(r)).toBe('a');
  });

  it('fetches the next page’s snapshot a few seconds before the turn', () => {
    const made: string[] = [];
    const create = document.createElement.bind(document);
    onAir(rotation({ refresh: 10, onError: 'hide' }));
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = create(tag);
      if (tag === 'img') {
        const img = el as HTMLImageElement;
        const set = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')?.set;
        void set;
        queueMicrotask(() => made.push(img.getAttribute('src') ?? ''));
      }
      return el;
    }) as typeof document.createElement);
    vi.advanceTimersByTime(5_000);
    expect(made).toEqual([]);
    vi.advanceTimersByTime(1_500);
    spy.mockRestore();
    return Promise.resolve().then(() => {
      expect(made.some((u) => u.startsWith('https://cam.example/b.jpg'))).toBe(true);
    });
  });

  it('stops the old camera when its row leaves', () => {
    onAir(rotation({ onError: 'hide' }));
    const first = [...document.querySelectorAll<HTMLImageElement>('.bz-media img')].filter((i) => i.getAttribute('src'));
    expect(first.length).toBeGreaterThan(0);
    vi.advanceTimersByTime(10_010);
    advance(2);
    for (const img of first) expect(img.hasAttribute('src')).toBe(false);
  });

  it('reads the kind a media check worked out, when the cell plays its mediaSrc', () => {
    const checked: DataSet = {
      id: 'cams',
      columns: [
        { key: 'name', type: 'string' },
        { key: 'mediaSrc', type: 'string' },
        { key: 'mediaKind', type: 'string' },
      ],
      rows: [{ name: 'a', mediaSrc: 'https://live.example/cam/playlist', mediaKind: 'hls' }],
    };
    mount(rotation({ cell: 'mediaSrc', onError: 'hide' }), checked);
    const host = document.querySelector<HTMLElement>('.bz-media')!;
    expect(host.dataset['kind']).toBe('hls');
  });

  it('lets go of every stream when the graphic is destroyed', () => {
    const r = onAir(rotation({ onError: 'hide' }));
    const img = [...document.querySelectorAll<HTMLImageElement>('.bz-media img')].find((i) => i.getAttribute('src'))!;
    r.destroy();
    runtime = undefined;
    expect(img.hasAttribute('src')).toBe(false);
  });
});

describe('a media layer on its own', () => {
  afterEach(() => {
    runtime?.destroy();
    runtime = undefined;
  });

  it('plays nothing until the graphic goes on air, and lets go when it is cleared', () => {
    gsap.ticker.lagSmoothing(0);
    rootTime = gsap.globalTimeline.time();
    const layer: Layer = media({ src: 'https://cam.example/a.jpg', audio: true });
    const r = mount(
      createComposition({ id: 'c', name: 'c', duration: 2, markers: [{ type: 'stop', time: 1 }], layers: [layer] }),
      CAMS,
    );
    const host = document.querySelector<HTMLElement>('.bz-media')!;
    // Off air: remembered, not playing — no connection, no sound before TAKE.
    expect(host.dataset['state']).toBe('idle');
    expect(host.dataset['kind']).toBe('image');
    expect(imgs(host)).toHaveLength(0);
    r.play();
    expect(imgs(host)[1]!.getAttribute('src')).toBe('https://cam.example/a.jpg');
    advance(1.2);
    const img = imgs(host)[1]!;
    r.clear();
    expect(img.hasAttribute('src')).toBe(false);
    expect(host.dataset['state']).toBe('idle');
    r.play();
    expect(imgs(host)[1]!.getAttribute('src')).toBe('https://cam.example/a.jpg');
  });

  it('plays while idle where the host asks — the editor’s stage', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    runtime = new BreezeRuntime({
      container,
      composition: createComposition({ id: 'c', name: 'c', duration: 2, layers: [media({ src: 'https://cam.example/a.jpg' })] }),
      injectStyles: false,
      mediaWhenIdle: true,
    });
    expect(imgs(document.querySelector('.bz-media')!)[1]!.getAttribute('src')).toBe('https://cam.example/a.jpg');
  });

  it('plays its URL, and a URL typed into its field', () => {
    const layer: Layer = media({ binding: 'camera', src: 'https://cam.example/a.jpg' });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const r = (runtime = new BreezeRuntime({
      container,
      composition: createComposition({ id: 'c', name: 'c', duration: 2, layers: [layer] }),
      injectStyles: false,
      mediaWhenIdle: true,
    }));
    const host = document.querySelector<HTMLElement>('.bz-media')!;
    expect(imgs(host)[1]!.getAttribute('src')).toBe('https://cam.example/a.jpg');
    r.update({ camera: 'https://live.example/cam/index.m3u8' });
    expect(host.dataset['kind']).toBe('hls');
    r.update({ camera: '' });
    expect(host.dataset['state']).toBe('idle');
    expect(host.children).toHaveLength(0);
  });
});
