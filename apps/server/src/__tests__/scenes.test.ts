// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createComposition, type Composition, type Layer } from '@breeze/schema';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-scenes-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../app.js');
const { listChannels } = await import('../store.js');

let app: FastifyInstance;
let projectId: string;

const element = (id: string, ref: string, channel?: string): Layer =>
  ({ id, type: 'composition', ref, independent: true, ...(channel ? { channel } : {}) }) as Layer;

async function putComp(comp: Composition): Promise<void> {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/projects/${projectId}/compositions/${comp.id}`,
    payload: comp,
  });
  expect(res.statusCode, res.body).toBe(200);
}

beforeAll(async () => {
  app = await buildApp();

  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'Random A Highschool - Basketball', key: 'rahb' },
  });
  expect(created.statusCode).toBe(201);
  projectId = created.json().id as string;

  await putComp(createComposition({ id: 'bug', name: 'Screen Bug' }));
  await putComp(createComposition({ id: 'lower-third', name: 'Lower Third' }));
  await putComp(
    createComposition({
      id: 'game-scene',
      name: 'Game Scene',
      layers: [
        { id: 'band', type: 'shape', shape: 'rect' } as Layer,
        element('e1', 'bug'),
        element('e2', 'lower-third'),
      ],
    }),
  );
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('URL keys on create', () => {
  it('puts the chosen key in front of the generated id', () => {
    expect(projectId.startsWith('rahb-')).toBe(true);
  });

  it('serves the project at that key', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Random A Highschool - Basketball');
  });

  it('rejects an illegal key with a 400 naming the field', async () => {
    // User input from a form, not a server fault — the editor needs to put the
    // message under the input rather than show a 500. And rejected rather than
    // truncated: silently handing back a URL nobody chose is worse than a
    // refusal, because the caller only finds out when a trigger 404s.
    for (const key of ['this-key-is-far-too-long', 'a b', 'a/b', '-bug', 'a.b']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Nope', key },
      });
      expect(res.statusCode, key).toBe(400);
      expect(res.json().field).toBe('key');
    }
  });

  it('coerces case rather than rejecting it', async () => {
    // The lowercase rule exists for the filesystem's benefit, not the caller's:
    // the id is a directory name, and RAHB and rahb are the same folder on
    // Windows and different ones in the container.
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Shouty', key: 'LOUD' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id.startsWith('loud-')).toBe(true);
  });

  it('still generates a default key when none is given', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Plain' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().id.startsWith('proj-')).toBe(true);
  });

  it('suggests initials from a name', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/keys/suggest?name=Random%20A%20Highschool%20-%20Basketball',
    });
    expect(res.json()).toMatchObject({ key: 'rahb', valid: true });
  });
});

describe('channel index', () => {
  it('lists every composition plus every element', async () => {
    // Not an exact list: createProject seeds an empty starter composition, and
    // that is addressable too.
    const channels = (await listChannels(projectId)).map((c) => c.channel);
    expect(channels).toEqual(expect.arrayContaining(['bug', 'lower-third', 'game-scene']));
  });

  it('does not list an element twice when it is also a composition', async () => {
    const channels = (await listChannels(projectId)).map((c) => c.channel);
    expect(channels.filter((c) => c === 'bug')).toHaveLength(1);
  });

  it('says which scene an element belongs to', async () => {
    const channels = await listChannels(projectId);
    const bug = channels.find((c) => c.channel === 'bug')!;
    // 'bug' is a composition in its own right *and* mounted in the scene. The
    // composition claim wins, which is what makes a direct /play/<proj>/bug and
    // the scene's copy share one channel — deliberately.
    expect(bug.sceneId).toBeNull();
  });

  it('exposes the index over REST', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/channels` });
    expect(res.statusCode).toBe(200);
    expect(res.json().channels.map((c: { channel: string }) => c.channel)).toContain('game-scene');
  });

  it('picks up an aliased channel that is not a composition id', async () => {
    await putComp(
      createComposition({
        id: 'two-badges',
        layers: [element('a', 'bug', 'bug-home'), element('b', 'bug', 'bug-away')],
      }),
    );
    const channels = (await listChannels(projectId)).map((c) => c.channel);
    expect(channels).toContain('bug-home');
    expect(channels).toContain('bug-away');
  });
});

describe('control routes', () => {
  it('triggers an element by its channel', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/control/${projectId}/bug/play` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, verb: 'play', channel: `${projectId}/bug` });
  });

  it('triggers an aliased element that is not a composition id', async () => {
    // The old guard resolved via getComposition and 404'd here — on exactly the
    // URLs scenes exist to provide.
    const res = await app.inject({ method: 'POST', url: `/api/control/${projectId}/bug-home/play` });
    expect(res.statusCode).toBe(200);
  });

  it('still 404s on a name that is neither', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/control/${projectId}/nonsense/play` });
    expect(res.statusCode).toBe(404);
  });

  it('fans clear-all out to the scene and every element', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/control/${projectId}/game-scene/clear-all` });
    expect(res.statusCode).toBe(200);
    expect(res.json().channels).toEqual([
      `${projectId}/game-scene`,
      `${projectId}/bug`,
      `${projectId}/lower-third`,
    ]);
  });

  it('offers no play-all — rolling everything at once is not an operation', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/control/${projectId}/game-scene/play-all` });
    expect(res.statusCode).toBe(404);
  });
});

describe('pages', () => {
  it('inlines the element list on the scene output page', async () => {
    const res = await app.inject({ method: 'GET', url: `/play/${projectId}/game-scene` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"channel":"bug"');
    expect(res.body).toContain('"channel":"lower-third"');
  });

  it('inlines no elements for an ordinary graphic', async () => {
    const res = await app.inject({ method: 'GET', url: `/play/${projectId}/bug` });
    expect(res.body).toContain('elements: []');
  });

  it('renders an element block per element on the scene panel', async () => {
    const res = await app.inject({ method: 'GET', url: `/control/${projectId}/game-scene` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-channel="bug"');
    expect(res.body).toContain('data-channel="lower-third"');
    expect(res.body).toContain('id="clear-all"');
  });

  it('renders no element block on an ordinary panel', async () => {
    const res = await app.inject({ method: 'GET', url: `/control/${projectId}/bug` });
    expect(res.body).not.toContain('id="clear-all"');
  });
});
