// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The React binding — the only React in this package, and a separate entry
 * point so the server and the esbuild client bundles never pull it in.
 *
 * Deliberately thin. The formatter, the catalogue and the locale rules live in
 * plain TypeScript because three different renderers share them (I18N.md §4.1);
 * this file is a context and two hooks over the top.
 */

import {
  Fragment,
  createContext,
  createElement,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';

import {
  makeCatalogue,
  makeTranslator,
  type Catalogue,
  type Message,
  type Translate,
} from './catalogue.js';
import { compileCached, renderRich, type Params, type RichParams } from './format.js';
import { SOURCE_LOCALE } from './locale.js';

export interface I18n {
  readonly locale: string;
  readonly direction: 'ltr' | 'rtl';
  readonly t: Translate;
  /**
   * The catalogue itself, so `useRichT` can read a message *before* it is
   * formatted. Formatting first and re-parsing the result would be wrong twice
   * over: `{env}` would already have become literal text, and a plural would
   * have picked a branch from parameters it had not been given.
   */
  readonly catalogue: Catalogue;
}

const EMPTY_CATALOGUE = makeCatalogue(SOURCE_LOCALE, {}, {});

/**
 * The default renders every key as itself rather than throwing, so a component
 * mounted outside the provider — in a unit test, most often — shows visible
 * keys instead of crashing.
 */
const EMPTY: I18n = {
  locale: SOURCE_LOCALE,
  direction: 'ltr',
  // Must satisfy both overloads: a component outside the provider should show
  // the key whether it was handed one directly or inside a Message.
  t: ((first: string | Message) => (typeof first === 'string' ? first : first.key)) as Translate,
  catalogue: EMPTY_CATALOGUE,
};

const I18nContext = createContext<I18n>(EMPTY);

export function I18nProvider({
  catalogue,
  children,
}: {
  catalogue: Catalogue;
  children: ReactNode;
}): ReactNode {
  const value = useMemo<I18n>(
    () => ({
      locale: catalogue.locale,
      direction: catalogue.direction,
      t: makeTranslator(catalogue),
      catalogue,
    }),
    [catalogue],
  );
  return createElement(I18nContext.Provider, { value }, children);
}

/** Everything a component needs: the translator, the tag, and the direction. */
export function useI18n(): I18n {
  return useContext(I18nContext);
}

/**
 * The common case, so components read `const t = useT()` and then `t('key')`.
 *
 * The identity of `t` is stable for the lifetime of a catalogue, so it is safe
 * in a `useMemo`/`useCallback` dependency array — which matters, because the
 * editor's panels memoise heavily and a translator that changed every render
 * would quietly defeat that.
 */
export function useT(): Translate {
  return useContext(I18nContext).t;
}

/** A message that puts elements inside a translated sentence. */
export type RichTranslate = (key: string, params?: RichParams<ReactNode>) => ReactNode;

/**
 * `t()` for sentences with an element in the middle of them.
 *
 * The call site passes an ordinary ICU placeholder whose value happens to be an
 * element:
 *
 * ```tsx
 * const rt = useRichT();
 * rt('editor.data.weather.contactOptional', { env: <code>BREEZE_CONTACT</code> })
 * ```
 *
 * The catalogue entry stays plain text — `… for the whole server with {env}
 * rather than per source.` — so a translator can move `{env}` anywhere in the
 * sentence, and the same key still renders correctly through plain `t()` when
 * the value is a string. `renderRich` explains why this beats tags in the
 * message.
 */
export function useRichT(): RichTranslate {
  const { locale, catalogue } = useContext(I18nContext);
  return (key, params) => {
    const message = catalogue.messages[key];
    // Same contract as `t()`: an unknown key renders as itself, visibly, which
    // is what the pseudo-locale sweep looks for.
    if (message === undefined) return key;
    let pieces: Array<string | ReactNode>;
    try {
      pieces = renderRich<ReactNode>(compileCached(message, key), locale, params);
    } catch {
      // A malformed message is an `i18n:check` failure, not a dead panel.
      return message;
    }
    return createElement(
      Fragment,
      null,
      ...pieces.map((piece, i) =>
        typeof piece === 'string'
          ? piece
          : createElement(Fragment, { key: `${key}:${String(i)}` }, piece),
      ),
    );
  };
}

/**
 * Locale-aware `Intl` formatters, bound to the active locale.
 *
 * Exposed because the UI already formats dates and byte counts, and today does
 * it through the browser's default locale — `shortTime()` and the upload
 * conflict dialog both pass `undefined`. A server set to `es` showing Spanish
 * labels around browser-locale dates reads as a bug in exactly the way a
 * missing translation does.
 */
export function useFormatters(): {
  number: Intl.NumberFormat;
  dateTime: (opts?: Intl.DateTimeFormatOptions) => Intl.DateTimeFormat;
} {
  const { locale } = useContext(I18nContext);
  return useMemo(
    () => ({
      number: new Intl.NumberFormat(locale),
      dateTime: (opts?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, opts),
    }),
    [locale],
  );
}

export type { Catalogue, Message, Params, RichParams, Translate };
