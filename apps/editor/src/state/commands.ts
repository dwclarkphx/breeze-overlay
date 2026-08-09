// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Editor commands.
 *
 * ROADMAP §4 Phase 2: "every mutation is a serializable command". Two reasons
 * that matters beyond undo — a command log can later drive scripted template
 * generation and collaborative editing, and it makes the whole mutation layer
 * testable in Node with no React and no DOM.
 *
 * Commands are plain data. `applyCommand` is a pure function from
 * (composition, command) to a new composition; it never mutates its input, so
 * history can hold previous documents by reference.
 */

import {
  type AnimatableProp,
  type Composition,
  type Ease,
  type Keyframe,
  type Layer,
  type Marker,
} from '@breeze/schema';

export type Command =
  | { kind: 'addLayer'; layer: Layer; index?: number; parentId?: string }
  | { kind: 'deleteLayers'; layerIds: string[] }
  | { kind: 'reorderLayer'; layerId: string; toIndex: number }
  | { kind: 'patchLayer'; layerId: string; patch: Partial<Layer> }
  | { kind: 'renameLayer'; layerId: string; name: string }
  /**
   * Set one or more animatable values at `time`, letting the reducer decide
   * per property whether that means a keyframe or the static baseline.
   *
   * This exists so the properties panel and on-canvas dragging cannot disagree.
   * It carries several properties at once because a drag changes x and y
   * together: as separate commands their coalescing keys alternate, so a drag
   * produced two undo entries per frame instead of one for the whole gesture.
   */
  | { kind: 'setValues'; layerId: string; values: Partial<Record<AnimatableProp, number>>; time: number }
  /**
   * Resize: a new box plus the position change that comes with it.
   *
   * One command rather than a `patchLayer` for the size and a `setValues` for
   * the position. Those alternate, and coalescing only inspects the
   * immediately previous entry — so a resize gesture produced two undo entries
   * per pointer event and could never be undone in one step.
   */
  | {
      kind: 'resizeLayer';
      layerId: string;
      size: { width: number; height: number };
      values: Partial<Record<AnimatableProp, number>>;
      time: number;
    }
  | { kind: 'setKeyframe'; layerId: string; prop: AnimatableProp; time: number; value: number; ease?: Ease }
  | { kind: 'moveKeyframe'; layerId: string; prop: AnimatableProp; from: number; to: number }
  | { kind: 'setKeyframeValue'; layerId: string; prop: AnimatableProp; time: number; value: number }
  | { kind: 'setKeyframeEase'; layerId: string; prop: AnimatableProp; time: number; ease: Ease }
  | { kind: 'deleteKeyframes'; targets: Array<{ layerId: string; prop: AnimatableProp; time: number }> }
  | { kind: 'pasteKeyframes'; layerId: string; prop: AnimatableProp; keyframes: Keyframe[]; atTime: number }
  | { kind: 'addMarker'; marker: Marker }
  | { kind: 'moveMarker'; index: number; time: number }
  | { kind: 'deleteMarker'; index: number }
  | { kind: 'setStage'; patch: Partial<Composition['stage']> }
  | { kind: 'setDuration'; duration: number }
  | { kind: 'renameComposition'; name: string };

/** Human-readable label for the history UI. */
export function describeCommand(command: Command): string {
  switch (command.kind) {
    case 'addLayer': return `Add ${command.layer.type} layer`;
    case 'deleteLayers': return command.layerIds.length > 1 ? `Delete ${command.layerIds.length} layers` : 'Delete layer';
    case 'reorderLayer': return 'Reorder layer';
    case 'patchLayer': return 'Change layer';
    case 'renameLayer': return 'Rename layer';
    case 'setValues': {
      const names = Object.keys(command.values);
      return names.length === 1 ? `Change ${names[0]}` : 'Move layer';
    }
    case 'resizeLayer': return 'Resize layer';
    case 'setKeyframe': return 'Add keyframe';
    case 'moveKeyframe': return 'Move keyframe';
    case 'setKeyframeValue': return 'Change keyframe value';
    case 'setKeyframeEase': return 'Change easing';
    case 'deleteKeyframes': return command.targets.length > 1 ? `Delete ${command.targets.length} keyframes` : 'Delete keyframe';
    case 'pasteKeyframes': return 'Paste keyframes';
    case 'addMarker': return 'Add marker';
    case 'moveMarker': return 'Move marker';
    case 'deleteMarker': return 'Delete marker';
    case 'setStage': return 'Change stage';
    case 'setDuration': return 'Change duration';
    case 'renameComposition': return 'Rename composition';
  }
}

/**
 * Commands that should merge with the previous one when they arrive in a
 * stream — dragging a layer must be one undo step, not four hundred.
 */
export function coalesceKey(command: Command): string | null {
  switch (command.kind) {
    case 'patchLayer': return `patchLayer:${command.layerId}:${Object.keys(command.patch).sort().join(',')}`;
    // Keyed on the property set and the time, so an entire drag gesture — many
    // writes to the same properties at the same playhead — is one undo step.
    case 'setValues': return `setValues:${command.layerId}:${Object.keys(command.values).sort().join(',')}:${command.time}`;
    case 'resizeLayer': return `resizeLayer:${command.layerId}:${command.time}`;
    case 'setKeyframe': return `setKeyframe:${command.layerId}:${command.prop}:${command.time}`;
    case 'moveKeyframe': return `moveKeyframe:${command.layerId}:${command.prop}`;
    case 'setKeyframeValue': return `setKeyframeValue:${command.layerId}:${command.prop}:${command.time}`;
    case 'moveMarker': return `moveMarker:${command.index}`;
    case 'renameLayer': return `renameLayer:${command.layerId}`;
    case 'renameComposition': return 'renameComposition';
    default: return null;
  }
}

/* ------------------------------------------------------------- traversal */

/**
 * Replace one layer anywhere in the tree.
 *
 * Returns the ORIGINAL array when nothing changed. That identity is load-
 * bearing: `pushCommand` treats `next === composition` as "no-op, don't record
 * an undo step". Without it, clicking a field and tabbing away without editing
 * anything — or a command aimed at a layer that no longer exists — silently
 * consumed the user's undo slot.
 *
 * Two kinds of child, deliberately traversed by the same walk. A group's
 * `children` are layers on the stage; a table's `row.cells` are the template
 * the runtime clones per data row. They are *both* ordinary layers with ids,
 * and that is the whole reason per-cell keyframes became authorable for the
 * cost of this function: every command below is keyed on `layerId` and routes
 * through here, so `patchLayer`, `setValues`, `setKeyframe`, `moveKeyframe`,
 * `deleteKeyframes` and `pasteKeyframes` all reach a cell with no case of
 * their own. The runtime and schema support shipped in 0.53.0; the editor
 * could not address a cell only because this walk stopped at the table.
 */
function mapLayer(layers: Layer[], layerId: string, fn: (layer: Layer) => Layer): Layer[] {
  let changed = false;

  const next = layers.map((layer) => {
    if (layer.id === layerId) {
      const updated = fn(layer);
      if (updated !== layer) changed = true;
      return updated;
    }
    if (layer.type === 'group') {
      const children = mapLayer(layer.children, layerId, fn);
      if (children !== layer.children) {
        changed = true;
        return { ...layer, children };
      }
    }
    if (layer.type === 'table') {
      const cells = mapLayer(layer.row.cells, layerId, fn);
      if (cells !== layer.row.cells) {
        changed = true;
        return { ...layer, row: { ...layer.row, cells } };
      }
    }
    return layer;
  });

  return changed ? next : layers;
}

function removeLayers(layers: Layer[], ids: Set<string>): Layer[] {
  let changed = false;
  const out: Layer[] = [];

  for (const layer of layers) {
    if (ids.has(layer.id)) {
      changed = true;
      continue;
    }
    if (layer.type === 'group') {
      const children = removeLayers(layer.children, ids);
      if (children !== layer.children) {
        changed = true;
        out.push({ ...layer, children });
        continue;
      }
    }
    if (layer.type === 'table') {
      const cells = removeLayers(layer.row.cells, ids);
      if (cells !== layer.row.cells) {
        changed = true;
        out.push({ ...layer, row: { ...layer.row, cells } });
        continue;
      }
    }
    out.push(layer);
  }

  return changed ? out : layers;
}

/** True when every key in `patch` already holds an equal value on `layer`. */
function patchIsNoop(layer: Layer, patch: Partial<Layer>): boolean {
  const current = layer as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id' || key === 'type') continue;
    // Values here are small plain objects (transform, size, style), so a JSON
    // comparison is both correct and cheaper than a deep-equal helper.
    if (JSON.stringify(current[key]) !== JSON.stringify(value)) return false;
  }
  return true;
}

function tracksEqual(a: Keyframe[] | undefined, b: Keyframe[]): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b);
}

export function findLayer(layers: Layer[], layerId: string): Layer | undefined {
  for (const layer of layers) {
    if (layer.id === layerId) return layer;
    if (layer.type === 'group') {
      const found = findLayer(layer.children, layerId);
      if (found) return found;
    }
    if (layer.type === 'table') {
      const found = findLayer(layer.row.cells, layerId);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * The table whose row template holds `cellId`, or undefined for an ordinary
 * layer.
 *
 * A cell is a layer, but it is not a layer *on the stage*: it is drawn once per
 * data row, inside a box positioned by the table. Several panels have to know
 * the difference — the stage cannot offer transform handles for something that
 * exists N times, and the timeline needs the owning table to label the track.
 * Asking this question is cheaper and far less error-prone than every caller
 * re-deriving it from the tree.
 */
export function findCellOwner(layers: Layer[], cellId: string): Layer | undefined {
  for (const layer of layers) {
    if (layer.type === 'table') {
      if (layer.row.cells.some((c) => c.id === cellId)) return layer;
    }
    if (layer.type === 'group') {
      const found = findCellOwner(layer.children, cellId);
      if (found) return found;
    }
  }
  return undefined;
}

/** True when `layerId` names a table cell rather than a stage layer. */
export function isCell(layers: Layer[], layerId: string): boolean {
  return findCellOwner(layers, layerId) !== undefined;
}

/* ------------------------------------------------------------- keyframes */

/** Keep a track sorted and free of duplicate times — the schema requires both. */
export function normalizeTrack(track: Keyframe[]): Keyframe[] {
  const byTime = new Map<number, Keyframe>();
  for (const kf of track) {
    // Snap to microseconds so float drift from dragging cannot produce two
    // keyframes the validator sees as duplicates but the UI draws as one.
    const t = Math.round(kf.t * 1e6) / 1e6;
    byTime.set(t, { ...kf, t });
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function withTrack(
  layer: Layer,
  prop: AnimatableProp,
  fn: (track: Keyframe[]) => Keyframe[],
): Layer {
  const current = layer.keyframes?.[prop] ?? [];
  const next = normalizeTrack(fn(current));

  // Preserve identity so a keyframe drag that lands back on its own time, or a
  // move targeting a keyframe that is not there, records no undo step.
  if (tracksEqual(layer.keyframes?.[prop], next)) return layer;

  const keyframes = { ...(layer.keyframes ?? {}) };

  if (next.length === 0) delete keyframes[prop];
  else keyframes[prop] = next;

  if (Object.keys(keyframes).length === 0) {
    const { keyframes: _dropped, ...rest } = layer;
    return rest as Layer;
  }
  return { ...layer, keyframes } as Layer;
}

const TIME_EPSILON = 1e-6;

const sameTime = (a: number, b: number) => Math.abs(a - b) < TIME_EPSILON;

/* --------------------------------------------------------------- reducer */

export function applyCommand(comp: Composition, command: Command): Composition {
  switch (command.kind) {
    case 'addLayer': {
      if (command.parentId) {
        const layers = mapLayer(comp.layers, command.parentId, (parent) => {
          if (parent.type === 'group') {
            return { ...parent, children: [...parent.children, command.layer] };
          }
          // A table's parent-child relationship is its row template. Appending
          // is right for both: `zIndex` follows array order, so a new cell
          // paints on top, which is what "add" means to whoever just clicked.
          if (parent.type === 'table') {
            return { ...parent, row: { ...parent.row, cells: [...parent.row.cells, command.layer] } };
          }
          return parent;
        });
        return layers === comp.layers ? comp : { ...comp, layers };
      }
      const layers = [...comp.layers];
      layers.splice(command.index ?? layers.length, 0, command.layer);
      return { ...comp, layers };
    }

    case 'deleteLayers': {
      const layers = removeLayers(comp.layers, new Set(command.layerIds));
      return layers === comp.layers ? comp : { ...comp, layers };
    }

    case 'reorderLayer': {
      const from = comp.layers.findIndex((l) => l.id === command.layerId);

      // Not at the top level — a cell inside a row template, whose order is its
      // paint order within the row (`buildRow` writes `zIndex` from the array
      // index). Reordering has to reach it, or the only way to put a badge
      // behind a name is to delete and re-add the cell in the right sequence.
      if (from === -1) {
        const owner = findCellOwner(comp.layers, command.layerId);
        if (!owner || owner.type !== 'table') return comp;

        const cellFrom = owner.row.cells.findIndex((c) => c.id === command.layerId);
        if (cellFrom === -1) return comp;

        const cells = [...owner.row.cells];
        const [moved] = cells.splice(cellFrom, 1);
        cells.splice(Math.max(0, Math.min(command.toIndex, cells.length)), 0, moved!);

        return withLayers(comp, mapLayer(comp.layers, owner.id, (table) =>
          table.type === 'table' ? { ...table, row: { ...table.row, cells } } : table,
        ));
      }

      const layers = [...comp.layers];
      const [moved] = layers.splice(from, 1);
      layers.splice(Math.max(0, Math.min(command.toIndex, layers.length)), 0, moved!);
      return { ...comp, layers };
    }

    case 'patchLayer': {
      const layers = mapLayer(comp.layers, command.layerId, (layer) =>
        patchIsNoop(layer, command.patch)
          ? layer
          : ({
              ...layer,
              ...command.patch,
              // Identity is never patchable: losing it would orphan keyframes
              // and detach the layer from the timeline.
              id: layer.id,
              type: layer.type,
            } as Layer),
      );
      return layers === comp.layers ? comp : { ...comp, layers };
    }

    case 'renameLayer': {
      const layers = mapLayer(comp.layers, command.layerId, (layer) =>
        layer.name === command.name ? layer : { ...layer, name: command.name },
      );
      return layers === comp.layers ? comp : { ...comp, layers };
    }

    case 'resizeLayer':
      return withLayers(comp, mapLayer(comp.layers, command.layerId, (layer) => {
        // Only re-wrap when the size actually differs. Spreading unconditionally
        // allocates a new object every time, which defeats the identity check
        // that stops a no-op consuming an undo slot.
        const sized = patchIsNoop(layer, { size: command.size } as Partial<Layer>)
          ? layer
          : ({ ...layer, size: command.size } as Layer);
        return applyValues(sized, command.values, command.time);
      }));

    case 'setValues':
      return withLayers(comp, mapLayer(comp.layers, command.layerId, (layer) =>
        applyValues(layer, command.values, command.time),
      ));

    case 'setKeyframe':
      return withLayers(comp, mapLayer(comp.layers, command.layerId, (layer) =>
        withTrack(layer, command.prop, (track) => [
          ...track.filter((kf) => !sameTime(kf.t, command.time)),
          {
            t: command.time,
            v: command.value,
            // Inherit the ease of the keyframe being replaced, so nudging a
            // value does not silently reset a hand-tuned curve.
            ...(command.ease !== undefined
              ? { ease: command.ease }
              : easeAt(track, command.time)),
          },
        ]),
      ));

    case 'moveKeyframe':
      return withLayers(comp, mapLayer(comp.layers, command.layerId, (layer) =>
        withTrack(layer, command.prop, (track) => {
          const moving = track.find((kf) => sameTime(kf.t, command.from));
          if (!moving) return track;
          const time = Math.max(0, command.to);
          return [
            ...track.filter((kf) => !sameTime(kf.t, command.from) && !sameTime(kf.t, time)),
            { ...moving, t: time },
          ];
        }),
      ));

    case 'setKeyframeValue':
      return withLayers(comp, mapLayer(comp.layers, command.layerId, (layer) =>
        withTrack(layer, command.prop, (track) =>
          track.map((kf) => (sameTime(kf.t, command.time) ? { ...kf, v: command.value } : kf)),
        ),
      ));

    case 'setKeyframeEase':
      return withLayers(comp, mapLayer(comp.layers, command.layerId, (layer) =>
        withTrack(layer, command.prop, (track) =>
          track.map((kf) => (sameTime(kf.t, command.time) ? { ...kf, ease: command.ease } : kf)),
        ),
      ));

    case 'deleteKeyframes': {
      let next = comp;
      // Group by layer+prop so one command can clear a multi-select spanning
      // several tracks in a single undo step.
      const byTrack = new Map<string, { layerId: string; prop: AnimatableProp; times: number[] }>();
      for (const target of command.targets) {
        const key = `${target.layerId}:${target.prop}`;
        const entry = byTrack.get(key);
        if (entry) entry.times.push(target.time);
        else byTrack.set(key, { layerId: target.layerId, prop: target.prop, times: [target.time] });
      }
      for (const { layerId, prop, times } of byTrack.values()) {
        next = withLayers(next, mapLayer(next.layers, layerId, (layer) =>
          withTrack(layer, prop, (track) =>
            track.filter((kf) => !times.some((t) => sameTime(kf.t, t))),
          ),
        ));
      }
      return next;
    }

    case 'pasteKeyframes': {
      if (command.keyframes.length === 0) return comp;
      const origin = Math.min(...command.keyframes.map((kf) => kf.t));
      return withLayers(comp, mapLayer(comp.layers, command.layerId, (layer) =>
        withTrack(layer, command.prop, (track) => {
          const shifted = command.keyframes.map((kf) => ({
            ...kf,
            t: Math.max(0, command.atTime + (kf.t - origin)),
          }));
          // Pasted keyframes win over whatever occupied those times.
          const kept = track.filter((kf) => !shifted.some((s) => sameTime(s.t, kf.t)));
          return [...kept, ...shifted];
        }),
      ));
    }

    case 'addMarker':
      return { ...comp, markers: [...(comp.markers ?? []), command.marker].sort((a, b) => a.time - b.time) };

    case 'moveMarker': {
      const markers = [...(comp.markers ?? [])];
      const marker = markers[command.index];
      if (!marker) return comp;
      if (sameTime(marker.time, Math.max(0, command.time))) return comp;
      markers[command.index] = { ...marker, time: Math.max(0, command.time) };
      return { ...comp, markers: markers.sort((a, b) => a.time - b.time) };
    }

    case 'deleteMarker': {
      const markers = (comp.markers ?? []).filter((_, i) => i !== command.index);
      return markers.length === (comp.markers ?? []).length ? comp : { ...comp, markers };
    }

    case 'setStage': {
      const stage = { ...comp.stage, ...command.patch };
      return JSON.stringify(stage) === JSON.stringify(comp.stage) ? comp : { ...comp, stage };
    }

    case 'setDuration': {
      const duration = Math.max(0, command.duration);
      return duration === comp.duration ? comp : { ...comp, duration };
    }

    case 'renameComposition':
      return command.name === comp.name ? comp : { ...comp, name: command.name };
  }
}

/** Rewrap a composition only when its layer array actually changed. */
function withLayers(comp: Composition, layers: Layer[]): Composition {
  return layers === comp.layers ? comp : { ...comp, layers };
}

/**
 * Write animatable values onto a layer, choosing per property between a
 * keyframe at `time` and the static baseline.
 *
 * Shared by `setValues` and `resizeLayer` so a drag and a resize cannot disagree
 * about what setting `x` means.
 */
function applyValues(
  layer: Layer,
  values: Partial<Record<AnimatableProp, number>>,
  time: number,
): Layer {
  let next = layer;
  const transform: Record<string, number> = {};
  const effects: Record<string, number> = {};
  let opacity: number | undefined;

  for (const [key, value] of Object.entries(values)) {
    const prop = key as AnimatableProp;
    if (value === undefined) continue;

    // Animated: write a keyframe at the playhead. The static baseline is
    // ignored by the planner once a track exists, so writing it there would
    // look like nothing happened.
    if (next.keyframes?.[prop]?.length) {
      next = withTrack(next, prop, (track) => [
        ...track.filter((kf) => !sameTime(kf.t, time)),
        { t: time, v: value, ...easeAt(track, time) },
      ]);
      continue;
    }

    if (prop === 'opacity') opacity = value;
    else if (prop === 'blur' || prop === 'brightness') effects[prop] = value;
    else transform[prop] = value;
  }

  const patch: Record<string, unknown> = {};
  if (Object.keys(transform).length) patch['transform'] = { ...(next.transform ?? {}), ...transform };
  if (Object.keys(effects).length) patch['effects'] = { ...(next.effects ?? {}), ...effects };
  if (opacity !== undefined) patch['opacity'] = opacity;

  if (Object.keys(patch).length && !patchIsNoop(next, patch as Partial<Layer>)) {
    next = { ...next, ...patch } as Layer;
  }
  return next;
}

/** Ease carried by the keyframe currently at `time`, if any. */
function easeAt(track: Keyframe[], time: number): { ease?: Ease } {
  const existing = track.find((kf) => sameTime(kf.t, time));
  return existing?.ease !== undefined ? { ease: existing.ease } : {};
}

export function applyCommands(comp: Composition, commands: Command[]): Composition {
  return commands.reduce(applyCommand, comp);
}
