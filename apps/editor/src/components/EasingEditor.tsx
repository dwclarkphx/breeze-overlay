// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Easing editor — preset picker plus a draggable cubic-bezier curve.
 *
 * The curve is plotted with `sampleEase` from `@breeze/runtime`, the exact
 * function the timeline evaluates at playback. ROADMAP §4 Phase 3 asks for a
 * bezier-easing preview feeding a GSAP CustomEase at runtime; using one solver
 * for both is strictly better — there is no second implementation to drift.
 */

import { useMemo, useRef, useState, type JSX } from 'react';
import { sampleEase } from '@breeze/runtime';
import { NAMED_EASES, type CubicBezierEase, type Ease } from '@breeze/schema';

import { useEditor, type KeyframeRef } from '../state/store.js';
import { findLayer } from '../state/commands.js';

const SIZE = 260;
const PAD = 40;

/**
 * Visible y range, wider than the unit square.
 *
 * A control point's y is deliberately unclamped — that is what allows overshoot
 * and anticipation. But the graph used to map only 0..1 across its height, and
 * an SVG viewport clips whatever falls outside it, so a point like Anticipate's
 * first (y = -0.55) was placed at y=443 in a 340px box and simply vanished. The
 * handle was invisible, could not be pressed, and a press aimed at where it
 * should have been fell through to the backdrop and closed the dialog. Applying
 * an overshoot preset worked; adjusting one by hand was impossible.
 *
 * -0.6..1.6 covers both built-in overshoot presets (Anticipate reaches -0.55 and
 * 1.55) with a little room to drag past them. The unit square is consequently
 * drawn shorter than it is wide; `graph-bg` shades it so it stays legible as the
 * 0..1 box, with the overshoot margins visible above and below.
 */
const Y_MIN = -0.6;
const Y_MAX = 1.6;
const Y_SPAN = Y_MAX - Y_MIN;

/** Curves worth one click, since hand-dragging these every time is tedious. */
const BEZIER_PRESETS: Array<{ label: string; points: [number, number, number, number] }> = [
  { label: 'Ease', points: [0.25, 0.1, 0.25, 1] },
  { label: 'Ease in', points: [0.42, 0, 1, 1] },
  { label: 'Ease out', points: [0, 0, 0.58, 1] },
  { label: 'Ease in-out', points: [0.42, 0, 0.58, 1] },
  { label: 'Anticipate', points: [0.68, -0.55, 0.265, 1.55] },
  { label: 'Broadcast in', points: [0.16, 1, 0.3, 1] },
];

export function EasingEditor({
  target,
  onClose,
}: {
  target: KeyframeRef;
  onClose: () => void;
}): JSX.Element | null {
  const composition = useEditor((s) => s.composition);
  const run = useEditor((s) => s.run);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<0 | 1 | null>(null);

  const keyframe = useMemo(() => {
    if (!composition) return null;
    const layer = findLayer(composition.layers, target.layerId);
    return layer?.keyframes?.[target.prop]?.find((kf) => Math.abs(kf.t - target.time) < 1e-6) ?? null;
  }, [composition, target]);

  if (!keyframe) return null;

  const ease: Ease = keyframe.ease ?? 'none';
  const bezier: CubicBezierEase =
    typeof ease === 'object' && ease.type === 'cubicBezier'
      ? ease
      : { type: 'cubicBezier', points: [0.25, 0.1, 0.25, 1] };

  const setEase = (next: Ease) =>
    run({ kind: 'setKeyframeEase', layerId: target.layerId, prop: target.prop, time: target.time, ease: next });

  /* --------------------------------------------------------- geometry */

  const toSvg = (x: number, y: number) => ({
    x: PAD + x * SIZE,
    // y is inverted: progress 1 sits above progress 0, as in every easing
    // editor. The scale spans Y_MIN..Y_MAX rather than 0..1 so overshoot stays
    // inside the viewport — see the constants.
    y: PAD + ((Y_MAX - y) / Y_SPAN) * SIZE,
  });

  const fromSvg = (px: number, py: number) => ({
    x: (px - PAD) / SIZE,
    y: Y_MAX - ((py - PAD) / SIZE) * Y_SPAN,
  });

  const curvePath = useMemo(() => {
    const samples = sampleEase(ease, 64);
    return samples
      .map((v, i) => {
        const p = toSvg(i / (samples.length - 1), v);
        return `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`;
      })
      .join(' ');
  }, [ease]);

  const isBezier = typeof ease === 'object' && ease.type === 'cubicBezier';
  const [x1, y1, x2, y2] = bezier.points;
  const c1 = toSvg(x1, y1);
  const c2 = toSvg(x2, y2);

  /** The two corners of the unit square the curve actually runs between. */
  const origin = { bottom: toSvg(0, 0), top: toSvg(1, 1) };

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging === null || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const { x, y } = fromSvg(e.clientX - rect.left, e.clientY - rect.top);

    // x is clamped to 0..1 because a cubic-bezier timing function with a
    // control point outside that range is not a function of time. y is free to
    // leave 0..1 — that is what allows overshoot and anticipation — but is held
    // inside the drawn range, so a handle can never be dragged back out of the
    // viewport and lost.
    const clampedX = Math.min(1, Math.max(0, x));
    const clampedY = Math.min(Y_MAX, Math.max(Y_MIN, y));
    const points: [number, number, number, number] = [...bezier.points];
    if (dragging === 0) { points[0] = clampedX; points[1] = clampedY; }
    else { points[2] = clampedX; points[3] = clampedY; }

    setEase({ type: 'cubicBezier', points });
  };

  return (
    <div className="easing-overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="easing-dialog">
        <header>
          <span>Easing — {target.prop} @ {target.time.toFixed(3)}s</span>
          <button onClick={onClose}>✕</button>
        </header>

        <div className="easing-body">
          <svg
            ref={svgRef}
            className="easing-graph"
            width={SIZE + PAD * 2}
            height={SIZE + PAD * 2}
            onPointerMove={onPointerMove}
            onPointerUp={() => setDragging(null)}
            onPointerLeave={() => setDragging(null)}
          >
            {/*
              The shaded box is the unit square, not the whole graph — the area
              outside it is the overshoot margin. Anchors are derived from toSvg
              rather than written as PAD/SIZE corners, so they follow the y scale
              instead of silently disagreeing with the curve.
            */}
            <rect
              x={PAD}
              y={origin.top.y}
              width={SIZE}
              height={origin.bottom.y - origin.top.y}
              className="graph-bg"
            />
            <line
              x1={origin.bottom.x}
              y1={origin.bottom.y}
              x2={origin.top.x}
              y2={origin.top.y}
              className="graph-linear"
            />
            <path d={curvePath} className="graph-curve" />

            {isBezier && (
              <>
                <line x1={origin.bottom.x} y1={origin.bottom.y} x2={c1.x} y2={c1.y} className="handle-line" />
                <line x1={origin.top.x} y1={origin.top.y} x2={c2.x} y2={c2.y} className="handle-line" />
                <circle
                  cx={c1.x} cy={c1.y} r={7} className="handle"
                  onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(0); }}
                />
                <circle
                  cx={c2.x} cy={c2.y} r={7} className="handle"
                  onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(1); }}
                />
              </>
            )}
          </svg>

          <div className="easing-controls">
            <label>
              GSAP preset
              <select
                value={typeof ease === 'string' ? ease : ''}
                onChange={(e) => e.target.value && setEase(e.target.value)}
              >
                <option value="">— custom curve —</option>
                {NAMED_EASES.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>

            <div className="preset-grid">
              {BEZIER_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => setEase({ type: 'cubicBezier', points: preset.points })}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <label>
              Hold (stepped)
              <button onClick={() => setEase({ type: 'stepped', steps: 1 })}>
                Snap, no tween
              </button>
            </label>

            {isBezier && (
              <code className="bezier-readout">
                cubic-bezier({bezier.points.map((n) => n.toFixed(3)).join(', ')})
              </code>
            )}

            <p className="hint">
              Named GSAP eases preview as a straight line here — they are evaluated by
              GSAP at playback. Custom curves preview exactly.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
