// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Empty the e2e data directory, then get out of the way.
 *
 * Runs as the first link in the webServer command chain rather than as
 * Playwright's `globalSetup`, because `globalSetup` runs *after* the web server
 * has started — so clearing the directory there deletes the projects out from
 * under a server that has already seeded and opened them, and every test fails
 * at once with nothing useful in the log.
 *
 * A node script rather than `rm -rf` in the command string because that command
 * has to run on Windows, where it does not.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Must match DATA_DIR in playwright.config.ts, beside this file.
const dir = path.join(os.tmpdir(), 'breeze-e2e-data');

// `force` so a first run, with nothing there, is not an error.
await fs.rm(dir, { recursive: true, force: true });
