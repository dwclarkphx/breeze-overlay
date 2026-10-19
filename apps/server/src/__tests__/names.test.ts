// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Project and composition names — the routes' side of `@breeze/schema` names.ts.
 *
 * Two halves. The create/save routes refuse a bad name with a coded 400, but a
 * name already on disk is left alone until someone changes it. And a restore
 * refuses a backup carrying a bad name until a replacement is supplied —
 * checked across the whole bundle before anything is written.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import type { FastifyInstance } from 'fastify';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-names-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../app.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const ZWSP = String.fromCodePoint(0x200b);
const ACUTE = String.fromCodePoint(0x0301);

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });

async function createProject(name: string): Promise<{ id: string; name: string; compositions: Array<{ id: string; name: string }> }> {
  const res = await post('/api/projects', { name });
  expect(res.statusCode).toBe(201);
  return res.json();
}

/** Write a name straight to disk — how a project from before the rules looks. */
async function forceNames(id: string, edit: (doc: { name: string; compositions: Array<{ id: string; name: string }> }) => void): Promise<void> {
  const file = path.join(tmpDir, 'projects', id, 'project.json');
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  edit(doc);
  await fs.writeFile(file, JSON.stringify(doc));
}

const projectIds = async (): Promise<string[]> =>
  ((await app.inject({ method: 'GET', url: '/api/projects' })).json().projects as Array<{ id: string }>).map((p) => p.id);

/* ------------------------------------------------------------- create */

describe('creating a project', () => {
  it('refuses an empty name with a coded 400 on the name field', async () => {
    const res = await post('/api/projects', { name: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'error.nameEmpty', field: 'name' });
  });

  it('refuses a name that is only invisible characters', async () => {
    const res = await post('/api/projects', { name: ` ${ZWSP} ` });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('error.nameEmpty');
  });

  it('refuses a line break inside the name', async () => {
    const res = await post('/api/projects', { name: 'Game\nnight' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('error.nameControl');
  });

  it('refuses a name past the cap and says what the cap is', async () => {
    const res = await post('/api/projects', { name: 'a'.repeat(65) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'error.nameTooLong', params: { max: 64 } });
  });

  it('still defaults a name that was not sent at all', async () => {
    const res = await post('/api/projects', {});
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Untitled project');
  });

  it('accepts any script, and stores the name trimmed and NFC', async () => {
    expect((await createProject('  ニュース速報  ')).name).toBe('ニュース速報');
    expect((await createProject(`Cafe${ACUTE}`)).name).toBe('Café'.normalize('NFC'));
  });
});

describe('creating a composition', () => {
  it('refuses an empty name instead of quietly calling it Untitled', async () => {
    const project = await createProject('Comp host');
    const res = await post(`/api/projects/${project.id}/compositions`, { name: '   ' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'error.nameEmpty', field: 'name' });
  });

  it('still defaults when no name is sent', async () => {
    const project = await createProject('Comp host 2');
    const res = await post(`/api/projects/${project.id}/compositions`, {});
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Untitled scene');
  });
});

/* --------------------------------------------------------------- save */

describe('saving a project', () => {
  it('refuses renaming a composition to nothing, and names which one', async () => {
    const project = await createProject('Save host');
    const doc = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json();
    const compId = doc.compositions[0].id;
    doc.compositions[0].name = '';
    const res = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}`, payload: doc });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'error.nameEmpty', field: 'name', composition: compId });
  });

  it('lets a legacy blank name through unchanged, so the project stays saveable', async () => {
    const project = await createProject('Legacy');
    await forceNames(project.id, (doc) => {
      doc.name = '';
      doc.compositions[0]!.name = '';
    });
    const doc = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json();
    expect(doc.name).toBe('');
    const res = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}`, payload: doc });
    expect(res.statusCode).toBe(200);
  });

  it('normalises a renamed project on save', async () => {
    const project = await createProject('Rename me');
    const doc = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json();
    doc.name = '  New name  ';
    const res = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}`, payload: doc });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('New name');
  });

  it('refuses the same through the composition route', async () => {
    const project = await createProject('Comp route');
    const comp = project.compositions[0]!;
    const full = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/compositions/${comp.id}` })).json();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}/compositions/${comp.id}`,
      payload: { ...full, name: 'two\nlines' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'error.nameControl', composition: comp.id });
  });
});

describe('control surfaces', () => {
  it('get the id in place of a legacy blank name, never an empty label', async () => {
    const project = await createProject('Blank buttons');
    await forceNames(project.id, (doc) => {
      doc.compositions[0]!.name = '';
    });
    const res = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/channels` });
    const channel = res.json().channels.find((c: { channel: string }) => c.channel === project.compositions[0]!.id);
    expect(channel.name).toBe(project.compositions[0]!.id);
  });
});

/* ------------------------------------------------------------ restore */

/** A real bundle of one project, with its names rewritten inside the zip. */
async function bundleWithNames(
  id: string,
  edit: (doc: { name: string; compositions: Array<{ id: string; name: string }> }) => void,
): Promise<{ body: Buffer; compIds: string[] }> {
  const res = await app.inject({ method: 'GET', url: `/api/backup?projects=${id}` });
  expect(res.statusCode).toBe(200);
  const files = unzipSync(new Uint8Array(res.rawPayload));
  const key = `projects/${id}/project.json`;
  const doc = JSON.parse(strFromU8(files[key]!));
  edit(doc);
  files[key] = strToU8(JSON.stringify(doc));
  return { body: Buffer.from(zipSync(files)), compIds: doc.compositions.map((c: { id: string }) => c.id) };
}

const encode = (names: unknown): string => Buffer.from(JSON.stringify(names), 'utf8').toString('base64');

const restoreWith = (body: Buffer, names?: unknown, query = 'mode=rename') =>
  app.inject({
    method: 'POST',
    url: `/api/restore?${query}`,
    payload: body,
    headers: {
      'content-type': 'application/zip',
      ...(names === undefined ? {} : { 'x-breeze-names': encode(names) }),
    },
  });

describe('restoring a backup with unusable names', () => {
  let source: { id: string; compositions: Array<{ id: string; name: string }> };
  let bundle: { body: Buffer; compIds: string[] };

  beforeAll(async () => {
    source = await createProject('Restore source');
    await post(`/api/projects/${source.id}/compositions`, { name: 'Second' });
    bundle = await bundleWithNames(source.id, (doc) => {
      doc.name = '';
      doc.compositions[0]!.name = 'Lower\nthird';
    });
  });

  it('inspect lists every one, with the problem, and writes nothing', async () => {
    const before = await projectIds();
    const res = await app.inject({
      method: 'POST',
      url: '/api/restore/inspect',
      payload: bundle.body,
      headers: { 'content-type': 'application/zip' },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.nameIssues).toEqual([
      { project: source.id, name: '', problem: 'empty' },
      { project: source.id, composition: bundle.compIds[0], name: 'Lower\nthird', problem: 'control' },
    ]);
    expect(out.projects[0].name).toBe('');
    expect(await projectIds()).toEqual(before);
  });

  it('refuses the restore without replacements, with the full list, and writes nothing', async () => {
    const before = await projectIds();
    const res = await restoreWith(bundle.body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'error.restoreNamesNeeded', params: { count: 2 } });
    expect(res.json().nameIssues).toHaveLength(2);
    expect(await projectIds()).toEqual(before);
  });

  it('still refuses when only some are replaced', async () => {
    const res = await restoreWith(bundle.body, { [source.id]: { name: 'Fixed' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().nameIssues).toEqual([
      { project: source.id, composition: bundle.compIds[0], name: 'Lower\nthird', problem: 'control' },
    ]);
  });

  it('holds a replacement to the same rules', async () => {
    const res = await restoreWith(bundle.body, {
      [source.id]: { name: 'x'.repeat(65), compositions: { [bundle.compIds[0]!]: 'Lower third' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().nameIssues).toEqual([{ project: source.id, name: 'x'.repeat(65), problem: 'tooLong' }]);
  });

  it('restores once every name is replaced — in any script', async () => {
    const res = await restoreWith(bundle.body, {
      [source.id]: { name: '  الأخبار  ', compositions: { [bundle.compIds[0]!]: 'ニュース' } },
    });
    expect(res.statusCode).toBe(201);
    const restored = res.json().restored[0];
    expect(restored.name).toBe('الأخبار');

    const doc = (await app.inject({ method: 'GET', url: `/api/projects/${restored.id}` })).json();
    expect(doc.name).toBe('الأخبار');
    expect(doc.compositions[0].name).toBe('ニュース');
    // Untouched names come through as they were.
    expect(doc.compositions[1].name).toBe('Second');
  });

  it('refuses a header that is not base64 JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/restore?mode=rename',
      payload: bundle.body,
      headers: { 'content-type': 'application/zip', 'x-breeze-names': 'not json at all' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('only holds the projects ?only= restores to the rules', async () => {
    const good = await createProject('Fine already');
    const res = await app.inject({ method: 'GET', url: `/api/backup?projects=${source.id},${good.id}` });
    const files = unzipSync(new Uint8Array(res.rawPayload));
    const key = `projects/${source.id}/project.json`;
    const doc = JSON.parse(strFromU8(files[key]!));
    doc.name = '';
    files[key] = strToU8(JSON.stringify(doc));
    const body = Buffer.from(zipSync(files));

    expect((await restoreWith(body)).statusCode).toBe(400);
    const only = await restoreWith(body, undefined, `mode=rename&only=${good.id}`);
    expect(only.statusCode).toBe(201);
  });

  it('normalises names that pass, so a backup cannot carry in a decomposed accent', async () => {
    const accented = await bundleWithNames(source.id, (doc) => {
      doc.name = `Cafe${ACUTE}`;
      for (const c of doc.compositions) c.name = 'Fine';
    });
    const res = await restoreWith(accented.body);
    expect(res.statusCode).toBe(201);
    expect(res.json().restored[0].name).toBe(`Cafe${ACUTE}`.normalize('NFC'));
  });
});

describe('merging a backup into a project', () => {
  it('ignores the bundled project name — it is discarded — but not composition names', async () => {
    const host = await createProject('Merge host');
    const source = await createProject('Merge source');
    const bundle = await bundleWithNames(source.id, (doc) => {
      doc.name = '';
      doc.compositions[0]!.name = '';
    });

    const refused = await restoreWith(bundle.body, undefined, `mode=merge&into=${host.id}`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().nameIssues).toEqual([
      { project: source.id, composition: bundle.compIds[0], name: '', problem: 'empty' },
    ]);

    const merged = await restoreWith(
      bundle.body,
      { [source.id]: { compositions: { [bundle.compIds[0]!]: 'Handed over' } } },
      `mode=merge&into=${host.id}`,
    );
    expect(merged.statusCode).toBe(201);
    const doc = (await app.inject({ method: 'GET', url: `/api/projects/${host.id}` })).json();
    expect(doc.name).toBe('Merge host');
    expect(doc.compositions.map((c: { name: string }) => c.name)).toContain('Handed over');
  });
});
