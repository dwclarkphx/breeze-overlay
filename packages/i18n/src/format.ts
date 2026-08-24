// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * ICU MessageFormat — the subset Breeze uses, and a loud refusal for the rest.
 *
 * The catalogue format is real ICU so that Crowdin, Weblate and every other
 * translation tool can read it unmodified (I18N.md §4.2). The *implementation*
 * is only as much of ICU as Breeze's ~500 strings actually need, because a full
 * MessageFormat engine is a library and this is a file.
 *
 * Supported: literal text, `{name}`, `{n, plural, ...}` with `Intl.PluralRules`
 * categories, `=N` exact matches and the `#` shorthand, `{g, select, ...}`, and
 * ICU apostrophe escaping.
 *
 * Refused, by name, with the offending construct quoted: `selectordinal`,
 * `number`/`date`/`time` skeletons, `offset:`, and plural nested inside plural.
 * Refusing loudly is the whole point — a message using an unimplemented feature
 * renders as literal braces on a control panel during a show, and a build that
 * will not start does not.
 */

export class IcuError extends Error {
  override name = 'IcuError';
}

export type Node =
  | { kind: 'text'; value: string }
  | { kind: 'arg'; name: string }
  | { kind: 'pound' }
  | { kind: 'plural'; name: string; cases: Case[] }
  | { kind: 'select'; name: string; cases: Case[] };

export interface Case {
  /** `other`, a plural category, a select key, or `=N` rendered as `=3`. */
  key: string;
  /** Set only for `=N` exact matches. */
  exact: number | null;
  nodes: Node[];
}

const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const REFUSED_ARG_TYPES: Record<string, string> = {
  selectordinal: 'selectordinal is not supported — Breeze has no ordinals in its UI',
  number: 'argument formatting is not supported — format through Intl at the call site',
  date: 'argument formatting is not supported — format through Intl at the call site',
  time: 'argument formatting is not supported — format through Intl at the call site',
  duration: 'argument formatting is not supported — format through Intl at the call site',
  ordinal: 'argument formatting is not supported — format through Intl at the call site',
  spellout: 'argument formatting is not supported — format through Intl at the call site',
};

interface Cursor {
  s: string;
  i: number;
  label: string;
}

function fail(c: Cursor, msg: string): never {
  throw new IcuError(`${c.label}: ${msg} (offset ${String(c.i)})`);
}

function skipWs(c: Cursor): void {
  while (c.i < c.s.length && /\s/.test(c.s[c.i] as string)) c.i += 1;
}

/**
 * ICU apostrophe escaping, DOUBLE_OPTIONAL mode — the one every tool assumes.
 *
 * An apostrophe opens a quoted run *only* when the next character is one it
 * could otherwise be mistaken for syntax: `{`, `}`, or `#` inside a plural.
 * `''` is a literal apostrophe anywhere. A lone apostrophe before an ordinary
 * letter stays a lone apostrophe, which is what makes "don't" survive without
 * the translator knowing any of this.
 */
function readQuoted(c: Cursor, out: string[]): boolean {
  const next = c.s[c.i + 1];
  if (next === "'") {
    out.push("'");
    c.i += 2;
    return true;
  }
  if (next !== '{' && next !== '}' && next !== '#') return false;
  c.i += 1;
  while (c.i < c.s.length) {
    if (c.s[c.i] === "'") {
      if (c.s[c.i + 1] === "'") {
        out.push("'");
        c.i += 2;
        continue;
      }
      c.i += 1;
      return true;
    }
    out.push(c.s[c.i] as string);
    c.i += 1;
  }
  return true; // unterminated quote runs to end of message, as ICU specifies
}

function parseNodes(c: Cursor, nested: boolean, inPlural: boolean): Node[] {
  const nodes: Node[] = [];
  const buf: string[] = [];
  const flush = (): void => {
    if (buf.length) {
      nodes.push({ kind: 'text', value: buf.join('') });
      buf.length = 0;
    }
  };

  while (c.i < c.s.length) {
    const ch = c.s[c.i] as string;
    if (ch === '}') {
      if (!nested) fail(c, 'unmatched `}` — write `\'}\'` for a literal brace');
      flush();
      return nodes;
    }
    if (ch === '{') {
      flush();
      nodes.push(parsePlaceholder(c, inPlural));
      continue;
    }
    if (ch === '#' && inPlural) {
      flush();
      nodes.push({ kind: 'pound' });
      c.i += 1;
      continue;
    }
    if (ch === "'" && readQuoted(c, buf)) continue;
    buf.push(ch);
    c.i += 1;
  }

  if (nested) fail(c, 'unexpected end of message — a `{` was never closed');
  flush();
  return nodes;
}

function readName(c: Cursor): string {
  const start = c.i;
  while (c.i < c.s.length && /[^\s,{}]/.test(c.s[c.i] as string)) c.i += 1;
  if (c.i === start) fail(c, 'expected an argument name');
  return c.s.slice(start, c.i);
}

function parsePlaceholder(c: Cursor, inPlural: boolean): Node {
  c.i += 1; // '{'
  skipWs(c);
  const name = readName(c);
  skipWs(c);

  if (c.s[c.i] === '}') {
    c.i += 1;
    return { kind: 'arg', name };
  }
  if (c.s[c.i] !== ',') fail(c, `expected \`,\` or \`}\` after \`{${name}\``);
  c.i += 1;
  skipWs(c);

  const argType = readName(c);
  const refusal = REFUSED_ARG_TYPES[argType];
  if (refusal !== undefined) fail(c, `\`{${name}, ${argType}, …}\`: ${refusal}`);
  if (argType !== 'plural' && argType !== 'select') {
    fail(c, `\`{${name}, ${argType}, …}\`: unknown argument type`);
  }
  if (argType === 'plural' && inPlural) {
    fail(c, `\`{${name}, plural, …}\` is nested inside another plural, which is not supported`);
  }

  skipWs(c);
  if (c.s[c.i] !== ',') fail(c, `expected \`,\` after \`${argType}\` in \`{${name}, ${argType}, …}\``);
  c.i += 1;
  skipWs(c);
  if (c.s.startsWith('offset:', c.i)) {
    fail(c, `\`{${name}, plural, offset:…}\`: plural offset is not supported`);
  }

  const cases = parseCases(c, name, argType);
  if (!cases.some((k) => k.key === 'other')) {
    fail(c, `\`{${name}, ${argType}, …}\` has no \`other\` case, which every message needs`);
  }
  c.i += 1; // '}'
  return argType === 'plural'
    ? { kind: 'plural', name, cases }
    : { kind: 'select', name, cases };
}

function parseCases(c: Cursor, name: string, argType: 'plural' | 'select'): Case[] {
  const cases: Case[] = [];
  const seen = new Set<string>();

  for (;;) {
    skipWs(c);
    if (c.i >= c.s.length) fail(c, `\`{${name}, ${argType}, …}\` was never closed`);
    if (c.s[c.i] === '}') return cases;

    const key = readName(c);
    let exact: number | null = null;
    if (key.startsWith('=')) {
      if (argType !== 'plural') fail(c, `\`${key}\` exact matches are only valid in \`plural\``);
      const n = Number(key.slice(1));
      if (!Number.isFinite(n)) fail(c, `\`${key}\` is not a number`);
      exact = n;
    } else if (argType === 'plural' && !PLURAL_CATEGORIES.has(key)) {
      fail(
        c,
        `\`${key}\` is not a plural category — expected one of ${[...PLURAL_CATEGORIES].join(', ')}, or \`=N\``,
      );
    }
    if (seen.has(key)) fail(c, `\`${key}\` appears twice in \`{${name}, ${argType}, …}\``);
    seen.add(key);

    skipWs(c);
    if (c.s[c.i] !== '{') fail(c, `expected \`{\` after \`${key}\``);
    c.i += 1;
    const nodes = parseNodes(c, true, argType === 'plural' || false);
    c.i += 1; // '}'
    cases.push({ key, exact, nodes });
  }
}

/** Parse a message into an AST. Throws `IcuError` on anything unsupported. */
export function compile(message: string, label = 'message'): Node[] {
  const c: Cursor = { s: message, i: 0, label };
  return parseNodes(c, false, false);
}

const compileCache = new Map<string, Node[]>();

export function compileCached(message: string, label = 'message'): Node[] {
  let ast = compileCache.get(message);
  if (!ast) {
    ast = compile(message, label);
    compileCache.set(message, ast);
  }
  return ast;
}

const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function rulesFor(locale: string): Intl.PluralRules {
  let r = pluralRules.get(locale);
  if (!r) {
    r = new Intl.PluralRules(locale);
    pluralRules.set(locale, r);
  }
  return r;
}

function numbersFor(locale: string): Intl.NumberFormat {
  let f = numberFormats.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale);
    numberFormats.set(locale, f);
  }
  return f;
}

export type Params = Record<string, string | number | boolean | null | undefined>;

/** Render a compiled AST. Missing parameters render as `{name}`, never as `undefined`. */
export function render(ast: Node[], locale: string, params: Params = {}, pound?: number): string {
  let out = '';
  for (const node of ast) {
    switch (node.kind) {
      case 'text':
        out += node.value;
        break;
      case 'pound':
        out += pound === undefined ? '#' : numbersFor(locale).format(pound);
        break;
      case 'arg': {
        const v = params[node.name];
        out += v === undefined || v === null ? `{${node.name}}` : String(v);
        break;
      }
      case 'plural': {
        const raw = params[node.name];
        const n = typeof raw === 'number' ? raw : Number(raw);
        const value = Number.isFinite(n) ? n : 0;
        const exact = node.cases.find((k) => k.exact === value);
        const category = rulesFor(locale).select(value);
        const chosen =
          exact ??
          node.cases.find((k) => k.key === category) ??
          (node.cases.find((k) => k.key === 'other') as Case);
        out += render(chosen.nodes, locale, params, value);
        break;
      }
      case 'select': {
        const key = String(params[node.name] ?? '');
        const chosen =
          node.cases.find((k) => k.key === key) ??
          (node.cases.find((k) => k.key === 'other') as Case);
        out += render(chosen.nodes, locale, params, pound);
        break;
      }
    }
  }
  return out;
}

/** Compile-and-render in one call, with the AST cached across calls. */
export function formatMessage(
  message: string,
  locale: string,
  params: Params = {},
  label = 'message',
): string {
  return render(compileCached(message, label), locale, params);
}

/** Every `{name}` a message reads, in source order. Used by `i18n:check`. */
export function placeholdersOf(ast: Node[], into = new Set<string>()): Set<string> {
  for (const node of ast) {
    if (node.kind === 'arg' || node.kind === 'plural' || node.kind === 'select') {
      into.add(node.name);
    }
    if (node.kind === 'plural' || node.kind === 'select') {
      for (const k of node.cases) placeholdersOf(k.nodes, into);
    }
  }
  return into;
}

/**
 * AST back to ICU source, re-escaping what has to be escaped.
 *
 * Exists for the pseudo-locale generator, which transforms literal text and
 * must not touch placeholders or case keywords — the naive
 * "wrap the whole string in brackets" approach turns
 * `{n, plural, one {…} other {…}}` into unparseable text. Round-tripping
 * through the AST is what keeps the structure intact.
 */
export function serialize(ast: Node[]): string {
  let out = '';
  for (const node of ast) {
    switch (node.kind) {
      case 'text':
        out += node.value.replace(/'/g, "''").replace(/[{}#]/g, (m) => `'${m}'`);
        break;
      case 'pound':
        out += '#';
        break;
      case 'arg':
        out += `{${node.name}}`;
        break;
      case 'plural':
      case 'select': {
        const body = node.cases.map((k) => `${k.key} {${serialize(k.nodes)}}`).join(' ');
        out += `{${node.name}, ${node.kind}, ${body}}`;
        break;
      }
    }
  }
  return out;
}

/** Apply a transform to every literal-text node, leaving structure untouched. */
export function mapText(ast: Node[], fn: (s: string) => string): Node[] {
  return ast.map((node) => {
    if (node.kind === 'text') return { kind: 'text', value: fn(node.value) };
    if (node.kind === 'plural' || node.kind === 'select') {
      return {
        ...node,
        cases: node.cases.map((k) => ({ ...k, nodes: mapText(k.nodes, fn) })),
      };
    }
    return node;
  });
}

/** Total length of the literal text in a message, ignoring placeholders. */
export function textLength(ast: Node[]): number {
  let n = 0;
  for (const node of ast) {
    if (node.kind === 'text') n += node.value.length;
    if (node.kind === 'plural' || node.kind === 'select') {
      for (const k of node.cases) n += textLength(k.nodes);
    }
  }
  return n;
}

/**
 * Parameters that may carry something richer than text — a React element, say.
 *
 * Anything that is not a primitive is passed through untouched rather than
 * stringified, which is what makes `renderRich` able to put an element in the
 * middle of a translated sentence.
 */
export type RichParams<T> = Record<string, string | number | boolean | null | undefined | T>;

/**
 * Format to a list of text runs and passed-through values, rather than a string.
 *
 * This is Breeze's answer to markup inside a translated sentence — the case
 * `DataPanel`'s contact hint raises, where `<code>BREEZE_CONTACT</code>` sits
 * mid-sentence and must survive translation and reordering.
 *
 * The rejected alternative was tags in the message
 * (`… with <code>BREEZE_CONTACT</code> instead …`), which is what react-intl
 * and Lingui do. It needs a tag node in the parser, a components map at every
 * call site, and a rule — unenforceable by `i18n:check` — that a message
 * carrying tags is never rendered through the plain string path, where the tags
 * would either vanish or print literally on an operator panel.
 *
 * A placeholder needs none of that. The catalogue stays plain ICU, translators
 * see an ordinary `{envVar}` they can move anywhere in the sentence, and the
 * same message renders correctly through `render` (as text) and `renderRich`
 * (as elements). The limitation is that a styled run has to be exactly one
 * placeholder — which is what Breeze actually needs, since the things wanting
 * `<code>` around them are identifiers, and identifiers are placeholders.
 */
export function renderRich<T>(
  ast: Node[],
  locale: string,
  params: RichParams<T> = {},
  pound?: number,
): Array<string | T> {
  const out: Array<string | T> = [];
  // Adjacent text is merged so a caller keying a list gets one node per visible
  // run rather than one per AST node.
  const push = (piece: string | T): void => {
    if (typeof piece === 'string') {
      const last = out[out.length - 1];
      if (typeof last === 'string') {
        out[out.length - 1] = last + piece;
        return;
      }
      if (piece === '') return;
    }
    out.push(piece);
  };

  for (const node of ast) {
    switch (node.kind) {
      case 'text':
        push(node.value);
        break;
      case 'pound':
        push(pound === undefined ? '#' : numbersFor(locale).format(pound));
        break;
      case 'arg': {
        const v = params[node.name];
        if (v === undefined || v === null) push(`{${node.name}}`);
        else if (typeof v === 'object' || typeof v === 'function') push(v as T);
        else push(String(v));
        break;
      }
      case 'plural': {
        const raw = params[node.name];
        const n = typeof raw === 'number' ? raw : Number(raw);
        const value = Number.isFinite(n) ? n : 0;
        const exact = node.cases.find((k) => k.exact === value);
        const category = rulesFor(locale).select(value);
        const chosen =
          exact ??
          node.cases.find((k) => k.key === category) ??
          (node.cases.find((k) => k.key === 'other') as Case);
        for (const piece of renderRich<T>(chosen.nodes, locale, params, value)) push(piece);
        break;
      }
      case 'select': {
        const key = String(params[node.name] ?? '');
        const chosen =
          node.cases.find((k) => k.key === key) ??
          (node.cases.find((k) => k.key === 'other') as Case);
        for (const piece of renderRich<T>(chosen.nodes, locale, params, pound)) push(piece);
        break;
      }
    }
  }
  return out;
}
