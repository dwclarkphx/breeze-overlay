// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Which locale, and which way it reads.
 *
 * Breeze does not detect a locale (I18N.md §4.4). A server belongs to one
 * operation, and detection would show two crew members two languages for the
 * same buttons. The locale is `BREEZE_LOCALE`, resolved once at start-up, with
 * `?lang=` as an explicit override that exists so the pseudo-locales and the
 * RTL spec can run against a server whose env says `en`.
 */

/** The source locale. Merged under every catalogue so a missing key is never raw. */
export const SOURCE_LOCALE = 'en';

/**
 * Right-to-left languages, hardcoded.
 *
 * `Intl.Locale.prototype.getTextInfo()` would answer this, but it only reached
 * Baseline in July 2026 and Breeze's client target is `chrome100` inside OBS and
 * vMix CEF builds that lag mainline browsers considerably. Four entries is a
 * cheaper answer than a capability check that differs across the wire.
 */
export const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'he', 'fa', 'ur']);

/** Pseudo-locales. Generated from `en`, never stored, never on the shipped list. */
export const PSEUDO_LOCALES: ReadonlySet<string> = new Set(['en-XA', 'ar-XB']);

/**
 * Normalise a BCP-47 tag's casing without validating it: `PT-br` → `pt-BR`,
 * `zh-hans` → `zh-Hans`. Tags arrive from env files and query strings, where
 * case is whatever the operator typed.
 */
export function normalizeTag(tag: string): string {
  const parts = tag.trim().replace(/_/g, '-').split('-').filter(Boolean);
  if (!parts.length) return '';
  return parts
    .map((p, i) => {
      if (i === 0) return p.toLowerCase();
      if (p.length === 4) return p[0]!.toUpperCase() + p.slice(1).toLowerCase();
      if (p.length === 2 || p.length === 3) return p.toUpperCase();
      return p.toLowerCase();
    })
    .join('-');
}

/** The language subtag, lowercased: `pt-BR` → `pt`. */
export function languageOf(tag: string): string {
  return normalizeTag(tag).split('-')[0] ?? '';
}

/**
 * `pt-BR` → `['pt-BR', 'pt', 'en']`. Always ends at the source locale, and
 * never repeats an entry, so `en-GB` gives `['en-GB', 'en']` rather than
 * `['en-GB', 'en', 'en']`.
 */
export function fallbackChain(tag: string): string[] {
  const norm = normalizeTag(tag);
  const chain: string[] = [];
  const parts = norm.split('-').filter(Boolean);
  for (let n = parts.length; n > 0; n -= 1) {
    const candidate = parts.slice(0, n).join('-');
    if (!chain.includes(candidate)) chain.push(candidate);
  }
  if (!chain.includes(SOURCE_LOCALE)) chain.push(SOURCE_LOCALE);
  return chain;
}

/**
 * BCP-47 lookup with truncation against what actually shipped.
 *
 * Returns the source locale for anything unmatched rather than throwing: a typo
 * in `env.breeze` must log a line and start the server, not take the panels
 * down. The caller is expected to notice `matched === false` and say so once.
 */
export function resolveLocale(
  requested: string | undefined,
  available: Iterable<string>,
): { locale: string; matched: boolean } {
  if (!requested) return { locale: SOURCE_LOCALE, matched: true };
  const norm = normalizeTag(requested);
  if (!norm) return { locale: SOURCE_LOCALE, matched: true };

  // Pseudo-locales are checked before the truncation walk, not after. `en-XA`
  // truncates to `en`, which is always shipped, so walking first would resolve
  // the pseudo-locale to plain English and silently disable the one tool that
  // finds unrouted strings.
  for (const p of PSEUDO_LOCALES) {
    if (normalizeTag(p) === norm) return { locale: p, matched: true };
  }

  // Truncation only — deliberately not `fallbackChain`, which appends the
  // source locale and would therefore report every unshipped tag as matched.
  const have = new Set<string>();
  for (const a of available) have.add(normalizeTag(a));
  const parts = norm.split('-');
  for (let n = parts.length; n > 0; n -= 1) {
    const candidate = parts.slice(0, n).join('-');
    if (have.has(candidate)) return { locale: candidate, matched: true };
  }
  return { locale: SOURCE_LOCALE, matched: false };
}

/**
 * Reading direction. `ar-XB` is the pseudo-RTL locale: English words, mirrored
 * layout, so a reviewer can tell a layout failure from a translation failure.
 */
export function directionOf(tag: string): 'ltr' | 'rtl' {
  if (normalizeTag(tag) === normalizeTag('ar-XB')) return 'rtl';
  return RTL_LANGUAGES.has(languageOf(tag)) ? 'rtl' : 'ltr';
}

export function isRtl(tag: string): boolean {
  return directionOf(tag) === 'rtl';
}
