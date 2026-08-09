// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Replace — new bytes, rewrite every referencing `src`, keep `supersedes`.
 *
 * ASSETS.md §2 lists this as the fifth wall: "a corrected logo is a new path
 * and every `src` string pointing at the old one keeps pointing at it". The
 * consequence in a gallery is worse than it sounds — the operator sees the new
 * file appear in the bin, concludes the job is done, and the graphic goes to
 * air on the old logo with nothing anywhere reporting a problem.
 *
 * The properties worth holding onto, in the order they can hurt:
 *
 * - **Every reference moves, in every composition.** A rewrite that misses one
 *   is the failure above, with a success message attached.
 * - **Identical bytes are not a replacement.** Content addressing means the
 *   same file has the same id, so replacing something with itself must not
 *   retire it — that would empty the row the operator was updating.
 * - **The old file survives.** Retired, not deleted, because the realistic
 *   mistake is replacing the wrong asset ten minutes before a show.
 * - **Filing survives.** A corrected logo is the same logo: same folder, same
 *   tags, same license. An operator who has to re-file after every correction
 *   stops filing.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AssetRef, Composition, Layer, Project } from '@breeze/schema';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-asset-replace-'));
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

const upload = (project: string, name: string, body: string, replaces?: string) =>
  app.inject({
    method: 'POST',
    url:
      `/api/projects/${project}/assets?name=${encodeURIComponent(name)}` +
      (replaces ? `&replaces=${encodeURIComponent(replaces)}` : ''),
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from(body),
  });

async function makeProject(id: string): Promise<void> {
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: id, id } });
  expect(res.statusCode).toBe(201);
}

async function setCompositions(id: string, compositions: Composition[]): Promise<void> {
  const project = (await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json() as Project;
  const res = await app.inject({
    method: 'PUT',
    url: `/api/projects/${id}`,
    payload: { ...project, compositions },
  });
  expect(res.statusCode).toBe(200);
}

const comp = (id: string, name: string, layers: Layer[]): Composition => ({
  formatVersion: 1,
  id,
  name,
  stage: { width: 1920, height: 1080, fps: 60, background: 'transparent' },
  layers,
});

const image = (id: string, src: string): Layer => ({ id, type: 'image', src });

/** Every `src` and `mask.src` in a project, flattened — what actually goes to air. */
async function srcsOf(projectId: string): Promise<string[]> {
  const project = await store.readProject(projectId);
  const { referencedAssets } = await import('@breeze/schema');
  return project.compositions.flatMap((c) => referencedAssets(c.layers));
}

/* --------------------------------------------------------------- rewrite */

describe('replace rewrites every reference', () => {
  it('repoints layers across every composition, not just the open one', async () => {
    await makeProject('rewrite');
    const before = (await upload('rewrite', 'logo.png', 'v1')).json().asset as AssetRef;

    // Three compositions: two use the logo, one does not. The third is the
    // control — a replace that rewrites a composition with no reference to the
    // asset is rewriting on something other than the reference.
    await setCompositions('rewrite', [
      comp('a', 'Lower Third', [image('l1', before.path)]),
      comp('b', 'Screen Bug', [image('l2', before.path)]),
      comp('c', 'Ticker', [image('l3', 'assets/other.png')]),
    ]);

    const res = await upload('rewrite', 'logo.png', 'v2', before.id);
    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.rewritten).toBe(2);
    expect(body.compositions.map((c: { name: string }) => c.name)).toEqual([
      'Lower Third',
      'Screen Bug',
    ]);

    // The assertion that matters: nothing anywhere still points at the old file.
    const srcs = await srcsOf('rewrite');
    expect(srcs).not.toContain(before.path);
    expect(srcs.filter((s) => s === body.asset.path)).toHaveLength(2);
    expect(srcs).toContain('assets/other.png');
  });

  it('reaches a reference inside a group and inside a table cell', async () => {
    // The two containers a flat walk misses, and a badge in a standings row is
    // the realistic case for both.
    await makeProject('nested');
    const before = (await upload('nested', 'badge.png', 'n1')).json().asset as AssetRef;

    await setCompositions('nested', [
      comp('g', 'Grouped', [
        { id: 'grp', type: 'group', children: [image('inner', before.path)] } as Layer,
      ]),
      comp('t', 'Table', [
        {
          id: 'tbl',
          type: 'table',
          source: 'standings',
          row: { height: 40, cells: [image('cell', before.path)] },
        } as unknown as Layer,
      ]),
    ]);

    const body = (await upload('nested', 'badge.png', 'n2', before.id)).json();
    expect(body.rewritten).toBe(2);
    expect(await srcsOf('nested')).not.toContain(before.path);
  });

  it('reaches an image mask, which no panel displays', async () => {
    // The reference an operator replaces without ever having seen it listed.
    await makeProject('masked');
    const before = (await upload('masked', 'wipe.png', 'm1')).json().asset as AssetRef;

    await setCompositions('masked', [
      comp('m', 'Masked', [
        {
          id: 'shape',
          type: 'shape',
          shape: 'rect',
          mask: { type: 'image', x: 0, y: 0, width: 10, height: 10, src: before.path },
        } as unknown as Layer,
      ]),
    ]);

    const body = (await upload('masked', 'wipe.png', 'm2', before.id)).json();
    expect(body.rewritten).toBe(1);
    expect(await srcsOf('masked')).not.toContain(before.path);
  });

  it('succeeds when nothing references the asset', async () => {
    // Replacing a file that is not on air yet is ordinary — it is how an
    // operator corrects something before building with it.
    await makeProject('unused');
    const before = (await upload('unused', 'spare.png', 'u1')).json().asset as AssetRef;

    const res = await upload('unused', 'spare.png', 'u2', before.id);
    expect(res.statusCode).toBe(201);
    expect(res.json().rewritten).toBe(0);
    expect(res.json().compositions).toEqual([]);
  });
});

/* ------------------------------------------------------------ bookkeeping */

describe('replace bookkeeping', () => {
  it('retires the old asset and keeps its bytes on disk', async () => {
    await makeProject('retire');
    const before = (await upload('retire', 'logo.png', 'r1')).json().asset as AssetRef;
    const oldFile = path.join(tmpDir, 'projects', 'retire', before.path);

    const after = (await upload('retire', 'logo.png', 'r2', before.id)).json().asset as AssetRef;

    const assets = await store.listAssets('retire');
    const old = assets.find((a) => a.id === before.id);

    expect(old?.state).toBe('retired');
    expect(after.supersedes).toBe(before.id);
    // Retired, not deleted — the realistic mistake is replacing the wrong file
    // before a show, and that has to be recoverable by an operator.
    await expect(fs.access(oldFile)).resolves.toBeUndefined();
  });

  it('leaves exactly one live row for the name', async () => {
    // The whole point: two rows called logo.png is a bin nobody can read.
    const assets = await store.listAssets('retire');
    const live = assets.filter(
      (a) => a.originalName === 'logo.png' && a.state !== 'retired',
    );
    expect(live).toHaveLength(1);
  });

  it('carries filing, rights and title to the successor', async () => {
    await makeProject('carry');
    const before = (await upload('carry', 'sponsor.png', 'c1')).json().asset as AssetRef;

    await app.inject({
      method: 'PATCH',
      url: `/api/projects/carry/assets/${before.id}`,
      payload: {
        title: 'Sponsor bug',
        folder: 'sponsors',
        tags: ['sponsor', 'q3'],
        source: 'Agency',
        usage: 'licensed',
        expiresAt: '2026-12-31',
        state: 'approved',
      },
    });

    const after = (await upload('carry', 'sponsor.png', 'c2', before.id)).json().asset as AssetRef;

    expect(after).toMatchObject({
      title: 'Sponsor bug',
      folder: 'sponsors',
      tags: ['sponsor', 'q3'],
      source: 'Agency',
      usage: 'licensed',
      expiresAt: '2026-12-31',
      state: 'approved',
    });
  });

  it('does not carry technical fields derived from the old bytes', async () => {
    /*
     * The one that would hurt. Carrying `hasAlpha` across would let a
     * transparent .mov's flag survive onto a flattened re-export, and the
     * operator finds out over live pictures.
     */
    await makeProject('technical');
    const before = (await upload('technical', 'plate.png', 'aaaa')).json().asset as AssetRef;
    await store.recordAssetProbe('technical', before.id, {
      width: 1920,
      height: 1080,
      duration: 4,
      codec: 'prores',
      hasAlpha: true,
    });

    const after = (await upload('technical', 'plate.png', 'bbbb', before.id)).json().asset as AssetRef;

    expect(after.hasAlpha).toBeUndefined();
    expect(after.codec).toBeUndefined();
    expect(after.duration).toBeUndefined();
    expect(after.bytes).toBe('bbbb'.length);
  });

  it('un-retires: replacing a retired asset produces a live successor', async () => {
    // How an operator brings a superseded file back — they go and find it and
    // put a corrected version over it. Inheriting `retired` would hide the
    // result from the default view, which reads as the upload having failed.
    await makeProject('unretire');
    const first = (await upload('unretire', 'old.png', 'x1')).json().asset as AssetRef;
    await upload('unretire', 'old.png', 'x2', first.id);

    const back = (await upload('unretire', 'old.png', 'x3', first.id)).json().asset as AssetRef;
    expect(back.state).toBeUndefined();
    expect(back.supersedes).toBe(first.id);
  });
});

/* ----------------------------------------------------------------- edges */

describe('replace edge cases', () => {
  it('treats identical bytes as a plain re-upload, not a replacement', async () => {
    /*
     * The content hash is the identity, so this is replacing a file with
     * itself. Retiring the asset in favor of itself would empty the row the
     * operator was trying to update — and an operator who picks Replace and
     * happens to choose the file already there has done nothing wrong.
     */
    await makeProject('same');
    const before = (await upload('same', 'logo.png', 'unchanged')).json().asset as AssetRef;
    await setCompositions('same', [comp('a', 'A', [image('l1', before.path)])]);

    const res = await upload('same', 'logo.png', 'unchanged', before.id);
    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.asset.id).toBe(before.id);
    expect(body.replaced).toBeNull();
    expect(body.rewritten).toBe(0);

    const assets = await store.listAssets('same');
    expect(assets.filter((a) => a.state === 'retired')).toHaveLength(0);
    expect(await srcsOf('same')).toEqual([before.path]);
  });

  it('404s when the asset being replaced does not exist', async () => {
    await makeProject('missing');
    const res = await upload('missing', 'logo.png', 'bytes', 'no-such-asset');
    expect(res.statusCode).toBe(404);
  });

  it('does not write a partial replacement when the target is missing', async () => {
    // The 404 above must not have left the new bytes registered as an asset:
    // a failed replace that half-succeeded is a bin row nobody asked for.
    expect(await store.listAssets('missing')).toEqual([]);
  });

  it('still refuses an executable extension on a replace', async () => {
    // `?replaces=` must not become a way around the ingest guards — they are
    // checked before the parameter is even read.
    await makeProject('refused');
    const before = (await upload('refused', 'logo.png', 'f1')).json().asset as AssetRef;
    expect((await upload('refused', 'evil.html', 'x', before.id)).statusCode).toBe(415);
  });

  it('leaves an ordinary upload behaving exactly as it did', async () => {
    // The API contract for every existing client: no `?replaces=`, no replace.
    await makeProject('plain');
    const first = (await upload('plain', 'logo.png', 'p1')).json().asset as AssetRef;
    const body = (await upload('plain', 'logo.png', 'p2')).json();

    expect(body.replaced).toBeUndefined();
    const assets = await store.listAssets('plain');
    expect(assets).toHaveLength(2);
    expect(assets.every((a) => a.state !== 'retired')).toBe(true);
    expect(assets.find((a) => a.id === first.id)).toBeDefined();
  });
});
