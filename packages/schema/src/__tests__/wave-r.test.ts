// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Phase 9 Wave R — rolls, polls and charts (ROLLS.md, CHARTS.md): the pure
 * parts shared by the hub, the runtime, the panels and the editor.
 */

import { describe, expect, it } from 'vitest';

import { arcPath, decimalsIn, driveValue, formatCount, mapDrive, plotPath, plotPoints } from '../charts.js';
import { applyTransforms, largestRemainder, type DataSet, type PollDataSource } from '../data.js';
import { createComposition, createLayer, createRollLayer, createShapeLayer, createTextLayer } from '../factory.js';
import { applyPollAction, competitionRanks, pollActionProblem, pollDataSet } from '../poll.js';
import {
  applyScrollAction,
  clampTravel,
  collectScrolls,
  implicitScroll,
  nextScrollSpeed,
  parseScrollSeek,
  resolveScroll,
  scrollAtEnd,
  scrollPosition,
  scrollTravel,
} from '../scroll.js';
import { parseTextBody, readTextLine, textBodyProblem, utf8Bytes } from '../text.js';
import { validateComposition, validateDataSources } from '../validate.js';
import type { LayerDrive, TableLayer } from '../types.js';

/* --------------------------------------------------------------- text */

describe('text source parsing', () => {
  const credits = '﻿# Credits\r\nProducer | Dave Clark\r\nCamera\tPat Smith\r\n\r\n\r\nThanks for watching\r\n\r\n';

  it('reads headings, pairs, gaps and lines, one row per line', () => {
    const set = parseTextBody('c', credits);
    expect(set.rows.map((r) => r['kind'])).toEqual(['heading', 'pair', 'pair', 'gap', 'line']);
    expect(set.rows[0]).toMatchObject({ n: 1, section: 1, text: 'Credits' });
    expect(set.rows[1]).toMatchObject({ left: 'Producer', right: 'Dave Clark', text: 'Producer Dave Clark' });
    expect(set.rows[2]).toMatchObject({ left: 'Camera', right: 'Pat Smith' });
    // A run of blank lines is one gap, and trailing blanks are none.
    expect(set.rows[3]).toMatchObject({ n: null, section: 2, kind: 'gap' });
    expect(set.rows[4]).toMatchObject({ n: 4, section: 2, text: 'Thanks for watching' });
  });

  it('splits by stanza, keeping the verse lines together', () => {
    const lyrics = 'Amazing grace\nhow sweet the sound\n\nThat saved a wretch\nlike me';
    const set = parseTextBody('l', lyrics, { split: 'stanzas' });
    expect(set.rows).toHaveLength(2);
    expect(set.rows[0]).toMatchObject({ n: 1, section: 1, kind: 'line', text: 'Amazing grace\nhow sweet the sound' });
    expect(set.rows[1]!['text']).toBe('That saved a wretch\nlike me');
  });

  it('leaves markup alone when asked, and honours an escaped hash', () => {
    expect(readTextLine('# not a heading', false)).toMatchObject({ kind: 'line', text: '# not a heading' });
    expect(readTextLine('\\#1 hit')).toMatchObject({ kind: 'line', text: '#1 hit' });
    // A pipe with no spaces is part of the text.
    expect(readTextLine('AC|DC')).toMatchObject({ kind: 'line', text: 'AC|DC' });
  });

  it('refuses a body over the limit rather than truncating it', () => {
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('😀')).toBe(4);
    const big = 'x'.repeat(256 * 1024 + 1);
    expect(textBodyProblem(big)).toMatch(/limit/);
    expect(() => parseTextBody('b', big)).toThrow(/limit/);
  });

  it('a text source is kept in the project or fetched, not both', () => {
    const wrap = (s: object) => ({ formatVersion: 1, sources: [s] });
    expect(validateDataSources(wrap({ id: 't', name: 'T', type: 'text', body: 'a' })).valid).toBe(true);
    expect(validateDataSources(wrap({ id: 't', name: 'T', type: 'text', url: 'https://x/a.txt' })).valid).toBe(true);
    const both = validateDataSources(wrap({ id: 't', name: 'T', type: 'text', body: 'a', url: 'https://x/a.txt' }));
    expect(both.valid).toBe(false);
  });
});

/* -------------------------------------------------------------- share */

describe('largest remainder and the share transform', () => {
  it('always adds up to exactly 100', () => {
    expect(largestRemainder([1, 1, 1])).toEqual([34, 33, 33]);
    expect(largestRemainder([2, 1])).toEqual([67, 33]);
    expect(largestRemainder([0, 0])).toEqual([0, 0]);
    const shares = largestRemainder([3, 7, 11, 13], 100, 1);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 9);
  });

  it('adds a percent column and a running start', () => {
    const data: DataSet = {
      id: 'p',
      columns: [{ key: 'label', type: 'string' }, { key: 'votes', type: 'number' }],
      rows: [{ label: 'A', votes: 1 }, { label: 'B', votes: 1 }, { label: 'C', votes: 2 }],
    };
    const out = applyTransforms(data, [{ op: 'share', column: 'votes', cumulative: 'from' }]);
    expect(out.rows.map((r) => r['percent'])).toEqual([25, 25, 50]);
    expect(out.rows.map((r) => r['from'])).toEqual([0, 25, 50]);
    expect(out.columns.map((c) => c.key)).toEqual(['label', 'votes', 'percent', 'from']);
  });
});

/* -------------------------------------------------------------- polls */

describe('polls', () => {
  const poll: PollDataSource = {
    id: 'poll',
    name: 'Poll',
    type: 'poll',
    question: 'Which?',
    options: [{ id: 'a', label: 'A', color: '#f00' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
    votes: { a: 5, b: 5, c: 2 },
  };

  it('emits one row per option with percentages that sum to 100 and tied leaders', () => {
    const set = pollDataSet(poll);
    expect(set.rows.map((r) => r['percent'])).toEqual([42, 42, 16]);
    expect(set.rows.map((r) => r['rank'])).toEqual([1, 1, 3]);
    expect(set.rows.map((r) => r['leader'])).toEqual([true, true, false]);
    expect(set.rows[0]).toMatchObject({ option: 'a', label: 'A', color: '#f00', total: 12, status: 'open', question: 'Which?' });
  });

  it('nobody leads a poll with no votes', () => {
    const set = pollDataSet({ ...poll, votes: {} });
    expect(set.rows.every((r) => r['leader'] === false && r['percent'] === 0)).toBe(true);
  });

  it('counts, corrects, closes and resets', () => {
    let p = applyPollAction(poll, { type: 'vote', option: 'c' });
    expect(p.votes!['c']).toBe(3);
    p = applyPollAction(p, { type: 'vote', option: 'c', delta: -10 });
    expect(p.votes!['c']).toBe(0);
    p = applyPollAction(p, { type: 'set', option: 'b', value: 9 });
    expect(p.votes!['b']).toBe(9);
    p = applyPollAction(p, { type: 'close' });
    expect(pollDataSet(p).rows[0]!['status']).toBe('closed');
    p = applyPollAction(p, { type: 'reset' });
    expect(p.votes).toBeUndefined();
    expect(p.status).toBe('open');
  });

  it('names a bad option or count', () => {
    expect(pollActionProblem(poll, { type: 'vote', option: 'zz' })).toBe('error.pollOption');
    expect(pollActionProblem(poll, { type: 'set', option: 'a', value: -1 })).toBe('error.pollValue');
    expect(pollActionProblem(poll, { type: 'vote', option: 'a', delta: 1.5 })).toBe('error.pollValue');
    expect(competitionRanks([3, 9, 9, 1])).toEqual([3, 1, 1, 4]);
  });

  it('validates option ids and stray votes', () => {
    const wrap = (s: object) => ({ formatVersion: 1, sources: [s] });
    expect(validateDataSources(wrap(poll)).valid).toBe(true);
    const dup = { ...poll, options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'A again' }], votes: {} };
    expect(validateDataSources(wrap(dup)).valid).toBe(false);
    expect(validateDataSources(wrap({ ...poll, votes: { nope: 1 } })).valid).toBe(false);
  });
});

/* ------------------------------------------------------------- scroll */

describe('scroll transport', () => {
  const info = { extent: 100, end: 'hold' as const };

  it('runs from the anchor, pauses where it is, and reverses at once from the end', () => {
    let s = applyScrollAction(undefined, 'play', 1_000);
    expect(scrollTravel(s, 11_000)).toBe(10);
    s = applyScrollAction(s, 'pause', 11_000, {}, info);
    expect(scrollPosition(s, 99_000, info)).toBe(10);
    s = applyScrollAction(s, 'play', 20_000, {}, info);
    // Long past the end: shown parked at the extent.
    expect(scrollPosition(s, 500_000, info)).toBe(100);
    expect(scrollAtEnd(s, 500_000, info)).toBe(true);
    // Reversing rebases on the clamped end, so it moves back immediately.
    s = applyScrollAction(s, 'backward', 500_000, {}, info);
    expect(scrollPosition(s, 502_000, info)).toBe(98);
  });

  it('changes speed on the ladder without a jump, keeping direction', () => {
    let s = applyScrollAction(undefined, 'forward', 0);
    s = applyScrollAction(s, 'faster', 10_000, {}, info);
    expect(s.rate).toBe(1.25);
    expect(s.base).toBe(10);
    expect(scrollTravel(s, 14_000)).toBe(15);
    s = applyScrollAction(s, 'backward', 14_000, {}, info);
    s = applyScrollAction(s, 'slower', 14_000, {}, info);
    expect(s.rate).toBe(-1);
    expect(nextScrollSpeed(4, 1)).toBe(4);
    expect(nextScrollSpeed(0.25, -1)).toBe(0.25);
    expect(nextScrollSpeed(1.1, -1)).toBe(1);
    s = applyScrollAction(s, 'speed', 14_000, { value: 50 }, info);
    expect(s.rate).toBe(-10);
  });

  it('jogs, seeks by seconds and percent, restarts and ends', () => {
    let s = applyScrollAction(undefined, 'seek', 0, { value: 40 }, info);
    expect(s.base).toBe(40);
    s = applyScrollAction(s, 'jog', 0, { value: -3 }, info);
    expect(s.base).toBe(37);
    s = applyScrollAction(s, 'seek', 0, { value: 50, percent: true }, info);
    expect(s.base).toBe(50);
    s = applyScrollAction(s, 'end', 0, {}, info);
    expect(s.base).toBe(100);
    s = applyScrollAction(s, 'restart', 0, {}, info);
    expect(s.base).toBe(0);
    expect(parseScrollSeek('1:30')).toEqual({ value: 90 });
    expect(parseScrollSeek('25%')).toEqual({ value: 25, percent: true });
    expect(parseScrollSeek('soon')).toBeNull();
  });

  it('wraps a loop and starts a PLAY-started roll from the PLAY', () => {
    expect(clampTravel(250, { extent: 100, end: 'loop' })).toBe(50);
    expect(clampTravel(-10, { extent: 100, end: 'loop' })).toBe(90);
    expect(implicitScroll('play', 5_000)).toEqual({ running: true, anchor: 5_000, base: 0, rate: 1 });
    expect(implicitScroll('operator', 5_000).running).toBe(false);
    expect(resolveScroll({ scrolls: {}, playAt: 5_000 }, 'main', undefined).running).toBe(true);
    expect(resolveScroll(undefined, 'main', 'play').running).toBe(false);
  });

  it('collects the scrolls a graphic shows, mounts included', () => {
    const roll = { ...createRollLayer(), id: 'r1', name: 'Credits', scrollId: 'credits' };
    const nested = { layers: [{ ...createRollLayer(), id: 'r2' }] };
    const refs = collectScrolls([roll, { id: 'n', type: 'composition', ref: 'x' }], () => nested);
    expect(refs.map((r) => r.id)).toEqual(['credits', 'main']);
    expect(refs[0]).toMatchObject({ layerName: 'Credits', direction: 'up', start: 'play', end: 'hold' });
  });
});

/* -------------------------------------------------------------- charts */

describe('drives', () => {
  const rows = [{ team: 'A', votes: 30, goal: 60 }, { team: 'B', votes: 60, goal: 60 }];
  const bar: LayerDrive = { property: 'width', from: { column: 'votes' }, range: [0, 400] };

  it('scales a cell against the largest row by default', () => {
    expect(driveValue(bar, { row: rows[0]!, rows })).toBe(200);
    expect(driveValue(bar, { row: rows[1]!, rows })).toBe(400);
  });

  it('reads a goal from the same row, a total, and a field', () => {
    const meter: LayerDrive = { ...bar, domain: { max: { column: 'goal' } } };
    expect(driveValue(meter, { row: rows[0]!, rows })).toBe(200);
    const share: LayerDrive = { ...bar, domain: { max: 'total' } };
    expect(driveValue(share, { row: rows[0]!, rows })).toBeCloseTo(133.33, 1);
    const field: LayerDrive = { property: 'sweep', from: { binding: 'raised' }, domain: { max: { binding: 'target' } }, range: [0, 360] };
    expect(driveValue(field, { field: (n) => (n === 'raised' ? '2500' : 10_000) })).toBe(90);
  });

  it('leaves the property alone with nothing to read, and clamps unless told not to', () => {
    expect(driveValue(bar, { row: { votes: null }, rows })).toBeNull();
    expect(mapDrive(150, 0, 100, [0, 10])).toBe(10);
    expect(mapDrive(150, 0, 100, [0, 10], false)).toBe(15);
  });

  it('reads a source row picked by where', () => {
    const d: LayerDrive = { property: 'height', from: { source: 's', column: 'votes', where: { column: 'team', value: 'A' } }, range: [0, 100] };
    const source = () => ({ id: 's', columns: [], rows });
    expect(driveValue(d, { source })).toBe(50);
  });
});

describe('arcs and plots', () => {
  it('draws a ring as a stroked arc and a wedge as a closed fill', () => {
    const ring = arcPath(200, 200, { sweep: 90, thickness: 20 });
    expect(ring.stroked).toBe(true);
    expect(ring.d).toBe('M100 10 A90 90 0 0 1 190 100');
    const wedge = arcPath(200, 200, { sweep: 90 });
    expect(wedge.d).toBe('M100 100 L100 0 A100 100 0 0 1 200 100 Z');
    expect(arcPath(200, 200, { sweep: 0 }).d).toBe('');
    // A full circle is two halves — one SVG arc cannot end where it starts.
    expect(arcPath(100, 100, { sweep: 360, thickness: 10 }).d.match(/A/g)).toHaveLength(2);
  });

  it('plots rows in the box, skipping gaps, and closes an area to the baseline', () => {
    const rows = [{ t: 10 }, { t: 20 }, { t: 15 }];
    expect(plotPoints(rows, { y: 't' }, 100, 50)).toEqual([[0, 50], [50, 0], [100, 25]]);
    expect(plotPath(rows, { y: 't', area: true }, 100, 50)).toBe('M0 50 L50 0 L100 25 L100 50 L0 50 Z');
    // A missing reading keeps its place on the axis: the hour after it is still the next hour.
    const gappy = plotPoints([{ t: 10 }, { t: null }, { t: 20 }, { t: 15 }], { y: 't' }, 300, 50);
    expect(gappy.map(([x]) => x)).toEqual([0, 200, 300]);
  });

  it('a monotone line never overshoots its readings', () => {
    const rows = [{ t: 0 }, { t: 10 }, { t: 10 }, { t: 0 }];
    const d = plotPath(rows, { y: 't', curve: 'monotone' }, 300, 100);
    const ys = [...d.matchAll(/[ML ]?(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[2]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(100);
  });

  it('formats a count', () => {
    expect(decimalsIn(41.25)).toBe(2);
    expect(formatCount(41.3, 0, '', '%')).toBe('41%');
    expect(formatCount(-0.001, 1)).toBe('0.0');
  });
});

/* ---------------------------------------------------------- validation */

describe('Wave R validation', () => {
  const comp = (layers: unknown[]) => createComposition({ name: 'T', layers: layers as never });

  it('accepts a new roll and the chart props on the right layers', () => {
    const arc = { ...createShapeLayer({ shape: 'ellipse' }), arc: { sweep: 120, thickness: 20 }, trim: 0.5 };
    const line = { ...createShapeLayer({ shape: 'path' }), plot: { source: 'w', y: 'temp', curve: 'monotone' } };
    const text = { ...createTextLayer(), count: { duration: 0.6, suffix: '%' } };
    // A plotted path draws its own outline: it needs no `path` data.
    const plotted = { ...line, id: 'plotted', path: '' };
    const r = validateComposition(comp([createLayer('roll'), arc, line, plotted, text]));
    expect(r.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('refuses a property both keyframed and driven, and a sweep with no arc', () => {
    const layer = {
      ...createShapeLayer(),
      keyframes: { opacity: [{ t: 0, v: 0 }, { t: 1, v: 1 }] },
      drives: [
        { property: 'opacity', from: { binding: 'x' }, range: [0, 1] },
        { property: 'sweep', from: { binding: 'x' }, range: [0, 360] },
      ],
    };
    const r = validateComposition(comp([layer]));
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.path)).toEqual(expect.arrayContaining(['/layers/0/drives/0/property', '/layers/0/drives/1/property']));
  });

  it('a column on its own only reads a row inside a table, and a roll cannot be a cell', () => {
    const outside = { ...createShapeLayer(), drives: [{ property: 'width', from: { column: 'votes' }, range: [0, 100] }] };
    expect(validateComposition(comp([outside])).valid).toBe(false);
    const table = createLayer('table') as TableLayer;
    const bar = { ...createShapeLayer(), drives: [{ property: 'width', from: { column: 'w' }, range: [0, 100] }] };
    const withBar = { ...table, row: { ...table.row, cells: [...table.row.cells, bar] } };
    expect(validateComposition(comp([withBar])).errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    const withRoll = { ...table, row: { ...table.row, cells: [createRollLayer()] } };
    expect(validateComposition(comp([withRoll])).valid).toBe(false);
  });
});
