// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Google Sheets API v4 adapter.
 *
 * The signing half is tested against a real generated RSA key and verified with
 * `node:crypto` rather than compared to a golden string — a hand-written
 * expected JWT would only prove that the test author and the implementation
 * made the same base64 mistake. The reading half is tested against captured
 * `values.get` response shapes, including the ragged one Sheets actually
 * returns.
 */

import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../config.js';
import {
  SheetsAuthError,
  buildJwtAssertion,
  clearTokenCache,
  getAccessToken,
  parseServiceAccount,
  resolveSheetsCredential,
  sheetsToDataSet,
  spreadsheetId,
} from '../data/sheets.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const KEY = { client_email: 'breeze@project.iam.gserviceaccount.com', private_key: PEM };

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
}

/* --------------------------------------------------------- spreadsheet id */

describe('spreadsheetId', () => {
  it('takes the id out of a browser URL', () => {
    // Nobody has the bare id to hand; they have the address bar.
    expect(
      spreadsheetId('https://docs.google.com/spreadsheets/d/1AbC-dEf_23/edit#gid=0'),
    ).toBe('1AbC-dEf_23');
  });

  it('accepts a bare id unchanged', () => {
    expect(spreadsheetId('1AbC-dEf_23')).toBe('1AbC-dEf_23');
  });

  it('drops a trailing fragment from a bare id', () => {
    expect(spreadsheetId('1AbC-dEf_23#gid=7')).toBe('1AbC-dEf_23');
  });
});

/* ------------------------------------------------------- service account */

describe('parseServiceAccount', () => {
  it('reads the downloaded JSON verbatim', () => {
    const key = parseServiceAccount(JSON.stringify(KEY));
    expect(key.client_email).toBe(KEY.client_email);
    expect(key.private_key).toContain('BEGIN PRIVATE KEY');
  });

  it('repairs escaped newlines from an environment variable', () => {
    /*
     * The one transformation that matters. A key round-tripped through a .env
     * file or a Compose `environment:` block arrives with literal backslash-n,
     * and OpenSSL rejects it with an error mentioning neither newlines nor the
     * env var it came from.
     */
    const flattened = JSON.stringify({ ...KEY, private_key: PEM.replace(/\n/g, '\\n') });
    expect(parseServiceAccount(flattened).private_key).toBe(PEM);
  });

  it('names the missing field rather than failing at signing time', () => {
    expect(() => parseServiceAccount('{"client_email":"a@b.test"}')).toThrow(/private_key/);
    expect(() => parseServiceAccount('not json')).toThrow(/valid JSON/);
  });
});

describe('buildJwtAssertion', () => {
  const now = Date.parse('2026-08-02T12:00:00Z');

  it('produces a signature the public key verifies', () => {
    const jwt = buildJwtAssertion(KEY, now);
    const [header, claims, signature] = jwt.split('.');

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${claims}`);
    verifier.end();
    const ok = verifier.verify(
      publicKey,
      Buffer.from(signature!.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    );
    expect(ok).toBe(true);
  });

  it('declares RS256 and the read-only scope', () => {
    const [header, claims] = buildJwtAssertion(KEY, now).split('.');
    expect(decodeSegment(header!)).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(decodeSegment(claims!)).toMatchObject({
      iss: KEY.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    });
  });

  it('backdates iat so a fast clock cannot invalidate the token', () => {
    /*
     * Venue machines are often not running NTP. A token whose iat is one second
     * in the future is rejected outright, with an error that reads like a bad
     * key — the most annoying possible failure at 19:55.
     */
    const claims = decodeSegment(buildJwtAssertion(KEY, now).split('.')[1]!);
    expect(claims.iat).toBe(Math.floor(now / 1000) - 60);
    expect(claims.exp).toBe((claims.iat as number) + 3600);
  });

  it('reports an unusable private key as such', () => {
    expect(() =>
      buildJwtAssertion({ client_email: 'a@b.test', private_key: 'nonsense' }, now),
    ).toThrow(SheetsAuthError);
  });
});

/* ----------------------------------------------------------- token cache */

describe('getAccessToken', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearTokenCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const ok = (token: string, expiresIn = 3600) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ access_token: token, expires_in: expiresIn }),
  });

  it('exchanges the assertion for a token', async () => {
    fetchMock.mockResolvedValue(ok('tok-1'));
    expect(await getAccessToken(KEY)).toBe('tok-1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(String((init as RequestInit).body)).toContain('grant_type=urn%3Aietf');
  });

  it('caches, so a 10s poll does not mint a token every 10s', () => {
    // Google rate-limits token minting far more tightly than reads, so this is
    // a correctness property rather than an optimization.
    fetchMock.mockResolvedValue(ok('tok-1'));
    const now = Date.now();
    return getAccessToken(KEY, now)
      .then(() => getAccessToken(KEY, now + 10_000))
      .then((second) => {
        expect(second).toBe('tok-1');
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
  });

  it('re-mints once the cached token is inside its last minute', async () => {
    fetchMock.mockResolvedValueOnce(ok('tok-1', 120)).mockResolvedValueOnce(ok('tok-2', 120));
    const now = Date.now();
    await getAccessToken(KEY, now);
    // 90s in: 30s of life left, inside the 60s margin, so it must not be reused
    // — a poll that starts just under the wire would finish just over it.
    expect(await getAccessToken(KEY, now + 90_000)).toBe('tok-2');
  });

  it('surfaces Google’s own error text', async () => {
    // "invalid_grant" means the clock is off; "unauthorized_client" means the
    // sheet was never shared. Both are actionable, and both are in the body.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant"}',
    });
    await expect(getAccessToken(KEY)).rejects.toThrow(/invalid_grant/);
  });
});

/* -------------------------------------------------------------- reading */

/*
 * `fetchText` is mocked rather than the global `fetch` for these.
 *
 * The real one runs the SSRF guard, which resolves the hostname before it will
 * make a request — so a unit test of the *mapping* would need working DNS to
 * pass, and would fail on an offline build machine for a reason that has
 * nothing to do with the code under test. Mocking one layer up also puts the
 * assertions where they belong: on the URL this adapter constructs.
 */
vi.mock('../data/fetch.js', () => ({ fetchText: vi.fn() }));
const { fetchText } = await import('../data/fetch.js');
const fetchTextMock = vi.mocked(fetchText);

describe('sheetsToDataSet', () => {
  const fetchMock = vi.fn();

  const values = (rows: string[][]) => ({
    body: JSON.stringify({ range: 'A1:C3', majorDimension: 'ROWS', values: rows }),
    status: 200,
  });

  beforeEach(() => {
    clearTokenCache();
    fetchMock.mockReset();
    fetchTextMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('maps a values grid to columns and rows', async () => {
    fetchTextMock.mockResolvedValue(
      values([
        ['Team', 'W', 'L'],
        ['Mesa', '11', '2'],
        ['Tempe', '9', '4'],
      ]),
    );

    const data = await sheetsToDataSet('standings', 'sheet-id', { apiKey: 'k' });
    expect(data.columns.map((c) => c.key)).toEqual(['team', 'w', 'l']);
    expect(data.columns[1]!.type).toBe('number');
    expect(data.rows).toEqual([
      { team: 'Mesa', w: 11, l: 2 },
      { team: 'Tempe', w: 9, l: 4 },
    ]);
  });

  it('pads the ragged rows Sheets actually returns', async () => {
    /*
     * Sheets truncates trailing empty cells per row, so a row whose last column
     * is blank comes back short. Unpadded, the positional column mapping is
     * still fine — but only by luck of the header being widest, and a sheet
     * whose last column has no title breaks that.
     */
    fetchTextMock.mockResolvedValue(
      values([
        ['Team', 'W', 'Note'],
        ['Mesa', '11'],
        ['Tempe', '9', 'clinched'],
      ]),
    );

    const data = await sheetsToDataSet('standings', 'sheet-id', { apiKey: 'k' });
    expect(data.rows[0]).toEqual({ team: 'Mesa', w: 11, note: '' });
    expect(data.rows[1]!.note).toBe('clinched');
  });

  it('sends the API key in the query and no bearer token', async () => {
    fetchTextMock.mockResolvedValue(values([['A'], ['1']]));
    await sheetsToDataSet('x', 'sheet-id', { apiKey: 'secret-key' });

    const [url, opts] = fetchTextMock.mock.calls[0]!;
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://sheets.googleapis.com');
    expect(parsed.searchParams.get('key')).toBe('secret-key');
    expect(parsed.searchParams.get('majorDimension')).toBe('ROWS');
    expect(opts?.bearerToken).toBeUndefined();
  });

  it('uses A1 notation verbatim, encoded', async () => {
    fetchTextMock.mockResolvedValue(values([['A'], ['1']]));
    await sheetsToDataSet('x', 'sheet-id', { apiKey: 'k', range: 'Standings!A1:F30' });
    expect(fetchTextMock.mock.calls[0]![0]).toContain('Standings!A1%3AF30');
  });

  it('refuses to fetch with no credential at all', async () => {
    // Better here than as a 403 from Google that reads like a sharing problem.
    await expect(sheetsToDataSet('x', 'sheet-id')).rejects.toThrow(/needs a credential/);
    expect(fetchTextMock).not.toHaveBeenCalled();
  });

  it('signs in and sends a bearer token for a service account', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'tok', expires_in: 3600 }),
    });
    fetchTextMock.mockResolvedValue(values([['A'], ['1']]));

    await sheetsToDataSet('x', 'sheet-id', {
      serviceAccount: parseServiceAccount(JSON.stringify(KEY)),
    });

    const [url, opts] = fetchTextMock.mock.calls[0]!;
    expect(opts?.bearerToken).toBe('tok');
    // A service-account read must not also put a key in the URL.
    expect(new URL(url).searchParams.get('key')).toBeNull();

    /*
     * And the token exchange must NOT have gone through the guarded fetcher.
     * That function's job is vetting operator-supplied URLs; routing a
     * credential exchange through it would mean an operator who allowlists a
     * host could redirect it.
     */
    expect(fetchMock.mock.calls[0]![0]).toBe('https://oauth2.googleapis.com/token');
  });
});

/* ------------------------------------------------------------ credential */

describe('resolveSheetsCredential', () => {
  const original = { ...config.dataSecrets };
  afterEach(() => {
    for (const key of Object.keys(config.dataSecrets)) delete config.dataSecrets[key];
    Object.assign(config.dataSecrets, original);
  });

  it('treats a JSON blob as a service account and a bare string as an API key', () => {
    // One secret id, two shapes, told apart by inspection — making the operator
    // declare which kind they configured only buys them a confusing 403 when
    // they pick wrong.
    config.dataSecrets.sa = JSON.stringify(KEY);
    config.dataSecrets.plain = 'AIzaSyExample';

    expect(resolveSheetsCredential('sa').serviceAccount?.client_email).toBe(KEY.client_email);
    expect(resolveSheetsCredential('sa').apiKey).toBeUndefined();
    expect(resolveSheetsCredential('plain').apiKey).toBe('AIzaSyExample');
  });

  it('names both config mechanisms when the id is not configured', () => {
    expect(() => resolveSheetsCredential('missing')).toThrow(/BREEZE_DATA_SECRETS_FILE/);
  });

  it('is empty for a source with no credential id', () => {
    expect(resolveSheetsCredential(undefined)).toEqual({});
  });
});
