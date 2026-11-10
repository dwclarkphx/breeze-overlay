// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * check-comments.mjs — keeps development bookkeeping out of published files.
 *
 * A comment or a doc in this repository is read by someone who has only the
 * repository. Three things mean nothing to that reader, and each fails here:
 *
 *  1. **Plan labels** — the names of the work packages a change was built in.
 *     Say what the code does; the changelog says when it arrived.
 *  2. **Private references** — a path under the unpublished development
 *     folder, or the name of a design note kept there. A reader cannot open
 *     it, so the comment has to carry the reason itself.
 *  3. **Narration** — "until now", "this release": phrasing that is only true
 *     on the day it was written. A comment describes the code as it stands.
 *
 * It also fails a file *named* after a work package, for the first reason.
 *
 *   node scripts/check-comments.mjs
 *
 * Reads the repository with node:fs and nothing else, so it runs before the
 * install. The patterns are matched on whole lines rather than only inside
 * comments: a test title or a string carrying a plan label is the same
 * problem in a different place.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ROOTS = ['apps', 'packages', 'scripts', 'tests', 'docs', '.github'];
const ROOT_FILES = ['README.md', 'CONTRIBUTING.md', 'MAINTAINING.md', 'Dockerfile', 'docker-compose.yml', 'env.breeze'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.html', '.json', '.md', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'public', 'pkg', 'images', 'test-results', 'fixtures']);
// This file names what it forbids.
const SKIP_FILES = new Set(['scripts/check-comments.mjs']);

/** Design notes that are kept private. A published file may not cite one by name. */
const PRIVATE_NOTES = [
  'ASSETS', 'BITFOCUS-MODULE', 'BRACKETS', 'CHARTS', 'CODE-NOTES', 'CYCLE', 'DATA-SOURCES',
  'DEVELOPMENT', 'GSAP-EXTERNAL', 'I18N', 'LATE-JOIN', 'MASKS', 'PHASE9', 'REVISIONS', 'ROADMAP',
  'ROLLS', 'SCENES', 'TEMPLATES', 'TESTING',
];

const RULES = [
  {
    name: 'plan label',
    pattern: /\bPhase \d|\bWave[ -](?:\d{1,2}|[A-Z])\b|\b(?:this|the|last|next|previous|earlier) wave\b|\bthis phase\b/,
    fix: 'say what the code does, not which work package built it',
  },
  {
    name: 'private reference',
    pattern: new RegExp(`\\bdev/(?:docs|build_test)\\b|\\bdev/[\\w.-]+\\.(?:md|mjs|ps1)\\b|(?<![\\w/-])(?:${PRIVATE_NOTES.join('|')})\\.md\\b`),
    fix: 'a reader cannot open it — put the reason in the comment itself',
  },
  {
    name: 'narration',
    pattern: /\buntil now\b|\bthis release\b|\bas requested\b|\bfound by auditing\b/i,
    fix: 'describe the code as it stands; history belongs in CHANGELOG.md',
  },
];

/** A file named after a work package: `data-wave3.test.ts`, `phase9-plan.md`. */
const FILE_NAME = /(?:^|[-_.])(?:wave-?[0-9a-z]|phase-?\d)(?=[-_.])/i;

/*
 * The root package.json runs the private release scripts by path. Those are
 * commands, not prose — the rule is about what a comment tells a reader.
 */
const ALLOW = [{ file: 'package.json', rule: 'private reference' }];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

const files = [];
for (const r of ROOTS) {
  const dir = path.join(root, r);
  if (fs.existsSync(dir)) files.push(...walk(dir));
}
for (const f of ROOT_FILES) {
  const full = path.join(root, f);
  if (fs.existsSync(full)) files.push(full);
}

const problems = [];
for (const full of files) {
  const rel = path.relative(root, full).split(path.sep).join('/');
  if (SKIP_FILES.has(rel)) continue;
  if (FILE_NAME.test(path.basename(rel))) {
    problems.push(`${rel}: file is named after a work package — name it for what it covers`);
  }
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue;
      if (ALLOW.some((a) => a.file === rel && a.rule === rule.name)) continue;
      problems.push(`${rel}:${i + 1}: ${rule.name} — ${rule.fix}\n    ${line.trim().slice(0, 140)}`);
    }
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n✖ ${problems.length} line(s) carry development bookkeeping. See MAINTAINING.md, "Comments and docs".`);
  process.exit(1);
}
console.log(`✔ ${files.length} published files carry no plan labels, private references or narration`);
