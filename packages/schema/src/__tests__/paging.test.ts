// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import { createComposition, createLayer, createTableLayer } from '../factory.js';
import { pagedTables, pagesByDesign, tableAddress } from '../paging.js';
import type { Composition, CompositionLayer, GroupLayer, Layer, TableLayer } from '../types.js';

const table = (over: Partial<TableLayer>): TableLayer => createTableLayer({ id: 't', ...over });
const comp = (id: string, layers: Layer[]): Composition => createComposition({ id, name: id, layers });
const mount = (id: string, ref: string, over: Partial<CompositionLayer> = {}): CompositionLayer => ({
  ...(createLayer('composition') as CompositionLayer),
  id,
  ref,
  ...over,
});
const group = (id: string, children: Layer[]): GroupLayer => ({ ...(createLayer('group') as GroupLayer), id, children });

describe('tableAddress', () => {
  it('is the binding at the top level', () => {
    expect(tableAddress('table', 'standings', [])).toBe('standings');
  });

  it('is <mount>.<binding> inside a nested composition, using the innermost mount', () => {
    expect(tableAddress('a/b/table', 'standings', ['a', 'a/b'])).toBe('a/b.standings');
  });

  it('is the instance id when the table has no binding', () => {
    expect(tableAddress('grp/table', undefined, [])).toBe('grp/table');
  });

  it('does not take a mount whose id is only a prefix of another segment', () => {
    expect(tableAddress('ab/table', 'x', ['a'])).toBe('x');
  });
});

describe('pagesByDesign', () => {
  it('is true with rows per page set', () => {
    expect(pagesByDesign(table({ rowsPerPage: 5 }))).toBe(true);
  });

  it('is true with a cycle that turns', () => {
    expect(pagesByDesign(table({ cycle: { dwell: 8 } as TableLayer['cycle'] }))).toBe(true);
  });

  it('is false for a table left on "every row that fits"', () => {
    expect(pagesByDesign(table({}))).toBe(false);
    expect(pagesByDesign(table({ rowsPerPage: 0 }))).toBe(false);
  });

  it('is false for a cycle switched off with a zero dwell', () => {
    expect(pagesByDesign(table({ cycle: { dwell: 0 } as TableLayer['cycle'] }))).toBe(false);
  });
});

describe('pagedTables', () => {
  const standings = table({ id: 'table', name: 'Standings table', binding: 'standings', rowsPerPage: 5 });

  it('lists a paged table with the address, name and cycle flag', () => {
    expect(pagedTables(comp('s', [standings]), () => undefined)).toEqual([
      { table: 'standings', name: 'Standings table', cycle: false },
    ]);
  });

  it('leaves out tables that are not built to page', () => {
    expect(pagedTables(comp('s', [table({ id: 'plain', binding: 'plain' })]), () => undefined)).toEqual([]);
  });

  it('walks groups, and names an unbound table by its path', () => {
    const c = comp('s', [group('grp', [table({ id: 'rot', name: 'City rotation', rowsPerPage: 1, cycle: { dwell: 5 } as TableLayer['cycle'] })])]);
    expect(pagedTables(c, () => undefined)).toEqual([{ table: 'grp/rot', name: 'City rotation', cycle: true }]);
  });

  it('enters a nested composition that plays inline, addressed through its mount', () => {
    const child = comp('child', [standings]);
    const parent = comp('parent', [mount('nest', 'child')]);
    expect(pagedTables(parent, (id) => (id === 'child' ? child : undefined))).toEqual([
      { table: 'nest.standings', name: 'Standings table', cycle: false },
    ]);
  });

  it('does not enter an independent element — its tables belong to its own channel', () => {
    const child = comp('child', [standings]);
    const scene = comp('scene', [mount('el', 'child', { independent: true })]);
    expect(pagedTables(scene, (id) => (id === 'child' ? child : undefined))).toEqual([]);
  });

  it('skips cyclic and unresolved references rather than looping', () => {
    const a = comp('a', [mount('toB', 'b'), mount('gone', 'missing')]);
    const b = comp('b', [mount('toA', 'a'), standings]);
    const lib = new Map([
      ['a', a],
      ['b', b],
    ]);
    expect(pagedTables(a, (id) => lib.get(id))).toEqual([{ table: 'toB.standings', name: 'Standings table', cycle: false }]);
  });
});
