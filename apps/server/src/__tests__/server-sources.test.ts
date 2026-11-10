// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Server-level data sources through the API (0.80.0).
 *
 * The registry's half is in `server-sources-registry.test.ts`. This is the half
 * a person meets: the `/api/server` mount, a project linking to a source and
 * being refused a link to nothing, the delete that will not reach into a
 * project, moving a source up without the graphic blinking, a Refresh held to
 * the source's limits, and a project that arrives by restore starting to poll
 * without anyone opening the editor — the gap this release was asked to close.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-server-sources-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';
// No timers: every fetch below is one a test asked for, so it can be counted.
process.env['BREEZE_DATA_POLLING'] = '0';
process.env['BREEZE_DATA_ALLOW_HOSTS'] = 'feed.example';

vi.mock('../data/fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/fetch.js')>()),
  fetchText: vi.fn(),
}));

const { fetchText } = await import('../data/fetch.js');
const { buildApp } = await import('../app.js');
const { SOURCES_PAGE_URL } = await import('../routes/editor.js');

const fetchMock = vi.mocked(fetchText);
const FEED = 'https://feed.example/scores.json';
let feedRows: Array<Record<string, unknown>> = [{ team: 'Mesa', score: 3 }];
fetchMock.mockImplementation(async (url: string) => {
  if (url === FEED) return { body: JSON.stringify(feedRows), status: 200 };
  throw new Error(`fetch failed: ${url}`);
});

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const feed = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Scores ${id}`,
  type: 'http-json',
  url: FEED,
  ...extra,
});

const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, payload: payload as object });
const get = (url: string) => app.inject({ method: 'GET', url });
const post = (url: string) => app.inject({ method: 'POST', url });
const del = (url: string) => app.inject({ method: 'DELETE', url });

async function newProject(name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name } });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return (res.json() as { id: string }).id;
}

interface Row {
  def: { id: string; name: string; type: string; source?: string };
  status: { revision: number; rowCount: number; lastError?: string; lastSuccess?: string };
  rowCount: number;
  refreshIn?: number;
  linked?: { id: string; name: string; type: string } | null;
  links?: Array<{ project: string; projectName: string; id: string }>;
}

describe('the /api/server mount', () => {
  it('saves a fetched source, fetches it at once, and lists it', async () => {
    const saved = await put('/api/server/datasources/scores', feed('scores'));
    expect(saved.statusCode, saved.body).toBe(200);

    const list = (await get('/api/server/datasources')).json() as { sources: Row[] };
    const row = list.sources.find((s) => s.def.id === 'scores')!;
    expect(row.rowCount).toBe(1);
    expect(row.status.lastSuccess).toBeDefined();

    // On disk beside the projects, not inside one.
    const file = JSON.parse(await fs.readFile(path.join(tmpDir, 'server', 'datasources.json'), 'utf8')) as {
      sources: Array<{ id: string }>;
    };
    expect(file.sources.map((s) => s.id)).toEqual(['scores']);
  });

  it('refuses the kinds that hold a show\'s own state', async () => {
    const manual = await put('/api/server/datasources/table', {
      id: 'table',
      name: 'Table',
      type: 'manual',
      columns: [],
      rows: [],
    });
    expect(manual.statusCode).toBe(400);
    expect(manual.json()).toMatchObject({ error: expect.stringMatching(/belongs to a project/) });

    const poll = await put('/api/server/datasources/poll', {
      id: 'poll',
      name: 'Poll',
      type: 'poll',
      question: 'Q',
      options: [{ id: 'a', label: 'A' }],
    });
    expect(poll.statusCode).toBe(400);

    const link = await put('/api/server/datasources/again', { id: 'again', name: 'Again', type: 'link', source: 'scores' });
    expect(link.statusCode).toBe(400);
  });

  it('previews a source that has not been saved', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/server/datasources-preview',
      payload: { def: feed('unsaved') },
    });
    expect(res.json()).toMatchObject({ ok: true, data: { rows: [{ team: 'Mesa', score: 3 }] } });
  });
});

describe('linking a project to a server-level source', () => {
  let news: string;
  let sport: string;

  beforeAll(async () => {
    news = await newProject('News');
    sport = await newProject('Sport');
  });

  it('gives the project the server source\'s rows without another fetch', async () => {
    const before = fetchMock.mock.calls.length;
    const res = await put(`/api/projects/${news}/datasources/scores`, {
      id: 'scores',
      name: 'Scores',
      type: 'link',
      source: 'scores',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(before);

    const one = (await get(`/api/projects/${news}/datasources/scores?rows=10`)).json() as {
      data: { rows: unknown[] };
      linked: Row['linked'];
    };
    expect(one.data.rows).toEqual([{ team: 'Mesa', score: 3 }]);
    expect(one.linked).toMatchObject({ id: 'scores', type: 'http-json' });
  });

  it('refuses a link to a source that is not there', async () => {
    const res = await put(`/api/projects/${news}/datasources/ghost`, {
      id: 'ghost',
      name: 'Ghost',
      type: 'link',
      source: 'nothing-here',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/no server-level data source "nothing-here"/) });
  });

  it('lists every source on the server, with the projects linked to each', async () => {
    await put(`/api/projects/${sport}/datasources/live`, { id: 'live', name: 'Live', type: 'link', source: 'scores' });
    await put(`/api/projects/${sport}/datasources/roster`, {
      id: 'roster',
      name: 'Roster',
      type: 'manual',
      columns: [{ key: 'player', type: 'string' }],
      rows: [{ player: 'Ortiz' }],
    });

    const all = (await get('/api/sources')).json() as {
      server: Row[];
      projects: Array<{ id: string; name: string; sources: Row[] }>;
    };
    const scores = all.server.find((s) => s.def.id === 'scores')!;
    expect(scores.links!.map((l) => `${l.projectName}/${l.id}`)).toEqual(['News/scores', 'Sport/live']);

    // A project's own sources are listed under it; its links are not listed twice.
    const mine = all.projects.find((p) => p.id === sport)!;
    expect(mine.sources.map((s) => s.def.id)).toEqual(['roster']);
    expect(all.projects.find((p) => p.id === news)).toBeUndefined();
  });

  it('will not delete a server source a project links to, and says which', async () => {
    const res = await del('/api/server/datasources/scores');
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; links: Array<{ projectName: string }> };
    expect(body.error).toMatch(/News, Sport/);
    expect(body.links).toHaveLength(2);
    // Still there, still served.
    expect((await get('/api/server/datasources/scores')).statusCode).toBe(200);
  });

  it('deletes it once nothing links to it — unlinking, or deleting the project', async () => {
    await put('/api/server/datasources/spare', feed('spare'));
    const temp = await newProject('Temp');
    await put(`/api/projects/${temp}/datasources/spare`, { id: 'spare', name: 'Spare', type: 'link', source: 'spare' });
    expect((await del('/api/server/datasources/spare')).statusCode).toBe(409);

    // The project goes, and takes its link with it — from the registry too.
    expect((await del(`/api/projects/${temp}`)).statusCode).toBeLessThan(300);
    const all = (await get('/api/sources')).json() as { server: Row[] };
    expect(all.server.find((s) => s.def.id === 'spare')!.links).toEqual([]);

    expect((await del('/api/server/datasources/spare')).statusCode).toBe(204);
  });
});

describe('moving a project\'s source to the server', () => {
  it('leaves a link under the same id, with the rows still there', async () => {
    const project = await newProject('Weather desk');
    await put(`/api/projects/${project}/datasources/canned`, {
      id: 'canned',
      name: 'Unavailable',
      type: 'manual',
      columns: [{ key: 'team', type: 'string' }],
      rows: [{ team: 'Unavailable' }],
    });
    await put(`/api/projects/${project}/datasources/results`, feed('results', { fallback: 'canned' }));

    const res = await post(`/api/projects/${project}/datasources/results/move-to-server`);
    expect(res.statusCode, res.body).toBe(200);
    const moved = res.json() as { def: Row['def'] & { fallback?: string }; server: { id: string; fallback?: string } };

    // The link keeps the id layers are bound to, and the project's backup with it.
    expect(moved.def).toMatchObject({ id: 'results', type: 'link', source: 'results', fallback: 'canned' });
    // The backup named a table in the project, which the server scope cannot see.
    expect(moved.server.fallback).toBeUndefined();

    const one = (await get(`/api/projects/${project}/datasources/results?rows=10`)).json() as { data: { rows: unknown[] } };
    expect(one.data.rows).toEqual([{ team: 'Mesa', score: 3 }]);
    expect((await get('/api/server/datasources/results')).statusCode).toBe(200);
  });

  it('picks another id when the server already has one by that name', async () => {
    const project = await newProject('Second desk');
    await put(`/api/projects/${project}/datasources/scores`, feed('scores'));
    const res = await post(`/api/projects/${project}/datasources/scores/move-to-server`);
    expect(res.json()).toMatchObject({ def: { id: 'scores', source: 'scores-2' }, server: { id: 'scores-2' } });
  });

  it('refuses a table typed into the project, and a link', async () => {
    const project = await newProject('Third desk');
    await put(`/api/projects/${project}/datasources/t`, { id: 't', name: 'T', type: 'manual', columns: [], rows: [] });
    const manual = await post(`/api/projects/${project}/datasources/t/move-to-server`);
    expect(manual.statusCode).toBe(409);
    expect(manual.json()).toMatchObject({ error: expect.stringMatching(/only fetched sources/) });

    await put(`/api/projects/${project}/datasources/l`, { id: 'l', name: 'L', type: 'link', source: 'scores' });
    const link = await post(`/api/projects/${project}/datasources/l/move-to-server`);
    expect(link.statusCode).toBe(409);
    expect(link.json()).toMatchObject({ error: expect.stringMatching(/already a link/) });
  });
});

describe('Refresh, within the source\'s limits', () => {
  it('does not fetch again inside the poll floor, and says how long is left', async () => {
    await put('/api/server/datasources/limited', feed('limited'));
    const before = fetchMock.mock.calls.length;

    const res = await post('/api/server/datasources/limited/refresh');

    expect(res.statusCode).toBe(200);
    const body = res.json() as { throttled?: { retryIn: number }; data: { rows: unknown[] } };
    expect(body.throttled?.retryIn).toBeGreaterThan(0);
    expect(body.throttled?.retryIn).toBeLessThanOrEqual(5);
    // The rows it already has still come back: a held refresh is not an empty answer.
    expect(body.data.rows).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBe(before);

    const all = (await get('/api/sources')).json() as { server: Row[] };
    expect(all.server.find((s) => s.def.id === 'limited')!.refreshIn).toBeGreaterThan(0);
  });

  it('fetches once the floor has passed, and a project\'s refresh is held the same way', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 6000);
      feedRows = [{ team: 'Mesa', score: 4 }];
      const before = fetchMock.mock.calls.length;

      const res = await post('/api/server/datasources/limited/refresh');
      const body = res.json() as { throttled?: unknown; data: { rows: unknown[] } };
      expect(body.throttled).toBeUndefined();
      expect(body.data.rows).toEqual([{ team: 'Mesa', score: 4 }]);
      expect(fetchMock.mock.calls.length).toBe(before + 1);

      const project = await newProject('Refresh desk');
      await put(`/api/projects/${project}/datasources/own`, feed('own'));
      const again = (await post(`/api/projects/${project}/datasources/own/refresh`)).json() as { throttled?: { retryIn: number } };
      expect(again.throttled?.retryIn).toBeGreaterThan(0);

      // And a link is held to the floor of what it links to.
      await put(`/api/projects/${project}/datasources/limited`, { id: 'limited', name: 'Limited', type: 'link', source: 'limited' });
      const viaLink = (await post(`/api/projects/${project}/datasources/limited/refresh`)).json() as { throttled?: { retryIn: number } };
      expect(viaLink.throttled?.retryIn).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a project that arrives while the server is running', () => {
  const restore = (body: Buffer, query: string) =>
    app.inject({ method: 'POST', url: `/api/restore?${query}`, payload: body, headers: { 'content-type': 'application/zip' } });

  it('starts fetching its sources on restore, with nobody opening the editor', async () => {
    const project = await newProject('Travelling show');
    await put(`/api/projects/${project}/datasources/own`, feed('own'));
    const bundle = (await get(`/api/backup?projects=${project}`)).rawPayload;

    const before = fetchMock.mock.calls.length;
    const res = await restore(bundle, 'mode=rename');
    expect(res.statusCode, res.body).toBe(201);
    const copy = (res.json() as { restored: Array<{ id: string }> }).restored[0]!.id;
    expect(copy).not.toBe(project);

    // Registered by the restore itself — asked of the registry directly, since
    // the refresh route below would register it on demand and hide the gap.
    // Before 0.80.0 this was undefined until a source was saved in the editor
    // or the server restarted, and with it no timer, so nothing was fetched.
    const registry = (app as unknown as { data: { get(project: string, source: string): unknown } }).data;
    expect(registry.get(copy, 'own')).toBeDefined();
    expect(fetchMock.mock.calls.length).toBe(before);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 6000);
      const refreshed = (await post(`/api/projects/${copy}/datasources/own/refresh`)).json() as Row;
      expect(refreshed.status.rowCount).toBe(1);
      expect(fetchMock.mock.calls.length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries a copy of what the project links to, and creates it where it is missing', async () => {
    await put('/api/server/datasources/touring', feed('touring', { headers: { Authorization: 'Bearer secret' } }));
    const project = await newProject('Touring');
    await put(`/api/projects/${project}/datasources/touring`, { id: 'touring', name: 'Touring', type: 'link', source: 'touring' });
    const bundle = (await get(`/api/backup?projects=${project}`)).rawPayload;

    // "Another machine": the project and the server source are both gone.
    await del(`/api/projects/${project}`);
    expect((await del('/api/server/datasources/touring')).statusCode).toBe(204);

    const res = await restore(bundle, 'mode=overwrite');
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ restored: [{ id: project, serverSources: ['touring'] }] });

    // The server source is back, without the credential a bundle never carries…
    const server = JSON.parse(await fs.readFile(path.join(tmpDir, 'server', 'datasources.json'), 'utf8')) as {
      sources: Array<{ id: string; headers?: unknown }>;
    };
    const touring = server.sources.find((s) => s.id === 'touring')!;
    expect(touring).toBeDefined();
    expect(JSON.stringify(touring)).not.toContain('secret');

    // …the link points at it, and the transport key did not leak into the project's file.
    const one = (await get(`/api/projects/${project}/datasources/touring`)).json() as { linked: Row['linked'] };
    expect(one.linked).toMatchObject({ id: 'touring' });
    const onDisk = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'projects', project, 'datasources.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(onDisk['linked']).toBeUndefined();
    expect(onDisk['sources']).toHaveLength(1);
  });

  it('leaves a server source alone when the bundle\'s copy differs from it', async () => {
    await put('/api/server/datasources/shared', feed('shared', { name: 'As set up here' }));
    const project = await newProject('Visitor');
    await put(`/api/projects/${project}/datasources/shared`, { id: 'shared', name: 'Shared', type: 'link', source: 'shared' });
    const bundle = (await get(`/api/backup?projects=${project}`)).rawPayload;

    await put('/api/server/datasources/shared', feed('shared', { name: 'Edited since the backup' }));
    const res = await restore(bundle, 'mode=overwrite');

    expect((res.json() as { restored: Array<{ serverSources?: string[] }> }).restored[0]!.serverSources).toBeUndefined();
    const now = (await get('/api/server/datasources/shared')).json() as { def: { name: string } };
    expect(now.def.name).toBe('Edited since the backup');
  });
});

describe('the Data sources page', () => {
  it('is linked from the portal, beside Connections', async () => {
    const html = (await get('/')).body;
    expect(html).toContain('href="/sources"');
    expect(html.indexOf('href="/peers"')).toBeLessThan(html.indexOf('href="/sources"'));
  });

  it('redirects /sources to the editor bundle\'s sources view', async () => {
    const res = await get('/sources');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(SOURCES_PAGE_URL);
  });

  it('agrees with the editor about that address', async () => {
    // Two constants in two packages that cannot import each other; this is
    // what stops one being changed without the other.
    const editor = await fs.readFile(
      path.join(import.meta.dirname, '../../../editor/src/state/sources-page.ts'),
      'utf8',
    );
    const view = /const VIEW_PARAM = '([^']+)'/.exec(editor)![1];
    const value = /const SOURCES_VIEW = '([^']+)'/.exec(editor)![1];
    expect(SOURCES_PAGE_URL).toBe(`/editor/?${view}=${value}`);
  });
});
