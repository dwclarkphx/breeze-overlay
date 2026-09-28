// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The camera proxy and the media-check API (CYCLE.md, Wave 8).
 *
 * `/media/…` is outside `/api` on purpose: output pages load it from `<img>`
 * tags that cannot send a key, exactly like `/play` and `/assets`. What it
 * can reach is bounded by the monitor — only the URLs that are rows of a
 * checked source, named by the hash of one.
 */

import type { FastifyInstance } from 'fastify';

import type { DataRegistry } from '../data/registry.js';
import { NotProxied, STREAM_BOUNDARY, type MediaMonitor } from '../media/monitor.js';

interface ProxyParams {
  project: string;
  source: string;
  key: string;
}
interface SourceParams {
  id: string;
  sourceId: string;
}

const NO_STORE = 'no-store, no-cache, must-revalidate';
/** How long a check-now request waits for its round before answering. */
export const CHECK_WAIT_MS = 4000;

export async function registerMediaRoutes(
  app: FastifyInstance,
  registry: DataRegistry,
  monitor: MediaMonitor,
): Promise<void> {
  app.get<{ Params: ProxyParams; Querystring: { _bz?: string } }>('/media/:project/:source/:key/snapshot', async (req, reply) => {
    const { project, source, key } = req.params;
    try {
      const frame = await monitor.snapshot(project, source, key);
      /*
       * A snapshot asked for by refresh period (`_bz`, `snapshotUrl`) is the
       * same picture for the whole period, so the browser may keep it for a
       * few seconds — which is what lets a page turn read the copy fetched
       * ahead of it. Anything else is never cached.
       */
      reply.header('cache-control', req.query._bz !== undefined ? 'private, max-age=15' : NO_STORE);
      reply.type(frame.type);
      return reply.send(frame.body);
    } catch (err) {
      if (err instanceof NotProxied) return reply.code(404).send({ error: err.message });
      // A 502, not the last frame: the page must see the camera is down to act on it.
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{ Params: ProxyParams }>('/media/:project/:source/:key/stream', async (req, reply) => {
    const { project, source, key } = req.params;
    let hub;
    try {
      hub = monitor.stream(project, source, key);
    } catch (err) {
      if (err instanceof NotProxied) return reply.code(404).send({ error: err.message });
      throw err;
    }
    // A HEAD is answered with the headers alone, not a camera connection.
    if (req.method === 'HEAD') {
      reply.header('content-type', `multipart/x-mixed-replace; boundary=${STREAM_BOUNDARY}`);
      reply.header('cache-control', NO_STORE);
      return reply.send();
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': `multipart/x-mixed-replace; boundary=${STREAM_BOUNDARY}`,
      'cache-control': NO_STORE,
      pragma: 'no-cache',
      connection: 'close',
    });
    hub.add(res);
    const leave = (): void => hub.remove(res);
    req.raw.on('close', leave);
    res.on('close', leave);
    return reply;
  });

  /* ------------------------------------------------------------------ api */

  /** Every row's check — the editor's and the control panel's detail. */
  app.get<{ Params: SourceParams }>('/api/projects/:id/datasources/:sourceId/media', async (req, reply) => {
    const { id, sourceId } = req.params;
    if (!registry.get(id, sourceId)) return reply.code(404).send({ error: `no data source "${sourceId}"` });
    return {
      summary: monitor.summary(id, sourceId) ?? null,
      rows: monitor.rows(id, sourceId),
    };
  });

  /**
   * Check every camera now rather than at the next round — after fixing one,
   * or before going on air. GET too, for control surfaces that can only open a
   * URL; gated like every other action (`app.ts`).
   */
  const check = async (req: { params: SourceParams }, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    const { id, sourceId } = req.params;
    const entry = registry.get(id, sourceId);
    if (!entry) return reply.code(404).send({ error: `no data source "${sourceId}"` });
    if (!entry.def.media) return reply.code(400).send({ error: `data source "${sourceId}" has no media checks` });
    /*
     * Answered within a few seconds whatever happens. A round with a camera
     * that does not answer takes its whole timeout, and a control surface
     * waiting on it would report the server unreachable. `done: false` says
     * the round is still running; the status shows its result when it ends.
     */
    const done = await Promise.race([
      monitor.checkNow(id, sourceId).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), CHECK_WAIT_MS).unref?.()),
    ]);
    return { done, summary: monitor.summary(id, sourceId) ?? null, rows: monitor.rows(id, sourceId) };
  };
  app.get<{ Params: SourceParams }>('/api/projects/:id/datasources/:sourceId/media/check', check);
  app.post<{ Params: SourceParams }>('/api/projects/:id/datasources/:sourceId/media/check', check);
}
