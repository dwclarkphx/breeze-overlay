// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Mounting a composition as a still, for a thumbnail.
 *
 * Phase 7.6's missing consumer. `RuntimeOptions.still` shipped in 0.58.0 and
 * nothing has called it since: a `composition` layer still renders as a `⧉`
 * glyph, so two nested comps in a layers panel look identical. This is the
 * piece that turns the glyph into a picture.
 *
 * Three traps are designed around here, all of them recorded before this file
 * existed and none of them obvious from the outside.
 *
 * **1. Never `display: none`.** A hidden container measures `offsetWidth 0`,
 * and the runtime measures elements — Fit Width silently produces a scale of
 * zero and the strap renders as nothing. The box is laid out and moved
 * offscreen instead. This is the same failure that broke layers with an
 * in-point, and it fails *quietly*, which is what makes it worth a comment
 * rather than a convention.
 *
 * **2. Scale once, on the outside.** `scaleMode: 'contain'` makes the runtime
 * measure its own container and scale itself; a wrapper that also scales
 * double-applies. SCENES.md §3 records this from the opposite direction. So the
 * container is stage-sized, the runtime is pinned to `'none'`, and exactly one
 * `transform: scale()` sits above it.
 *
 * **3. Pose at the rest frame, not t=0.** `posterTimeOf` decides where —
 * `posterTime ?? first stop ?? 0`. t=0 is the one moment a graphic is
 * guaranteed to look like nothing.
 *
 * **Scenes mount several runtimes into one wrapper.** `expand.ts` skips
 * independent children, so a scene built as a single runtime renders its shared
 * plate and none of its elements. `sceneElements` gives the children in paint
 * order, and each gets its own full-bleed container and its own runtime, posed
 * at *its own* rest frame — a scene's elements are independently triggered, so
 * they have no shared timeline and no shared poster time.
 *
 * **This deliberately does not reuse `player.ts`'s mount**, which the plan had
 * called for. That loop is entangled with boot seeds, hub channels and its own
 * bookkeeping, and it scales each runtime with `contain` because its containers
 * are full-bleed and identical — the opposite of the single wrapper scale a
 * thumbnail needs. The part genuinely worth sharing, `sceneElements`, already
 * is. Merging the rest would mean a helper of five optional parameters serving
 * two callers that agree on about ten lines, and would make both harder to
 * read than the duplication it removed.
 */

import { BreezeRuntime } from '@breeze/runtime';
import { posterTimeOf, sceneElements, type Composition } from '@breeze/schema';

export interface ThumbMount {
  /** The scaled wrapper to put in the DOM. */
  element: HTMLElement;
  /**
   * A detached, larger copy of the same still, for a hover preview.
   *
   * **A clone, not a second runtime.** A still never animates — that is what
   * `RuntimeOptions.still` means — so `cloneNode(true)` of the built DOM is a
   * faithful copy at zero build cost. Rebuilding would double everything the
   * phase was careful about, to show the same frame again.
   *
   * Crisp at any size because the runtime rendered at the composition's own
   * stage pixels and only the CSS transform scales it: enlarging changes a
   * number, not a resolution. Raster images resample as they would anywhere.
   *
   * The one thing a clone cannot copy is a running timer. A clock layer's
   * ticker belongs to the live runtime, so a preview freezes its clock at the
   * moment it was opened — acceptable for a hover, and the same tick-once gap
   * Phase 7.6 already carries.
   */
  preview: (maxSize: number) => HTMLElement;
  destroy: () => void;
}

/**
 * How a stage fits a box, and where it sits inside it.
 *
 * Pure, and shared by the thumbnail and its preview so the two cannot disagree
 * about what "fit" means. Exported for its own tests: the offsets are the part
 * that silently produces a graphic hanging off one edge.
 */
export function fitStage(
  stage: { width: number; height: number },
  box: { width: number; height: number },
): { scale: number; x: number; y: number } {
  if (stage.width <= 0 || stage.height <= 0) return { scale: 1, x: 0, y: 0 };
  const scale = Math.min(box.width / stage.width, box.height / stage.height);
  return {
    scale,
    x: (box.width - stage.width * scale) / 2,
    y: (box.height - stage.height * scale) / 2,
  };
}

/**
 * Box for a preview of this stage, capped on its longest side.
 *
 * Aspect-correct rather than square. The row thumbnail is square because it
 * sits in a column of square things; a preview is a picture, and letterboxing
 * a 16:9 stage into a square would waste a third of it on nothing.
 */
export function previewBox(
  stage: { width: number; height: number },
  maxSize: number,
): { width: number; height: number } {
  if (stage.width <= 0 || stage.height <= 0) return { width: maxSize, height: maxSize };
  const scale = Math.min(maxSize / stage.width, maxSize / stage.height);
  return { width: Math.round(stage.width * scale), height: Math.round(stage.height * scale) };
}

/** Gap between the anchor and the preview, in px. */
export const PREVIEW_GAP = 10;

/**
 * Where a preview of `box` goes, given the thumbnail it belongs to.
 *
 * Beside the anchor by default, flipped to the other side when it would run off
 * the right edge, and clamped vertically. Pure, and in client coordinates —
 * which is what `getBoundingClientRect` returns and what `position: fixed`
 * consumes, so nothing has to convert.
 *
 * **Flip before clamp, deliberately.** Clamping a preview that does not fit on
 * the right slides it left until it covers the very row being pointed at,
 * which hides the thing the preview is meant to identify. Flipping moves it to
 * the other side of the anchor entirely and keeps the row visible; clamping is
 * then only ever a few pixels of vertical correction near a window edge.
 */
export function placePreview(
  anchor: { x: number; y: number; width: number; height: number },
  box: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = PREVIEW_GAP,
): { x: number; y: number } {
  const right = anchor.x + anchor.width + gap;
  const left = anchor.x - gap - box.width;

  // Prefer the right; flip only when it genuinely does not fit *and* the left
  // does. A preview wider than the whole viewport fits nowhere, and pinning it
  // to the left edge is the least bad answer.
  const x = right + box.width <= viewport.width ? right : left >= 0 ? left : Math.max(0, viewport.width - box.width);

  // Centred on the anchor, then clamped into the viewport.
  const wanted = anchor.y + anchor.height / 2 - box.height / 2;
  const y = Math.max(0, Math.min(wanted, viewport.height - box.height));

  return { x, y };
}

export interface MountThumbOptions {
  composition: Composition;
  /** Rendered size in CSS pixels — the thumbnail is square-ish and small. */
  size: number;
  resolveComposition?: (id: string) => Composition | undefined;
  resolveAsset?: (src: string) => string;
  doc?: Document;
}

/**
 * Build a still of one composition, posed and parked.
 *
 * Returns a wrapper the caller inserts wherever it likes. Ownership is the
 * caller's: `destroy()` must run when the thumbnail unmounts, or what the
 * runtime allocated outlives the panel that showed it.
 *
 * **Two of those allocations no longer happen.** A still now takes a tick-once
 * clock — the real time written before the first paint, and no interval — and
 * builds video layers as a poster frame captured once and then released rather
 * than as a live `<video>` with `preload="auto"`. Both were deferred while
 * thumbnails lived only in the layers panel, where the count is a handful; both
 * were the cost that made a composition picker unaffordable.
 */
export function mountCompositionThumb(opts: MountThumbOptions): ThumbMount {
  const doc = opts.doc ?? document;
  const { width, height } = opts.composition.stage;

  /*
   * The wrapper clips and scales. Its size is the thumbnail's; the stage inside
   * it keeps its authored pixels and is scaled down to fit.
   */
  const wrapper = doc.createElement('div');
  wrapper.className = 'comp-thumb';
  wrapper.style.width = `${opts.size}px`;
  wrapper.style.height = `${opts.size}px`;
  wrapper.style.overflow = 'hidden';
  wrapper.style.position = 'relative';

  const fit = fitStage({ width, height }, { width: opts.size, height: opts.size });

  /*
   * Stage-sized, laid out, and positioned — not hidden.
   *
   * `position: absolute` inside the wrapper keeps a 1920×1080 box from forcing
   * the panel's layout wider, while still giving the runtime real dimensions to
   * measure. `transform-origin: top left` makes the scale predictable from the
   * corner rather than the middle, and the centring offset is applied as part
   * of the same transform so there is still only one.
   */
  const host = doc.createElement('div');
  host.style.position = 'absolute';
  host.style.top = '0';
  host.style.width = `${width}px`;
  host.style.height = `${height}px`;
  host.style.transformOrigin = 'top left';
  host.style.transform = `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})`;
  wrapper.appendChild(host);

  const runtimes: BreezeRuntime[] = [];

  /**
   * One full-bleed container per runtime, stacked inside the scaled host.
   *
   * Absolute and 100%, so every runtime sees the same stage-sized box and their
   * outputs overlay exactly. DOM order is paint order.
   */
  const addContainer = (): HTMLElement => {
    const container = doc.createElement('div');
    container.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;';
    host.appendChild(container);
    return container;
  };

  const build = (comp: Composition, container: HTMLElement): BreezeRuntime =>
    new BreezeRuntime({
      container,
      composition: comp,
      ...(opts.resolveComposition ? { resolveComposition: opts.resolveComposition } : {}),
      ...(opts.resolveAsset ? { resolveAsset: opts.resolveAsset } : {}),
      autoPlay: false,
      // Skips the per-character split and its re-split on fonts.ready — most of
      // what `build()` costs on a text-heavy graphic, and none of it observable
      // in a frame that never moves.
      still: true,
      // Pinned. The wrapper above owns the only scale; `'contain'` here would
      // measure the container and apply a second one.
      scaleMode: 'none',
    });

  /*
   * The composition's own layers first — whatever is not independent. On a
   * scene that is the shared plate or band, and it belongs underneath.
   */
  const base = build(opts.composition, addContainer());
  base.seek(posterTimeOf(opts.composition));
  runtimes.push(base);

  /*
   * Then each independent element, in paint order, each posed at its own rest
   * frame.
   *
   * Independently triggered means independently *timed*: the scene's poster
   * time says nothing about where its bug should sit, so each element resolves
   * its own `posterTime ?? first stop ?? 0`.
   *
   * Wrapped individually, matching the player's rule for the same reason in a
   * smaller way: one element that fails to build must not cost the whole
   * thumbnail. A scene showing its strap and missing its bug is still useful
   * for telling two scenes apart, which is the only job here.
   */
  for (const element of sceneElements(opts.composition)) {
    const child = opts.resolveComposition?.(element.ref);
    if (!child) continue;
    try {
      const runtime = build(child, addContainer());
      runtime.seek(posterTimeOf(child));
      runtimes.push(runtime);
    } catch {
      /* This element contributes nothing; the rest of the scene still draws. */
    }
  }

  const preview = (maxSize: number): HTMLElement => {
    const box = previewBox({ width, height }, maxSize);
    const big = doc.createElement('div');
    big.className = 'comp-thumb comp-preview';
    big.style.width = `${box.width}px`;
    big.style.height = `${box.height}px`;
    big.style.overflow = 'hidden';
    big.style.position = 'relative';

    const copy = host.cloneNode(true) as HTMLElement;
    const bigFit = fitStage({ width, height }, box);
    copy.style.transform = `translate(${bigFit.x}px, ${bigFit.y}px) scale(${bigFit.scale})`;
    big.appendChild(copy);
    return big;
  };

  return {
    element: wrapper,
    preview,
    destroy: () => {
      for (const runtime of runtimes) runtime.destroy();
      wrapper.remove();
    },
  };
}
