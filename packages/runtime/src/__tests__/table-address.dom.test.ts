// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * The address `/api/channels` hands out for a paged table must be the address
 * the runtime reports and accepts — a Companion button built from the listing
 * aims NEXT at it, and a page feedback matches on it. Both come from
 * `tableAddress` in `@breeze/schema`; this pins that they stay the same
 * through groups and nested compositions, where the two could most easily part.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createComposition,
  createLayer,
  createTableLayer,
  createTextLayer,
  pagedTables,
  type Composition,
  type CompositionLayer,
  type GroupLayer,
  type Layer,
  type TableLayer,
} from '@breeze/schema';

import { BreezeRuntime } from '../runtime.js';

const rows = Array.from({ length: 6 }, (_, i) => ({ team: `Team ${i + 1}` }));

const table = (over: Partial<TableLayer>): TableLayer =>
  createTableLayer({
    size: { width: 400, height: 200 },
    rowsPerPage: 2,
    row: { height: 40, cells: [createTextLayer({ id: 'cell', cell: 'team', size: { width: 400, height: 40 } })] },
    data: { columns: [{ key: 'team', type: 'string' }], rows },
    ...over,
  });

const comp = (id: string, layers: Layer[]): Composition =>
  createComposition({ id, name: id, duration: 2, markers: [{ type: 'stop', time: 1 }], layers });

const child = comp('child', [table({ id: 'inner', binding: 'groups' })]);
const root = comp('root', [
  table({ id: 'top', binding: 'standings' }),
  { ...(createLayer('group') as GroupLayer), id: 'grp', children: [table({ id: 'loose' })] },
  { ...(createLayer('composition') as CompositionLayer), id: 'nest', ref: 'child' },
]);
const library = new Map([['child', child]]);

let runtime: BreezeRuntime | undefined;
afterEach(() => {
  runtime?.destroy();
  runtime = undefined;
  document.body.innerHTML = '';
});

describe('paged-table addresses', () => {
  it('are the same from the channel listing and from the running graphic', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    runtime = new BreezeRuntime({
      container,
      composition: root,
      injectStyles: false,
      resolveComposition: (id) => library.get(id),
    });

    const listed = pagedTables(root, (id) => library.get(id)).map((t) => t.table).sort();
    const reported = runtime.tableStates.map((s) => s.table).sort();

    expect(listed).toEqual(['grp/loose', 'nest.groups', 'standings']);
    expect(reported).toEqual(listed);
    warn.mockRestore();
  });
});
