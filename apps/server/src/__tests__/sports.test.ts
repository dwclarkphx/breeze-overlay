// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Sport templates on the server (Phase 9 Wave B): the catalogue route, and a
 * score tapped on the game table reaching every open graphic of the project.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { newGameRow, sportDataColumns, sportRuleset, sportTemplate } from '@breeze/schema';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-sports-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../app.js');
type Hub = import('../hub.js').ControlHub;
type ServerMessage = import('../hub.js').ServerMessage;

const P = 'demo-1iixd';
let app: FastifyInstance;
let hub: Hub;

beforeAll(async () => {
  app = await buildApp();
  hub = (app as unknown as { hub: Hub }).hub;
  const t = sportTemplate('basketball')!;
  const r = sportRuleset(t, 'nba');
  const res = await app.inject({
    method: 'PUT',
    url: `/api/projects/${P}/datasources/bball-game`,
    payload: {
      id: 'bball-game',
      name: 'Basketball — Game',
      type: 'manual',
      columns: sportDataColumns(t, r, 'game'),
      rows: [newGameRow(t, r)],
      template: { sport: 'basketball', ruleset: 'nba', table: 'game' },
    },
  });
  expect(res.statusCode).toBe(200);
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const game = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/projects/${P}/datasources/bball-game/game`, payload });

describe('the catalogue', () => {
  it('lists every sport with its rulesets, buttons and columns', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/sports' })).json();
    const bball = body.sports.find((s: { id: string }) => s.id === 'basketball');
    expect(bball.actions.map((a: { label: string }) => a.label)).toEqual(['+1', '+2', '+3']);
    expect(bball.rulesets[0].timers.map((t: { id: string }) => t.id)).toEqual(['game', 'shot']);
    expect(bball.rulesets[0].columns.game.map((c: { key: string }) => c.key)).toContain('homeBonus');
  });
});

describe('game actions', () => {
  it('scores, and every open graphic of the project gets the new row', async () => {
    const received: ServerMessage[] = [];
    hub.addClient('bug-out', (m) => received.push(m));
    hub.handle('bug-out', { type: 'subscribe', channel: `${P}/l3rd-name-2a94g`, role: 'renderer' });
    const res = await game({ type: 'score', side: 'home', action: 'three' });
    expect(res.statusCode).toBe(200);
    expect(res.json().row).toMatchObject({ homeScore: 3, home1: 3 });
    const pushed = received
      .filter((m) => m.type === 'command')
      .map((m) => (m as { command: { data?: Record<string, unknown> } }).command.data?.['$data'] as Record<string, { rows: Array<Record<string, unknown>> }> | undefined)
      .find((d) => d?.['bball-game']);
    expect(pushed?.['bball-game']?.rows[0]?.['homeScore']).toBe(3);
    hub.removeClient('bug-out');
  });

  it('keeps every tap when they arrive together', async () => {
    await Promise.all([1, 2, 3, 4].map(() => game({ type: 'score', side: 'away', action: 'ft' })));
    const def = (await app.inject({ method: 'GET', url: `/api/projects/${P}/datasources/bball-game` })).json();
    expect(def.data.rows[0].awayScore).toBe(4);
  });

  it('moves the period and resets the team fouls', async () => {
    await game({ type: 'adjust', column: 'homeFouls', delta: 3 });
    const res = await game({ type: 'period', delta: 1 });
    expect(res.json().row).toMatchObject({ period: 2, periodLabel: '2nd', homeFouls: 0 });
  });

  it('works from a header-less GET', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${P}/datasources/bball-game/game?type=set&column=possession&value=away` });
    expect(res.json().row.possession).toBe('away');
  });

  it('refuses an action it cannot read, and a source that is not a game table', async () => {
    expect((await game({ type: 'score', side: 'middle', action: 'ft' })).json().code).toBe('error.gameSide');
    expect((await game({ type: 'dance' })).json().code).toBe('error.gameAction');
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${P}/datasources/plain`,
      payload: { id: 'plain', name: 'Plain', type: 'manual', columns: [{ key: 'a', type: 'string' }], rows: [] },
    });
    const res = await app.inject({ method: 'POST', url: `/api/projects/${P}/datasources/plain/game`, payload: { type: 'reset' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('error.gameNotGameTable');
  });
});
