// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The asset index — `projects/<id>/assets.json` (ASSETS.md §6, Phase 7.5).
 *
 * Three things are under test here and only one of them is visible through the
 * HTTP surface:
 *
 * - **The migration.** Every project on an operator's disk has its index inside
 *   `project.json`. It has to move without an export step and without anyone
 *   being told to do anything.
 * - **The write lock.** `registerAsset` used to be a read-modify-write on the
 *   project document with two callers racing for it. The editor only avoided
 *   the race because `uploadAssets` awaits each file in turn; two tabs did not.
 * - **The usage index.** "Is this in use" across every composition, which is the
 *   question the bin could never answer and which delete, replace and
 *   composition-scoped export all wait on.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Composition, Project } from '@breeze/schema';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-asset-index-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../app.js');
const store = await import('../store.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const projectDir = (id: string) => path.join(tmpDir, 'projects', id);
const indexFile = (id: string) => path.join(projectDir(id), 'assets.json');

const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await fs.readFile(file, 'utf8')) as T;

const exists = async (file: string): Promise<boolean> =>
  fs.access(file).then(() => true, () => false);

/** The bin as the server sees it, for assertions that outlive one response. */
const listAssetsOf = (project: string) => store.listAssets(project);

const upload = (project: string, name: string, body: Buffer | string) =>
  app.inject({
    method: 'POST',
    url: `/api/projects/${project}/assets?name=${encodeURIComponent(name)}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: typeof body === 'string' ? Buffer.from(body) : body,
  });

async function makeProject(id: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: id, id },
  });
  expect(res.statusCode).toBe(201);
}

/** Overwrite a project's compositions wholesale. */
async function setCompositions(id: string, compositions: Composition[]): Promise<void> {
  const project = (await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json() as Project;
  const res = await app.inject({
    method: 'PUT',
    url: `/api/projects/${id}`,
    payload: { ...project, compositions },
  });
  expect(res.statusCode).toBe(200);
}

const comp = (id: string, name: string, layers: Composition['layers']): Composition => ({
  formatVersion: 1,
  id,
  name,
  stage: { width: 1920, height: 1080, fps: 60, background: 'transparent' },
  layers,
});

/**
 * A real 1×1 PNG header.
 *
 * `imageDimensions` reads IHDR at a fixed offset, so the signature and the
 * first chunk are all that matter — but they have to be genuinely correct, or
 * the test proves the reader accepts nonsense rather than that it works.
 */
function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/* ------------------------------------------------------------- migration */

describe('migration from project.json', () => {
  it('lifts a legacy index into assets.json on first read', async () => {
    await makeProject('legacy');

    // Write the index the old way — straight into project.json, which is
    // exactly the state every project on disk is in before this ships.
    const file = path.join(projectDir('legacy'), 'project.json');
    const project = await readJson<Project>(file);
    project.assets = [
      { id: 'aaa1', path: 'assets/logo-aaa1.png', kind: 'image', originalName: 'logo.png', bytes: 12 },
    ];
    await fs.writeFile(file, JSON.stringify(project, null, 2));
    expect(await exists(indexFile('legacy'))).toBe(false);

    const assets = await store.listAssets('legacy');
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ id: 'aaa1', path: 'assets/logo-aaa1.png' });

    // Materialised, so the next read does not have to migrate again.
    expect(await exists(indexFile('legacy'))).toBe(true);
    const index = await readJson<{ assets: unknown[] }>(indexFile('legacy'));
    expect(index.assets).toHaveLength(1);
  });

  it('is idempotent — assets.json wins once it exists', async () => {
    // A stale legacy key must not resurrect a deleted asset. Reading twice
    // more should not append, duplicate or reintroduce anything.
    expect(await store.listAssets('legacy')).toHaveLength(1);
    expect(await store.listAssets('legacy')).toHaveLength(1);

    await store.deleteAsset('legacy', 'aaa1');
    expect(await store.listAssets('legacy')).toHaveLength(0);
  });

  it('does not write an index for a project that has no assets', async () => {
    // Otherwise `listProjects` would turn into a write across every project
    // directory it walks, on a server that may be mid-show.
    await makeProject('empty');
    expect(await store.listAssets('empty')).toEqual([]);
    expect(await exists(indexFile('empty'))).toBe(false);
  });

  it('drops the legacy key on the next project write', async () => {
    const file = path.join(projectDir('legacy'), 'project.json');
    expect(await readJson<Project>(file)).toHaveProperty('assets');

    await store.writeProject(await store.readProject('legacy'));

    expect(await readJson<Project>(file)).not.toHaveProperty('assets');
  });

  it('falls back to the legacy key rather than throwing on a corrupt index', async () => {
    await makeProject('corrupt');
    const file = path.join(projectDir('corrupt'), 'project.json');
    const project = await readJson<Project>(file);
    project.assets = [{ id: 'bbb2', path: 'assets/x-bbb2.png', kind: 'image' }];
    await fs.writeFile(file, JSON.stringify(project, null, 2));
    await fs.writeFile(indexFile('corrupt'), '{ this is not json');

    // An empty bin is the worst case here, not the first one: the assets may
    // still be recoverable from project.json, so that is where we look.
    expect(await store.listAssets('corrupt')).toHaveLength(1);
  });

  it('does not carry an assets key on a freshly created project', async () => {
    await makeProject('fresh');
    const project = await readJson<Project>(path.join(projectDir('fresh'), 'project.json'));
    expect(project).not.toHaveProperty('assets');
  });
});

/* ------------------------------------------------------------------ lock */

describe('concurrent writes', () => {
  it('keeps every asset when uploads land at once', async () => {
    await makeProject('race');

    /*
     * The regression this exists for. `registerAsset` was read → mutate →
     * write with no serialization: ten uploads in flight together would each
     * read the same index and the last write would win, leaving nine files on
     * disk that the bin does not list and nobody can find.
     *
     * Ten distinct payloads, so content addressing cannot mask the failure by
     * collapsing them into one row.
     */
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => upload('race', `file-${i}.png`, `bytes-${i}`)),
    );
    for (const res of results) expect(res.statusCode).toBe(201);

    expect(await store.listAssets('race')).toHaveLength(10);
  });

  it('keeps the index consistent when deletes race uploads', async () => {
    await makeProject('race2');
    await upload('race2', 'keep.png', 'keep-bytes');
    const doomed = (await upload('race2', 'doomed.png', 'doomed-bytes')).json().asset;

    await Promise.all([
      upload('race2', 'added.png', 'added-bytes'),
      store.deleteAsset('race2', doomed.id),
      upload('race2', 'also.png', 'also-bytes'),
    ]);

    const names = (await store.listAssets('race2')).map((a) => a.originalName).sort();
    expect(names).toEqual(['added.png', 'also.png', 'keep.png']);
  });

  it('does not let one failed write poison the queue behind it', async () => {
    // The lock chains promises. Storing the raw chain rather than a swallowed
    // copy would mean a single rejected write breaks every write after it for
    // the life of the process — a bin that can never be changed again.
    await makeProject('poison');
    await expect(
      store.updateAssets('poison', () => {
        throw new Error('deliberate');
      }),
    ).rejects.toThrow('deliberate');

    const res = await upload('poison', 'after.png', 'after-bytes');
    expect(res.statusCode).toBe(201);
    expect(await store.listAssets('poison')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------- metadata */

describe('technical metadata at ingest', () => {
  it('records dimensions for an image, read from the header', async () => {
    await makeProject('meta');
    const res = await upload('meta', 'plate.png', png(1920, 1080));
    expect(res.statusCode).toBe(201);
    expect(res.json().asset).toMatchObject({ width: 1920, height: 1080 });
  });

  it('stamps addedAt', async () => {
    const asset = (await upload('meta', 'stamped.png', png(16, 16))).json().asset;
    expect(Date.parse(asset.addedAt)).not.toBeNaN();
  });

  it('does not refuse an upload whose header it cannot read', async () => {
    // Metadata is a nicety. A file the browser may well render must not be
    // rejected because a header reader did not recognize it.
    const res = await upload('meta', 'mystery.png', 'not really a png');
    expect(res.statusCode).toBe(201);
    expect(res.json().asset).not.toHaveProperty('width');
  });

  it('reads a JPEG, whose frame header is not at a fixed offset', async () => {
    // SOI, then a COM segment to prove the walk skips segments rather than
    // assuming SOF0 comes first, then SOF0 carrying 480×640.
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xfe, 0x00, 0x04, 0x41, 0x42]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80]),
      Buffer.alloc(16),
    ]);
    const asset = (await upload('meta', 'photo.jpg', jpeg)).json().asset;
    expect(asset).toMatchObject({ width: 640, height: 480 });
  });

  it('terminates on a JPEG with a zero-length segment', async () => {
    // A crafted file, and the loop guard that stops it spinning forever.
    const evil = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xfe, 0x00, 0x00]),
      Buffer.alloc(32),
    ]);
    const res = await upload('meta', 'evil.jpg', evil);
    expect(res.statusCode).toBe(201);
  });
});

/* ----------------------------------------------------------------- usage */

describe('usage index', () => {
  const logo = 'assets/logo-11111111.png';
  const wipe = 'assets/wipe-22222222.png';
  const badge = 'assets/badge-33333333.png';

  beforeAll(async () => {
    await makeProject('usage');
    await setCompositions('usage', [
      comp('lower-third', 'Lower Third', [
        { id: 'bug', name: 'Corner bug', type: 'image', src: logo },
        {
          id: 'plate',
          type: 'shape',
          shape: 'rect',
          fill: '#000',
          mask: { type: 'image', x: 0, y: 0, width: 10, height: 10, src: wipe },
        },
      ]),
      comp('standings', 'Standings', [
        {
          id: 'tbl',
          type: 'table',
          row: { height: 40, cells: [{ id: 'cell-badge', type: 'image', src: badge }] },
        },
      ]),
      comp('clean', 'Clean', [{ id: 's', type: 'shape', shape: 'rect', fill: '#fff' }]),
    ]);
  });

  it('finds a reference in another composition than the one open', async () => {
    // The whole point. The bin's own answer was scoped to the open composition,
    // so this reference was invisible at the moment it mattered — delete.
    const usage = await store.assetUsage('usage', logo);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ compositionId: 'lower-third', compositionName: 'Lower Third' });
    expect(usage[0]!.references[0]).toMatchObject({ layerId: 'bug', layerName: 'Corner bug', via: 'src' });
  });

  it('finds an image mask, which nothing in the layers panel shows', async () => {
    const usage = await store.assetUsage('usage', wipe);
    expect(usage[0]!.references[0]).toMatchObject({ layerId: 'plate', via: 'mask' });
  });

  it('finds a reference inside a table row template', async () => {
    const usage = await store.assetUsage('usage', badge);
    expect(usage[0]).toMatchObject({ compositionId: 'standings' });
    expect(usage[0]!.references[0]).toMatchObject({ layerId: 'cell-badge' });
  });

  it('reports nothing for a path no composition mentions', async () => {
    expect(await store.assetUsage('usage', 'assets/never-used.png')).toEqual([]);
  });

  it('answers over HTTP, keyed on the asset id', async () => {
    const asset = (await upload('usage', 'real.png', png(8, 8))).json().asset;
    await setCompositions('usage', [
      comp('uses-real', 'Uses Real', [{ id: 'img', type: 'image', src: asset.path }]),
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/usage/assets/${asset.id}/usage`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().usage[0]).toMatchObject({ compositionId: 'uses-real' });
  });

  it('404s for an asset id that is not in the bin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/usage/assets/nope/usage',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('orphans', () => {
  it('lists assets nothing references, and excludes those that are used', async () => {
    await makeProject('tidy');
    const used = (await upload('tidy', 'used.png', png(4, 4))).json().asset;
    const stray = (await upload('tidy', 'stray.png', png(4, 5))).json().asset;

    await setCompositions('tidy', [
      comp('main', 'Main', [{ id: 'img', type: 'image', src: used.path }]),
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/projects/tidy/assets/orphans' });
    expect(res.statusCode).toBe(200);

    const ids = (res.json().assets as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toContain(stray.id);
    expect(ids).not.toContain(used.id);
  });

  it('does not shadow the asset id route', async () => {
    // `orphans` sits where an asset id would. Static segments beat parametric
    // ones on Fastify's radix tree, but a rename would silently break it.
    const res = await app.inject({ method: 'GET', url: '/api/projects/tidy/assets/orphans' });
    expect(res.json()).toHaveProperty('assets');
  });

  it('404s for a project that does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/ghost/assets/orphans' });
    expect(res.statusCode).toBe(404);
  });
});

/* -------------------------------------------------------- metadata edits */

describe('editing metadata', () => {
  const patch = (project: string, assetId: string, body: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `/api/projects/${project}/assets/${assetId}`,
      payload: body,
    });

  it('sets descriptive fields and normalizes as it goes', async () => {
    await makeProject('edit');
    const { id } = (await upload('edit', 'raw.png', png(2, 2))).json().asset;

    const res = await patch('edit', id, {
      title: 'Corner bug',
      tags: ['Sponsor', 'sponsor', ' BUG '],
      folder: 'Game Scene/Backgrounds',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().asset).toMatchObject({
      title: 'Corner bug',
      tags: ['sponsor', 'bug'],
      folder: 'game-scene/backgrounds',
    });
  });

  it('folds new tags into the project vocabulary', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/edit/assets/tags' });
    expect(res.json().tags).toEqual(['bug', 'sponsor']);
  });

  it('keeps a vocabulary term after the last asset using it loses it', async () => {
    // The whole point of a controlled vocabulary: the suggestion survives, so
    // nobody re-invents `sponsor` as `sponsors` next week.
    const { id } = (await listAssetsOf('edit'))[0]!;
    await patch('edit', id, { tags: [] });

    const res = await app.inject({ method: 'GET', url: '/api/projects/edit/assets/tags' });
    expect(res.json().tags).toEqual(['bug', 'sponsor']);
  });

  it('clears a field when it is set to null', async () => {
    const { id } = (await listAssetsOf('edit'))[0]!;
    await patch('edit', id, { title: 'temporary' });
    const res = await patch('edit', id, { title: null });
    expect(res.json().asset).not.toHaveProperty('title');
  });

  it('refuses a derived field by name rather than ignoring it', async () => {
    /*
     * The regression that matters. Silently dropping `hasAlpha` from a PATCH
     * body is how a caller comes to believe it was set — and an operator who
     * thinks they have marked a flattened .mov as transparent finds out over
     * live pictures.
     */
    const { id } = (await listAssetsOf('edit'))[0]!;
    const res = await patch('edit', id, { hasAlpha: true });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('hasAlpha');
  });

  it('refuses identity and technical fields too', async () => {
    const { id } = (await listAssetsOf('edit'))[0]!;
    for (const field of ['id', 'path', 'kind', 'bytes', 'width', 'addedAt', 'origin']) {
      const res = await patch('edit', id, { [field]: 'x' });
      expect(res.statusCode, field).toBe(400);
    }
  });

  it('rejects a bad enum and a bad date rather than storing them', async () => {
    const { id } = (await listAssetsOf('edit'))[0]!;
    expect((await patch('edit', id, { state: 'live' })).statusCode).toBe(400);
    expect((await patch('edit', id, { usage: 'free' })).statusCode).toBe(400);
    expect((await patch('edit', id, { expiresAt: 'soon' })).statusCode).toBe(400);
    expect((await patch('edit', id, { tags: 'sponsor' })).statusCode).toBe(400);
  });

  it('404s for an asset that is not there, rather than reporting a no-op success', async () => {
    expect((await patch('edit', 'nope', { title: 'x' })).statusCode).toBe(404);
  });
});

describe('bulk edits', () => {
  const bulk = (project: string, body: unknown) =>
    app.inject({ method: 'PATCH', url: `/api/projects/${project}/assets`, payload: body });

  let all: string[] = [];

  beforeAll(async () => {
    await makeProject('bulk');
    // Distinct dimensions, so distinct bytes. `one.png` and `two.png` are the
    // same length, so sizing the fixture from the name gave two of them
    // identical content — and content addressing correctly collapsed them into
    // one asset, which is right for the store and useless for this test.
    for (const [i, name] of ['one.png', 'two.png', 'three.png'].entries()) {
      await upload('bulk', name, png(16 + i, 8));
    }
    all = (await listAssetsOf('bulk')).map((a) => a.id);

    // Give one of them a tag of its own, so a merge can be told from a replace.
    await app.inject({
      method: 'PATCH',
      url: `/api/projects/bulk/assets/${all[0]}`,
      payload: { tags: ['keepme'] },
    });
  });

  it('applies one edit to every id in a single request', async () => {
    const res = await bulk('bulk', { ids: all, edit: { folder: 'Shoot A' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().assets).toHaveLength(3);
    for (const a of await listAssetsOf('bulk')) expect(a.folder).toBe('shoot-a');
  });

  it('merges addTags per asset instead of replacing what each one had', async () => {
    // "Tag these forty as sponsors" has no single value to set — each asset's
    // result depends on its own tags, which is why this is a server-side merge
    // and not a loop of PATCHes in the editor.
    const res = await bulk('bulk', { ids: all, addTags: ['Sponsor'] });
    expect(res.statusCode).toBe(200);

    const assets = await listAssetsOf('bulk');
    const first = assets.find((a) => a.id === all[0])!;
    expect(first.tags).toEqual(['keepme', 'sponsor']);
    for (const a of assets) expect(a.tags).toContain('sponsor');
  });

  it('reports unknown ids rather than silently editing the rest', async () => {
    const res = await bulk('bulk', { ids: [...all, 'ghost'], edit: { state: 'approved' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('ghost');

    // And nothing was applied.
    for (const a of await listAssetsOf('bulk')) expect(a.state).toBeUndefined();
  });

  it('rejects an empty or malformed id list', async () => {
    expect((await bulk('bulk', { ids: [], edit: {} })).statusCode).toBe(400);
    expect((await bulk('bulk', { ids: 'all', edit: {} })).statusCode).toBe(400);
    expect((await bulk('bulk', { ids: [1, 2], edit: {} })).statusCode).toBe(400);
  });

  it('refuses a derived field in a bulk body as well', async () => {
    const res = await bulk('bulk', { ids: all, edit: { codec: 'vp9' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('tag vocabulary', () => {
  it('accepts terms with no asset attached, so a taxonomy can be seeded', async () => {
    await makeProject('vocab');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/vocab/assets/tags',
      payload: { tags: ['Lower Third', 'bug', 'bug'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tags).toEqual(['bug', 'lower-third']);
  });

  it('rejects a malformed tag list', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/vocab/assets/tags',
      payload: { tags: 'bug' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('does not shadow the asset id route', async () => {
    // `tags` sits where an asset id would, same as `orphans`.
    const res = await app.inject({ method: 'GET', url: '/api/projects/vocab/assets/tags' });
    expect(res.json()).toHaveProperty('tags');
  });
});
