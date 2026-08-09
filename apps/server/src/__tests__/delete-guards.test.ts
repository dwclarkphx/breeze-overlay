// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Deleting a composition that something still mounts.
 *
 * A `composition` layer holds its target by id, and nothing in the schema
 * repairs a reference to a document that no longer exists: the parent loads,
 * plays, and is quietly missing a graphic. That is a fault which surfaces on
 * air, so the delete is refused rather than warned about — and the refusal has
 * to survive the two shapes the reference can take, a direct layer and one
 * buried inside a group.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createComposition, type Composition, type Layer } from '@breeze/schema';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-delete-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../app.js');

let app: FastifyInstance;
let projectId: string;

async function putComp(comp: Composition): Promise<void> {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/projects/${projectId}/compositions/${comp.id}`,
    payload: comp,
  });
  expect(res.statusCode, res.body).toBe(200);
}

beforeAll(async () => {
  app = await buildApp({ seed: false });

  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'Delete Guards', key: 'guards' },
  });
  projectId = created.json().id as string;

  await putComp(createComposition({ id: 'bug', name: 'Screen Bug' }));
  await putComp(createComposition({ id: 'sting', name: 'Sting' }));
  await putComp(createComposition({ id: 'orphan', name: 'Orphan' }));

  // Mounts `bug` directly as a scene element, and `sting` from inside a group.
  await putComp(
    createComposition({
      id: 'game',
      name: 'Game Scene',
      layers: [
        { id: 'e1', name: 'Bug', type: 'composition', ref: 'bug', independent: true } as Layer,
        {
          id: 'g1',
          name: 'Stingers',
          type: 'group',
          children: [
            { id: 'e2', name: 'Opener', type: 'composition', ref: 'sting' } as Layer,
          ],
        } as Layer,
      ],
    }),
  );
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('composition referrers', () => {
  it('names the composition and the layer doing the mounting', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/compositions/bug/referrers`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().referrers).toEqual([
      { id: 'game', name: 'Game Scene', layer: 'Bug', independent: true },
    ]);
  });

  it('finds a reference nested inside a group', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/compositions/sting/referrers`,
    });

    expect(res.json().referrers).toEqual([
      { id: 'game', name: 'Game Scene', layer: 'Opener', independent: false },
    ]);
  });

  it('falls back to the layer id when the layer has no name', async () => {
    await putComp(
      createComposition({
        id: 'unnamed',
        name: 'Unnamed Host',
        // `name` is optional on a layer, and the editor shows the id in its
        // place. A referrer list saying "layer" and then nothing is an
        // instruction to go and unlink something the user cannot identify.
        layers: [{ id: 'lyr-77', type: 'composition', ref: 'orphan' } as Layer],
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/compositions/orphan/referrers`,
    });

    expect(res.json().referrers).toEqual([
      { id: 'unnamed', name: 'Unnamed Host', layer: 'lyr-77', independent: false },
    ]);

    // Put it back for the tests below, which expect `orphan` to be free.
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/compositions/unnamed`,
      payload: createComposition({ id: 'unnamed', name: 'Unnamed Host' }),
    });
  });

  it('returns nothing for a composition no one mounts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/compositions/orphan/referrers`,
    });

    expect(res.json().referrers).toEqual([]);
  });

  it('404s for a composition that does not exist, rather than claiming it is safe', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/compositions/nope/referrers`,
    });

    // An empty referrer list reads as "nothing uses this, go ahead" — the worst
    // possible answer to a question about an id that was mistyped.
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE composition', () => {
  it('refuses while something still mounts it, and says what', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/compositions/bug`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().referrers).toHaveLength(1);
    expect(res.json().error).toContain('still used by 1 composition');

    // And it really is still there.
    const still = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/compositions/bug`,
    });
    expect(still.statusCode).toBe(200);
  });

  it('refuses for a reference inside a group too', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/compositions/sting`,
    });
    expect(res.statusCode).toBe(409);
  });

  it('deletes one nothing points at', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/compositions/orphan`,
    });

    expect(res.statusCode).toBe(200);
    const gone = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/compositions/orphan`,
    });
    expect(gone.statusCode).toBe(404);
  });

  it('allows the delete once the referring layer is removed', async () => {
    // Strip the group holding the `sting` reference, keeping the bug element.
    await putComp(
      createComposition({
        id: 'game',
        name: 'Game Scene',
        layers: [
          { id: 'e1', name: 'Bug', type: 'composition', ref: 'bug', independent: true } as Layer,
        ],
      }),
    );

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/compositions/sting`,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /docs', () => {
  let html = '';

  beforeAll(async () => {
    html = (await app.inject({ method: 'GET', url: '/docs' })).body;
  });

  /**
   * The guide opens with a sixteen-entry table of contents written as
   * GitHub-style `#4-the-app-bar…` links, because the file is also read on
   * GitHub. `marked` stopped emitting heading ids in v5, so without the slugs
   * added in `routes/docs.ts` the first thing on the page is sixteen links that
   * silently do nothing.
   */
  it('renders the guide with working contents links', () => {
    const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!);
    expect(anchors.length).toBeGreaterThan(15);

    const broken = anchors.filter((a) => !html.includes(`id="${a}"`));
    expect(broken).toEqual([]);
  });

  it('keeps the doubled hyphen a removed dash leaves behind', () => {
    // `## 4. The app bar — projects, saving, undo`. Collapsing the two spaces
    // the em dash sat between into one hyphen breaks five of the sixteen.
    expect(html).toContain('id="4-the-app-bar--projects-saving-undo"');
  });

  it("rewrites the guide's repo-relative images to the served path", () => {
    expect(html).toContain('src="/docs/images/');
    expect(html).not.toMatch(/<img[^>]+src="images\//);
  });

  it('refuses to serve anything outside docs/images', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/docs/images/..%2fUSER-GUIDE.md',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('GET /api/status', () => {
  it('answers without an API key, and reports the version', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(typeof body.version).toBe('string');
    expect(body.viewers.renderers).toBe(0);
    expect(body.cpu.cores).toBeGreaterThan(0);
  });
});
