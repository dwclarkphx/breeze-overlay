// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Rundowns, cue → take and outputs (Phase 9 Wave A), against the real app and
 * hub with fake sockets standing in for output pages and panels.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-rundown-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../app.js');
type Hub = import('../hub.js').ControlHub;
type ServerMessage = import('../hub.js').ServerMessage;

const P = 'demo-1iixd';
const LT = 'l3rd-name-2a94g';
const BUG = 'badge-3j8xr';

let app: FastifyInstance;
let hub: Hub;

beforeAll(async () => {
  app = await buildApp();
  hub = (app as unknown as { hub: Hub }).hub;
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function client(id: string, channel: string, role: 'renderer' | 'controller') {
  const received: ServerMessage[] = [];
  hub.addClient(id, (m) => received.push(m));
  hub.handle(id, { type: 'subscribe', channel, role });
  return {
    received,
    // Data-source pushes land on any open channel whenever the demo's sources
    // poll; they are not what these tests are about, and timing decides whether
    // one falls inside a test's window.
    commands: () =>
      received
        .filter((m) => m.type === 'command')
        .map((m) => (m as { command: Record<string, unknown> }).command)
        .filter((c) => c['source'] !== 'datasource'),
    close: () => hub.removeClient(id),
  };
}

const doc = {
  formatVersion: 1,
  rundowns: [
    {
      id: 'sunday',
      name: 'Sunday service',
      items: [
        { id: 'a', composition: LT, data: { name: 'Jane Doe', title: 'Elder' } },
        { id: 'b', composition: LT, data: { name: 'John Roe', title: 'Pastor' } },
        { id: 'c', composition: LT, data: { name: 'Ann Poe' }, output: 'main' },
        { id: 'd', composition: BUG, output: 'main', layer: 10 },
      ],
    },
  ],
};

const put = (body: unknown) => app.inject({ method: 'PUT', url: `/api/projects/${P}/rundowns`, payload: body as object });
const verb = (name: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/api/rundown/${P}/sunday/${name}`, payload });

describe('the document', () => {
  it('reads as empty before anything is saved', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${P}/rundowns` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ formatVersion: 1, rundowns: [] });
  });

  it('saves, and reads back what was saved', async () => {
    expect((await put(doc)).statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: `/api/projects/${P}/rundowns` });
    expect(res.json()).toEqual(doc);
    const onDisk = JSON.parse(await fs.readFile(path.join(tmpDir, 'projects', P, 'rundowns.json'), 'utf8'));
    expect(onDisk).toEqual(doc);
  });

  it('refuses an item naming a composition the project does not have', async () => {
    const bad = structuredClone(doc);
    bad.rundowns[0]!.items.push({ id: 'z', composition: 'nope' } as never);
    const res = await put(bad);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('error.rundownInvalid');
    expect(res.json().issues[0].path).toBe('/rundowns/0/items/4/composition');
  });
});

describe('cue and take', () => {
  beforeEach(async () => {
    await put(doc);
    await verb('cue', { item: null });
  });

  it('arming changes nothing on air, and every panel hears it', async () => {
    const out = client('o1', `${P}/${LT}`, 'renderer');
    const panel = client('p1', `${P}/#rundowns`, 'controller');
    const res = await verb('cue', { item: 'a' });
    expect(res.json()).toMatchObject({ ok: true, armed: 'a' });
    expect(out.commands()).toEqual([]);
    const last = panel.received.at(-1) as { state: { data: Record<string, unknown> } };
    expect((last.state.data['$rundown'] as Record<string, { armed: string }>)['sunday']?.armed).toBe('a');
    out.close();
    panel.close();
  });

  it('a refreshed panel is welcomed with the same armed item', async () => {
    await verb('cue', { item: 'b' });
    const panel = client('p2', `${P}/#rundowns`, 'controller');
    const welcome = panel.received[0] as { type: string; state: { data: Record<string, unknown> } };
    expect(welcome.type).toBe('welcome');
    expect((welcome.state.data['$rundown'] as Record<string, { armed: string }>)['sunday']?.armed).toBe('b');
    panel.close();
  });

  it('take sends values and PLAY as one command, retains the values, and arms the next', async () => {
    const out = client('o2', `${P}/${LT}`, 'renderer');
    await verb('cue', { item: 'a' });
    const res = await verb('take');
    expect(res.json()).toMatchObject({ ok: true, item: 'a', target: LT, delivered: 1, armed: 'b' });
    expect(out.commands()).toEqual([{ verb: 'take', data: { name: 'Jane Doe', title: 'Elder' }, source: 'rest' }]);
    expect(hub.state(`${P}/${LT}`).data).toMatchObject({ name: 'Jane Doe' });

    // One button walks the list.
    expect((await verb('take')).json()).toMatchObject({ item: 'b', armed: 'c' });
    out.close();
  });

  it('take with nothing armed is refused', async () => {
    const res = await verb('take');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('error.rundownNothingArmed');
  });

  it('next and prev arm without wrapping, and next follows the last take', async () => {
    await verb('cue', { item: 'a' });
    expect((await verb('next')).json().armed).toBe('b');
    expect((await verb('prev')).json().armed).toBe('a');
    expect((await verb('prev')).json().armed).toBe('a');
    await verb('cue', { item: 'd' });
    expect((await verb('next')).json().armed).toBe('d');
    await verb('take', { item: 'a', advance: false });
    await verb('cue', { item: null });
    expect((await verb('next')).json().armed).toBe('b');
  });

  it('reports each target and what was taken there', async () => {
    await verb('take', { item: 'a' });
    const state = (await app.inject({ method: 'GET', url: `/api/rundown/${P}/sunday/state` })).json();
    expect(state.targets.map((t: { target: string }) => t.target)).toEqual([LT, '@main']);
    expect(state.onAir[LT]).toBe('a');
  });

  it('works over the socket too, in the order sent, and nothing is dispatched on the rundown channel', async () => {
    const out = client('o3', `${P}/${LT}`, 'renderer');
    const panel = client('p3', `${P}/#rundowns`, 'controller');
    try {
      // Back to back, as a Companion button would: TAKE must see the CUE.
      hub.handle('p3', { type: 'command', command: { verb: 'cue', rundown: 'sunday', item: 'a' } });
      hub.handle('p3', { type: 'command', command: { verb: 'take', rundown: 'sunday' } });
      // Polled, not slept: both verbs read rundowns.json, and a loaded run is slow.
      await vi.waitFor(() => expect(out.commands().map((c) => c['verb'])).toEqual(['take']), { timeout: 2_000 });
      expect(panel.received.filter((m) => m.type === 'error')).toEqual([]);
      expect(panel.commands()).toEqual([]);
    } finally {
      // Closed even on failure: a renderer left behind is counted in every
      // later test's `delivered` on this channel.
      out.close();
      panel.close();
    }
  });
});

describe('outputs', () => {
  beforeEach(async () => {
    await put(doc);
    await app.inject({ method: 'POST', url: `/api/out/${P}/main/clear` });
  });

  it('mounts what the rundown takes onto it, in layer order, and retains the values on the mount', async () => {
    const page = client('out1', `${P}/@main`, 'renderer');
    await verb('take', { item: 'd' });
    await verb('take', { item: 'c' });
    const commands = page.commands();
    const takes = commands.filter((c) => c['verb'] === 'take');
    expect(takes).toEqual([
      { verb: 'take', mount: BUG, data: {}, source: 'rest' },
      { verb: 'take', mount: LT, data: { name: 'Ann Poe' }, source: 'rest' },
    ]);
    const mounts = hub.state(`${P}/@main`).data['$mounts'] as Array<{ composition: string }>;
    // The bug is layer 10, so in front of the lower third taken after it.
    expect(mounts.map((m) => m.composition)).toEqual([LT, BUG]);
    expect(hub.state(`${P}/@main~${LT}`).data).toMatchObject({ name: 'Ann Poe' });
    // Field values go to the mount's channel, never the routing channel's.
    expect(hub.state(`${P}/@main`).data['name']).toBeUndefined();
    page.close();
  });

  it('a reloaded output page is welcomed with the same stack', async () => {
    await verb('take', { item: 'c' });
    const page = client('out2', `${P}/@main`, 'renderer');
    const welcome = page.received[0] as { state: { data: Record<string, unknown> } };
    expect((welcome.state.data['$mounts'] as Array<{ composition: string }>).map((m) => m.composition)).toEqual([LT]);
    page.close();
  });

  it('take out stops only the graphic this rundown put there', async () => {
    const page = client('out3', `${P}/@main`, 'renderer');
    await verb('take', { item: 'c' });
    await verb('take', { item: 'd' });
    const res = await verb('out', { target: '@main' });
    expect(res.json()).toMatchObject({ ok: true, target: '@main', delivered: 1 });
    expect(page.commands().at(-1)).toEqual({ verb: 'stop', source: 'rundown', mount: BUG });
    page.close();
  });

  it('clear empties the stack', async () => {
    await verb('take', { item: 'c' });
    const res = await app.inject({ method: 'POST', url: `/api/out/${P}/main/clear` });
    expect(res.json()).toMatchObject({ ok: true, verb: 'clear' });
    expect(hub.state(`${P}/@main`).data['$mounts']).toEqual([]);
  });

  it('serves the output page, and refuses a bad output name', async () => {
    const ok = await app.inject({ method: 'GET', url: `/out/${P}/main` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('output: "main"');
    expect(ok.body).toContain('/public/player.js');
    const bad = await app.inject({ method: 'GET', url: `/out/${P}/Main%20Out` });
    expect(bad.statusCode).toBe(400);
  });

  it('shapes an output page for a switcher with ?bg= and ?matte=1 (Phase 9 Wave C)', async () => {
    const chroma = await app.inject({ method: 'GET', url: `/out/${P}/main?bg=0000ff` });
    expect(chroma.body).toContain(':root,:root>body{background:#0000ff!important}');
    const matte = await app.inject({ method: 'GET', url: `/out/${P}/main?matte=1` });
    expect(matte.body).toContain('#breeze-stage{filter:brightness(0) invert(1)}');
    expect(matte.body).toContain('<title>@main · matte — Breeze</title>');
  });

  it('serves the rundown panel with every composition and its fields', async () => {
    const res = await app.inject({ method: 'GET', url: `/rundown/${P}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('/public/rundown.js');
    expect(res.body).toContain(LT);
  });

  it('seeds a new mount with the project rows, so a graphic mounted mid-show is not stale', async () => {
    await verb('take', { item: 'c' });
    expect(hub.state(`${P}/@main~${LT}`).data).toHaveProperty('$data');
  });
});

describe('control panel take', () => {
  it('REST take on a graphic dispatches values and PLAY as one command', async () => {
    const out = client('o9', `${P}/${LT}`, 'renderer');
    const res = await app.inject({ method: 'POST', url: `/api/control/${P}/${LT}/take`, payload: { name: 'Zed' } });
    expect(res.json()).toMatchObject({ ok: true, verb: 'take', delivered: 1 });
    expect(out.commands()).toEqual([{ verb: 'take', data: { name: 'Zed' }, source: 'rest' }]);
    out.close();
  });
});

describe('timer routes (Phase 9 Wave B)', () => {
  it('starts, adjusts and reports a graphic timer over REST', async () => {
    const out = client('timer-out', `${P}/${LT}`, 'renderer');
    const start = await app.inject({ method: 'POST', url: `/api/control/${P}/${LT}/timer`, payload: { action: 'start', id: 'game' } });
    expect(start.statusCode).toBe(200);
    expect(start.json().timer.state.running).toBe(true);
    expect(start.json().delivered).toBe(1);
    const add = await app.inject({ method: 'GET', url: `/api/control/${P}/${LT}/timer?action=add&id=game&value=-10` });
    expect(add.json().timer.state.adjust).toBe(-10_000);
    const state = await app.inject({ method: 'GET', url: `/api/control/${P}/${LT}/state?data=0` });
    expect(state.json().timers.timers.game.running).toBe(true);
    expect(out.commands().at(-1)?.['verb']).toBe('update');
    out.close();
  });

  it('refuses a bad action or value with a code', async () => {
    const bad = await app.inject({ method: 'POST', url: `/api/control/${P}/${LT}/timer`, payload: { action: 'explode' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('error.timerAction');
    const value = await app.inject({ method: 'POST', url: `/api/control/${P}/${LT}/timer`, payload: { action: 'set', value: 'soon' } });
    expect(value.json().code).toBe('error.timerValue');
  });

  it('runs one clock for everything on an output', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/out/${P}/main/timer`, payload: { action: 'set', id: 'game', value: '8:00' } });
    expect(res.statusCode).toBe(200);
    expect(hub.timerState(`${P}/@main~${BUG}`, 'game')?.base).toBe(480_000);
  });
});
