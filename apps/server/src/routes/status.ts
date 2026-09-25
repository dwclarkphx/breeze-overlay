// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * `GET /api/status` — what the portal header polls.
 *
 * A plain REST route rather than a hub channel. The hub is keyed by
 * `projectId/compositionId` and every client on it is subscribed to one
 * graphic; a server-wide status feed would need a channel that is not a
 * graphic, which is a new concept in a protocol that currently has exactly one.
 * Polling every couple of seconds costs a few hundred bytes and reconnects for
 * free after a server restart, which a socket does not.
 *
 * A GET, so it stays readable without the API key — the portal is the page an
 * operator lands on before they have credentials for anything.
 */

import type { FastifyInstance } from 'fastify';

import { describeAgent, recent } from '../audit.js';
import type { ControlHub } from '../hub.js';
import { serverI18n } from '../i18n.js';
import { activityPage, peersPage } from '../pages.js';
import { peersReport, type ApiClients } from '../peers.js';
import { StatusSampler } from '../status.js';
import { APP_VERSION } from '../version.js';

export async function registerStatusRoutes(
  app: FastifyInstance,
  hub: ControlHub,
  apiClients: ApiClients,
): Promise<void> {
  const sampler = new StatusSampler();

  /**
   * The activity log, as a page and as JSON.
   *
   * A GET, so it is readable without the API key — same reasoning as the status
   * route. Worth being explicit about what that means: on a server with no key
   * set, anyone who can reach it can read which addresses did what. That is the
   * same exposure the portal already has, on a LAN-first tool.
   */
  app.get<{ Querystring: { filter?: string } }>('/activity', async (req, reply) => {
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    return activityPage(await recent(200), describeAgent, req.query?.filter ?? '');
  });

  app.get<{ Querystring: { limit?: string } }>('/api/activity', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    // Clamped: an unbounded limit turns a month of panel connections into one
    // response, and the page only ever asks for a screenful.
    const limit = Math.min(Math.max(Number(req.query?.limit ?? 200) || 200, 1), 1000);
    return { entries: await recent(limit) };
  });

  /**
   * Who is connected, as a page and as JSON — the list behind the status
   * strip's two counts.
   *
   * Open without the key, like `/activity`, and exposing the same thing: which
   * addresses are doing what. The API list never carries a query string, so a
   * `?key=` a Stream Deck sent is not echoed onto a page anyone can read.
   */
  app.get<{ Querystring: { filter?: string } }>('/peers', async (req, reply) => {
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    return peersPage(peersReport(hub, apiClients), describeAgent, req.query?.filter ?? '');
  });

  app.get('/api/peers', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return peersReport(hub, apiClients);
  });

  app.get('/api/status', async (_req, reply) => {
    // Never cached. A status number served from a proxy cache is a lie that
    // looks exactly like a working readout.
    reply.header('cache-control', 'no-store');
    const { locale, direction } = serverI18n();
    return sampler.report(hub, APP_VERSION, { locale, direction });
  });
}
