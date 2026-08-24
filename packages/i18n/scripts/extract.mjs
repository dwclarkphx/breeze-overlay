// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * `pnpm i18n:extract [file…]` — the sweep's worklist and its catalogue fragment.
 *
 * With no arguments it reports how many hardcoded strings each unswept file
 * still has, newest debt first. With a file it prints that file's candidates
 * and the `en.json` fragment to paste, keys already generated.
 *
 * What it deliberately does **not** do is rewrite the source. Deciding whether
 * a given run of JSX is one message or three, whether a number beside it is a
 * plural, and where a `<code>` element should become a placeholder are
 * judgements a regex gets wrong quietly — and quietly wrong is the failure mode
 * this whole phase exists to avoid. Generating the keys and the English is the
 * mechanical half; wiring the call sites stays manual.
 *
 * Must never run in CI. Regenerating `en.json` during a check would turn
 * `i18n:check`'s missing-key rule into a tautology.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findCandidates } from './detect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');

const config = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'i18n.config.json'), 'utf8'));
const source = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'locales', 'en.json'), 'utf8'));
const allow = new Set(config.allow ?? []);
const htmlFiles = new Set(config.html ?? []);
const swept = new Set(config.swept ?? []);
const namespaces = config.namespaces ?? {};

/**
 * `state/` is deliberately *not* skipped: `state/commands.ts` holds the command
 * descriptions that surface in the undo tooltip — "Delete 3 keyframes" is text
 * an operator reads, however far from a component it lives.
 */
const SCAN_ROOTS = config.scan ?? ['apps/editor/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__']);

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(full); }
    else if (/\.(ts|tsx)$/.test(e.name)) yield full;
  }
}

const rel = (f) => path.relative(repoRoot, f).split(path.sep).join('/');

/** The namespace a file's keys live under. */
function namespaceFor(relPath) {
  if (namespaces[relPath]) return namespaces[relPath];
  const base = path.basename(relPath).replace(/\.(tsx?|mjs)$/, '');
  const trimmed = base.replace(/(Panel|Editor|Dialog|Dialogs|Viewport)$/, '') || base;
  return `editor.${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`;
}

/** `Bring forward` → `bringForward`; capped so a sentence does not become a key. */
function slugify(text) {
  const words = text
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  if (!words.length) return 'text';
  return words
    .map((w, i) =>
      i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join('');
}

/**
 * Candidates in one file, in source order, deduplicated by text.
 *
 * The detection rules live in `detect.mjs`, shared with `i18n:check`, so the
 * worklist and the gate can never disagree about what counts as UI text. They
 * did once: this script scanned JSX across the whole file rather than line by
 * line, which put the line-scoped `i18n-ignore` markers out of reach and left
 * finished files showing phantom debt.
 */
function candidatesIn(file) {
  return findCandidates(fs.readFileSync(file, 'utf8'), {
    markup: file.endsWith('.tsx') || htmlFiles.has(rel(file)),
    allow,
  });
}

const targets = process.argv.slice(2);

if (!targets.length) {
  // Worklist mode.
  const files = SCAN_ROOTS.flatMap((r) => {
    const full = path.join(repoRoot, r);
    return fs.existsSync(full) && fs.statSync(full).isFile() ? [full] : [...walk(full)];
  });
  const rows = [];
  let total = 0;
  for (const f of files) {
    const r = rel(f);
    const n = candidatesIn(f).size;
    if (!n) continue;
    total += swept.has(r) ? 0 : n;
    rows.push({ file: r, n, swept: swept.has(r) });
  }
  rows.sort((a, b) => Number(a.swept) - Number(b.swept) || b.n - a.n);
  console.log(`[i18n] sweep worklist — ${String(total)} string(s) left across ${String(rows.filter((r) => !r.swept).length)} file(s)\n`);
  for (const r of rows) {
    console.log(`  ${String(r.n).padStart(4)}  ${r.swept ? '✔ swept ' : '        '}${r.file}`);
  }
  console.log('\nRun with a path to see that file\'s candidates and its en.json fragment.');
  process.exit(0);
}

// Per-file mode.
for (const t of targets) {
  const full = path.isAbsolute(t) ? t : path.join(repoRoot, t);
  if (!fs.existsSync(full)) { console.error(`✖ no such file: ${t}`); process.exitCode = 1; continue; }
  const r = rel(full);
  const ns = namespaceFor(r);
  const found = candidatesIn(full);

  // Reuse an existing key when the English already appears in the catalogue —
  // a label repeated across panels should be one entry, not two that drift.
  const byText = new Map(Object.entries(source).map(([k, v]) => [v, k]));

  const fragment = {};
  const table = [];
  const used = new Set(Object.keys(source));
  for (const [text, { kind, line }] of found) {
    const existing = byText.get(text);
    if (existing) { table.push({ key: existing, text, kind, line, reused: true }); continue; }
    let key = `${ns}.${slugify(text)}`;
    let n = 2;
    while (used.has(key)) key = `${ns}.${slugify(text)}${String(n++)}`;
    used.add(key);
    fragment[key] = text;
    table.push({ key, text, kind, line, reused: false });
  }

  console.log(`\n[i18n] ${r}  →  namespace \`${ns}\`  (${String(found.size)} candidate(s))\n`);
  for (const row of table) {
    const flag = row.reused ? 'reuse' : row.kind.padEnd(5);
    console.log(`  ${flag}  ${String(row.line).padStart(5)}  ${row.key}`);
    console.log(`         "${row.text}"`);
  }
  const fresh = Object.keys(fragment).length;
  console.log(`\n  ${String(fresh)} new key(s), ${String(table.length - fresh)} reused.`);
  if (fresh) {
    console.log('\n─── en.json fragment ───');
    console.log(
      Object.entries(fragment)
        .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
        .join('\n'),
    );
  }
}
