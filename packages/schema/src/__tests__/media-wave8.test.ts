// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Wave 8 in the schema: which kind a media URL is, the media layer, and a
 * source's media checks.
 */

import { describe, expect, it } from 'vitest';

import type { DataSourceDef } from '../data.js';
import { collectBindings } from '../bindings.js';
import { assetReferences } from '../assets.js';
import { createComposition, createLayer, createTableLayer } from '../factory.js';
import { mediaKindOf, parseMediaKind, youtubeId } from '../media.js';
import type { Composition, Layer, MediaLayer, TableLayer } from '../types.js';
import { validateComposition, validateDataSources } from '../validate.js';

describe('mediaKindOf', () => {
  it.each([
    ['https://cam.example/snapshot.jpg', 'image'],
    ['http://cam.example/axis-cgi/jpg/image.cgi', 'image'],
    ['http://cam.example/axis-cgi/mjpg/video.cgi', 'mjpeg'],
    ['http://cam.example/mjpg/video.mjpg', 'mjpeg'],
    ['http://cam.example/cgi-bin/faststream.jpg?stream=full', 'mjpeg'],
    ['http://cam.example/videostream.cgi?user=x', 'mjpeg'],
    ['/media/demo/cams/abc123def456/stream', 'mjpeg'],
    ['/media/demo/cams/abc123def456/snapshot', 'image'],
    ['https://cdn.example/loop.mp4', 'video'],
    ['https://cdn.example/loop.webm?x=1', 'video'],
    ['https://live.example/cam/index.m3u8', 'hls'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ?si=abc', 'youtube'],
  ])('%s is %s', (url, kind) => {
    expect(mediaKindOf(url)).toBe(kind);
  });

  it('finds the video id in every YouTube shape, and nothing elsewhere', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?t=5',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    ]) {
      expect(youtubeId(url), url).toBe('dQw4w9WgXcQ');
    }
    for (const url of ['https://vimeo.com/123', 'https://www.youtube.com/', 'not a url', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ']) {
      expect(youtubeId(url), url).toBeNull();
    }
  });

  it('reads a written kind however it is cased, and nothing else', () => {
    expect(parseMediaKind(' MJPEG ')).toBe('mjpeg');
    expect(parseMediaKind('YouTube')).toBe('youtube');
    expect(parseMediaKind('webcam')).toBeNull();
    expect(parseMediaKind(3)).toBeNull();
  });
});

function media(overrides: Partial<MediaLayer> = {}): MediaLayer {
  return { ...(createLayer('media') as MediaLayer), id: 'cam', ...overrides };
}

function comp(layers: Layer[]): Composition {
  return createComposition({ id: 'wx', name: 'wx', duration: 2, layers });
}

function rotation(cell: MediaLayer, dwell = 8): Composition {
  const table: TableLayer = createTableLayer({
    id: 'rot',
    size: { width: 640, height: 360 },
    rowsPerPage: 1,
    row: { height: 360, cells: [cell] },
    data: { columns: [{ key: 'url', type: 'string' }, { key: 'kind', type: 'string' }], rows: [] },
    ...(dwell ? { cycle: { dwell } } : {}),
  });
  return comp([table]);
}

const errors = (c: Composition) => validateComposition(c).errors.filter((e) => e.severity !== 'warning');
const warnings = (c: Composition) => validateComposition(c).errors.filter((e) => e.severity === 'warning');

describe('the media layer', () => {
  it('is valid as created, on its own and as a table cell', () => {
    expect(errors(comp([media({ src: 'https://cam.example/snap.jpg', refresh: 10 })]))).toEqual([]);
    expect(errors(rotation(media({ cell: 'url', kindColumn: 'kind', onError: 'skip' })))).toEqual([]);
    expect(warnings(rotation(media({ cell: 'url', kindColumn: 'kind', onError: 'skip' })))).toEqual([]);
  });

  it('refuses what cannot work', () => {
    expect(errors(comp([media({ kind: 'webcam' as never })]))).not.toEqual([]);
    expect(errors(comp([media({ refresh: 0.5 })]))).not.toEqual([]);
    expect(errors(comp([media({ timeout: 0 })]))).not.toEqual([]);
    expect(errors(comp([media({ onError: 'retry' as never })]))).not.toEqual([]);
  });

  it('warns about settings that only mean something elsewhere', () => {
    expect(warnings(comp([media({ kindColumn: 'kind' })])).map((w) => w.path)).toEqual(['/layers/0/kindColumn']);
    expect(warnings(comp([media({ onError: 'skip' })])).map((w) => w.path)).toEqual(['/layers/0/onError']);
    // Skip in a table that does not cycle has nothing to skip to.
    expect(warnings(rotation(media({ cell: 'url', onError: 'skip' }), 0)).map((w) => w.path)).toEqual([
      '/layers/0/row/cells/0/onError',
    ]);
    expect(warnings(comp([media({ kind: 'mjpeg', refresh: 5 })])).map((w) => w.path)).toEqual(['/layers/0/refresh']);
  });

  it('binds as a plain text field — the operator types a URL', () => {
    const [binding] = collectBindings(comp([media({ binding: 'camera', src: 'https://cam.example/a.jpg' })]));
    expect(binding).toMatchObject({ name: 'camera', kind: 'string', defaultValue: 'https://cam.example/a.jpg' });
  });

  it('counts an asset path as an asset, and a URL or server path as not one', () => {
    const refs = (src: string) => assetReferences([media({ src })]).map((r) => r.src);
    expect(refs('assets/loop.mp4')).toEqual(['assets/loop.mp4']);
    expect(refs('https://cam.example/a.jpg')).toEqual([]);
    expect(refs('//cam.example/a.jpg')).toEqual([]);
    expect(refs('/media/p/s/k/stream')).toEqual([]);
  });
});

describe('media checks on a source', () => {
  const cams = (mediaCheck: unknown, columns = [{ key: 'name', type: 'string' }, { key: 'url', type: 'string' }]): unknown => ({
    formatVersion: 1,
    sources: [{ id: 'cams', name: 'Cameras', type: 'manual', columns, rows: [], media: mediaCheck }],
  });
  const issues = (doc: unknown) => validateDataSources(doc).errors;

  it('accepts a check on a declared column', () => {
    expect(issues(cams({ column: 'url' }))).toEqual([]);
    expect(issues(cams({ column: 'url', every: 30, frozenAfter: 0, proxy: false }))).toEqual([]);
  });

  it('refuses a column the source does not have, checks too often, and a column the check would add', () => {
    expect(issues(cams({ column: 'link' })).map((e) => e.path)).toEqual(['/sources/0/media/column']);
    expect(issues(cams({ column: 'url', every: 5 }))).not.toEqual([]);
    expect(issues(cams({ column: 'url' }, [{ key: 'url', type: 'string' }, { key: 'mediaOk', type: 'boolean' }])).map((e) => e.path)).toEqual([
      '/sources/0/media',
    ]);
    expect(issues(cams({ kindColumn: 'kind' }))).not.toEqual([]);
  });

  it('is allowed on a fetched source, whose columns are only known live', () => {
    const doc = {
      formatVersion: 1,
      sources: [{ id: 'feed', name: 'Feed', type: 'http-json', url: 'https://x.example/cams.json', media: { column: 'anything' } }],
    };
    expect(validateDataSources(doc as unknown as { sources: DataSourceDef[] }).errors).toEqual([]);
  });
});
