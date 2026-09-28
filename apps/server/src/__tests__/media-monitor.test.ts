// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Wave 8 on the server: JPEG frames out of a stream, the media checks, the
 * camera proxy, and the check's columns on a published source.
 *
 * Nothing touches the network: `open` is replaced by a function answering
 * from a table of URLs, the way `fetchText` is mocked in the data tests.
 */

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MEDIA_COLUMNS, type DataSet, type DataSourceDef } from '@breeze/schema';

import { DataRegistry } from '../data/registry.js';
import { JpegSplitter, imageType, jpegFrameEnd } from '../media/jpeg.js';
import { MediaMonitor, NotProxied, STREAM_BOUNDARY, StreamHub, mediaKey, type StreamClient } from '../media/monitor.js';
import { registerMediaRoutes } from '../routes/media.js';

/* ------------------------------------------------------------------ jpeg */

/**
 * A JPEG as far as the structure goes: SOI, an APP1 carrying a whole
 * thumbnail (with its own end marker), a scan with a stuffed FF, EOI.
 */
function jpeg(tag: number): Buffer {
  const thumb = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 2 + thumb.length]), thumb]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6]);
  const scan = Buffer.from([tag, 0xff, 0x00, tag, 0xff, 0xd3, tag]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sos, scan, Buffer.from([0xff, 0xd9])]);
}

function multipart(frames: Buffer[], boundary = 'myboundary'): Buffer {
  return Buffer.concat(
    frames.flatMap((f) => [Buffer.from(`--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`), f, Buffer.from('\r\n')]),
  );
}

describe('JPEG frames', () => {
  it('steps over an EXIF thumbnail’s end marker to the frame’s own', () => {
    const f = jpeg(7);
    expect(jpegFrameEnd(f)).toBe(f.length);
    expect(imageType(f)).toBe('image/jpeg');
  });

  it('finds every frame in a multipart body, whatever the chunking', () => {
    const body = multipart([jpeg(1), jpeg(2), jpeg(3)]);
    for (const size of [1, 7, 64, body.length]) {
      const splitter = new JpegSplitter();
      const out: Buffer[] = [];
      for (let i = 0; i < body.length; i += size) out.push(...splitter.push(body.subarray(i, i + size)));
      expect(out.map((f) => f.equals(jpeg(out.indexOf(f) + 1)))).toEqual([true, true, true]);
    }
  });

  it('joins a big frame once, not once per chunk', () => {
    // A 2 MB scan with no FF in it, then the end: a hundred and more chunks.
    const big = Buffer.concat([jpeg(1).subarray(0, 21), Buffer.alloc(2 * 1024 * 1024, 0x11), Buffer.from([0xff, 0xd9])]);
    const splitter = new JpegSplitter();
    const started = performance.now();
    const out: Buffer[] = [];
    for (let i = 0; i < big.length; i += 16 * 1024) out.push(...splitter.push(big.subarray(i, i + 16 * 1024)));
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(big.length);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('gives up on a frame that never ends', () => {
    const splitter = new JpegSplitter(100);
    const start = jpeg(1).subarray(0, 21); // into the scan
    expect(() => splitter.push(Buffer.concat([start, Buffer.alloc(200, 1)]))).toThrow(/over 100 bytes/);
  });

  it('knows the pictures a browser shows by their first bytes', () => {
    expect(imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(imageType(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(imageType(Buffer.from('<html>not found</html>'))).toBeNull();
  });
});

/* --------------------------------------------------------------- monitor */

type Answer = { body: Buffer | string | ReadableStream<Uint8Array>; type?: string; status?: number } | Error;

let routes: Record<string, Answer>;
let opened: string[];
const open = vi.fn(async (url: string, opts: { signal?: AbortSignal } = {}) => {
  opened.push(url);
  const answer = routes[url];
  if (!answer) throw new Error(`fetch failed: ${url}`);
  if (answer instanceof Error) throw answer;
  if ((answer.status ?? 200) >= 400) throw new Error(`HTTP ${answer.status}`);
  void opts;
  return new Response(answer.body as BodyInit, { headers: { 'content-type': answer.type ?? 'image/jpeg' } });
});

/** A camera stream that sends the given frames, then stays open until cancelled. */
function liveStream(frames: Buffer[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(multipart(frames)));
    },
  });
}

let clock = Date.parse('2026-09-28T12:00:00Z');
const now = () => clock;

const SNAP = 'https://cams.example/a.jpg';
const MJPEG = 'http://cams.example/axis-cgi/mjpg/video.cgi';
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const OEMBED = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ')}`;
const HLS = 'https://live.example/cam/index.m3u8';

const camsDef = (media: DataSourceDef['media'] = { column: 'url' }): DataSourceDef => ({
  id: 'cams',
  name: 'Cameras',
  type: 'manual',
  columns: [
    { key: 'name', type: 'string' },
    { key: 'url', type: 'string' },
  ],
  rows: [],
  ...(media ? { media } : {}),
});
const camsData = (urls: string[]): DataSet => ({
  id: 'cams',
  columns: [
    { key: 'name', type: 'string' },
    { key: 'url', type: 'string' },
  ],
  rows: urls.map((url, i) => ({ name: `cam ${i + 1}`, url })),
});

let monitor: MediaMonitor;

beforeEach(() => {
  routes = {};
  opened = [];
  open.mockClear();
  clock = Date.parse('2026-09-28T12:00:00Z');
  monitor = new MediaMonitor({ open: open as never, now, checkTimeoutMs: 2000 });
});

afterEach(() => {
  monitor.stop();
  vi.useRealTimers();
});

const byUrl = (url: string) => monitor.rows('p', 'cams').find((r) => r.url === url);

describe('the media checks', () => {
  it('adds its columns at once, counting an unchecked camera as up and playing snapshots and streams through the proxy', () => {
    const data = camsData([SNAP, MJPEG, YT]);
    monitor.sync('p', camsDef(), data);
    const out = monitor.decorate('p', 'cams', data);
    expect(out.columns.map((c) => c.key)).toEqual(['name', 'url', 'mediaState', 'mediaOk', 'mediaSrc', 'mediaKind']);
    expect(out.rows.map((r) => [r[MEDIA_COLUMNS.state], r[MEDIA_COLUMNS.ok], r[MEDIA_COLUMNS.kind]])).toEqual([
      ['unchecked', true, 'image'],
      ['unchecked', true, 'mjpeg'],
      ['unchecked', true, 'youtube'],
    ]);
    expect(out.rows.map((r) => r[MEDIA_COLUMNS.src])).toEqual([
      `/media/p/cams/${mediaKey(SNAP)}/snapshot`,
      `/media/p/cams/${mediaKey(MJPEG)}/stream`,
      YT,
    ]);
  });

  it('plays the original URLs when the proxy is off', () => {
    const data = camsData([SNAP]);
    monitor.sync('p', camsDef({ column: 'url', proxy: false }), data);
    expect(monitor.decorate('p', 'cams', data).rows[0]![MEDIA_COLUMNS.src]).toBe(SNAP);
  });

  it('checks each kind its own way, and says why one failed', async () => {
    routes[SNAP] = { body: jpeg(1) };
    routes[MJPEG] = { body: liveStream([jpeg(2), jpeg(3)]), type: `multipart/x-mixed-replace; boundary=myboundary` };
    routes[OEMBED] = { body: '', status: 401 };
    routes[HLS] = { body: '#EXTM3U\n#EXT-X-VERSION:3\n', type: 'application/vnd.apple.mpegurl' };
    const notPicture = 'https://cams.example/login.html';
    routes[notPicture] = { body: '<html>log in</html>', type: 'text/html' };
    const data = camsData([SNAP, MJPEG, YT, HLS, notPicture, 'https://cams.example/gone.jpg']);
    monitor.sync('p', camsDef(), data);
    await monitor.checkNow('p', 'cams');
    expect(byUrl(SNAP)?.state).toBe('ok');
    expect(byUrl(MJPEG)?.state).toBe('ok');
    expect(byUrl(HLS)?.state).toBe('ok');
    expect(byUrl(YT)).toMatchObject({ state: 'failed', error: 'the owner does not allow this video to be embedded' });
    expect(byUrl(notPicture)).toMatchObject({ state: 'failed', error: 'not a picture' });
    expect(byUrl('https://cams.example/gone.jpg')?.state).toBe('failed');
    expect(monitor.summary('p', 'cams')).toMatchObject({ ok: 3, failed: 3, frozen: 0, unchecked: 0 });
    const rows = monitor.decorate('p', 'cams', data).rows;
    expect(rows.map((r) => r[MEDIA_COLUMNS.ok])).toEqual([true, true, false, true, false, false]);
  });

  it('calls a camera frozen once its picture has not changed for frozenAfter seconds, and thaws it', async () => {
    routes[SNAP] = { body: jpeg(1) };
    monitor.sync('p', camsDef({ column: 'url', frozenAfter: 120 }), camsData([SNAP]));
    await monitor.checkNow('p', 'cams');
    clock += 119_000;
    routes[SNAP] = { body: jpeg(1) };
    await monitor.checkNow('p', 'cams');
    expect(byUrl(SNAP)?.state).toBe('ok');
    clock += 2_000;
    routes[SNAP] = { body: jpeg(1) };
    await monitor.checkNow('p', 'cams');
    expect(byUrl(SNAP)).toMatchObject({ state: 'frozen', error: 'the picture has not changed' });
    routes[SNAP] = { body: jpeg(9) };
    await monitor.checkNow('p', 'cams');
    expect(byUrl(SNAP)?.state).toBe('ok');
  });

  it('keeps a camera login on the server when it plays through the proxy', async () => {
    const withLogin = 'http://viewer:s3cret@cams.example/snap.jpg';
    const data = camsData([withLogin]);
    monitor.sync('p', camsDef(), data);
    const row = monitor.decorate('p', 'cams', data).rows[0]!;
    expect(row['url']).toBe('http://cams.example/snap.jpg');
    expect(String(row[MEDIA_COLUMNS.src])).not.toContain('s3cret');
    expect(monitor.rows('p', 'cams')[0]!.url).toBe('http://cams.example/snap.jpg');
    // …and it is what the camera is asked with.
    routes[withLogin] = { body: jpeg(1) };
    await monitor.checkNow('p', 'cams');
    expect(opened).toEqual([withLogin]);
  });

  it('reads a stream’s first frame whatever the camera calls it', async () => {
    routes[MJPEG] = { body: liveStream([jpeg(2)]), type: 'application/octet-stream' };
    monitor.sync('p', camsDef(), camsData([MJPEG]));
    await monitor.checkNow('p', 'cams');
    expect(byUrl(MJPEG)?.state).toBe('ok');
  });

  it('counts the same camera in two rows once, the first row’s kind standing', () => {
    const data: DataSet = { ...camsData([SNAP, SNAP]), rows: [{ name: 'a', url: SNAP }, { name: 'b', url: SNAP }] };
    monitor.sync('p', camsDef(), data);
    expect(monitor.rows('p', 'cams')).toHaveLength(1);
  });

  it('never calls a camera frozen with frozenAfter 0', async () => {
    routes[SNAP] = { body: jpeg(1) };
    monitor.sync('p', camsDef({ column: 'url', frozenAfter: 0 }), camsData([SNAP]));
    await monitor.checkNow('p', 'cams');
    clock += 86_400_000;
    routes[SNAP] = { body: jpeg(1) };
    await monitor.checkNow('p', 'cams');
    expect(byUrl(SNAP)?.state).toBe('ok');
  });

  it('reads a written kind before the URL’s look', async () => {
    const odd = 'http://cams.example/cam1';
    routes[odd] = { body: liveStream([jpeg(4)]), type: 'multipart/x-mixed-replace; boundary=x' };
    const def: DataSourceDef = { ...camsDef({ column: 'url', kindColumn: 'kind' }), columns: [...camsDef().columns ?? [], { key: 'kind', type: 'string' }] } as DataSourceDef;
    const data: DataSet = { ...camsData([odd]), rows: [{ name: 'a', url: odd, kind: 'MJPEG' }] };
    monitor.sync('p', def, data);
    expect(monitor.decorate('p', 'cams', data).rows[0]![MEDIA_COLUMNS.src]).toMatch(/\/stream$/);
    await monitor.checkNow('p', 'cams');
    expect(byUrl(odd)).toMatchObject({ kind: 'mjpeg', state: 'ok' });
  });

  it('forgets a camera that leaves the list, and stops checking a source that loses its checks', async () => {
    monitor.sync('p', camsDef(), camsData([SNAP, MJPEG]));
    monitor.sync('p', camsDef(), camsData([SNAP]));
    expect(monitor.rows('p', 'cams').map((r) => r.url)).toEqual([SNAP]);
    monitor.sync('p', camsDef(null as never), camsData([SNAP]));
    expect(monitor.summary('p', 'cams')).toBeUndefined();
  });

  it('checks again on its own schedule', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    routes[SNAP] = { body: jpeg(1) };
    monitor.sync('p', camsDef({ column: 'url', every: 30 }), camsData([SNAP]));
    await vi.advanceTimersByTimeAsync(600);
    expect(open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(open).toHaveBeenCalledTimes(2);
  });
});

/* ----------------------------------------------------------------- proxy */

describe('the proxy', () => {
  it('serves a snapshot, one fetch for requests at the same moment', async () => {
    routes[SNAP] = { body: jpeg(5) };
    monitor.sync('p', camsDef(), camsData([SNAP]));
    const key = mediaKey(SNAP);
    const [a, b] = await Promise.all([monitor.snapshot('p', 'cams', key), monitor.snapshot('p', 'cams', key)]);
    expect(a.body.equals(jpeg(5))).toBe(true);
    expect(b).toBe(a);
    expect(open).toHaveBeenCalledTimes(1);
    // Fresh enough to serve again as it is.
    clock += 1000;
    await monitor.snapshot('p', 'cams', key);
    expect(open).toHaveBeenCalledTimes(1);
    clock += 2000;
    await monitor.snapshot('p', 'cams', key);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('proxies nothing that is not a row of a checked source', async () => {
    monitor.sync('p', camsDef(), camsData([SNAP]));
    await expect(monitor.snapshot('p', 'cams', 'ffffffffffff')).rejects.toBeInstanceOf(NotProxied);
    await expect(monitor.snapshot('p', 'other', mediaKey(SNAP))).rejects.toBeInstanceOf(NotProxied);
    // Only pictures: a YouTube row is played from YouTube, not fetched through here.
    monitor.sync('p', camsDef(), camsData([SNAP, YT]));
    await expect(monitor.snapshot('p', 'cams', mediaKey(YT))).rejects.toBeInstanceOf(NotProxied);
    expect(() => monitor.stream('p', 'cams', mediaKey(SNAP))).toThrow(NotProxied); // a snapshot, not a stream
    expect(open).not.toHaveBeenCalled();
  });

  it('fans one camera connection out to every viewer, in multipart of its own', async () => {
    let push!: (b: Buffer) => void;
    routes[MJPEG] = {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          push = (b) => controller.enqueue(new Uint8Array(b));
        },
      }),
      type: 'multipart/x-mixed-replace; boundary=cam',
    };
    monitor.sync('p', camsDef(), camsData([MJPEG]));
    const hub = monitor.stream('p', 'cams', mediaKey(MJPEG));
    const client = (): StreamClient & { got: Buffer[] } => {
      const got: Buffer[] = [];
      return { got, write: (b) => (got.push(b), true), end: () => undefined, once: () => undefined };
    };
    const one = client();
    const two = client();
    hub.add(one);
    hub.add(two);
    await vi.waitFor(() => expect(push).toBeTypeOf('function'));
    push(multipart([jpeg(1)], 'cam'));
    await vi.waitFor(() => expect(one.got).toHaveLength(1));
    expect(two.got).toHaveLength(1);
    expect(one.got[0]!.toString('latin1')).toContain(`--${STREAM_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg(1).length}`);
    expect(open).toHaveBeenCalledTimes(1);
    // A late viewer gets the last frame at once.
    const three = client();
    hub.add(three);
    expect(three.got).toHaveLength(1);
    // The same hub for the next request, and its frame answers a snapshot.
    expect(monitor.stream('p', 'cams', mediaKey(MJPEG))).toBe(hub);
    const frame = await monitor.snapshot('p', 'cams', mediaKey(MJPEG));
    expect(frame.body.equals(jpeg(1))).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    hub.close(null);
  });

  it('reopens a camera connection that stalls or ends while anyone is watching, keeping the viewer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let n = 0;
    const opener = vi.fn(async (_url: string, opts: { signal?: AbortSignal } = {}) => {
      n += 1;
      const first = n === 1;
      if (n >= 3) throw new Error('fetch failed (ECONNREFUSED)');
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            // The first connection stalls; the second sends a frame and ends.
            opts.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
            if (!first) {
              controller.enqueue(new Uint8Array(multipart([jpeg(8)])));
              controller.close();
            }
          },
        }),
        { headers: { 'content-type': 'multipart/x-mixed-replace' } },
      );
    });
    const closed = vi.fn();
    const ended = vi.fn();
    const got: Buffer[] = [];
    const hub = new StreamHub('http://cam/stream', opener as never, now, () => undefined, closed);
    hub.add({ write: (b) => (got.push(b), true), end: ended, once: () => undefined });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(opener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_500); // stalled at 20 s, reopened a second later
    expect(opener).toHaveBeenCalledTimes(2);
    expect(got).toHaveLength(1);
    expect(ended).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    // Ended, then refused: reopened with backoff until it keeps failing, then the viewer is let go.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('takes a stream’s still off the stream’s own connection, shared with the viewer who follows', async () => {
    routes[MJPEG] = { body: liveStream([jpeg(6)]), type: 'multipart/x-mixed-replace; boundary=myboundary' };
    monitor.sync('p', camsDef(), camsData([MJPEG]));
    const frame = await monitor.snapshot('p', 'cams', mediaKey(MJPEG));
    expect(frame.body.equals(jpeg(6))).toBe(true);
    const hub = monitor.stream('p', 'cams', mediaKey(MJPEG));
    const got: Buffer[] = [];
    hub.add({ write: (b) => (got.push(b), true), end: () => undefined, once: () => undefined });
    expect(got).toHaveLength(1); // the frame the still read, straight away
    expect(open).toHaveBeenCalledTimes(1);
    hub.close(null);
  });

  it('closes the camera connection a few seconds after the last viewer leaves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const aborted = vi.fn();
    const opener = vi.fn(async (_url: string, opts: { signal?: AbortSignal } = {}) => {
      opts.signal?.addEventListener('abort', aborted);
      return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'multipart/x-mixed-replace' } });
    });
    const closed = vi.fn();
    const hub = new StreamHub('http://cam/stream', opener as never, now, () => undefined, closed);
    const viewer: StreamClient = { write: () => true, end: () => undefined, once: () => undefined };
    hub.add(viewer);
    hub.remove(viewer);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(closed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(aborted).toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------- registry */

describe('a camera list on air', () => {
  it('publishes its rows with the check’s columns, and again when a check changes them', async () => {
    const registry = new DataRegistry();
    registry.stop();
    registry.attachMedia(monitor);
    const pushes: DataSet[] = [];
    registry.onPush((_p, d) => pushes.push(d));
    const def = { ...camsDef(), rows: [{ name: 'a', url: SNAP }] } as DataSourceDef;
    await registry.upsert('p', def);
    expect(pushes.at(-1)!.rows[0]).toMatchObject({ mediaState: 'unchecked', mediaOk: true });
    expect(registry.get('p', 'cams')!.status.media).toMatchObject({ unchecked: 1 });

    await monitor.checkNow('p', 'cams'); // no answer: failed
    expect(pushes.at(-1)!.rows[0]).toMatchObject({ mediaState: 'failed', mediaOk: false });
    expect(registry.get('p', 'cams')!.status.media).toMatchObject({ failed: 1 });
    const count = pushes.length;
    await monitor.checkNow('p', 'cams'); // the same answer: nothing to push
    expect(pushes).toHaveLength(count);

    registry.remove('p', 'cams');
    expect(monitor.summary('p', 'cams')).toBeUndefined();
  });

  it('leaves a source without checks exactly as it was', async () => {
    const registry = new DataRegistry();
    registry.stop();
    registry.attachMedia(monitor);
    await registry.upsert('p', { ...camsDef(null as never), rows: [{ name: 'a', url: SNAP }] } as DataSourceDef);
    expect(registry.get('p', 'cams')!.data.columns.map((c) => c.key)).toEqual(['name', 'url']);
    expect(registry.get('p', 'cams')!.status.media).toBeUndefined();
  });
});

/* ---------------------------------------------------------------- routes */

describe('the routes', () => {
  async function app() {
    const registry = new DataRegistry();
    registry.stop();
    registry.attachMedia(monitor);
    await registry.upsert('p', { ...camsDef(), rows: [{ name: 'a', url: SNAP }] } as DataSourceDef);
    await registry.upsert('p', { id: 'plain', name: 'Plain', type: 'manual', columns: [], rows: [] });
    const server = Fastify();
    await registerMediaRoutes(server, registry, monitor);
    return server;
  }

  it('serves a proxied snapshot, 404s a key it does not know, and 502s a camera that is down', async () => {
    const server = await app();
    routes[SNAP] = { body: jpeg(3) };
    const ok = await server.inject({ method: 'GET', url: `/media/p/cams/${mediaKey(SNAP)}/snapshot` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.headers['cache-control']).toContain('no-store');
    expect(Buffer.from(ok.rawPayload).equals(jpeg(3))).toBe(true);

    expect((await server.inject({ method: 'GET', url: '/media/p/cams/ffffffffffff/snapshot' })).statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: `/media/p/cams/${mediaKey(SNAP)}/stream` })).statusCode).toBe(404);

    // A snapshot asked for by refresh period may be kept briefly — so a page turn reads the preload.
    const bucketed = await server.inject({ method: 'GET', url: `/media/p/cams/${mediaKey(SNAP)}/snapshot?_bz=123` });
    expect(bucketed.headers['cache-control']).toBe('private, max-age=15');

    clock += 5_000;
    routes[SNAP] = new Error('connect ECONNREFUSED');
    const down = await server.inject({ method: 'GET', url: `/media/p/cams/${mediaKey(SNAP)}/snapshot` });
    expect(down.statusCode).toBe(502);
    // Held briefly: the next output asking does not reach the dead camera.
    const before = open.mock.calls.length;
    expect((await server.inject({ method: 'GET', url: `/media/p/cams/${mediaKey(SNAP)}/snapshot` })).statusCode).toBe(502);
    expect(open.mock.calls.length).toBe(before);
    await server.close();
  });

  it('reports every camera, and checks now on request', async () => {
    const server = await app();
    const list = await server.inject({ method: 'GET', url: '/api/projects/p/datasources/cams/media' });
    expect(list.json()).toMatchObject({ summary: { unchecked: 1 }, rows: [{ url: SNAP, kind: 'image', state: 'unchecked' }] });
    routes[SNAP] = { body: jpeg(1) };
    const checked = await server.inject({ method: 'POST', url: '/api/projects/p/datasources/cams/media/check' });
    expect(checked.json()).toMatchObject({ done: true, summary: { ok: 1 }, rows: [{ state: 'ok' }] });
    expect((await server.inject({ method: 'POST', url: '/api/projects/p/datasources/plain/media/check' })).statusCode).toBe(400);
    expect((await server.inject({ method: 'GET', url: '/api/projects/p/datasources/nope/media' })).statusCode).toBe(404);
    await server.close();
  });
});
