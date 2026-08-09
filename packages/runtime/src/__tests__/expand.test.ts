// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { createComposition, createShapeLayer, createTextLayer } from '@breeze/schema';
import type { Composition, Project } from '@breeze/schema';

import { expandComposition } from '../expand.js';
import { buildPlan, derivedDuration } from '../plan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = JSON.parse(
  readFileSync(path.resolve(here, '../../../../examples/lower-third.json'), 'utf8'),
) as Project;

const byId = new Map(project.compositions.map((c) => [c.id, c]));
const resolve = (id: string) => byId.get(id);
const lowerThird = byId.get('l3rd-name') as Composition;

describe('flat compositions', () => {
  it('returns every layer at depth 0 with no offset', () => {
    const comp = createComposition({
      layers: [createShapeLayer({ id: 'a' }), createShapeLayer({ id: 'b' })],
    });
    const { instances, warnings } = expandComposition(comp);

    expect(instances.map((i) => i.id)).toEqual(['a', 'b']);
    expect(instances.every((i) => i.depth === 0 && i.offset === 0)).toBe(true);
    expect(warnings).toEqual([]);
  });
});

describe('groups', () => {
  const comp = createComposition({
    layers: [
      {
        id: 'grp',
        type: 'group',
        children: [createShapeLayer({ id: 'inner' })],
      },
      createShapeLayer({ id: 'after' }),
    ],
  });

  it('namespaces children under the group', () => {
    const { instances } = expandComposition(comp);
    expect(instances.map((i) => i.id)).toEqual(['grp', 'grp/inner', 'after']);
  });

  it('links children to the group as parent', () => {
    const { instances } = expandComposition(comp);
    expect(instances.find((i) => i.id === 'grp/inner')?.parentId).toBe('grp');
  });

  it('does not offset group children in time', () => {
    // A group is a transform container, not a time container.
    const { instances } = expandComposition(comp);
    expect(instances.find((i) => i.id === 'grp/inner')?.offset).toBe(0);
  });
});

describe('nested compositions', () => {
  it('inlines the referenced composition layers', () => {
    const { instances } = expandComposition(lowerThird, { resolve });
    const ids = instances.map((i) => i.id);

    expect(ids).toContain('badge');
    expect(ids).toContain('badge/chip');
    expect(ids).toContain('badge/label');
  });

  it('offsets nested layers by the composition layer in-point', () => {
    const { instances } = expandComposition(lowerThird, { resolve });
    // The badge layer declares "in": 0.3.
    expect(instances.find((i) => i.id === 'badge/chip')?.offset).toBe(0.3);
    expect(instances.find((i) => i.id === 'badge')?.offset).toBe(0);
  });

  it('shifts nested keyframes onto the parent timeline', () => {
    const plan = buildPlan(lowerThird, { resolve });
    const chipTween = plan.tweens.find((t) => t.layerId === 'badge/chip' && t.prop === 'scaleX');

    // Authored at t=0 inside the badge, so it starts at the 0.3s in-point.
    expect(chipTween?.start).toBeCloseTo(0.3, 5);
    expect(chipTween?.duration).toBeCloseTo(0.35, 5);
  });

  it('marks nested binding names as pinned when overridden', () => {
    const { instances } = expandComposition(lowerThird, { resolve });
    const label = instances.find((i) => i.id === 'badge/label')!;

    expect(label.pinnedBindings.has('badgeText')).toBe(true);
    expect(label.overrides['badgeText']).toBe('LIVE');
  });

  it('leaves un-overridden bindings unpinned so parent updates reach them', () => {
    const { instances } = expandComposition(lowerThird, { resolve });
    expect(instances.find((i) => i.id === 'name')!.pinnedBindings.size).toBe(0);
  });

  it('instantiates the same composition twice independently', () => {
    const comp = createComposition({
      id: 'root',
      layers: [
        { id: 'home', type: 'composition', ref: 'badge', overrides: { badgeText: 'HOME' } },
        { id: 'away', type: 'composition', ref: 'badge', overrides: { badgeText: 'AWAY' } },
      ],
    });
    const { instances } = expandComposition(comp, { resolve });

    expect(instances.find((i) => i.id === 'home/label')!.overrides['badgeText']).toBe('HOME');
    expect(instances.find((i) => i.id === 'away/label')!.overrides['badgeText']).toBe('AWAY');
  });

  it('extends the derived duration to cover nested content', () => {
    const inner = createComposition({
      id: 'inner',
      layers: [createShapeLayer({ keyframes: { x: [{ t: 0, v: 0 }, { t: 2, v: 100 }] } })],
    });
    const outer = createComposition({
      id: 'outer',
      layers: [{ id: 'nest', type: 'composition', ref: 'inner', in: 3 }],
    });

    const { instances } = expandComposition(outer, { resolve: (id) => (id === 'inner' ? inner : undefined) });
    // 3s start + 2s of nested animation.
    expect(derivedDuration(instances)).toBeCloseTo(5, 5);
  });
});

describe('recursion guards', () => {
  it('refuses a self-reference instead of hanging', () => {
    const comp: Composition = createComposition({
      id: 'loop',
      layers: [{ id: 'nest', type: 'composition', ref: 'loop' }],
    });
    const { instances, warnings } = expandComposition(comp, { resolve: () => comp });

    expect(instances.map((i) => i.id)).toEqual(['nest']);
    expect(warnings[0]!.message).toMatch(/cyclic/);
  });

  it('breaks a two-composition cycle', () => {
    const a = createComposition({ id: 'a', layers: [{ id: 'toB', type: 'composition', ref: 'b' }] });
    const b = createComposition({ id: 'b', layers: [{ id: 'toA', type: 'composition', ref: 'a' }] });
    const table = new Map([['a', a], ['b', b]]);

    const { instances, warnings } = expandComposition(a, { resolve: (id) => table.get(id) });

    expect(instances.map((i) => i.id)).toEqual(['toB', 'toB/toA']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/cyclic/);
  });

  it('stops at maxDepth for deeply chained compositions', () => {
    // Self-similar but never repeating an id, so the cycle guard cannot catch it.
    const make = (n: number): Composition =>
      createComposition({
        id: `c${n}`,
        layers: n > 0 ? [{ id: `n${n}`, type: 'composition', ref: `c${n - 1}` }] : [],
      });
    const table = new Map(Array.from({ length: 30 }, (_, i) => [`c${i}`, make(i)]));

    const { warnings } = expandComposition(table.get('c29')!, {
      resolve: (id) => table.get(id),
      maxDepth: 4,
    });

    expect(warnings.some((w) => /deeper than 4/.test(w.message))).toBe(true);
  });

  it('warns rather than throwing when a ref cannot be resolved', () => {
    const comp = createComposition({
      layers: [{ id: 'nest', type: 'composition', ref: 'missing' }],
    });
    const { instances, warnings } = expandComposition(comp, { resolve: () => undefined });

    expect(instances).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/unresolved/);
  });

  it('warns when no resolver is supplied at all', () => {
    const comp = createComposition({
      layers: [{ id: 'nest', type: 'composition', ref: 'badge' }],
    });
    expect(expandComposition(comp).warnings[0]!.message).toMatch(/unresolved/);
  });
});

describe('plan integration', () => {
  it('keeps only the root composition markers as holds', () => {
    const inner = createComposition({
      id: 'inner',
      layers: [createTextLayer({ id: 'txt' })],
      markers: [{ type: 'stop', time: 0.2 }],
    });
    const outer = createComposition({
      id: 'outer',
      layers: [
        createShapeLayer({ id: 'bg', keyframes: { x: [{ t: 0, v: 0 }, { t: 1, v: 10 }] } }),
        { id: 'nest', type: 'composition', ref: 'inner' },
      ],
      markers: [{ type: 'stop', time: 0.5 }],
    });

    const plan = buildPlan(outer, { resolve: (id) => (id === 'inner' ? inner : undefined) });
    // A nested comp's markers are ignored, as in an After Effects precomp.
    expect(plan.holds).toEqual([0.5]);
  });

  it('surfaces expansion warnings on the plan', () => {
    const comp = createComposition({
      layers: [{ id: 'nest', type: 'composition', ref: 'nope' }],
    });
    expect(buildPlan(comp).warnings).toHaveLength(1);
  });
});

describe('independent composition layers', () => {
  const inner = createComposition({
    id: 'bug',
    layers: [createShapeLayer({ id: 'plate' }), createTextLayer({ id: 'temp' })],
  });
  const resolveInner = (id: string) => (id === 'bug' ? inner : undefined);

  it('is not expanded into the parent', () => {
    // The whole point: an independent element has its own timeline, so its
    // layers must not appear in this one.
    const scene = createComposition({
      id: 'scene',
      layers: [{ id: 'e1', type: 'composition', ref: 'bug', independent: true }],
    });

    const { instances } = expandComposition(scene, { resolve: resolveInner });
    expect(instances.map((i) => i.id)).toEqual(['e1']);
  });

  it('keeps the wrapper instance, so the scene can still place it', () => {
    const scene = createComposition({
      id: 'scene',
      layers: [{ id: 'e1', type: 'composition', ref: 'bug', independent: true, transform: { x: 40 } }],
    });

    const { instances } = expandComposition(scene, { resolve: resolveInner });
    expect(instances).toHaveLength(1);
    expect(instances[0]?.layer.transform).toEqual({ x: 40 });
  });

  it('does not warn about an unresolved ref it never tried to resolve', () => {
    // An element's composition is mounted by the player, not inlined here, so
    // expansion has no opinion about whether the ref resolves.
    const scene = createComposition({
      id: 'scene',
      layers: [{ id: 'e1', type: 'composition', ref: 'missing', independent: true }],
    });
    expect(expandComposition(scene).warnings).toEqual([]);
  });

  it('still flattens a sibling that is not independent', () => {
    const scene = createComposition({
      id: 'scene',
      layers: [
        { id: 'e1', type: 'composition', ref: 'bug', independent: true },
        { id: 'n1', type: 'composition', ref: 'bug' },
      ],
    });

    const ids = expandComposition(scene, { resolve: resolveInner }).instances.map((i) => i.id);
    expect(ids).toEqual(['e1', 'n1', 'n1/plate', 'n1/temp']);
  });
});
