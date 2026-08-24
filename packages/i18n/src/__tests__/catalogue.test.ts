// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { coverageOf, isMessage, makeCatalogue, makeTranslator, msg } from '../catalogue.js';

const SOURCE = {
  'editor.layers.bringForward': 'Bring forward',
  'editor.layers.count': '{n, plural, one {# layer} other {# layers}}',
  'editor.assets.dateAdded': 'Date added',
};

describe('makeCatalogue', () => {
  it('merges the active locale over English', () => {
    const cat = makeCatalogue('es', { 'editor.layers.bringForward': 'Traer adelante' }, SOURCE);
    const t = makeTranslator(cat);
    expect(t('editor.layers.bringForward')).toBe('Traer adelante');
  });

  it('falls through to English for a key the locale lacks', () => {
    // Not configurable: a panel showing a raw key mid-show is the worse failure.
    const cat = makeCatalogue('es', { 'editor.layers.bringForward': 'Traer adelante' }, SOURCE);
    expect(makeTranslator(cat)('editor.assets.dateAdded')).toBe('Date added');
  });

  it('records what fell back, for the coverage report', () => {
    const cat = makeCatalogue('es', { 'editor.layers.bringForward': 'Traer adelante' }, SOURCE);
    expect([...cat.fellBack].sort()).toEqual([
      'editor.assets.dateAdded',
      'editor.layers.count',
    ]);
  });

  it('treats an empty translation as untranslated', () => {
    const cat = makeCatalogue('es', { 'editor.assets.dateAdded': '' }, SOURCE);
    expect(makeTranslator(cat)('editor.assets.dateAdded')).toBe('Date added');
    expect(cat.fellBack.has('editor.assets.dateAdded')).toBe(true);
  });

  it('carries the direction of its locale', () => {
    expect(makeCatalogue('ar', {}, SOURCE).direction).toBe('rtl');
    expect(makeCatalogue('es', {}, SOURCE).direction).toBe('ltr');
  });

  it('freezes what it hands out', () => {
    const cat = makeCatalogue('es', {}, SOURCE);
    expect(Object.isFrozen(cat)).toBe(true);
    expect(Object.isFrozen(cat.messages)).toBe(true);
  });
});

describe('makeTranslator', () => {
  it('formats in the catalogue locale, not the source locale', () => {
    const cat = makeCatalogue('pl', { 'editor.layers.count': '{n, plural, one {# warstwa} few {# warstwy} many {# warstw} other {# warstwy}}' }, SOURCE);
    expect(makeTranslator(cat)('editor.layers.count', { n: 5 })).toBe('5 warstw');
  });

  it('returns the key itself when nothing has it', () => {
    // Visible on screen, which is exactly what the pseudo-locale sweep looks for.
    expect(makeTranslator(makeCatalogue('en', {}, SOURCE))('no.such.key')).toBe('no.such.key');
  });

  it('does not throw at runtime on a malformed message', () => {
    // i18n:check is where a bad message fails the build; a panel must survive it.
    const cat = makeCatalogue('es', { bad: '{n, selectordinal, other {#}}' }, { bad: 'ok' });
    expect(makeTranslator(cat)('bad')).toBe('{n, selectordinal, other {#}}');
  });
});

describe('coverageOf', () => {
  it('measures against the source key set', () => {
    expect(coverageOf({ 'editor.layers.bringForward': 'x' }, SOURCE)).toBeCloseTo(1 / 3);
    expect(coverageOf(SOURCE, SOURCE)).toBe(1);
    expect(coverageOf({}, SOURCE)).toBe(0);
  });

  it('ignores keys the source does not have', () => {
    expect(coverageOf({ orphan: 'x' }, SOURCE)).toBe(0);
  });
});

describe('Message', () => {
  const cat = makeCatalogue('en', {}, {
    'a.plain': 'Reading the file…',
    'a.withParams': 'Uploading {done} of {total}…',
    'a.plural': '{count, plural, one {# layer} other {# layers}}',
  });
  const t = makeTranslator(cat);

  it('translates a Message the same as a key and params', () => {
    expect(t(msg('a.withParams', { done: 2, total: 5 }))).toBe('Uploading 2 of 5…');
    expect(t('a.withParams', { done: 2, total: 5 })).toBe('Uploading 2 of 5…');
  });

  it('handles a Message with no params', () => {
    expect(t(msg('a.plain'))).toBe('Reading the file…');
  });

  it('carries plurals through untouched', () => {
    expect(t(msg('a.plural', { count: 1 }))).toBe('1 layer');
    expect(t(msg('a.plural', { count: 4 }))).toBe('4 layers');
  });

  it('returns the key for an unknown Message, like a bare key', () => {
    expect(t(msg('a.missing'))).toBe('a.missing');
  });

  it('omits params entirely when none were given', () => {
    expect(msg('a.plain')).toEqual({ key: 'a.plain' });
    expect(msg('a.plain', { x: 1 })).toEqual({ key: 'a.plain', params: { x: 1 } });
  });

  it('recognises a Message but not a bare key', () => {
    expect(isMessage(msg('a.plain'))).toBe(true);
    expect(isMessage('a.plain')).toBe(false);
    expect(isMessage(null)).toBe(false);
    expect(isMessage({ params: {} })).toBe(false);
  });
});
