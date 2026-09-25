// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// First, before anything that reads `config` — it is evaluated at import, and
// the settings file has to be in the environment by then. See load-env.ts.
import { created, settings } from './boot-settings.js';
import { describeSettings } from './load-env.js';

import { networkInterfaces } from 'node:os';

import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import { describeAgent } from './audit.js';
import { config } from './config.js';
import { Dashboard, LogTail, resolveConsoleMode } from './console.js';
import { serverI18n } from './i18n.js';
import { StatusSampler } from './status.js';
import { APP_VERSION } from './version.js';

async function main(): Promise<void> {
  const { mode, warning } = resolveConsoleMode(config.console, Boolean(process.stdout.isTTY));

  // Created before the app so nothing the app logs while booting — seeding,
  // data-source registration — lands on stdout underneath the dashboard.
  const tail = mode === 'dashboard' ? new LogTail() : null;

  const app = await buildApp(tail ? { logStream: tail } : {});
  await app.listen({ host: config.host, port: config.port });

  const lanAddresses = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address);

  if (warning) app.log.warn(warning);

  /*
   * First line, before the URLs. When something is misbehaving on a show day
   * the first question is which build is running, and the answer should be in
   * the terminal already rather than requiring a curl.
   */
  app.log.info(`Breeze Overlay ${APP_VERSION}`);
  app.log.info(`Breeze editor:  http://localhost:${config.port}/`);
  for (const addr of lanAddresses) {
    app.log.info(`Browser source: http://${addr}:${config.port}/play/<project>/<composition>`);
  }
  app.log.info(`Data directory: ${config.dataDir}`);
  for (const { level, text } of describeSettings(settings, created)) app.log[level](text);

  if (!tail) {
    // Last, so it is the line left showing once startup has finished.
    app.log.info('Press Ctrl+C to exit');
    return;
  }

  const sampler = new StatusSampler();
  const dashboard = new Dashboard({
    out: process.stdout,
    hub: app.hub,
    api: app.apiClients,
    status: () => {
      const { locale, direction } = serverI18n();
      return sampler.report(app.hub, APP_VERSION, { locale, direction });
    },
    version: APP_VERSION,
    urls: [
      ['Editor', `http://localhost:${config.port}/`],
      ...lanAddresses.map((addr): [string, string] => [
        'Output',
        `http://${addr}:${config.port}/play/<project>/<composition>`,
      ]),
    ],
    log: tail,
    describe: describeAgent,
  });
  dashboard.start();
  handleShutdown(app, dashboard, tail);
}

/**
 * Ctrl+C under the dashboard.
 *
 * The terminal has to be handed back — alternate screen left, cursor shown —
 * before anything else is printed, or the shell comes back invisible. Then the
 * last of the log goes to the normal screen, because whatever the server said
 * just before it stopped is the thing most likely to be wanted.
 *
 * A second Ctrl+C exits at once, and a close that hangs is cut off after three
 * seconds: an open browser source can hold a socket, and an operator pressing
 * Ctrl+C wants a prompt, not a lesson in keep-alive.
 */
function handleShutdown(app: FastifyInstance, dashboard: Dashboard, tail: LogTail): void {
  let stopping = false;

  const shutdown = (): void => {
    if (stopping) process.exit(130);
    stopping = true;
    dashboard.stop();
    const last = tail.plain(20);
    if (last.length > 0) process.stdout.write(`${last.join('\n')}\n`);
    process.stdout.write('Stopping Breeze Overlay…\n');
    setTimeout(() => process.exit(0), 3000).unref();
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Whatever else ends the process, the terminal is restored.
  process.on('exit', () => dashboard.stop());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
