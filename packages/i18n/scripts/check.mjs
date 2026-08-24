// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * `pnpm i18n:check` — the gate that keeps the catalogue and the source honest.
 *
 * Runs with the instant gates in CI, before the build, so it fails in seconds
 * with a file and a key rather than four minutes later. Reads the repo with
 * `node:fs` and nothing else: no parser, no dependency, no build step, so it
 * can run before `pnpm install` has finished being interesting.
 *
 * Five rules fail the build and two only report. The split matters
 * (I18N.md §10): on a one-maintainer project a gate that fails every time an
 * English string is added — because 27 catalogues instantly fall behind — is a
 * gate that gets skipped within a fortnight, and a skipped gate is worse than
 * no gate.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findCandidates, findPhysical, stripComments } from './detect.mjs';
import { readMessage } from './icu-lite.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const localesDir = path.join(pkgRoot, 'locales');

const SOURCE_LOCALE = 'en';
const SHIP_THRESHOLD = 0.95;

/** Namespaces a catalogue key may start with. Anything else is not a key. */
/*
 * `runtime` joins `schema` for the same reason: both packages own label tables
 * the editor renders — `TEXT_ANIM_PRESETS`, `ROW_ANIM_PRESETS` — and a table
 * carrying display text is a table that has to carry keys instead. The package
 * never translates them; it only names them.
 */
const KEY_NAMESPACES = ['editor', 'server', 'schema', 'runtime', 'error', 'control', 'portal', 'backup', 'activity', 'docs'];
const KEY_RE = new RegExp(`^(?:${KEY_NAMESPACES.join('|')})\\.[A-Za-z0-9_.-]+$`);
/*
 * Quotes only — no backticks. A key is never written in a template literal
 * (`t(\`…\`)` is refused as a dynamic call two rules down), and in a doc
 * comment a backtick is markdown: `runtime.ts` and `schema.ts` are filenames
 * mentioned in prose, and both were briefly read as missing catalogue keys.
 */
const KEY_LITERAL_RE = new RegExp(`(['\"])((?:${KEY_NAMESPACES.join('|')})\\.[A-Za-z0-9_.-]+)\\1`, 'g');

const config = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'i18n.config.json'), 'utf8'));

const SCAN_ROOTS = ['apps/editor/src', 'apps/server/src', 'apps/server/client', 'packages/schema/src', 'packages/runtime/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__']);

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      yield full;
    }
  }
}

const sources = SCAN_ROOTS.flatMap((r) => [...walk(path.join(repoRoot, r))]);
const rel = (f) => path.relative(repoRoot, f).split(path.sep).join('/');

// ── catalogues ────────────────────────────────────────────────────────────────
const catalogues = new Map();
for (const name of fs.readdirSync(localesDir)) {
  if (!name.endsWith('.json')) continue;
  const tag = name.slice(0, -5);
  try {
    catalogues.set(tag, JSON.parse(fs.readFileSync(path.join(localesDir, name), 'utf8')));
  } catch (err) {
    console.error(`✖ locales/${name} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}
const source = catalogues.get(SOURCE_LOCALE);
if (!source) {
  console.error(`✖ locales/${SOURCE_LOCALE}.json is missing — it is the key set everything else is measured against.`);
  process.exit(1);
}

// ── collect what the source actually references ───────────────────────────────
const referenced = new Map(); // key -> [files]
const dynamicCalls = [];      // suspicious t(`...`) / t('a' + b)

for (const file of sources) {
  // Comment-stripped: a key named in a doc comment, or one left behind in
  // commented-out code, is not a reference.
  const text = stripComments(fs.readFileSync(file, 'utf8'));

  /*
   * Anchored on the key's own shape, not on quote pairing.
   *
   * The obvious version — match every quoted string, keep the ones that look
   * like keys — cannot see a key inside a differently-quoted string, and the
   * server builds every page that way: `title="${escapeHtml(t('server.pages.x'))}"`
   * has the whole attribute matched as one double-quoted literal, with the key
   * consumed inside it. An empty `''` desynchronises it just as badly. Three
   * genuinely-referenced keys were being reported as dead before this, which is
   * the report that is supposed to find dead keys.
   *
   * Requiring a namespace prefix and a closing quote of the same kind makes the
   * match local to the key, so what surrounds it stops mattering.
   */
  for (const m of text.matchAll(KEY_LITERAL_RE)) {
    const lit = m[2];
    if (!referenced.has(lit)) referenced.set(lit, []);
    referenced.get(lit).push(rel(file));
  }

  // Rule 2's practical form: a key built at runtime cannot be verified here, and
  // a frozen identifier interpolated into one is how an enum value ends up
  // translated. Both look the same to a reader, so both are refused.
  for (const m of text.matchAll(/\b(?:t|rt)\(\s*`([^`]*)`/g)) {
    if (m[1].includes('${')) dynamicCalls.push({ file: rel(file), snippet: m[0].slice(0, 60) });
  }
  for (const m of text.matchAll(/\b(?:t|rt)\(\s*'[^']*'\s*\+/g)) {
    dynamicCalls.push({ file: rel(file), snippet: m[0].slice(0, 60) });
  }
}

// ── rules ─────────────────────────────────────────────────────────────────────
const failures = [];
const notes = [];
const fail = (rule, lines) => { if (lines.length) failures.push({ rule, lines }); };

// 1. Every key the source names exists in en.json.
fail('a key is referenced but missing from en.json', 
  [...referenced.entries()]
    .filter(([k]) => !(k in source))
    .map(([k, files]) => `${k}  (${[...new Set(files)].join(', ')})`));

// 2. No dynamically built keys.
fail('a catalogue key is built at runtime, so it cannot be checked (and may be a frozen identifier)',
  dynamicCalls.map((d) => `${d.file}: ${d.snippet}…`));

// 3. No orphan keys in any translation.
for (const [tag, messages] of catalogues) {
  if (tag === SOURCE_LOCALE) continue;
  fail(`locales/${tag}.json has keys that no longer exist in en.json`,
    Object.keys(messages).filter((k) => !(k in source)));
}

// 4. Every message parses, and placeholders match en exactly.
const sourcePlaceholders = new Map();
for (const [key, msg] of Object.entries(source)) {
  const result = readMessage(msg);
  if (result instanceof Error) {
    failures.push({ rule: 'a message in en.json is outside the supported ICU subset', lines: [`${key}: ${result.message}`] });
  } else {
    sourcePlaceholders.set(key, result);
  }
}
for (const [tag, messages] of catalogues) {
  if (tag === SOURCE_LOCALE) continue;
  const bad = [];
  for (const [key, msg] of Object.entries(messages)) {
    const result = readMessage(msg);
    if (result instanceof Error) { bad.push(`${key}: ${result.message}`); continue; }
    const want = sourcePlaceholders.get(key);
    if (!want) continue;
    const missing = [...want].filter((n) => !result.has(n));
    const extra = [...result].filter((n) => !want.has(n));
    if (missing.length || extra.length) {
      bad.push(`${key}: ${missing.length ? `dropped {${missing.join('} {')}}` : ''}${missing.length && extra.length ? ', ' : ''}${extra.length ? `added {${extra.join('} {')}}` : ''}`);
    }
  }
  fail(`locales/${tag}.json has malformed or mismatched messages`, bad);
}

// 5. The ratchet: files declared swept must not regrow untranslated literals.
//
// The detection itself lives in `detect.mjs`, shared with `i18n:extract`. It
// used to live in both scripts as two copies of the same regexes, and they
// drifted: extract scanned JSX over the whole file rather than line by line, so
// it never saw the line-scoped `i18n-ignore` markers and reported debt on files
// this gate considered clean. One implementation, two callers.
const allow = new Set(config.allow ?? []);
const htmlFiles = new Set(config.html ?? []);

for (const swept of config.swept ?? []) {
  const full = path.join(repoRoot, swept);
  if (!fs.existsSync(full)) { failures.push({ rule: 'i18n.config.json lists a file that does not exist', lines: [swept] }); continue; }
  const found = findCandidates(fs.readFileSync(full, 'utf8'), {
    markup: full.endsWith('.tsx') || htmlFiles.has(swept),
    allow,
  });
  fail(
    `${swept} is marked swept but still has hardcoded UI text`,
    [...found].map(([text, { line }]) => `${swept}:${line}  "${text}"`),
  );
}

// 6. Direction: physical properties do not mirror (I18N.md §6.2).
//
// Scoped to the files that actually style chrome. Everything pinned `dir="ltr"`
// — the timeline, the stage canvas, `/play` — is listed in `config.direction`
// with the reason, so a physical property there is a declaration of intent
// rather than an omission.
const dir = config.direction ?? {};
const dirFiles = new Set(dir.files ?? []);
const STYLE_SOURCES = [
  'apps/editor/src/styles.css',
  'apps/server/src/pages.ts',
  ...(config.swept ?? []).filter((f) => f.endsWith('.tsx')),
];
for (const rel of [...new Set(STYLE_SOURCES)]) {
  if (dirFiles.has(rel)) continue;
  const full = path.join(repoRoot, rel);
  if (!fs.existsSync(full)) continue;
  const hits = findPhysical(fs.readFileSync(full, 'utf8'), {
    selectors: rel === 'apps/editor/src/styles.css' ? (dir.selectors ?? []) : [],
  });
  fail(
    `${rel} uses a physical direction property — it will not mirror under dir="rtl"`,
    hits.map((h) => `${rel}:${h.line}  ${h.text}`),
  );
}

// ── reports (never fail) ──────────────────────────────────────────────────────
const unreferenced = Object.keys(source).filter((k) => !referenced.has(k));
if (unreferenced.length) {
  notes.push(`${unreferenced.length} key(s) in en.json are not referenced by any scanned source file:\n    ` + unreferenced.join('\n    '));
}

const coverage = [];
for (const [tag, messages] of [...catalogues].sort()) {
  if (tag === SOURCE_LOCALE) continue;
  const keys = Object.keys(source);
  const have = keys.filter((k) => typeof messages[k] === 'string' && messages[k] !== '').length;
  const pct = keys.length ? have / keys.length : 1;
  coverage.push(`  ${tag.padEnd(10)} ${String(Math.round(pct * 100)).padStart(3)}%  ${have}/${keys.length}  ${pct >= SHIP_THRESHOLD ? 'shipped' : 'NOT shipped (below 95%)'}`);
}

// ── output ────────────────────────────────────────────────────────────────────
console.log(`[i18n] ${Object.keys(source).length} source keys, ${referenced.size} referenced, ${sources.length} files scanned, ${catalogues.size} catalogue(s)`);
if (coverage.length) console.log('\n[i18n] coverage\n' + coverage.join('\n'));
for (const n of notes) console.log(`\n[i18n] note: ${n}`);

if (failures.length) {
  for (const f of failures) {
    console.error(`\n✖ ${f.rule}:`);
    for (const l of f.lines) console.error(`    ${l}`);
  }
  console.error(`\n${failures.length} rule(s) failed.`);
  process.exit(1);
}
console.log('\n✔ i18n check passed');
