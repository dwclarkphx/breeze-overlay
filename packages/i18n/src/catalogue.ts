// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * A catalogue is a frozen map of key → ICU message, with English underneath.
 *
 * The merge is not configurable. A panel showing `editor.layers.bringForward`
 * to an operator mid-show is a worse failure than a panel showing English, so a
 * key missing from the active locale falls through to the source rather than
 * rendering raw. `missingKeys()` is how the check script sees what fell through;
 * the running product never announces it.
 */

import { compileCached, render, type Node, type Params } from './format.js';
import { SOURCE_LOCALE, directionOf } from './locale.js';

export type Messages = Readonly<Record<string, string>>;

export interface Catalogue {
  readonly locale: string;
  readonly direction: 'ltr' | 'rtl';
  /** Active-locale messages merged over the source. */
  readonly messages: Messages;
  /** Keys the active locale did not supply, resolved from the source instead. */
  readonly fellBack: ReadonlySet<string>;
}

export function makeCatalogue(locale: string, active: Messages, source: Messages): Catalogue {
  const merged: Record<string, string> = { ...source };
  const fellBack = new Set<string>(Object.keys(source));
  for (const [k, v] of Object.entries(active)) {
    if (typeof v !== 'string' || v === '') continue;
    merged[k] = v;
    fellBack.delete(k);
  }
  return Object.freeze({
    locale,
    direction: directionOf(locale),
    messages: Object.freeze(merged),
    fellBack: fellBack as ReadonlySet<string>,
  });
}

/**
 * A message a non-React module can hand upward for the UI to translate.
 *
 * `state/psd-file.ts` and friends produce text an operator reads — "Reading the
 * file…", "clipping masks are not imported" — but they are not components and
 * cannot reach a translator. The alternatives were a module-level translator
 * bound at boot, or this. This one keeps the data flow visible: a module that
 * returns `{ key, params }` is obviously producing something for display, and
 * the translation happens exactly where the locale is known.
 *
 * It also means those strings survive a round trip through state without being
 * frozen into one language at the moment they were created.
 */
export interface Message {
  readonly key: string;
  readonly params?: Params;
}

/** Build a `Message`. Sugar, but it keeps call sites to one short line. */
export function msg(key: string, params?: Params): Message {
  return params === undefined ? { key } : { key, params };
}

/** True for a `Message`, as opposed to a plain key string. */
export function isMessage(v: unknown): v is Message {
  return typeof v === 'object' && v !== null && typeof (v as Message).key === 'string';
}

/**
 * Callable two ways: with a key and params, or with a `Message` a module built
 * earlier. The overload exists so a component reads `t(report.reason)` without
 * having to know which of the two it is holding.
 */
export interface Translate {
  (key: string, params?: Params): string;
  (message: Message): string;
}

/**
 * Build the `t()` a surface calls.
 *
 * An unknown key returns the key itself. That is deliberate and it is what the
 * pseudo-locale sweep looks for: a key on screen is a missing catalogue entry,
 * visible immediately, where a silent empty string would not be.
 */
export function makeTranslator(cat: Catalogue): Translate {
  return ((first: string | Message, maybeParams?: Params): string => {
    const key = typeof first === 'string' ? first : first.key;
    const params = typeof first === 'string' ? maybeParams : first.params;
    const message = cat.messages[key];
    if (message === undefined) return key;
    let ast: Node[];
    try {
      ast = compileCached(message, key);
    } catch {
      // A malformed message must not take a panel down at runtime; `i18n:check`
      // is where this is supposed to be caught, and it fails the build there.
      return message;
    }
    return render(ast, cat.locale, params ?? {});
  }) as Translate;
}

/** The catalogue every other one is merged over. */
export function sourceCatalogue(source: Messages): Catalogue {
  return makeCatalogue(SOURCE_LOCALE, source, source);
}

/** Coverage as a 0..1 fraction, for the ship threshold and the startup line. */
export function coverageOf(active: Messages, source: Messages): number {
  const keys = Object.keys(source);
  if (!keys.length) return 1;
  let have = 0;
  for (const k of keys) {
    const v = active[k];
    if (typeof v === 'string' && v !== '') have += 1;
  }
  return have / keys.length;
}
