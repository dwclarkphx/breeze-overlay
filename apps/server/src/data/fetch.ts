// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The one place a data source reaches the network.
 *
 * This server sits on production LANs, next to vMix machines, switcher control
 * surfaces and whatever else the venue runs — and it accepts a URL from anyone
 * who can open the editor. That makes an unguarded fetcher a request forgery
 * primitive pointed at the most sensitive network in the building, so private
 * and link-local ranges are refused by default and opened only by explicit
 * config.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

import { config } from '../config.js';
import { APP_VERSION } from '../version.js';

export class FetchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchBlockedError';
  }
}

/* --------------------------------------------------------------- SSRF guard */

/**
 * Ranges refused unless allowlisted.
 *
 * Loopback and the RFC 1918 blocks are the obvious ones. The two easy to forget
 * are both the ones that actually get exploited: 169.254.169.254 (cloud instance
 * metadata, and 169.254/16 generally) and IPv4-mapped IPv6, where `::ffff:10.0.0.1`
 * reaches a private host through an address that does not look private.
 */
export function isPrivateAddress(address: string): boolean {
  const v = address.toLowerCase();

  if (net.isIPv6(v)) {
    if (v === '::1' || v === '::') return true;
    // Unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/.test(v)) return true;
    if (/^fe[89ab]/.test(v)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return false;
  }

  if (!net.isIPv4(v)) return true; // unparseable is not trusted

  const [a = 0, b = 0] = v.split('.').map(Number);
  if (a === 0 || a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function allowlisted(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return config.dataAllowHosts.some((entry) => {
    const e = entry.toLowerCase();
    if (e === host) return true;
    // A leading dot means "this domain and its subdomains".
    return e.startsWith('.') && host.endsWith(e);
  });
}

/**
 * Resolve and vet a URL before any request is made.
 *
 * Resolution happens here, and the resolved addresses are handed back, so the
 * caller can be sure the host that was *checked* is the host that gets
 * *connected to*. Checking the name and then letting `fetch` resolve it again
 * leaves a DNS-rebinding window between the two.
 */
export async function assertFetchable(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FetchBlockedError(`not a valid URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FetchBlockedError(`unsupported protocol "${parsed.protocol}"`);
  }

  if (allowlisted(parsed.hostname)) return parsed;

  /*
   * `URL.hostname` keeps the brackets on an IPv6 literal — `http://[::1]/`
   * gives `[::1]`, which `net.isIP` rejects. Left as-is that fell through to a
   * DNS lookup of a string that cannot resolve, so `http://[::1]:7331/` was
   * refused with "cannot resolve host" rather than as the loopback address it
   * plainly is. Same outcome by luck, wrong reason, and one resolver quirk away
   * from being no refusal at all.
   */
  const literal = parsed.hostname.replace(/^\[|\]$/g, '');

  // A literal IP needs no lookup and must not get one.
  if (net.isIP(literal)) {
    if (isPrivateAddress(literal)) {
      throw new FetchBlockedError(
        `refusing to fetch a private address (${literal}). Add the host to BREEZE_DATA_ALLOW_HOSTS to permit it.`,
      );
    }
    return parsed;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true });
  } catch {
    throw new FetchBlockedError(`cannot resolve host "${parsed.hostname}"`);
  }

  // Every answer must be public: a name resolving to one public and one private
  // address is the rebinding case, and picking the public one would be luck.
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new FetchBlockedError(
        `"${parsed.hostname}" resolves to a private address (${address}). Add it to BREEZE_DATA_ALLOW_HOSTS to permit it.`,
      );
    }
  }

  return parsed;
}

/* ------------------------------------------------------------------ fetch */

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Value from the previous response, for a conditional request. */
  etag?: string | undefined;
  lastModified?: string | undefined;
  timeoutMs?: number;
  /** Resolved from the server-side secret store by the caller. */
  bearerToken?: string | undefined;
}

export interface FetchResult {
  /** null when the origin answered 304 — the cached body is still current. */
  body: string | null;
  status: number;
  etag?: string | undefined;
  lastModified?: string | undefined;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
/** Refuse a body large enough to be a mistake rather than a data feed. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Product token, `BreezeOverlay/0.60.0`.
 *
 * Tracks the running build rather than a literal, which is the whole point of a
 * product token: an origin that starts refusing us needs to be able to tell one
 * release from another, and `1.0` — hardcoded here since Phase 6 while the
 * product moved through the 0.4x and 0.5x lines — named a version that has
 * never shipped. `APP_VERSION` is read from the server's own manifest, so this
 * follows `pnpm version:sync` with nothing further to remember.
 *
 * `dev` appears here when the manifest cannot be read; that is the honest
 * answer and a legal token, so it is left to flow through.
 */
export const PRODUCT_TOKEN = `BreezeOverlay/${APP_VERSION}`;

/**
 * Used only when nobody has said who this server is. Shared by every Breeze
 * install in the world, which is exactly what makes it a liability worth
 * replacing — see `config.contact`.
 */
export const FALLBACK_USER_AGENT = `${PRODUCT_TOKEN} (+https://github.com/dwclarkphx/breeze-overlay)`;

/**
 * `User-Agent` for an outgoing request.
 *
 * Shaped `BreezeOverlay/0.60.0 (mystation.com, ops@mystation.com)` — the product
 * token identifies the software, the parenthesised part identifies the
 * operator. api.weather.gov documents the second half and says the more unique
 * the string, the less likely it is to be caught by someone else's security
 * event; keeping the product token as well means an origin can tell *what* is
 * calling as well as *who* runs it, which is strictly more useful to both ends.
 *
 * A contact already wrapped in brackets is unwrapped rather than nested: NWS's
 * own documentation shows the value as `(myweatherapp.com, contact@…)`, so an
 * operator copying that example verbatim is doing the reasonable thing and
 * should not end up sending `((…))`.
 */
export function userAgent(contact?: string): string {
  const who = (contact ?? '').trim() || config.contact.trim();
  if (!who) return FALLBACK_USER_AGENT;
  const inner = who.replace(/^\(+/, '').replace(/\)+$/, '').trim();
  return inner ? `${PRODUCT_TOKEN} (${inner})` : FALLBACK_USER_AGENT;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const parsed = await assertFetchable(url);

  const headers: Record<string, string> = {
    // api.weather.gov rejects requests without one, and it is good manners
    // everywhere else. Carries the operator's contact when they have set one.
    'user-agent': userAgent(),
    accept: '*/*',
    ...(opts.headers ?? {}),
  };
  if (opts.etag) headers['if-none-match'] = opts.etag;
  if (opts.lastModified) headers['if-modified-since'] = opts.lastModified;
  if (opts.bearerToken) headers['authorization'] = `Bearer ${opts.bearerToken}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(parsed, {
      headers,
      signal: controller.signal,
      // A feed that 302s to an internal host would sail past the pre-flight
      // check, so redirects are followed manually — one hop at a time, each
      // vetted — rather than by the runtime.
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`redirect with no location (${response.status})`);
      const next = new URL(location, parsed).toString();
      clearTimeout(timer);
      return fetchText(next, { ...opts, timeoutMs: opts.timeoutMs });
    }

    if (response.status === 304) {
      return {
        body: null,
        status: 304,
        etag: opts.etag,
        lastModified: opts.lastModified,
      };
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_BODY_BYTES) {
      throw new Error(`response is ${declared} bytes, over the ${MAX_BODY_BYTES} limit`);
    }

    const body = await response.text();
    if (body.length > MAX_BODY_BYTES) {
      throw new Error(`response is ${body.length} bytes, over the ${MAX_BODY_BYTES} limit`);
    }

    return {
      body,
      status: response.status,
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
