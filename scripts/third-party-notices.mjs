// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Generates THIRD-PARTY-NOTICES.md from what pnpm actually installed.
 *
 *   node scripts/third-party-notices.mjs           # write the file
 *   node scripts/third-party-notices.mjs --check   # fail if it is out of date
 *
 * Generated, never hand-maintained, for the reason every attribution file is
 * eventually wrong: a dependency list written by hand records the intent at the
 * moment someone last remembered, while `pnpm licenses list` records the tree
 * that shipped. The `--check` mode is what makes that a CI failure rather than
 * a discovery.
 *
 * Production dependencies only (`--prod`). Vite, esbuild, TypeScript, Vitest
 * and Playwright are not redistributed — they build the thing and stay behind.
 * Listing them would pad the file with packages no user ever receives and make
 * the ones they *do* receive harder to find.
 *
 * GSAP is the exception this file exists to state precisely, and it is
 * deliberately not in the generated table: it is no longer a `dependency` of
 * anything, because it is no longer bundled. It ships as verbatim files under
 * `apps/server/public/vendor/gsap/`, staged by `scripts/vendor-gsap.mjs`, under
 * its own separate licence. A pnpm-derived list would omit it entirely and
 * quietly understate what a user receives, so it gets its own section above the
 * table.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(repoRoot, 'THIRD-PARTY-NOTICES.md');
const check = process.argv.includes('--check');

const gsapRequire = createRequire(path.join(repoRoot, 'packages', 'runtime', 'package.json'));

function gsapVersion() {
  try {
    return gsapRequire('gsap/package.json').version;
  } catch {
    return null;
  }
}

/**
 * Ask pnpm what is installed.
 *
 * `pnpm licenses list` reads the lockfile and the installed manifests, so it
 * sees the resolved tree rather than the semver ranges in our manifests —
 * "^5.2.0" is a wish, "5.2.4" is what a user got. Shelled out rather than
 * reimplemented: walking a pnpm store to reconstruct the production subtree is
 * a resolver, and there is already a correct one on the machine.
 */
/**
 * How to invoke pnpm without going through a shell.
 *
 * Windows is the whole problem. `pnpm` there is `pnpm.cmd`, and since the fix
 * for CVE-2024-27980 Node refuses to `execFile` a `.cmd` or `.bat` at all —
 * `EINVAL` before the process is even created. The obvious repair is
 * `shell: true`, and it works, but Node then warns DEP0190: with a shell, an
 * args array is *concatenated rather than escaped*. That is harmless for this
 * particular command line, where every argument is a fixed literal, and it is
 * still the wrong shape to leave in a repo — the day someone interpolates a
 * path into these args the warning becomes the bug, and by then the comment
 * explaining why it was safe will be describing code that has changed.
 *
 * So: run pnpm's own JavaScript entry point under the Node we are already in.
 * `npm_execpath` is set by pnpm for any script it launches — which is how this
 * one is meant to be run — and points at a `.cjs`, not a shim. No shell, no
 * deprecation, no `.cmd`, and the same resolution on every platform.
 *
 * The shell fallback stays for the case `npm_execpath` is absent: someone
 * running `node scripts/third-party-notices.mjs` directly rather than through
 * `pnpm notices`. That path still warns, and it is the path nobody uses in CI.
 */
function pnpmCommand() {
  const viaPnpm = process.env.npm_execpath;
  if (viaPnpm && /\.(c?js|mjs)$/i.test(viaPnpm)) {
    return { bin: process.execPath, prefix: [viaPnpm], shell: false };
  }
  const win = process.platform === 'win32';
  return { bin: win ? 'pnpm.cmd' : 'pnpm', prefix: [], shell: win };
}

function readLicenses() {
  const { bin, prefix, shell } = pnpmCommand();
  let raw;
  try {
    raw = execFileSync(bin, [...prefix, 'licenses', 'list', '--json', '--prod'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell,
    });
  } catch (err) {
    /*
     * The EINVAL case gets its own message.
     *
     * The generic advice below — "run pnpm install, put pnpm on PATH" — is
     * actively misleading for it: both are already true, and following it means
     * re-running a ten-minute install to fix something an install cannot touch.
     */
    if (err.code === 'EINVAL') {
      throw new Error(
        `could not spawn ${bin}. On Windows this is Node refusing to run a .cmd ` +
          'without a shell (the CVE-2024-27980 fix) — not a missing install. ' +
          'Run this through `pnpm notices` rather than `node` directly, so ' +
          'pnpm sets npm_execpath and the shell is not needed at all.',
      );
    }
    throw new Error(
      '`pnpm licenses list` failed. It needs a completed `pnpm install` and pnpm ' +
        `on PATH.\n${err.stderr || err.message}`,
    );
  }

  /*
   * Shape: { "<licence>": [ { name, version|versions[], author, homepage } ] }.
   * Read defensively — this is a CLI's JSON output, not a stable API, and the
   * failure we care about is a silently empty notices file, not a crash.
   */
  const parsed = JSON.parse(raw);
  const rows = [];
  for (const [license, entries] of Object.entries(parsed)) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const versions = entry.versions ?? (entry.version ? [entry.version] : []);
      rows.push({
        name: entry.name,
        versions: [...new Set(versions)].sort(),
        license: entry.license ?? license,
        author: typeof entry.author === 'string' ? entry.author : (entry.author?.name ?? ''),
        homepage: entry.homepage ?? '',
      });
    }
  }

  if (rows.length === 0) {
    throw new Error(
      '`pnpm licenses list --prod` returned no packages. Refusing to write an ' +
        'empty notices file — an attribution list that is wrong by omission is ' +
        'worse than one that is missing.',
    );
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function render(rows) {
  const gsap = gsapVersion();
  const byLicense = new Map();
  for (const row of rows) byLicense.set(row.license, (byLicense.get(row.license) ?? 0) + 1);
  const summary = [...byLicense.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([license, count]) => `${license} (${count})`)
    .join(', ');

  const lines = [
    '# Third-party notices',
    '',
    '<!--',
    '  Generated by scripts/third-party-notices.mjs — do not edit by hand.',
    '  Regenerate with `pnpm notices`; CI checks it with `pnpm notices:check`.',
    '-->',
    '',
    'Breeze Overlay itself is licensed under the Mozilla Public License 2.0.',
    'This file lists the third-party software distributed with it, and is',
    'generated from the installed production dependency tree rather than',
    'maintained by hand.',
    '',
    'Build-time tooling (TypeScript, Vite, esbuild, Vitest, Playwright and their',
    'dependencies) is excluded: it produces the release and is not part of it.',
    '',
    '## GSAP — separately licensed, not bundled',
    '',
    gsap
      ? `Breeze uses **GSAP ${gsap}** (GreenSock Animation Platform) as its animation`
      : 'Breeze uses **GSAP** (GreenSock Animation Platform) as its animation',
    'engine. GSAP is **not** covered by this project’s MPL-2.0 licence and is',
    '**not** compiled into any Breeze bundle.',
    '',
    'It is distributed as unmodified files under `apps/server/public/vendor/gsap/`',
    '(`gsap.min.js`, `SplitText.min.js` and their source maps), copied verbatim',
    'from the `gsap` npm package at build time by `scripts/vendor-gsap.mjs` and',
    'loaded by a script tag. Each file carries its own GreenSock licence banner.',
    'Because it is a separate file rather than bundled code, it can be replaced',
    'with a different GSAP release without rebuilding Breeze.',
    '',
    '> Copyright (c) 2008-2026, GreenSock. All rights reserved.',
    '> Subject to the terms of the GreenSock Standard License:',
    '> <https://gsap.com/standard-license>',
    '',
    '## Bundled and installed dependencies',
    '',
    `${rows.length} packages. Licences present: ${summary}.`,
    '',
    '| Package | Version | License | Author | Homepage |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const row of rows) {
    lines.push(
      `| \`${escapeCell(row.name)}\` | ${escapeCell(row.versions.join(', '))} | ` +
        `${escapeCell(row.license)} | ${escapeCell(row.author)} | ` +
        `${row.homepage ? `<${escapeCell(row.homepage)}>` : ''} |`,
    );
  }

  lines.push(
    '',
    '## Services, not dependencies',
    '',
    'Breeze can be pointed at external data providers whose terms bind the',
    'operator of an installation rather than this project. Two carry conditions',
    'worth restating: the hosted **Open-Meteo** tier and **BOM** may not be used',
    'commercially, while **MET Norway**, **DWD/Bright Sky** and **NWS** may be,',
    'subject to attribution. See the weather source documentation in the README.',
    '',
    '**ffmpeg** is used for media transcoding when present on `PATH`. It is never',
    'bundled or redistributed, so its licence does not travel with Breeze.',
    '',
  );

  return lines.join('\n');
}

const content = render(readLicenses());

/**
 * Report *what* differs, not just that something does.
 *
 * This check fails inside CI, where nobody can poke at the tree — so a bare
 * "out of date" turns a one-line fix into a local reproduction. Package rows
 * are the interesting diff (something was added, removed or bumped), and
 * they are what the summary leads with.
 */
function describeDiff(current, expected) {
  const rows = (text) =>
    new Map(
      text
        .split('\n')
        .map((line) => /^\| `([^`]+)` \| ([^|]*) \|/.exec(line))
        .filter(Boolean)
        .map((m) => [m[1], m[2].trim()]),
    );

  const before = rows(current);
  const after = rows(expected);
  const notes = [];

  for (const [name, version] of after) {
    if (!before.has(name)) notes.push(`  + ${name} ${version}`);
    else if (before.get(name) !== version) {
      notes.push(`  ~ ${name} ${before.get(name)} → ${version}`);
    }
  }
  for (const name of before.keys()) {
    if (!after.has(name)) notes.push(`  - ${name} ${before.get(name)}`);
  }

  if (notes.length === 0) {
    /*
     * The prose changed but the package table did not — almost always because
     * the generator's own wording was edited. Worth saying plainly, because
     * "no packages changed" otherwise reads as a false positive.
     */
    return '         The package list is unchanged; the surrounding text differs.';
  }
  return notes.slice(0, 40).join('\n') + (notes.length > 40 ? `\n  … and ${notes.length - 40} more` : '');
}

if (check) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
  if (current !== content) {
    console.error(
      current === null
        ? '[breeze] THIRD-PARTY-NOTICES.md is missing. Run: pnpm notices'
        : '[breeze] THIRD-PARTY-NOTICES.md is out of date — the installed\n' +
            '         dependency tree no longer matches the generated file.\n' +
            '         Run: pnpm notices\n\n' +
            describeDiff(current, content),
    );
    process.exit(1);
  }
  console.log('[breeze] THIRD-PARTY-NOTICES.md is up to date');
  process.exit(0);
}

fs.writeFileSync(outPath, content, 'utf8');
console.log(`[breeze] wrote ${path.relative(repoRoot, outPath)}`);
