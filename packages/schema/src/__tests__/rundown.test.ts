// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/** Rundowns and outputs (Phase 9 Wave A). */

import { describe, expect, it } from 'vitest';

import { LEGACY_KEY_PATTERN } from '../keys.js';
import {
  adjacentItem,
  channelKind,
  channelTakesData,
  itemTarget,
  itemTitle,
  orderMounts,
  outputChannel,
  outputMountChannel,
  rundownChannel,
  validateRundowns,
  type Rundown,
} from '../rundown.js';

const rundown: Rundown = {
  id: 'sunday',
  name: 'Sunday',
  items: [
    { id: 'a', composition: 'lt', data: { name: 'Jane Doe' } },
    { id: 'b', composition: 'lt', label: 'Pastor', data: { name: 'John' } },
    { id: 'c', composition: 'slate', output: 'main' },
  ],
};

describe('channels', () => {
  it('cannot collide with a composition id', () => {
    for (const name of ['@main', '@main~lt', '#rundowns']) expect(LEGACY_KEY_PATTERN.test(name)).toBe(false);
  });

  it('builds and classifies every kind', () => {
    expect(outputChannel('p', 'main')).toBe('p/@main');
    expect(outputMountChannel('p', 'main', 'lt')).toBe('p/@main~lt');
    expect(rundownChannel('p')).toBe('p/#rundowns');
    expect(channelKind('p/lt')).toBe('graphic');
    expect(channelKind('p/@main')).toBe('output');
    expect(channelKind('p/@main~lt')).toBe('mount');
    expect(channelKind('p/#rundowns')).toBe('rundown');
  });

  it('sends data pushes only to channels that render', () => {
    expect(channelTakesData('p/lt')).toBe(true);
    expect(channelTakesData('p/@main~lt')).toBe(true);
    expect(channelTakesData('p/@main')).toBe(false);
    expect(channelTakesData('p/#rundowns')).toBe(false);
  });

  it('targets an output, or the graphic itself', () => {
    expect(itemTarget(rundown.items[0]!)).toBe('lt');
    expect(itemTarget(rundown.items[2]!)).toBe('@main');
  });
});

describe('navigation', () => {
  it('starts at the ends with nothing armed', () => {
    expect(adjacentItem(rundown, null, 1)?.id).toBe('a');
    expect(adjacentItem(rundown, null, -1)?.id).toBe('c');
  });

  it('steps and stops at the ends rather than wrapping', () => {
    expect(adjacentItem(rundown, 'a', 1)?.id).toBe('b');
    expect(adjacentItem(rundown, 'b', -1)?.id).toBe('a');
    expect(adjacentItem(rundown, 'c', 1)).toBeNull();
    expect(adjacentItem(rundown, 'a', -1)).toBeNull();
  });

  it('treats an item that has been deleted as nothing armed', () => {
    expect(adjacentItem(rundown, 'gone', 1)?.id).toBe('a');
  });

  it('titles a row by label, then first field, then composition', () => {
    expect(itemTitle(rundown.items[1]!)).toBe('Pastor');
    expect(itemTitle(rundown.items[0]!)).toBe('Jane Doe');
    expect(itemTitle(rundown.items[2]!, 'Slate')).toBe('Slate');
  });
});

describe('validateRundowns', () => {
  const doc = { formatVersion: 1, rundowns: [rundown] };

  it('accepts a good document', () => {
    expect(validateRundowns(doc, new Set(['lt', 'slate']))).toEqual([]);
  });

  it('names an item whose composition is gone', () => {
    const issues = validateRundowns(doc, new Set(['lt']));
    expect(issues).toEqual([{ path: '/rundowns/0/items/2/composition', message: 'no composition "slate" in this project' }]);
  });

  it('refuses duplicate ids, bad outputs and unknown keys', () => {
    const bad = {
      formatVersion: 1,
      rundowns: [
        {
          id: 'r',
          name: 'R',
          items: [
            { id: 'x', composition: 'lt', output: 'Main Out' },
            { id: 'x', composition: 'lt', colour: 'red' },
          ],
        },
      ],
    };
    const paths = validateRundowns(bad).map((i) => i.path);
    expect(paths).toContain('/rundowns/0/items/0/output');
    expect(paths).toContain('/rundowns/0/items/1/id');
    expect(paths).toContain('/rundowns/0/items/1/colour');
  });

  it('refuses something that is not a rundowns document', () => {
    expect(validateRundowns([])[0]?.path).toBe('');
    expect(validateRundowns({ formatVersion: 1 }).map((i) => i.path)).toContain('/rundowns');
  });
});

describe('orderMounts', () => {
  it('stacks by layer, then by when each was first mounted', () => {
    const out = orderMounts([
      { composition: 'bug', layer: 10, since: 1 },
      { composition: 'lt', layer: 0, since: 3 },
      { composition: 'slate', layer: 0, since: 2 },
    ]);
    expect(out.map((m) => m.composition)).toEqual(['slate', 'lt', 'bug']);
  });
});
