// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Server-level sources and the links to them (0.80.0), at the registry.
 *
 * Rule 6 in `registry.ts`: a server-level source is fetched once however many
 * projects show it, and a project's link is an entry that adopts what that
 * source has on air. These tests hold the two halves of that — one fetch, and
 * everything downstream of an entry working on a link without knowing it is
 * one: the push to the project, a backup, the health an operator reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SERVER_SCOPE, type DataSet, type DataSourceDef } from '@breeze/schema';

vi.mock('../data/fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/fetch.js')>()),
  fetchText: vi.fn(),
}));

import { fetchText } from '../data/fetch.js';
import { DataRegistry } from '../data/registry.js';

const fetchMock = vi.mocked(fetchText);

const URL = 'https://feed.example/scores.json';
let rows: Array<Record<string, unknown>> | Error;

const feed: DataSourceDef = { id: 'scores', name: 'Scores', type: 'http-json', url: URL };
const link = (extra: Partial<Extract<DataSourceDef, { type: 'link' }>> = {}): DataSourceDef => ({
  id: 'scores',
  name: 'Scores',
  type: 'link',
  source: 'scores',
  ...extra,
});
const canned: DataSourceDef = {
  id: 'canned',
  name: 'Unavailable',
  type: 'manual',
  columns: [{ key: 'team', type: 'string' }],
  rows: [{ team: 'Scores are temporarily unavailable' }],
};

const teams = (data: DataSet | undefined) => (data?.rows ?? []).map((r) => r['team']);

let registry: DataRegistry;
let pushes: Array<{ project: string; data: DataSet }>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
  rows = [{ team: 'Mesa', score: 3 }];
  fetchMock.mockImplementation(async (url: string) => {
    if (url !== URL) throw new Error(`fetch failed: ${url}`);
    if (rows instanceof Error) throw rows;
    return { body: JSON.stringify(rows), status: 200 };
  });
  registry = new DataRegistry();
  // Stopped: no background ticks racing the refreshes below. `stop` drops
  // listeners, so the recorder goes on after it.
  registry.stop();
  pushes = [];
  registry.onPush((project, data) => pushes.push({ project, data }));
});

afterEach(() => {
  fetchMock.mockReset();
  vi.useRealTimers();
});

describe('a link to a server-level source', () => {
  it('shows the server source\'s rows in every linked project from one fetch', async () => {
    await registry.upsert(SERVER_SCOPE, feed);
    await registry.upsert('news', link());
    await registry.upsert('sport', link({ id: 'live-scores' }));

    await registry.refresh(SERVER_SCOPE, 'scores');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(teams(registry.get('news', 'scores')?.data)).toEqual(['Mesa']);
    expect(teams(registry.get('sport', 'live-scores')?.data)).toEqual(['Mesa']);
    // Each project is pushed its rows under its own id for them — the id its layers bind.
    expect(pushes.filter((p) => p.project === 'news').map((p) => p.data.id)).toEqual(['scores']);
    expect(pushes.filter((p) => p.project === 'sport').map((p) => p.data.id)).toEqual(['live-scores']);
  });

  it('adopts what the server source already has when it is linked later', async () => {
    await registry.upsert(SERVER_SCOPE, feed);
    await registry.refresh(SERVER_SCOPE, 'scores');

    const entry = await registry.upsert('late', link());

    expect(teams(entry.data)).toEqual(['Mesa']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pushes a project nothing when the content has not changed', async () => {
    await registry.upsert(SERVER_SCOPE, feed);
    await registry.upsert('news', link());
    await registry.refresh(SERVER_SCOPE, 'scores');
    const before = pushes.length;

    await registry.refresh(SERVER_SCOPE, 'scores');

    expect(pushes.length).toBe(before);
    expect(registry.get('news', 'scores')?.status.revision).toBe(1);
  });

  it('refreshing the link refreshes the server source, once', async () => {
    await registry.upsert(SERVER_SCOPE, feed);
    await registry.upsert('news', link());
    rows = [{ team: 'Tempe', score: 1 }];

    const entry = await registry.refresh('news', 'scores');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(teams(entry.data)).toEqual(['Tempe']);
    expect(teams(registry.get(SERVER_SCOPE, 'scores')?.data)).toEqual(['Tempe']);
  });

  it('carries the server source\'s health, and keeps last-good rows through a failure', async () => {
    await registry.upsert(SERVER_SCOPE, feed);
    await registry.upsert('news', link());
    await registry.refresh(SERVER_SCOPE, 'scores');

    rows = new Error('origin is down');
    await registry.refresh(SERVER_SCOPE, 'scores');

    const status = registry.get('news', 'scores')!.status;
    expect(status.failures).toBe(1);
    expect(status.lastError).toMatch(/origin is down/);
    expect(status.lastSuccess).toBe('2026-11-09T12:00:00.000Z');
    // Rule 1, through a link: a dead feed never blanks a graphic.
    expect(teams(registry.get('news', 'scores')?.data)).toEqual(['Mesa']);

    rows = [{ team: 'Mesa', score: 4 }];
    await registry.refresh(SERVER_SCOPE, 'scores');
    expect(registry.get('news', 'scores')!.status.failures).toBe(0);
    expect(registry.get('news', 'scores')!.status.lastError).toBeUndefined();
  });

  it('puts the project\'s own backup on air when the server source has nothing fit to show', async () => {
    await registry.upsert(SERVER_SCOPE, { ...feed, expireAfter: 60 } as DataSourceDef);
    await registry.upsert('news', canned);
    await registry.upsert('news', link({ fallback: 'canned' }));
    await registry.upsert('sport', link());
    await registry.refresh(SERVER_SCOPE, 'scores');
    expect(teams(registry.get('news', 'scores')?.data)).toEqual(['Mesa']);

    // The feed goes down and its rows run out.
    rows = new Error('origin is down');
    vi.setSystemTime(new Date('2026-11-09T12:05:00Z'));
    await registry.refresh(SERVER_SCOPE, 'scores');

    expect(registry.get(SERVER_SCOPE, 'scores')!.status.expired).toBe(true);
    // The project with a backup shows it; the one without shows blank, as the server source does.
    expect(teams(registry.get('news', 'scores')?.data)).toEqual(['Scores are temporarily unavailable']);
    expect(registry.get('news', 'scores')!.status.serving).toBe('canned');
    expect(teams(registry.get('sport', 'scores')?.data)).toEqual([]);

    // And back to the feed when it returns.
    rows = [{ team: 'Mesa', score: 5 }];
    await registry.refresh(SERVER_SCOPE, 'scores');
    expect(teams(registry.get('news', 'scores')?.data)).toEqual(['Mesa']);
    expect(registry.get('news', 'scores')!.status.serving).toBeUndefined();
  });

  it('says so when the server source is not there, and keeps what it had', async () => {
    await registry.upsert(SERVER_SCOPE, feed);
    await registry.upsert('news', link());
    await registry.refresh(SERVER_SCOPE, 'scores');

    registry.remove(SERVER_SCOPE, 'scores');

    const entry = registry.get('news', 'scores')!;
    expect(entry.status.lastError).toMatch(/server-level data source "scores" is not on this server/);
    expect(teams(entry.data)).toEqual(['Mesa']);
  });

  it('never fetches for itself', async () => {
    await registry.upsert('news', link());
    await registry.refresh('news', 'scores');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('what the registry knows about links', () => {
  it('lists the projects linked to a server source, and forgets a deleted project', async () => {
    await registry.upsert(SERVER_SCOPE, feed);
    await registry.upsert('news', link());
    await registry.upsert('sport', link({ id: 'live-scores', name: 'Live scores' }));

    expect(registry.linksTo('scores')).toEqual([
      { projectId: 'news', id: 'scores', name: 'Scores' },
      { projectId: 'sport', id: 'live-scores', name: 'Live scores' },
    ]);

    registry.unregister('news');

    expect(registry.linksTo('scores').map((l) => l.projectId)).toEqual(['sport']);
    expect(registry.get('news', 'scores')).toBeUndefined();
    // The server source is nobody's to take with them.
    expect(registry.get(SERVER_SCOPE, 'scores')).toBeDefined();
  });
});

describe('a refresh on request', () => {
  const weather: DataSourceDef = {
    id: 'wx',
    name: 'Weather',
    type: 'weather',
    provider: 'nws',
    latitude: 33.45,
    longitude: -112.07,
  };

  it('may fetch at once the first time, then waits out the source\'s poll floor', async () => {
    await registry.upsert(SERVER_SCOPE, feed);
    expect(registry.refreshDueIn(SERVER_SCOPE, 'scores')).toBe(0);

    await registry.refresh(SERVER_SCOPE, 'scores');
    // MIN_POLL_INTERVAL: five seconds for an ordinary feed.
    expect(registry.refreshDueIn(SERVER_SCOPE, 'scores')).toBe(5000);

    vi.setSystemTime(new Date('2026-11-09T12:00:03Z'));
    expect(registry.refreshDueIn(SERVER_SCOPE, 'scores')).toBe(2000);
    vi.setSystemTime(new Date('2026-11-09T12:00:05Z'));
    expect(registry.refreshDueIn(SERVER_SCOPE, 'scores')).toBe(0);
  });

  it('counts a failed fetch too — a failing feed is not a reason to ask it more often', async () => {
    await registry.upsert(SERVER_SCOPE, feed);
    rows = new Error('origin is down');
    await registry.refresh(SERVER_SCOPE, 'scores');
    expect(registry.refreshDueIn(SERVER_SCOPE, 'scores')).toBe(5000);
  });

  it('holds a link to its server source\'s floor', async () => {
    await registry.upsert(SERVER_SCOPE, feed);
    await registry.upsert('news', link());
    await registry.refresh(SERVER_SCOPE, 'scores');
    expect(registry.refreshDueIn('news', 'scores')).toBe(5000);
  });

  it('uses the provider\'s own floor for weather', async () => {
    const entry = await registry.upsert(SERVER_SCOPE, weather);
    entry.status.lastFetch = '2026-11-09T12:00:00.000Z';
    // Far more than an ordinary feed's five seconds: the provider's limit, not ours.
    expect(registry.refreshDueIn(SERVER_SCOPE, 'wx')).toBeGreaterThan(5000);
  });

  it('never holds a typed-in table', async () => {
    await registry.upsert('news', canned);
    expect(registry.refreshDueIn('news', 'canned')).toBe(0);
  });
});
