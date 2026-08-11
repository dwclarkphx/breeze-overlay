#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * release-check.mjs — everything CI checks, before the snapshot rather than
 * after the push.
 *
 * **Why this exists.** `dev/make-release.mjs` gated version consistency and
 * (since 0.67.0) the lockfile, and nothing else. Everything CI actually
 * enforces — licence headers, third-party notices, the build, typecheck, the
 * unit suite, GSAP staging — ran only on GitHub, which meant a snapshot could
 * be taken from a tree that fails CI and the failure arrived after the push
 * with a release directory already written. That is exactly how the 0.67.0
 * lockfile drift was found.
 *
 * **CI's order, deliberately.** Cheap and specific first, so a bump that only
 * landed in the root manifest fails in a second with the filename rather than
 * eleven minutes later inside a test run. The list is meant to mirror
 * `.github/workflows/ci.yml` step for step; if the two drift, this file is
 * wrong and the workflow is right.
 *
 * **E2E is not here.** It needs browsers installed and a free port, both of
 * which fail for environmental reasons that have nothing to do with the code
 * — see the Hyper-V port-reservation note in the roadmap. A gate that fails
 * for reasons the developer cannot act on is a gate they learn to skip, and a
 * skipped gate protects nothing. Run `pnpm test:e2e` deliberately.
 *
 * Usage:
 *   node scripts/release-check.mjs          # run every gate, stop at the first failure
 *   node scripts/release-check.mjs --list   # print the gates without running them
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Node scripts are run through `process.execPath`; pnpm scripts through pnpm.
 *
 * The direct-node ones cost nothing and dodge the whole Windows `.cmd`
 * question that broke `pnpm notices` (see third-party-notices.mjs). The ones
 * that genuinely need pnpm — recursive workspace builds and tests — go through
 * the same shell-on-Windows path, with fixed arguments only.
 */
const GATES = [
  { name: 'Lockfile up to date', node: 'scripts/check-lockfile.mjs', cheap: true },
  /*
   * Immediately after the lockfile, because the two fail in adjacent ways and
   * only one of them says so clearly. A correct lockfile with an uninstalled
   * package surfaces four gates later as a bundler resolution error whose
   * suggested fix — externalise the module — is actively wrong.
   */
  { name: 'Dependencies installed', node: 'scripts/check-installed.mjs', cheap: true },
  { name: 'Version consistency', node: 'scripts/sync-version.mjs', args: ['--check'], cheap: true },
  { name: 'License headers', node: 'scripts/check-license-headers.mjs', cheap: true },
  { name: 'Third-party notices', node: 'scripts/third-party-notices.mjs', args: ['--check'], cheap: true },
  /*
   * The build is a gate, not a step that shapes the release.
   *
   * `make-release.mjs` excludes `dist/` and `apps/server/public` from both
   * copies, so nothing produced here reaches a snapshot. It earns its place for
   * two other reasons. `@breeze/schema` resolves to `./dist/index.js` and the
   * server tests have no alias back to `src`, so an unbuilt tree makes the
   * "Unit tests" gate below a test of the *previous* build — the stale-artifact
   * trap this project has hit before. And `tsc` never runs vite or esbuild, so
   * a broken asset path or a bad dynamic-import chunk fails here and nowhere
   * else.
   *
   * The cost is honest and worth stating: this writes `dist/` across the
   * workspace and re-stages GSAP into `apps/server/public/vendor/`. A server
   * running out of the repo will have its bundles change underneath it.
   */
  { name: 'Build', pnpm: ['build'], writes: true },
  { name: 'GSAP staged', node: 'scripts/vendor-gsap.mjs', args: ['--check'], cheap: true },
  { name: 'Typecheck', pnpm: ['typecheck'] },
  { name: 'Unit tests', pnpm: ['test'] },
];

if (process.argv.includes('--list')) {
  for (const gate of GATES) {
    console.log(`  ${gate.name}${gate.cheap ? '' : gate.writes ? '   (slow, writes to the tree)' : '   (slow)'}`);
  }
  process.exit(0);
}

/**
 * `--quick` runs only the gates that are instant and touch nothing.
 *
 * For the case the full run exists to make safe but does not need to be
 * repeated for: copying again minutes after a green build, having changed a
 * doc. Deliberately still runs *every* cheap gate rather than a chosen few,
 * because those are the ones that have actually caught things — the lockfile
 * twice — and they cost nothing.
 */
const quick = process.argv.includes('--quick');
const gates = quick ? GATES.filter((g) => g.cheap) : GATES;

const win = process.platform === 'win32';
const started = Date.now();

/*
 * Say what is about to happen, before it happens.
 *
 * A command called `release:copy` that silently starts a multi-minute build and
 * rewrites `dist/` is one whose first run makes you wonder whether it is doing
 * the right thing — which is a bad quality in a release tool, independently of
 * whether it *is* doing the right thing. The banner costs four lines.
 */
console.log(`Release gates (${gates.length}${quick ? ', --quick' : ''})`);
for (const gate of gates) {
  console.log(`  · ${gate.name}${gate.writes ? '  ← builds: writes dist/ and re-stages GSAP' : ''}`);
}
if (!quick) {
  console.log('\nThe build gate rewrites dist/ across the workspace and re-stages');
  console.log('apps/server/public/vendor/. A server running out of this repo will pick');
  console.log('up the new bundles. Nothing built here reaches the snapshot — dist/ and');
  console.log('apps/server/public are excluded from both release copies.');
  console.log(
    `\nUse --quick for the ${GATES.filter((g) => g.cheap).length} instant gates only. Expect a few minutes.`,
  );
}

for (const [i, gate] of gates.entries()) {
  const label = `[${i + 1}/${gates.length}] ${gate.name}`;
  console.log(`\n${label}`);
  console.log('─'.repeat(label.length));

  const result = gate.node
    ? spawnSync(process.execPath, [path.join(root, gate.node), ...(gate.args ?? [])], {
        cwd: root,
        stdio: 'inherit',
      })
    : spawnSync(win ? 'pnpm.cmd' : 'pnpm', gate.pnpm, {
        cwd: root,
        stdio: 'inherit',
        // Same reason as third-party-notices.mjs: Node refuses to execFile a
        // .cmd without a shell since the CVE-2024-27980 fix. Safe here because
        // every argument is a fixed literal from the table above.
        shell: win,
      });

  if (result.status !== 0) {
    console.error(`\n✖ ${gate.name} failed — nothing has been snapshotted.`);
    /*
     * The remaining gates are named rather than silently dropped.
     *
     * Someone who has just been told "Build failed" will fix the build and
     * re-run, and it is worth their knowing there are three more gates behind
     * it before they conclude they are done.
     */
    const remaining = gates.slice(i + 1);
    if (remaining.length) {
      console.error(`  Not run: ${remaining.map((g) => g.name).join(', ')}`);
    }
    process.exit(1);
  }
}

const seconds = Math.round((Date.now() - started) / 1000);
console.log(`\n✔ all ${gates.length} release gates passed in ${seconds}s`);
if (quick) {
  console.log('  --quick: build, typecheck and unit tests were NOT run.');
} else {
  console.log('  E2E is not included — run `pnpm test:e2e` separately.');
}
