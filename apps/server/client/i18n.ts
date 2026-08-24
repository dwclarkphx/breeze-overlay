// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * A translator for the server-rendered pages' client bundles.
 *
 * These three bundles are plain IIFEs with no React, no provider and no boot
 * request. What they do have is the `window.__BREEZE_*` object the page already
 * inlines for their data, so the messages ride in the same way: the server
 * slices its catalogue by namespace (`messagesFor` in src/i18n.ts) and writes
 * the slice, the locale and the direction into that object.
 *
 * Inlined rather than fetched because the alternative is a request between the
 * page painting and its own text appearing. On a control panel opened thirty
 * seconds before a show, a flash of untranslated markup is a worse failure than
 * a few kilobytes.
 *
 * The slice arrives already merged over English, so it serves as both layers.
 */

import { SOURCE_LOCALE, makeCatalogue, makeTranslator, type Translate } from '@breeze/i18n';

export interface I18nBoot {
  locale?: string;
  messages?: Record<string, string>;
}

export interface ClientI18n {
  t: Translate;
  locale: string;
  direction: 'ltr' | 'rtl';
}

/**
 * Never throws and never returns null.
 *
 * A page served by an older build, or one whose boot object failed to parse,
 * has no `messages` — and a panel that renders its keys is still a working
 * panel, where one that crashes on a missing catalogue is not. `makeTranslator`
 * already returns the key for anything it cannot find, so an empty catalogue
 * degrades to exactly that.
 */
export function bootI18n(boot: I18nBoot | undefined): ClientI18n {
  const locale = boot?.locale ?? SOURCE_LOCALE;
  const messages = boot?.messages ?? {};
  const catalogue = makeCatalogue(locale, messages, messages);
  return { t: makeTranslator(catalogue), locale, direction: catalogue.direction };
}
