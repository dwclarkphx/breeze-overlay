// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * A dependency-free reader for the ICU subset, for `i18n:check`.
 *
 * A second implementation of what `src/format.ts` already does, which is a cost
 * worth naming: the gate runs *before* `pnpm install` and `pnpm build`, so it
 * cannot import the package's own compiled parser. Plain `.mjs` is the only
 * thing available that early.
 *
 * It is a separate file rather than inline in `check.mjs` so the package's own
 * vitest suite can test it. The first version lived in the checker, scanned for
 * `word {` with a regex, and rejected
 * `{n, plural, other {# of {total} left}}` on the grounds that `of` is not a
 * plural category — a valid message the real parser accepts. Brace depth is not
 * something a regex can see; this one counts.
 */

const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const REFUSED_ARG_TYPES = new Set([
  'selectordinal', 'number', 'date', 'time', 'duration', 'ordinal', 'spellout',
]);

class Reader {
  constructor(src) {
    this.s = src;
    this.i = 0;
    this.names = new Set();
  }

  /** ICU apostrophe escaping, matching `readQuoted` in format.ts. */
  skipQuote() {
    const next = this.s[this.i + 1];
    if (next === "'") { this.i += 2; return true; }
    if (next !== '{' && next !== '}' && next !== '#') { this.i += 1; return true; }
    this.i += 1;
    while (this.i < this.s.length) {
      if (this.s[this.i] === "'") {
        if (this.s[this.i + 1] === "'") { this.i += 2; continue; }
        this.i += 1;
        return true;
      }
      this.i += 1;
    }
    return true;
  }

  ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i += 1; }

  name() {
    const start = this.i;
    while (this.i < this.s.length && /[^\s,{}]/.test(this.s[this.i])) this.i += 1;
    return this.s.slice(start, this.i);
  }

  /** Body text up to an unmatched `}`. Returns nothing; throws on a problem. */
  body(nested, inPlural) {
    while (this.i < this.s.length) {
      const ch = this.s[this.i];
      if (ch === '}') {
        if (!nested) throw new Error("unmatched `}` — write `'}'` for a literal brace");
        return;
      }
      if (ch === "'") { this.skipQuote(); continue; }
      if (ch === '{') { this.placeholder(inPlural); continue; }
      this.i += 1;
    }
    if (nested) throw new Error('unexpected end of message — a `{` was never closed');
  }

  placeholder(inPlural) {
    this.i += 1; // '{'
    this.ws();
    const name = this.name();
    if (!name) throw new Error('expected an argument name');
    this.names.add(name);
    this.ws();

    if (this.s[this.i] === '}') { this.i += 1; return; }
    if (this.s[this.i] !== ',') throw new Error(`expected \`,\` or \`}\` after \`{${name}\``);
    this.i += 1;
    this.ws();

    const argType = this.name();
    if (REFUSED_ARG_TYPES.has(argType)) {
      throw new Error(`\`{${name}, ${argType}, …}\` is not in the supported ICU subset`);
    }
    if (argType !== 'plural' && argType !== 'select') {
      throw new Error(`\`{${name}, ${argType}, …}\` is an unknown argument type`);
    }
    if (argType === 'plural' && inPlural) {
      throw new Error('plural nested inside plural is not supported');
    }
    this.ws();
    if (this.s[this.i] !== ',') throw new Error(`expected \`,\` after \`${argType}\``);
    this.i += 1;
    this.ws();
    if (this.s.startsWith('offset:', this.i)) throw new Error('plural offset is not supported');

    const seen = new Set();
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) throw new Error(`\`{${name}, ${argType}, …}\` was never closed`);
      if (this.s[this.i] === '}') break;

      const key = this.name();
      if (!key) throw new Error(`expected a case name in \`{${name}, ${argType}, …}\``);
      if (key.startsWith('=')) {
        if (argType !== 'plural') throw new Error(`\`${key}\` is only valid in \`plural\``);
        if (!Number.isFinite(Number(key.slice(1)))) throw new Error(`\`${key}\` is not a number`);
      } else if (argType === 'plural' && !PLURAL_CATEGORIES.has(key)) {
        throw new Error(`\`${key}\` is not a plural category`);
      }
      if (seen.has(key)) throw new Error(`\`${key}\` appears twice in \`{${name}, ${argType}, …}\``);
      seen.add(key);

      this.ws();
      if (this.s[this.i] !== '{') throw new Error(`expected \`{\` after \`${key}\``);
      this.i += 1;
      this.body(true, argType === 'plural' || inPlural);
      this.i += 1; // '}'
    }
    if (!seen.has('other')) {
      throw new Error(`\`{${name}, ${argType}, …}\` has no \`other\` case`);
    }
    this.i += 1; // '}'
  }
}

/**
 * Placeholder names in a message, or an `Error` describing why it is
 * unsupported. Never throws — the caller reports, it does not crash.
 */
export function readMessage(message) {
  const r = new Reader(message);
  try {
    r.body(false, false);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  return r.names;
}
