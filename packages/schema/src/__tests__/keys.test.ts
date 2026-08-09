// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import {
  KEY_MAX_LENGTH,
  assertKey,
  isValidKey,
  normalizeKey,
  suggestKey,
} from '../keys.js';
import { makeKeyedId, uniqueKeyedId } from '../factory.js';

describe('normalizeKey', () => {
  it('lowercases', () => {
    // Not cosmetic: the project id is a directory name, and RAH-B is the same
    // folder as rah-b on Windows but a different one in the Linux container.
    expect(normalizeKey('RAH-B')).toBe('rah-b');
  });

  it('turns punctuation into separators rather than deleting it', () => {
    // Not 'randomahighs' — words must stay separable, which is also why
    // suggestKey uses initials rather than this for a multi-word name.
    expect(normalizeKey('Random A Highschool')).toBe('random-a-hig');
  });

  it('collapses runs of separators', () => {
    expect(normalizeKey('a   ---  b')).toBe('a-b');
  });

  it('strips leading and trailing separators', () => {
    expect(normalizeKey('  -bug-  ')).toBe('bug');
  });

  it('caps at the maximum length', () => {
    expect(normalizeKey('abcdefghijklmnopqrst')).toHaveLength(KEY_MAX_LENGTH);
  });

  it('does not leave a hyphen exposed by the length cut', () => {
    // 'aaaaaaaaaaa-b' cuts to 'aaaaaaaaaaa-' at 12; the trailing hyphen has to
    // go, or makeKeyedId produces 'aaaaaaaaaaa--1a2b'.
    expect(normalizeKey('aaaaaaaaaaa-b')).toBe('aaaaaaaaaaa');
  });

  it('returns empty when nothing usable survives', () => {
    expect(normalizeKey('!!!')).toBe('');
    expect(normalizeKey('   ')).toBe('');
  });
});

describe('assertKey', () => {
  it('accepts a plain key', () => {
    expect(() => assertKey('rah-b')).not.toThrow();
    expect(() => assertKey('bug')).not.toThrow();
    expect(() => assertKey('a')).not.toThrow();
    expect(() => assertKey('abcdefghijkl')).not.toThrow();
  });

  it('rejects empty, overlong, uppercase and edge hyphens', () => {
    expect(() => assertKey('')).toThrow(/empty/);
    expect(() => assertKey('abcdefghijklm')).toThrow(/at most/);
    expect(() => assertKey('RAHB')).toThrow(/lowercase/);
    expect(() => assertKey('-bug')).toThrow(/start and end/);
    expect(() => assertKey('bug-')).toThrow(/start and end/);
  });

  it('rejects characters that would need escaping in a URL or a path', () => {
    for (const bad of ['a b', 'a/b', 'a.b', 'a_b', 'a%b', '..']) {
      expect(isValidKey(bad), bad).toBe(false);
    }
  });
});

describe('suggestKey', () => {
  it('uses initials for a multi-word name', () => {
    expect(suggestKey('Random A Highschool - Basketball')).toBe('rahb');
  });

  it('falls back to a slug for a single word', () => {
    // Initials would give one useless character.
    expect(suggestKey('Basketball')).toBe('basketball');
  });

  it('returns empty for a name with nothing to work from', () => {
    expect(suggestKey('!!!')).toBe('');
  });

  it('always suggests something legal to create', () => {
    for (const name of ['Random A Highschool - Basketball', 'Basketball', 'A B C D E F G H I J K L M N']) {
      const key = suggestKey(name);
      expect(isValidKey(key), name).toBe(true);
    }
  });
});

describe('makeKeyedId', () => {
  it('puts the chosen prefix before a hyphen and the generated part after', () => {
    const id = makeKeyedId('proj', 'rahb');
    expect(id.startsWith('rahb-')).toBe(true);
    expect(id.length).toBeGreaterThan('rahb-'.length);
  });

  it('falls back to the kind when nothing was chosen', () => {
    expect(makeKeyedId('comp').startsWith('comp-')).toBe(true);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 500 }, () => makeKeyedId('comp', 'bug')));
    expect(ids.size).toBe(500);
  });
});

describe('uniqueKeyedId', () => {
  it('avoids ids already in use', () => {
    // The counter is module scope and resets with the process, so two comps
    // created in different server sessions can collide. The failure mode is one
    // composition silently overwriting another.
    const taken = new Set<string>();
    for (let i = 0; i < 50; i += 1) taken.add(uniqueKeyedId('comp', 'bug', taken));
    expect(taken.size).toBe(50);
  });

  it('returns something not in a pre-seeded taken set', () => {
    const first = makeKeyedId('comp', 'bug');
    const next = uniqueKeyedId('comp', 'bug', new Set([first]));
    expect(next).not.toBe(first);
  });
});
