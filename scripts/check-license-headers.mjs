// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * MPL-2.0 Exhibit A header check (and fixer).
 *
 * Under MPL-2.0 the per-file notice is load-bearing: §1.4 defines Covered
 * Software as source "to which the initial Contributor has attached the
 * notice in Exhibit A". A file that silently misses the notice has quietly
 * left the copyleft — so CI fails on any source file without one.
 *
 *   node scripts/check-license-headers.mjs          # check, exit 1 on misses
 *   node scripts/check-license-headers.mjs --fix    # prepend missing headers
 *
 * Scope: apps/, packages/, scripts/, tests/ — .ts/.tsx/.js/.mjs/.css/.html,
 * skipping node_modules, dist and apps/server/public (built output). The
 * comment syntax varies per file type; the Exhibit A sentence does not.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * `integrations` is in here for the same reason as the rest: MPL-2.0 copyleft
 * is file-scoped, and the Companion module ships as its own package built from
 * these sources. Being outside the pnpm workspace means nothing else in CI
 * looks at it, so without this its headers would drift unnoticed.
 */
const ROOTS = ['apps', 'integrations', 'packages', 'scripts', 'tests'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.html']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'public']);

// The first line of Exhibit A, verbatim. Its presence near the top of the
// file is what the check asserts; rewording it is not an option (§ Exhibit A).
const SENTINEL = 'This Source Code Form is subject to the terms of the Mozilla Public';

const NOTICE = [
  'This Source Code Form is subject to the terms of the Mozilla Public',
  'License, v. 2.0. If a copy of the MPL was not distributed with this',
  'file, You can obtain one at https://mozilla.org/MPL/2.0/.',
  '',
  'Copyright (C) 2026 Dave Clark',
  'SPDX-License-Identifier: MPL-2.0',
];

function headerFor(ext) {
  if (ext === '.css') {
    return '/*\n' + NOTICE.map((l) => (l ? ` * ${l}` : ' *')).join('\n') + '\n */\n\n';
  }
  if (ext === '.html') {
    return '<!--\n' + NOTICE.map((l) => (l ? `  ${l}` : '')).join('\n') + '\n-->\n';
  }
  return NOTICE.map((l) => (l ? `// ${l}` : '//')).join('\n') + '\n\n';
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

const fix = process.argv.includes('--fix');
const missing = [];

for (const top of ROOTS) {
  const dir = path.join(root, top);
  if (!fs.existsSync(dir)) continue;
  for (const file of walk(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    // The notice must sit at the top of the file, not merely somewhere in it.
    const head = text.split('\n').slice(0, 12).join('\n');
    if (head.includes(SENTINEL)) continue;
    missing.push(file);
    if (fix) {
      const ext = path.extname(file);
      let out;
      if (text.startsWith('#!')) {
        // Preserve a shebang line; the notice goes directly under it.
        const nl = text.indexOf('\n') + 1;
        out = text.slice(0, nl) + headerFor(ext) + text.slice(nl);
      } else {
        out = headerFor(ext) + text;
      }
      fs.writeFileSync(file, out);
    }
  }
}

if (missing.length === 0) {
  console.log('license headers: all files carry the Exhibit A notice');
} else if (fix) {
  console.log(`license headers: added to ${missing.length} file(s)`);
  for (const f of missing) console.log('  + ' + path.relative(root, f));
} else {
  console.error(`license headers: ${missing.length} file(s) missing the Exhibit A notice`);
  for (const f of missing) console.error('  ✖ ' + path.relative(root, f));
  process.exit(1);
}
