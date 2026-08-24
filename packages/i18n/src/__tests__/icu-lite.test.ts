// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * `scripts/icu-lite.mjs` is a second reader for the same grammar `format.ts`
 * parses — unavoidable, because `i18n:check` runs before the package is built
 * and cannot import the compiled one. Two implementations of one grammar drift,
 * so the last block here holds them to the same verdicts.
 */

import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs with no type declarations, on purpose: it has
// to stay importable by a script that runs before anything is compiled.
import { readMessage } from '../../scripts/icu-lite.mjs';
import { IcuError, compile, placeholdersOf } from '../format.js';

const read = readMessage as (m: string) => Set<string> | Error;

describe('icu-lite accepts what the subset allows', () => {
  it('reads a nested placeholder inside a plural case', () => {
    // The case that exposed the regex version: ` of {` looked like a case label.
    const r = read('{count, plural, =0 {None.} other {# of {total} will be replaced.}}');
    expect(r).toBeInstanceOf(Set);
    expect([...(r as Set<string>)].sort()).toEqual(['count', 'total']);
  });

  it('reads select with a nested placeholder', () => {
    expect([...(read('{k, select, image {an {thing}} other {a file}}') as Set<string>)].sort())
      .toEqual(['k', 'thing']);
  });

  it('treats escaped braces as literal', () => {
    expect([...(read("Type '{'name'}' to bind") as Set<string>)]).toEqual([]);
  });
});

describe('icu-lite refuses what the subset excludes', () => {
  const refuses = (m: string, needle: RegExp): void => {
    const r = read(m);
    expect(r, m).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(needle);
  };

  it('refuses selectordinal and skeletons', () => {
    refuses('{n, selectordinal, other {#}}', /not in the supported ICU subset/);
    refuses('{n, number, percent}', /not in the supported ICU subset/);
  });

  it('refuses an unknown plural category', () => refuses('{n, plural, lots {x} other {y}}', /not a plural category/));
  it('refuses a missing other case', () => refuses('{n, plural, one {x}}', /no `other` case/));
  it('refuses nested plural', () => refuses('{a, plural, other {{b, plural, other {x}}}}', /nested inside another plural|nested inside plural/));
  it('refuses plural offset', () => refuses('{n, plural, offset:1 other {#}}', /offset is not supported/));
  it('refuses a duplicate case', () => refuses('{n, plural, one {x} one {y} other {z}}', /appears twice/));
  it('refuses an unclosed placeholder', () => refuses('{n, plural, other {x}', /never closed|unexpected end/));
});

describe('the two readers agree', () => {
  const SAME = [
    'Bring forward',
    'Uploading {done} of {total}…',
    '{count, plural, one {# layer} other {# layers}}',
    '{count, plural, =0 {Nothing will be replaced.} other {# of {total} will be replaced.}}',
    '{k, select, image {an image} other {a file}}',
    "Type '{'name'}' to bind",
    "it''s fine",
  ];

  it('collect the same placeholders for every message the subset allows', () => {
    for (const m of SAME) {
      const lite = read(m);
      expect(lite, m).toBeInstanceOf(Set);
      expect([...(lite as Set<string>)].sort(), m).toEqual([...placeholdersOf(compile(m))].sort());
    }
  });

  const BOTH_REFUSE = [
    '{n, selectordinal, other {#}}',
    '{n, number, percent}',
    '{n, plural, lots {x} other {y}}',
    '{n, plural, one {x}}',
    '{a, plural, other {{b, plural, other {x}}}}',
    '{n, plural, offset:1 other {#}}',
  ];

  it('refuse the same messages', () => {
    for (const m of BOTH_REFUSE) {
      expect(read(m), m).toBeInstanceOf(Error);
      expect(() => compile(m), m).toThrowError(IcuError);
    }
  });
});
