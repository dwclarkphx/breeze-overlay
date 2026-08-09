// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';

import { CompositionValidationError } from '@breeze/schema/validate';

import { DATA_UPDATE_KEY } from '@breeze/schema';

import { config } from './config.js';
import { DataRegistry } from './data/registry.js';
import { portalPage } from './pages.js';
import { ControlHub } from './hub.js';
import { TranscodeQueue } from './media/transcode.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerControlRoutes } from './routes/control.js';
import { registerDataSourceRoutes } from './routes/datasources.js';
import { registerDocsRoutes } from './routes/docs.js';
import { registerEditorRoutes } from './routes/editor.js';
import { registerPlayRoutes } from './routes/play.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerStatusRoutes } from './routes/status.js';
import { seedDemos } from './seed.js';
import { NotFoundError, ensureDataDirs, listProjects } from './store.js';
import { APP_VERSION, FORMAT_VERSION } from './version.js';

export interface BuildAppOptions {
  /** Install the demo project when the data dir is empty. Default true. */
  seed?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    // Compositions with embedded base64 assets get large.
    bodyLimit: 64 * 1024 * 1024,
  });

  await ensureDataDirs();
  if (options.seed !== false) {
    // Named rather than counted: "installed 3 demo projects" tells an operator
    // nothing about what just appeared in their project list.
    const seeded = await seedDemos();
    if (seeded.length > 0) app.log.info(`installed demo projects: ${seeded.join(', ')}`);
  }

  /**
   * Optional shared secret. Output pages and the editor shell stay open so a
   * browser source never needs credentials; only mutating and control calls
   * are gated. LAN-first, per ROADMAP §3.
   */
  app.addHook('onRequest', async (req, reply) => {
    if (!config.apiKey) return;
    if (!req.url.startsWith('/api/')) return;

    /*
     * Reads stay open so output pages and the editor need no credentials —
     * except control actions, which are side-effecting whatever their method.
     * A GET that fires a graphic to air is a write in every sense that matters,
     * and those exist because Stream Deck and Companion presets often can only
     * open a URL.
     */
    const isControlAction =
      /^\/api\/control\/[^/]+\/[^/]+\/(play|stop|next|clear|update)\b/.test(req.url);
    if (!isControlAction && req.method === 'GET') return;

    // Header or query parameter, for the same header-less devices.
    const header = req.headers['x-breeze-key'];
    const query = (req.query as { key?: string } | undefined)?.key;
    if (header === config.apiKey || query === config.apiKey) return;

    /*
     * Sent directly rather than thrown. The error handler derives its status
     * from `err.statusCode`, which a plain Error does not carry, so throwing
     * here surfaced every auth failure as a 500 — misleading for anyone wiring
     * up a control surface, and it hid the real cause.
     */
    return reply.code(401).send({ error: 'invalid or missing API key' });
  });

  app.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof CompositionValidationError) {
      reply.code(422).send({ error: 'validation failed', issues: error.issues });
      return;
    }
    if (error instanceof NotFoundError) {
      reply.code(404).send({ error: error.message });
      return;
    }
    const err = error as { statusCode?: number; message?: string };
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({ error: err.message ?? 'internal error' });
  });

  /*
   * `version` is the app, `formatVersion` is the composition document.
   *
   * This used to report `version: 1` — the format version wearing the app's
   * name — so a health check asked "what is running?" answered "1" no matter
   * which build it was. Both are reported now, each under the name that means
   * what it says.
   */
  app.get('/healthz', async () => ({
    ok: true,
    version: APP_VERSION,
    formatVersion: FORMAT_VERSION,
  }));

  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return portalPage(await listProjects(), APP_VERSION);
  });

  await app.register(websocket);

  const hub = new ControlHub();
  app.decorate('hub', hub);

  const data = new DataRegistry();
  app.decorate('data', data);

  /*
   * A changed DataSet goes out as an ordinary `update` on the existing hub —
   * no new socket protocol, and it converges with operator field edits on the
   * one rebind path in the runtime (DATA-SOURCES §1).
   *
   * Only to channels that exist: a channel is created the moment anything
   * subscribes, so this fans out to graphics that are actually open rather than
   * to every composition in the project.
   */
  data.onPush((projectId, dataset) => {
    const prefix = `${projectId}/`;
    for (const channel of hub.activeChannels) {
      if (!channel.startsWith(prefix)) continue;
      hub.dispatch(channel, {
        verb: 'update',
        data: { [DATA_UPDATE_KEY]: { [dataset.id]: dataset } },
        source: 'datasource',
      });
    }
  });

  // Start polling for every project on disk. Sources are per project and a
  // browser source may be opened without anyone visiting the editor first, so
  // waiting for a request to register them would leave a graphic showing its
  // authored snapshot until someone happened to look at it.
  for (const project of await listProjects()) {
    try {
      await data.register(project.id);
    } catch (err) {
      app.log.warn({ err, project: project.id }, 'could not register data sources');
    }
  }

  /*
   * The transcode queue is built here rather than imported as a singleton so
   * each test app gets its own — a module-level queue would carry jobs (and
   * live ffmpeg processes) between suites.
   */
  const transcodes = new TranscodeQueue();

  app.addHook('onClose', async () => {
    data.stop();
    // Killed rather than awaited. An encode can be minutes from finishing and
    // its output is content-addressed, so re-requesting it after a restart
    // either finds the file or starts cleanly from a source that has not moved.
    transcodes.stop();
  });

  await registerProjectRoutes(app);
  await registerAssetRoutes(app, transcodes);
  await registerPlayRoutes(app, data);
  await registerControlRoutes(app, hub, data);
  await registerDataSourceRoutes(app, data);
  await registerStatusRoutes(app, hub);
  await registerDocsRoutes(app);
  await registerEditorRoutes(app);

  return app;
}
