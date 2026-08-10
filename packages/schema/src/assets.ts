// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Which assets a layer tree touches.
 *
 * Lived in `apps/editor/src/components/AssetBin.tsx` until Phase 7.5, where it
 * answered "is this file in use by the composition currently open" for the bin's
 * delete confirmation. The server needs the same answer across *every*
 * composition in a project — to make delete honest, to scope a composition
 * export, and to make an expiry warning actionable — and two implementations of
 * "which assets does this layer tree touch" would diverge on the next layer type
 * that grows a `src`. So it moves here, where both sides import it.
 *
 * **One walk, two shapes.** `assetReferences` is the real function and reports
 * where each reference lives; `referencedAssets` is the flat path list the bin
 * has always used, derived from it. Deriving rather than duplicating is the
 * lesson from the editor command traversal: teaching one walk about a new
 * container fixes every caller at once, and teaching two fixes one of them.
 *
 * **Deliberately not transitive.** A `composition` layer referencing another
 * composition does not report that composition's assets. The nested composition
 * is in the same project and reports its own usage, so the operator still sees a
 * name they can act on — and making this transitive would mean passing the whole
 * project in and answering a different question. Transitive resolution is
 * `getDependencies` in the server store, composed on top of this rather than
 * baked into it.
 */

import type { AssetRef, Layer } from './types.js';

/**
 * The fields a person may edit.
 *
 * The complement — id, path, kind, bytes, addedAt, width, height, duration,
 * hasAlpha, codec, origin, supersedes — is derived from the bytes or from where
 * they came from, so a hand-set value there is not a preference somebody
 * expressed, it is a lie about the file that survives until something trusts it.
 * `hasAlpha` is the one that would hurt: an operator could mark a flattened
 * .mov as transparent and discover it over live pictures.
 *
 * Enumerated as a runtime array rather than a TypeScript-only `Pick` because
 * the edit route needs to reject unknown keys at the boundary, and a type
 * cannot do that to a JSON body.
 */
export const EDITABLE_ASSET_FIELDS = [
  'title',
  'description',
  'tags',
  'folder',
  'state',
  'notes',
  'source',
  'usage',
  'expiresAt',
] as const;

export type EditableAssetField = (typeof EDITABLE_ASSET_FIELDS)[number];

/**
 * An edit to an asset's editable fields.
 *
 * `null` clears a field, `undefined` leaves it alone. That distinction is what
 * lets one shape serve both "rename this one" and "tag these forty" — a bulk
 * edit sends only the keys it means, and everything absent is untouched rather
 * than reset.
 */
export type AssetEdit = {
  [K in EditableAssetField]?: AssetRef[K] | null;
};

/**
 * Normalize a tag.
 *
 * Trimmed, lowercased, inner whitespace collapsed to single hyphens. The single
 * highest-leverage governance decision in a DAM is that `Logo`, `logo ` and
 * `station logo` do not become three terms, because a fragmented vocabulary is
 * worse than none: search starts returning confidently incomplete results and
 * nobody can tell.
 *
 * Deliberately lossy and deliberately not rejecting: a tag an operator cannot
 * save before a show is a tag they stop adding.
 */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Normalize, drop empties, de-duplicate, preserving first-seen order. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * Normalize a folder label.
 *
 * A label, not a path — but `/` is kept, because `game-scene/backgrounds` as a
 * convention costs nothing now and can become real nesting later without a
 * migration (ASSETS.md §11). Leading, trailing and doubled separators collapse
 * so `/scene//bg/` and `scene/bg` are the same folder rather than three.
 */
export function normalizeFolder(folder: string): string {
  return folder
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .split('/')
    .map((part) => part.replace(/-+/g, '-').replace(/^-|-$/g, ''))
    .filter(Boolean)
    .join('/');
}

/** How a layer arrived at an asset — which field named it. */
export type AssetReferenceVia = 'src' | 'mask';

export interface AssetReference {
  /** The asset path exactly as written, e.g. `assets/logo-3f2a91bc.png`. */
  src: string;
  /** Layer that names it. For a cell, the cell's own id. */
  layerId: string;
  /** Layer name, when set — what the operator actually recognizes. */
  layerName?: string;
  via: AssetReferenceVia;
}

/**
 * Every asset reference in a layer tree, with its location.
 *
 * Walks the three containers that hold layers — group children, table row
 * cells, and the top level — plus the one reference that no panel displays.
 *
 * The mask case is the reason this function is worth having rather than
 * grepping for `src`: `mask.src` names a file, nothing in the layers panel shows
 * it, and it is the reference an operator deletes out from under a graphic
 * without ever seeing it listed.
 */
export function assetReferences(layers: readonly Layer[]): AssetReference[] {
  const out: AssetReference[] = [];

  const visit = (layer: Layer): void => {
    if ((layer.type === 'image' || layer.type === 'video' || layer.type === 'sprite') && layer.src) {
      out.push({
        src: layer.src,
        layerId: layer.id,
        ...(layer.name ? { layerName: layer.name } : {}),
        via: 'src',
      });
    }

    if (layer.mask?.type === 'image' && layer.mask.src) {
      out.push({
        src: layer.mask.src,
        layerId: layer.id,
        ...(layer.name ? { layerName: layer.name } : {}),
        via: 'mask',
      });
    }

    if (layer.type === 'group') for (const child of layer.children) visit(child);
    if (layer.type === 'table') for (const cell of layer.row.cells) visit(cell);
  };

  for (const layer of layers) visit(layer);
  return out;
}

/**
 * Repoint every reference to one asset path at another.
 *
 * The write half of `assetReferences`, and the thing Replace is actually made
 * of: new bytes are a new content-addressed path (§2 wall 5), so replacing a
 * corrected logo without this leaves every `src` pointing at the old file and
 * the graphic showing the old logo. The ASSETS.md §8 entry is one line —
 * "new bytes, rewrite every referencing `src`, keep `supersedes`" — and this is
 * the middle clause.
 *
 * **Walks with `assetReferences`, deliberately.** Same three containers, same
 * `mask.src` case that no panel displays. Two walks would diverge on the next
 * layer type that grows a `src`, and they would diverge in the worst possible
 * direction: a reference the reader finds and the rewriter misses is a graphic
 * that reports itself up to date and goes to air stale.
 *
 * **Structurally shared.** A layer with nothing to change is returned by
 * identity, not copied, so an untouched subtree stays reference-equal. The
 * editor runs this over the composition it currently has open — including
 * unsaved work — and a wholesale clone would blow every `React.memo` on the
 * stage and reset the layer list's scroll for a logo swap three groups deep.
 */
export function rewriteAssetReferences(
  layers: readonly Layer[],
  from: string,
  to: string,
): { layers: Layer[]; count: number } {
  let count = 0;

  // Guards the caller cannot always make: a no-op rewrite must not deep-copy a
  // document, and `from === to` is the ordinary result of replacing a file with
  // itself — the content hash makes identical bytes the same path.
  if (from === to || from === '') return { layers: [...layers], count: 0 };

  /*
   * Narrowed off `next` rather than off `layer` at every step.
   *
   * `Layer` is a discriminated union, and spreading the union loses the
   * discriminant — `{ ...layer, src: to }` where `layer` is only narrowed in
   * the condition produces an object TypeScript will not accept as any one
   * member. Re-testing `next` narrows the value being copied, so each spread
   * stays inside a single variant and nothing needs a cast to compile.
   */
  const visit = (layer: Layer): Layer => {
    let next: Layer = layer;

    // `next === layer` until something actually changes, then a shallow copy
    // that later branches keep writing into. One copy per touched layer.
    if ((next.type === 'image' || next.type === 'video' || next.type === 'sprite') && next.src === from) {
      next = { ...next, src: to };
      count += 1;
    }

    if (next.mask?.type === 'image' && next.mask.src === from) {
      next = { ...next, mask: { ...next.mask, src: to } };
      count += 1;
    }

    /*
     * The narrowed value is pinned to a `const` before the callback.
     *
     * Narrowing does not survive into a closure over a `let` — TypeScript has
     * to assume the variable was reassigned before the callback ran, which
     * here it genuinely could have been.
     */
    if (next.type === 'group') {
      const group = next;
      const children = group.children.map(visit);
      // Compared element-wise rather than by array identity: `map` always
      // returns a new array, so `children !== group.children` is true even
      // when nothing below changed.
      if (children.some((child, i) => child !== group.children[i])) {
        next = { ...group, children };
      }
    }

    if (next.type === 'table') {
      const table = next;
      const cells = table.row.cells.map(visit);
      if (cells.some((cell, i) => cell !== table.row.cells[i])) {
        next = { ...table, row: { ...table.row, cells } };
      }
    }

    return next;
  };

  return { layers: layers.map(visit), count };
}

/**
 * Every asset path the given layers refer to, cells and group children
 * included.
 *
 * The shape the asset bin has always consumed. Duplicates are preserved — the
 * bin builds a `Set` from it, and a caller counting references wants the
 * repeats.
 *
 * "Is this file still used" is a question with an exact answer, and getting it
 * wrong in either direction is bad: a false negative invites deleting a file
 * that is on air, a false positive makes the bin impossible to tidy.
 */
export function referencedAssets(layers: readonly Layer[]): string[] {
  return assetReferences(layers).map((r) => r.src);
}

/**
 * Where one asset is referenced, in one composition.
 *
 * Computed on the server (it needs every composition in the project, not just
 * the one open) but declared here because the editor renders it — a type that
 * lived in `apps/server` would have to be duplicated to cross that boundary.
 */
export interface AssetUsage {
  compositionId: string;
  compositionName: string;
  references: AssetReference[];
}

/* ------------------------------------------------------------ find things */

export type AssetSort = 'name' | 'added' | 'size' | 'duration';

export interface AssetFilter {
  /** Free text, matched against name, title, description and tags. */
  query?: string;
  kinds?: readonly AssetRef['kind'][];
  folders?: readonly string[];
  tags?: readonly string[];
  states?: readonly NonNullable<AssetRef['state']>[];
  sort?: AssetSort;
  descending?: boolean;
}

/** What the bin displays for an asset, and what free-text search matches first. */
export function assetLabel(asset: AssetRef): string {
  return asset.title ?? asset.originalName ?? asset.path;
}

/* ------------------------------------------------------- name collisions */

/** An incoming filename that matches something already in the bin. */
export interface AssetNameCollision {
  /** The uploaded file's name, exactly as the browser reported it. */
  name: string;
  /** The asset it collides with — what Replace would supersede. */
  existing: AssetRef;
}

/**
 * Which of these filenames already exist in the bin?
 *
 * The question the upload prompt is built on, and it is about *names* — because
 * names are all the caller can know before uploading. Identity is the content
 * hash, and computing it in a browser means reading the whole file into memory
 * first, which for the 400 MB stinger this feature exists to serve is worse
 * than the extra click it would save.
 *
 * So a re-upload of genuinely identical bytes *does* prompt. That is a false
 * positive in the harmless direction: both answers are no-ops on identical
 * content — Replace short-circuits server-side once the hashes match, and
 * "upload as new" is the dedup that has always been there. Sizes are surfaced
 * in the dialog so the operator can usually tell at a glance.
 *
 * **Compared case-insensitively**, for the reason `assetFilename` lowercases in
 * the first place: `Logo.PNG` and `logo.png` are one file on a Windows desk and
 * two inside the Linux container, and a prompt that fires on one machine and
 * not the other is worse than one that never fires.
 *
 * **Retired assets do not collide.** Retiring is what Replace does to the file
 * it supersedes, so counting them would make the second replacement of the same
 * logo offer to replace the copy already thrown away — and offer it above the
 * one actually on air.
 *
 * Newest wins where several match, by `addedAt`, so replacing twice in a
 * session supersedes the current file rather than the original.
 */
export function findNameCollisions(
  assets: readonly AssetRef[],
  names: readonly string[],
): AssetNameCollision[] {
  const byName = new Map<string, AssetRef>();

  for (const asset of assets) {
    if (asset.state === 'retired') continue;
    const key = asset.originalName?.trim().toLowerCase();
    if (!key) continue;

    const held = byName.get(key);
    if (!held) {
      byName.set(key, asset);
      continue;
    }

    // Missing `addedAt` sorts oldest: it means the asset predates Phase 7.5,
    // which is the one thing we know about it.
    const heldAt = held.addedAt ? Date.parse(held.addedAt) : 0;
    const thisAt = asset.addedAt ? Date.parse(asset.addedAt) : 0;
    if (thisAt >= heldAt) byName.set(key, asset);
  }

  const out: AssetNameCollision[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    const key = name.trim().toLowerCase();
    // One entry per name even if the same file is dropped twice in one go —
    // the dialog asks about names, and asking twice about one name is a bug.
    if (seen.has(key)) continue;
    const existing = byName.get(key);
    if (!existing) continue;
    seen.add(key);
    out.push({ name, existing });
  }

  return out;
}

/**
 * Does this asset match a free-text query?
 *
 * Substring rather than fuzzy, across the four fields a person would expect to
 * be searching. Fuzzy matching sounds better and is worse here: an operator
 * typing `bug` twenty seconds before a break wants the two files with "bug" in
 * the name, not a ranked list that also contains `debug-plate` and `bgnd`.
 */
function matchesQuery(asset: AssetRef, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  return (
    assetLabel(asset).toLowerCase().includes(needle) ||
    (asset.originalName?.toLowerCase().includes(needle) ?? false) ||
    (asset.description?.toLowerCase().includes(needle) ?? false) ||
    (asset.folder?.toLowerCase().includes(needle) ?? false) ||
    (asset.tags?.some((t) => t.includes(needle)) ?? false)
  );
}

/**
 * Filter and sort a bin.
 *
 * Facets combine as AND *across* dimensions and OR *within* one — picking two
 * kinds widens, picking a kind and a tag narrows. That is what every faceted
 * search does and what makes the counts beside each facet predictable: an
 * operator who has selected "video" expects the tag counts to describe the
 * videos, not the whole bin.
 *
 * Untagged and unfiled assets are reachable through the sentinel `''`, so
 * "everything nobody has filed yet" is a facet rather than a thing you can only
 * find by scrolling.
 */
export function filterAssets(
  assets: readonly AssetRef[],
  filter: AssetFilter = {},
): AssetRef[] {
  const { query, kinds, folders, tags, states } = filter;

  const out = assets.filter((asset) => {
    if (query && !matchesQuery(asset, query)) return false;
    if (kinds?.length && !kinds.includes(asset.kind)) return false;
    if (folders?.length && !folders.includes(asset.folder ?? '')) return false;
    if (states?.length && !states.includes(asset.state ?? 'draft')) return false;
    if (tags?.length) {
      const own = asset.tags ?? [];
      const wantsUntagged = tags.includes('');
      if (!(wantsUntagged && own.length === 0) && !tags.some((t) => own.includes(t))) {
        return false;
      }
    }
    return true;
  });

  return sortAssets(out, filter.sort ?? 'added', filter.descending ?? true);
}

/**
 * Sort a bin.
 *
 * Every comparison falls back to the label, so the order is total and a re-sort
 * cannot shuffle rows that tie — a list that reorders under the cursor when
 * nothing changed reads as a bug. Assets missing the sort key sink to the
 * bottom regardless of direction, because "no duration" is not "duration zero"
 * and floating fonts to the top of a duration sort would be noise.
 */
export function sortAssets(
  assets: readonly AssetRef[],
  sort: AssetSort,
  descending = false,
): AssetRef[] {
  const byLabel = (a: AssetRef, b: AssetRef): number =>
    assetLabel(a).localeCompare(assetLabel(b), undefined, { numeric: true, sensitivity: 'base' });

  const numeric = (
    a: AssetRef,
    b: AssetRef,
    pick: (x: AssetRef) => number | undefined,
  ): number => {
    const av = pick(a);
    const bv = pick(b);
    if (av === undefined && bv === undefined) return byLabel(a, b);
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    return av === bv ? byLabel(a, b) : (descending ? bv - av : av - bv);
  };

  const sorted = [...assets];

  switch (sort) {
    case 'name':
      return sorted.sort((a, b) => (descending ? -byLabel(a, b) : byLabel(a, b)));
    case 'size':
      return sorted.sort((a, b) => numeric(a, b, (x) => x.bytes));
    case 'duration':
      return sorted.sort((a, b) => numeric(a, b, (x) => x.duration));
    case 'added':
      return sorted.sort((a, b) =>
        numeric(a, b, (x) => (x.addedAt ? Date.parse(x.addedAt) : undefined)),
      );
  }
}

/** One facet value and how many assets carry it. */
export interface AssetFacet {
  value: string;
  count: number;
}

/**
 * Count a facet across a set of assets, including an entry for "none".
 *
 * Counted over the assets *already narrowed by the other facets*, which is what
 * makes a zero-count facet impossible to click into an empty list.
 */
export function facetCounts(
  assets: readonly AssetRef[],
  pick: (asset: AssetRef) => string | string[] | undefined,
): AssetFacet[] {
  const counts = new Map<string, number>();

  for (const asset of assets) {
    const raw = pick(asset);
    const values = raw === undefined ? [''] : Array.isArray(raw) ? raw : [raw];
    // An empty array — no tags at all — is the "none" bucket, not nothing.
    for (const value of values.length === 0 ? [''] : values) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    // "None" last: it is the biggest bucket in a fresh bin and would otherwise
    // push every real folder off the visible row.
    .sort((a, b) => (a.value === '' ? 1 : b.value === '' ? -1 : a.value.localeCompare(b.value)));
}

/** Every folder in use, for the folder facet and the move-to menu. */
export function assetFolders(assets: readonly AssetRef[]): AssetFacet[] {
  return facetCounts(assets, (a) => a.folder);
}

/** Every tag in use. Distinct from the project's vocabulary, which outlives use. */
export function assetTags(assets: readonly AssetRef[]): AssetFacet[] {
  return facetCounts(assets, (a) => a.tags);
}

/**
 * Is this asset past its licensed date?
 *
 * Compared date-only. A sponsor package licensed "through 31 December" is good
 * for all of the 31st, and an asset that expires at midnight UTC would go dark
 * mid-show for anyone west of Greenwich.
 */
export function isExpired(asset: AssetRef, now: Date = new Date()): boolean {
  if (!asset.expiresAt) return false;
  const expiry = Date.parse(asset.expiresAt);
  if (Number.isNaN(expiry)) return false;

  const endOfDay = new Date(expiry);
  endOfDay.setUTCHours(23, 59, 59, 999);
  return now.getTime() > endOfDay.getTime();
}
