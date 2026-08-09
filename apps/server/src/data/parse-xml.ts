// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * XML payload → DataSet. Two adapters over one parser.
 *
 * **Generic XML** is the honest one: point at a repeating element, its children
 * and attributes become columns. It handles the league-office export nobody
 * documented.
 *
 * **RSS/Atom** is a *normaliser*, and that is the whole reason it is separate.
 * The two formats disagree about almost everything — where the link lives (text
 * in RSS, an `href` attribute in Atom), what the date field is called
 * (`pubDate`, `dc:date`, `updated`, `published`), how the body is marked up —
 * and a graphic bound to `title` must not break because a station switched feed
 * software. So the adapter emits one fixed column set regardless of which
 * dialect arrived, and the generic adapter stays available for anyone who wants
 * the raw shape instead.
 */

import { conform, type DataColumn, type DataRow, type DataSet } from '@breeze/schema';

import { headerToKey, inferColumnsFromTextRows } from './parse.js';
import {
  childNamed,
  childText,
  childrenNamed,
  decodeEntities,
  elementPaths,
  guessRowElementPath,
  parseXml,
  selectPath,
  type XmlNode,
} from './xml.js';

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

/* ---------------------------------------------------------- generic XML */

export interface XmlParseOptions {
  /**
   * Slash path to the repeating element — `channel/item`. Blank means "guess",
   * which is a first-run convenience only: a saved source always carries an
   * explicit path, because a feed that grows a second repeating element would
   * otherwise silently start reading the wrong one.
   */
  rowPath?: string;
  columns?: DataColumn[];
}

/**
 * Flatten one element into a row.
 *
 * The mapping, and why each part earns its place:
 *
 *  - **Own attributes** become columns directly. `<team id="12">` is a column
 *    called `id`.
 *  - **Child element text** becomes a column named for the child.
 *  - **Child attributes** become `child_attr`. Not optional: Atom's link is
 *    `<link href="…"/>` with no text at all, and an adapter that only reads text
 *    returns a table of empty links.
 *  - **Repeated children** join with ", " rather than overwrite. Multiple
 *    `<category>` elements are one legitimate cell, and last-one-wins would
 *    quietly drop the rest.
 *  - **Grandchildren** are flattened one level as `child_grandchild`, matching
 *    what the JSON adapter does with nested objects, and no deeper. A column key
 *    with four underscores in it is not something anyone binds a cell to.
 */
export function xmlRowFromElement(element: XmlNode): DataRow {
  const row: DataRow = {};

  const put = (key: string, value: string): void => {
    const k = headerToKey(key, Object.keys(row).length);
    if (!k) return;
    const prior = row[k];
    if (prior === undefined || prior === null || prior === '') row[k] = value;
    else if (value !== '') row[k] = `${String(prior)}, ${value}`;
  };

  for (const [name, value] of Object.entries(element.attrs)) put(name, value);

  for (const child of element.children) {
    if (child.text) put(child.local, child.text);
    for (const [name, value] of Object.entries(child.attrs)) {
      put(`${child.local}_${name}`, value);
    }
    if (!child.text && child.children.length > 0) {
      for (const grand of child.children) {
        if (grand.text) put(`${child.local}_${grand.local}`, grand.text);
      }
    }
  }

  return row;
}

export function xmlToDataSet(id: string, text: string, opts: XmlParseOptions = {}): DataSet {
  const root = parseXml(text);
  if (!root) {
    throw new XmlParseError(
      'no XML elements in the response — check the URL returns XML rather than an error page',
    );
  }

  const path = opts.rowPath?.trim() ?? '';
  const elements = path ? selectPath(root, path) : autoRows(root);

  const rows = elements.map(xmlRowFromElement);
  /*
   * Typed from the text, not from `typeof`. Every value XML yields is a string,
   * so the schema's `inferColumns` would type a score column as text — and a
   * table sorted on it would put 10 before 9 on air. Same reason the CSV adapter
   * samples its cells.
   */
  const columns = opts.columns?.length ? opts.columns : inferColumnsFromTextRows(rows);
  return { id, columns, rows: conform(rows, columns) };
}

/**
 * Rows for a source with no path yet: the deepest repeating element found by
 * `guessRowElementPath`, or the root's own children if nothing repeats.
 */
function autoRows(root: XmlNode): XmlNode[] {
  const guessed = guessPath(root);
  return guessed ? selectPath(root, guessed) : root.children;
}

/**
 * Where the rows probably are.
 *
 * Feed shapes are checked before the count-based heuristic, because their
 * repeating element is *known* — spending a guess on a document that says
 * `<rss>` at the top is how you end up pointed at `channel/item/category`.
 */
function guessPath(root: XmlNode): string | undefined {
  const feed = detectFeedKind(root);
  if (feed === 'rss') return 'channel/item';
  if (feed === 'rdf') return 'item';
  if (feed === 'atom') return 'entry';
  return guessRowElementPath(root);
}

/* ------------------------------------------------------------- RSS / Atom */

export type FeedKind = 'rss' | 'rdf' | 'atom' | null;

export function detectFeedKind(root: XmlNode): FeedKind {
  const name = root.local.toLowerCase();
  if (name === 'rss') return 'rss';
  if (name === 'feed') return 'atom';
  // RSS 1.0 is an RDF document whose items are top-level siblings of the
  // channel rather than inside it — a shape that catches out every adapter
  // written against RSS 2.0 alone.
  if (name === 'rdf') return 'rdf';
  if (name === 'channel' && childrenNamed(root, 'item').length > 0) return 'rss';
  return null;
}

/**
 * Columns an RSS/Atom source always has, in this order.
 *
 * Fixed rather than inferred, and declared even when a particular feed leaves
 * one empty. A ticker bound to `date` must not lose its column because today's
 * batch of headlines happens to be undated — the cell should be blank, and the
 * graphic should still lay out.
 */
export const FEED_COLUMNS: DataColumn[] = [
  { key: 'title', label: 'Title', type: 'string' },
  { key: 'link', label: 'Link', type: 'string' },
  { key: 'date', label: 'Date', type: 'string' },
  { key: 'description', label: 'Description', type: 'string' },
  { key: 'author', label: 'Author', type: 'string' },
  { key: 'category', label: 'Category', type: 'string' },
  { key: 'image', label: 'Image', type: 'string' },
  { key: 'guid', label: 'ID', type: 'string' },
];

/**
 * Tags out, entities decoded, whitespace collapsed.
 *
 * An RSS `<description>` is usually a lump of HTML. A crawl layer renders text,
 * not markup, so leaving it raw puts `<p>` on air — and stripping tags without
 * inserting a space would run "…won.</p><p>Next…" together into "won.Next".
 */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Feed dates, normalised to ISO 8601.
 *
 * RSS uses RFC 822 ("Sat, 02 Aug 2026 19:55:00 -0700"), Atom uses ISO, and
 * `dc:date` can be either. Storing whichever arrived would make `sort(date)` a
 * lexical sort over two incompatible formats — the newest item lands wherever
 * its day name falls in the alphabet. Unparseable input is kept verbatim, since
 * showing the feed's own string beats showing "Invalid Date".
 */
export function normalizeDate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : trimmed;
}

/** The `<link>` for an entry, across both dialects' disagreement about it. */
function feedLink(item: XmlNode): string {
  const links = childrenNamed(item, 'link');
  if (links.length === 0) return '';

  // Atom: prefer rel="alternate" (the human page) over rel="self",
  // rel="enclosure" or a paging link, all of which appear on real entries.
  const alternate = links.find((l) => (l.attrs.rel ?? 'alternate').toLowerCase() === 'alternate');
  const chosen = alternate ?? links[0]!;
  return chosen.attrs.href ?? chosen.text;
}

function feedDescription(item: XmlNode): string {
  // `content:encoded` carries the full article where `description` is a teaser;
  // the teaser is what a ticker wants, so description wins when both exist.
  const raw =
    childText(item, 'description', 'summary') ||
    childNamed(item, 'content')?.text ||
    childText(item, 'encoded');
  return stripHtml(raw);
}

function feedAuthor(item: XmlNode): string {
  const author = childNamed(item, 'author');
  if (author) {
    // Atom nests it: <author><name>…</name></author>.
    const name = childText(author, 'name');
    if (name) return name;
    if (author.text) return author.text;
  }
  return childText(item, 'creator', 'dc:creator');
}

/**
 * An image URL for the entry, if the feed offers one.
 *
 * Three conventions in the wild, none of them standard: an `<enclosure>` with an
 * image MIME type (RSS), `<media:content>` / `<media:thumbnail>` (Media RSS,
 * which most news feeds use), and an `<image>` element. Checked in that order.
 */
function feedImage(item: XmlNode): string {
  for (const enclosure of childrenNamed(item, 'enclosure')) {
    const type = enclosure.attrs.type ?? '';
    if (type.startsWith('image/') && enclosure.attrs.url) return enclosure.attrs.url;
  }
  for (const name of ['thumbnail', 'content']) {
    for (const media of childrenNamed(item, name)) {
      const type = media.attrs.type ?? media.attrs.medium ?? '';
      if (media.attrs.url && (type === '' || type.startsWith('image') || type === 'image')) {
        return media.attrs.url;
      }
    }
  }
  const image = childNamed(item, 'image');
  if (image) return image.attrs.href ?? image.attrs.url ?? childText(image, 'url');
  return '';
}

export interface FeedParseOptions {
  /** Declared columns win, as everywhere else. Omit for `FEED_COLUMNS`. */
  columns?: DataColumn[];
}

export function feedToDataSet(id: string, text: string, opts: FeedParseOptions = {}): DataSet {
  const root = parseXml(text);
  if (!root) {
    throw new XmlParseError(
      'no XML elements in the response — check the URL is a feed and not an HTML page',
    );
  }

  const kind = detectFeedKind(root);
  if (!kind) {
    throw new XmlParseError(
      `not an RSS or Atom feed (root element is <${root.name}>). Use the Generic XML source type for other documents.`,
    );
  }

  const items =
    kind === 'atom'
      ? selectPath(root, 'entry')
      : kind === 'rdf'
        ? [...selectPath(root, 'item'), ...selectPath(root, 'channel/item')]
        : selectPath(root, 'channel/item');

  const rows: DataRow[] = items.map((item) => ({
    title: stripHtml(childText(item, 'title')),
    link: feedLink(item),
    date: normalizeDate(childText(item, 'pubdate', 'published', 'updated', 'date', 'issued')),
    description: feedDescription(item),
    author: feedAuthor(item),
    category: childrenNamed(item, 'category')
      .map((c) => c.text || c.attrs.term || '')
      .filter(Boolean)
      .join(', '),
    image: feedImage(item),
    guid: childText(item, 'guid', 'id') || feedLink(item),
  }));

  const columns = opts.columns?.length ? opts.columns : FEED_COLUMNS;
  return { id, columns, rows: conform(rows as DataRow[], columns) };
}

/** Channel-level metadata, shown in the editor so a feed is identifiable. */
export function feedTitle(text: string): string {
  const root = parseXml(text);
  if (!root) return '';
  const kind = detectFeedKind(root);
  if (kind === 'atom') return childText(root, 'title');
  const channel = childNamed(root, 'channel') ?? root;
  return childText(channel, 'title');
}

/* ------------------------------------------------------------- inspection */

/**
 * What the editor's "find it" button asks for: a suggested path plus the other
 * candidates, so an operator staring at an unfamiliar export can pick rather
 * than type. Capped at 20 — a list longer than that is not a menu, it is the
 * document.
 */
export function inspectXml(text: string): {
  rowPath: string;
  feed: FeedKind;
  candidates: Array<{ path: string; count: number }>;
} {
  const root = parseXml(text);
  if (!root) throw new XmlParseError('no XML elements in the response');
  return {
    rowPath: guessPath(root) ?? '',
    feed: detectFeedKind(root),
    candidates: elementPaths(root)
      .filter((p) => p.count >= 2)
      .slice(0, 20),
  };
}

export { guessRowElementPath, parseXml, selectPath };
export type { XmlNode };
