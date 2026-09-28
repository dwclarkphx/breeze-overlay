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
import { ApiClients, isExternalApiCall } from './peers.js';
import { TranscodeQueue } from './media/transcode.js';
import { registerAssetRoutes } from './routes/assets.js';
import { authState, registerAuthRoutes } from './routes/auth.js';
import { registerBackupRoutes } from './routes/backup.js';
import { registerControlRoutes } from './routes/control.js';
import { registerDataSourceRoutes } from './routes/datasources.js';
import { registerDocsRoutes } from './routes/docs.js';
import { registerModeRoutes } from './routes/mode.js';
import { registerMediaRoutes } from './routes/media.js';
import { MediaMonitor } from './media/monitor.js';
import { registerEditorRoutes } from './routes/editor.js';
import { registerPlayRoutes } from './routes/play.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerStatusRoutes } from './routes/status.js';
import { seedDemos } from './seed.js';
import { SESSION_COOKIE, Sessions, keyMatches, readCookie, redactKey, sameOrigin } from './session.js';
import { fail } from './errors.js';
import { FAVICON_SVG } from './favicon.js';
import { NotFoundError, ensureDataDirs, listProjects } from './store.js';
import { APP_VERSION, FORMAT_VERSION } from './version.js';

export interface BuildAppOptions {
  /** Install the demo project when the data dir is empty. Default true. */
  seed?: boolean;
  /**
   * Where log lines go instead of stdout. The console dashboard owns the
   * terminal and draws the log itself; anything writing to stdout underneath it
   * would scribble over the frame.
   */
  logStream?: { write(line: string): void };
}

declare module 'fastify' {
  interface FastifyInstance {
    hub: ControlHub;
    apiClients: ApiClients;
  }
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  /*
   * Request lines are logged with the key taken out of the URL. The shape is
   * Fastify's own default request serializer, with only `url` changed.
   */
  const serializers = {
    req: (req: { method: string; url: string; host?: string; ip?: string; socket?: { remotePort?: number } }) => ({
      method: req.method,
      url: redactKey(req.url),
      host: req.host,
      remoteAddress: req.ip,
      remotePort: req.socket?.remotePort,
    }),
  };
  const app = Fastify({
    logger: options.logStream
      ? { level: config.logLevel, stream: options.logStream, serializers }
      : { level: config.logLevel, serializers },
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
   * are gated. LAN-first by design.
   */
  const sessions = new Sessions();

  /** Sign-in, sign-out and the status read — each checks what it needs itself. */
  const AUTH_ROUTES = new Set(['/api/auth', '/api/auth/login', '/api/auth/logout']);

  app.addHook('onRequest', async (req, reply) => {
    if (!config.apiKey) return;
    /*
     * Everything is decided on the route the request resolved to, never on
     * the raw URL. The router decodes escapes before matching, so a raw-URL
     * test is walked round by spelling the same path differently: `/%61pi/…`
     * reached every API route while skipping this gate entirely, until this
     * was changed. A request that matched no route has no route here and falls
     * through to its 404.
     */
    const route = req.routeOptions?.url;
    if (!route || !route.startsWith('/api/')) return;
    if (AUTH_ROUTES.has(route)) return;

    /*
     * Reads stay open so output pages and the editor need no credentials —
     * except control actions, which are side-effecting whatever their method.
     * A GET that fires a graphic to air is a write in every sense that matters,
     * and those exist because Stream Deck and Companion presets often can only
     * open a URL.
     *
     * Everything under a channel except `state` is an action. Written as the
     * one exception rather than a list of verbs: the list this replaced named
     * five, and the three verbs added after it (`prev`, `page`, `cycle`) would
     * have been open to any GET. A new verb is gated by default now; making one
     * public has to be done on purpose.
     */
    const isControlAction =
      (route.startsWith('/api/control/:id/:compId/') && route !== '/api/control/:id/:compId/state') ||
      // Choosing a source's backup puts different rows on air (Wave 5), and
      // setting the mode changes what every graphic shows (Wave 6).
      route === '/api/projects/:id/datasources/:sourceId/use' ||
      // Checking every camera now makes a request to each of them (Wave 8).
      route === '/api/projects/:id/datasources/:sourceId/media/check' ||
      route === '/api/projects/:id/mode/set';
    if (!isControlAction && req.method === 'GET') return;

    /*
     * Header or query parameter, for the same header-less devices. Compared in
     * constant time, and counted: a wrong key here costs the same as one
     * typed on the portal, so the sign-in limit cannot be walked round by
     * guessing through any other route.
     */
    const header = req.headers['x-breeze-key'];
    const presented = [Array.isArray(header) ? header[0] : header, (req.query as { key?: unknown } | undefined)?.key]
      .filter((k) => k !== undefined);
    if (presented.length > 0) {
      if (!sessions.mayTry(req.ip)) return reply.code(429).send(fail('error.tooManyAttempts'));
      if (presented.some((k) => keyMatches(k, config.apiKey))) return;
      sessions.failed(req.ip);
    }

    /*
     * A browser signed in on the portal (session.ts). Never for a GET — no
     * page of ours makes a side-effecting GET, and a GET from an `<img>` on
     * another port of this machine would carry the cookie — and only with an
     * Origin that is this server.
     */
    if (
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      sameOrigin(req.headers.origin, req.headers.host) &&
      sessions.expiry(readCookie(req.headers.cookie, SESSION_COOKIE)) !== undefined
    ) {
      return;
    }

    /*
     * Sent directly rather than thrown. The error handler derives its status
     * from `err.statusCode`, which a plain Error does not carry, so throwing
     * here surfaced every auth failure as a 500 — misleading for anyone wiring
     * up a control surface, and it hid the real cause.
     */
    return reply.code(401).send(fail('error.apiKeyRequired'));
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

  /*
   * The tab icon. `/favicon.ico` too, because a browser asks for it on any
   * page without a `<link rel="icon">` — the output page among them — and a
   * 404 in the log on every browser-source load is noise. Browsers go by the
   * content type, not the extension.
   */
  const favicon = async (_req: unknown, reply: { type(t: string): unknown; header(k: string, v: string): unknown }) => {
    reply.type('image/svg+xml');
    reply.header('cache-control', 'public, max-age=86400');
    return FAVICON_SVG;
  };
  app.get('/favicon.svg', favicon);
  app.get('/favicon.ico', favicon);

  app.get('/', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    // Says whether this browser is signed in, so it is never served from a cache.
    reply.header('cache-control', 'no-store');
    return portalPage(await listProjects(), APP_VERSION, authState(sessions, req));
  });

  await app.register(websocket);

  const hub = new ControlHub();
  app.decorate('hub', hub);

  /*
   * Recently active API callers, for the peers page and the console dashboard.
   * `onResponse` rather than `onRequest` so the status is known — a Companion
   * getting 401s on every press is exactly what someone opens that list to find.
   */
  const apiClients = new ApiClients();
  app.decorate('apiClients', apiClients);
  app.addHook('onResponse', async (req, reply) => {
    if (isExternalApiCall(req)) apiClients.note(req, reply.statusCode);
  });

  const data = new DataRegistry();
  // Before any source registers, so a camera list is checked from its first publish.
  const media = new MediaMonitor();
  data.attachMedia(media);
  // Before the server closes, not after: an open camera stream is a response
  // that never ends, and would hold the close until its cut-off.
  app.addHook('preClose', async () => {
    media.stop();
  });
  app.decorate('data', data);

  /*
   * A changed DataSet goes out as an ordinary `update` on the existing hub —
   * no new socket protocol, and it converges with operator field edits on the
   * one rebind path in the runtime.
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

  await registerAuthRoutes(app, sessions);
  await registerProjectRoutes(app);
  await registerAssetRoutes(app, transcodes);
  await registerBackupRoutes(app);
  await registerPlayRoutes(app, data);
  await registerControlRoutes(app, hub, data, sessions);
  await registerDataSourceRoutes(app, data);
  await registerModeRoutes(app, hub);
  await registerMediaRoutes(app, data, media);
  await registerStatusRoutes(app, hub, apiClients);
  await registerDocsRoutes(app);
  await registerEditorRoutes(app);

  return app;
}
