// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Dynamic fields. Any layer carrying a `binding` name becomes an operator-
 * editable field. The derived schema drives:
 *   - the `/control/:id` operator form (Phase 4)
 *   - `update()` payloads over REST and WebSocket
 *   - host scripting from vMix and OBS, which send the same JSON
 */

import type { Composition, Layer } from './types.js';

export type BindingKind = 'string' | 'image' | 'video' | 'stringList' | 'dataset';

export interface BindingDescriptor {
  name: string;
  kind: BindingKind;
  /** Layer ids that consume this binding — several layers may share one name. */
  layerIds: string[];
  /** Authored value, used as the form default. */
  defaultValue: unknown;
  label: string;
  /**
   * Data-source id feeding the layer behind this binding, if any.
   *
   * A layer can carry both — `source` for the feed and `binding` so a playout
   * server can still push rows — and the two then race, last write winning. The
   * operator panel resolves that by asking what *kind* of source it is: rows
   * that come from a fetch are shown and not edited, rows that come from a
   * manual table stay editable. That decision needs the source *definition*,
   * which lives on the server, so this only reports the id and lets the caller
   * judge.
   */
  source?: string;
  /** For a crawl: which column of `source` supplies the items. */
  column?: string;
}

/**
 * Table row templates are deliberately not walked. A cell's `binding` would be
 * meaningless — every row would show the same value — so cells bind to columns
 * via `cell`, and the *table* exposes the one operator-editable field.
 */
function eachLayer(layers: Layer[], fn: (l: Layer) => void): void {
  for (const layer of layers) {
    fn(layer);
    if (layer.type === 'group') eachLayer(layer.children, fn);
  }
}

export function collectBindings(comp: Composition): BindingDescriptor[] {
  const byName = new Map<string, BindingDescriptor>();

  eachLayer(comp.layers, (layer) => {
    if (!('binding' in layer) || !layer.binding) return;
    const name = layer.binding;

    let kind: BindingKind = 'string';
    let defaultValue: unknown = '';
    let source: string | undefined;
    let column: string | undefined;
    if (layer.type === 'text') defaultValue = layer.text;
    else if (layer.type === 'image') { kind = 'image'; defaultValue = layer.src; }
    else if (layer.type === 'video') { kind = 'video'; defaultValue = layer.src; }
    // A sprite binds as an `image` because what travels over the wire is a
    // still sheet, and the panel should offer an image picker rather than a
    // video one. Only reachable on a 1×1 grid — `validate.ts` refuses a binding
    // on a multi-frame sprite, since the replacement sheet would be stepped
    // through the outgoing sheet's geometry.
    else if (layer.type === 'sprite') { kind = 'image'; defaultValue = layer.src; }
    else if (layer.type === 'crawl') {
      kind = 'stringList';
      defaultValue = layer.items;
      source = layer.source;
      column = layer.column;
    } else if (layer.type === 'table') {
      kind = 'dataset';
      defaultValue = layer.data ?? { columns: [], rows: [] };
      source = layer.source;
    }

    const existing = byName.get(name);
    if (existing) {
      existing.layerIds.push(layer.id);
      // First layer to name a source wins. Two layers sharing a binding name
      // but reading different sources is an authoring mistake the editor should
      // catch; picking one here at least keeps the panel coherent.
      if (source !== undefined && existing.source === undefined) existing.source = source;
      if (column !== undefined && existing.column === undefined) existing.column = column;
    } else {
      byName.set(name, {
        name,
        kind,
        layerIds: [layer.id],
        defaultValue,
        label: layer.name ?? name,
        ...(source ? { source } : {}),
        ...(column ? { column } : {}),
      });
    }
  });

  return [...byName.values()];
}

/**
 * Separator between a mount and the field it carries — `nest118bi.headlines`.
 *
 * A frozen identifier (I18N.md §2): it goes into `update()` payloads, into the
 * `/bindings` descriptor an external caller reads, and therefore into Companion
 * buttons and vMix scripts. It never changes and it is never localised.
 */
export const OVERRIDE_ADDRESS_SEPARATOR = '.';

export interface OverrideBinding extends BindingDescriptor {
  /**
   * How an operator addresses this one mount: `<mount layer id>.<binding>`,
   * with the mount's id namespaced by any groups or mounts above it — the same
   * id the runtime's expander gives that instance.
   *
   * The plain binding name deliberately does **not** reach it: an overridden
   * field is pinned against ordinary `update()` precisely so two mounts of one
   * badge can differ, and un-pinning it would make the HOME badge answer a
   * push meant for AWAY. The address is the way in that keeps them apart.
   */
  address: string;
  /** Instance id of the composition layer carrying the override. */
  mountId: string;
  /** What the operator sees — the mount's name, then the field's. */
  mountLabel: string;
}

/**
 * Overridden fields on nested mounts, addressable one mount at a time.
 *
 * `collectBindings` above answers "what may an operator type into *this*
 * composition" and deliberately does not walk into mounted compositions — a
 * nested comp's fields are the child's business, and exposing them all would
 * put every field of every mounted graphic on one panel.
 *
 * This answers the narrower question the override editor creates: *which
 * fields has an author deliberately configured per mount*, and what does an
 * operator send to change one live. Only overridden fields qualify, and that is
 * the point — the override is the author saying "this mount's copy is a thing
 * somebody sets", which is exactly the field an operator will be asked for at
 * two minutes to air.
 *
 * Independent mounts are skipped: they own a control channel each, and their
 * fields are addressed there rather than through the parent (SCENES.md §2).
 */
export function collectOverrideBindings(
  comp: Composition,
  resolve: (id: string) => Composition | undefined,
  /** Guards a cyclic project, the same way the runtime's expander does. */
  seen: readonly string[] = [comp.id],
  prefix = '',
): OverrideBinding[] {
  const out: OverrideBinding[] = [];

  const visit = (layers: Layer[], at: string): void => {
    for (const layer of layers) {
      if (layer.type === 'group') {
        visit(layer.children, `${at}${layer.id}/`);
        continue;
      }
      if (layer.type !== 'composition' || layer.independent) continue;

      const child = resolve(layer.ref);
      if (!child || seen.includes(layer.ref)) continue;

      const mountId = `${at}${layer.id}`;
      const overrides = layer.overrides ?? {};
      const childBindings = collectBindings(child);

      for (const [name, value] of Object.entries(overrides)) {
        const binding = childBindings.find((b) => b.name === name);
        // An override naming a field the child does not have is dead config;
        // it is not offered, and `validateProject` is where saying so belongs.
        if (!binding) continue;
        out.push({
          ...binding,
          defaultValue: value,
          address: `${mountId}${OVERRIDE_ADDRESS_SEPARATOR}${name}`,
          mountId,
          mountLabel: `${layer.name ?? layer.ref} · ${binding.label}`,
        });
      }

      // A mount inside a mount can carry overrides too.
      out.push(...collectOverrideBindings(child, resolve, [...seen, layer.ref], `${mountId}/`));
    }
  };

  visit(comp.layers, prefix);
  return out;
}

/** A data source this composition reads, and what reads it. */
export interface SourceRef {
  /** Data-source id. */
  id: string;
  /** Layer ids consuming it. */
  layerIds: string[];
  /** How the consuming layer uses it — governs how a panel should show it. */
  kind: 'dataset' | 'stringList';
  /** For a crawl: the column supplying items. */
  column?: string;
  /** Layer name, for a caption. */
  label: string;
}

/**
 * Sources this composition reads, independent of `binding`.
 *
 * Separate from `collectBindings` because the two answer different questions
 * and a layer can be either, both, or neither. A binding is "what may an
 * operator type into"; a source ref is "what does this graphic read on its
 * own". The screen bug has one source and *no* bindings at all — its
 * temperature is fed and its clock is local — so a panel built only from
 * bindings would show an empty page for a graphic that is doing plenty.
 *
 * Row templates are not walked, for the same reason `collectBindings` skips
 * them: a cell reads a column of the table's source, not a source of its own.
 */
export function collectSources(comp: Composition): SourceRef[] {
  const byId = new Map<string, SourceRef>();

  eachLayer(comp.layers, (layer) => {
    if (layer.type !== 'table' && layer.type !== 'crawl') return;
    if (!layer.source) return;

    const existing = byId.get(layer.source);
    if (existing) {
      existing.layerIds.push(layer.id);
      if (layer.type === 'crawl' && layer.column !== undefined && existing.column === undefined) {
        existing.column = layer.column;
      }
      return;
    }

    byId.set(layer.source, {
      id: layer.source,
      layerIds: [layer.id],
      kind: layer.type === 'crawl' ? 'stringList' : 'dataset',
      ...(layer.type === 'crawl' && layer.column ? { column: layer.column } : {}),
      label: layer.name ?? layer.source,
    });
  });

  return [...byId.values()];
}

/**
 * JSON Schema for the dynamic-field form — what `/control/:id` renders, and
 * what `GET …/bindings` hands any client driving the graphic.
 */
export function bindingsJsonSchema(
  comp: Composition,
  /**
   * Supplied by a caller that can resolve nested refs — the server can, a
   * browser holding one composition cannot. With it, per-mount override
   * addresses join the schema so an external caller can discover them; without
   * it the schema is exactly what it always was.
   */
  resolve?: (id: string) => Composition | undefined,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  const overrides = resolve ? collectOverrideBindings(comp, resolve) : [];

  /*
   * Key and title are decided before the switch rather than inside it. An
   * override is keyed by its *address*, not its bare name: two mounts of one
   * badge both bind `badgeText`, and one property called that could only ever
   * mean one of them.
   */
  const fields: Array<{ key: string; title: string; b: BindingDescriptor }> = [
    ...collectBindings(comp).map((b) => ({ key: b.name, title: b.label, b })),
    ...overrides.map((o) => ({ key: o.address, title: o.mountLabel, b: o as BindingDescriptor })),
  ];

  for (const { key, title, b } of fields) {
    switch (b.kind) {
      case 'stringList':
        properties[key] = {
          type: 'array',
          items: { type: 'string' },
          title,
          default: b.defaultValue,
        };
        break;
      case 'dataset':
        /*
         * Described as an object with `columns` and `rows` rather than a bare
         * array. The control panel has to be able to render an editor for it,
         * and a caller pushing rows without columns cannot be typed — which is
         * exactly how a numeric column arrives as text and sorts alphabetically
         * on air.
         */
        properties[key] = {
          type: 'object',
          title,
          description: 'tabular data — { columns, rows }',
          properties: {
            columns: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  label: { type: 'string' },
                  type: { enum: ['string', 'number', 'boolean', 'date'] },
                },
                required: ['key', 'type'],
              },
            },
            rows: { type: 'array', items: { type: 'object' } },
          },
          default: b.defaultValue,
        };
        break;
      case 'image':
      case 'video':
        properties[key] = {
          type: 'string',
          title,
          description: `${b.kind} asset path or URL`,
          default: b.defaultValue,
        };
        break;
      default:
        properties[key] = { type: 'string', title, default: b.defaultValue };
    }
  }

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    title: `${comp.name} — dynamic fields`,
    properties,
  };
}

/**
 * Number of playable steps — a step is a state the graphic can *hold* in, so
 * this is the stop-marker count.
 *
 * It deliberately does not count the outro. The outro is not a step: an
 * operator cannot park on it, and `next()` never lands there. Counting it made
 * a plain lower third report two steps when it has exactly one holdable state,
 * which showed up as "step 2/2" on the debug overlay at the only hold.
 *
 * A composition with no stop markers plays straight through; that is still one
 * step, not zero.
 */
export function stepCount(comp: Composition): number {
  return Math.max(1, (comp.markers ?? []).filter((m) => m.type === 'stop').length);
}
