// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Build-time constants injected by Vite's `define`.
 *
 * Declared rather than imported: `define` performs a textual substitution
 * before TypeScript ever sees the file, so there is no module to import from
 * and no value at runtime beyond the literal that replaces it.
 */

/** The editor's version, taken from its own package.json at build time. */
declare const __APP_VERSION__: string;
