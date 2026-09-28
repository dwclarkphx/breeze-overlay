// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Browser sessions for a server with `BREEZE_API_KEY` set.
 *
 * Before these, the key had two ways in — an `x-breeze-key` header and a
 * `?key=` parameter — and a browser could use neither well: the editor sent
 * nothing, so every save was refused, and the control panel carried the key in
 * its URL, into history and bookmarks. Now a person types the key once on the
 * portal, and the server answers with a random token in a cookie. The browser
 * holds the token, never the key.
 *
 * The cookie is `HttpOnly` (no script on the page can read it) and
 * `SameSite=Strict` (no other site can make the browser send it). SameSite goes
 * by *site*, though, and another service on the same machine on another port
 * is the same site — so a session is also only accepted on a request whose
 * `Origin` is this server, and never on a GET, where browsers send no Origin
 * and an `<img>` could fire a control URL. Header-less hardware keeps using
 * `?key=`; sessions are for people in browsers.
 *
 * Held in memory, on purpose: a restart signs everyone out, and so does
 * changing the key, which takes a restart. Twelve hours covers a shift.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'breeze_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Wrong keys allowed from one address inside `FAILURE_WINDOW_MS` before it must wait. */
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 60_000;

export class Sessions {
  private tokens = new Map<string, number>();
  private failures = new Map<string, { count: number; first: number }>();

  /** A new session, and when it ends. */
  create(now = Date.now()): { token: string; expiresAt: number } {
    this.sweep(now);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + SESSION_TTL_MS;
    this.tokens.set(token, expiresAt);
    return { token, expiresAt };
  }

  /** When a live session ends, or undefined for an unknown or expired one. */
  expiry(token: string | undefined, now = Date.now()): number | undefined {
    if (!token) return undefined;
    const at = this.tokens.get(token);
    if (at === undefined) return undefined;
    if (at <= now) {
      this.tokens.delete(token);
      return undefined;
    }
    return at;
  }

  end(token: string | undefined): boolean {
    return token !== undefined && this.tokens.delete(token);
  }

  /**
   * Whether an address may try a key now. Five wrong keys in a minute and it
   * waits out the rest of that minute — enough to make guessing hopeless,
   * little enough that a mistyped key at a desk costs nothing.
   */
  mayTry(ip: string, now = Date.now()): boolean {
    const record = this.failures.get(ip);
    if (!record || now - record.first >= FAILURE_WINDOW_MS) return true;
    return record.count < MAX_FAILURES;
  }

  failed(ip: string, now = Date.now()): void {
    // Swept here too: a stream of wrong keys from rotating addresses must not
    // grow the table until someone happens to sign in.
    if (this.failures.size > 1000) this.sweep(now);
    const record = this.failures.get(ip);
    if (!record || now - record.first >= FAILURE_WINDOW_MS) this.failures.set(ip, { count: 1, first: now });
    else record.count += 1;
  }

  succeeded(ip: string): void {
    this.failures.delete(ip);
  }

  private sweep(now: number): void {
    for (const [token, at] of this.tokens) if (at <= now) this.tokens.delete(token);
    for (const [ip, record] of this.failures) if (now - record.first >= FAILURE_WINDOW_MS) this.failures.delete(ip);
  }
}

/** Compare a typed key with the configured one in constant time. */
export function keyMatches(given: unknown, key: string): boolean {
  if (typeof given !== 'string' || key === '') return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(key).digest();
  return timingSafeEqual(a, b);
}

/**
 * A URL with any `key=` parameter's value replaced — for logs. Fastify logs
 * every request's URL, and a header-less device's `?key=` would otherwise be
 * written to stdout and the console dashboard on every press.
 */
export function redactKey(url: string): string {
  return url.replace(/([?&]key=)[^&#]*/gi, '$1[redacted]');
}

/** One cookie's value from a `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** The `Set-Cookie` value for a session, or for clearing one (`token` null). */
export function sessionCookie(token: string | null, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token ?? ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${token ? Math.floor(SESSION_TTL_MS / 1000) : 0}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Whether a request's `Origin` is this server. Absent is not accepted: every
 * browser sends Origin on the non-GET requests a session may authorise, so a
 * request without one did not come from a page of ours.
 */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
