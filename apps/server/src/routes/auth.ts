// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Signing a browser in with the API key — see `session.ts` for why a session
 * rather than the key itself.
 *
 * All three routes are exempt from the key gate in `app.ts`: sign-in is how a
 * browser gets past it, sign-out needs nothing to be allowed, and the status
 * read is what the portal asks before it knows anything.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { actorOf, record } from '../audit.js';
import { config } from '../config.js';
import { fail } from '../errors.js';
import { SESSION_COOKIE, keyMatches, readCookie, sameOrigin, sessionCookie, type Sessions } from '../session.js';

/** When the request's session ends, or undefined when it has none. */
export function sessionExpiry(sessions: Sessions, req: FastifyRequest): number | undefined {
  return sessions.expiry(readCookie(req.headers.cookie, SESSION_COOKIE));
}

/** Whether a key is set, and whether this browser is signed in. */
export function authState(sessions: Sessions, req: FastifyRequest): { keyRequired: boolean; signedIn: boolean; expiresAt?: string } {
  if (!config.apiKey) return { keyRequired: false, signedIn: false };
  const expiry = sessionExpiry(sessions, req);
  return {
    keyRequired: true,
    signedIn: expiry !== undefined,
    ...(expiry !== undefined ? { expiresAt: new Date(expiry).toISOString() } : {}),
  };
}

export async function registerAuthRoutes(app: FastifyInstance, sessions: Sessions): Promise<void> {
  app.get('/api/auth', async (req) => authState(sessions, req));

  app.post<{ Body: { key?: unknown } }>('/api/auth/login', async (req, reply) => {
    if (!config.apiKey) {
      reply.code(409);
      return fail('error.noApiKey');
    }
    // From the portal only. Another site — or another port of this machine —
    // could otherwise burn this address's tries and lock the operator out.
    if (!sameOrigin(req.headers.origin, req.headers.host)) {
      reply.code(403);
      return fail('error.forbidden');
    }
    if (!sessions.mayTry(req.ip)) {
      reply.code(429);
      return fail('error.tooManyAttempts');
    }
    const given = req.body && typeof req.body === 'object' ? req.body.key : undefined;
    if (typeof given !== 'string') {
      reply.code(400);
      return fail('error.apiKeyWrong');
    }
    if (!keyMatches(given, config.apiKey)) {
      sessions.failed(req.ip);
      void record({ action: 'session.refused', actor: actorOf(req) });
      reply.code(401);
      return fail('error.apiKeyWrong');
    }
    sessions.succeeded(req.ip);
    // A browser signing in again replaces its old session rather than holding two.
    sessions.end(readCookie(req.headers.cookie, SESSION_COOKIE));
    const { token, expiresAt } = sessions.create();
    reply.header('set-cookie', sessionCookie(token, req.protocol === 'https'));
    reply.header('cache-control', 'no-store');
    void record({ action: 'session.start', actor: actorOf(req) });
    return { keyRequired: true, signedIn: true, expiresAt: new Date(expiresAt).toISOString() };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (!sameOrigin(req.headers.origin, req.headers.host)) {
      reply.code(403);
      return fail('error.forbidden');
    }
    if (sessions.end(readCookie(req.headers.cookie, SESSION_COOKIE))) {
      void record({ action: 'session.end', actor: actorOf(req) });
    }
    reply.header('set-cookie', sessionCookie(null, req.protocol === 'https'));
    return { keyRequired: Boolean(config.apiKey), signedIn: false };
  });
}
