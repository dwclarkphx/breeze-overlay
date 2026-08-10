// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import os from 'node:os';
import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

/**
 * A port of its own, away from the dev server's 7331, so a running dev session
 * doesn't collide with a test run.
 *
 * Overridable because the host can take the port away from us. On Windows,
 * Hyper-V/WSL2 reserves blocks of ports for NAT, and those blocks move when the
 * service restarts; a port inside one fails to bind with EACCES (not EADDRINUSE
 * — nothing is listening, the OS simply won't let us have it). Check with:
 *
 *   netsh interface ipv4 show excludedportrange protocol=tcp
 *
 * If 7399 falls inside a listed range, either set BREEZE_E2E_PORT to something
 * outside every range, or claim it permanently in an elevated shell:
 *
 *   net stop winnat
 *   netsh int ipv4 add excludedportrange protocol=tcp startport=7399 numberofports=1
 *   net start winnat
 */
const PORT = process.env['BREEZE_E2E_PORT'] ?? '7399';
const ORIGIN = `http://127.0.0.1:${PORT}`;

/**
 * A data directory of the suite's own, emptied before every run.
 *
 * Without this the e2e server used the repo's `data/`, which persists — so the
 * suite both polluted a directory a developer may be using and depended on
 * whatever previous runs had left in it. That stayed invisible while the tests
 * only edited compositions the server re-seeds anyway. Uploading assets made it
 * visible immediately: the asset bin's empty-state test passed on a clean
 * checkout and failed for good afterwards, because the files from the previous
 * run were still sitting in the bin.
 *
 * A test that cannot fail twice in a row for the same reason is worse than no
 * test. `globalSetup` below clears this, and the server re-seeds the demo
 * project into it on boot, so every run starts from the same known state.
 *
 * In the OS temp dir rather than the repo so nothing needs gitignoring and a
 * crashed run leaves nothing behind that a developer has to find.
 */
const DATA_DIR = path.join(os.tmpdir(), 'breeze-e2e-data');

/**
 * The output page is the product, so the e2e suite drives a real Chromium —
 * the same engine family as vMix's Web Browser input and OBS's Browser Source.
 * Anything that passes here should behave identically on air.
 */
export default defineConfig({
  // Relative to this file, which lives in `tests/` — so `./e2e`, not
  // `./tests/e2e`. See the note on `cwd` below for the other half of this.
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  /*
   * One worker, deliberately.
   *
   * These are integration tests against a single stateful server: the control
   * hub retains channel data, and every spec that opens `/play/demo/l3rd-name`
   * joins the same channel. Running spec files in parallel had one file's
   * output page counted in another's `delivered`, and one file's retained
   * fields overwriting another's. Serializing costs about a minute of wall
   * clock and removes an entire class of false failure.
   */
  workers: 1,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: ORIGIN,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Match a browser-source viewport so measurements are 1:1.
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: {
    /**
     * Build before serving. `start` alone runs whatever is already in dist/ and
     * public/, so editing the runtime and re-running the suite would quietly
     * test the *previous* bundle — a green run that proves nothing. The whole
     * graph is built because the browser bundle inlines schema and runtime.
     */
    /*
     * The clean step is first in the chain, not in `globalSetup`.
     *
     * Playwright starts the web server *before* running `globalSetup`, so
     * clearing the data directory there deletes the projects out from under a
     * server that has already seeded and opened them — every test then fails at
     * once, with nothing in the log that points at the cause.
     */
    command:
      'node tests/e2e-clean.mjs && pnpm -r build && pnpm --filter @breeze/server start',
    /*
     * Anchored at the repo root, explicitly, and this is not optional.
     *
     * Playwright resolves `cwd` against the *config file's* directory, and this
     * config lives in `tests/`. Left as `__dirname` every relative path in the
     * command above — the clean script, the workspace filters — resolves one
     * level too deep, and the server dies with a module-not-found before a
     * single test runs. A container harness with its own config below the root
     * hit exactly this when it was the only one in that position; moving this
     * config down made it the normal case rather than the exception.
     */
    cwd: path.resolve(__dirname, '..'),
    url: `${ORIGIN}/healthz`,
    // Same trap as above: a server left running from an earlier session is
    // serving an older bundle. Always start a fresh one.
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      BREEZE_PORT: PORT,
      BREEZE_HOST: '127.0.0.1',
      BREEZE_LOG_LEVEL: 'warn',
      BREEZE_DATA_DIR: DATA_DIR,
    },
  },
});
