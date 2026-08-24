// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * How the editor finds out what language to render in.
 *
 * The editor is a static bundle: it cannot read `BREEZE_LOCALE`, and there is
 * no server-rendered shell to template it into. So it asks — `/api/status`
 * carries the resolved tag (I18N.md §4.4), and the catalogue for that tag is
 * fetched as its own chunk so only the active language is downloaded.
 *
 * The first frame renders in English and swaps when the answer arrives. That is
 * acceptable here and nowhere near as bad as it sounds: the editor already
 * renders placeholder panels until the project loads, so the locale lands well
 * before there is anything on screen to read.
 */

import {
  SOURCE_LOCALE,
  isMessage,
  makeCatalogue,
  msg,
  pseudoMessages,
  sourceCatalogue,
  type Catalogue,
  type Message,
  type Messages,
} from '@breeze/i18n';
import en from '@breeze/i18n/locales/en.json';

/**
 * English is imported statically, everything else dynamically.
 *
 * It is the fallback layer every other catalogue merges over, so it is the one
 * that must never be a network round trip away — a missing key has to resolve
 * to English synchronously or the panel renders a raw key.
 */
const SOURCE = en as Messages;

/** The catalogue to render with before the server has answered. */
export const bootCatalogue: Catalogue = sourceCatalogue(SOURCE);

/**
 * Vite turns this glob into one chunk per locale and fetches only the one
 * asked for. A tag with no catalogue resolves to English rather than throwing:
 * the server has already logged the mismatch, and the editor repeating it as a
 * crash would help nobody.
 */
const CATALOGUES = import.meta.glob<{ default: Messages }>('../../../../packages/i18n/locales/*.json');

async function messagesFor(locale: string): Promise<Messages> {
  if (locale === SOURCE_LOCALE) return SOURCE;
  if (locale === 'en-XA' || locale === 'ar-XB') return pseudoMessages(SOURCE, locale);

  const entry = Object.entries(CATALOGUES).find(([path]) => path.endsWith(`/${locale}.json`));
  if (!entry) return SOURCE;
  try {
    return (await entry[1]()).default;
  } catch {
    return SOURCE;
  }
}

/** Ask the server which locale this install runs in, and load it. */
export async function loadCatalogue(): Promise<Catalogue> {
  let locale = SOURCE_LOCALE;
  try {
    const res = await fetch('/api/status', { headers: { accept: 'application/json' } });
    if (res.ok) {
      const body = (await res.json()) as { ui?: { locale?: unknown } };
      if (typeof body.ui?.locale === 'string' && body.ui.locale) locale = body.ui.locale;
    }
  } catch {
    // Offline, or the server restarted mid-load. English is a working editor.
  }
  return makeCatalogue(locale, await messagesFor(locale), SOURCE);
}

/**
 * Mirror the language onto `<html>`.
 *
 * `lang` drives hyphenation, font fallback and screen-reader pronunciation;
 * `dir` is what Wave 3's logical properties key off. Both are set here rather
 * than in `index.html` so they follow the resolved locale instead of being
 * frozen at `en` in the markup.
 */
export function applyDocumentLocale(cat: Catalogue): void {
  const el = document.documentElement;
  el.lang = cat.locale;
  el.dir = cat.direction;
}

/**
 * An error whose text an operator will read.
 *
 * `.message` stays English so a stack trace, a devtools console and a bug
 * report all say the same thing wherever the editor is configured; `.detail`
 * carries the `Message` the UI renders. Same split as the server's error
 * contract (I18N.md §5.1): the machine-facing half is stable English, the
 * human-facing half is translated at the point of display.
 */
export class LocalizedError extends Error {
  override name = 'LocalizedError';

  constructor(
    readonly detail: Message,
    englishForLogs: string,
  ) {
    super(englishForLogs);
  }
}

/**
 * The `Message` to show for any thrown value.
 *
 * Duck-typed on `.detail` rather than testing `instanceof`, so `ApiError` can
 * carry one without importing anything from here — the api client sits below
 * this module and a dependency the other way would be a cycle.
 *
 * Anything else falls back to wrapping its English text. That is the right
 * outcome for a server refusal, whose message is deliberately English and is
 * often the only specific thing the operator has to go on.
 */
export function detailOf(error: unknown): Message {
  const detail: unknown = (error as { detail?: unknown } | null)?.detail;
  if (isMessage(detail)) return detail;
  return msg('editor.error.unexpected', {
    detail: error instanceof Error ? error.message : String(error),
  });
}
