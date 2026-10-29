// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Phase 9 Wave R on the server (ROLLS.md, CHARTS.md): the scroll transport in
 * the hub, its REST verbs, text and poll sources, and the routes an operator
 * changes them through.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { ControlHub, channelKey, type ServerMessage } from '../hub.js';
import { readScrollRequest } from '../scroll-request.js';
import { readPollAction } from '../routes/live-sources.js';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-wave-r-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../app.js');

const P = 'demo-1iixd';
const CHANNEL = channelKey(P, 'l3rd-name-2a94g');

type Update = { type: 'command'; command: { verb: string; data?: Record<string, unknown> } };
const scrollsIn = (m: ServerMessage | undefined) =>
  (m as Update | undefined)?.command.data?.['$scrolls'] as
    | { clock: number; scrolls: Record<string, { running: boolean; base: number; rate: number }>; playAt?: number }
    | undefined;

/** A renderer that has reported a roll, so the hub knows its extent. */
function rollOutput(hub: ControlHub, id: string, channel = CHANNEL, extent = 100, start: 'play' | 'operator' = 'play') {
  const received: ServerMessage[] = [];
  hub.addClient(id, (m) => received.push(m));
  hub.handle(id, { type: 'subscribe', channel, role: 'renderer' });
  hub.handle(id, {
    type: 'state',
    playback: { state: 'idle', time: 0, step: 0, stepCount: 1, scrolls: [{ id: 'main', extent, end: 'hold', start, travel: 0, running: false, rate: 1 }] },
  });
  return { received, last: () => received.filter((m) => m.type === 'command').at(-1) };
}

/* ------------------------------------------------------------------ hub */

describe('the scroll transport in the hub', () => {
  it('applies a verb and sends renderers $scrolls, never the verb', () => {
    const hub = new ControlHub();
    const out = rollOutput(hub, 'out');
    expect(hub.dispatch(CHANNEL, { verb: 'scroll', scroll: { action: 'play' } })).toBe(1);
    const sent = out.last() as Update;
    expect(sent.command.verb).toBe('update');
    expect(scrollsIn(sent)?.scrolls['main']?.running).toBe(true);
    expect(hub.scrollState(CHANNEL, 'main').running).toBe(true);
  });

  it('clamps with the extent an output reported, so reversing at the end moves at once', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const hub = new ControlHub();
      rollOutput(hub, 'out');
      hub.dispatch(CHANNEL, { verb: 'scroll', scroll: { action: 'play' } });
      vi.setSystemTime(1_000_000 + 500_000);
      hub.dispatch(CHANNEL, { verb: 'scroll', scroll: { action: 'backward' } });
      const state = hub.scrollState(CHANNEL, 'main');
      expect(state.base).toBe(100);
      expect(state.rate).toBe(-1);
      hub.dispatch(CHANNEL, { verb: 'scroll', scroll: { action: 'seek', value: 50, percent: true } });
      expect(hub.scrollState(CHANNEL, 'main').base).toBe(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fresh PLAY resets the rolls and stamps the start; a PLAY from a hold does not', () => {
    const hub = new ControlHub();
    const out = rollOutput(hub, 'out');
    hub.dispatch(CHANNEL, { verb: 'scroll', scroll: { action: 'faster' } });
    hub.dispatch(CHANNEL, { verb: 'play' });
    const commands = out.received.filter((m) => m.type === 'command') as Update[];
    // The reset goes out before the PLAY, so the page holds it when its intro starts.
    expect(commands.at(-2)?.command.verb).toBe('update');
    expect(commands.at(-1)?.command.verb).toBe('play');
    const reset = scrollsIn(commands.at(-2));
    expect(reset?.scrolls).toEqual({});
    expect(reset?.playAt).toBeTypeOf('number');
    // A roll that starts on PLAY runs from it.
    expect(hub.scrollState(CHANNEL, 'main').running).toBe(true);

    hub.handle('out', { type: 'state', playback: { state: 'holding', time: 1, step: 1, stepCount: 2 } });
    hub.dispatch(CHANNEL, { verb: 'scroll', scroll: { action: 'pause' } });
    hub.dispatch(CHANNEL, { verb: 'play' });
    expect(hub.scrollState(CHANNEL, 'main').running).toBe(false);
  });

  it('CLEAR leaves nothing playing, and a graphic with no roll is sent nothing', () => {
    const hub = new ControlHub();
    rollOutput(hub, 'out');
    hub.dispatch(CHANNEL, { verb: 'play' });
    hub.dispatch(CHANNEL, { verb: 'clear' });
    expect(hub.scrollState(CHANNEL, 'main').running).toBe(false);

    const plain = new ControlHub();
    const received: ServerMessage[] = [];
    plain.addClient('o', (m) => received.push(m));
    plain.handle('o', { type: 'subscribe', channel: CHANNEL, role: 'renderer' });
    plain.dispatch(CHANNEL, { verb: 'play' });
    expect(received.filter((m) => m.type === 'command').map((m) => (m as Update).command.verb)).toEqual(['play']);
  });

  it('welcomes a late page with the scrolls, and shares them across an output', () => {
    const hub = new ControlHub();
    rollOutput(hub, 'credits', `${P}/@main~credits-1`);
    hub.dispatch(`${P}/@main`, { verb: 'scroll', scroll: { action: 'play' } });
    const late: ServerMessage[] = [];
    hub.addClient('late', (m) => late.push(m));
    hub.handle('late', { type: 'subscribe', channel: `${P}/@main~lyrics-2`, role: 'renderer' });
    const welcome = late.find((m) => m.type === 'welcome') as { state: { data: Record<string, unknown> } };
    expect((welcome.state.data['$scrolls'] as { scrolls: Record<string, { running: boolean }> }).scrolls['main']?.running).toBe(true);
  });

  it('an operator-started roll waits through PLAY', () => {
    const hub = new ControlHub();
    rollOutput(hub, 'out', CHANNEL, 100, 'operator');
    hub.dispatch(CHANNEL, { verb: 'play' });
    expect(hub.scrollState(CHANNEL, 'main').running).toBe(false);
  });
});

describe('reading requests', () => {
  it('reads scroll verbs as an operator types them', () => {
    expect(readScrollRequest({ action: 'speed', value: 'x1.5' })).toMatchObject({ ok: true, value: 1.5 });
    expect(readScrollRequest({ action: 'jog', value: '-3' })).toMatchObject({ ok: true, value: -3 });
    expect(readScrollRequest({ action: 'seek', value: '50%', id: 'credits' })).toMatchObject({ ok: true, value: 50, percent: true, id: 'credits' });
    expect(readScrollRequest({ action: 'seek', value: '1:30' })).toMatchObject({ ok: true, value: 90 });
    expect(readScrollRequest({ action: 'fly' })).toMatchObject({ ok: false, code: 'error.scrollAction' });
    expect(readScrollRequest({ action: 'speed', value: '0' })).toMatchObject({ ok: false, code: 'error.scrollValue' });
    expect(readScrollRequest({ action: 'play', id: 'Bad Id' })).toMatchObject({ ok: false, code: 'error.scrollId' });
  });

  it('reads poll actions', () => {
    expect(readPollAction({ type: 'vote', option: 'a' })).toEqual({ type: 'vote', option: 'a', delta: 1 });
    expect(readPollAction({ action: 'vote', option: 'a', delta: '-1' })).toEqual({ type: 'vote', option: 'a', delta: -1 });
    expect(readPollAction({ type: 'set', option: 'b', value: '12' })).toEqual({ type: 'set', option: 'b', value: 12 });
    expect(readPollAction({ type: 'close' })).toEqual({ type: 'close' });
    expect(readPollAction({ type: 'vote' })).toEqual({ error: 'error.pollOption' });
    expect(readPollAction({ type: 'shout' })).toEqual({ error: 'error.pollAction' });
  });
});

/* ---------------------------------------------------------------- routes */

describe('routes', () => {
  let app: FastifyInstance;
  let hub: ControlHub;

  beforeAll(async () => {
    app = await buildApp();
    hub = (app as unknown as { hub: ControlHub }).hub;
    const put = (id: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: `/api/projects/${P}/datasources/${id}`, payload: { id, ...payload } });
    expect((await put('credits', { name: 'Credits', type: 'text', body: '# Credits\nCamera | Pat\n\nThanks', operatorEditable: true })).statusCode).toBe(200);
    expect((await put('locked', { name: 'Locked', type: 'text', body: 'A' })).statusCode).toBe(200);
    expect(
      (await put('poll', { name: 'Poll', type: 'poll', question: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })).statusCode,
    ).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('a text source is parsed into rows as soon as it is saved', async () => {
    const rows = (await app.inject({ method: 'GET', url: `/api/projects/${P}/datasources/credits` })).json().data.rows;
    expect(rows.map((r: { kind: string }) => r.kind)).toEqual(['heading', 'pair', 'gap', 'line']);
  });

  it('an operator changes an operator-changeable text, and every graphic gets the rows', async () => {
    const received: ServerMessage[] = [];
    hub.addClient('roll-out', (m) => received.push(m));
    hub.handle('roll-out', { type: 'subscribe', channel: CHANNEL, role: 'renderer' });
    const res = await app.inject({ method: 'PUT', url: `/api/projects/${P}/datasources/credits/text`, payload: { body: 'One\nTwo\nThree' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toBe(3);
    const pushed = received
      .filter((m): m is Update => m.type === 'command')
      .map((m) => (m.command.data?.['$data'] as Record<string, { rows: unknown[] }> | undefined)?.['credits'])
      .filter(Boolean);
    expect(pushed.at(-1)?.rows).toHaveLength(3);
  });

  it('refuses a text the designer did not make changeable, or one too long', async () => {
    const locked = await app.inject({ method: 'PUT', url: `/api/projects/${P}/datasources/locked/text`, payload: { body: 'B' } });
    expect(locked.statusCode).toBe(403);
    expect(locked.json().code).toBe('error.textNotEditable');
    const big = await app.inject({ method: 'PUT', url: `/api/projects/${P}/datasources/credits/text`, payload: { body: 'x'.repeat(256 * 1024 + 10) } });
    expect(big.statusCode).toBe(413);
    const wrong = await app.inject({ method: 'PUT', url: `/api/projects/${P}/datasources/poll/text`, payload: { body: 'B' } });
    expect(wrong.statusCode).toBe(409);
  });

  it('counts votes from POST and from a header-less GET, and closes', async () => {
    let res = await app.inject({ method: 'POST', url: `/api/projects/${P}/datasources/poll/poll`, payload: { type: 'vote', option: 'a' } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: `/api/projects/${P}/datasources/poll/poll?type=vote&option=b&delta=3` });
    expect(res.json().rows.map((r: { votes: number; percent: number }) => [r.votes, r.percent])).toEqual([[1, 25], [3, 75]]);
    res = await app.inject({ method: 'POST', url: `/api/projects/${P}/datasources/poll/poll`, payload: { type: 'close' } });
    expect(res.json().rows[0].status).toBe('closed');
    const bad = await app.inject({ method: 'POST', url: `/api/projects/${P}/datasources/poll/poll`, payload: { type: 'vote', option: 'zz' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('error.pollOption');
  });

  it('two taps a frame apart both land', async () => {
    await app.inject({ method: 'POST', url: `/api/projects/${P}/datasources/poll/poll`, payload: { type: 'reset' } });
    await Promise.all(
      Array.from({ length: 6 }, () => app.inject({ method: 'POST', url: `/api/projects/${P}/datasources/poll/poll`, payload: { type: 'vote', option: 'a' } })),
    );
    const res = await app.inject({ method: 'POST', url: `/api/projects/${P}/datasources/poll/poll`, payload: { type: 'vote', option: 'a', delta: 0 } });
    expect(res.json().rows[0].votes).toBe(6);
  });

  it('re-words a poll only when it is operator changeable', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/projects/${P}/datasources/poll/poll`, payload: { question: 'New?' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('error.pollNotEditable');
  });

  it('drives the transport over REST on a graphic and an output', async () => {
    rollOutput(hub, 'rest-out', `${P}/ticker-40hbh`);
    const res = await app.inject({ method: 'POST', url: `/api/control/${P}/ticker-40hbh/scroll`, payload: { action: 'faster' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().scroll).toMatchObject({ id: 'main', action: 'faster', state: { rate: 1.25 }, info: { extent: 100 } });
    const bad = await app.inject({ method: 'POST', url: `/api/control/${P}/ticker-40hbh/scroll`, payload: { action: 'warp' } });
    expect(bad.statusCode).toBe(400);
    const out = await app.inject({ method: 'GET', url: `/api/out/${P}/main/scroll?action=pause&id=credits` });
    expect(out.statusCode).toBe(200);
    expect(out.json().scroll.state.running).toBe(false);
    // A lean /state poller (Companion) gets the scrolls without the field data.
    const state = (await app.inject({ method: 'GET', url: `/api/control/${P}/ticker-40hbh/state?data=0` })).json();
    expect(state.scrolls.items).toEqual([expect.objectContaining({ id: 'main', state: expect.objectContaining({ rate: 1.25 }), info: expect.objectContaining({ extent: 100 }) })]);
    expect(typeof state.scrolls.clock).toBe('number');
    const outState = (await app.inject({ method: 'GET', url: `/api/out/${P}/main/state` })).json();
    expect(outState.scrolls.items.map((s: { id: string }) => s.id)).toContain('credits');
  });
});
