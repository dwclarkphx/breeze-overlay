// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Wave 5 in the registry (CYCLE.md): a fetch has to pass its guard to go on
 * air, and a source with nothing fit to show can serve its backup's rows —
 * under its own id, so every table bound to it carries on unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DataSet, DataSourceDef } from '@breeze/schema';

vi.mock('../data/fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/fetch.js')>()),
  fetchText: vi.fn(),
}));

import { fetchText } from '../data/fetch.js';
import { DataRegistry } from '../data/registry.js';

const fetchMock = vi.mocked(fetchText);

/** Answer fetches from a URL → body map; anything else is a network failure. */
function serve(routes: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (url: string) => {
    if (url in routes) return { body: JSON.stringify(routes[url]), status: 200 };
    throw new Error(`fetch failed: ${url}`);
  });
}

const OBS_URL = 'https://feed.example/obs.json';
const SPARE_URL = 'https://spare.example/obs.json';
const CITIES = [
  { place: 'Phoenix', temp: 104 },
  { place: 'Tucson', temp: 99 },
  { place: 'Flagstaff', temp: 71 },
  { place: 'Yuma', temp: 108 },
];

const obs = (extra: Partial<Extract<DataSourceDef, { type: 'http-json' }>> = {}): DataSourceDef => ({
  id: 'obs', name: 'Observations', type: 'http-json', url: OBS_URL, ...extra,
});
const spare = (extra: Partial<Extract<DataSourceDef, { type: 'http-json' }>> = {}): DataSourceDef => ({
  id: 'spare', name: 'Spare feed', type: 'http-json', url: SPARE_URL, ...extra,
});
const canned: DataSourceDef = {
  id: 'canned', name: 'Unavailable', type: 'manual',
  columns: [{ key: 'place', type: 'string' }], rows: [{ place: 'Temporarily unavailable' }],
};

const places = (data: DataSet) => data.rows.map((r) => r['place']);

let registry: DataRegistry;
let pushes: DataSet[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
  registry = new DataRegistry();
  // Stopped first: no background ticks racing the refreshes below. `stop`
  // drops listeners, so the push recorder is attached after it.
  registry.stop();
  pushes = [];
  registry.onPush((_project, data) => pushes.push(data));
});

afterEach(() => {
  fetchMock.mockReset();
  vi.useRealTimers();
});

const at = (iso: string) => vi.setSystemTime(new Date(iso));

describe('the guard', () => {
  it('refuses a bad fetch like a failed one — last-good stays, the status says why', async () => {
    await registry.upsert('p', obs({ guard: { ranges: [{ column: 'temp', max: 130 }] } }));
    serve({ [OBS_URL]: CITIES });
    let entry = await registry.refresh('p', 'obs');
    expect(entry.data.rows).toHaveLength(4);

    serve({ [OBS_URL]: [...CITIES, { place: 'Sensor fault', temp: 212 }] });
    entry = await registry.refresh('p', 'obs');
    expect(entry.status.failures).toBe(1);
    expect(entry.status.lastError).toBe('refused by guard: row 5: "temp" is 212, above the maximum of 130');
    expect(places(entry.data)).toEqual(['Phoenix', 'Tucson', 'Flagstaff', 'Yuma']);
  });

  it('drops bad rows when told to, and says so', async () => {
    await registry.upsert('p', obs({ guard: { required: ['place'], badRows: 'drop' } }));
    serve({ [OBS_URL]: [...CITIES, { place: '', temp: 90 }] });
    const entry = await registry.refresh('p', 'obs');
    expect(entry.data.rows).toHaveLength(4);
    expect(entry.status.dropped).toBe(1);
    expect(entry.status.warning).toBe('the guard dropped 1 row');
    expect(entry.status.lastError).toBeUndefined();
  });

  it('believes a refused drop once it has held for three fetches', async () => {
    await registry.upsert('p', obs({ guard: { maxDropPercent: 50 } }));
    serve({ [OBS_URL]: CITIES });
    await registry.refresh('p', 'obs');

    serve({ [OBS_URL]: CITIES.slice(0, 1) });
    let entry = await registry.refresh('p', 'obs');
    expect(entry.status.lastError).toMatch(/fell from 4 to 1 .*\(1 of 3/);
    entry = await registry.refresh('p', 'obs');
    expect(entry.status.lastError).toMatch(/\(2 of 3/);
    expect(entry.data.rows).toHaveLength(4);

    entry = await registry.refresh('p', 'obs');
    expect(entry.status.lastError).toBeUndefined();
    expect(entry.status.warning).toMatch(/accepted a drop/);
    expect(places(entry.data)).toEqual(['Phoenix']);
  });

  it('starts counting again when the size it fell to changes', async () => {
    await registry.upsert('p', obs({ guard: { maxDropPercent: 40 } }));
    serve({ [OBS_URL]: CITIES });
    await registry.refresh('p', 'obs');
    serve({ [OBS_URL]: CITIES.slice(0, 1) });
    await registry.refresh('p', 'obs');
    await registry.refresh('p', 'obs');
    serve({ [OBS_URL]: CITIES.slice(0, 2) });
    const entry = await registry.refresh('p', 'obs');
    expect(entry.status.lastError).toMatch(/\(1 of 3/);
  });

  it('treats frozen content as expired — blank without a backup', async () => {
    await registry.upsert('p', obs({ guard: { maxUnchanged: 3600 } }));
    serve({ [OBS_URL]: CITIES });
    let entry = await registry.refresh('p', 'obs');
    at('2026-09-27T12:59:00Z');
    entry = await registry.refresh('p', 'obs');
    expect(entry.status.stuck).toBeUndefined();
    expect(entry.data.rows).toHaveLength(4);

    at('2026-09-27T13:01:00Z');
    entry = await registry.refresh('p', 'obs');
    expect(entry.status.stuck).toBe(true);
    expect(entry.data.rows).toEqual([]);
    expect(entry.data.columns.map((c) => c.key)).toEqual(['place', 'temp']);

    serve({ [OBS_URL]: CITIES.slice(0, 2) });
    entry = await registry.refresh('p', 'obs');
    expect(entry.status.stuck).toBeUndefined();
    expect(entry.data.rows).toHaveLength(2);
  });
});

describe('backups', () => {
  it('serves the backup under its own id once its data expires, and comes back', async () => {
    await registry.upsert('p', canned);
    await registry.upsert('p', obs({ expireAfter: 3600, fallback: 'canned' }));
    serve({ [OBS_URL]: CITIES });
    let entry = await registry.refresh('p', 'obs');
    expect(entry.status.serving).toBeUndefined();

    serve({});
    at('2026-09-27T12:30:00Z');
    entry = await registry.refresh('p', 'obs');
    // Failing but inside its limit: its own last-good stays.
    expect(entry.data.rows).toHaveLength(4);

    at('2026-09-27T13:01:00Z');
    entry = await registry.refresh('p', 'obs');
    expect(entry.status.expired).toBe(true);
    expect(entry.status.serving).toBe('canned');
    expect(entry.data.id).toBe('obs');
    expect(places(entry.data)).toEqual(['Temporarily unavailable']);
    expect(pushes.at(-1)).toMatchObject({ id: 'obs', rows: [{ place: 'Temporarily unavailable' }] });

    serve({ [OBS_URL]: CITIES });
    entry = await registry.refresh('p', 'obs');
    expect(entry.status.serving).toBeUndefined();
    expect(entry.data.rows).toHaveLength(4);
  });

  it('switches at the first failure with fallbackOn: failing', async () => {
    await registry.upsert('p', spare());
    await registry.upsert('p', obs({ fallback: 'spare', fallbackOn: 'failing' }));
    serve({ [OBS_URL]: CITIES, [SPARE_URL]: CITIES.slice(0, 2) });
    await registry.refresh('p', 'spare');
    await registry.refresh('p', 'obs');

    serve({ [SPARE_URL]: CITIES.slice(0, 2) });
    let entry = await registry.refresh('p', 'obs');
    expect(entry.status.serving).toBe('spare');
    expect(places(entry.data)).toEqual(['Phoenix', 'Tucson']);

    serve({ [OBS_URL]: CITIES, [SPARE_URL]: CITIES.slice(0, 2) });
    entry = await registry.refresh('p', 'obs');
    expect(entry.status.serving).toBeUndefined();
    expect(entry.data.rows).toHaveLength(4);
  });

  it('switches on a guard refusal too', async () => {
    await registry.upsert('p', canned);
    await registry.upsert('p', obs({ guard: { minRows: 3 }, fallback: 'canned', fallbackOn: 'failing' }));
    serve({ [OBS_URL]: CITIES });
    await registry.refresh('p', 'obs');
    serve({ [OBS_URL]: CITIES.slice(0, 1) });
    const entry = await registry.refresh('p', 'obs');
    expect(entry.status.serving).toBe('canned');
  });

  it('keeps its own stale rows when the backup has nothing fit to show either', async () => {
    await registry.upsert('p', spare());
    await registry.upsert('p', obs({ fallback: 'spare', fallbackOn: 'failing' }));
    serve({ [OBS_URL]: CITIES });
    await registry.refresh('p', 'obs');
    serve({});
    await registry.refresh('p', 'spare');
    const entry = await registry.refresh('p', 'obs');
    expect(entry.status.serving).toBeUndefined();
    expect(entry.data.rows).toHaveLength(4);
  });

  it('serves the backup for a source that never loaded, once a fetch has failed — not before', async () => {
    await registry.upsert('p', canned);
    await registry.upsert('p', obs({ fallback: 'canned' }));
    // Registered, not yet tried: nothing is pushed and the backup does not flash up.
    expect(pushes.filter((d) => d.id === 'obs')).toEqual([]);
    expect(registry.get('p', 'obs')!.status.serving).toBeUndefined();

    serve({});
    const entry = await registry.refresh('p', 'obs');
    expect(entry.status.serving).toBe('canned');
    expect(places(entry.data)).toEqual(['Temporarily unavailable']);
  });

  it('follows a chain of backups', async () => {
    await registry.upsert('p', canned);
    await registry.upsert('p', spare({ fallback: 'canned', fallbackOn: 'failing' }));
    await registry.upsert('p', obs({ fallback: 'spare', fallbackOn: 'failing' }));
    serve({});
    await registry.refresh('p', 'spare');
    const entry = await registry.refresh('p', 'obs');
    expect(entry.status.serving).toBe('canned');
    expect(places(entry.data)).toEqual(['Temporarily unavailable']);
  });

  it('passes a change to the backup straight through to the source it is serving', async () => {
    await registry.upsert('p', canned);
    await registry.upsert('p', obs({ fallback: 'canned' }));
    serve({});
    await registry.refresh('p', 'obs');
    await registry.upsert('p', { ...canned, rows: [{ place: 'Back shortly' }] } as DataSourceDef);
    expect(places(registry.get('p', 'obs')!.data)).toEqual(['Back shortly']);
    expect(pushes.at(-1)).toMatchObject({ id: 'obs', rows: [{ place: 'Back shortly' }] });
  });

  it('lets go of a backup that is removed', async () => {
    await registry.upsert('p', canned);
    await registry.upsert('p', obs({ fallback: 'canned' }));
    serve({});
    await registry.refresh('p', 'obs');
    registry.remove('p', 'canned');
    expect(registry.get('p', 'obs')!.status.serving).toBeUndefined();
    expect(registry.get('p', 'obs')!.data.rows).toEqual([]);
  });
});

describe('an operator’s choice', () => {
  it('puts the backup on air on demand, and hands back to the rules on auto', async () => {
    await registry.upsert('p', canned);
    await registry.upsert('p', obs({ fallback: 'canned' }));
    serve({ [OBS_URL]: CITIES });
    await registry.refresh('p', 'obs');

    let entry = registry.setUse('p', 'obs', 'backup');
    expect(entry.status).toMatchObject({ use: 'backup', serving: 'canned' });
    expect(places(entry.data)).toEqual(['Temporarily unavailable']);
    // A successful fetch does not undo it.
    entry = await registry.refresh('p', 'obs');
    expect(entry.status.serving).toBe('canned');

    entry = registry.setUse('p', 'obs', 'auto');
    expect(entry.status.use).toBeUndefined();
    expect(entry.status.serving).toBeUndefined();
    expect(entry.data.rows).toHaveLength(4);
  });

  it('keeps the own rows on primary even when they have expired', async () => {
    await registry.upsert('p', canned);
    await registry.upsert('p', obs({ expireAfter: 3600, fallback: 'canned' }));
    serve({ [OBS_URL]: CITIES });
    await registry.refresh('p', 'obs');
    registry.setUse('p', 'obs', 'primary');
    serve({});
    at('2026-09-27T13:01:00Z');
    const entry = await registry.refresh('p', 'obs');
    expect(entry.status.serving).toBeUndefined();
    // Expired is still expired — primary means "not the backup", not "stale forever".
    expect(entry.data.rows).toEqual([]);
  });

  it('survives an edit of the source, and is dropped when the backup is', async () => {
    await registry.upsert('p', canned);
    await registry.upsert('p', obs({ fallback: 'canned' }));
    registry.setUse('p', 'obs', 'backup');
    let entry = await registry.upsert('p', obs({ fallback: 'canned', name: 'Renamed' }));
    expect(entry.status.use).toBe('backup');
    entry = await registry.upsert('p', obs());
    expect(entry.status.use).toBeUndefined();
  });
});

describe('review fixes', () => {
  it('believes a drop that holds in size even when its values keep changing', async () => {
    await registry.upsert('p', obs({ guard: { maxDropPercent: 50 } }));
    serve({ [OBS_URL]: CITIES });
    await registry.refresh('p', 'obs');
    let entry = registry.get('p', 'obs')!;
    for (const temp of [100, 101, 102]) {
      serve({ [OBS_URL]: [{ place: 'Phoenix', temp }] });
      entry = await registry.refresh('p', 'obs');
    }
    expect(entry.status.lastError).toBeUndefined();
    expect(entry.data.rows).toEqual([{ place: 'Phoenix', temp: 102 }]);
  });

  it('lets an operator keep a source on air that the guard thinks is frozen', async () => {
    await registry.upsert('p', canned);
    await registry.upsert('p', obs({ guard: { maxUnchanged: 3600 }, fallback: 'canned' }));
    serve({ [OBS_URL]: CITIES });
    await registry.refresh('p', 'obs');
    at('2026-09-27T13:01:00Z');
    let entry = await registry.refresh('p', 'obs');
    expect(entry.status.serving).toBe('canned');
    entry = registry.setUse('p', 'obs', 'primary');
    expect(entry.status.serving).toBeUndefined();
    expect(entry.data.rows).toHaveLength(4);
  });

  it('does not put a backup on air whose own data has run out, even if it is not fetching', async () => {
    await registry.upsert('p', spare({ expireAfter: 3600, enabled: false }));
    await registry.upsert('p', obs({ fallback: 'spare', fallbackOn: 'failing' }));
    serve({ [SPARE_URL]: CITIES.slice(0, 1), [OBS_URL]: CITIES });
    await registry.refresh('p', 'spare');
    await registry.refresh('p', 'obs');
    at('2026-09-27T14:00:00Z');
    serve({});
    const entry = await registry.refresh('p', 'obs');
    // The spare's hour is up, so the primary's own stale rows stay instead.
    expect(entry.status.serving).toBeUndefined();
    expect(entry.data.rows).toHaveLength(4);
  });

  it('keeps re-reading the last accepted CAP body — not one the guard refused', async () => {
    const CAP_URL = 'https://api.weather.gov/alerts/active?area=AZ';
    const alert = (id: string, extra: Record<string, unknown>) => ({
      id,
      properties: {
        id, status: 'Actual', messageType: 'Alert', event: 'Tornado Warning', severity: 'Extreme',
        areaDesc: 'Maricopa, AZ', effective: '2026-09-27T04:00:00-07:00', expires: '2026-09-27T05:30:00-07:00',
        headline: 'Tornado Warning issued', description: 'Take cover.', instruction: null, ...extra,
      },
    });
    await registry.upsert('p', {
      id: 'alerts', name: 'Alerts', type: 'cap', url: CAP_URL, guard: { required: ['headline'] },
    } as DataSourceDef);
    serve({ [CAP_URL]: { features: [alert('a', {})] } });
    let entry = await registry.refresh('p', 'alerts');
    expect(entry.data.rows).toHaveLength(1);

    // Refused from now on: a second alert with no headline. The first still ends on time.
    serve({ [CAP_URL]: { features: [alert('a', {}), alert('b', { headline: '', expires: '2026-09-27T09:00:00-07:00' })] } });
    at('2026-09-27T12:40:00Z'); // 05:40 MST — past the first alert's end
    entry = await registry.refresh('p', 'alerts');
    expect(entry.status.lastError).toMatch(/refused by guard/);
    expect(entry.data.rows).toEqual([]);
  });
});
