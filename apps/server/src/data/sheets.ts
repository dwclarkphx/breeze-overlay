// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Google Sheets API v4 — the *private* sheet adapter.
 *
 * The published-CSV route from Wave 1 stays the recommended path and the panel
 * still says so: it needs no credential, no Cloud project and no consent
 * screen, and it is one URL an operator can paste. This adapter exists for the
 * case that route cannot serve — a sheet holding anything the league does not
 * want on a public URL, which "Publish to web" makes world-readable by
 * definition.
 *
 * **No `googleapis` dependency.** That package pulls a large transitive tree to
 * do, for our purposes, two things: sign a JWT and issue one HTTPS GET. RS256
 * signing is `node:crypto`, the token exchange is a form POST, and the whole
 * surface is the ~60 lines below. The dependency audit closed in 0.40 and this
 * did not seem worth reopening it for.
 */

import { createSign } from 'node:crypto';

import { type DataColumn, type DataSet } from '@breeze/schema';

import { config } from '../config.js';
import { fetchText } from './fetch.js';
import { gridToDataSet } from './parse.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SHEETS_ORIGIN = 'https://sheets.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export class SheetsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetsAuthError';
  }
}

/* --------------------------------------------------------- service account */

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/**
 * Read a service-account key out of whatever the operator pasted.
 *
 * Accepts the downloaded JSON verbatim, because that is what people have and
 * asking them to reformat it is asking them to break it. The one transformation
 * is on `private_key`: a key that has been through an environment variable, a
 * `.env` file or a Docker Compose `environment:` block usually arrives with its
 * newlines as literal backslash-n, and OpenSSL rejects that with an error
 * message ("error:0909006C:PEM routines:get_name:no start line") that says
 * nothing whatsoever about newlines.
 */
export function parseServiceAccount(raw: string | Record<string, unknown>): ServiceAccountKey {
  let obj: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new SheetsAuthError('service-account credential is not valid JSON');
    }
  } else {
    obj = raw;
  }

  const email = typeof obj.client_email === 'string' ? obj.client_email : '';
  const key = typeof obj.private_key === 'string' ? obj.private_key : '';
  if (!email || !key) {
    throw new SheetsAuthError(
      'service-account credential needs "client_email" and "private_key" — use the JSON key file Google downloads',
    );
  }

  return {
    client_email: email,
    private_key: key.replace(/\\n/g, '\n'),
    ...(typeof obj.token_uri === 'string' ? { token_uri: obj.token_uri } : {}),
  };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Build and sign the assertion Google's JWT-bearer flow wants.
 *
 * `iat` is backdated a minute. Server clocks drift, venue machines are often
 * not running NTP, and a token issued one second into the future is rejected
 * outright with an error that reads like a bad key — the single most annoying
 * way for this to fail at 19:55.
 */
export function buildJwtAssertion(
  key: ServiceAccountKey,
  now: number = Date.now(),
  scope: string = SCOPE,
): string {
  const issued = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope,
      aud: key.token_uri ?? TOKEN_ENDPOINT,
      iat: issued,
      exp: issued + 3600,
    }),
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();

  let signature: Buffer;
  try {
    signature = signer.sign(key.private_key);
  } catch (err) {
    throw new SheetsAuthError(
      `could not sign with the service-account private key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return `${header}.${claims}.${base64url(signature)}`;
}

interface CachedToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/** Exposed for tests, and for a config reload to invalidate a rotated key. */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/**
 * Exchange the assertion for an access token, cached until shortly before it
 * expires.
 *
 * Caching is not an optimisation here so much as a correctness matter: a sheet
 * polled every 10 seconds would otherwise mint a token every 10 seconds, and
 * Google rate-limits token minting far more tightly than it rate-limits reads.
 * The 60-second early expiry keeps a poll that starts just under the wire from
 * finishing just over it.
 *
 * This request does **not** go through `fetchText`. That function's job is to
 * vet operator-supplied URLs against the SSRF guard; this URL is a constant in
 * this file, and routing it through the guard would mean an operator who
 * allowlists a host could redirect the credential exchange.
 */
export async function getAccessToken(key: ServiceAccountKey, now = Date.now()): Promise<string> {
  const cacheKey = `${key.client_email}|${SCOPE}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now + 60_000) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: buildJwtAssertion(key, now),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(key.token_uri ?? TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      // Google's error body is small and specific ("invalid_grant" when the
      // clock is off, "unauthorized_client" when domain delegation is missing).
      // It goes into the source's lastError verbatim, because the editor's
      // health row is where this gets diagnosed.
      throw new SheetsAuthError(`token request failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
    }
    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) throw new SheetsAuthError('token response contained no access_token');

    tokenCache.set(cacheKey, {
      token: parsed.access_token,
      expiresAt: now + (parsed.expires_in ?? 3600) * 1000,
    });
    return parsed.access_token;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new SheetsAuthError('token request timed out after 10000ms');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ read */

/**
 * A spreadsheet id out of whatever was pasted.
 *
 * Nobody has the bare id to hand; they have the URL from the browser bar. Both
 * work, and so does the `#gid=` fragment being left on the end.
 */
export function spreadsheetId(input: string): string {
  const trimmed = input.trim();
  const match = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(trimmed);
  if (match) return match[1]!;
  return trimmed.replace(/[#?].*$/, '');
}

export interface SheetsReadOptions {
  /** A1 notation — `Standings!A1:F30`, or a bare sheet name for the used range. */
  range?: string;
  /** API key, for a sheet shared as "anyone with the link". */
  apiKey?: string | undefined;
  /** Parsed service-account key, for a sheet shared with its client_email. */
  serviceAccount?: ServiceAccountKey | undefined;
  header?: boolean;
  columns?: DataColumn[];
}

interface ValuesResponse {
  values?: string[][];
}

/**
 * `values.get`, as a DataSet.
 *
 * `valueRenderOption=FORMATTED_VALUE` is deliberate: the sheet's own formatting
 * is a decision the person who built it already made, and a table showing
 * "0.6666666666666666" where the sheet shows "66.7%" is not a rounding bug we
 * should be fixing downstream. Numeric columns still coerce, because
 * `inferColumnsFromRows` strips separators and currency symbols.
 *
 * `majorDimension=ROWS` matters more than it looks: the default is ROWS, but
 * saying so keeps a future default change from transposing every standings
 * table in the field.
 */
export async function sheetsToDataSet(
  id: string,
  spreadsheet: string,
  opts: SheetsReadOptions = {},
): Promise<DataSet> {
  const sheet = spreadsheetId(spreadsheet);
  if (!sheet) throw new SheetsAuthError('a spreadsheet id or URL is required');

  const range = opts.range?.trim() || 'A1:Z1000';
  const url = new URL(
    `${SHEETS_ORIGIN}/v4/spreadsheets/${encodeURIComponent(sheet)}/values/${encodeURIComponent(range)}`,
  );
  url.searchParams.set('majorDimension', 'ROWS');
  url.searchParams.set('valueRenderOption', 'FORMATTED_VALUE');

  let bearer: string | undefined;
  if (opts.serviceAccount) {
    bearer = await getAccessToken(opts.serviceAccount);
  } else if (opts.apiKey) {
    url.searchParams.set('key', opts.apiKey);
  } else {
    throw new SheetsAuthError(
      'this source needs a credential — set its credential id and configure either an API key or a service-account JSON on the server',
    );
  }

  const result = await fetchText(url.toString(), { bearerToken: bearer });
  if (result.body === null) return { id, columns: opts.columns ?? [], rows: [] };

  const payload = JSON.parse(result.body) as ValuesResponse;
  const grid = payload.values ?? [];

  /*
   * Sheets truncates trailing empty cells per row, so a row whose last two
   * columns are blank comes back short. `gridToDataSet` indexes columns
   * positionally, which is fine — a missing cell reads as '' — but only because
   * the *header* row is the widest. Pad to the header width so a short header
   * (itself possible, if the last column has no title) cannot silently drop a
   * column that every data row has.
   */
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  const padded = grid.map((row) =>
    row.length === width ? row : [...row, ...Array<string>(width - row.length).fill('')],
  );

  return gridToDataSet(id, padded, {
    ...(opts.header !== undefined ? { header: opts.header } : {}),
    ...(opts.columns ? { columns: opts.columns } : {}),
  });
}

/**
 * Resolve a source's `secretId` into whichever credential kind it holds.
 *
 * One secret id, two possible shapes — a bare API key or a service-account JSON
 * blob — distinguished by whether it parses as an object with a `client_email`.
 * Making the operator declare which kind they configured, and then getting a
 * confusing 403 when they picked wrong, buys nothing.
 */
export function resolveSheetsCredential(secretId: string | undefined): {
  apiKey?: string;
  serviceAccount?: ServiceAccountKey;
} {
  if (!secretId) return {};
  const raw = config.dataSecrets[secretId];
  if (raw === undefined) {
    throw new SheetsAuthError(
      `credential "${secretId}" is not configured on this server (set BREEZE_DATA_SECRETS or BREEZE_DATA_SECRETS_FILE)`,
    );
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return { serviceAccount: parseServiceAccount(trimmed) };
  return { apiKey: trimmed };
}
