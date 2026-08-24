// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import {
  directionOf,
  fallbackChain,
  languageOf,
  normalizeTag,
  resolveLocale,
} from '../locale.js';

const SHIPPED = ['en', 'es', 'fr', 'de', 'pt-BR', 'zh-Hans', 'ar'];

describe('normalizeTag', () => {
  it('fixes the casing an operator types into env.breeze', () => {
    expect(normalizeTag('PT-br')).toBe('pt-BR');
    expect(normalizeTag('zh-hans')).toBe('zh-Hans');
    expect(normalizeTag('EN')).toBe('en');
  });

  it('accepts underscores, because people type them', () => {
    expect(normalizeTag('pt_BR')).toBe('pt-BR');
  });

  it('survives whitespace and emptiness', () => {
    expect(normalizeTag('  de  ')).toBe('de');
    expect(normalizeTag('')).toBe('');
  });
});

describe('fallbackChain', () => {
  it('truncates subtag by subtag and ends at en', () => {
    expect(fallbackChain('pt-BR')).toEqual(['pt-BR', 'pt', 'en']);
    expect(fallbackChain('de-CH')).toEqual(['de-CH', 'de', 'en']);
  });

  it('does not repeat en for an English variant', () => {
    expect(fallbackChain('en-GB')).toEqual(['en-GB', 'en']);
  });
});

describe('resolveLocale', () => {
  it('matches exactly when the locale shipped', () => {
    expect(resolveLocale('pt-BR', SHIPPED)).toEqual({ locale: 'pt-BR', matched: true });
  });

  it('truncates to a shipped parent', () => {
    expect(resolveLocale('de-CH', SHIPPED)).toEqual({ locale: 'de', matched: true });
  });

  it('reports an unshipped locale rather than throwing', () => {
    // A typo in env.breeze must log a line and start the server, not take the
    // panels down.
    expect(resolveLocale('xx', SHIPPED)).toEqual({ locale: 'en', matched: false });
    expect(resolveLocale('sv-SE', SHIPPED)).toEqual({ locale: 'en', matched: false });
  });

  it('matches an explicitly requested source locale', () => {
    expect(resolveLocale('en', SHIPPED)).toEqual({ locale: 'en', matched: true });
    expect(resolveLocale('en-GB', SHIPPED)).toEqual({ locale: 'en', matched: true });
  });

  it('defaults to en when nothing was configured', () => {
    expect(resolveLocale(undefined, SHIPPED)).toEqual({ locale: 'en', matched: true });
  });

  it('accepts the pseudo-locales even though they never ship', () => {
    expect(resolveLocale('en-XA', SHIPPED)).toEqual({ locale: 'en-XA', matched: true });
    expect(resolveLocale('ar-XB', SHIPPED)).toEqual({ locale: 'ar-XB', matched: true });
  });
});

describe('directionOf', () => {
  it('knows the four RTL languages', () => {
    for (const t of ['ar', 'he', 'fa', 'ur']) expect(directionOf(t)).toBe('rtl');
  });

  it('applies direction by language, not by full tag', () => {
    expect(directionOf('ar-EG')).toBe('rtl');
  });

  it('leaves everything else LTR', () => {
    for (const t of ['en', 'pt-BR', 'zh-Hans', 'ja', 'ru']) expect(directionOf(t)).toBe('ltr');
  });

  it('makes ar-XB RTL and en-XA LTR', () => {
    expect(directionOf('ar-XB')).toBe('rtl');
    expect(directionOf('en-XA')).toBe('ltr');
  });
});

describe('languageOf', () => {
  it('takes the language subtag', () => {
    expect(languageOf('pt-BR')).toBe('pt');
    expect(languageOf('EN-gb')).toBe('en');
  });
});
