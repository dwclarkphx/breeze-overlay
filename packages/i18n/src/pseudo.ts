// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Pseudo-locales: the highest-value artefact in the phase (I18N.md §9).
 *
 * `en-XA` accents every literal character, brackets the message and pads it
 * 40%. Two jobs in one pass. Anything rendering unbracketed is a string that
 * was never routed through `t()` — a *visual* coverage report that finds what
 * an AST scan cannot: text assembled at runtime, strings arriving from the
 * server, labels built by concatenation. And the padding is the German and
 * Finnish length test, which matters because Breeze's properties panel is a
 * narrow column of two-up label/field rows and "Bring forward" becoming
 * "Nach vorne bringen" is exactly the case that overflows it.
 *
 * `ar-XB` leaves the words in English and only flips the direction, so a
 * reviewer can tell a layout failure from a translation failure. Reviewing a
 * mirrored panel you cannot read is not a review.
 *
 * Neither is ever written to `locales/`; both are generated from `en` at load.
 */

import { compile, mapText, serialize, textLength } from './format.js';
import type { Messages } from './catalogue.js';
import { normalizeTag } from './locale.js';

const ACCENTS: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ḋ', e: 'é', f: 'ƒ', g: 'ǧ', h: 'ĥ', i: 'í', j: 'ĵ',
  k: 'ķ', l: 'ł', m: 'ɱ', n: 'ń', o: 'ó', p: 'ƥ', q: 'ɋ', r: 'ŕ', s: 'š', t: 'ţ',
  u: 'ú', v: 'ṽ', w: 'ẃ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ḋ', E: 'É', F: 'Ƒ', G: 'Ǧ', H: 'Ĥ', I: 'Í', J: 'Ĵ',
  K: 'Ķ', L: 'Ł', M: 'Ṁ', N: 'Ń', O: 'Ó', P: 'Ƥ', Q: 'Ɋ', R: 'Ŕ', S: 'Š', T: 'Ţ',
  U: 'Ú', V: 'Ṽ', W: 'Ẃ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

function accent(s: string): string {
  let out = '';
  for (const ch of s) out += ACCENTS[ch] ?? ch;
  return out;
}

/** Ratio of padding added, as a fraction of the message's literal text. */
export const PSEUDO_EXPANSION = 0.4;

/**
 * One message through the `en-XA` transform.
 *
 * Structure survives because the transform runs on the AST: placeholders, case
 * keywords and `#` come out untouched, so `{n, plural, …}` still selects.
 */
export function pseudoMessage(message: string, key = 'message'): string {
  const ast = compile(message, key);
  const accented = mapText(ast, accent);
  const pad = Math.max(1, Math.ceil(textLength(ast) * PSEUDO_EXPANSION));
  return `[${serialize(accented)} ${'~'.repeat(pad)}]`;
}

/**
 * Generate a whole pseudo-catalogue from the source.
 *
 * A message the parser refuses is passed through unchanged rather than thrown:
 * `i18n:check` is what fails a build over a malformed message, and the
 * pseudo-locale's job is to reveal missing strings, which it cannot do if one
 * bad entry stops it generating.
 */
export function pseudoMessages(source: Messages, locale: string): Messages {
  if (normalizeTag(locale) === normalizeTag('ar-XB')) return source;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    try {
      out[k] = pseudoMessage(v, k);
    } catch {
      out[k] = v;
    }
  }
  return Object.freeze(out);
}
