// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * `POST /api/projects/:id/compositions` — creating a scene.
 *
 * The id it mints is the thing under test. It has to obey the same key rules a
 * project id does, and it has to avoid colliding with anything else the project
 * already answers to — which includes the channels a scene's independent
 * elements occupy, not just the other composition ids.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createComposition, type Layer } from '@breeze/schema';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-newscene-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../app.js');

let app: FastifyInstance;
let projectId: string;

const post = (body: unknown) =>
  app.inject({ method: 'POST', url: `/api/projects/${projectId}/compositions`, payload: body });

beforeAll(async () => {
  app = await buildApp({ seed: false });
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'New Scene Tests', key: 'nst' },
  });
  projectId = created.json().id as string;
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('creating a scene', () => {
  it('mints an id from the chosen key, with a generated suffix', async () => {
    const res = await post({ name: 'Lower Third — Name', key: 'l3rd' });

    expect(res.statusCode).toBe(201);
    const comp = res.json();
    expect(comp.name).toBe('Lower Third — Name');
    expect(comp.id).toMatch(/^l3rd-[a-z0-9]+$/);
    expect(comp.layers).toEqual([]);
  });

  it('appends it to the project rather than replacing anything', async () => {
    const before = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}` }))
      .json().compositions.length;

    await post({ name: 'Badge', key: 'badge' });

    const after = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}` }))
      .json().compositions;
    expect(after).toHaveLength(before + 1);
    expect(after.some((c: { name: string }) => c.name === 'Badge')).toBe(true);
  });

  it('falls back to the default prefix when no key is given', async () => {
    const res = await post({ name: 'Unkeyed' });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toMatch(/^comp-[a-z0-9]+$/);
  });

  it('names it rather than leaving the name blank', async () => {
    const res = await post({});
    expect(res.json().name).toBe('Untitled scene');
  });

  it('rejects a bad key as a field error, not a server fault', async () => {
    const res = await post({ name: 'Bad', key: 'NOT VALID!' });

    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('key');
    // The message names the rule that was broken, so the editor can put it
    // under the input.
    expect(res.json().error).toContain('invalid key');
  });

  it('lowercases a key rather than rejecting it', async () => {
    // `RAHB` is unambiguous, and the lowercase rule exists for the filesystem's
    // benefit rather than the caller's — same reasoning as project creation.
    const res = await post({ name: 'Shouty', key: 'SHOUTY' });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toMatch(/^shouty-/);
  });

  it('does not collide with a scene element channel', async () => {
    // A scene mounting an element on channel `bug` means /control/<p>/bug is
    // already answered. A new composition with that id would give it two
    // answers, and which one replies is not something to discover on air.
    // The element's target has to exist: `listChannels` only reports a channel
    // for an element whose `ref` resolves, so a scene mounting a phantom would
    // reserve nothing.
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/compositions/screen-bug`,
      payload: createComposition({ id: 'screen-bug', name: 'Screen Bug Source' }),
    });

    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/compositions/game`,
      payload: createComposition({
        id: 'game',
        name: 'Game Scene',
        layers: [
          {
            id: 'e1',
            name: 'Bug',
            type: 'composition',
            ref: 'screen-bug',
            independent: true,
            channel: 'bug',
          } as Layer,
        ],
      }),
    });

    const channels = (await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/channels`,
    })).json().channels.map((c: { channel: string }) => c.channel);
    expect(channels).toContain('bug');

    const res = await post({ name: 'Screen Bug', key: 'bug' });
    expect(res.statusCode).toBe(201);
    // Suffixed, so it cannot be `bug` itself.
    expect(res.json().id).toMatch(/^bug-[a-z0-9]+$/);
    expect(res.json().id).not.toBe('bug');
  });

  it('404s for a project that does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/no-such-project/compositions',
      payload: { name: 'Orphan' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('inherits the stage of the project it is added to', async () => {
    // A 1280x720 project gaining a 1920x1080 scene is a surprise nobody goes
    // looking for until the graphic is the wrong size on air.
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Seven Twenty', key: 'sevtwenty' },
    });
    const smallId = created.json().id as string;
    const first = created.json().compositions[0];

    await app.inject({
      method: 'PUT',
      url: `/api/projects/${smallId}/compositions/${first.id}`,
      payload: { ...first, stage: { ...first.stage, width: 1280, height: 720 } },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${smallId}/compositions`,
      payload: { name: 'Added later' },
    });

    expect(res.json().stage.width).toBe(1280);
    expect(res.json().stage.height).toBe(720);
  });
});
