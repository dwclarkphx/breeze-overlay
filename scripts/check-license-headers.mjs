// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Per-file license header check (and fixer), across two license zones.
 *
 * Under MPL-2.0 the per-file notice is load-bearing: §1.4 defines Covered
 * Software as source "to which the initial Contributor has attached the
 * notice in Exhibit A". A file that silently misses the notice has quietly
 * left the copyleft — so CI fails on any source file without one. The MIT
 * zone (`integrations/`) has no such mechanic, but is checked the same way
 * for the same reason: a header nobody verifies is a header that drifts.
 *
 *   node scripts/check-license-headers.mjs          # check, exit 1 on misses
 *   node scripts/check-license-headers.mjs --fix    # prepend missing headers
 *
 * Scope: apps/, packages/, scripts/, tests/ under MPL-2.0; integrations/ under
 * MIT (below) — .ts/.tsx/.js/.mjs/.css/.html, skipping node_modules, dist and
 * apps/server/public (built output). The comment syntax varies per file type;
 * the notice sentence does not.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * Two license zones, not one. `integrations/` is Bitfocus Companion connector
 * code: their module directory requires MIT to be eligible for listing and
 * bundling in Companion itself, so it carries its own LICENSE file and its own
 * header — everything else in the repo stays MPL-2.0. Each zone is walked and
 * checked against its own sentinel/notice; a file only has to satisfy the one
 * that applies to the root it lives under.
 */
const ZONES = [
  {
    roots: ['apps', 'packages', 'scripts', 'tests'],
    // The first line of Exhibit A, verbatim. Its presence near the top of the
    // file is what the check asserts; rewording it is not an option (§ Exhibit A).
    sentinel: 'This Source Code Form is subject to the terms of the Mozilla Public',
    notice: [
      'This Source Code Form is subject to the terms of the Mozilla Public',
      'License, v. 2.0. If a copy of the MPL was not distributed with this',
      'file, You can obtain one at https://mozilla.org/MPL/2.0/.',
      '',
      'Copyright (C) 2026 Dave Clark',
      'SPDX-License-Identifier: MPL-2.0',
    ],
  },
  {
    roots: ['integrations'],
    sentinel: 'SPDX-License-Identifier: MIT',
    notice: ['Copyright (C) 2026 Dave Clark', 'SPDX-License-Identifier: MIT'],
  },
];

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.html']);
// `pkg/` is companion-module-build's packaging staging directory (bundled
// esbuild output it tars into the .tgz) — generated, not source, same as `dist/`.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'public', 'pkg']);

function headerFor(notice, ext) {
  if (ext === '.css') {
    return '/*\n' + notice.map((l) => (l ? ` * ${l}` : ' *')).join('\n') + '\n */\n\n';
  }
  if (ext === '.html') {
    return '<!--\n' + notice.map((l) => (l ? `  ${l}` : '')).join('\n') + '\n-->\n';
  }
  return notice.map((l) => (l ? `// ${l}` : '//')).join('\n') + '\n\n';
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

for (const zone of ZONES) {
  for (const top of zone.roots) {
    const dir = path.join(root, top);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const text = fs.readFileSync(file, 'utf8');
      // The notice must sit at the top of the file, not merely somewhere in it.
      const head = text.split('\n').slice(0, 12).join('\n');
      if (head.includes(zone.sentinel)) continue;
      missing.push(file);
      if (fix) {
        const ext = path.extname(file);
        let out;
        if (text.startsWith('#!')) {
          // Preserve a shebang line; the notice goes directly under it.
          const nl = text.indexOf('\n') + 1;
          out = text.slice(0, nl) + headerFor(zone.notice, ext) + text.slice(nl);
        } else {
          out = headerFor(zone.notice, ext) + text;
        }
        fs.writeFileSync(file, out);
      }
    }
  }
}

if (missing.length === 0) {
  console.log('license headers: all files carry the notice for their zone');
} else if (fix) {
  console.log(`license headers: added to ${missing.length} file(s)`);
  for (const f of missing) console.log('  + ' + path.relative(root, f));
} else {
  console.error(`license headers: ${missing.length} file(s) missing their zone's notice`);
  for (const f of missing) console.error('  ✖ ' + path.relative(root, f));
  process.exit(1);
}
