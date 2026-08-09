// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Which assets a composition actually uses.
 *
 * Moved here from `apps/editor/src/__tests__/asset-bin.test.ts` in Phase 7.5
 * along with the function itself: the server now asks the same question across
 * every composition in a project, and one walk needs one test suite.
 *
 * The answer is load-bearing in both directions — a false negative invites
 * deleting a file that is on air, a false positive makes the bin impossible to
 * tidy.
 */

import { describe, expect, it } from 'vitest';

import {
  assetFolders,
  assetLabel,
  assetReferences,
  assetTags,
  facetCounts,
  filterAssets,
  findNameCollisions,
  isExpired,
  normalizeFolder,
  normalizeTag,
  normalizeTags,
  referencedAssets,
  rewriteAssetReferences,
  sortAssets,
} from '../assets.js';
import { createShapeLayer, createTableLayer, createTextLayer } from '../factory.js';
import type { AssetRef, Layer } from '../types.js';

const image = (src: string): Layer => ({ id: `i-${src}`, type: 'image', src });
const video = (src: string): Layer => ({ id: `v-${src}`, type: 'video', src });

describe('referencedAssets', () => {
  it('finds image and video sources', () => {
    expect(referencedAssets([image('assets/logo.png'), video('assets/stinger.webm')])).toEqual([
      'assets/logo.png',
      'assets/stinger.webm',
    ]);
  });

  it('ignores layers that have no source', () => {
    expect(referencedAssets([createShapeLayer({ id: 's' }), createTextLayer({ id: 't' })])).toEqual([]);
  });

  it('descends into groups', () => {
    const group: Layer = {
      id: 'g',
      type: 'group',
      children: [image('assets/nested.png')],
    };
    expect(referencedAssets([group])).toEqual(['assets/nested.png']);
  });

  it('descends into a table row template', () => {
    // A badge inside a standings row is the common case, and it is invisible
    // from the top level — cells are the one place an asset hides.
    const table = createTableLayer({
      id: 'tbl',
      row: { height: 40, cells: [image('assets/badge.png')] },
    });
    expect(referencedAssets([table])).toEqual(['assets/badge.png']);
  });

  it('counts an image mask, which nothing in the layers panel shows', () => {
    const masked: Layer = {
      ...createShapeLayer({ id: 'm' }),
      mask: { type: 'image', x: 0, y: 0, width: 10, height: 10, src: 'assets/wipe.png' },
    };
    expect(referencedAssets([masked])).toEqual(['assets/wipe.png']);
  });

  it('skips an empty src rather than reporting it as a reference', () => {
    // A freshly added video layer has `src: ''`. Reporting that would mark
    // every asset in the bin as in use the moment one is created.
    expect(referencedAssets([video('')])).toEqual([]);
  });

  it('ignores a non-image mask that carries a stale src', () => {
    // Switching a mask from image to rect leaves `src` behind in the JSON.
    // Counting it would pin an asset that nothing renders.
    const masked: Layer = {
      ...createShapeLayer({ id: 'm' }),
      mask: { type: 'rect', x: 0, y: 0, width: 10, height: 10, src: 'assets/wipe.png' },
    };
    expect(referencedAssets([masked])).toEqual([]);
  });

  it('keeps duplicates, so a caller can count references', () => {
    expect(referencedAssets([image('assets/logo.png'), video('assets/logo.png')])).toHaveLength(2);
  });
});

/*
 * The write half. Every case `referencedAssets` finds, this has to repoint —
 * a reference the reader sees and the rewriter misses is the worst outcome
 * available, because the replace reports success and the graphic goes to air
 * on the old file.
 */
describe('rewriteAssetReferences', () => {
  const OLD = 'assets/logo-aaaaaaaa.png';
  const NEW = 'assets/logo-bbbbbbbb.png';

  it('repoints a top-level image and counts it', () => {
    const result = rewriteAssetReferences([image(OLD)], OLD, NEW);
    expect(result.count).toBe(1);
    expect(referencedAssets(result.layers)).toEqual([NEW]);
  });

  it('leaves references to other assets alone', () => {
    const result = rewriteAssetReferences([image('assets/other.png')], OLD, NEW);
    expect(result.count).toBe(0);
    expect(referencedAssets(result.layers)).toEqual(['assets/other.png']);
  });

  it('descends into groups', () => {
    const group: Layer = { id: 'g', type: 'group', children: [image(OLD)] };
    const result = rewriteAssetReferences([group], OLD, NEW);
    expect(result.count).toBe(1);
    expect(referencedAssets(result.layers)).toEqual([NEW]);
  });

  it('descends into a table row template', () => {
    const table = createTableLayer({ id: 'tbl', row: { height: 40, cells: [image(OLD)] } });
    const result = rewriteAssetReferences([table], OLD, NEW);
    expect(result.count).toBe(1);
    expect(referencedAssets(result.layers)).toEqual([NEW]);
  });

  it('repoints an image mask, which nothing in the layers panel shows', () => {
    // The reference an operator replaces without ever having seen it listed.
    const masked: Layer = {
      ...createShapeLayer({ id: 'm' }),
      mask: { type: 'image', x: 0, y: 0, width: 10, height: 10, src: OLD },
    };
    const result = rewriteAssetReferences([masked], OLD, NEW);
    expect(result.count).toBe(1);
    expect(referencedAssets(result.layers)).toEqual([NEW]);
  });

  it('does not touch a non-image mask carrying a stale src', () => {
    // `referencedAssets` ignores it, so rewriting it would make the two walks
    // disagree about what a reference is.
    const masked: Layer = {
      ...createShapeLayer({ id: 'm' }),
      mask: { type: 'rect', x: 0, y: 0, width: 10, height: 10, src: OLD },
    };
    const result = rewriteAssetReferences([masked], OLD, NEW);
    expect(result.count).toBe(0);
    expect(result.layers[0]?.mask?.src).toBe(OLD);
  });

  it('counts a layer that references the same asset as both src and mask twice', () => {
    const both: Layer = {
      ...image(OLD),
      mask: { type: 'image', x: 0, y: 0, width: 10, height: 10, src: OLD },
    };
    const result = rewriteAssetReferences([both], OLD, NEW);
    expect(result.count).toBe(2);
    expect(referencedAssets(result.layers)).toEqual([NEW, NEW]);
  });

  it('is a no-op when the paths match, rather than counting every reference', () => {
    // Replacing a file with itself is the ordinary result of picking the file
    // already in the bin: identical bytes hash to the same path.
    const result = rewriteAssetReferences([image(OLD)], OLD, OLD);
    expect(result.count).toBe(0);
  });

  it('ignores an empty from-path', () => {
    // A freshly added video layer has `src: ''`. Rewriting on that would
    // repoint every unset layer in the project at one asset.
    const result = rewriteAssetReferences([video(''), image(OLD)], '', NEW);
    expect(result.count).toBe(0);
  });

  it('does not mutate the layers it was given', () => {
    const original = image(OLD);
    rewriteAssetReferences([original], OLD, NEW);
    expect(original.src).toBe(OLD);
  });

  it('returns untouched subtrees by identity', () => {
    /*
     * Structural sharing, asserted rather than assumed. The editor runs this
     * over the composition currently on screen, so a wholesale clone would
     * blow every memoised layer on the stage for a swap three groups deep.
     */
    const untouched: Layer = { id: 'g', type: 'group', children: [image('assets/other.png')] };
    const touched: Layer = { id: 'g2', type: 'group', children: [image(OLD)] };
    const result = rewriteAssetReferences([untouched, touched], OLD, NEW);

    expect(result.layers[0]).toBe(untouched);
    expect(result.layers[1]).not.toBe(touched);
  });
});

describe('findNameCollisions', () => {
  const asset = (over: Partial<AssetRef>): AssetRef => ({
    id: 'a1',
    path: 'assets/logo-aaaaaaaa.png',
    kind: 'image',
    originalName: 'logo.png',
    addedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  });

  it('matches an incoming filename against an existing originalName', () => {
    const found = findNameCollisions([asset({})], ['logo.png']);
    expect(found).toHaveLength(1);
    expect(found[0]?.existing.id).toBe('a1');
  });

  it('reports nothing for a name that is not in the bin', () => {
    expect(findNameCollisions([asset({})], ['other.png'])).toEqual([]);
  });

  it('matches case-insensitively', () => {
    // `Logo.PNG` and `logo.png` are one file on a Windows desk and two inside
    // the Linux container. A prompt that fires on one and not the other is
    // worse than one that never fires.
    expect(findNameCollisions([asset({})], ['LOGO.PNG'])).toHaveLength(1);
  });

  it('ignores retired assets', () => {
    // Retiring is what Replace does to the file it supersedes. Counting them
    // would offer to replace the copy already thrown away.
    expect(findNameCollisions([asset({ state: 'retired' })], ['logo.png'])).toEqual([]);
  });

  it('picks the newest match when several share a name', () => {
    const older = asset({ id: 'old', addedAt: '2026-08-01T00:00:00.000Z' });
    const newer = asset({ id: 'new', addedAt: '2026-08-05T00:00:00.000Z' });
    expect(findNameCollisions([older, newer], ['logo.png'])[0]?.existing.id).toBe('new');
    // Order in the bin must not decide it.
    expect(findNameCollisions([newer, older], ['logo.png'])[0]?.existing.id).toBe('new');
  });

  it('treats an asset with no addedAt as the oldest', () => {
    const undated = asset({ id: 'undated', addedAt: undefined });
    const dated = asset({ id: 'dated' });
    expect(findNameCollisions([undated, dated], ['logo.png'])[0]?.existing.id).toBe('dated');
  });

  it('reports one entry per name even when a file is dropped twice', () => {
    // The dialog asks about names; asking twice about one name is a bug.
    expect(findNameCollisions([asset({})], ['logo.png', 'logo.png'])).toHaveLength(1);
  });

  it('skips assets with no originalName rather than matching them on empty', () => {
    const nameless = asset({ id: 'n', originalName: undefined });
    expect(findNameCollisions([nameless], [''])).toEqual([]);
  });

  it('preserves the incoming name exactly, for display', () => {
    // The dialog shows what the operator dropped, not the normalized key.
    expect(findNameCollisions([asset({})], ['LOGO.PNG'])[0]?.name).toBe('LOGO.PNG');
  });
});

describe('assetReferences', () => {
  it('reports the layer that names each asset', () => {
    const layers: Layer[] = [{ id: 'bug', name: 'Corner bug', type: 'image', src: 'assets/logo.png' }];
    expect(assetReferences(layers)).toEqual([
      { src: 'assets/logo.png', layerId: 'bug', layerName: 'Corner bug', via: 'src' },
    ]);
  });

  it('omits layerName rather than emitting undefined for an unnamed layer', () => {
    // The result is serialized into an API response; an explicit `undefined`
    // would survive as a key in some shapes and not others.
    expect(assetReferences([image('assets/logo.png')])[0]).not.toHaveProperty('layerName');
  });

  it('distinguishes a mask reference from a src reference', () => {
    const masked: Layer = {
      ...createShapeLayer({ id: 'm' }),
      mask: { type: 'image', x: 0, y: 0, width: 10, height: 10, src: 'assets/wipe.png' },
    };
    // `createShapeLayer` names the layer "Shape", so the name comes through.
    expect(assetReferences([masked])).toEqual([
      { src: 'assets/wipe.png', layerId: 'm', layerName: 'Shape', via: 'mask' },
    ]);
  });

  it('reports a cell by its own id, not the table it sits in', () => {
    // The operator needs to reach the thing that names the file. A table id
    // sends them to a layer whose properties panel never mentions the asset.
    const table = createTableLayer({
      id: 'tbl',
      row: { height: 40, cells: [{ id: 'cell-badge', type: 'image', src: 'assets/badge.png' }] },
    });
    expect(assetReferences([table])).toEqual([
      { src: 'assets/badge.png', layerId: 'cell-badge', via: 'src' },
    ]);
  });

  it('reports both references when one layer carries a src and a mask', () => {
    const both: Layer = {
      id: 'plate',
      type: 'image',
      src: 'assets/plate.png',
      mask: { type: 'image', x: 0, y: 0, width: 10, height: 10, src: 'assets/wipe.png' },
    };
    expect(assetReferences([both]).map((r) => r.via)).toEqual(['src', 'mask']);
  });

  it('does not follow a composition layer into the composition it references', () => {
    // Deliberately shallow: the nested composition lives in the same project
    // and reports its own usage, so the operator still gets a name to act on.
    const nested: Layer = { id: 'c', type: 'composition', ref: 'other-comp' };
    expect(assetReferences([nested])).toEqual([]);
  });
});

/* ------------------------------------------------------------ vocabulary */

describe('normalizeTag', () => {
  it('folds the four ways one term fragments', () => {
    // The single highest-leverage governance decision in a DAM: `Logo`,
    // `logo `, `LOGO` and `station logo` must not become four terms, because a
    // fragmented vocabulary returns confidently incomplete search results.
    expect(normalizeTag('Logo')).toBe('logo');
    expect(normalizeTag('  logo  ')).toBe('logo');
    expect(normalizeTag('LOGO')).toBe('logo');
    expect(normalizeTag('station logo')).toBe('station-logo');
  });

  it('collapses runs of separators rather than emitting them', () => {
    expect(normalizeTag('station   logo')).toBe('station-logo');
    expect(normalizeTag('--lower--third--')).toBe('lower-third');
  });

  it('reduces a tag of nothing but punctuation to empty, not to a hyphen', () => {
    // Callers drop empties. A bare `-` would become a real, unremovable tag.
    expect(normalizeTag('---')).toBe('');
    expect(normalizeTag('   ')).toBe('');
  });
});

describe('normalizeTags', () => {
  it('de-duplicates after normalizing, not before', () => {
    expect(normalizeTags(['Logo', 'logo', ' LOGO '])).toEqual(['logo']);
  });

  it('preserves first-seen order and drops empties', () => {
    expect(normalizeTags(['sponsor', '', 'Bug', '  '])).toEqual(['sponsor', 'bug']);
  });
});

describe('normalizeFolder', () => {
  it('keeps the separator, so a nesting convention survives', () => {
    // ASSETS.md §11: flat now, `game-scene/backgrounds` as a convention that
    // can become real nesting later without a migration.
    expect(normalizeFolder('Game Scene/Backgrounds')).toBe('game-scene/backgrounds');
  });

  it('treats leading, trailing and doubled separators as the same folder', () => {
    expect(normalizeFolder('/scene//bg/')).toBe('scene/bg');
    expect(normalizeFolder('scene/bg')).toBe('scene/bg');
  });

  it('reduces an empty label to empty, which means unfiled', () => {
    expect(normalizeFolder('  /  ')).toBe('');
  });
});

/* ---------------------------------------------------------- find things */

const asset = (init: Partial<AssetRef> & { id: string }): AssetRef => ({
  path: `assets/${init.id}.png`,
  kind: 'image',
  ...init,
});

const bin: AssetRef[] = [
  asset({ id: 'a', originalName: 'Sponsor Bug.png', tags: ['sponsor', 'bug'], folder: 'sponsors', bytes: 300, addedAt: '2026-08-01T00:00:00Z' }),
  asset({ id: 'b', originalName: 'stinger.webm', kind: 'video', tags: ['transition'], bytes: 900_000, duration: 2.5, addedAt: '2026-08-03T00:00:00Z', state: 'approved' }),
  asset({ id: 'c', originalName: 'lower-third-plate.png', description: 'blue gradient', folder: 'sponsors', bytes: 12_000, addedAt: '2026-08-02T00:00:00Z' }),
  asset({ id: 'd', originalName: 'Inter.woff2', kind: 'font', bytes: 40_000 }),
];

const ids = (assets: readonly AssetRef[]): string[] => assets.map((a) => a.id);

describe('assetLabel', () => {
  it('prefers a title, falls back to the filename, then the path', () => {
    expect(assetLabel(asset({ id: 'x', title: 'Bug', originalName: 'b.png' }))).toBe('Bug');
    expect(assetLabel(asset({ id: 'x', originalName: 'b.png' }))).toBe('b.png');
    expect(assetLabel(asset({ id: 'x' }))).toBe('assets/x.png');
  });
});

describe('filterAssets', () => {
  it('matches a query case-insensitively across name, description and tags', () => {
    expect(ids(filterAssets(bin, { query: 'sponsor' }))).toContain('a');
    expect(ids(filterAssets(bin, { query: 'GRADIENT' }))).toEqual(['c']);
    expect(ids(filterAssets(bin, { query: 'transition' }))).toEqual(['b']);
  });

  it('ORs within one facet and ANDs across facets', () => {
    // The property that makes facet counts predictable: picking two kinds
    // widens, picking a kind and a folder narrows.
    expect(ids(filterAssets(bin, { kinds: ['video', 'font'] })).sort()).toEqual(['b', 'd']);
    expect(ids(filterAssets(bin, { kinds: ['image'], folders: ['sponsors'] })).sort()).toEqual(['a', 'c']);
  });

  it('reaches unfiled and untagged assets through the empty sentinel', () => {
    // Otherwise "everything nobody has filed yet" is only findable by scrolling.
    expect(ids(filterAssets(bin, { folders: [''] })).sort()).toEqual(['b', 'd']);
    expect(ids(filterAssets(bin, { tags: [''] })).sort()).toEqual(['c', 'd']);
  });

  it('treats a missing state as draft, so the facet is not a lie', () => {
    expect(ids(filterAssets(bin, { states: ['approved'] }))).toEqual(['b']);
    expect(ids(filterAssets(bin, { states: ['draft'] })).sort()).toEqual(['a', 'c', 'd']);
  });

  it('ignores an empty facet array rather than matching nothing', () => {
    expect(filterAssets(bin, { kinds: [], tags: [] })).toHaveLength(bin.length);
  });
});

describe('sortAssets', () => {
  it('sinks assets missing the key to the bottom in both directions', () => {
    // "No duration" is not "duration zero", and floating fonts to the top of a
    // duration sort would be noise at the moment someone is looking for a clip.
    expect(sortAssets(bin, 'duration', false).at(-1)?.duration).toBeUndefined();
    expect(sortAssets(bin, 'duration', true).at(-1)?.duration).toBeUndefined();
  });

  it('breaks ties by label, so a re-sort cannot shuffle equal rows', () => {
    const tied = [
      asset({ id: 'z', originalName: 'zebra.png', bytes: 10 }),
      asset({ id: 'm', originalName: 'middle.png', bytes: 10 }),
      asset({ id: 'a', originalName: 'apple.png', bytes: 10 }),
    ];
    expect(ids(sortAssets(tied, 'size'))).toEqual(['a', 'm', 'z']);
    expect(ids(sortAssets(sortAssets(tied, 'size'), 'size'))).toEqual(['a', 'm', 'z']);
  });

  it('sorts by name naturally, so plate-10 follows plate-9', () => {
    const numbered = [
      asset({ id: '10', originalName: 'plate-10.png' }),
      asset({ id: '9', originalName: 'plate-9.png' }),
    ];
    expect(ids(sortAssets(numbered, 'name'))).toEqual(['9', '10']);
  });

  it('defaults to newest first', () => {
    expect(ids(filterAssets(bin))[0]).toBe('b');
  });

  it('does not mutate the input', () => {
    const before = ids(bin);
    sortAssets(bin, 'name');
    expect(ids(bin)).toEqual(before);
  });
});

describe('facets', () => {
  it('counts folders with an entry for unfiled, sorted last', () => {
    expect(assetFolders(bin)).toEqual([
      { value: 'sponsors', count: 2 },
      { value: '', count: 2 },
    ]);
  });

  it('counts an asset once per tag it carries', () => {
    expect(assetTags(bin)).toEqual([
      { value: 'bug', count: 1 },
      { value: 'sponsor', count: 1 },
      { value: 'transition', count: 1 },
      { value: '', count: 2 },
    ]);
  });

  it('treats an empty tag array as untagged rather than as nothing', () => {
    // `tags: []` and no `tags` key at all must land in the same bucket, or the
    // counts stop adding up to the number of assets.
    expect(facetCounts([asset({ id: 'x', tags: [] })], (a) => a.tags)).toEqual([
      { value: '', count: 1 },
    ]);
  });
});

describe('isExpired', () => {
  const licensed = asset({ id: 'x', expiresAt: '2026-12-31' });

  it('is good for the whole of the last licensed day', () => {
    // A package licensed "through 31 December" that goes dark at midnight UTC
    // takes a graphic off air mid-show for everyone west of Greenwich.
    expect(isExpired(licensed, new Date('2026-12-31T23:00:00Z'))).toBe(false);
    expect(isExpired(licensed, new Date('2027-01-01T00:30:00Z'))).toBe(true);
  });

  it('is never expired without a date, and never on an unparseable one', () => {
    expect(isExpired(asset({ id: 'x' }))).toBe(false);
    expect(isExpired(asset({ id: 'x', expiresAt: 'whenever' }))).toBe(false);
  });
});
