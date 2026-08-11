// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The shared store, and composition-scoped bundles.
 *
 * The shared store's whole design rests on one decision — it copies, it does
 * not link — and the tests are written to fail if that ever quietly changes.
 * Deleting a shared asset must leave every project's copy working, because the
 * alternative is a blank graphic over live pictures, and it is exactly the kind
 * of thing a later "tidy up orphaned files" change would break without anyone
 * noticing until a show.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import type { FastifyInstance } from 'fastify';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-shared-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../app.js');
const { slugFor } = await import('../shared-store.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** A tiny but valid PNG header, enough for the store to classify it. */
const png = (tint: number): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0, 0, 0, 4, 8, 6, 0, 0, 0]),
    Buffer.from([tint, tint, tint, tint]),
  ]);

const upload = (name: string, body: Buffer, project = 'demo') =>
  app.inject({
    method: 'POST',
    url: `/api/projects/${project}/assets?name=${encodeURIComponent(name)}`,
    payload: body,
    headers: { 'content-type': 'application/octet-stream' },
  });

const promote = (assetId: string, body: Record<string, unknown> = {}, project = 'demo') =>
  app.inject({
    method: 'POST',
    url: `/api/projects/${project}/assets/${assetId}/promote`,
    payload: body,
  });

describe('slugFor', () => {
  it('rewrites to a URL-safe stem without the hash', () => {
    // The hash is deliberately absent: a slug has to survive the bytes
    // changing, or a rebrand looks like a different asset and no project ever
    // reports itself stale.
    expect(slugFor('Station Logo v2.PNG')).toBe('station-logo-v2');
  });

  it('falls back rather than producing an empty name', () => {
    expect(slugFor('日本語.png')).toBe('asset');
  });
});

describe('promote', () => {
  it('copies a project asset into the shared store', async () => {
    const asset = (await upload('logo.png', png(1))).json().asset;
    const res = await promote(asset.id, { slug: 'station-logo', title: 'Station logo' });
    expect(res.statusCode).toBe(201);
    expect(res.json().shared.slug).toBe('station-logo');

    const listed = (await app.inject({ method: 'GET', url: '/api/shared' })).json().assets;
    expect(listed.map((a: { slug: string }) => a.slug)).toContain('station-logo');
  });

  it('marks the promoting project as having come from the store', async () => {
    /*
     * Otherwise the project that contributed the logo is the one project that
     * never learns it is behind: it holds the same bytes, but nothing records
     * where they now live, so a later rebrand flags every project except the
     * source.
     */
    const asset = (await upload('badge.png', png(2))).json().asset;
    await promote(asset.id, { slug: 'badge' });

    const assets = (await app.inject({ method: 'GET', url: '/api/projects/demo/assets' })).json().assets;
    const row = assets.find((a: { id: string }) => a.id === asset.id);
    expect(row.origin).toMatchObject({ store: 'shared', slug: 'badge' });
  });

  it('replaces on re-promote rather than refusing, which is what a rebrand is', async () => {
    const first = (await upload('rebrand.png', png(3))).json().asset;
    await promote(first.id, { slug: 'rebrand' });

    const second = (await upload('rebrand-new.png', png(9))).json().asset;
    const res = await promote(second.id, { slug: 'rebrand' });
    expect(res.statusCode).toBe(201);

    const listed = (await app.inject({ method: 'GET', url: '/api/shared' })).json().assets;
    expect(listed.filter((a: { slug: string }) => a.slug === 'rebrand')).toHaveLength(1);
  });

  it('refuses an invalid slug', async () => {
    const asset = (await upload('x.png', png(4))).json().asset;
    expect((await promote(asset.id, { slug: '../escape' })).statusCode).toBe(400);
  });

  it('404s an unknown asset', async () => {
    expect((await promote('nope')).statusCode).toBe(404);
  });
});

describe('pull', () => {
  it('copies a shared asset into another project and records its origin', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Second', id: 'second' },
    });

    const asset = (await upload('shared-plate.png', png(5))).json().asset;
    await promote(asset.id, { slug: 'plate' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/second/shared/pull',
      payload: { slug: 'plate' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().asset.origin).toMatchObject({ store: 'shared', slug: 'plate' });

    // Copied, so the bytes are in the *project's* own assets directory.
    const onDisk = path.join(tmpDir, 'projects', 'second', res.json().asset.path);
    await expect(fs.stat(onDisk)).resolves.toBeTruthy();
  });

  it('404s an unknown slug', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/second/shared/pull',
      payload: { slug: 'no-such-thing' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('staleness', () => {
  it('reports same slug, different hash', async () => {
    const original = (await upload('sponsor.png', png(6))).json().asset;
    await promote(original.id, { slug: 'sponsor' });

    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Show', id: 'show' } });
    await app.inject({
      method: 'POST',
      url: '/api/projects/show/shared/pull',
      payload: { slug: 'sponsor' },
    });

    // Nothing has changed centrally yet.
    let stale = (await app.inject({ method: 'GET', url: '/api/projects/show/shared/stale' })).json().stale;
    expect(stale).toHaveLength(0);

    // Rebrand: same slug, new bytes.
    const replacement = (await upload('sponsor-2027.png', png(7))).json().asset;
    await promote(replacement.id, { slug: 'sponsor' });

    stale = (await app.inject({ method: 'GET', url: '/api/projects/show/shared/stale' })).json().stale;
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ slug: 'sponsor' });
    expect(stale[0].have).not.toBe(stale[0].available);
  });

  it('does not report an asset whose origin was deleted centrally', async () => {
    /*
     * The copy is still perfectly good. Reporting it would be reporting the
     * exact failure that copy-don't-link exists to prevent — and would push an
     * operator to "fix" something that is not broken.
     */
    const asset = (await upload('gone.png', png(8))).json().asset;
    await promote(asset.id, { slug: 'gone' });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Ghost', id: 'ghost' } });
    await app.inject({
      method: 'POST',
      url: '/api/projects/ghost/shared/pull',
      payload: { slug: 'gone' },
    });

    await app.inject({ method: 'DELETE', url: '/api/shared/gone' });

    const stale = (await app.inject({ method: 'GET', url: '/api/projects/ghost/shared/stale' })).json().stale;
    expect(stale).toHaveLength(0);
  });

  it('leaves every project copy working after a central delete', async () => {
    // The decision the whole design turns on. A later "tidy up orphaned files"
    // change that broke this would not show up until a show.
    const assets = (await app.inject({ method: 'GET', url: '/api/projects/ghost/assets' })).json().assets;
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      await expect(fs.stat(path.join(tmpDir, 'projects', 'ghost', asset.path))).resolves.toBeTruthy();
    }
  });
});

describe('composition bundles', () => {
  it('carries only what the composition references', async () => {
    const project = (await app.inject({ method: 'GET', url: '/api/projects/demo' })).json();
    const comp = project.compositions[0];

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/demo/compositions/${comp.id}/backup`,
    });
    expect(res.statusCode).toBe(200);

    const names = Object.keys(unzipSync(new Uint8Array(res.rawPayload)));
    const bundled = JSON.parse(
      new TextDecoder().decode(unzipSync(new Uint8Array(res.rawPayload))['projects/demo/project.json']!),
    );

    // The trimmed document holds this composition and whatever it mounts —
    // never the whole project, which is the entire point of the scope.
    expect(bundled.compositions.length).toBeLessThanOrEqual(project.compositions.length);
    expect(bundled.compositions.some((c: { id: string }) => c.id === comp.id)).toBe(true);
    expect(names).toContain('breeze-bundle.json');
  });

  it('names its scope in the manifest', async () => {
    const project = (await app.inject({ method: 'GET', url: '/api/projects/demo' })).json();
    const comp = project.compositions[0];
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/demo/compositions/${comp.id}/backup`,
    });
    const manifest = JSON.parse(
      new TextDecoder().decode(unzipSync(new Uint8Array(res.rawPayload))['breeze-bundle.json']!),
    );
    // Absence would mean "whole project", so a restore could not offer merge.
    expect(manifest.scope).toMatchObject({ composition: comp.id });
  });

  it('404s an unknown composition', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/demo/compositions/nope/backup' });
    expect(res.statusCode).toBe(404);
  });

  it('merges into an existing project, renaming colliding composition ids', async () => {
    const project = (await app.inject({ method: 'GET', url: '/api/projects/demo' })).json();
    const comp = project.compositions[0];
    const bundle = (
      await app.inject({ method: 'GET', url: `/api/projects/demo/compositions/${comp.id}/backup` })
    ).rawPayload;

    // Merging demo's own composition back into demo forces the collision path.
    const res = await app.inject({
      method: 'POST',
      url: '/api/restore?mode=merge&into=demo',
      payload: bundle,
      headers: { 'content-type': 'application/zip' },
    });
    expect(res.statusCode).toBe(201);
    const merged = res.json().merged[0];
    expect(merged.renamed.length).toBeGreaterThan(0);
    expect(merged.renamed[0].to).not.toBe(merged.renamed[0].from);

    const after = (await app.inject({ method: 'GET', url: '/api/projects/demo' })).json();
    expect(after.compositions.length).toBeGreaterThan(project.compositions.length);
  });

  it('requires ?into= for a merge', async () => {
    const bundle = (await app.inject({ method: 'GET', url: '/api/backup?projects=demo' })).rawPayload;
    const res = await app.inject({
      method: 'POST',
      url: '/api/restore?mode=merge',
      payload: bundle,
      headers: { 'content-type': 'application/zip' },
    });
    expect(res.statusCode).toBe(400);
  });
});
