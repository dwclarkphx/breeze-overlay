// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The API client's request shaping.
 *
 * Written after every `DELETE` in the editor turned out to be broken in the
 * browser while passing its server-side tests. The helper set
 * `content-type: application/json` on every request including bodyless ones,
 * and Fastify rightly refuses a request that promises JSON and sends none.
 * `app.inject` sets no content-type unless given a payload, so the server suite
 * had been exercising a request the editor never actually makes.
 *
 * The lesson generalises past this bug: a test that constructs the request
 * itself cannot catch a client that constructs it differently. These assert the
 * headers the editor really sends.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api/client.js';

interface Captured {
  url: string;
  init: RequestInit;
}

function stubFetch(status = 200, body: unknown = {}): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      json: () => Promise.resolve(body),
    } as Response);
  });
  return calls;
}

const headersOf = (init: RequestInit): Record<string, string> =>
  Object.fromEntries(
    Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bodyless requests', () => {
  it('sends no content-type on DELETE', async () => {
    // The bug, exactly: Fastify answers 400 "Body cannot be empty when
    // content-type is set to 'application/json'".
    const calls = stubFetch(204);
    await api.deleteProject('demo');
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(headersOf(calls[0]!.init)['content-type']).toBeUndefined();
  });

  it('sends no content-type on GET', async () => {
    const calls = stubFetch(200, { projects: [] });
    await api.listProjects();
    expect(headersOf(calls[0]!.init)['content-type']).toBeUndefined();
  });
});

describe('requests carrying a body', () => {
  it('still declares JSON', async () => {
    // The other half. Dropping the header everywhere would break every write.
    const calls = stubFetch(200, { id: 'x' });
    await api.createProject('New');
    expect(headersOf(calls[0]!.init)['content-type']).toBe('application/json');
    expect(calls[0]!.init.body).toBeTruthy();
  });

  it('declares JSON on a PUT too', async () => {
    // `saveProject` PUTs the whole document; it is the write that matters most.
    const calls = stubFetch(200, { id: 'demo' });
    await api.saveProject({ id: 'demo' } as never);
    expect(calls[0]!.init.method).toBe('PUT');
    expect(headersOf(calls[0]!.init)['content-type']).toBe('application/json');
  });
});
