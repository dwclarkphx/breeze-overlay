// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Which tables in a composition page, and what a caller calls them — known from
 * the document alone, before anything plays.
 *
 * Control surfaces need this to offer a button for a table that turns pages
 * (Companion builds its presets from `/api/channels` at connect, long before
 * any output reports in). The live report says which tables page *now*; this
 * says which ones were built to.
 *
 * **One naming rule, shared.** `tableAddress` is what the runtime puts in
 * every live report and what NEXT / PREV / `page` accept as `?table=`. The
 * runtime calls this same function, so the address a channel listing hands
 * out and the address a report shows cannot drift apart.
 */

import type { Composition, Layer, TableLayer } from './types.js';

/** A table built to page, as a control surface addresses it. */
export interface PagedTable {
  /** What NEXT, PREV and `page` take as `?table=`, and what a live report names the table. */
  table: string;
  /** The layer's name — what to put on a button. */
  name: string;
  /** A cycle is set, so HOLD and RESUME mean something for it. */
  cycle: boolean;
}

/** How deep nested compositions expand — the runtime's `DEFAULT_MAX_DEPTH`. */
const MAX_DEPTH = 8;

/**
 * The address a caller aims a table with: the 0.72 field-address shape, so
 * tables and override fields are aimed at the same way.
 *
 * - A table with a binding inside a nested composition: `<mount>.<binding>`,
 *   using the innermost mount it sits in.
 * - A table with a binding at the top level: the binding.
 * - A table with no binding: its instance id (`group/table`, `mount/table`).
 *
 * `instanceId` is the expanded id — layer ids joined by `/` through every group
 * and nested composition above it. `mountIds` are the instance ids of the
 * composition layers in the same expansion.
 */
export function tableAddress(
  instanceId: string,
  binding: string | undefined,
  mountIds: Iterable<string>,
): string {
  if (!binding) return instanceId;
  let mount = '';
  for (const m of mountIds) {
    if (instanceId.startsWith(`${m}/`) && m.length > mount.length) mount = m;
  }
  return mount ? `${mount}.${binding}` : binding;
}

/**
 * Whether the author set a table up to page: rows per page set, or a cycle.
 *
 * A table left on "every row that fits" can still page on a day its feed is
 * longer than the box, but whether it does depends on that day's data, so it
 * is not listed — a button for it would sit blank on most shows.
 */
export function pagesByDesign(layer: TableLayer): boolean {
  const perPage = layer.rowsPerPage;
  if (typeof perPage === 'number' && perPage > 0) return true;
  return hasCycle(layer);
}

/** The runtime's `cycleEnabled`: a dwell above zero. */
function hasCycle(layer: TableLayer): boolean {
  const dwell = layer.cycle?.dwell;
  return typeof dwell === 'number' && Number.isFinite(dwell) && dwell > 0;
}

/**
 * Every table in `comp` built to page, addressed as the runtime will report it.
 *
 * Walks the composition the way the runtime expands it: through groups, and
 * into nested compositions that play inline. An *independent* mount is not
 * entered — it is a graphic of its own on its own channel, and its tables are
 * listed under that channel instead. A cyclic, unresolved or over-deep
 * reference is skipped, as the runtime skips it.
 */
export function pagedTables(
  comp: Composition,
  resolve: (id: string) => Composition | undefined,
): PagedTable[] {
  const tables: Array<{ id: string; layer: TableLayer }> = [];
  // Every composition instance counts as a mount for addressing, independent
  // or not — the runtime's `mountIds` lists them all.
  const mounts: string[] = [];

  const walk = (layers: Layer[], prefix: string, depth: number, chain: readonly string[]): void => {
    for (const layer of layers) {
      const id = `${prefix}${layer.id}`;
      if (layer.type === 'table') {
        if (pagesByDesign(layer)) tables.push({ id, layer });
        continue;
      }
      if (layer.type === 'group') {
        walk(layer.children, `${id}/`, depth + 1, chain);
        continue;
      }
      if (layer.type !== 'composition') continue;
      mounts.push(id);
      if (layer.independent) continue;
      if (chain.includes(layer.ref) || depth + 1 > MAX_DEPTH) continue;
      const child = resolve(layer.ref);
      if (!child) continue;
      walk(child.layers, `${id}/`, depth + 1, [...chain, layer.ref]);
    }
  };

  walk(comp.layers, '', 0, [comp.id]);

  return tables.map(({ id, layer }) => ({
    table: tableAddress(id, layer.binding, mounts),
    name: layer.name ?? layer.binding ?? layer.id,
    cycle: hasCycle(layer),
  }));
}
