// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Putting a rule's outcome on a layer (CYCLE.md, Wave 6). The deciding is in
 * `@breeze/schema`'s `resolveRules`; this is only the DOM half.
 *
 * Every change is reversible. The first time a rule overrides a property the
 * value it replaced is kept, and the moment no rule holds it goes back — a
 * banner turned red by First Alert must be the authored blue again when the
 * mode clears, not whatever it was a frame ago.
 *
 * Hiding uses `data-rule-hidden`, styled `visibility: hidden !important`, and
 * not the `data-hidden` the lifetime windows use: the two are independent (a
 * rule cannot pull a layer out of its window, nor a window override a rule),
 * and `visibility` keeps the layer measurable, so a text fit made while it was
 * hidden is still right when it shows.
 */

import type { RuleResult } from '@breeze/schema';

import type { LayerNodes } from './dom.js';

interface Originals {
  color?: { color: string; backgroundImage: string };
  fill?: string;
  src?: string;
}

const originals = new WeakMap<HTMLElement, Originals>();

function memo(el: HTMLElement): Originals {
  let o = originals.get(el);
  if (!o) {
    o = {};
    originals.set(el, o);
  }
  return o;
}

/**
 * The element a shape's fill lives on: a path's `<path>`, else the `.bz-shape`
 * div. The path first — its `<svg>` carries `.bz-shape` too, and painting the
 * svg's background would fill the whole layer box instead of the path.
 */
function shapeTarget(nodes: LayerNodes): HTMLElement | SVGElement | null {
  return nodes.content.querySelector<SVGElement>('path') ?? nodes.content.querySelector<HTMLElement>('.bz-shape');
}

function applyColor(nodes: LayerNodes, color: string | undefined): void {
  const o = memo(nodes.el);
  if (nodes.layer.type === 'text' && nodes.textInner) {
    const s = nodes.textInner.style;
    if (color === undefined) {
      if (!o.color) return;
      s.color = o.color.color;
      s.backgroundImage = o.color.backgroundImage;
      delete o.color;
      return;
    }
    o.color ??= { color: s.color, backgroundImage: s.backgroundImage };
    // A flat colour replaces a gradient fill too; the gradient is restored with it.
    s.backgroundImage = 'none';
    s.color = color;
    return;
  }
  if (nodes.layer.type === 'shape') {
    const target = shapeTarget(nodes);
    if (!target) return;
    const isPath = target.tagName.toLowerCase() === 'path';
    const current = isPath ? target.getAttribute('fill') ?? '' : (target as HTMLElement).style.background;
    if (color === undefined) {
      if (o.fill === undefined) return;
      if (isPath) target.setAttribute('fill', o.fill);
      else (target as HTMLElement).style.background = o.fill;
      delete o.fill;
      return;
    }
    o.fill ??= current;
    if (isPath) target.setAttribute('fill', color);
    else (target as HTMLElement).style.background = color;
  }
}

function applySrc(nodes: LayerNodes, src: string | undefined, resolve: (s: string) => string): void {
  const media = nodes.media;
  if (nodes.layer.type !== 'image' || !media) return;
  const o = memo(nodes.el);
  if (src === undefined) {
    if (o.src === undefined) return;
    // An image with no source before the rule goes back to none — an empty
    // `src` would be the browser's broken-image icon.
    if (o.src) media.src = o.src;
    else media.removeAttribute('src');
    delete o.src;
    return;
  }
  o.src ??= media.getAttribute('src') ?? '';
  const next = resolve(src);
  if (media.getAttribute('src') !== next) media.src = next;
}

/**
 * A new picture for an image a rule has replaced — a field bound to it changed
 * while the rule holds. It becomes what the layer goes back to when the rule
 * stops, rather than being shown now over the rule's. True when it was taken.
 */
export function setRuleBaseSrc(el: HTMLElement, src: string): boolean {
  const o = originals.get(el);
  if (o?.src === undefined) return false;
  o.src = src;
  return true;
}

/**
 * Put a rule result on a layer. `src` is left alone when `manageSrc` is false —
 * a table cell sets its own image from the row and the rule together, since
 * the row's value changes under it.
 */
export function applyRuleResult(
  nodes: LayerNodes,
  result: RuleResult,
  resolveAsset: (s: string) => string,
  manageSrc = true,
): void {
  if (result.hidden) nodes.el.dataset['ruleHidden'] = '1';
  else delete nodes.el.dataset['ruleHidden'];
  applyColor(nodes, result.color);
  if (manageSrc) applySrc(nodes, result.src, resolveAsset);
}
