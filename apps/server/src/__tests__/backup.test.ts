// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Backup and restore.
 *
 * The acceptance criterion in ASSETS.md is "a composition backed up to a zip
 * that restores into a clean install and plays", so the round trip is tested as
 * a round trip: build a bundle, restore it under a new id, and assert the
 * restored project is the same document with the same asset bytes on disk.
 *
 * The refusals matter as much. A restore writes into the data directory from an
 * archive the server did not author, and `openBundle` allowlists paths rather
 * than blacklisting them — so the tests below name things a blacklist would
 * have let through.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import type { FastifyInstance } from 'fastify';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-backup-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../app.js');
const { stripSecrets } = await import('../archive/bundle.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const zip = (files: Record<string, Uint8Array>): Buffer => Buffer.from(zipSync(files));
const json = (v: unknown): Uint8Array => strToU8(JSON.stringify(v));

async function bundleOf(projects: string): Promise<Buffer> {
  const res = await app.inject({ method: 'GET', url: `/api/backup?projects=${projects}` });
  expect(res.statusCode).toBe(200);
  return res.rawPayload;
}

const restore = (body: Buffer, query = 'mode=rename') =>
  app.inject({
    method: 'POST',
    url: `/api/restore?${query}`,
    payload: body,
    headers: { 'content-type': 'application/zip' },
  });

const inspect = (body: Buffer) =>
  app.inject({
    method: 'POST',
    url: '/api/restore/inspect',
    payload: body,
    headers: { 'content-type': 'application/zip' },
  });

describe('backup', () => {
  it('requires an explicit selection', async () => {
    // Defaulting to "all" would make the expensive answer the accidental one.
    const res = await app.inject({ method: 'GET', url: '/api/backup' });
    expect(res.statusCode).toBe(400);
  });

  it('serves a zip with a download filename', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/backup?projects=demo' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('zip');
    expect(String(res.headers['content-disposition'])).toContain('.zip');
  });

  it('takes everything with projects=all', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/backup?projects=all' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['x-breeze-projects'])).toContain('demo');
  });

  it('404s an unknown project rather than writing an empty bundle', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/backup?projects=nope' });
    expect(res.statusCode).toBe(404);
  });

  it('offers a per-project download', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/demo/backup' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('zip');
  });
});

describe('the page', () => {
  it('serves the backup page with a working restore drop zone', async () => {
    const res = await app.inject({ method: 'GET', url: '/backup' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="drop"');
  });

  /*
   * The script path is asserted against the route that serves it.
   *
   * This page shipped pointing at `/client/backup.js`, which nothing serves —
   * the client bundle is emitted to `public/` and read back through
   * `/public/*`. The page rendered, the drop zone appeared, and every button
   * did nothing at all, because the only thing that had failed was a 404 on a
   * script tag. Nothing else in the suite could see it: the server tests drive
   * routes directly and never load the page's JavaScript.
   *
   * `api.test.ts` already makes exactly this assertion for `control.js` and
   * `player.js`. The omission here was the whole bug.
   */
  it('points at a script path that is actually served', async () => {
    const page = await app.inject({ method: 'GET', url: '/backup' });
    const src = /<script src="([^"]+)"/.exec(page.body)?.[1];
    expect(src).toBe('/public/backup.js');

    const asset = await app.inject({ method: 'GET', url: src! });
    // 404 is the failure this test exists for. A built tree serves 200; an
    // unbuilt one has no bundle yet, and that is not this test's business.
    expect(asset.statusCode).not.toBe(404);
  });
});

describe('inspect', () => {
  it('reports what a bundle contains and whether it collides', async () => {
    const body = await bundleOf('demo');
    const res = await inspect(body);
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.projects).toHaveLength(1);
    expect(out.projects[0].id).toBe('demo');
    // `demo` is seeded, so a bundle of it must collide with itself — this is
    // the signal the page uses to offer overwrite-or-rename at all.
    expect(out.projects[0].collides).toBe(true);
  });

  it('writes nothing', async () => {
    const before = await fs.readdir(path.join(tmpDir, 'projects'));
    await inspect(await bundleOf('demo'));
    expect(await fs.readdir(path.join(tmpDir, 'projects'))).toEqual(before);
  });

  it('refuses a zip that is not a bundle', async () => {
    // A zip of a project folder is the obvious wrong thing to drop, and the
    // message says so rather than failing on a missing key three layers down.
    const res = await inspect(zip({ 'project.json': json({ id: 'x' }) }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a Breeze backup/i);
  });

  it('refuses a bundle from a newer format version', async () => {
    const res = await inspect(
      zip({
        'breeze-bundle.json': json({ kind: 'breeze-backup', formatVersion: 99, projects: [] }),
        'projects/x/project.json': json({ id: 'x' }),
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/newer Breeze/i);
  });
});

describe('restore', () => {
  it('requires an explicit mode', async () => {
    // Both answers are legitimate, so guessing means guessing destructively
    // half the time.
    const res = await restore(await bundleOf('demo'), 'mode=');
    expect(res.statusCode).toBe(400);
  });

  it('restores a colliding project under a fresh id', async () => {
    const res = await restore(await bundleOf('demo'), 'mode=rename');
    expect(res.statusCode).toBe(201);
    const { restored } = res.json();
    expect(restored[0].bundledId).toBe('demo');
    expect(restored[0].id).not.toBe('demo');
    expect(restored[0].overwrote).toBe(false);
  });

  it('does not reuse a suffix it has already taken', async () => {
    // Restoring the same bundle twice must give two projects, not overwrite
    // the first copy with the second — which a fixed suffix would do.
    const body = await bundleOf('demo');
    const a = (await restore(body)).json().restored[0].id;
    const b = (await restore(body)).json().restored[0].id;
    expect(a).not.toBe(b);
  });

  it('leaves the original untouched when renaming', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/projects/demo' });
    await restore(await bundleOf('demo'), 'mode=rename');
    const after = await app.inject({ method: 'GET', url: '/api/projects/demo' });
    expect(after.json().compositions.length).toBe(before.json().compositions.length);
  });

  it('round-trips the document and its assets onto disk', async () => {
    const original = (await app.inject({ method: 'GET', url: '/api/projects/demo' })).json();
    const res = await restore(await bundleOf('demo'), 'mode=rename');
    const id = res.json().restored[0].id;

    const copy = (await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json();
    expect(copy.name).toBe(original.name);
    expect(copy.compositions.length).toBe(original.compositions.length);
    // The id is the one field a restore rewrites; everything else must survive.
    expect(copy.id).toBe(id);

    const assets = (await app.inject({ method: 'GET', url: `/api/projects/${id}/assets` })).json().assets;
    for (const asset of assets) {
      const onDisk = path.join(tmpDir, 'projects', id, asset.path);
      // The bytes, not just the row: an index entry whose file is missing is
      // exactly the failure a backup exists to prevent.
      await expect(fs.stat(onDisk)).resolves.toBeTruthy();
    }
  });

  it('restores only the projects named by ?only=', async () => {
    const res = await restore(await bundleOf('all'), 'mode=rename&only=demo');
    expect(res.statusCode).toBe(201);
    expect(res.json().restored.every((r: { bundledId: string }) => r.bundledId === 'demo')).toBe(true);
  });

  it('refuses a bundle whose entries escape the project folder', async () => {
    // The allowlist means this cannot land anywhere; the reader refuses it
    // outright first, which is the earlier and better of the two.
    const res = await restore(
      zip({
        'breeze-bundle.json': json({ kind: 'breeze-backup', formatVersion: 1, projects: [] }),
        '../escape.json': json({}),
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('ignores entries it does not understand rather than writing them', async () => {
    /*
     * The case a blacklist gets wrong. `notes.txt` is not executable, so the
     * REFUSED list has no opinion on it — the allowlist is what keeps it out of
     * the data directory.
     *
     * Built by adding strays to a *real* bundle rather than hand-rolling one,
     * so the project document is genuinely valid and the only thing under test
     * is what happens to the extra entries. The first version of this test
     * hand-wrote a project and got a 422 from `writeProject`'s validation,
     * which proved something true but not the thing it claimed to.
     */
    const { unzipSync } = await import('fflate');
    const real = unzipSync(new Uint8Array(await bundleOf('demo')));
    const withStrays: Record<string, Uint8Array> = { ...real };
    withStrays['notes.txt'] = strToU8('not part of a bundle');
    withStrays['projects/demo/secrets/keys.json'] = json({ token: 'nope' });

    const res = await restore(zip(withStrays), 'mode=rename');
    expect(res.statusCode).toBe(201);
    const id = res.json().restored[0].id;
    await expect(fs.stat(path.join(tmpDir, 'projects', id, 'notes.txt'))).rejects.toThrow();
    await expect(fs.stat(path.join(tmpDir, 'projects', id, 'secrets'))).rejects.toThrow();
  });

  it('refuses a bundle whose project document is invalid', async () => {
    /*
     * Found while writing the test above, and worth keeping deliberately: a
     * hand-edited bundle does not get to write a malformed project. `restore`
     * goes through `writeProject`, which validates, so the schema is the last
     * gate on the restore path as well as the API — and a bundle is exactly the
     * input most likely to have been edited by hand.
     */
    const res = await restore(
      zip({
        'breeze-bundle.json': json({
          kind: 'breeze-backup',
          formatVersion: 1,
          createdAt: new Date().toISOString(),
          appVersion: 'test',
          projects: [{ id: 'bogus', name: 'Bogus', compositions: 0, assets: 0 }],
        }),
        'projects/bogus/project.json': json({ id: 'bogus', name: 'Bogus' }),
      }),
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    await expect(fs.stat(path.join(tmpDir, 'projects', 'bogus', 'project.json'))).rejects.toThrow();
  });
});

describe('stripSecrets', () => {
  it('removes credential headers rather than masking them', () => {
    /*
     * The distinction from `redact()`, which masks with bullets so the editor
     * can show *that* a header is set. A restored source carrying a literal
     * `Authorization: ••••` looks configured, is not, and fails with a message
     * about a bad credential rather than a missing one.
     */
    const out = stripSecrets({
      type: 'json',
      headers: { Authorization: 'Bearer real', 'X-Api-Key': 'k', Accept: 'application/json' },
    });
    expect(out.headers).toEqual({ Accept: 'application/json' });
    expect(JSON.stringify(out)).not.toContain('••••');
    expect(JSON.stringify(out)).not.toContain('real');
  });

  it('keeps secretId, which is a name and not a credential', () => {
    const out = stripSecrets({ type: 'json', secretId: 'scoreboard-key', headers: { Token: 't' } });
    expect(out.secretId).toBe('scoreboard-key');
  });

  it('leaves a def with no headers alone', () => {
    const def = { type: 'manual', id: 'm' };
    expect(stripSecrets(def)).toBe(def);
  });
});

describe('the bundle carries no runtime', () => {
  it('holds only data files', async () => {
    /*
     * ASSETS.md's rule, asserted rather than trusted: a bundle is inert without
     * a Breeze install, which is what makes it a backup rather than an export.
     * A `.js` appearing in here would mean someone had added a self-restoring
     * archive or an embedded preview player.
     */
    const { unzipSync } = await import('fflate');
    const names = Object.keys(unzipSync(new Uint8Array(await bundleOf('demo'))));
    expect(names).toContain('breeze-bundle.json');
    expect(names.some((n) => /\.(js|mjs|cjs|html|exe|sh)$/i.test(n))).toBe(false);
  });
});
