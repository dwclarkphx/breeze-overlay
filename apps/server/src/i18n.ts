// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Resolving `BREEZE_LOCALE` once, at start-up.
 *
 * Nothing here reads `Accept-Language`, and nothing ever should: the locale is
 * an installation setting (I18N.md §4.4), so `/play`, `/api/*`, `/ws/control`
 * and `/healthz` are byte-identical whatever a client asks for. In Wave 1 the
 * only consumer is `/api/status`, which is how the editor — static files with
 * no access to env — finds out what language to render in.
 *
 * A bad value must not stop the server. A typo in `.env` logs one line
 * and falls back to English; taking the panels down over a misspelt language
 * tag would be a worse failure than showing the wrong one.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  SOURCE_LOCALE,
  coverageOf,
  directionOf,
  makeCatalogue,
  pseudoMessages,
  resolveLocale,
  type Catalogue,
  type Messages,
} from '@breeze/i18n';

import { config } from './config.js';

/** Coverage below which a locale is not considered shipped (I18N.md §8). */
export const SHIP_THRESHOLD = 0.95;

/**
 * `packages/i18n/locales/`, found through the package rather than by walking up
 * from here.
 *
 * The two layouts differ: in the repo this resolves under `packages/i18n/dist`,
 * in the image under whatever the Dockerfile copied. Resolving the package
 * entry and stepping to its sibling `locales/` is the one expression that is
 * correct in both — and if the Dockerfile forgot its `COPY` line for `locales`,
 * this throws here, at boot, instead of silently serving English forever.
 */
function localesDir(): URL {
  return new URL('../locales/', import.meta.resolve('@breeze/i18n'));
}

function loadAll(): Map<string, Messages> {
  const out = new Map<string, Messages>();
  let dir: URL;
  try {
    dir = localesDir();
  } catch {
    return out;
  }
  let names: string[];
  try {
    names = readdirSync(fileURLToPath(dir));
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const tag = name.slice(0, -'.json'.length);
    try {
      const raw = readFileSync(fileURLToPath(new URL(name, dir)), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.set(tag, parsed as Messages);
      }
    } catch {
      // A malformed catalogue is an i18n:check failure, not a boot failure.
    }
  }
  return out;
}

export interface ServerI18n {
  /** The tag actually in use, after resolution. */
  locale: string;
  direction: 'ltr' | 'rtl';
  catalogue: Catalogue;
  /**
   * English, always — regardless of `BREEZE_LOCALE`.
   *
   * The `error` field of an API response is English in every deployment
   * (I18N.md §5.1), so building one needs a translator that ignores the
   * configured locale. Keeping it here rather than re-reading `en.json` at each
   * call site is what stops the two drifting.
   */
  source: Catalogue;
  /** Tags at or above the ship threshold, for `/api/status` and the log line. */
  shipped: string[];
  /** One line to log at boot, or null when the configured locale was fine. */
  warning: string | null;
}

function build(requested: string): ServerI18n {
  const all = loadAll();
  const source: Messages = all.get(SOURCE_LOCALE) ?? {};

  const shipped: string[] = [];
  for (const [tag, messages] of all) {
    if (tag === SOURCE_LOCALE || coverageOf(messages, source) >= SHIP_THRESHOLD) {
      shipped.push(tag);
    }
  }
  shipped.sort();

  const { locale, matched } = resolveLocale(requested, all.keys());

  let active: Messages;
  if (locale === 'en-XA' || locale === 'ar-XB') {
    active = pseudoMessages(source, locale);
  } else {
    active = all.get(locale) ?? {};
  }

  let warning: string | null = null;
  if (!matched) {
    warning =
      `BREEZE_LOCALE="${requested}" is not a shipped locale — falling back to ` +
      `"${SOURCE_LOCALE}". Shipped: ${shipped.join(', ') || SOURCE_LOCALE}.`;
  } else if (locale !== SOURCE_LOCALE && !shipped.includes(locale)) {
    const pct = Math.round(coverageOf(active, source) * 100);
    warning =
      `BREEZE_LOCALE="${locale}" is ${String(pct)}% translated, below the ` +
      `${String(Math.round(SHIP_THRESHOLD * 100))}% ship threshold. ` +
      `Untranslated strings will render in English.`;
  } else if (all.size === 0) {
    warning = 'No locale catalogues were found — every string will render as its key.';
  }

  return {
    locale,
    direction: directionOf(locale),
    catalogue: makeCatalogue(locale, active, source),
    source: makeCatalogue(SOURCE_LOCALE, source, source),
    shipped,
    warning,
  };
}

/**
 * The subset of the active catalogue a browser bundle needs, by key prefix.
 *
 * The server-rendered pages are translated here, at render time, but the three
 * client bundles — control, portal, backup — build DOM of their own and need
 * messages in the browser. They have no `/api/status` boot the way the editor
 * does and no place to fetch from before first paint, so the page inlines what
 * they need into the same `window.__BREEZE_*` object that already carries their
 * data.
 *
 * A *slice*, not the whole catalogue. Shipping all of it would put every editor
 * string into every control-panel page load to serve the dozen a panel actually
 * uses. The namespaces already partition the catalogue by surface, so the
 * prefix is the natural cut — and it makes a key used across two surfaces
 * visible as a decision rather than a coincidence.
 *
 * Already merged over English by `makeCatalogue`, so the client can treat the
 * slice as both its active and its source layer.
 */
export function messagesFor(...prefixes: string[]): Messages {
  const { messages } = serverI18n().catalogue;
  // Built mutable and widened on return: `Messages` is `Readonly`, which is the
  // right shape for a catalogue nobody should patch after it is handed out.
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(messages)) {
    if (prefixes.some((p) => key.startsWith(p))) out[key] = value;
  }
  return out;
}

let current: ServerI18n | null = null;

/** The resolved locale for this process. Built once, on first read. */
export function serverI18n(): ServerI18n {
  current ??= build(config.locale);
  return current;
}

/** Test seam — re-resolve against a different tag. */
export function resetServerI18n(requested?: string): ServerI18n {
  current = build(requested ?? config.locale);
  return current;
}
