#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * check-installed.mjs — is node_modules actually carrying what the manifests
 * ask for?
 *
 * The third question in a family, and the three are genuinely different:
 *
 *   check-lockfile.mjs  manifests  ↔ pnpm-lock.yaml   (did someone edit a
 *                                                      manifest and not install)
 *   this script         manifests  ↔ node_modules     (did the install happen
 *                                                      *here*)
 *   pnpm install        lockfile   → node_modules     (the fix for both)
 *
 * **Why it exists.** `ag-psd` was added to the editor, recorded in the lockfile,
 * and never installed into the working tree — because the install that resolved
 * it was run in `dev/build_test/<version>/` rather than the repo. The lockfile
 * check passed, because the lockfile was right. The failure surfaced four gates
 * later as `Rolldown failed to resolve import "ag-psd"`, which reads like a
 * bundler configuration problem; vite's own suggestion — add it to
 * `build.rolldownOptions.external` — would have silenced the error and shipped
 * an editor that throws the first time someone opens a PSD.
 *
 * A missing install is a thirty-second fix and was a twenty-minute diagnosis.
 * That asymmetry is the whole justification.
 *
 * **Directory listings, not `existsSync`.** pnpm links dependencies as symlinks
 * into `node_modules/.pnpm`, and a symlink whose target does not resolve — a
 * container mount, a moved store, a half-cleaned tree — makes `existsSync`
 * answer false for a package that is plainly installed. `readdir` reports the
 * entry either way, which is the question actually being asked: did the install
 * put this name here.
 *
 * Usage:
 *   node scripts/check-installed.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function workspaceDirs() {
  const dirs = ['.'];
  for (const parent of ['apps', 'packages']) {
    const base = path.join(root, parent);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base)) {
      if (fs.existsSync(path.join(base, entry, 'package.json'))) dirs.push(`${parent}/${entry}`);
    }
  }
  return dirs;
}

/** Entry names directly under a directory's `node_modules`, scopes included. */
function listing(dir) {
  try {
    return new Set(fs.readdirSync(path.join(root, dir, 'node_modules')));
  } catch {
    return new Set();
  }
}

const rootModules = listing('.');
const missing = [];

for (const dir of workspaceDirs()) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
  const local = listing(dir);

  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (name.startsWith('//')) continue;
      // Workspace links are created by pnpm from the workspace itself; if one is
      // absent the install is broken in a way this script cannot usefully add to.
      if (typeof spec === 'string' && spec.startsWith('workspace:')) continue;

      // A scoped package appears under its scope directory, so `@types/react`
      // is found by looking for `@types`.
      const key = name.startsWith('@') ? name.split('/')[0] : name;
      if (local.has(key) || local.has(name) || rootModules.has(key) || rootModules.has(name)) continue;

      missing.push(`${dir}: ${name}@${spec} (${section})`);
    }
  }
}

if (missing.length) {
  console.error('✖ packages in the manifests are not installed in this tree:\n');
  for (const entry of missing) console.error(`  ${entry}`);
  console.error(
    '\nRun `pnpm install` here. If an install seemed to succeed recently, check\n' +
      'which directory it ran in — installing inside dev/build_test/<version>/\n' +
      'leaves the repo itself untouched.',
  );
  process.exit(1);
}

console.log(`✔ every manifest dependency is installed across ${workspaceDirs().length} workspace projects`);
