// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { networkInterfaces } from 'node:os';

import { buildApp } from './app.js';
import { config } from './config.js';
import { APP_VERSION } from './version.js';

async function main(): Promise<void> {
  const app = await buildApp();
  await app.listen({ host: config.host, port: config.port });

  const lanAddresses = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address);

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
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
