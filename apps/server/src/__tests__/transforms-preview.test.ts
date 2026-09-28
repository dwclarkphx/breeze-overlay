// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The source preview runs a `lookup` or `union` against the project's other
 * live sources (CYCLE.md, Wave 7) — the author sees the brought columns before
 * saving, not an empty column that fills in only on air.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-test-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../app.js');

let app: FastifyInstance;
const PROJECT = 'demo-1iixd';
const BASE = `/api/projects/${PROJECT}/datasources`;

beforeAll(async () => {
  app = await buildApp();
  const cities = await app.inject({
    method: 'PUT',
    url: `${BASE}/w7-cities`,
    payload: {
      id: 'w7-cities', name: 'Cities', type: 'manual',
      columns: [{ key: 'code', type: 'string' }, { key: 'name', type: 'string' }],
      rows: [{ code: 'PHX', name: 'Phoenix' }, { code: 'FLG', name: 'Flagstaff' }],
    },
  });
  expect(cities.statusCode).toBe(200);
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const forecast = {
  id: 'w7-forecast', name: 'Forecast', type: 'manual',
  columns: [{ key: 'code', type: 'string' }, { key: 'hi', type: 'number' }],
  rows: [{ code: 'phx', hi: 104 }, { code: 'FLG', hi: 78 }],
};

describe('preview with Wave 7 transforms', () => {
  it('brings columns across from a saved source by key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/datasources-preview`,
      payload: { def: forecast, transforms: [{ op: 'lookup', source: 'w7-cities', key: 'code' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.rows).toEqual([
      { code: 'phx', hi: 104, name: 'Phoenix' },
      { code: 'FLG', hi: 78, name: 'Flagstaff' },
    ]);
  });

  it('appends a saved source’s rows', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/datasources-preview`,
      payload: { def: forecast, transforms: [{ op: 'union', source: 'w7-cities' }] },
    });
    const body = res.json();
    expect(body.rowCount).toBe(4);
    expect(body.data.columns.map((c: { key: string }) => c.key)).toEqual(['code', 'hi', 'name']);
  });

  it('reads nothing from another project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/some-other-project/datasources-preview',
      payload: { def: forecast, transforms: [{ op: 'union', source: 'w7-cities' }] },
    });
    expect(res.json().rowCount).toBe(2);
  });
});
