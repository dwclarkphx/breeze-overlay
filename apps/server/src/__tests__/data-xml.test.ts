// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The XML side of the data layer.
 *
 * Two things are being defended here, and they are different things. The
 * *parser* tests are about surviving what feeds actually contain — CDATA,
 * unclosed tags inside a description, namespace prefixes, an entity nobody
 * declared. The *adapter* tests are about the promise the RSS type makes: that
 * a graphic bound to `title` keeps working when the feed underneath it changes
 * dialect. The Atom and RSS fixtures below describe the same two stories on
 * purpose, and assert the same rows come out.
 */

import { describe, expect, it } from 'vitest';

import {
  childText,
  childrenNamed,
  decodeEntities,
  elementPaths,
  guessRowElementPath,
  parseXml,
  selectPath,
} from '../data/xml.js';
import {
  FEED_COLUMNS,
  XmlParseError,
  detectFeedKind,
  feedToDataSet,
  inspectXml,
  normalizeDate,
  stripHtml,
  xmlToDataSet,
} from '../data/parse-xml.js';

/* ------------------------------------------------------------------ parser */

describe('parseXml', () => {
  it('reads elements, attributes and text', () => {
    const root = parseXml('<game id="7"><home>Mesa</home><away>Tempe</away></game>')!;
    expect(root.name).toBe('game');
    expect(root.attrs.id).toBe('7');
    expect(childText(root, 'home')).toBe('Mesa');
    expect(childText(root, 'away')).toBe('Tempe');
  });

  it('handles self-closing tags and unquoted attributes', () => {
    const root = parseXml('<feed><link href=http://x.test rel="self"/><entry/></feed>')!;
    const link = childrenNamed(root, 'link')[0]!;
    expect(link.attrs.href).toBe('http://x.test');
    expect(link.attrs.rel).toBe('self');
    expect(childrenNamed(root, 'entry')).toHaveLength(1);
  });

  it('keeps CDATA literal, entities and all', () => {
    // The classic mistake is decoding CDATA. A description wrapping HTML says
    // "&amp;" because it means an ampersand *in the rendered page*, and
    // decoding it here would corrupt the markup a consumer re-parses.
    const root = parseXml('<d><![CDATA[<b>Smith &amp; Jones</b>]]></d>')!;
    expect(root.text).toBe('<b>Smith &amp; Jones</b>');
  });

  it('decodes entities in ordinary text but leaves unknown ones alone', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42; &notathing;')).toBe(
      'a & b <c> A B &notathing;',
    );
  });

  it('survives an unclosed tag inside a description', () => {
    /*
     * A strict pop would treat </description> as closing <p> and then swallow
     * every sibling that followed. Feeds ship unclosed <p> and <br> constantly,
     * and losing the rest of the channel over one is not acceptable.
     */
    const root = parseXml(
      '<channel><item><description><p>one</description><title>Kept</title></item></channel>',
    )!;
    const item = selectPath(root, 'item')[0]!;
    expect(childText(item, 'title')).toBe('Kept');
  });

  it('ignores comments, processing instructions and the XML declaration', () => {
    const root = parseXml('<?xml version="1.0"?><!-- note --><a><b>1</b></a>')!;
    expect(root.name).toBe('a');
    expect(childText(root, 'b')).toBe('1');
  });

  it('skips a doctype without resolving anything inside it', () => {
    /*
     * The XXE case. An internal subset declaring an external entity must be
     * skipped as opaque text — brackets balanced — and the reference left as
     * literal characters. If this ever returns the contents of a file, the
     * parser has grown a capability it must not have.
     */
    const doc =
      '<?xml version="1.0"?>' +
      '<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>' +
      '<foo><bar>&xxe;</bar></foo>';
    const root = parseXml(doc)!;
    expect(root.name).toBe('foo');
    expect(childText(root, 'bar')).toBe('&xxe;');
  });

  it('does not stop a tag at a > inside a quoted attribute', () => {
    const root = parseXml('<a href="x?p=1>2" title="ok"/>')!;
    expect(root.attrs.href).toBe('x?p=1>2');
    expect(root.attrs.title).toBe('ok');
  });

  it('matches close tags across namespace prefixes', () => {
    const root = parseXml('<rss><dc:creator>Ann</dc:creator></rss>')!;
    const creator = childrenNamed(root, 'creator')[0]!;
    expect(creator.name).toBe('dc:creator');
    expect(creator.local).toBe('creator');
    expect(creator.text).toBe('Ann');
  });

  it('returns null for a document with no elements', () => {
    // An origin serving an HTML error page, or JSON, with a 200. The adapters
    // turn this into a message in the editor rather than a stack trace.
    expect(parseXml('')).toBeNull();
    expect(parseXml('   \n  ')).toBeNull();
  });

  it('strips a BOM rather than making it part of the first tag name', () => {
    const root = parseXml('﻿<a><b>1</b></a>')!;
    expect(root.name).toBe('a');
  });
});

describe('selectPath', () => {
  const doc = parseXml('<rss><channel><item><t>a</t></item><item><t>b</t></item></channel></rss>')!;

  it('walks a slash path', () => {
    expect(selectPath(doc, 'channel/item')).toHaveLength(2);
  });

  it('tolerates the root element being included in the path', () => {
    // People copy the path out of the document they are looking at, root and
    // all. Refusing that is a support ticket, not a safeguard.
    expect(selectPath(doc, 'rss/channel/item')).toHaveLength(2);
  });

  it('returns nothing for a path that does not exist', () => {
    expect(selectPath(doc, 'channel/nope')).toEqual([]);
  });
});

describe('elementPaths / guessRowElementPath', () => {
  const doc = parseXml(
    '<results>' +
      '<game><team>A</team><team>B</team></game>' +
      '<game><team>C</team><team>D</team></game>' +
      '</results>',
  )!;

  it('counts every repeating path', () => {
    const paths = Object.fromEntries(elementPaths(doc).map((p) => [p.path, p.count]));
    expect(paths.game).toBe(2);
    expect(paths['game/team']).toBe(4);
  });

  it('prefers the shallower path when depth ties on count', () => {
    // `game/team` occurs more often than `game`, but a graphic's row is a game.
    // The shallowest of the top-count candidates is the right default, and here
    // the counts differ, so the highest-count rule alone would pick wrong —
    // this is the case that makes the tie-break worth having.
    const doc2 = parseXml('<r><g><t>1</t></g><g><t>2</t></g></r>')!;
    expect(guessRowElementPath(doc2)).toBe('g');
  });

  it('declines to guess when nothing repeats', () => {
    expect(guessRowElementPath(parseXml('<a><b>1</b></a>')!)).toBeUndefined();
  });
});

/* --------------------------------------------------------------- generic */

describe('xmlToDataSet', () => {
  const doc = `
    <results>
      <game id="1" status="final">
        <home>Mesa</home><away>Tempe</away>
        <score home="4" away="2"/>
      </game>
      <game id="2" status="live">
        <home>Gilbert</home><away>Chandler</away>
        <score home="1" away="1"/>
      </game>
    </results>`;

  it('maps a repeating element to rows', () => {
    const data = xmlToDataSet('games', doc, { rowPath: 'game' });
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0]).toMatchObject({ id: 1, status: 'final', home: 'Mesa', away: 'Tempe' });
  });

  it('exposes a child element’s attributes as child_attr columns', () => {
    // <score home="4" away="2"/> has no text at all. An adapter that only reads
    // text returns a table of empty scores.
    const data = xmlToDataSet('games', doc, { rowPath: 'game' });
    expect(data.rows[0]).toMatchObject({ score_home: 4, score_away: 2 });
  });

  it('joins repeated children rather than keeping only the last', () => {
    const data = xmlToDataSet(
      'x',
      '<r><i><tag>a</tag><tag>b</tag></i></r>',
      { rowPath: 'i' },
    );
    expect(data.rows[0]!.tag).toBe('a, b');
  });

  it('types a numeric column as a number so it sorts as one', () => {
    const data = xmlToDataSet('games', doc, { rowPath: 'game' });
    expect(data.columns.find((c) => c.key === 'id')?.type).toBe('number');
  });

  it('guesses the repeating element when no path is given', () => {
    expect(xmlToDataSet('games', doc).rows).toHaveLength(2);
  });

  it('throws a readable error on a non-XML body', () => {
    expect(() => xmlToDataSet('x', '{"not":"xml"}')).toThrow(XmlParseError);
  });
});

/* ------------------------------------------------------------- RSS / Atom */

const RSS_2 = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Valley Sports</title>
    <item>
      <title>Mesa wins &amp; advances</title>
      <link>https://example.test/1</link>
      <pubDate>Sat, 01 Aug 2026 19:55:00 GMT</pubDate>
      <description><![CDATA[<p>A late run.</p><p>Next up: Tempe.</p>]]></description>
      <dc:creator>Ann Reporter</dc:creator>
      <category>baseball</category>
      <category>playoffs</category>
      <guid>tag:1</guid>
      <enclosure url="https://example.test/1.jpg" type="image/jpeg"/>
    </item>
    <item>
      <title>Tempe rallies</title>
      <link>https://example.test/2</link>
      <pubDate>Sat, 01 Aug 2026 18:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Valley Sports</title>
  <entry>
    <title>Mesa wins &amp; advances</title>
    <link rel="self" href="https://example.test/1.atom"/>
    <link rel="alternate" href="https://example.test/1"/>
    <updated>2026-08-01T19:55:00Z</updated>
    <summary type="html">&lt;p&gt;A late run.&lt;/p&gt;&lt;p&gt;Next up: Tempe.&lt;/p&gt;</summary>
    <author><name>Ann Reporter</name></author>
    <category term="baseball"/>
    <category term="playoffs"/>
    <id>tag:1</id>
  </entry>
  <entry>
    <title>Tempe rallies</title>
    <link rel="alternate" href="https://example.test/2"/>
    <updated>2026-08-01T18:00:00Z</updated>
  </entry>
</feed>`;

const RSS_1_RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
  <channel><title>Valley Sports</title></channel>
  <item><title>Mesa wins</title><link>https://example.test/1</link></item>
  <item><title>Tempe rallies</title><link>https://example.test/2</link></item>
</rdf:RDF>`;

describe('detectFeedKind', () => {
  it('recognizes all three dialects', () => {
    expect(detectFeedKind(parseXml(RSS_2)!)).toBe('rss');
    expect(detectFeedKind(parseXml(ATOM)!)).toBe('atom');
    expect(detectFeedKind(parseXml(RSS_1_RDF)!)).toBe('rdf');
  });

  it('does not claim an arbitrary document', () => {
    expect(detectFeedKind(parseXml('<results><game/></results>')!)).toBeNull();
  });
});

describe('feedToDataSet', () => {
  it('always declares the full column set', () => {
    // Even the sparse second item must not cost the table a column. A ticker
    // bound to `date` should show a blank cell, not lose its layout.
    const data = feedToDataSet('news', RSS_2);
    expect(data.columns.map((c) => c.key)).toEqual(FEED_COLUMNS.map((c) => c.key));
  });

  it('normalizes RSS 2.0', () => {
    const [first] = feedToDataSet('news', RSS_2).rows;
    expect(first).toMatchObject({
      title: 'Mesa wins & advances',
      link: 'https://example.test/1',
      date: '2026-08-01T19:55:00.000Z',
      author: 'Ann Reporter',
      category: 'baseball, playoffs',
      image: 'https://example.test/1.jpg',
      guid: 'tag:1',
    });
    expect(first!.description).toBe('A late run. Next up: Tempe.');
  });

  it('normalizes Atom to the same rows', () => {
    /*
     * The whole promise of this adapter in one assertion. Atom puts the link in
     * an attribute, dates in ISO, the author in a nested <name> and categories
     * in @term — and a graphic bound to these keys should not be able to tell.
     */
    const rss = feedToDataSet('news', RSS_2).rows;
    const atom = feedToDataSet('news', ATOM).rows;

    for (const key of ['title', 'link', 'date', 'description', 'author', 'category', 'guid']) {
      expect(atom[0]![key], key).toEqual(rss[0]![key]);
    }
    expect(atom[1]!.title).toBe(rss[1]!.title);
  });

  it('prefers rel="alternate" over rel="self" for an Atom link', () => {
    // Ordered self-first in the fixture deliberately: taking the first link
    // would put the machine-readable feed URL on air instead of the article.
    expect(feedToDataSet('news', ATOM).rows[0]!.link).toBe('https://example.test/1');
  });

  it('reads RSS 1.0 items that sit outside the channel', () => {
    const rows = feedToDataSet('news', RSS_1_RDF).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.title).toBe('Mesa wins');
  });

  it('refuses a document that is not a feed, and says which type to use', () => {
    expect(() => feedToDataSet('news', '<results><game/></results>')).toThrow(/Generic XML/);
  });
});

describe('stripHtml', () => {
  it('inserts a space at block boundaries', () => {
    // Without this, "…won.</p><p>Next…" crawls past as "won.Next".
    expect(stripHtml('<p>won.</p><p>Next up.</p>')).toBe('won. Next up.');
  });

  it('drops script and style content entirely', () => {
    expect(stripHtml('a<script>evil()</script>b')).toBe('a b');
  });

  it('decodes entities after stripping', () => {
    expect(stripHtml('<b>Smith &amp; Jones</b>')).toBe('Smith & Jones');
  });
});

describe('normalizeDate', () => {
  it('converts RFC 822 to ISO so both dialects sort together', () => {
    expect(normalizeDate('Sat, 01 Aug 2026 19:55:00 GMT')).toBe('2026-08-01T19:55:00.000Z');
  });

  it('passes ISO through unchanged in meaning', () => {
    expect(normalizeDate('2026-08-01T19:55:00Z')).toBe('2026-08-01T19:55:00.000Z');
  });

  it('keeps an unparseable string rather than showing "Invalid Date"', () => {
    expect(normalizeDate('sometime tuesday')).toBe('sometime tuesday');
  });

  it('is empty for an absent date', () => {
    expect(normalizeDate('')).toBe('');
  });
});

describe('inspectXml', () => {
  it('suggests the feed path and flags the dialect', () => {
    const found = inspectXml(RSS_2);
    expect(found.feed).toBe('rss');
    expect(found.rowPath).toBe('channel/item');
  });

  it('offers ranked candidates for an unfamiliar export', () => {
    const found = inspectXml('<r><g><t>1</t></g><g><t>2</t></g></r>');
    expect(found.feed).toBeNull();
    expect(found.rowPath).toBe('g');
    expect(found.candidates.map((c) => c.path)).toContain('g/t');
  });
});
