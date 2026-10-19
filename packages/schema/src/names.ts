// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Display names — the shared rules for what a project or composition may be
 * called.
 *
 * A name is operator data, not an identifier (I18N.md §2): it never reaches a
 * URL, a directory or a channel key — those are all built from the id, which
 * has its own rules in `keys.ts`. So the rules here are deliberately about
 * what a *person* reads, and any script is welcome: Arabic, CJK, accented
 * Latin, emoji. What is refused is only what reads as nothing, breaks a line,
 * or overflows every place a name is shown.
 *
 *  1. Trimmed, then at least one character.
 *  2. A name made only of invisible characters is blank. Zero-width spaces,
 *     bidi marks and the like are *kept* inside a real name — ZWJ and ZWNJ are
 *     load-bearing in Persian, Indic scripts and emoji sequences — but they do
 *     not count towards it being non-empty. Otherwise a lone U+200B passes the
 *     check and prints as an empty Companion button.
 *  3. No control characters, newlines or tabs anywhere. A Companion button's
 *     text is split on a real `\n`, the activity log is one JSON line per event,
 *     and the portal lays names out in table rows.
 *  4. Normalised to NFC, so "é" typed as one code point and as e + combining
 *     acute are the same name.
 *  5. At most `NAME_MAX_LENGTH` code points — code points rather than UTF-16
 *     units, so an emoji is one character, not two.
 *  6. No uniqueness rule. The id is what is unique; two scenes called
 *     "Lower third" in different projects are perfectly ordinary.
 *
 * Like the key rules, these apply at *creation, rename and import*. The JSON
 * Schema keeps accepting any string, because `assertValidProject` runs on
 * every read and a project already on disk with an empty name must still open
 * — the same split as `KEY_PATTERN` versus `LEGACY_KEY_PATTERN`.
 */

/** Longest name accepted, in code points. Well past any button or tile. */
export const NAME_MAX_LENGTH = 64;

/** Why a name was refused. Frozen: these become error params on the wire. */
export type NameProblem = 'empty' | 'control' | 'tooLong';

/**
 * Characters that render as nothing on their own.
 *
 * `\p{Cf}` (format characters) covers the zero-width space/joiners, the bidi
 * marks, embeddings, overrides and isolates, the word joiner, the soft hyphen
 * and the BOM. The rest are invisible but not `Cf`: the Hangul fillers, which
 * are classed as letters and are the usual way blank names are smuggled past
 * a naive check, the combining grapheme joiner, and the variation selectors.
 */
const INVISIBLE = /[\s\p{Cf}\u034F\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F]/gu;

/** Control characters, plus the two Unicode line/paragraph separators. */
const CONTROL = /[\p{Cc}\u2028\u2029]/u;
const CONTROL_RUN = /[\p{Cc}\u2028\u2029]+/gu;

/** True when `raw` holds a character a name may not contain (rule 3). */
export function hasControl(raw: string): boolean {
  return CONTROL.test(raw);
}

/** Every run of control characters replaced by one space. */
export function replaceControls(raw: string): string {
  return raw.replace(CONTROL_RUN, ' ');
}

/**
 * What a name field inserts when text with control characters is pasted.
 *
 * A browser strips line breaks out of a pasted single-line value on its own,
 * silently — "Lower\nthird" arrives as "Lowerthird" with nothing to say why —
 * so a name field intercepts the paste and does this instead: a break that
 * would end up *between* two words becomes a space, and `replaced` tells the
 * field to say so under itself. A break that would end up at the very start or
 * end of the field is dropped without a notice; that is a whole line copied
 * with its newline, and nothing the operator meant has changed.
 *
 * `before` and `after` are the field's text either side of the caret, which is
 * what decides whether a break at the edge of the *pasted* text is at the edge
 * of the *name* — "⏎Third" pasted after "Lower" is between two words.
 */
export function cleanPastedName(
  text: string,
  before = '',
  after = '',
): { text: string; replaced: boolean } {
  const lead = /^[\p{Cc}\u2028\u2029]+/u.exec(text)?.[0] ?? '';
  const rest = text.slice(lead.length);
  const trail = /[\p{Cc}\u2028\u2029]+$/u.exec(rest)?.[0] ?? '';
  const inner = rest.slice(0, rest.length - trail.length);

  // An edge break joins words only if there is a word on the other side of it.
  const leadSpace = lead !== '' && /\S$/u.test(before) && inner !== '';
  const trailSpace = trail !== '' && /^\S/u.test(after) && inner !== '';

  return {
    text: `${leadSpace ? ' ' : ''}${replaceControls(inner)}${trailSpace ? ' ' : ''}`,
    replaced: hasControl(inner) || leadSpace || trailSpace,
  };
}

/** NFC and trimmed — what is stored when the name passes. */
export function normalizeName(raw: string): string {
  return raw.normalize('NFC').trim();
}

/** Length in code points, which is what the cap is measured in. */
export function nameLength(name: string): number {
  return [...name].length;
}

/** True when nothing visible would be left on screen. */
export function isBlankName(raw: string | null | undefined): boolean {
  return (raw ?? '').replace(INVISIBLE, '') === '';
}

/**
 * The first rule `raw` breaks, or null if it is a legal name.
 *
 * Checked after normalising, so a pasted name with a trailing newline is fine
 * — the newline is trimmed away — while one with a newline in the middle is
 * not.
 */
export function nameProblem(raw: string | null | undefined): NameProblem | null {
  const name = normalizeName(raw ?? '');
  if (isBlankName(name)) return 'empty';
  if (CONTROL.test(name)) return 'control';
  if (nameLength(name) > NAME_MAX_LENGTH) return 'tooLong';
  return null;
}

export class InvalidNameError extends Error {
  constructor(
    readonly input: string,
    readonly problem: NameProblem,
  ) {
    super(
      problem === 'empty'
        ? 'name must contain at least one character'
        : problem === 'control'
          ? 'name must not contain line breaks, tabs or other control characters'
          : `name must be at most ${NAME_MAX_LENGTH} characters`,
    );
    this.name = 'InvalidNameError';
  }
}

/** Throw unless `raw` is a legal name; return it normalised. */
export function assertName(raw: string | null | undefined): string {
  const problem = nameProblem(raw);
  if (problem) throw new InvalidNameError(raw ?? '', problem);
  return normalizeName(raw!);
}

/**
 * What to show for a name that may predate these rules.
 *
 * A legacy project with an empty name still opens; this is what keeps it from
 * appearing as a blank tile, a blank button or a blank row. The fallback is
 * normally the id, which is always non-empty.
 */
export function displayName(name: string | null | undefined, fallback: string): string {
  return isBlankName(name) ? fallback : name!;
}

/**
 * A starting point for fixing a refused name — what a prompt pre-fills.
 *
 * Control characters become single spaces (a line break in a name was almost
 * always meant as a space), and an over-long name is cut to the cap. An empty
 * name has nothing to suggest, so it stays empty and the operator types one.
 * The result still goes through `nameProblem`; this only saves typing.
 */
export function suggestName(raw: string | null | undefined): string {
  const flattened = normalizeName(replaceControls(raw ?? ''));
  if (isBlankName(flattened)) return '';
  return [...flattened].slice(0, NAME_MAX_LENGTH).join('').trim();
}
