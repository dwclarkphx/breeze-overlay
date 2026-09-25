// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The settings files' side effects, run at import.
 *
 * At import, not in `main()`, because `config` is evaluated once when it is
 * first imported and the files have to be in `process.env` by then. `index.ts`
 * imports this first. Nothing else may: see `load-env.ts`.
 */

import { ensureUserSettingsFile, loadSettings, settingsFilesEnabled } from './load-env.js';

const enabled = settingsFilesEnabled();

/** Before loading, though it makes no difference to the values: the file is comments only. */
export const created = enabled ? ensureUserSettingsFile() : null;
export const settings = enabled ? loadSettings() : null;
