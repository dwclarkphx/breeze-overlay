// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * One version, stated consistently.
 *
 * This exists because the failure it catches is silent and long-lived: the four
 * workspace packages sat at the 0.1.0 they were scaffolded with while the
 * product reached 0.44, so `pnpm start` announced `@breeze/server@0.1.0` on a
 * machine running Phase 5 and nobody noticed for forty-odd releases. A bump that
 * only half-lands now fails here rather than in a bug report.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { APP_VERSION, UNKNOWN_VERSION } from '../version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

function versionOf(relative: string): string {
  const raw = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

/** Kept in step with `scripts/sync-version.mjs` by the last test below. */
const WORKSPACE_PACKAGES = [
  'packages/schema/package.json',
  'packages/runtime/package.json',
  'apps/server/package.json',
  'apps/editor/package.json',
];

describe('version reporting', () => {
  it('reports the server package version, not the fallback', () => {
    expect(APP_VERSION).not.toBe(UNKNOWN_VERSION);
    expect(APP_VERSION).toBe(versionOf('apps/server/package.json'));
  });

  it('matches the root package.json, which is the source of truth', () => {
    expect(APP_VERSION).toBe(versionOf('package.json'));
  });

  it('is the same across every workspace package', () => {
    const root = versionOf('package.json');
    for (const relative of WORKSPACE_PACKAGES) {
      expect(versionOf(relative), relative).toBe(root);
    }
  });

  it('looks like a version rather than a placeholder', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('lists exactly the packages the sync script knows about', () => {
    /*
     * A new workspace package added to pnpm-workspace.yaml but not to the sync
     * script would silently keep its scaffolded version — the original bug,
     * repeating. Both lists are derived from the same directories, so this
     * fails the moment they diverge.
     */
    const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'sync-version.mjs'), 'utf8');
    for (const relative of WORKSPACE_PACKAGES) {
      expect(script, `sync-version.mjs should cover ${relative}`).toContain(relative);
    }

    const onDisk = ['packages', 'apps'].flatMap((dir) =>
      fs
        .readdirSync(path.join(repoRoot, dir), { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(repoRoot, dir, e.name, 'package.json')))
        .map((e) => `${dir}/${e.name}/package.json`),
    );
    expect(onDisk.sort()).toEqual([...WORKSPACE_PACKAGES].sort());
  });
});
