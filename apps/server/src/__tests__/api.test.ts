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

// config.ts reads the environment at import time, so the temp data dir has to
// be set before anything imports it.
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-test-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../app.js');
const { APP_VERSION } = await import('../version.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('health and shell', () => {
  it('reports healthy, and says which build is answering', async () => {
    /*
     * `version` used to be the composition format version — a hardcoded 1 — so
     * a health check asked "what is running?" answered the same thing for every
     * build ever shipped. The two are separate fields now because they are
     * separate facts on separate clocks.
     */
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: APP_VERSION, formatVersion: 1 });
    expect(APP_VERSION).toMatch(/^\d+\.\d+/);
  });

  it('serves the portal, with the version on it', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain(APP_VERSION);
  });

  it('links every composition to its control panel, output and preview', async () => {
    // Assembling these URLs by hand is how a graphic gets misconfigured
    // minutes before air.
    const res = await app.inject({ method: 'GET', url: '/' });

    for (const comp of ['l3rd-name', 'badge', 'ticker']) {
      expect(res.body).toContain(`/control/demo/${comp}`);
      expect(res.body).toContain(`/play/demo/${comp}`);
    }
    expect(res.body).toContain('scale=contain');
  });

  it('links to the editor', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).toContain('/editor/');
  });
});

describe('seeding', () => {
  it('installs the demo project on first run', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    const body = res.json() as { projects: Array<{ id: string }> };
    expect(body.projects.map((p) => p.id)).toContain('demo');
  });
});

describe('project CRUD', () => {
  it('creates, reads and deletes a project', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Test Project', id: 'test-project' },
    });
    expect(created.statusCode).toBe(201);

    const read = await app.inject({ method: 'GET', url: '/api/projects/test-project' });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ id: 'test-project', name: 'Test Project' });

    const removed = await app.inject({ method: 'DELETE', url: '/api/projects/test-project' });
    expect(removed.statusCode).toBe(204);

    const gone = await app.inject({ method: 'GET', url: '/api/projects/test-project' });
    expect(gone.statusCode).toBe(404);
  });

  it('round-trips the demo project unchanged apart from updatedAt', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/projects/demo' })).json() as Record<string, unknown>;
    const put = await app.inject({ method: 'PUT', url: '/api/projects/demo', payload: before });
    expect(put.statusCode).toBe(200);

    const after = put.json() as Record<string, unknown>;
    expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null });
  });

  it('rejects a project that fails schema validation', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/demo',
      payload: { formatVersion: 1, id: 'demo', name: 'x', compositions: [{ nope: true }] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('refuses ids that would escape the data directory', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/..%2F..%2Fetc' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('compositions', () => {
  it('returns a single composition', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/demo/compositions/l3rd-name' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'l3rd-name', name: 'Lower Third — Name' });
  });

  it('exposes the dynamic-field schema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/demo/compositions/l3rd-name/bindings',
    });
    const body = res.json() as {
      bindings: Array<{ name: string }>;
      stepCount: number;
      schema: { properties: Record<string, unknown> };
    };
    expect(body.bindings.map((b) => b.name).sort()).toEqual(['name', 'title']);
    // One STOP marker → one step. An inflated count would tell the control
    // panel the graphic has a hold it does not have.
    expect(body.stepCount).toBe(1);
    expect(Object.keys(body.schema.properties).sort()).toEqual(['name', 'title']);
  });

  it('validates without saving', async () => {
    const good = await app.inject({
      method: 'POST',
      url: '/api/validate/composition',
      payload: {
        formatVersion: 1,
        id: 'x',
        name: 'x',
        stage: { width: 1920, height: 1080, fps: 60, background: 'transparent' },
        layers: [],
      },
    });
    expect(good.json()).toEqual({ valid: true, errors: [] });

    const bad = await app.inject({
      method: 'POST',
      url: '/api/validate/composition',
      payload: { formatVersion: 1, id: 'x' },
    });
    expect((bad.json() as { valid: boolean }).valid).toBe(false);
  });
});

describe('control API', () => {
  const base = '/api/control/demo/l3rd-name';

  it('accepts every verb over POST', async () => {
    for (const verb of ['play', 'next', 'stop', 'clear']) {
      const res = await app.inject({ method: 'POST', url: `${base}/${verb}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, verb });
    }
  });

  it('accepts verbs over GET too', async () => {
    // Side-effecting GET is deliberate: Stream Deck and Companion presets
    // often can only open a URL.
    const res = await app.inject({ method: 'GET', url: `${base}/play` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, verb: 'play' });
  });

  it('reports zero delivered when nothing is on air', async () => {
    // Tells an operator their button did nothing because no output is open,
    // rather than silently succeeding.
    const res = await app.inject({ method: 'POST', url: `${base}/play` });
    expect(res.json()).toMatchObject({ delivered: 0 });
  });

  it('404s for a composition that does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/control/demo/nope/play' });
    expect(res.statusCode).toBe(404);
  });

  it('takes update fields from a POST body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base}/update`,
      payload: { name: 'Alex Rivera', title: 'Field Producer' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: { name: 'Alex Rivera' } });
  });

  it('takes update fields from a GET query string', async () => {
    const res = await app.inject({ method: 'GET', url: `${base}/update?name=From%20URL` });
    expect(res.json()).toMatchObject({ data: { name: 'From URL' } });
  });

  it('rejects an update with no fields', async () => {
    const res = await app.inject({ method: 'POST', url: `${base}/update`, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('retains pushed values so a reconnecting output can resync', async () => {
    await app.inject({ method: 'POST', url: `${base}/update`, payload: { name: 'Retained' } });

    const res = await app.inject({ method: 'GET', url: `${base}/state` });
    expect(res.json()).toMatchObject({ state: { data: { name: 'Retained' } } });
  });

  it('keeps channels separate', async () => {
    await app.inject({ method: 'POST', url: `${base}/update`, payload: { name: 'Lower third' } });
    const other = await app.inject({ method: 'GET', url: '/api/control/demo/ticker/state' });
    expect((other.json() as { state: { data: Record<string, unknown> } }).state.data).toEqual({});
  });
});

describe('operator control page', () => {
  it('renders a field per binding', async () => {
    const res = await app.inject({ method: 'GET', url: '/control/demo/l3rd-name' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('"name"');
    expect(res.body).toContain('"title"');
  });

  it('inlines the field list so it paints without a round trip', async () => {
    // Used minutes before air, sometimes over poor wifi on a tablet.
    const res = await app.inject({ method: 'GET', url: '/control/demo/l3rd-name' });
    expect(res.body).toContain('__BREEZE_CONTROL__');
    expect(res.body).toContain('/public/control.js');
  });

  it('offers the verbs an operator needs', async () => {
    const res = await app.inject({ method: 'GET', url: '/control/demo/l3rd-name' });
    for (const verb of ['play', 'stop', 'next', 'clear']) {
      expect(res.body).toContain(`data-verb="${verb}"`);
    }
  });

  it('hides NEXT on a single-step graphic', async () => {
    // The demo lower third has one hold, so NEXT would do nothing.
    const res = await app.inject({ method: 'GET', url: '/control/demo/l3rd-name' });
    expect(res.body).toMatch(/data-verb="next" hidden/);
  });

  it('is never cached', async () => {
    const res = await app.inject({ method: 'GET', url: '/control/demo/l3rd-name' });
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('404s for an unknown composition', async () => {
    const res = await app.inject({ method: 'GET', url: '/control/demo/nope' });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * Fed fields.
 *
 * The bug these cover: the screen bug's temperature comes from a weather feed,
 * but the panel offered it as an editable grid seeded from the authored
 * snapshot — so pressing PLAY pushed `96°` over whatever the feed had last
 * said, and the graphic showed the placeholder until the next poll. The fix has
 * two halves and both are asserted here, because either alone leaves the bug:
 * the field must be marked read-only, *and* it must reach the page at all.
 */
describe('control page — source-fed fields', () => {
  const bindingsOf = (body: string): Array<Record<string, unknown>> => {
    const match = /bindings: (\[.*?\]),\n/s.exec(body);
    return match ? (JSON.parse(match[1]!) as Array<Record<string, unknown>>) : [];
  };

  it('marks a field fed by a fetched source read-only', async () => {
    const res = await app.inject({ method: 'GET', url: '/control/demo/screen-bug' });
    expect(res.statusCode).toBe(200);

    const fed = bindingsOf(res.body).find((b) => b['source'] === 'wx-current');
    expect(fed).toBeDefined();
    expect(fed).toMatchObject({ readOnly: true, sourceType: 'weather', kind: 'dataset' });
  });

  it('surfaces a fed source even when no layer carries a binding', async () => {
    /*
     * The screen bug's table has `source` and deliberately no `binding` — that
     * is what stops anything pushing over the feed. Built from bindings alone
     * the panel for it was empty, which reads as a broken page rather than as
     * a graphic with nothing to type into.
     */
    const res = await app.inject({ method: 'GET', url: '/control/demo/screen-bug' });
    expect(bindingsOf(res.body)).toHaveLength(1);
    expect(res.body).toContain('Every field here is fed by a data source');
    expect(res.body).not.toContain('UPDATE ON AIR');
  });

  it('leaves a manual source fully editable', async () => {
    // The standings demo is a manual table. Editing it in the panel is the
    // entire point of a manual source and must not be caught by this change.
    const res = await app.inject({ method: 'GET', url: '/control/demo/standings' });
    const standings = bindingsOf(res.body).find((b) => b['name'] === 'standings');

    expect(standings).toMatchObject({ kind: 'dataset', sourceType: 'manual' });
    expect(standings?.['readOnly']).toBeUndefined();
    expect(res.body).toContain('UPDATE ON AIR');
  });

  it('inlines the current DataSets so a fed field paints before the first push', async () => {
    const res = await app.inject({ method: 'GET', url: '/control/demo/screen-bug' });
    expect(res.body).toContain('datasets:');
    expect(res.body).toContain('dataKey:');
  });
});

describe('editor hosting', () => {
  // The editor may or may not be built when this suite runs, and failing the
  // API tests because of that would be noise. Both outcomes are valid; what
  // matters is that the route answers and says which case it is.
  it('serves the editor or explains how to build it', async () => {
    const res = await app.inject({ method: 'GET', url: '/editor/' });
    expect([200, 503]).toContain(res.statusCode);
    expect(res.headers['content-type']).toContain('text/html');
    if (res.statusCode === 503) {
      expect(res.body).toContain('pnpm --filter @breeze/editor build');
    }
  });

  it('never caches the editor shell', async () => {
    // A cached index.html would leave a browser running the previous bundle
    // against a newer API after every rebuild.
    const res = await app.inject({ method: 'GET', url: '/editor/' });
    if (res.statusCode === 200) {
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('falls back to the shell for deep links', async () => {
    const res = await app.inject({ method: 'GET', url: '/editor/deep/route' });
    expect([200, 503]).toContain(res.statusCode);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('blocks path traversal out of the editor directory', async () => {
    const res = await app.inject({ method: 'GET', url: '/editor/..%2F..%2F..%2Fetc%2Fpasswd' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('links to the editor from the landing page', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).toContain('/editor/');
  });
});

describe('output page', () => {
  it('serves a transparent play page with the composition inlined', async () => {
    const res = await app.inject({ method: 'GET', url: '/play/demo/l3rd-name' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body).toContain('background:transparent');
    expect(res.body).toContain('compositionId: "l3rd-name"');
    expect(res.body).toContain('/public/player.js');
    // The composition is inlined, so a browser source paints without a second
    // round trip and survives a server blip after load.
    expect(res.body).toContain('"formatVersion":1');
  });

  it('does not arm autoplay', async () => {
    // A browser source must not put a graphic to air just by existing.
    const res = await app.inject({ method: 'GET', url: '/play/demo/l3rd-name' });
    expect(res.body).toContain('autoPlay: false');
  });

  it('redirects a bare project URL to its first composition', async () => {
    const res = await app.inject({ method: 'GET', url: '/play/demo' });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('/play/demo/l3rd-name');
  });

  it('inlines nested compositions so a composition layer can resolve', async () => {
    const res = await app.inject({ method: 'GET', url: '/play/demo/l3rd-name' });
    // The lower third nests the badge composition; without it inlined the
    // browser source would render the graphic with a hole in it.
    expect(res.body).toContain('dependencies:');
    expect(res.body).toContain('"id":"badge"');
  });

  it('does not inline compositions the graphic never references', async () => {
    const res = await app.inject({ method: 'GET', url: '/play/demo/l3rd-name' });
    const deps = /dependencies: (\[.*?\]),\n/s.exec(res.body)?.[1] ?? '[]';
    const ids = (JSON.parse(deps) as Array<{ id: string }>).map((c) => c.id);

    expect(ids).toEqual(['badge']);
    expect(ids).not.toContain('ticker');
  });

  it('blocks path traversal in asset URLs', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/demo/../../../etc/passwd' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
