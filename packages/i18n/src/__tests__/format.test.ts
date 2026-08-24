// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import {
  IcuError,
  compile,
  formatMessage,
  placeholdersOf,
  renderRich,
  serialize,
} from '../format.js';

const f = (m: string, params?: Record<string, string | number>, locale = 'en'): string =>
  formatMessage(m, locale, params);

describe('literals and arguments', () => {
  it('passes plain text through', () => {
    expect(f('Bring forward')).toBe('Bring forward');
  });

  it('substitutes a simple argument', () => {
    expect(f('Uploading {done} of {total}…', { done: 3, total: 9 })).toBe('Uploading 3 of 9…');
  });

  it('renders a missing parameter as its own name, never as undefined', () => {
    expect(f('Cell in {table}', {})).toBe('Cell in {table}');
  });

  it('treats an apostrophe before a letter as an apostrophe', () => {
    expect(f("Don't delete this")).toBe("Don't delete this");
  });

  it('escapes braces with apostrophes', () => {
    expect(f("Type '{'name'}' to bind")).toBe('Type {name} to bind');
  });

  it('reads a doubled apostrophe as one', () => {
    expect(f("it''s fine")).toBe("it's fine");
  });
});

describe('plural', () => {
  const msg = '{count, plural, =0 {No layers} one {# layer} other {# layers}}';

  it('uses the exact match ahead of the category', () => {
    expect(f(msg, { count: 0 })).toBe('No layers');
  });

  it('selects one and other in English', () => {
    expect(f(msg, { count: 1 })).toBe('1 layer');
    expect(f(msg, { count: 7 })).toBe('7 layers');
  });

  it('formats # through the locale', () => {
    expect(f('{n, plural, other {# items}}', { n: 12345 }, 'en')).toBe('12,345 items');
    expect(f('{n, plural, other {# items}}', { n: 12345 }, 'de')).toBe('12.345 items');
  });

  // The case that decides the design: two slots per message would be
  // unfixable later without touching every catalogue.
  it('honours all six Arabic categories', () => {
    const ar =
      '{n, plural, zero {none} one {one} two {two} few {few} many {many} other {other}}';
    expect(f(ar, { n: 0 }, 'ar')).toBe('none');
    expect(f(ar, { n: 1 }, 'ar')).toBe('one');
    expect(f(ar, { n: 2 }, 'ar')).toBe('two');
    expect(f(ar, { n: 3 }, 'ar')).toBe('few');
    expect(f(ar, { n: 11 }, 'ar')).toBe('many');
    expect(f(ar, { n: 100 }, 'ar')).toBe('other');
  });

  it('honours the Polish few/many split', () => {
    const pl = '{n, plural, one {jeden} few {kilka} many {wiele} other {inne}}';
    expect(f(pl, { n: 1 }, 'pl')).toBe('jeden');
    expect(f(pl, { n: 3 }, 'pl')).toBe('kilka');
    expect(f(pl, { n: 25 }, 'pl')).toBe('wiele');
  });

  it('falls back to other when the locale has a category the message lacks', () => {
    expect(f('{n, plural, one {a} other {b}}', { n: 3 }, 'pl')).toBe('b');
  });

  it('collapses to other in Japanese', () => {
    expect(f('{n, plural, one {a} other {b}}', { n: 1 }, 'ja')).toBe('b');
  });
});

describe('select', () => {
  it('picks a case and falls back to other', () => {
    const m = '{kind, select, image {an image} video {a video} other {a file}}';
    expect(f(m, { kind: 'video' })).toBe('a video');
    expect(f(m, { kind: 'sprite' })).toBe('a file');
  });
});

describe('refusals', () => {
  const refuses = (m: string, needle: string): void => {
    expect(() => compile(m, 'some.key')).toThrowError(IcuError);
    expect(() => compile(m, 'some.key')).toThrowError(new RegExp(needle));
  };

  it('refuses selectordinal', () => {
    refuses('{n, selectordinal, other {#th}}', 'selectordinal is not supported');
  });

  it('refuses number, date and time skeletons', () => {
    refuses('{n, number, percent}', 'format through Intl at the call site');
    refuses('{d, date, short}', 'format through Intl at the call site');
    refuses('{t, time, short}', 'format through Intl at the call site');
  });

  it('refuses plural offset', () => {
    refuses('{n, plural, offset:1 other {#}}', 'plural offset is not supported');
  });

  it('refuses plural nested inside plural', () => {
    refuses(
      '{a, plural, other {{b, plural, other {x}}}}',
      'nested inside another plural',
    );
  });

  it('refuses an unknown plural category', () => {
    refuses('{n, plural, lots {many} other {x}}', 'is not a plural category');
  });

  it('refuses a plural or select with no other case', () => {
    refuses('{n, plural, one {x}}', 'has no `other` case');
    refuses('{g, select, male {x}}', 'has no `other` case');
  });

  it('refuses a duplicated case', () => {
    refuses('{n, plural, one {x} one {y} other {z}}', 'appears twice');
  });

  it('refuses an unclosed placeholder', () => {
    refuses('Hello {name', 'expected `,` or `}`');
    refuses('{n, plural, other {x}', 'was never closed');
    refuses('{n, plural, other {x', 'unexpected end of message');
  });

  it('refuses a stray closing brace', () => {
    refuses('100% done}', 'unmatched');
  });

  it('names the key in the error, so the check script can point at it', () => {
    expect(() => compile('{n, selectordinal, other {#}}', 'editor.layers.count')).toThrowError(
      /^editor\.layers\.count:/,
    );
  });
});

describe('serialize', () => {
  const roundTrips = (m: string): void => {
    expect(serialize(compile(serialize(compile(m))))).toBe(serialize(compile(m)));
  };

  it('round-trips structure', () => {
    roundTrips('{count, plural, =0 {No layers} one {# layer} other {# layers}}');
    roundTrips('{kind, select, image {an image} other {a file}}');
    roundTrips('Uploading {done} of {total}…');
  });

  it('re-escapes braces so the result reparses', () => {
    const src = "Type '{'name'}' to bind";
    expect(formatMessage(serialize(compile(src)), 'en')).toBe('Type {name} to bind');
  });

  it('re-escapes apostrophes', () => {
    expect(formatMessage(serialize(compile("it''s fine")), 'en')).toBe("it's fine");
  });
});

describe('placeholdersOf', () => {
  it('collects every argument a message reads, including inside cases', () => {
    const ast = compile('{n, plural, one {# of {total}} other {# of {total}}}');
    expect([...placeholdersOf(ast)].sort()).toEqual(['n', 'total']);
  });
});

describe('renderRich', () => {
  const rich = (m: string, params?: Record<string, unknown>): Array<string | unknown> =>
    renderRich(compile(m), 'en', params as never);

  it('passes non-primitives through and keeps text around them', () => {
    const el = { tag: 'code' };
    expect(rich('Set {env} once, not per source.', { env: el })).toEqual([
      'Set ',
      el,
      ' once, not per source.',
    ]);
  });

  it('merges adjacent text into one run', () => {
    expect(rich('Uploading {a} of {b} now', { a: 1, b: 2 })).toEqual(['Uploading 1 of 2 now']);
  });

  it('stringifies primitives exactly as render does', () => {
    expect(rich('{n} items', { n: 3 })).toEqual(['3 items']);
  });

  it('survives an element inside a plural branch', () => {
    const el = { tag: 'b' };
    expect(rich('{n, plural, one {# {what} file} other {# {what} files}}', { n: 2, what: el }))
      .toEqual(['2 ', el, ' files']);
  });

  it('renders a missing parameter as its own name, like render', () => {
    expect(rich('Cell in {table}', {})).toEqual(['Cell in {table}']);
  });

  // The property that lets one catalogue entry serve both paths.
  it('agrees with render when every parameter is a primitive', () => {
    const m = '{n, plural, one {# file in {where}} other {# files in {where}}}';
    for (const n of [1, 5]) {
      const params = { n, where: 'the bin' };
      expect(rich(m, params).join('')).toBe(formatMessage(m, 'en', params));
    }
  });
});
