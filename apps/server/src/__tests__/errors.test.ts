// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The error contract (I18N.md §5.1) and the frozen-response guarantee (§5.2).
 *
 * These two belong together: the contract only buys anything if the response
 * really is the same for every caller, and the guarantee is only worth having
 * because the contract gives a browser another way to get localised prose.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createComposition } from '@breeze/schema';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-errors-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../app.js');
const { fail } = await import('../errors.js');
const { resetServerI18n } = await import('../i18n.js');

let app: FastifyInstance;
let projectId: string;

beforeAll(async () => {
  app = await buildApp({ seed: false });
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'Errors' },
  });
  projectId = (created.json() as { id: string }).id;
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('fail()', () => {
  it('renders the English message from the code it carries', () => {
    // One source of truth: the message is the catalogue entry rendered with the
    // same parameters the client will use, so the two cannot say different
    // things about the same refusal.
    expect(fail('error.compositionInUse', { count: 3 })).toEqual({
      error: 'still used by 3 compositions',
      code: 'error.compositionInUse',
      params: { count: 3 },
    });
  });

  it('moves the plural into the message rather than into a template literal', () => {
    expect(fail('error.compositionInUse', { count: 1 }).error).toBe('still used by 1 composition');
  });

  it('omits params and field when there are none', () => {
    expect(fail('error.forbidden')).toEqual({ error: 'forbidden', code: 'error.forbidden' });
  });

  it('carries a field-level marker when the refusal names one', () => {
    expect(fail('error.forbidden', undefined, 'key').field).toBe('key');
  });

  it('stays English when the server is not', () => {
    /*
     * The whole argument for the contract. `docker logs` has to be greppable
     * in every deployment, and an integrator's `curl` must not change language
     * because somebody set BREEZE_LOCALE.
     */
    try {
      resetServerI18n('en-XA');
      const body = fail('error.compositionInUse', { count: 2 });
      expect(body.error).toBe('still used by 2 compositions');
      expect(body.code).toBe('error.compositionInUse');
    } finally {
      resetServerI18n();
    }
  });
});

describe('the contract on the wire', () => {
  it('refuses a composition delete with a code, params and its English', async () => {
    const bug = createComposition({ id: 'bug', name: 'Bug' });
    const host = createComposition({
      id: 'host',
      name: 'Host',
      layers: [{ id: 'nested', type: 'composition', ref: 'bug' } as never],
    });
    for (const comp of [bug, host]) {
      const put = await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/compositions/${comp.id}`,
        payload: comp,
      });
      expect(put.statusCode, put.body).toBe(200);
    }

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/compositions/bug`,
    });
    expect(res.statusCode).toBe(409);

    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe('error.compositionInUse');
    expect(body['params']).toEqual({ count: 1 });
    // `error` keeps its type and its wording: a caller that predates the
    // contract sees exactly what it saw before.
    expect(body['error']).toBe('still used by 1 composition');
    expect(Array.isArray(body['referrers'])).toBe(true);
  });
});

describe('the frozen-response guarantee (§5.2)', () => {
  /*
   * No route reads `Accept-Language`, ever. With detection gone this is wider
   * than "the frozen routes are frozen" — the header is dead input everywhere,
   * because the localised pages take their language from BREEZE_LOCALE.
   *
   * This is the assertion that has to survive every future refactor: the way
   * this breaks is somebody adding per-request negotiation to one endpoint
   * because it seemed harmless there.
   */
  const LANGS = ['ar', 'de-DE', 'ja,en;q=0.8', '*'];

  const frozen = [
    '/healthz',
    '/api/projects',
    `/api/projects/${'PROJECT'}`,
  ];

  it.each(frozen)('%s is byte-identical under any Accept-Language', async (route) => {
    const url = route.replace('PROJECT', projectId);
    const base = await app.inject({ method: 'GET', url });
    for (const lang of LANGS) {
      const res = await app.inject({ method: 'GET', url, headers: { 'accept-language': lang } });
      expect(res.statusCode, lang).toBe(base.statusCode);
      expect(res.body, lang).toBe(base.body);
    }
  });

  it('returns the same refusal body under any Accept-Language', async () => {
    const url = `/api/projects/${projectId}/compositions/bug`;
    const base = await app.inject({ method: 'DELETE', url });
    for (const lang of LANGS) {
      const res = await app.inject({ method: 'DELETE', url, headers: { 'accept-language': lang } });
      expect(res.body, lang).toBe(base.body);
    }
  });

  it('never reads the header anywhere in the server source', async () => {
    /*
     * Belt and braces, and the half that actually generalises: the tests above
     * can only cover the routes somebody remembered to list, while this covers
     * a route added next year.
     */
    const src = path.resolve(import.meta.dirname, '..');
    const seen: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') await walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const text = await fs.readFile(full, 'utf8');
          // Comments are where the rule is explained, so only code counts.
          const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
          if (/accept-language/i.test(code)) seen.push(path.relative(src, full));
        }
      }
    };
    await walk(src);
    expect(seen).toEqual([]);
  });
});
