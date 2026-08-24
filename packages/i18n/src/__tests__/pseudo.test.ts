// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { formatMessage } from '../format.js';
import { pseudoMessage, pseudoMessages } from '../pseudo.js';

describe('pseudoMessage', () => {
  it('brackets, accents and pads', () => {
    const out = formatMessage(pseudoMessage('Reset width'), 'en');
    expect(out.startsWith('[')).toBe(true);
    expect(out.endsWith(']')).toBe(true);
    expect(out).toContain('Ŕéšéţ');
    expect(out).toMatch(/~+\]$/);
  });

  it('expands by roughly 40%, which is the German length test', () => {
    const src = 'Bring forward';
    const out = formatMessage(pseudoMessage(src), 'en');
    const inner = out.slice(1, -1);
    expect(inner.length).toBeGreaterThanOrEqual(Math.ceil(src.length * 1.4));
  });

  // The reason the transform runs on the AST rather than the string: wrapping
  // the raw source in brackets turns a plural into unparseable text.
  it('keeps plural structure working', () => {
    const p = pseudoMessage('{n, plural, one {# layer} other {# layers}}');
    expect(formatMessage(p, 'en', { n: 1 })).toContain('łáýéŕ');
    expect(formatMessage(p, 'en', { n: 4 })).toContain('łáýéŕš');
  });

  it('leaves placeholder names untouched, so params still bind', () => {
    const p = pseudoMessage('Uploading {done} of {total}…');
    expect(formatMessage(p, 'en', { done: 2, total: 5 })).toContain('2');
    expect(formatMessage(p, 'en', { done: 2, total: 5 })).toContain('5');
    expect(formatMessage(p, 'en', { done: 2, total: 5 })).not.toContain('{done}');
  });

  it('keeps select structure working', () => {
    const p = pseudoMessage('{k, select, image {an image} other {a file}}');
    expect(formatMessage(p, 'en', { k: 'image' })).toContain('íɱáǧé');
  });

  it('survives escaped braces', () => {
    // The braces are literal text, so the word between them is accented like
    // any other literal — what must survive is that they reparse as braces
    // rather than as a placeholder.
    const out = formatMessage(pseudoMessage("Type '{'name'}' to bind"), 'en');
    expect(out).toContain('{\u0144\u00e1\u0271\u00e9}');
  });
});

describe('pseudoMessages', () => {
  const SOURCE = { a: 'Save', b: '{n, plural, one {# file} other {# files}}' };

  it('transforms every entry for en-XA', () => {
    const out = pseudoMessages(SOURCE, 'en-XA');
    expect(formatMessage(out['a'] as string, 'en')).toContain('Šáṽé');
  });

  it('leaves ar-XB in English — it tests layout, not translation', () => {
    expect(pseudoMessages(SOURCE, 'ar-XB')).toEqual(SOURCE);
  });

  it('passes a malformed message through rather than failing to generate', () => {
    const out = pseudoMessages({ bad: '{n, selectordinal, other {#}}' }, 'en-XA');
    expect(out['bad']).toBe('{n, selectordinal, other {#}}');
  });
});
