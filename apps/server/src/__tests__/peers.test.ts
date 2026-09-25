// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The connections list — `/peers`, `/api/peers`, and the API-caller tracker.
 *
 * The parts worth pinning are the ones that would fail quietly: a `?key=` that
 * leaks onto a page readable without one; our own pages' polling showing up as
 * "API callers" and burying Companion; and a poller that stopped an hour ago
 * still listed as if it were there.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-peers-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../app.js');
const { ApiClients, formatDuration, isExternalApiCall, stripQuery } = await import('../peers.js');
const { peersPage, portalPage } = await import('../pages.js');

const req = (url: string, headers: Record<string, string> = {}, method = 'GET', ip = '10.0.0.7') => ({
  ip,
  method,
  url,
  headers: { host: 'breeze.local:7331', ...headers },
});

describe('isExternalApiCall', () => {
  it('counts a bare API call and ignores everything that is not /api/', () => {
    expect(isExternalApiCall(req('/api/control/a/b/play'))).toBe(true);
    expect(isExternalApiCall(req('/play/a/b'))).toBe(false);
    expect(isExternalApiCall(req('/peers'))).toBe(false);
  });

  it('leaves out our own pages, by fetch metadata or by a same-origin referer', () => {
    expect(isExternalApiCall(req('/api/status', { 'sec-fetch-site': 'same-origin' }))).toBe(false);
    expect(isExternalApiCall(req('/api/status', { referer: 'http://breeze.local:7331/' }))).toBe(false);
    expect(isExternalApiCall(req('/api/projects', { origin: 'http://breeze.local:7331' }))).toBe(false);
  });

  it('still counts a page on some other host calling in', () => {
    expect(isExternalApiCall(req('/api/status', { referer: 'http://dashboard.local/' }))).toBe(true);
    expect(isExternalApiCall(req('/api/status', { referer: 'not a url' }))).toBe(true);
  });
});

describe('ApiClients', () => {
  it('never keeps a query string — the key can travel in one', () => {
    const api = new ApiClients();
    api.note(req('/api/control/a/b/play?key=s3cret'), 200);
    expect(api.list()[0]?.last).toBe('GET /api/control/a/b/play');
    expect(JSON.stringify(api.list())).not.toContain('s3cret');
    expect(stripQuery('/x?y=1')).toBe('/x');
  });

  it('keys a caller on address and agent together, and counts its requests', () => {
    const api = new ApiClients();
    api.note(req('/api/a', { 'user-agent': 'node' }), 200);
    api.note(req('/api/b', { 'user-agent': 'node' }, 'POST'), 401);
    api.note(req('/api/c', { 'user-agent': 'curl/8.9' }), 200);
    const list = api.list();
    expect(list).toHaveLength(2);
    const node = list.find((a) => a.agent === 'node');
    expect(node).toMatchObject({ requests: 2, last: 'POST /api/b', lastStatus: 401 });
  });

  it('lists a caller only for its window after the last request', () => {
    let now = 1_000_000;
    const api = new ApiClients(60_000, () => now);
    api.note(req('/api/a'), 200);
    now += 59_000;
    expect(api.list()).toHaveLength(1);
    now += 2_000;
    expect(api.list()).toHaveLength(0);
    expect(api.windowSeconds).toBe(60);
  });

  it('is bounded, evicting the caller seen longest ago', () => {
    const api = new ApiClients();
    for (let i = 0; i < 250; i += 1) api.note(req('/api/a', { 'user-agent': `bot/${i}` }), 200);
    const list = api.list();
    expect(list.length).toBeLessThanOrEqual(200);
    expect(list.some((a) => a.agent === 'bot/0')).toBe(false);
    expect(list.some((a) => a.agent === 'bot/249')).toBe(true);
  });
});

describe('formatDuration', () => {
  it('reads like a clock', () => {
    expect(formatDuration(5_000)).toBe('0:05');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(-10)).toBe('0:00');
  });
});

describe('routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ seed: false });
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reports external API callers and not the portal polling', async () => {
    await app.inject({ method: 'GET', url: '/api/status', headers: { 'user-agent': 'curl/8.9' } });
    await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { 'user-agent': 'Chrome', 'sec-fetch-site': 'same-origin' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/peers' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as { api: Array<{ agent: string }>; apiWindowSeconds: number; sockets: unknown[] };
    expect(body.apiWindowSeconds).toBe(60);
    expect(body.api.map((a) => a.agent)).toContain('curl/8.9');
    expect(body.api.map((a) => a.agent)).not.toContain('Chrome');
  });

  it('renders the page with whatever the hub has on it', async () => {
    app.hub.addClient('s1', () => {}, { ip: '10.0.0.51', agent: 'vMix/28' });
    app.hub.handle('s1', { type: 'subscribe', channel: 'demo/lower-third', role: 'renderer' });
    app.hub.addClient('p1', () => {}, { ip: '10.0.0.20', agent: 'Chrome' });
    app.hub.handle('p1', { type: 'subscribe', channel: 'demo/scorebug', role: 'controller', client: 'panel' });

    const res = await app.inject({ method: 'GET', url: '/peers' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<code>demo/lower-third</code>');
    expect(res.body).toContain('<code>10.0.0.51</code>');
    expect(res.body).toContain('Control panel');
    expect(res.body).toContain('<meta http-equiv="refresh" content="5">');

    app.hub.removeClient('s1');
    app.hub.removeClient('p1');
  });

  it('filters to one table, and treats an unknown filter as everything', async () => {
    const sources = await app.inject({ method: 'GET', url: '/peers?filter=sources' });
    expect(sources.body).toContain('No browser sources connected.');
    expect(sources.body).not.toContain('No control panels or editors open.');

    const junk = await app.inject({ method: 'GET', url: '/peers?filter=%3Cscript%3E' });
    expect(junk.body).not.toContain('<script>');
    expect(junk.body).toContain('No control panels or editors open.');
  });
});

describe('peersPage', () => {
  const base = { sockets: [], api: [], apiWindowSeconds: 60, now: 100_000 };
  const describeAgent = (a: string) => a;

  it('counts element readouts instead of listing them', () => {
    const mon = (id: string) => ({
      id, kind: 'monitor' as const, channel: 'demo/scene', ip: '10.0.0.2', agent: 'Chrome', connectedAt: 0,
    });
    const html = peersPage({ ...base, sockets: [mon('a'), mon('b'), mon('c')] }, describeAgent);
    expect(html).toContain('Plus 3 element readouts opened by scene panels');
    expect(html).not.toContain('<code>demo/scene</code>');
  });

  it('counts an embedded preview in the note, not the heading, like the status strip', () => {
    const peer = (id: string, kind: 'panel' | 'preview') => ({
      id, kind, channel: 'demo/scene', ip: '10.0.0.2', agent: 'Chrome', connectedAt: 0,
    });
    const html = peersPage({ ...base, sockets: [peer('p', 'panel'), peer('v', 'preview')] }, describeAgent);
    expect(html).toContain('Plus 1 output preview embedded in a control panel.');
    expect(html).toMatch(/Panels &amp; editors <span class="count">1<\/span>/);
  });

  it('escapes what the client sent', () => {
    const html = peersPage(
      {
        ...base,
        api: [{
          ip: '10.0.0.3', agent: '<b>x</b>', requests: 1, last: 'GET /api/<img>',
          lastStatus: 404, firstSeen: 99_000, lastSeen: 99_000,
        }],
      },
      describeAgent,
    );
    expect(html).not.toContain('<img>');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('class="num bad">404');
    expect(html).toContain('1 second ago');
  });
});

describe('portal', () => {
  it('links the connections page beside activity, in the same tab', () => {
    const html = portalPage([]);
    expect(html).toContain('<a class="pill" href="/activity">Activity</a>');
    expect(html).toContain('<a class="pill" href="/peers">Connections</a>');
  });
});
