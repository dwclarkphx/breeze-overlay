// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * What version of Breeze is this?
 *
 * Read from the server package's own `package.json` at startup rather than
 * baked in by the build or read from the repo root. Its own manifest is the one
 * file guaranteed to sit beside `dist/` in every deployment — a repo-root read
 * fails the moment the app is copied out of the workspace, and a build-time
 * constant goes stale whenever someone runs `start` on an older `dist/`.
 *
 * `scripts/sync-version.mjs` keeps that manifest equal to the root version, and
 * `make-release.mjs` runs it before every snapshot, so "its own package.json"
 * and "the product version" cannot disagree.
 */

import fs from 'node:fs';
import path from 'node:path';

import { APP_ROOT } from './config.js';

/**
 * Deliberately not `'unknown'` or `'0.0.0'`.
 *
 * A version string is quoted in bug reports, so a fallback that looks like a
 * real version is worse than one that plainly is not — `0.0.0` would send
 * someone hunting for a release that never existed.
 */
export const UNKNOWN_VERSION = 'dev';

function read(): string {
  try {
    const manifest = path.join(APP_ROOT, 'package.json');
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : UNKNOWN_VERSION;
  } catch {
    // Never fatal. A server that refuses to start because it cannot name
    // itself is a worse outcome than one that starts and says "dev".
    return UNKNOWN_VERSION;
  }
}

/** Resolved once — the file cannot change under a running process. */
export const APP_VERSION = read();

/**
 * Composition format version, which is a different thing and has its own
 * lifecycle: the app moves every week, the document format has been at 1 since
 * Phase 0. `/healthz` reported only this one, under the name `version`, which
 * is how a health check came to answer "1" when asked what was running.
 */
export { FORMAT_VERSION } from '@breeze/schema';
