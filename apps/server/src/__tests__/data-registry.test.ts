// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The registry's three on-air rules (see `registry.ts`): a dead feed never
 * blanks a graphic, a push only happens on a real change, and one slow origin
 * cannot starve the loop.
 */

import { describe, expect, it } from 'vitest';

import { DataRegistry, backoffMultiplier, hashDataSet, loadDataSource } from '../data/registry.js';
import type { DataSet, DataSourceDef } from '@breeze/schema';

const manual: DataSourceDef = {
  id: 'standings',
  name: 'Standings',
  type: 'manual',
  columns: [
    { key: 'team', type: 'string' },
    { key: 'w', type: 'number' },
  ],
  rows: [{ team: 'Mesa', w: 11 }],
};

const base: DataSet = {
  id: 'x',
  columns: [{ key: 'team', type: 'string' }],
  rows: [{ team: 'Mesa' }],
};

describe('hashDataSet', () => {
  it('ignores fetch metadata', () => {
    /*
     * `fetchedAt` moves on every poll and `revision` is derived from this very
     * hash. Including either would make every source look permanently dirty and
     * re-render every graphic on every interval.
     */
    expect(hashDataSet({ ...base, fetchedAt: 'a', revision: 1 })).toBe(
      hashDataSet({ ...base, fetchedAt: 'b', revision: 99 }),
    );
  });

  it('ignores key order within a row', () => {
    // Several origins re-serialise their JSON with different key order between
    // requests; that is not a change to the data.
    const a: DataSet = { id: 'x', columns: [], rows: [{ a: 1, b: 2 }] };
    const b: DataSet = { id: 'x', columns: [], rows: [{ b: 2, a: 1 }] };
    expect(hashDataSet(a)).toBe(hashDataSet(b));
  });

  it('changes when a value does', () => {
    expect(hashDataSet(base)).not.toBe(
      hashDataSet({ ...base, rows: [{ team: 'Tempe' }] }),
    );
  });

  it('changes when row order does — a re-sort is a change', () => {
    const two: DataSet = { ...base, rows: [{ team: 'Mesa' }, { team: 'Tempe' }] };
    const swapped: DataSet = { ...base, rows: [{ team: 'Tempe' }, { team: 'Mesa' }] };
    expect(hashDataSet(two)).not.toBe(hashDataSet(swapped));
  });

  it('changes when a column is retyped', () => {
    // Same values, different sort behavior — worth a re-push.
    expect(hashDataSet({ id: 'x', columns: [{ key: 'w', type: 'number' }], rows: [] })).not.toBe(
      hashDataSet({ id: 'x', columns: [{ key: 'w', type: 'string' }], rows: [] }),
    );
  });
});

describe('backoffMultiplier', () => {
  it('is 1 while healthy', () => {
    expect(backoffMultiplier(0)).toBe(1);
  });

  it('grows with consecutive failures and then caps', () => {
    expect(backoffMultiplier(1)).toBe(1);
    expect(backoffMultiplier(3)).toBe(4);
    expect(backoffMultiplier(99)).toBe(30);
  });
});

describe('loadDataSource', () => {
  it('reads a manual source straight from its definition', async () => {
    const { data } = await loadDataSource(manual);
    expect(data!.rows).toEqual([{ team: 'Mesa', w: 11 }]);
  });

  it('coerces manual rows to their declared types', async () => {
    const { data } = await loadDataSource({ ...manual, rows: [{ team: 'Mesa', w: '11' }] });
    expect(data!.rows[0]!.w).toBe(11);
  });

  it('refuses an HTTP source whose secret is not configured', async () => {
    // Better to fail loudly here than to send an unauthenticated request and
    // cache whatever error page comes back as the data.
    await expect(
      loadDataSource({
        id: 'f', name: 'Feed', type: 'http-json', url: 'https://example.com/x.json',
        secretId: 'missing-on-this-server',
      }),
    ).rejects.toThrow(/not configured/);
  });
});

describe('DataRegistry', () => {
  it('serves a manual source immediately, with no fetch', async () => {
    const registry = new DataRegistry();
    const entry = await registry.upsert('p', manual);
    expect(entry.data.rows).toHaveLength(1);
    expect(entry.status.revision).toBe(1);
    registry.stop();
  });

  it('pushes on a change and stays silent otherwise', async () => {
    const registry = new DataRegistry();
    const pushes: string[] = [];
    registry.onPush((_p, data) => pushes.push(String(data.rows[0]?.team)));

    await registry.upsert('p', manual);
    await registry.upsert('p', manual); // identical — no push
    await registry.upsert('p', { ...manual, rows: [{ team: 'Tempe', w: 9 }] });

    expect(pushes).toEqual(['Mesa', 'Tempe']);
    registry.stop();
  });

  it('bumps the revision only when the content changed', async () => {
    const registry = new DataRegistry();
    await registry.upsert('p', manual);
    await registry.upsert('p', manual);
    expect(registry.get('p', manual.id)!.status.revision).toBe(1);
    registry.stop();
  });

  it('keeps last-good data when a refresh fails', async () => {
    /*
     * Rule 1. A source that starts working and then breaks must leave the rows
     * that are on air alone — the error belongs in the status the editor shows,
     * not in the graphic.
     */
    const registry = new DataRegistry();
    await registry.upsert('p', manual);

    await registry.upsert('p', {
      id: manual.id, name: 'Standings', type: 'http-json',
      // A private address: the SSRF guard refuses it without touching the
      // network, so this test makes no request.
      url: 'http://127.0.0.1:1/never.json',
    });
    const entry = await registry.refresh('p', manual.id);

    expect(entry.status.lastError).toMatch(/private address/);
    expect(entry.status.failures).toBe(1);
    expect(entry.data.rows).toEqual([{ team: 'Mesa', w: 11 }]);
    registry.stop();
  });

  it('drops a source that is removed from the project', async () => {
    const registry = new DataRegistry();
    await registry.upsert('p', manual);
    registry.remove('p', manual.id);
    expect(registry.get('p', manual.id)).toBeUndefined();
    registry.stop();
  });

  it('keys its datasets by source id, per project', async () => {
    const registry = new DataRegistry();
    await registry.upsert('p', manual);
    await registry.upsert('other', { ...manual, id: 'elsewhere' });

    expect(Object.keys(registry.datasets('p'))).toEqual(['standings']);
    expect(Object.keys(registry.datasets('other'))).toEqual(['elsewhere']);
    registry.stop();
  });
});
