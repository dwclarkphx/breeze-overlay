// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Last step of the server build: give the install its own `.env`.
 *
 * At build time so the file is there *before* the first start — a key can be
 * set before the server has ever run with the control API open. The server
 * still does the same on startup, for a copy that was built somewhere else.
 *
 * Imports the compiled `load-env.js` rather than repeating it, so the build and
 * the server write the same text by the same rules: only beside `env.breeze`
 * (so never in the Docker builder, which does not copy it), never over an
 * existing file, and never failing the build over it.
 */

import { ensureUserSettingsFile, settingsFilesEnabled } from '../dist/load-env.js';

// The e2e suite builds with BREEZE_SETTINGS_FILES=off; a test run must not
// leave files behind in the checkout.
const result = settingsFilesEnabled() ? ensureUserSettingsFile() : null;
if (result && 'created' in result) {
  console.log(`Created ${result.created} for your own settings — open it to see how.`);
} else if (result && 'error' in result) {
  console.warn(`Note: ${result.error}. The server will try again on first start.`);
}
