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
const { flush } = await import('../audit.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  // Sign-ins and switches are audited; let those writes land before the
  // directory they land in is removed.
  await flush();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const PLAY = '/api/control/demo-1iixd/l3rd-name-2a94g/play';

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
    const url = '/api/control/demo-1iixd/l3rd-name-2a94g/update?name=Nope';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it('gates every verb added since — prev, page, cycle and clear-all', async () => {
    // The gate once listed its verbs by name, and each new one was open to a
    // plain GET until somebody remembered to add it. It now gates everything
    // under a channel except `state`.
    for (const verb of ['prev', 'page?n=2', 'cycle?state=hold', 'clear-all', 'next?table=standings']) {
      const url = `/api/control/demo-1iixd/l3rd-name-2a94g/${verb}`;
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
  });

  it('lets a gated table verb through with the key, and does not read the key as a page name', async () => {
    const url = '/api/control/demo-1iixd/l3rd-name-2a94g/page?n=2&key=s3cret';
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ verb: 'page', n: 2 });
  });

  it('does not treat the key as a dynamic field', async () => {
    await app.inject({
      method: 'GET',
      url: '/api/control/demo-1iixd/l3rd-name-2a94g/update?key=s3cret&name=Dave',
    });
    const state = await app.inject({ method: 'GET', url: '/api/control/demo-1iixd/l3rd-name-2a94g/state' });
    expect((state.json() as { state: { data: Record<string, unknown> } }).state.data).toEqual({
      name: 'Dave',
    });
  });
});

describe('reads stay open', () => {
  it('lets an output page fetch its composition without a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/demo-1iixd/compositions/l3rd-name-2a94g' });
    expect(res.statusCode).toBe(200);
  });

  it('lets a panel poll channel state without a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/control/demo-1iixd/l3rd-name-2a94g/state' });
    expect(res.statusCode).toBe(200);
  });

  it('keeps state open with a query string too', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/control/demo-1iixd/l3rd-name-2a94g/state?data=0' });
    expect(res.statusCode).toBe(200);
  });

  it('serves the output page without a key', async () => {
    expect((await app.inject({ method: 'GET', url: '/play/demo-1iixd/l3rd-name-2a94g' })).statusCode).toBe(200);
  });

  it('serves the operator panel without a key', async () => {
    expect((await app.inject({ method: 'GET', url: '/control/demo-1iixd/l3rd-name-2a94g' })).statusCode).toBe(200);
  });
});

describe('project mutations require the key', () => {
  it('rejects an unauthenticated save with 401', async () => {
    const project = (await app.inject({ method: 'GET', url: '/api/projects/demo-1iixd' })).json();
    const res = await app.inject({ method: 'PUT', url: '/api/projects/demo-1iixd', payload: project });
    expect(res.statusCode).toBe(401);
  });

  it('accepts it with the key', async () => {
    const project = (await app.inject({ method: 'GET', url: '/api/projects/demo-1iixd' })).json();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/demo-1iixd',
      headers: { 'x-breeze-key': 's3cret' },
      payload: project,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('choosing a data source’s backup requires the key (Wave 5)', () => {
  const KEY = { 'x-breeze-key': 's3cret' };
  const BASE = '/api/projects/demo-1iixd/datasources';

  beforeAll(async () => {
    const backup = await app.inject({
      method: 'PUT', url: `${BASE}/wx-backup`, headers: KEY,
      payload: {
        id: 'wx-backup', name: 'Unavailable', type: 'manual',
        columns: [{ key: 'place', type: 'string' }], rows: [{ place: 'Temporarily unavailable' }],
      },
    });
    expect(backup.statusCode).toBe(200);
    // A private address: the SSRF guard refuses it without touching the network.
    const main = await app.inject({
      method: 'PUT', url: `${BASE}/wx-main`, headers: KEY,
      payload: { id: 'wx-main', name: 'Main', type: 'http-json', url: 'http://127.0.0.1:1/x.json', fallback: 'wx-backup' },
    });
    expect(main.statusCode).toBe(200);
  });

  it('refuses a GET without the key — it changes what is on air', async () => {
    expect((await app.inject({ method: 'GET', url: `${BASE}/wx-main/use?mode=backup` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `${BASE}/wx-main/use`, payload: { mode: 'backup' } })).statusCode).toBe(401);
  });

  it('is not reachable round the gate by encoding the verb', async () => {
    const res = await app.inject({ method: 'GET', url: `${BASE}/wx-main/%75se?mode=backup` });
    expect(res.statusCode).not.toBe(200);
  });

  it('keeps the source list itself open to read', async () => {
    expect((await app.inject({ method: 'GET', url: BASE })).statusCode).toBe(200);
  });

  it('switches with the key, and reports the new status', async () => {
    const res = await app.inject({ method: 'POST', url: `${BASE}/wx-main/use`, headers: KEY, payload: { mode: 'backup' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toMatchObject({ use: 'backup', serving: 'wx-backup' });

    const back = await app.inject({ method: 'GET', url: `${BASE}/wx-main/use?mode=auto`, headers: KEY });
    expect(back.statusCode).toBe(200);
    expect(back.json().status.use).toBeUndefined();
  });

  it('says what is wrong with a bad request', async () => {
    expect((await app.inject({ method: 'POST', url: `${BASE}/wx-main/use`, headers: KEY, payload: { mode: 'spare' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${BASE}/wx-backup/use`, headers: KEY, payload: { mode: 'backup' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `${BASE}/nope/use`, headers: KEY, payload: { mode: 'auto' } })).statusCode).toBe(404);
  });
});

describe('browser sessions', () => {
  const HOST = 'breeze.test:7331';
  const ORIGIN = `http://${HOST}`;
  const PROJECT = '/api/projects/demo-1iixd';

  const signIn = async (key: string) =>
    app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: HOST, origin: ORIGIN }, payload: { key } });
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers['set-cookie'] ?? '').split(';')[0]!;
  const save = async (headers: Record<string, string>) => {
    const project = (await app.inject({ method: 'GET', url: PROJECT })).json();
    return app.inject({ method: 'PUT', url: PROJECT, headers: { host: HOST, ...headers }, payload: project });
  };

  it('says a key is set and this browser is not signed in', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth' })).json()).toEqual({ keyRequired: true, signedIn: false });
    const portal = await app.inject({ method: 'GET', url: '/' });
    expect(portal.body).toContain('id="auth-chip"');
    expect(portal.body).toContain('data-signed-in="0"');
    expect(portal.headers['cache-control']).toContain('no-store');
  });

  it('refuses a wrong key, and says so in the log', async () => {
    const res = await signIn('nope');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'error.apiKeyWrong' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('answers the right key with a session cookie no script can read — and not the key', async () => {
    const res = await signIn('s3cret');
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^breeze_session=[A-Za-z0-9_-]{40,};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Max-Age=43200');
    expect(cookie).not.toContain('s3cret');
    expect(res.json()).toMatchObject({ keyRequired: true, signedIn: true });
  });

  it('lets a signed-in browser save from a page of this server', async () => {
    const cookie = cookieOf(await signIn('s3cret'));
    expect((await save({ cookie, origin: ORIGIN })).statusCode).toBe(200);
    const state = await app.inject({ method: 'GET', url: '/api/auth', headers: { cookie } });
    expect(state.json()).toMatchObject({ signedIn: true, expiresAt: expect.any(String) });
    expect((await app.inject({ method: 'GET', url: '/', headers: { cookie } })).body).toContain('data-signed-in="1"');
  });

  it('refuses the session from another origin, with no origin, or on a GET', async () => {
    const cookie = cookieOf(await signIn('s3cret'));
    expect((await save({ cookie, origin: 'http://breeze.test:8080' })).statusCode).toBe(401);
    expect((await save({ cookie })).statusCode).toBe(401);
    const get = await app.inject({
      method: 'GET', url: '/api/control/demo-1iixd/l3rd-name-2a94g/clear', headers: { host: HOST, origin: ORIGIN, cookie },
    });
    expect(get.statusCode).toBe(401);
  });

  it('ends the session on sign-out', async () => {
    const cookie = cookieOf(await signIn('s3cret'));
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { host: HOST, origin: ORIGIN, cookie } });
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await save({ cookie, origin: ORIGIN })).statusCode).toBe(401);
  });

  it('gates commands on the control socket, but not subscriptions', async () => {
    const next = (ws: import('ws').WebSocket, type: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const on = (raw: unknown) => {
          const message = JSON.parse(String(raw)) as Record<string, unknown>;
          if (message['type'] !== type) return;
          ws.off('message', on);
          resolve(message);
        };
        ws.on('message', on);
      });
    const subscribe = { type: 'subscribe', channel: 'demo-1iixd/l3rd-name-2a94g', role: 'controller', client: 'panel' };
    const command = { type: 'command', command: { verb: 'clear' } };

    const anon = await app.injectWS('/ws/control');
    const welcome = next(anon, 'welcome');
    anon.send(JSON.stringify(subscribe));
    await welcome;
    const refused = next(anon, 'error');
    anon.send(JSON.stringify(command));
    expect(await refused).toMatchObject({ code: 'error.apiKeyRequired' });
    anon.terminate();

    const keyed = await app.injectWS('/ws/control?key=s3cret');
    const welcomed = next(keyed, 'welcome');
    keyed.send(JSON.stringify(subscribe));
    await welcomed;
    const errors: unknown[] = [];
    keyed.on('message', (raw) => {
      if (JSON.parse(String(raw)).type === 'error') errors.push(raw);
    });
    keyed.send(JSON.stringify(command));
    await new Promise((r) => setTimeout(r, 100));
    expect(errors).toEqual([]);
    keyed.terminate();
  });

  it('takes command rights away from an open socket when its browser signs out', async () => {
    const cookie = cookieOf(await signIn('s3cret'));
    const ws = await app.injectWS('/ws/control', { headers: { host: HOST, origin: ORIGIN, cookie } });
    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'demo-1iixd/l3rd-name-2a94g', role: 'controller', client: 'panel' }));
    const settle = () => new Promise((r) => setTimeout(r, 100));
    await settle();
    ws.send(JSON.stringify({ type: 'command', command: { verb: 'clear' } }));
    await settle();
    expect(messages.filter((m) => m['type'] === 'error')).toEqual([]);

    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { host: HOST, origin: ORIGIN, cookie } });
    ws.send(JSON.stringify({ type: 'command', command: { verb: 'clear' } }));
    await settle();
    expect(messages.filter((m) => m['type'] === 'error')).toEqual([expect.objectContaining({ code: 'error.apiKeyRequired' })]);
    ws.terminate();
  });

  it('refuses sign-in and sign-out from any page but its own', async () => {
    const foreign = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: { host: HOST, origin: 'http://evil.test' }, payload: { key: 's3cret' },
    });
    expect(foreign.statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { host: HOST } })).statusCode).toBe(403);
  });

  it('makes an address wait after five wrong keys in a minute — through any route', async () => {
    const from = { remoteAddress: '10.9.8.7' };
    const login = (key: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: HOST, origin: ORIGIN }, payload: { key }, ...from });
    for (let i = 0; i < 3; i += 1) await login('wrong');
    // A wrong header on an ordinary route counts too.
    for (let i = 0; i < 2; i += 1) {
      await app.inject({ method: 'POST', url: PLAY, headers: { 'x-breeze-key': 'guess' }, ...from });
    }
    const res = await login('s3cret');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: 'error.tooManyAttempts' });
    const keyed = await app.inject({ method: 'POST', url: PLAY, headers: { 'x-breeze-key': 's3cret' }, ...from });
    expect(keyed.statusCode).toBe(429);
    // Another address is unaffected.
    expect((await app.inject({ method: 'POST', url: PLAY, headers: { 'x-breeze-key': 's3cret' } })).statusCode).toBe(200);
  });
});

describe('the gate is decided on the resolved route', () => {
  it('cannot be walked round by spelling /api differently', async () => {
    expect((await app.inject({ method: 'POST', url: '/%61pi/control/demo-1iixd/l3rd-name-2a94g/play' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/%61pi/control/demo-1iixd/l3rd-name-2a94g/play' })).statusCode).toBe(401);
    const project = (await app.inject({ method: 'GET', url: '/api/projects/demo-1iixd' })).json();
    expect((await app.inject({ method: 'PUT', url: '/%61pi/projects/demo-1iixd', payload: project })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/%61pi/projects/demo-1iixd' })).statusCode).toBe(401);
  });

  it('keeps an encoded state read open, and an encoded verb gated', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/control/demo-1iixd/l3rd-name-2a94g/%73tate' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/control/demo-1iixd/l3rd-name-2a94g/%70lay' })).statusCode).toBe(401);
  });
});

describe('logging', () => {
  it('takes the key out of a URL before it is logged', async () => {
    const { redactKey } = await import('../session.js');
    expect(redactKey('/api/control/p/c/play?key=s3cret')).toBe('/api/control/p/c/play?key=[redacted]');
    expect(redactKey('/x?table=a&KEY=s3cret&n=2')).toBe('/x?table=a&KEY=[redacted]&n=2');
    expect(redactKey('/x?monkey=1')).toBe('/x?monkey=1');
  });
});

describe('setting the mode requires the key (Wave 6)', () => {
  it('gates the set, and leaves the read open', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/projects/demo-1iixd/mode/set?value=storm' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/projects/demo-1iixd/mode/%73et?value=storm' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/projects/demo-1iixd/mode' })).statusCode).toBe(200);
    const keyed = await app.inject({
      method: 'POST', url: '/api/projects/demo-1iixd/mode/set', headers: { 'x-breeze-key': 's3cret' }, payload: { value: '' },
    });
    expect(keyed.statusCode).toBe(200);
  });
});

describe('checking a camera list requires the key (Wave 8)', () => {
  const BASE = '/api/projects/demo-1iixd/datasources';
  const KEY = { 'x-breeze-key': 's3cret' };

  it('gates the check, and leaves the list and the proxy open', async () => {
    const put = await app.inject({
      method: 'PUT', url: `${BASE}/w8-cams`, headers: KEY,
      payload: {
        id: 'w8-cams', name: 'Cameras', type: 'manual',
        columns: [{ key: 'url', type: 'string' }], rows: [{ url: 'http://127.0.0.1:1/snap.jpg' }],
        media: { column: 'url' },
      },
    });
    expect(put.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `${BASE}/w8-cams/media/check` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `${BASE}/w8-cams/media/check` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `${BASE}/w8-cams/media/%63heck` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `${BASE}/w8-cams/media` })).statusCode).toBe(200);
    // Output pages load the proxy from <img> tags with no key: an unknown camera is a 404, not a 401.
    expect((await app.inject({ method: 'GET', url: '/media/demo-1iixd/w8-cams/ffffffffffff/snapshot' })).statusCode).toBe(404);
    const keyed = await app.inject({ method: 'POST', url: `${BASE}/w8-cams/media/check`, headers: KEY });
    expect(keyed.statusCode).toBe(200);
    // A private address is refused by the same guard as every other fetch.
    expect(keyed.json().rows[0]).toMatchObject({ state: 'failed' });
    expect(keyed.json().rows[0].error).toMatch(/private address/);
  });
});
