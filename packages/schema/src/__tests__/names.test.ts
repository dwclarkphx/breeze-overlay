// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import {
  InvalidNameError,
  NAME_MAX_LENGTH,
  assertName,
  cleanPastedName,
  displayName,
  isBlankName,
  nameLength,
  nameProblem,
  normalizeName,
  suggestName,
} from '../names.js';

const ZWSP = String.fromCodePoint(0x200b);

describe('nameProblem — rule 1, at least one character', () => {
  it.each(['', '   ', '\t', '\u00A0', '\u3000'])('refuses %j as empty', (raw) => {
    expect(nameProblem(raw)).toBe('empty');
  });

  it('treats null and undefined as empty', () => {
    expect(nameProblem(null)).toBe('empty');
    expect(nameProblem(undefined)).toBe('empty');
  });

  it('accepts one visible character', () => {
    expect(nameProblem('x')).toBeNull();
    expect(nameProblem(' x ')).toBeNull();
  });
});

describe('nameProblem — rule 2, invisible-only is blank', () => {
  it.each([
    ['zero-width space', '\u200B'],
    ['ZWJ + ZWNJ', '\u200D\u200C'],
    ['bidi marks', '\u200E\u200F\u202E\u2066'],
    ['word joiner + BOM', '\u2060\uFEFF'],
    ['soft hyphen', '\u00AD'],
    ['Hangul filler', '\u3164'],
    ['variation selector', '\uFE0F'],
    ['mixed with spaces', ' \u200B \u3164 '],
  ])('%s', (_label, raw) => {
    expect(nameProblem(raw)).toBe('empty');
  });

  it('keeps joiners inside a real name — they are load-bearing in some scripts', () => {
    const persian = 'می\u200Cخواهم';
    expect(nameProblem(persian)).toBeNull();
    expect(assertName(persian)).toBe(persian);

    const family = '👨\u200D👩\u200D👧';
    expect(nameProblem(family)).toBeNull();
  });
});

describe('nameProblem — rule 3, no control characters', () => {
  it.each([
    ['newline inside', 'Lower\nthird'],
    ['tab inside', 'Lower\tthird'],
    ['NUL', 'a\u0000b'],
    ['DEL', 'a\u007Fb'],
    ['C1 control', 'a\u0085b'],
    ['line separator', 'a\u2028b'],
    ['paragraph separator', 'a\u2029b'],
  ])('refuses %s', (_label, raw) => {
    expect(nameProblem(raw)).toBe('control');
  });

  it('trims a pasted trailing newline rather than refusing it', () => {
    expect(nameProblem('Lower third\n')).toBeNull();
    expect(assertName('Lower third\r\n')).toBe('Lower third');
  });
});

describe('rule 4 — NFC', () => {
  it('stores the composed form', () => {
    const decomposed = 'Cafe\u0301';
    expect(normalizeName(decomposed)).toBe('Café');
    expect(assertName(decomposed)).toBe(assertName('Café'));
  });
});

describe('rule 5 — length cap in code points', () => {
  it('accepts exactly the cap', () => {
    expect(nameProblem('a'.repeat(NAME_MAX_LENGTH))).toBeNull();
  });

  it('refuses one past it', () => {
    expect(nameProblem('a'.repeat(NAME_MAX_LENGTH + 1))).toBe('tooLong');
  });

  it('counts an astral emoji as one character, not two', () => {
    const emoji = '🎬'.repeat(NAME_MAX_LENGTH);
    expect(emoji.length).toBe(NAME_MAX_LENGTH * 2);
    expect(nameLength(emoji)).toBe(NAME_MAX_LENGTH);
    expect(nameProblem(emoji)).toBeNull();
  });

  it('does not count trimmed whitespace', () => {
    expect(nameProblem(`  ${'a'.repeat(NAME_MAX_LENGTH)}  `)).toBeNull();
  });
});

describe('any script is welcome', () => {
  it.each([
    'ニュース速報',
    'الأخبار العاجلة',
    'חדשות',
    'Новости — главное',
    'Ελληνικά',
    'Café & Bar <Live>',
    'Election "Night" 2026 — Governor\'s Race',
  ])('%s', (name) => {
    expect(nameProblem(name)).toBeNull();
  });
});

describe('assertName', () => {
  it('throws an InvalidNameError carrying the problem', () => {
    try {
      assertName('\u200B');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidNameError);
      expect((err as InvalidNameError).problem).toBe('empty');
    }
  });
});

describe('isBlankName / displayName', () => {
  it('falls back for a legacy blank name and keeps a real one', () => {
    expect(isBlankName('')).toBe(true);
    expect(displayName('', 'demo-1iixd')).toBe('demo-1iixd');
    expect(displayName('\u200B', 'demo-1iixd')).toBe('demo-1iixd');
    expect(displayName(undefined, 'demo-1iixd')).toBe('demo-1iixd');
    expect(displayName('Breeze Demo', 'demo-1iixd')).toBe('Breeze Demo');
  });
});

describe('suggestName', () => {
  it('turns line breaks and tabs into single spaces', () => {
    expect(suggestName('Lower\r\nthird\tA')).toBe('Lower third A');
    expect(nameProblem(suggestName('Lower\r\nthird'))).toBeNull();
  });

  it('cuts an over-long name to the cap without splitting an emoji', () => {
    const long = `${'a'.repeat(NAME_MAX_LENGTH - 1)}🎬🎬`;
    const out = suggestName(long);
    expect(nameLength(out)).toBe(NAME_MAX_LENGTH);
    expect(out.endsWith('🎬')).toBe(true);
    expect(nameProblem(out)).toBeNull();
  });

  it('suggests nothing for a blank name', () => {
    expect(suggestName('')).toBe('');
    expect(suggestName(ZWSP)).toBe('');
    expect(suggestName(undefined)).toBe('');
  });
});

describe('cleanPastedName', () => {
  it('turns a line break inside pasted text into a space, and says so', () => {
    expect(cleanPastedName('Lower\nthird')).toEqual({ text: 'Lower third', replaced: true });
    expect(cleanPastedName('a\t\tb\r\nc')).toEqual({ text: 'a b c', replaced: true });
  });

  it('drops a break at either end without a notice — a copied line, not a change', () => {
    expect(cleanPastedName('Lower third\n')).toEqual({ text: 'Lower third', replaced: false });
    expect(cleanPastedName('\r\nLower third\r\n')).toEqual({ text: 'Lower third', replaced: false });
  });

  it('leaves clean text alone', () => {
    expect(cleanPastedName('ニュース')).toEqual({ text: 'ニュース', replaced: false });
  });
});

describe('cleanPastedName — breaks at the edge of the paste, in the middle of the name', () => {
  it('becomes a space when it would join two words', () => {
    expect(cleanPastedName('\nThird', 'Lower', '')).toEqual({ text: ' Third', replaced: true });
    expect(cleanPastedName('Lower\n', '', 'Third')).toEqual({ text: 'Lower ', replaced: true });
  });

  it('is still dropped quietly at the edge of the name, or next to a space already there', () => {
    expect(cleanPastedName('\nThird', '', '')).toEqual({ text: 'Third', replaced: false });
    expect(cleanPastedName('\nThird', 'Lower ', '')).toEqual({ text: 'Third', replaced: false });
  });

  it('pastes nothing for a paste that is only line breaks', () => {
    expect(cleanPastedName('\n\n', 'Lower', 'Third')).toEqual({ text: '', replaced: false });
  });
});
