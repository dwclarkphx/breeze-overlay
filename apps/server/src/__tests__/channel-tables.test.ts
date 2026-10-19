// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * `/api/channels` lists each channel's paged tables.
 *
 * Companion builds its buttons from this at connect, before any output has
 * reported in, so the listing is the only place it can learn that Standings
 * has a page to show — and the address it hands out has to be the one NEXT
 * accepts.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createComposition,
  createLayer,
  createTableLayer,
  createTextLayer,
  type CompositionLayer,
} from '@breeze/schema';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-channel-tables-'));
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

type Channel = { channel: string; sceneId: string | null; tables: Array<{ table: string; name: string; cycle: boolean }> };

async function channelsOf(projectId: string): Promise<Channel[]> {
  const res = await app.inject({ method: 'GET', url: '/api/channels' });
  expect(res.statusCode).toBe(200);
  return (res.json().projects as Array<{ id: string; channels: Channel[] }>).find((p) => p.id === projectId)!.channels;
}

describe('paged tables in /api/channels', () => {
  it('lists the demo standings table under the address NEXT takes', async () => {
    const standings = (await channelsOf('demo-1iixd')).find((c) => c.channel === 'standings-72q2s');
    expect(standings?.tables).toEqual([{ table: 'standings', name: 'Standings table', cycle: false }]);
  });

  it('gives a graphic with nothing to page an empty list, never a missing one', async () => {
    const lower = (await channelsOf('demo-1iixd')).find((c) => c.channel === 'l3rd-name-2a94g');
    expect(lower?.tables).toEqual([]);
  });

  it('lists a scene element’s tables under the element’s own channel, not the scene’s', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Paging scene', key: 'paging' } });
    expect(created.statusCode).toBe(201);
    const project = created.json();

    const tableComp = createComposition({
      id: 'board-1abcd',
      name: 'Board',
      layers: [
        createTableLayer({
          id: 'grid',
          name: 'Leaders',
          binding: 'leaders',
          rowsPerPage: 3,
          cycle: { dwell: 6 } as never,
          row: { height: 40, cells: [createTextLayer({ id: 'c', cell: 'n', size: { width: 200, height: 40 } })] },
          data: { columns: [{ key: 'n', type: 'string' }], rows: [{ n: 'a' }, { n: 'b' }, { n: 'c' }, { n: 'd' }] },
        }),
      ],
    });
    const scene = createComposition({
      id: 'show-2abcd',
      name: 'Show',
      layers: [
        { ...(createLayer('composition') as CompositionLayer), id: 'el', ref: 'board-1abcd', independent: true, channel: 'board' },
      ],
    });

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}`,
      payload: { ...project, compositions: [tableComp, scene] },
    });
    expect(put.statusCode).toBe(200);

    const channels = await channelsOf(project.id);
    const element = channels.find((c) => c.channel === 'board');
    expect(element?.sceneId).toBe('show-2abcd');
    // Addressed from the element's own composition — it plays on a runtime of
    // its own — so `leaders`, not `el.leaders`.
    expect(element?.tables).toEqual([{ table: 'leaders', name: 'Leaders', cycle: true }]);
    // The scene's own channel does not claim a table that belongs to its element.
    expect(channels.find((c) => c.channel === 'show-2abcd')?.tables).toEqual([]);
  });
});
