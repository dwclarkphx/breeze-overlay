// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Masks, built as real SVG `<mask>` elements.
 *
 * The obvious approach — `clip-path: inset()/ellipse()` — cannot feather and
 * cannot invert, which rules out the two things masks are actually for in
 * broadcast graphics: soft-edged wipe reveals and punching a hole in a plate.
 * An SVG mask gives genuine gaussian feather (`feGaussianBlur`), trivial
 * inversion (white backing rect minus a black shape) and an animatable
 * transform for reveal moves — and Blink composites it on the GPU, so it stays
 * cheap in a browser source.
 */

import type { LayerMask } from '@breeze/schema';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

export interface MaskSize {
  width: number;
  height: number;
}

export interface MaskHandle {
  /** Value written to the element's `mask-image`. */
  reference: string;
  /** Slide the mask along X — drives the `maskOffset` keyframe track. */
  setOffset(px: number): void;
  destroy(): void;
}

/** Host `<svg>` that holds every mask definition for one runtime instance. */
export function createMaskHost(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  // Absolute + zero size keeps it out of layout without display:none, which
  // would stop Blink resolving the mask reference at all.
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  return svg;
}

export function createMask(
  doc: Document,
  host: SVGSVGElement,
  uid: string,
  mask: LayerMask,
  size: MaskSize,
  resolveAsset: (src: string) => string,
): MaskHandle {
  const maskId = `bz-mask-${uid}`;
  const filterId = `bz-mask-blur-${uid}`;

  const width = size.width || mask.width;
  const height = size.height || mask.height;

  const maskEl = doc.createElementNS(SVG_NS, 'mask');
  maskEl.setAttribute('id', maskId);
  // userSpaceOnUse so mask geometry is authored in the same pixel coordinates
  // as the layer box — objectBoundingBox would force every value to be a
  // fraction and break as soon as the layer is resized.
  maskEl.setAttribute('maskUnits', 'userSpaceOnUse');
  maskEl.setAttribute('x', '0');
  maskEl.setAttribute('y', '0');
  maskEl.setAttribute('width', String(width));
  maskEl.setAttribute('height', String(height));

  if (mask.invert) {
    // White shows through; the shape is then painted black to punch the hole.
    const backing = doc.createElementNS(SVG_NS, 'rect');
    backing.setAttribute('x', '0');
    backing.setAttribute('y', '0');
    backing.setAttribute('width', String(width));
    backing.setAttribute('height', String(height));
    backing.setAttribute('fill', '#ffffff');
    maskEl.appendChild(backing);
  }

  const group = doc.createElementNS(SVG_NS, 'g');
  const paint = mask.invert ? '#000000' : '#ffffff';

  if (mask.feather && mask.feather > 0) {
    const filter = doc.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', filterId);
    // Room for the blur to spread past the shape bounds, or the soft edge
    // gets clipped square — which looks exactly like no feather at all.
    filter.setAttribute('x', '-50%');
    filter.setAttribute('y', '-50%');
    filter.setAttribute('width', '200%');
    filter.setAttribute('height', '200%');

    const blur = doc.createElementNS(SVG_NS, 'feGaussianBlur');
    // stdDeviation ≈ half the visible feather width.
    blur.setAttribute('stdDeviation', String(mask.feather / 2));
    filter.appendChild(blur);
    host.appendChild(filter);

    group.setAttribute('filter', `url(#${filterId})`);
  }

  group.appendChild(buildMaskShape(doc, mask, paint, resolveAsset));
  maskEl.appendChild(group);
  host.appendChild(maskEl);

  return {
    reference: `url(#${maskId})`,
    setOffset(px: number) {
      group.setAttribute('transform', `translate(${px} 0)`);
    },
    destroy() {
      maskEl.remove();
      host.querySelector(`#${CSS.escape(filterId)}`)?.remove();
    },
  };
}

function buildMaskShape(
  doc: Document,
  mask: LayerMask,
  paint: string,
  resolveAsset: (src: string) => string,
): SVGElement {
  if (mask.type === 'ellipse') {
    const ellipse = doc.createElementNS(SVG_NS, 'ellipse');
    ellipse.setAttribute('cx', String(mask.x + mask.width / 2));
    ellipse.setAttribute('cy', String(mask.y + mask.height / 2));
    ellipse.setAttribute('rx', String(mask.width / 2));
    ellipse.setAttribute('ry', String(mask.height / 2));
    ellipse.setAttribute('fill', paint);
    return ellipse;
  }

  if (mask.type === 'image' && mask.src) {
    const image = doc.createElementNS(SVG_NS, 'image');
    const href = resolveAsset(mask.src);
    image.setAttribute('href', href);
    // Older CEF builds still want the xlink form.
    image.setAttributeNS(XLINK_NS, 'xlink:href', href);
    image.setAttribute('x', String(mask.x));
    image.setAttribute('y', String(mask.y));
    image.setAttribute('width', String(mask.width));
    image.setAttribute('height', String(mask.height));
    image.setAttribute('preserveAspectRatio', 'none');
    return image;
  }

  const rect = doc.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', String(mask.x));
  rect.setAttribute('y', String(mask.y));
  rect.setAttribute('width', String(mask.width));
  rect.setAttribute('height', String(mask.height));
  rect.setAttribute('fill', paint);
  return rect;
}

/** Apply a mask reference to an element, with the vendor-prefixed fallback. */
export function applyMaskReference(el: HTMLElement, reference: string): void {
  el.style.setProperty('mask-image', reference);
  el.style.setProperty('-webkit-mask-image', reference);
}
