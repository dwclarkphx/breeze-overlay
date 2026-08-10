// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/** Constructors that fill in defaults, so the editor and tests never hand-roll partial documents. */

import {
  DEFAULT_CRAWL_SEPARATOR,
  DEFAULT_STAGE,
  FORMAT_VERSION,
  type Composition,
  type Layer,
  type LayerBase,
  type LayerType,
  type Project,
  type ShapeLayer,
  type Stage,
  type TableLayer,
  type TextLayer,
} from './types.js';

let counter = 0;

/**
 * Layer ids: unchanged. Short, opaque, never seen in a URL.
 *
 * The hyphenated form below is for document keys only — a layer id appears in
 * `parentId` chains and cell references, where a separator buys nothing.
 */
export function makeId(prefix = 'l'): string {
  counter += 1;
  return `${prefix}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Document keys — project and composition ids, the things that end up in URLs.
 *
 * `<chosen>-<generated>`. The chosen half is the human part and the only half
 * anyone picks; the generated half is what keeps uniqueness automatic, so there
 * is no collision dialog to build and no rename path to support.
 *
 * The hyphen is load-bearing. It marks where the part a person chose ends and
 * the part the system owns begins, so nobody mistakes the whole string for
 * something they invented and tries to tidy up the tail.
 *
 * Note the format differs from every id already on disk (`proj1k3f9`, no
 * hyphen). That is fine and deliberate: existing files are never rewritten, and
 * both forms satisfy the pattern the JSON Schema validates against.
 */
export function makeKeyedId(kind: string, chosen?: string): string {
  const prefix = chosen && chosen.length > 0 ? chosen : kind;
  counter += 1;
  return `${prefix}-${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * A keyed id that is not already in `taken`.
 *
 * `counter` is module scope and resets when the process does, so two
 * compositions created in different server sessions can land on the same
 * counter value and the same four random characters. Rare — but the failure
 * mode is one composition silently overwriting another, which is not something
 * to discover during a show.
 */
export function uniqueKeyedId(kind: string, chosen: string | undefined, taken: Iterable<string>): string {
  const used = taken instanceof Set ? taken : new Set(taken);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = makeKeyedId(kind, chosen);
    if (!used.has(id)) return id;
  }
  // 100 collisions in a row is not bad luck, it is a broken RNG. Fail loudly
  // rather than returning a duplicate that overwrites someone's work.
  throw new Error(`could not generate a unique id for "${chosen ?? kind}"`);
}

export function createComposition(init: Partial<Composition> = {}): Composition {
  return {
    formatVersion: FORMAT_VERSION,
    id: init.id ?? makeKeyedId('comp'),
    name: init.name ?? 'Untitled composition',
    stage: { ...DEFAULT_STAGE, ...(init.stage ?? {}) } as Stage,
    markers: init.markers ?? [],
    layers: init.layers ?? [],
    ...(init.duration !== undefined ? { duration: init.duration } : {}),
    ...(init.meta ? { meta: init.meta } : {}),
  };
}

export function createProject(init: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    formatVersion: FORMAT_VERSION,
    id: init.id ?? makeKeyedId('proj'),
    name: init.name ?? 'Untitled project',
    createdAt: init.createdAt ?? now,
    updatedAt: init.updatedAt ?? now,
    compositions: init.compositions ?? [createComposition()],
    /*
     * No `assets` key. The index lives in a sibling `assets.json` as of Phase
     * 7.5, and emitting an empty legacy array here would mean every new project
     * is born already needing the migration `readAssets` performs. Carried
     * through only when a caller explicitly supplies one — which is the import
     * path reconstructing a project from an older bundle.
     */
    ...(init.assets ? { assets: init.assets } : {}),
  };
}

/**
 * Optional `LayerBase` fields carried through by every factory.
 *
 * These used to be dropped, which made the factories quietly lossy: cloning a
 * layer through one — exactly what an editor does on duplicate — discarded its
 * mask, effects and in/out points with no error anywhere.
 */
type BaseOptionals = Omit<Partial<LayerBase>, 'id' | 'type' | 'name'>;

function baseOptionals(init: Partial<LayerBase>): BaseOptionals {
  return {
    ...(init.keyframes ? { keyframes: init.keyframes } : {}),
    ...(init.mask ? { mask: init.mask } : {}),
    ...(init.effects ? { effects: init.effects } : {}),
    ...(init.blendMode ? { blendMode: init.blendMode } : {}),
    ...(init.in !== undefined ? { in: init.in } : {}),
    ...(init.out !== undefined ? { out: init.out } : {}),
    ...(init.visible !== undefined ? { visible: init.visible } : {}),
    ...(init.locked !== undefined ? { locked: init.locked } : {}),
    ...(init.cell ? { cell: init.cell } : {}),
  };
}

export function createShapeLayer(init: Partial<ShapeLayer> = {}): ShapeLayer {
  return {
    id: init.id ?? makeId('shape'),
    type: 'shape',
    name: init.name ?? 'Shape',
    shape: init.shape ?? 'rect',
    fill: init.fill ?? '#1f6feb',
    size: init.size ?? { width: 400, height: 100 },
    transform: init.transform ?? { x: 0, y: 0 },
    opacity: init.opacity ?? 1,
    ...baseOptionals(init),
    ...(init.stroke ? { stroke: init.stroke } : {}),
    ...(init.cornerRadius !== undefined ? { cornerRadius: init.cornerRadius } : {}),
  };
}

export function createTextLayer(init: Partial<TextLayer> = {}): TextLayer {
  return {
    id: init.id ?? makeId('text'),
    type: 'text',
    name: init.name ?? 'Text',
    text: init.text ?? 'Text',
    style: {
      fontFamily: 'Inter, Arial, sans-serif',
      fontSize: 48,
      fill: '#ffffff',
      align: 'left',
      verticalAlign: 'middle',
      ...(init.style ?? {}),
    },
    size: init.size ?? { width: 600, height: 60 },
    transform: init.transform ?? { x: 0, y: 0 },
    opacity: init.opacity ?? 1,
    ...baseOptionals(init),
    ...(init.binding ? { binding: init.binding } : {}),
    ...(init.fit ? { fit: init.fit } : {}),
    ...(init.textAnimPreset ? { textAnimPreset: init.textAnimPreset } : {}),
    ...(init.clock ? { clock: init.clock } : {}),
  };
}

/**
 * A table that renders something the moment it is added.
 *
 * The default carries a two-column snapshot and a matching template row rather
 * than an empty shell. An empty table looks identical to a broken one on the
 * stage — nothing — so a new layer that shows plausible rows is the difference
 * between "now style it" and "why is nothing there".
 */
export function createTableLayer(init: Partial<TableLayer> = {}): TableLayer {
  const rowHeight = init.row?.height ?? 56;
  return {
    id: init.id ?? makeId('table'),
    type: 'table',
    name: init.name ?? 'Table',
    size: init.size ?? { width: 720, height: 400 },
    transform: init.transform ?? { x: 0, y: 0 },
    opacity: init.opacity ?? 1,
    data: init.data ?? {
      columns: [
        { key: 'team', label: 'Team', type: 'string' },
        { key: 'w', label: 'W', type: 'number' },
        { key: 'l', label: 'L', type: 'number' },
      ],
      rows: [
        { team: 'Mesa', w: 11, l: 2 },
        { team: 'Chandler', w: 9, l: 4 },
        { team: 'Gilbert', w: 7, l: 6 },
      ],
    },
    row: init.row ?? {
      height: rowHeight,
      gap: 4,
      cells: [
        createShapeLayer({
          name: 'Row background',
          fill: 'rgba(13,17,23,0.86)',
          size: { width: 720, height: rowHeight },
          cornerRadius: 4,
        }),
        createTextLayer({
          name: 'Team',
          cell: 'team',
          text: 'Team',
          size: { width: 500, height: rowHeight },
          transform: { x: 20, y: 0 },
          style: { fontFamily: 'Inter, Arial, sans-serif', fontSize: 32, fill: '#ffffff', align: 'left', verticalAlign: 'middle' },
          fit: { mode: 'width', maxWidth: 480 },
        }),
        createTextLayer({
          name: 'W',
          cell: 'w',
          text: '0',
          size: { width: 80, height: rowHeight },
          transform: { x: 540, y: 0 },
          style: { fontFamily: 'Inter, Arial, sans-serif', fontSize: 32, fill: '#ffffff', align: 'center', verticalAlign: 'middle' },
        }),
        createTextLayer({
          name: 'L',
          cell: 'l',
          text: '0',
          size: { width: 80, height: rowHeight },
          transform: { x: 630, y: 0 },
          style: { fontFamily: 'Inter, Arial, sans-serif', fontSize: 32, fill: '#ffffff', align: 'center', verticalAlign: 'middle' },
        }),
      ],
    },
    rowAnim: init.rowAnim ?? { id: 'rows-up', stagger: 0.06, duration: 0.45, ease: 'power3.out' },
    flip: init.flip ?? { duration: 0.5, ease: 'power2.inOut' },
    ...baseOptionals(init),
    ...(init.source ? { source: init.source } : {}),
    ...(init.binding ? { binding: init.binding } : {}),
    ...(init.transforms ? { transforms: init.transforms } : {}),
    ...(init.rowsPerPage !== undefined ? { rowsPerPage: init.rowsPerPage } : {}),
    ...(init.layout ? { layout: init.layout } : {}),
  };
}

export function createLayer(type: LayerType): Layer {
  switch (type) {
    case 'shape':
      return createShapeLayer();
    case 'text':
      return createTextLayer();
    case 'image':
      return { id: makeId('img'), type: 'image', name: 'Image', src: '', size: { width: 320, height: 180 }, transform: { x: 0, y: 0 }, opacity: 1 };
    case 'video':
      // `onEnd: 'hold'` stated rather than left to the runtime default, so the
      // choice is visible in the JSON the moment a video layer is created.
      return { id: makeId('vid'), type: 'video', name: 'Video', src: '', size: { width: 640, height: 360 }, transform: { x: 0, y: 0 }, opacity: 1, loop: false, muted: true, onEnd: 'hold' };
    case 'sprite':
      // 1×1 is the only grid that is meaningful before a sheet has been picked:
      // it renders the whole image as a single frame, so a fresh sprite layer
      // looks like the asset the operator is about to choose rather than a
      // fragment of it. `fps` matches the stage default rather than the sheet's
      // real rate, which nothing can know yet.
      return { id: makeId('spr'), type: 'sprite', name: 'Sprite', src: '', cols: 1, rows: 1, fps: 30, size: { width: 320, height: 180 }, transform: { x: 0, y: 0 }, opacity: 1, loop: false, onEnd: 'hold' };
    case 'crawl':
      return {
        id: makeId('crawl'),
        type: 'crawl',
        name: 'Crawl',
        speed: 120,
        direction: 'left',
        items: ['Headline one', 'Headline two'],
        separator: DEFAULT_CRAWL_SEPARATOR,
        style: { fontFamily: 'Inter, Arial, sans-serif', fontSize: 36, fill: '#ffffff' },
        size: { width: 1920, height: 60 },
        transform: { x: 0, y: 0 },
        opacity: 1,
      };
    case 'table':
      return createTableLayer();
    case 'group':
      return { id: makeId('grp'), type: 'group', name: 'Group', children: [], transform: { x: 0, y: 0 }, opacity: 1 };
    case 'composition':
      return { id: makeId('nest'), type: 'composition', name: 'Nested', ref: '', transform: { x: 0, y: 0 }, opacity: 1 };
    default: {
      const exhaustive: never = type;
      throw new Error(`unknown layer type ${String(exhaustive)}`);
    }
  }
}
