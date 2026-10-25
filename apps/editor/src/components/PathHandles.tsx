// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The on-stage bezier surface (MASKS.md §5.1, D′) — anchors, handles and the
 * hairlines joining them, drawn over the selected layer's path and dragged in
 * place.
 *
 * Every number here comes from `state/path-overlay.ts`; this file is pointer
 * events and SVG. It sits inside `.stage-transform` beside `.stage-guides`, so
 * it draws in stage pixels and the stage zoom scales it for free — handle sizes
 * are divided by the zoom to stay a constant size on screen.
 *
 * **It is not Moveable, and does not share Moveable's hazards.** Moveable
 * measures the layer element and must not see it rebuilt or rewritten
 * mid-gesture. This measures the layer once, at pointer-down, through a probe
 * of its own, and from then on works only in path space — so a preview rebuild
 * during a drag replaces the element under it and changes nothing here. The
 * gesture therefore does not suspend rebuilds, and the path the runtime draws
 * catches up whenever the pointer pauses; in between, `d` is written straight
 * onto the drawn `<path>`, which no animation owns (GSAP drives the layer's
 * transform, never its geometry).
 *
 * The four rules the stage learned the hard way, applied:
 * - pointer capture goes on this overlay's root, which outlives every handle
 *   (they are re-rendered on every move), and only on the first move — so a
 *   double-click on an anchor still reaches the anchor;
 * - every move dispatches, including one that lands back on the start;
 * - the overlay is pointer-transparent except for its own marks, so Moveable's
 *   drag area under it keeps working for moving the whole layer;
 * - `e2e/path-handles.spec.ts` asserts mid-gesture, not only the end.
 */

import { useEffect, useRef, useState, type JSX } from 'react';
import type { Layer } from '@breeze/schema';
import { useT } from '@breeze/i18n/react';

import { useEditor } from '../state/store.js';
import { parsePath, serializePath, type EditablePath } from '../state/path-geometry.js';
import {
  beginPathDrag,
  dragPathTo,
  insertOnSegment,
  layerToStage,
  overlayModel,
  pathPatch,
  removeAnchor,
  toggleSmooth,
  type Affine,
  type Grab,
  type PathDrag,
  type PathTarget,
} from '../state/path-overlay.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A DOMMatrix (or SVGMatrix) as the plain affine the pure module takes. */
function affine(m: DOMMatrix | SVGMatrix | null | undefined): Affine | null {
  return m ? { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f } : null;
}

function same(a: Affine | null, b: Affine | null): boolean {
  if (!a || !b) return a === b;
  return (
    Math.abs(a.a - b.a) < 1e-6 && Math.abs(a.b - b.b) < 1e-6 && Math.abs(a.c - b.c) < 1e-6 &&
    Math.abs(a.d - b.d) < 1e-6 && Math.abs(a.e - b.e) < 1e-3 && Math.abs(a.f - b.f) < 1e-3
  );
}

/**
 * Write `d` onto the path the runtime drew, for feedback during a drag.
 *
 * The shape's own `<path>`, or the `<path>` inside the mask the layer's
 * `mask-image` points at. Both are replaced by the next rebuild with the same
 * value from the document, so this can never leave the preview disagreeing
 * with what was saved.
 */
function paintLive(target: HTMLElement, kind: PathTarget['kind'], d: string): void {
  if (kind === 'shape') {
    target.querySelector('svg.bz-path > path')?.setAttribute('d', d); // i18n-ignore — CSS selector
    return;
  }
  const ref = /url\(["']?#([^"')]+)["']?\)/.exec(target.style.getPropertyValue('mask-image'))?.[1];
  if (ref) target.ownerDocument.getElementById(ref)?.querySelector('path')?.setAttribute('d', d);
}

export function PathHandles({
  layer,
  target,
  edit,
  zoom,
  stage,
  measureKey,
}: {
  layer: Layer;
  /** The selected layer's `.bz-layer` element. */
  target: HTMLElement;
  edit: PathTarget;
  zoom: number;
  stage: { width: number; height: number };
  /** Changes whenever the layer may have moved on the stage: playhead, rebuild, edit. */
  measureKey: string;
}): JSX.Element | null {
  const t = useT();
  const run = useEditor((s) => s.run);
  const rootRef = useRef<SVGSVGElement>(null);
  const probeRef = useRef<SVGSVGElement | null>(null);
  const [toStage, setToStage] = useState<Affine | null>(null);

  /*
   * A zero-size `<svg>` at the layer box's origin, inside the layer element.
   * No viewBox, so its user space *is* layer space — the space a path shape's
   * own `<svg>` and a `userSpaceOnUse` mask both resolve in — and its screen
   * CTM therefore carries the layer's whole transform. A probe of our own
   * rather than the shape's `<svg>`, because a path *mask* can sit on any layer
   * type, most of which have no `<svg>` to ask.
   */
  useEffect(() => {
    const probe = target.ownerDocument.createElementNS(SVG_NS, 'svg');
    probe.setAttribute('class', 'bz-editor-probe');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none'; // dir-ok — layer space's origin is the box's top-left by definition
    target.appendChild(probe);
    probeRef.current = probe;
    return () => {
      probe.remove();
      if (probeRef.current === probe) probeRef.current = null;
    };
  }, [target]);

  /*
   * Layer → stage, re-measured whenever the layer may have moved.
   *
   * On the next frame rather than in the effect: this component's effects run
   * before its parent's, and the parent's effect is the one that seeks the
   * runtime to the playhead. Measured in the effect, the handles drew where
   * the layer was one scrub ago.
   */
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const probe = probeRef.current;
      const root = rootRef.current;
      const next = layerToStage(affine(probe?.getScreenCTM()), affine(root?.getScreenCTM()));
      setToStage((prev) => (same(prev, next) ? prev : next));
    });
    return () => cancelAnimationFrame(frame);
  }, [target, measureKey, zoom]);

  const drag = useRef<(PathDrag & { pointerId: number; captured: boolean }) | null>(null);
  const [dragging, setDragging] = useState(false);

  const path = parsePath(edit.d);
  if (!path) return null;

  const write = (next: EditablePath) => {
    const d = serializePath(next);
    paintLive(target, edit.kind, d);
    run({ kind: 'patchLayer', layerId: layer.id, patch: pathPatch(layer, edit.kind, d) });
  };

  const layerToScreen = (): Affine | null => affine(probeRef.current?.getScreenCTM());

  const onPartDown = (grab: Grab) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Ours, not the stage's: no deselect, no Alt-pan, no Moveable drag.
    e.stopPropagation();
    e.preventDefault();

    if (grab.part === 'anchor' && e.altKey) {
      write(removeAnchor(path, grab.index));
      return;
    }

    const m = layerToScreen();
    const begun = m && beginPathDrag(path, grab, edit.offset, m, { x: e.clientX, y: e.clientY });
    if (!begun) return;
    drag.current = { ...begun, pointerId: e.pointerId, captured: false };
    setDragging(true);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    /*
     * Captured on the first move, and on the root: a handle is re-rendered on
     * every move, so capture taken on it could die with it — the keyframe
     * diamond froze after one step that way — and capturing on pointer-down
     * would retarget the pointerup and kill the anchor's double-click.
     */
    if (!d.captured) {
      rootRef.current?.setPointerCapture(e.pointerId);
      d.captured = true;
    }
    // No "nothing changed" guard: a move back onto the start must still land.
    write(dragPathTo(d, { x: e.clientX, y: e.clientY }));
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.captured && rootRef.current?.hasPointerCapture(e.pointerId)) {
      rootRef.current.releasePointerCapture(e.pointerId);
    }
    drag.current = null;
    setDragging(false);
  };

  const onAnchorDouble = (index: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    write(toggleSmooth(path, index));
  };

  const onSegmentDouble = (after: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    const m = layerToScreen();
    if (m) write(insertOnSegment(path, after, edit.offset, m, { x: e.clientX, y: e.clientY }));
  };

  const model = toStage ? overlayModel(path, edit.offset, toStage) : null;
  // Constant on screen whatever the zoom.
  const px = (n: number) => n / zoom;

  return (
    <svg
      ref={rootRef}
      className="path-handles"
      data-kind={edit.kind}
      data-dragging={dragging ? '1' : undefined}
      width={stage.width}
      height={stage.height}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {model && (
        <>
          {model.straight.map((s) => (
            <line
              key={`seg-${s.after}`}
              className="path-segment"
              data-after={s.after}
              x1={s.from.x}
              y1={s.from.y}
              x2={s.to.x}
              y2={s.to.y}
              strokeWidth={px(10)}
              onDoubleClick={onSegmentDouble(s.after)}
            >
              <title>{t('editor.stage.pathSegment')}</title>
            </line>
          ))}
          {model.anchors.map((a) => (
            <g key={a.index}>
              {(['in', 'out'] as const).map((part) => {
                const h = a[part];
                if (!h) return null;
                return (
                  <g key={part}>
                    <line className="path-arm" x1={a.at.x} y1={a.at.y} x2={h.x} y2={h.y} strokeWidth={px(1)} />
                    <circle
                      className="path-handle"
                      data-index={a.index}
                      data-part={part}
                      cx={h.x}
                      cy={h.y}
                      r={px(4.5)}
                      strokeWidth={px(1.5)}
                      onPointerDown={onPartDown({ part, index: a.index })}
                    >
                      <title>{t('editor.stage.pathHandle')}</title>
                    </circle>
                  </g>
                );
              })}
              <rect
                className="path-anchor"
                data-index={a.index}
                data-smooth={a.smooth ? '1' : undefined}
                x={a.at.x - px(5)}
                y={a.at.y - px(5)}
                width={px(10)}
                height={px(10)}
                strokeWidth={px(1.5)}
                onPointerDown={onPartDown({ part: 'anchor', index: a.index })}
                onDoubleClick={onAnchorDouble(a.index)}
              >
                <title>
                  {t('editor.stage.pathAnchor', { index: a.index + 1, smooth: a.smooth ? 'yes' : 'no' })}
                </title>
              </rect>
            </g>
          ))}
        </>
      )}
    </svg>
  );
}
