// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Shared value formatting for the editor's panels.
 *
 * `formatBytes` lived in two files with identical bodies before the sweep, and
 * the sweep is what made that expensive rather than merely untidy: two copies
 * meant two sets of catalogue keys for one set of units, which a translator
 * would have to notice were the same thing and keep in step by hand.
 */

import type { Translate } from '@breeze/i18n';

/**
 * Bytes as something read at a glance — the rounding the bin has always used.
 *
 * The number goes through `Intl.NumberFormat` rather than `toFixed` because
 * `1.5 MB` is `1,5 MB` across most of Europe, and a hand-written decimal point
 * is the kind of wrong that nobody files a bug about. The unit is a catalogue
 * entry rather than a suffix, because a few locales put it in front.
 */
export function formatBytes(
  bytes: number | undefined,
  t: Translate,
  locale: string,
): string {
  if (bytes === undefined) return '';
  const fixed = (v: number, digits: number): string =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(v);
  const whole = (v: number): string => new Intl.NumberFormat(locale).format(v);

  if (bytes < 1024) return t('editor.size.b', { size: whole(bytes) });
  if (bytes < 1024 * 1024) return t('editor.size.kb', { size: whole(Math.round(bytes / 1024)) });
  if (bytes < 1024 * 1024 * 1024) {
    return t('editor.size.mb', { size: fixed(bytes / (1024 * 1024), 1) });
  }
  return t('editor.size.gb', { size: fixed(bytes / (1024 * 1024 * 1024), 2) });
}

/** `2026-08-07T…` → `7 Aug 2026`, in the active locale rather than the browser's. */
export function formatDate(iso: string | undefined, t: Translate, locale: string): string {
  if (!iso) return t('editor.date.unknown');
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return t('editor.date.unknown');
  return at.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}
