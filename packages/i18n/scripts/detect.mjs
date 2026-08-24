// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Hardcoded-UI-text detection, shared by `i18n:check` and `i18n:extract`.
 *
 * These two scripts ask the same question of a file — which of its strings are
 * text an operator reads? — and for a while they each answered it with their
 * own copy of the same eight regexes. The copies drifted, in the direction that
 * matters most: `extract` ran its JSX and attribute passes over the whole file
 * at once, so it never saw the `i18n-ignore` markers that are inherently
 * line-scoped, while `check` ran everything line-by-line and honoured them.
 *
 * The result was a worklist that disagreed with the gate. `EasingEditor.tsx`
 * sat on the list at one remaining string while `i18n:check` passed on it, and
 * that string was `Math.abs(kf.t - target.time)` — the tail of an arrow
 * function, suppressed on its line months earlier. A worklist that reports
 * phantom debt on finished files is worse than no worklist: the counts stop
 * meaning anything, and the reflex becomes to disbelieve them.
 *
 * So the detector lives here once and both scripts import it. `check` uses the
 * texts to fail the ratchet; `extract` uses the kinds and line numbers to
 * generate keys. Neither owns the rules.
 */

/** Labelled attributes whose values are shown to the operator. */
export const ATTRS = /(?:title|placeholder|aria-label|alt|label)=["']([^"'\n]{2,})["']/g;

/**
 * JSX text, with the closing bracket captured.
 *
 * Two guards, because a `>…<` scan over a .tsx file has two ways to be wrong.
 *
 * Looking forward: `Promise<void>` in a type annotation looks exactly like
 * element text, as does every other generic. The tell is what follows the
 * closing `<` — real element text is followed by `</`, a generic by a type
 * name. Single-word candidates are therefore only accepted when a `/` follows;
 * anything with a space is prose either way.
 *
 * Looking back: `(a, b) => Math.abs(a.t - b.t) < 1e-6` also has a `>`, then a
 * span, then a `<`, and that span contains spaces so the forward guard lets it
 * through. This one cost real time — it is why `EasingEditor.tsx` carried a
 * suppression marker and still showed a string of debt on the worklist. The
 * lookbehind is the whole fix: a `>` closing a JSX tag is preceded by a tag
 * name, a quote or a brace, never by the `=` of an arrow.
 */
export const JSX_TEXT = /(?<!=)>([^<>{}\n]{2,})<(\/?)/g;

/**
 * Bare string and template literals.
 *
 * Capped at 160 characters, unlike the two above. A literal longer than that is
 * a data URI, a licence header or a base64 blob far more often than it is a
 * sentence, and the JSX passes have no such cap precisely because a paragraph
 * of real UI prose does live between two tags.
 *
 * The lower bound is 1, not 2, and that matters more than it looks. This scan
 * pairs quotes left to right, so a literal it *skips* desynchronises everything
 * after it on the line: with a floor of 2, `{ prop: 'x', labelKey: '…' }` never
 * matched `'x'`, so the scan treated the closing quote as an opening one and
 * captured `, labelKey:` as prose. Every one-character value in the codebase
 * did this — `'x'`, `'y'`, `'w'`, `'l'` — and each cost a suppression marker on
 * a line that had nothing wrong with it. Matching them costs nothing, because
 * `looksTranslatable` rejects anything shorter than two characters anyway.
 */
export const LITERALS = /(['"`])((?:[^'"`\\\n]|\\.){1,160})\1/g;

/**
 * `// i18n-ignore` — a line-level opt-out, next to the code that needs it.
 *
 * Both comment styles are matched. JSX children position accepts only a braced
 * block comment — a `//` there is rendered to the page as text rather than
 * treated as a comment — so the marker has to be recognised in both forms.
 *
 * Three comment forms, because a marker has to be legal where the code is.
 * JSX children position accepts only a braced block comment — a `//` there is
 * rendered to the page as text. Inside an HTML template literal, which is how
 * the server builds every page it serves, neither works and `<!-- -->` is the
 * only form that does not end up in the output.
 *
 * The allow-list is for words that are never translated anywhere (`GSAP`,
 * `vMix`). This is for the other case: a literal that only looks like prose
 * where it sits — a CSS gradient built in `layer-thumb.ts`, a thrown `Error`
 * that only a developer reads. Putting those in the global allow-list would
 * suppress the same text everywhere, including somewhere it really is a label.
 */
export const IGNORE_LINE = /(?:\/\/|\/\*|<!--)\s*i18n-ignore(?!-next-line|-start|-end)\b/;

/**
 * `// i18n-ignore-next-line`, for when the literal is the whole line.
 *
 * Same-line-only was the first design and it is a footgun: the natural place to
 * write the justification is above the line, that reads fine, and the
 * suppression then silently does nothing. Supporting both spellings costs one
 * regex and removes a class of mistake — the eslint convention, for the same
 * reason eslint has it.
 *
 * Strictly the *immediately* preceding line, which has its own footgun: a
 * two-line justification ending in the marker works, one that *starts* with the
 * marker does not, because the second comment line is what sits above the code.
 * Write the reason first and the marker last, directly above the statement.
 * Widening this to scan up through contiguous comments was tempting and
 * rejected — it would let a marker suppress a line several away from it, which
 * is exactly the kind of action-at-a-distance the line scope exists to prevent.
 * The gate fails loudly when it is written the other way round, so the mistake
 * is cheap.
 */
export const IGNORE_NEXT = /(?:\/\/|\/\*|<!--)\s*i18n-ignore-next-line\b/;

/**
 * `i18n-ignore-start` … `i18n-ignore-end`, for a region that is frozen as a
 * whole rather than line by line.
 *
 * Held back for a long time, because a marker that acts at a distance is the
 * thing line scoping exists to prevent. What justifies it is a region where
 * per-line markers are not available at all: `gsapTags()` builds the inline
 * script for `/play`, so its text sits inside a template literal inside a
 * `<script>` — a `//` there is shipped to the browser, and an HTML comment
 * would land inside JavaScript. Eight markers that each degrade the output are
 * worse than one pair that states the real fact: this whole function belongs to
 * `/play`, and `/play` is frozen English by design (I18N.md §2).
 *
 * Deliberately not a file-level switch. A block names its own extent, so the
 * next string added below the `end` is still caught.
 */
export const IGNORE_START = /(?:\/\/|\/\*|<!--)\s*i18n-ignore-start\b/;
export const IGNORE_END = /(?:\/\/|\/\*|<!--)\s*i18n-ignore-end\b/;

/** `e.key === 'Enter'` is a KeyboardEvent name, not a label. */
export const KEY_COMPARISON = /\.(?:key|code)\s*[=!]==?/;

/** Shapes that only occur in code: arrow bodies, blocks, declarations. */
export const CODEISH = /=>|\)\s*\{|\bconst\b|\breturn\b|\btypeof\b|[{}<>|=]{2,}/;

/**
 * A className list — `panel layers-panel` — rather than a sentence.
 *
 * At least one token must be hyphenated. Without that clause this matched any
 * run of lowercase words and quietly swallowed real prose: `date unknown` and
 * `in the bin as` were both missing from a worklist before it was tightened.
 * Hyphens are near-universal in class names and rare mid-sentence, which makes
 * them the cheap discriminator here.
 */
const CLASS_LIST = /^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)+$/;
const HAS_HYPHENATED_TOKEN = /(?:^| )[a-z0-9]+-[a-z0-9-]+(?: |$)/;
const isClassList = (t) => CLASS_LIST.test(t) && HAS_HYPHENATED_TOKEN.test(t);

/** Nothing but an interpolation and punctuation — `${Math.round(x)}%`. */
const INTERP_ONLY = /^[\s%(),.:+-]*\$\{[^}]*\}[\s%(),.:+-]*$/;

/**
 * The tail of an interpolation, captured because the literal scan mis-paired
 * its quotes.
 *
 * `LITERALS` pairs quotes left to right and cannot see template-literal
 * nesting, so an empty-string branch desynchronises it:
 *
 *     `timeline-label${isCell ? ' cell' : ''}${sel ? ' selected' : ''}`
 *
 * It matches `' cell'`, then treats the `'` opening `''` as an opening quote
 * and runs to the next one, capturing `}${sel ?` — which has letters, spaces
 * and no code shape `CODEISH` recognises. This is the single most common
 * className idiom in the editor, so suppressing it file by file would mean a
 * marker on nearly every component.
 *
 * A leading structural closer settles it. `}`, `)` and `]` never begin a
 * sentence, only the tail of an expression the scan cut into:
 *
 *     .split('\t')[i] ?? ''        →  `)[i] ??`
 *     ... ?? '').trim()) ? 'number' →  `).trim()) ?`
 *
 * Deliberately not extended to `,` and `:`, though the same mis-pairing throws
 * those up too. A literal that *starts* with `, ` is usually a real finding —
 * `', edges to trim'` was one half of a concatenated sentence in the timeline,
 * exactly the antipattern the ratchet should surface. Suppressing that shape
 * would buy a few quiet false positives at the cost of the findings that matter
 * most.
 */
const INTERP_TAIL = /^[})\]]/;

/**
 * Strip block comments before looking for literals.
 *
 * Skipping lines that *start* with `//` or `*` is not enough: this codebase
 * explains itself in long block comments, and prose inside one ("put a PSD in
 * this composition") reads exactly like UI text to a regex. Three of the first
 * five false positives on the first file swept came from here.
 *
 * Comment characters are replaced with spaces rather than removed, so the
 * stripped line array stays index-aligned with the raw one. That alignment is
 * load-bearing: the raw line is what carries an `i18n-ignore` marker, and an
 * earlier version tested for the marker in text it had already blanked, so
 * every suppression in the repo silently did nothing.
 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/**
 * Is this string user-visible text?
 *
 * `strict` is the difference between where the string was found. Inside JSX
 * text or a labelled attribute, a lone capitalised word is almost always a
 * label — `<option>Text</option>` is the Text *layer type* as the operator
 * reads it, and excluding it because it has no space (the first version of this
 * rule did) silently drops most of a properties panel. In a bare string literal
 * the same word is far more likely an enum value or a DOM id, so single words
 * are only counted in the loose pass.
 */
export function looksTranslatable(s, strict = false, allow = new Set()) {
  const t = s.trim();
  if (t.length < 2 || allow.has(t)) return false;
  if (!/[A-Za-z]/.test(t) || !/[a-z]/.test(t)) return false;
  if (/^[a-z0-9_-]+$/.test(t)) return false;
  if (/^[a-zA-Z]+([A-Z][a-z]+)+$/.test(t)) return false;
  if (/^https?:|^\.\//.test(t)) return false;
  if (isClassList(t) || INTERP_ONLY.test(t) || INTERP_TAIL.test(t)) return false;
  if (strict && /^[\w.@/-]+$/.test(t)) return false;
  return /\s/.test(t) || /^[A-Z]/.test(t);
}

/**
 * Every candidate in one file's text, in source order, deduplicated by text.
 *
 * Three passes, not two. JSX text and labelled attributes are the obvious half;
 * the third is bare string literals, and skipping it would leave the ratchet
 * blind to exactly the strings that matter most — `Imported ${name}` and
 * `Column: ${cell}` are template literals, which is to say the parameterised
 * messages, which is to say the ones with plurals and placeholders in them.
 *
 * All three run per line, over the comment-stripped copy, after the raw line
 * has been checked for a suppression marker. Running the markup passes over the
 * whole file instead — which `extract` used to do — makes the line-scoped
 * markers unreachable and is the drift this module exists to prevent.
 *
 * `markup` turns the JSX passes on. It is false for a plain `.ts` file, where
 * `a > b && c < d` is arithmetic and a `>…<` scan reads the span between the
 * operators as element text; `i18n.config.json`'s `html` list opts specific
 * `.ts` files (the server's page templates) back in.
 *
 * Returns `Map<text, { kind, line }>`, first occurrence winning. `kind` is
 * `jsx`, `attr` or `lit`; `line` is 1-based.
 */
export function findCandidates(text, { markup = false, allow = new Set() } = {}) {
  const out = new Map();
  const add = (raw, kind, line) => {
    const s = raw.trim().replace(/\s+/g, ' ');
    if (!looksTranslatable(s, kind === 'lit', allow)) return;
    if (!out.has(s)) out.set(s, { kind, line });
  };

  const rawLines = text.split('\n');
  const lines = stripComments(text).split('\n');
  let frozen = false;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = rawLines[i] ?? '';
    // The `start` and `end` lines are themselves inside the region, so the flag
    // is set before the skip and cleared after it.
    if (IGNORE_START.test(raw)) frozen = true;
    if (frozen) {
      if (IGNORE_END.test(raw)) frozen = false;
      continue;
    }
    if (IGNORE_LINE.test(raw)) continue;
    if (IGNORE_NEXT.test(rawLines[i - 1] ?? '')) continue;
    const line = lines[i] ?? '';

    if (markup) {
      for (const m of line.matchAll(JSX_TEXT)) {
        if (!m[2] && !/\s/.test(m[1].trim())) continue; // generic, not element text
        // An arrow function reads as `>` … `<` too: `(k) => k.t < 1e-6` puts the
        // whole comparison between the brackets. The literal pass has always
        // filtered code shapes; the JSX pass needs the same filter.
        if (CODEISH.test(m[1])) continue;
        add(m[1], 'jsx', i + 1);
      }
      for (const m of line.matchAll(ATTRS)) add(m[1], 'attr', i + 1);
    }

    // Skipping the whole line is coarser than parsing, but it is the shape these
    // always take, and the alternative is an allow-list entry for `Delete` — a
    // word that is genuinely a button caption elsewhere in the same panel.
    if (KEY_COMPARISON.test(line)) continue;
    for (const m of line.matchAll(LITERALS)) {
      const lit = m[2].trim();
      if (CODEISH.test(lit)) continue;
      add(lit, 'lit', i + 1);
    }
  }
  return out;
}

/* ── direction (I18N.md §6.2) ───────────────────────────────────────────────
 *
 * Physical direction properties do not mirror. One surviving `margin-left` in
 * a mirrored panel is the three-pixel wrongness nobody can name and everybody
 * notices, so this is a gate rather than a checklist.
 *
 * Kept in this module because it has the same shape as the text rules — line
 * scoped, marker-aware, and needing the same comment forms — and because the
 * two are read together when either fires.
 */

/** CSS declarations. Also applied to `.ts`, where the server builds its CSS. */
export const CSS_PHYSICAL =
  /(?:^|[;{\s])(?:margin|padding|border|inset|scroll-margin|scroll-padding)-(?:left|right)\b|(?:^|[;{\s])(?:left|right)\s*:|text-align\s*:\s*(?:left|right)\b|float\s*:\s*(?:left|right)\b/;

/** React inline styles — `marginInlineStart` is accepted, so there is no excuse. */
export const JSX_PHYSICAL =
  /\b(?:margin|padding|border|inset|scrollMargin|scrollPadding)(?:Left|Right)\b|\b(?:left|right)\s*:\s*[^,}\s]/;

/** `// dir-ok — reason`, in any of the three comment forms. */
const DIR_OK = /(?:\/\/|\/\*|<!--)\s*dir-ok\b/;

/**
 * Physical direction declarations that are not deliberately pinned.
 *
 * `selectors` are matched against the innermost CSS selector, because a rule
 * inside a `dir="ltr"` subtree is usually written as `.tick`, not as
 * `.timeline-body .tick` — the parent is nowhere on the line.
 *
 * Returns `[{ line, text }]`.
 */
export function findPhysical(text, { selectors = [], marked = false } = {}) {
  const out = [];
  const rawLines = text.split('\n');
  const lines = stripComments(text).split('\n');
  let selector = '';
  for (let i = 0; i < lines.length; i += 1) {
    const raw = rawLines[i] ?? '';
    const line = lines[i] ?? '';
    const m = /^\s*([.#][^{]*?)\s*\{/.exec(line);
    if (m) selector = m[1].trim();
    if (!CSS_PHYSICAL.test(line) && !JSX_PHYSICAL.test(line)) continue;
    if (DIR_OK.test(raw) || DIR_OK.test(rawLines[i - 1] ?? '')) continue;
    const first = selector.split(/[\s,>]/)[0] ?? '';
    if (selectors.some((p) => first.startsWith(p))) continue;
    out.push({ line: i + 1, text: line.trim().slice(0, 90) });
  }
  return out;
}
