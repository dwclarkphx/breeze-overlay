// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * API key behavior. Kept in its own file because `config.ts` reads the
 * environment once at import time, so a suite that needs a key set cannot share
 * a module graph with one that needs it unset.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-auth-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';
process.env['BREEZE_API_KEY'] = 's3cret';

const { buildApp } = await import('../app.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const PLAY = '/api/control/demo/l3rd-name/play';

describe('control actions require the key', () => {
  it('answers 401, not 500, when the key is missing', async () => {
    /*
     * Regression: the hook threw a plain Error, and the error handler derives
     * its status from `err.statusCode` — which a plain Error does not carry —
     * so every auth failure surfaced as a 500. Misleading for anyone wiring up
     * a control surface, and it hid the real cause.
     */
    const res = await app.inject({ method: 'POST', url: PLAY });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('API key') });
  });

  it('accepts the key as a header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: PLAY,
      headers: { 'x-breeze-key': 's3cret' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts the key as a query parameter', async () => {
    // Stream Deck and Companion presets often cannot set headers.
    const res = await app.inject({ method: 'GET', url: `${PLAY}?key=s3cret` });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a wrong key', async () => {
    expect((await app.inject({ method: 'GET', url: `${PLAY}?key=nope` })).statusCode).toBe(401);
  });

  it('gates GET triggers, not just POST', async () => {
    // A GET that fires a graphic to air is a write in every sense that matters.
    expect((await app.inject({ method: 'GET', url: PLAY })).statusCode).toBe(401);
  });

  it('gates update the same way', async () => {
    const url = '/api/control/demo/l3rd-name/update?name=Nope';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it('does not treat the key as a dynamic field', async () => {
    await app.inject({
      method: 'GET',
      url: '/api/control/demo/l3rd-name/update?key=s3cret&name=Dave',
    });
    const state = await app.inject({ method: 'GET', url: '/api/control/demo/l3rd-name/state' });
    expect((state.json() as { state: { data: Record<string, unknown> } }).state.data).toEqual({
      name: 'Dave',
    });
  });
});

describe('reads stay open', () => {
  it('lets an output page fetch its composition without a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/demo/compositions/l3rd-name' });
    expect(res.statusCode).toBe(200);
  });

  it('lets a panel poll channel state without a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/control/demo/l3rd-name/state' });
    expect(res.statusCode).toBe(200);
  });

  it('serves the output page without a key', async () => {
    expect((await app.inject({ method: 'GET', url: '/play/demo/l3rd-name' })).statusCode).toBe(200);
  });

  it('serves the operator panel without a key', async () => {
    expect((await app.inject({ method: 'GET', url: '/control/demo/l3rd-name' })).statusCode).toBe(200);
  });
});

describe('project mutations require the key', () => {
  it('rejects an unauthenticated save with 401', async () => {
    const project = (await app.inject({ method: 'GET', url: '/api/projects/demo' })).json();
    const res = await app.inject({ method: 'PUT', url: '/api/projects/demo', payload: project });
    expect(res.statusCode).toBe(401);
  });

  it('accepts it with the key', async () => {
    const project = (await app.inject({ method: 'GET', url: '/api/projects/demo' })).json();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/demo',
      headers: { 'x-breeze-key': 's3cret' },
      payload: project,
    });
    expect(res.statusCode).toBe(200);
  });
});
