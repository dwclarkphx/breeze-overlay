// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The activity log.
 *
 * Two things matter beyond "a line got written": that a delete records the
 * *name* — read before the thing is destroyed, since afterwards there is
 * nowhere to look it up — and that the log stays narrow. A page that logs every
 * browser source reconnect is a page nobody reads, and the entries that matter
 * are four a month.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-audit-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../app.js');
const { auditFile, describeAgent, flush, recent } = await import('../audit.js');

let app: FastifyInstance;

const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36';

async function entries() {
  await flush();
  return recent(500);
}

beforeAll(async () => {
  app = await buildApp({ seed: false });
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('describeAgent', () => {
  it('squints a User-Agent into something scannable', () => {
    expect(describeAgent(AGENT)).toBe('Chrome on Windows');
    expect(describeAgent('Mozilla/5.0 (Macintosh) Gecko Firefox/130.0')).toBe('Firefox on macOS');
    // Edge, Opera and OBS all claim to be Chrome; whichever is more specific wins.
    expect(describeAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/140 Edg/140')).toBe('Edge on Windows');
    expect(describeAgent('Mozilla/5.0 (Windows) Chrome/120 OBS/30.1')).toBe('OBS on Windows');
    expect(describeAgent('unknown')).toBe('unknown');
  });

  it('keeps something short rather than truncating to nothing', () => {
    expect(describeAgent('curl/8.4.0')).toBe('curl');
  });
});

describe('project and scene changes', () => {
  it('records a project create with its name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Audit Demo', key: 'audit' },
      headers: { 'user-agent': AGENT },
    });
    const id = res.json().id as string;

    const log = await entries();
    const entry = log.find((e) => e.action === 'project.create' && e.project === id);
    expect(entry).toBeDefined();
    expect(entry!.name).toBe('Audit Demo');
    expect(entry!.actor.agent).toBe(AGENT);
    expect(entry!.actor.ip).toBeTruthy();
  });

  it('records a scene create and delete, keeping the name through the delete', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Scene Log', key: 'scenelog' },
    });
    const projectId = created.json().id as string;

    const scene = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/compositions`,
      payload: { name: 'Half Time', key: 'ht' },
    });
    const sceneId = scene.json().id as string;

    await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/compositions/${sceneId}`,
    });

    const log = await entries();
    const made = log.find((e) => e.action === 'scene.create' && e.scene === sceneId);
    const gone = log.find((e) => e.action === 'scene.delete' && e.scene === sceneId);

    expect(made?.name).toBe('Half Time');
    // The point of the whole exercise: after the delete the name exists nowhere
    // else, so if it were read afterwards this would be undefined.
    expect(gone?.name).toBe('Half Time');
  });

  it('records a project delete with the name it had', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Doomed Project', key: 'doomed' },
    });
    const id = created.json().id as string;

    await app.inject({ method: 'DELETE', url: `/api/projects/${id}` });

    const log = await entries();
    const entry = log.find((e) => e.action === 'project.delete' && e.project === id);
    expect(entry?.name).toBe('Doomed Project');
  });

  it('does not record a refused scene delete', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Referred', key: 'referred' },
    });
    const projectId = created.json().id as string;

    const target = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/compositions`,
      payload: { name: 'Mounted', key: 'mounted' },
    });
    const targetId = target.json().id as string;

    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/compositions/host`,
      payload: {
        formatVersion: 1,
        id: 'host',
        name: 'Host',
        stage: { width: 1920, height: 1080, fps: 60, background: 'transparent' },
        markers: [],
        layers: [{ id: 'l1', name: 'Mount', type: 'composition', ref: targetId }],
      },
    });

    const refused = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/compositions/${targetId}`,
    });
    expect(refused.statusCode).toBe(409);

    const log = await entries();
    // Nothing changed, so nothing is recorded. A log of attempted deletes would
    // be a different feature, and a noisier one.
    expect(log.some((e) => e.action === 'scene.delete' && e.scene === targetId)).toBe(false);
  });
});

describe('the log file itself', () => {
  it('is JSON Lines, one object per line, in the data dir', async () => {
    await flush();
    const raw = await fs.readFile(auditFile(), 'utf8');

    expect(auditFile().startsWith(tmpDir)).toBe(true);
    expect(raw.endsWith('\n')).toBe(true);
    for (const line of raw.split('\n').filter((l) => l.trim() !== '')) {
      const parsed = JSON.parse(line);
      expect(typeof parsed.at).toBe('string');
      expect(typeof parsed.action).toBe('string');
      expect(typeof parsed.actor.ip).toBe('string');
    }
  });

  it('survives a torn line rather than losing the file', async () => {
    await flush();
    await fs.appendFile(auditFile(), '{"at":"2026-08-08T00:00:00.000Z","action":"scene.cr\n', 'utf8');

    // A process killed mid-append leaves half a line. The reader must skip it.
    const log = await recent(500);
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((e) => typeof e.action === 'string')).toBe(true);
  });

  it('returns newest first', async () => {
    const log = await entries();
    const times = log.map((e) => e.at);
    expect([...times].sort().reverse()).toEqual(times);
  });
});

describe('GET /activity', () => {
  it('renders the entries, and filters by category', async () => {
    const all = await app.inject({ method: 'GET', url: '/activity' });
    expect(all.statusCode).toBe(200);
    expect(all.body).toContain('Doomed Project');
    expect(all.body).toContain('project.delete');

    const scenes = await app.inject({ method: 'GET', url: '/activity?filter=scene' });
    expect(scenes.body).toContain('scene.create');
    // A project entry must not survive the scene filter.
    expect(scenes.body).not.toContain('project.delete');
  });

  it('serves the same data as JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/activity?limit=5' });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries.length).toBeLessThanOrEqual(5);
  });

  it('shows the squinted agent, keeping the full string for the tooltip', async () => {
    const res = await app.inject({ method: 'GET', url: '/activity' });
    expect(res.body).toContain('Chrome on Windows');
    expect(res.body).toContain('AppleWebKit/537.36');
  });
});
