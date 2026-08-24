// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * `scripts/detect.mjs` decides what counts as hardcoded UI text, for both
 * `i18n:check` (which fails the build on it) and `i18n:extract` (which puts it
 * on the worklist). Every rule in it exists because a regex got something
 * wrong on a real file in this repo, so each case below names the thing that
 * broke.
 */

import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs with no type declarations, on purpose: it has
// to stay importable by a script that runs before anything is compiled.
import {
  findCandidates,
  findPhysical,
  looksTranslatable,
  stripComments,
} from '../../scripts/detect.mjs';

/** Texts only, in order — the shape most assertions here care about. */
const texts = (src: string, markup = true): string[] =>
  [...(findCandidates(src, { markup }) as Map<string, { kind: string; line: number }>).keys()];

const first = (src: string, markup = true) =>
  [...(findCandidates(src, { markup }) as Map<string, { kind: string; line: number }>)][0];

describe('suppression markers', () => {
  /*
   * The regression this module was extracted for. `extract.mjs` ran its JSX
   * pass over the whole file in one `matchAll`, so a marker — which can only
   * ever mean "this line" — was never consulted, and `EasingEditor.tsx` sat on
   * the worklist forever over the tail of an arrow function that `i18n:check`
   * had been correctly ignoring all along.
   */
  it('honours an inline marker in the JSX pass, not only the literal pass', () => {
    const src = '<span>Some real label</span> // i18n-ignore\n';
    expect(texts(src)).toEqual([]);
  });

  it('honours a preceding i18n-ignore-next-line', () => {
    const src = '// i18n-ignore-next-line\n<span>Some real label</span>\n';
    expect(texts(src)).toEqual([]);
  });

  it('accepts the braced block form, which is all JSX children position allows', () => {
    // A `//` between two tags is rendered to the page as text, not treated as
    // a comment, so the marker has to be writable as `{/* … */}`.
    expect(texts('<span>Some real label</span> {/* i18n-ignore */}\n')).toEqual([]);
  });

  it('does not let i18n-ignore-next-line satisfy the same-line test', () => {
    // The negative lookahead: `i18n-ignore-next-line` on the line itself must
    // suppress the line *below*, not the line it sits on.
    expect(texts('<span>Kept here</span> // i18n-ignore-next-line\n<span>Gone below</span>\n'))
      .toEqual(['Kept here']);
  });

  it('suppresses only the marked line', () => {
    const src = '<b>First label</b> // i18n-ignore\n<b>Second label</b>\n';
    expect(texts(src)).toEqual(['Second label']);
  });
});

describe('code that only looks like markup', () => {
  it('reads a generic type parameter as a type, not element text', () => {
    // `Promise<void>` is `>`…`<` to a regex. Real element text is followed by
    // a closing tag, so a single word only counts when `/` follows.
    expect(texts('const f: Array<Thing> = [];\n')).toEqual([]);
  });

  it('reads an arrow function body as code', () => {
    // The forward guard is not enough here: the span has spaces in it, so it
    // reads as prose. What settles it is the `=` before the `>`, which no JSX
    // tag ever has. This exact line sat on the worklist under a suppression
    // marker until the lookbehind went in.
    expect(texts('keys.sort((a, b) => Math.abs(a.t - b.t) < 1e-6);\n')).toEqual([]);
  });

  it('still reads text out of an arrow function that returns JSX', () => {
    // The lookbehind must reject the arrow's own `>`, not the `>` of the tag
    // that follows it.
    expect(texts('const f = (p) => <div>Real label</div>;\n')).toEqual(['Real label']);
  });

  it('reads text that is followed by a nested element, not a closing tag', () => {
    // `<p>Some text here <b>bold</b></p>` — the first candidate's `<` opens a
    // tag rather than closing one, so the `/` rule cannot be universal.
    expect(texts('<p>Some text here <b>bold</b></p>\n')).toContain('Some text here');
  });

  it('skips the JSX pass entirely on a plain .ts file', () => {
    // `a > b && c < d` is arithmetic; the span between the operators is not text.
    expect(texts('if (count > total && other < limit) return;\n', false)).toEqual([]);
  });
});

describe('prose against near-misses', () => {
  it('keeps a className list out', () => {
    expect(looksTranslatable('panel layers-panel')).toBe(false);
  });

  it('keeps lowercase prose in, even though it has no hyphen', () => {
    // Requiring a hyphenated token is what separates the two. Without that
    // clause the class-list rule swallowed `date unknown` and `in the bin as`.
    expect(looksTranslatable('date unknown')).toBe(true);
    expect(looksTranslatable('in the bin as')).toBe(true);
  });

  it('rejects a string that is only an interpolation and punctuation', () => {
    expect(looksTranslatable('${Math.round(pct)}%')).toBe(false);
  });

  it('rejects the tail of an interpolation left by a mis-paired quote scan', () => {
    /*
     * The literal scan pairs quotes left to right and cannot see template
     * nesting, so an empty-string branch desynchronises it:
     *
     *   `timeline-label${isCell ? ' cell' : ''}${sel ? ' selected' : ''}`
     *
     * captures `}${sel ?` — letters, a space, no code shape. This className
     * idiom is everywhere in the editor, so it has to be a rule rather than a
     * marker on every component that uses it.
     */
    expect(texts("const c = `label${a ? ' cell' : ''}${b ? ' selected' : ''}`;\n", false))
      .toEqual([]);
    expect(looksTranslatable('}${selectedLayerIds.includes(layer.id) ?')).toBe(false);
    // `)` and `]` are the same story from a different expression shape.
    expect(looksTranslatable(')[i] ??')).toBe(false);
    expect(looksTranslatable(').trim()) ?')).toBe(false);
  });

  it('still flags a literal that starts with a comma', () => {
    /*
     * The same mis-pairing throws up `, label:` too, and it would be easy to
     * suppress alongside the closers. It is not, on purpose: a literal starting
     * with `, ` is usually one half of a concatenated sentence — `', edges to
     * trim'` in the timeline was exactly that — and those are the findings the
     * ratchet exists for.
     */
    expect(looksTranslatable(', edges to trim')).toBe(true);
  });

  it('takes a lone capitalised word from JSX but not from a bare literal', () => {
    // `<option>Text</option>` is the Text *layer type* as the operator reads
    // it; `const kind = 'Text'` is far more likely an enum value.
    expect(looksTranslatable('Text', false)).toBe(true);
    expect(looksTranslatable('Text', true)).toBe(false);
  });

  it('honours the allow-list', () => {
    expect(looksTranslatable('vMix', false, new Set(['vMix']))).toBe(false);
  });

  it('skips a line comparing a key or code to a name', () => {
    // `e.key === 'Enter'` is a KeyboardEvent name. The alternative is an
    // allow-list entry for `Delete`, which is a real button caption elsewhere.
    expect(texts("if (e.key === 'Enter') submit();\n")).toEqual([]);
  });
});

describe('comments', () => {
  it('does not read prose out of a block comment', () => {
    const src = '/* Put a PSD in this composition and it imports. */\nconst x = 1;\n';
    expect(texts(src)).toEqual([]);
  });

  it('keeps the stripped text index-aligned with the raw text', () => {
    // Load-bearing: the raw line carries the marker, the stripped line is what
    // gets searched. An earlier version removed comments outright, the arrays
    // fell out of step, and every suppression in the repo silently did nothing.
    const src = 'const a = 1; /* note */\nconst b = 2;\n';
    expect(stripComments(src).split('\n')).toHaveLength(src.split('\n').length);
    expect(stripComments(src).split('\n')[0]).toHaveLength(src.split('\n')[0]!.length);
  });

  it('leaves a protocol-relative URL alone rather than reading it as a comment', () => {
    expect(stripComments("const u = 'https://example.com/x';\n")).toContain('https://example.com/x');
  });
});

describe('what it reports', () => {
  it('gives each candidate a kind and a 1-based line', () => {
    const src = '\n\n<button title="Go to start">Play preview</button>\n';
    const found = findCandidates(src, { markup: true }) as Map<string, { kind: string; line: number }>;
    expect(found.get('Play preview')).toEqual({ kind: 'jsx', line: 3 });
    expect(found.get('Go to start')).toEqual({ kind: 'attr', line: 3 });
  });

  it('finds a template literal carrying a message', () => {
    // The parameterised messages — the ones with placeholders and plurals — are
    // template literals. A worklist blind to them is blind to the hard half.
    expect(first('const s = `Imported ${name} layers`;\n')).toEqual([
      'Imported ${name} layers', { kind: 'lit', line: 1 },
    ]);
  });

  it('reports the first occurrence of a repeated string once', () => {
    const src = '<b>Zoom in</b>\n<i>Zoom in</i>\n';
    const found = findCandidates(src, { markup: true }) as Map<string, { line: number }>;
    expect(found.size).toBe(1);
    expect(found.get('Zoom in')?.line).toBe(1);
  });

  it('collapses internal whitespace so a wrapped label matches its catalogue entry', () => {
    expect(texts('<p>Pause at STOP   markers</p>\n')).toEqual(['Pause at STOP markers']);
  });
});

describe('physical direction properties', () => {
  const hits = (src: string, selectors: string[] = []): string[] =>
    (findPhysical(src, { selectors }) as Array<{ text: string }>).map((h) => h.text);

  it('finds the CSS forms that do not mirror', () => {
    expect(hits('.a { margin-left: 4px; }\n')).toHaveLength(1);
    expect(hits('.a { text-align: left; }\n')).toHaveLength(1);
    expect(hits('.a { inset-inline-start: 4px; text-align: start; }\n')).toEqual([]);
  });

  it('finds React inline styles too, where the logical name is accepted', () => {
    expect(hits('<i style={{ paddingLeft: 4 }} />\n')).toHaveLength(1);
    expect(hits('<i style={{ paddingInlineStart: 4 }} />\n')).toEqual([]);
  });

  it('reads CSS out of a .ts file, because the server builds its pages there', () => {
    /*
     * Picking the pattern by file extension was the bug this catches: every
     * server page's CSS lives in a template literal in `pages.ts`, so only the
     * JSX pattern was ever applied there and `text-align:left` went unreported
     * five times.
     */
    expect(hits('const CSS = `th{text-align:left;color:red}`;\n')).toHaveLength(1);
  });

  it('leaves a pinned subtree alone, matched on the innermost selector', () => {
    // A rule inside `dir="ltr"` is written `.tick`, not `.timeline-body .tick`
    // — the parent is nowhere on the line.
    expect(hits('.tick { left: 3px; }\n', ['.tick'])).toEqual([]);
    expect(hits('.lib-tick { left: 3px; }\n', ['.tick'])).toHaveLength(1);
  });

  it('honours a dir-ok marker on the line and on the one above', () => {
    expect(hits('.a { left: 0; } /* dir-ok */\n')).toEqual([]);
    expect(hits('// dir-ok\n<i style={{ left: 0 }} />\n')).toEqual([]);
  });

  it('does not let a two-line justification break the marker', () => {
    /*
     * The same footgun as `i18n-ignore-next-line`, and it caught a marker of
     * mine: the marker must be the *last* comment line before the code, so the
     * reason goes above it, not below.
     */
    expect(hits('// dir-ok — because\n// of some longer reason\n<i style={{ left: 0 }} />\n'))
      .toHaveLength(1);
  });
});
