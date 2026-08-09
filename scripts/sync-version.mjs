#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * sync-version.mjs — one version, written everywhere it is stated.
 *
 * Also the gate on version *format*: see the check below the root read.
 *
 * The root `package.json` is the single source of truth. The four workspace
 * packages are private and never published, so their versions exist only to be
 * *reported* — by pnpm's own script banner, and by the server reading its own
 * manifest at startup. Left to themselves they drift: all four sat at the 0.1.0
 * they were scaffolded with while the product reached 0.44, so `pnpm start`
 * announced `@breeze/server@0.1.0` on a machine running Phase 5.
 *
 * Usage:
 *   node scripts/sync-version.mjs          # write root version into every package
 *   node scripts/sync-version.mjs --check  # exit 1 if any differ (CI, release)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootPkgPath = path.join(root, 'package.json');
const version = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8')).version;

/*
 * MAJOR.MINOR.PATCH, three parts, digits only.
 *
 * Releases 0.37 through 0.44 were named by their folder alone — every one of
 * those manifests still says 0.1.0 inside — and `0.37` is not a valid semver
 * string at all, so nothing downstream would have accepted it as a version
 * even if it had been written down. Checked here rather than in a unit test
 * because this file runs first in CI and again at the top of every release
 * copy: a malformed version cannot reach a snapshot without passing this line.
 *
 * Pre-release suffixes (-rc.1, -beta) are rejected deliberately. There is no
 * pre-release channel, and allowing the syntax invites a tag that the release
 * script would happily freeze into `releases/breeze_overlay-1.0.0-rc.1/`.
 */
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`✖ root package.json version "${version}" is not MAJOR.MINOR.PATCH`);
  console.error('  Features bump the minor and reset the patch (0.45.0 → 0.46.0).');
  console.error('  Fixes bump the patch and leave the minor (0.45.0 → 0.45.1).');
  process.exit(1);
}

/** Workspace manifests, relative to the repo root. */
export const WORKSPACE_PACKAGES = [
  'packages/schema/package.json',
  'packages/runtime/package.json',
  'apps/server/package.json',
  'apps/editor/package.json',
];

const check = process.argv.includes('--check');

let changed = 0;
const stale = [];

for (const relative of WORKSPACE_PACKAGES) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    console.error(`✖ missing ${relative}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(file, 'utf8');
  const pkg = JSON.parse(raw);
  if (pkg.version === version) continue;

  if (check) {
    stale.push(`${relative}: ${pkg.version} (expected ${version})`);
    continue;
  }

  /*
   * Rewritten by hand rather than by re-serialising the parsed object.
   * `JSON.stringify` would reorder nothing but would reformat everything —
   * collapsing the two-space style and the inline `"files": ["dist"]` arrays —
   * turning a one-line version bump into a whole-file diff in every review.
   */
  const next = raw.replace(
    /("version"\s*:\s*)"[^"]*"/,
    (_m, prefix) => `${prefix}"${version}"`,
  );
  if (next === raw) {
    console.error(`✖ ${relative} has no "version" field to update`);
    process.exit(1);
  }

  fs.writeFileSync(file, next);
  console.log(`  ${relative} → ${version}`);
  changed += 1;
}

if (check) {
  if (stale.length) {
    console.error('✖ workspace versions are out of step with the root package.json:');
    for (const line of stale) console.error(`    ${line}`);
    console.error('  Run: node scripts/sync-version.mjs');
    process.exit(1);
  }
  console.log(`✔ all workspace packages at ${version}`);
} else {
  console.log(changed ? `✔ synced ${changed} package(s) to ${version}` : `✔ already at ${version}`);
}
