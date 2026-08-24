// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * `@breeze/i18n` — one catalogue, three consumers.
 *
 * The React editor, the Fastify template literals in `pages.ts` and the
 * dependency-free esbuild bundles in `apps/server/client/` all render UI, and
 * any React-bound i18n library would serve exactly one of them (I18N.md §4.1).
 * So the runtime lives here, in plain TypeScript with no dependency beyond
 * `Intl`, and the React binding is a hook on top of it — `@breeze/i18n/react`,
 * imported only by the editor.
 */

export {
  IcuError,
  compile,
  compileCached,
  formatMessage,
  mapText,
  placeholdersOf,
  render,
  renderRich,
  serialize,
  textLength,
  type Node,
  type Case,
  type Params,
  type RichParams,
} from './format.js';

export {
  coverageOf,
  isMessage,
  makeCatalogue,
  makeTranslator,
  msg,
  sourceCatalogue,
  type Catalogue,
  type Message,
  type Messages,
  type Translate,
} from './catalogue.js';

export {
  PSEUDO_LOCALES,
  RTL_LANGUAGES,
  SOURCE_LOCALE,
  directionOf,
  fallbackChain,
  isRtl,
  languageOf,
  normalizeTag,
  resolveLocale,
} from './locale.js';

export { PSEUDO_EXPANSION, pseudoMessage, pseudoMessages } from './pseudo.js';
