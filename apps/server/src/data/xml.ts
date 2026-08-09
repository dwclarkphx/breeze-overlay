// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * A small non-validating XML reader.
 *
 * Written rather than depended on, for the same reason `parseDelimited` was: the
 * requirement is narrow and the failure modes are specific. What has to work is
 * the XML that data feeds actually emit — an RSS 2.0 channel, an Atom feed, a
 * league office's results export — and none of that needs DTDs, entity
 * declarations, XSD types or a DOM with parent pointers.
 *
 * What it deliberately does *not* do:
 *
 *  - **Validate.** A malformed feed still yields whatever it parsed. On air, a
 *    ticker showing eight of ten headlines beats a ticker showing an exception.
 *  - **Resolve external entities.** `<!ENTITY xxe SYSTEM "file:///etc/passwd">`
 *    is the standard attack on an XML parser, and this parser cannot be talked
 *    into a file read or a network fetch because it has no mechanism for either:
 *    doctype internal subsets are skipped as opaque text, and an undeclared
 *    entity reference is left as literal text rather than looked up. That is a
 *    security property of the design, not a limitation to fix later.
 *  - **Track namespaces properly.** Prefixes are preserved on the raw name and
 *    also exposed stripped (`local`), because feeds are wildly inconsistent
 *    about whether a field is `dc:date`, `date` or `atom:updated`, and a
 *    prefix-exact match would drop half of them.
 */

/* ------------------------------------------------------------------ model */

export interface XmlNode {
  /** Tag name as written, prefix included: `dc:creator`. */
  name: string;
  /** Tag name with any namespace prefix removed: `creator`. */
  local: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct text content of this element, concatenated and trimmed. */
  text: string;
}

/** The five predefined entities. Everything else is left alone on purpose. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // Not predefined in XML, but so common in feeds that leaving it literal shows
  // "&nbsp;" on air. It is the one exception, and it is a space.
  nbsp: ' ',
};

/**
 * Expand character and named entity references.
 *
 * An unknown reference is returned verbatim rather than dropped or looked up.
 * Verbatim is the honest answer: `&foo;` in a feed is either a declared entity
 * this parser will not resolve, or a literal ampersand somebody forgot to
 * escape, and showing the source text makes both diagnosable.
 */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      // Surrogate halves are not characters; String.fromCodePoint throws on them.
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/* ----------------------------------------------------------------- parser */

/** Guard against a pathological document exhausting the stack or the heap. */
const MAX_DEPTH = 64;

interface Frame {
  node: XmlNode;
  /** Text accumulated directly inside this element. */
  text: string[];
}

function makeNode(name: string, attrs: Record<string, string>): XmlNode {
  return { name, local: localName(name), attrs, children: [], text: '' };
}

/**
 * Parse a document into a single root node.
 *
 * Returns `null` for a document with no element content at all — an empty body,
 * an HTML error page the origin served with a 200, a JSON payload pointed at the
 * wrong adapter. The caller turns that into a source error the editor shows,
 * which is far more useful than a thrown parse error three frames deep.
 *
 * A synthetic root wraps the document so that a feed with junk before the root
 * element (a stray BOM, a PHP warning, a blank line — all of which happen) still
 * parses, and so that multiple top-level elements are not a crash.
 */
export function parseXml(source: string): XmlNode | null {
  let text = source;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const root = makeNode('#document', {});
  const stack: Frame[] = [{ node: root, text: [] }];
  let i = 0;

  const top = (): Frame => stack[stack.length - 1]!;

  const closeFrame = (): void => {
    if (stack.length <= 1) return;
    const frame = stack.pop()!;
    frame.node.text = decodeEntities(frame.text.join('')).trim();
    top().node.children.push(frame.node);
  };

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      top().text.push(text.slice(i));
      break;
    }
    if (lt > i) top().text.push(text.slice(i, lt));

    /* --- CDATA: content is literal, entities included. ------------------ */
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      const body = end === -1 ? text.slice(lt + 9) : text.slice(lt + 9, end);
      /*
       * Re-escaped on the way in so the one `decodeEntities` pass at close time
       * gives it back unchanged. CDATA is by definition *not* entity-encoded, so
       * decoding it would corrupt an RSS description that legitimately contains
       * the characters "&amp;" as text to display — which, in a section wrapping
       * HTML, is most of them.
       */
      top().text.push(body.replace(/&/g, '&amp;'));
      i = end === -1 ? text.length : end + 3;
      continue;
    }

    /* --- Comment. ------------------------------------------------------- */
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end === -1 ? text.length : end + 3;
      continue;
    }

    /*
     * --- Doctype, skipped as opaque text.
     *
     * Including any internal subset, brackets balanced. This is where entity
     * declarations live, and skipping the whole construct without reading it is
     * precisely what makes an XXE payload inert here.
     */
    if (/^<!doctype/i.test(text.slice(lt, lt + 9))) {
      let depth = 0;
      let j = lt;
      for (; j < text.length; j += 1) {
        const ch = text[j];
        if (ch === '[') depth += 1;
        else if (ch === ']') depth -= 1;
        else if (ch === '>' && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }

    /* --- Processing instruction / XML declaration. ----------------------- */
    if (text[lt + 1] === '?') {
      const end = text.indexOf('?>', lt + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }

    /* --- Closing tag. ---------------------------------------------------- */
    if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      const name = text.slice(lt + 2, end === -1 ? text.length : end).trim();
      /*
       * Unwind to the matching open tag rather than assuming the top of the
       * stack is it. Feeds carry unclosed `<br>` and `<p>` inside descriptions
       * often enough that a strict pop would swallow every sibling after one.
       * A close tag matching nothing on the stack is ignored entirely.
       */
      const at = findOpen(stack, name);
      if (at > 0) while (stack.length > at) closeFrame();
      i = end === -1 ? text.length : end + 1;
      continue;
    }

    /* --- Opening tag. ---------------------------------------------------- */
    const end = findTagEnd(text, lt);
    if (end === -1) {
      top().text.push(text.slice(lt));
      break;
    }
    const raw = text.slice(lt + 1, end);
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const { name, attrs } = parseTag(body);
    i = end + 1;

    if (!name) continue;

    const node = makeNode(name, attrs);
    if (selfClosing) {
      top().node.children.push(node);
      continue;
    }
    if (stack.length > MAX_DEPTH) {
      // Too deep to be real data. Keep the element's text with its parent
      // rather than growing the stack without bound.
      continue;
    }
    stack.push({ node, text: [] });
  }

  while (stack.length > 1) closeFrame();
  root.text = decodeEntities(stack[0]!.text.join('')).trim();

  const elements = root.children;
  if (elements.length === 0) return null;
  if (elements.length === 1) return elements[0]!;
  return root;
}

/* --------------------------------------------------------------- internals */

/** Index in the stack of the innermost frame with this tag name, or -1. */
function findOpen(stack: Frame[], name: string): number {
  const wanted = name.toLowerCase();
  const wantedLocal = localName(wanted);
  for (let i = stack.length - 1; i > 0; i -= 1) {
    const n = stack[i]!.node.name.toLowerCase();
    if (n === wanted || localName(n) === wantedLocal) return i;
  }
  return -1;
}

/**
 * Find the `>` that ends a tag, ignoring any inside a quoted attribute value.
 * `<link href="a?x=1&gt;2">` is rare but real, and stopping at the first `>`
 * truncates the tag and orphans everything after it.
 */
function findTagEnd(text: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

const ATTR_RE = /([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseTag(body: string): { name: string; attrs: Record<string, string> } {
  const trimmed = body.trim();
  const space = trimmed.search(/\s/);
  const name = space === -1 ? trimmed : trimmed.slice(0, space);
  const attrs: Record<string, string> = {};
  if (space === -1) return { name, attrs };

  const rest = trimmed.slice(space);
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(rest)) !== null) {
    const key = m[1];
    if (!key) continue;
    // A bare attribute (`<opt selected>`) is the empty string, not absent — the
    // path picker can then still select on its presence.
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    // First value wins for a repeated attribute, matching how every browser
    // resolves the same ambiguity.
    if (!Object.prototype.hasOwnProperty.call(attrs, key)) attrs[key] = decodeEntities(value);
  }
  return { name, attrs };
}

/* ------------------------------------------------------------- navigation */

/** Direct children matching a tag name, prefix-insensitively. */
export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  const wanted = name.toLowerCase();
  return node.children.filter(
    (c) => c.name.toLowerCase() === wanted || c.local.toLowerCase() === wanted,
  );
}

export function childNamed(node: XmlNode, name: string): XmlNode | undefined {
  return childrenNamed(node, name)[0];
}

/** First matching child's text, or `''`. Convenience — feeds are full of these. */
export function childText(node: XmlNode, ...names: string[]): string {
  for (const name of names) {
    const child = childNamed(node, name);
    if (child && child.text) return child.text;
  }
  return '';
}

/**
 * Resolve a slash path of element names against a node: `channel/item`.
 *
 * A leading path segment equal to the root's own name is tolerated, so
 * `rss/channel/item` and `channel/item` both work against an `<rss>` document.
 * People copy the path out of the feed they are looking at, including the root,
 * and refusing that is a support ticket rather than a safeguard.
 */
export function selectPath(root: XmlNode, path: string): XmlNode[] {
  const parts = path
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return [root];

  let start = 0;
  const first = parts[0]!.toLowerCase();
  if (first === root.name.toLowerCase() || first === root.local.toLowerCase()) start = 1;
  if (start >= parts.length) return [root];

  let nodes: XmlNode[] = [root];
  for (const part of parts.slice(start)) {
    const next: XmlNode[] = [];
    for (const node of nodes) next.push(...childrenNamed(node, part));
    nodes = next;
    if (nodes.length === 0) return [];
  }
  return nodes;
}

/**
 * Every element path in the document, with how many siblings share it.
 *
 * This is what the editor's "find it" button uses: the repeating element in an
 * unfamiliar feed is nearly always the deepest path with the highest count, and
 * showing the operator the candidates beats making them read raw XML.
 */
export function elementPaths(root: XmlNode, maxDepth = 6): Array<{ path: string; count: number }> {
  const counts = new Map<string, number>();

  const walk = (node: XmlNode, prefix: string, depth: number): void => {
    if (depth > maxDepth) return;
    for (const child of node.children) {
      const path = prefix ? `${prefix}/${child.local}` : child.local;
      counts.set(path, (counts.get(path) ?? 0) + 1);
      walk(child, path, depth + 1);
    }
  };
  walk(root, '', 0);

  return [...counts]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.length - b.path.length);
}

/**
 * Best guess at the repeating element that holds the rows.
 *
 * Ranked by count first, then by depth: a feed with 20 `<item>` elements each
 * containing one `<title>` has both at count 20, and the shallower one is the
 * row. Ties below two occurrences return nothing rather than a guess — one
 * element is not a repeating element, and a wrong default that looks confident
 * is worse than an empty field.
 */
export function guessRowElementPath(root: XmlNode): string | undefined {
  const paths = elementPaths(root).filter((p) => p.count >= 2);
  if (paths.length === 0) return undefined;

  const best = paths[0]!;
  const contenders = paths.filter((p) => p.count === best.count);
  contenders.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  return contenders[0]!.path;
}
