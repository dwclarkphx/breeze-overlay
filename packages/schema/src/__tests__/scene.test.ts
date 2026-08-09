// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import { createComposition } from '../factory.js';
import { isScene, sceneElements } from '../scene.js';
import type { Layer } from '../types.js';

const element = (id: string, ref: string, extra: Record<string, unknown> = {}): Layer =>
  ({ id, type: 'composition', ref, independent: true, ...extra }) as Layer;

describe('sceneElements', () => {
  it('returns nothing for an ordinary composition', () => {
    const comp = createComposition({
      id: 'lt',
      layers: [{ id: 'bar', type: 'shape', shape: 'rect' } as Layer],
    });
    expect(sceneElements(comp)).toEqual([]);
    expect(isScene(comp)).toBe(false);
  });

  it('ignores flattened composition layers', () => {
    // A nested badge inside a lower third is absorbed into the parent timeline
    // and is emphatically not an element.
    const comp = createComposition({
      id: 'lt',
      layers: [{ id: 'badge', type: 'composition', ref: 'badge' } as Layer],
    });
    expect(sceneElements(comp)).toEqual([]);
  });

  it('defaults the channel to the ref', () => {
    const comp = createComposition({ id: 'scene', layers: [element('e1', 'bug')] });
    expect(sceneElements(comp)).toEqual([
      { layerId: 'e1', name: 'bug', ref: 'bug', channel: 'bug' },
    ]);
  });

  it('honours an explicit channel', () => {
    const comp = createComposition({
      id: 'scene',
      layers: [element('e1', 'badge', { channel: 'badge-home', name: 'Home badge' })],
    });
    expect(sceneElements(comp)[0]).toMatchObject({ channel: 'badge-home', name: 'Home badge' });
  });

  it('keeps paint order — layer order decides what sits on top', () => {
    const comp = createComposition({
      id: 'scene',
      layers: [element('e1', 'bug'), element('e2', 'lower-third')],
    });
    expect(sceneElements(comp).map((e) => e.channel)).toEqual(['bug', 'lower-third']);
  });

  it('finds elements nested inside groups', () => {
    const comp = createComposition({
      id: 'scene',
      layers: [
        { id: 'g', type: 'group', children: [element('e1', 'bug')] } as Layer,
      ],
    });
    expect(sceneElements(comp).map((e) => e.channel)).toEqual(['bug']);
  });

  it('reports a missing ref rather than dropping the element', () => {
    // The channel is occupied whether or not the composition still exists;
    // presenting that is the caller's job.
    const comp = createComposition({ id: 'scene', layers: [element('e1', 'gone')] });
    expect(sceneElements(comp)).toHaveLength(1);
  });
});
