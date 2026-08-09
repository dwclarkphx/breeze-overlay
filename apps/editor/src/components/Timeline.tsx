// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Timeline panel — Phase 3.
 *
 * One track per layer, one lane per animated property, a marker lane for STOP
 * markers, and a draggable playhead. All geometry comes from `timeline-math.ts`
 * so the arithmetic is unit-tested rather than trapped in event handlers.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { AnimatableProp, Layer } from '@breeze/schema';

import { useEditor, type KeyframeRef } from '../state/store.js';
import {
  clampView,
  fitView,
  formatTimecode,
  overflowHeight,
  moveLifetime,
  pxToTime,
  snapTime,
  ticks,
  timeToPx,
  trimIn,
  trimOut,
  zoomAround,
  type Lifetime,
  type SnapTarget,
  type TimelineView,
} from '../state/timeline-math.js';
import { EasingEditor } from './EasingEditor.js';

const LABEL_WIDTH = 180;

/**
 * Left gutter, wide enough that a keyframe diamond centered on t=0 sits fully
 * inside the track area rather than half-overlapping the layer names.
 */
const TRACK_INSET = 10;

/**
 * A lifetime bar never renders narrower than this. A layer whose window is a
 * fraction of a second at high zoom-out would otherwise be a sub-pixel target
 * that cannot be grabbed — precisely the case that stranded a layer added at
 * the end of the timeline.
 */
const MIN_LIFETIME_PX = 12;

/**
 * Below this width a lifetime bar renders no trim handles.
 *
 * The handles used to sit *outside* the bar and reach inwards, so on a short bar
 * they met in the middle and there was no pixel left that meant "move" — every
 * grab trimmed an edge and changed the layer's length. They now sit inside the
 * bar, and below this width they are dropped entirely so the whole bar stays a
 * move target. Trimming a sliver is a zoom-in away; being unable to move it at
 * all is what strands a layer.
 */
/**
 * Widest a trim handle gets — the coarse-pointer (touch) case in the stylesheet.
 * Sizing the threshold for the widest variant means the guarantee holds on a
 * tablet too, where a 6px target is unhittable and a mis-hit retimes a graphic.
 * The handle widths themselves live in CSS so the media query can own them.
 */
const TRIM_HANDLE_PX = 12;
const MIN_TRIMMABLE_PX = TRIM_HANDLE_PX * 2 + 10;

const round = (n: number) => Math.round(n * 1000) / 1000;

export interface TimelineProps {
  /**
   * Ask the shell to make the timeline panel this much taller, in px.
   *
   * Fit needs it: the panel height is App state (it is a draggable splitter and
   * it persists), and "fit every row" is not achievable from inside the panel.
   * The shell clamps the request against the layout limits, so a composition
   * with more rows than the maximum height can show simply grows as far as it
   * can and keeps its scrollbar — which is the honest outcome.
   */
  onGrow?: (extraPx: number) => void;
}

export function Timeline({ onGrow }: TimelineProps = {}): JSX.Element {
  const composition = useEditor((s) => s.composition);
  const playhead = useEditor((s) => s.playhead);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const playing = useEditor((s) => s.playing);
  const setPlaying = useEditor((s) => s.setPlaying);
  const honourHolds = useEditor((s) => s.honourHolds);
  const setHonourHolds = useEditor((s) => s.setHonourHolds);
  const selectedLayerIds = useEditor((s) => s.selectedLayerIds);
  const selectLayers = useEditor((s) => s.selectLayers);
  const selectedKeyframes = useEditor((s) => s.selectedKeyframes);
  const selectKeyframes = useEditor((s) => s.selectKeyframes);
  const run = useEditor((s) => s.run);

  /**
   * The track column, in state rather than a ref.
   *
   * The observer below was attached in a `[]` effect against a ref, and this
   * component renders "—" until a project loads over the API. So on first mount
   * there was no track column to observe, the effect never ran again, and the
   * view kept its placeholder 900px width for the life of the session. Nothing
   * looked broken — timeToPx draws and hit-tests through the same number, so
   * content stays self-consistent — but everything derived from the *width* was
   * wrong: Fit scaled the composition to 900px rather than the panel, and
   * clampView bounded scrolling by a viewport that did not exist. On a tablet
   * panel of 400px, Fit fitted nothing.
   */
  const [trackEl, setTrackEl] = useState<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<TimelineView>({
    start: 0,
    pxPerSecond: 240,
    width: 900,
    inset: TRACK_INSET,
  });
  const [easingTarget, setEasingTarget] = useState<KeyframeRef | null>(null);

  // Keep the view width in step with the panel so ticks span the full area.
  useEffect(() => {
    if (!trackEl) return;
    const measure = () => setView((v) => ({ ...v, width: trackEl.clientWidth }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(trackEl);
    return () => observer.disconnect();
  }, [trackEl]);

  const fps = composition?.stage.fps ?? 60;
  const duration = composition?.duration ?? 5;

  /**
   * The rows the timeline draws, tables expanded into their cells.
   *
   * A cell is a layer and carries keyframe tracks the runtime plays, so it
   * needs lanes here — that is the whole point of surfacing cells at all. It is
   * not a layer *on the stage*, though, and the difference shows up as one
   * missing control: no lifetime bar.
   *
   * `in`/`out` are simply not read for cells. `fillCellTrack` builds a cell's
   * motion from `layerMotion(cell)`, which is keyframes only — there is no
   * lifetime window in a cell's world because a cell's clock starts when its
   * row arrives and ends when the row leaves. Drawing a draggable bar would
   * offer to edit a number the runtime never reads, and the author would find
   * out only on air.
   */
  const rows = useMemo(() => {
    const out: Array<{ layer: Layer; isCell: boolean }> = [];
    for (const layer of composition?.layers ?? []) {
      out.push({ layer, isCell: false });
      if (layer.type === 'table') {
        for (const cell of layer.row.cells) out.push({ layer: cell, isCell: true });
      }
    }
    return out;
  }, [composition]);

  /** Everything a dragged keyframe or marker can snap to. */
  const snapTargets = useMemo<SnapTarget[]>(() => {
    if (!composition) return [];
    const out: SnapTarget[] = [
      { time: 0, source: 'start' },
      { time: duration, source: 'end' },
      { time: playhead, source: 'playhead' },
    ];
    for (const marker of composition.markers ?? []) out.push({ time: marker.time, source: 'marker' });
    for (const layer of composition.layers) {
      for (const track of Object.values(layer.keyframes ?? {})) {
        for (const kf of track ?? []) out.push({ time: kf.t, source: 'keyframe' });
      }
    }
    return out;
  }, [composition, duration, playhead]);

  /**
   * Both handles on the same node: the state copy drives the resize effect, the
   * ref keeps `localX` (and everything memoised on it) stable across renders.
   */
  const attachTrack = useCallback((el: HTMLDivElement | null) => {
    trackRef.current = el;
    setTrackEl(el);
  }, []);

  /* ------------------------------------------------------------------ fit */

  /**
   * The scrollport. Both scrollbars live on `.timeline-body`, so this is the
   * element that has to be asked whether either of them is needed.
   */
  const bodyRef = useRef<HTMLDivElement | null>(null);

  /**
   * Bumped by Fit; the layout effect below does the actual work.
   *
   * Fit cannot finish in its own click handler. Removing the vertical scrollbar
   * gives the track column roughly 15px more width, and the horizontal scale
   * has to be computed from the width that *results* — computing it from the
   * width measured while the scrollbar was still there is what left the
   * composition overhanging the right edge and put a horizontal scrollbar under
   * it. So: grow the panel, let the browser lay out, then measure and scale.
   */
  const [fitNonce, setFitNonce] = useState(0);

  const requestFit = useCallback(() => {
    const body = bodyRef.current;
    if (body && onGrow) {
      const extra = overflowHeight(body.scrollHeight, body.clientHeight);
      if (extra > 0) onGrow(extra);
    }
    setFitNonce((n) => n + 1);
  }, [onGrow]);

  useLayoutEffect(() => {
    if (fitNonce === 0) return;
    const el = trackRef.current;
    if (!el) return;
    /*
     * Re-measured here rather than trusting `view.width`. The ResizeObserver
     * will deliver the new width too, but on its own schedule — a frame in
     * which the scale is fitted to the old width and the column already has the
     * new one is a frame with a scrollbar in it.
     */
    setView((v) => clampView(fitView(v, duration, el.clientWidth), duration));
    // `duration` is intentionally a dependency: fitting is defined against it.
  }, [fitNonce, duration]);

  const localX = useCallback((clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    return clientX - (rect?.left ?? 0);
  }, []);

  const scrubTo = useCallback(
    (clientX: number) => {
      const time = Math.max(0, pxToTime(view, localX(clientX)));
      setPlayhead(Math.min(time, duration));
    },
    [view, localX, setPlayhead, duration],
  );

  /* ------------------------------------------------------- interactions */

  const onRulerPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setPlaying(false);
    scrubTo(e.clientX);
  };

  const onRulerPointerMove = (e: React.PointerEvent) => {
    if (e.buttons !== 1) return;
    scrubTo(e.clientX);
  };

  // Every view change goes through clampView, so nothing can scroll before 0
  // or past the end of the composition.
  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setView((v) => clampView(zoomAround(v, localX(e.clientX), e.deltaY < 0 ? 1.15 : 1 / 1.15), duration));
    } else if (e.shiftKey) {
      e.preventDefault();
      setView((v) => clampView({ ...v, start: v.start + e.deltaY / v.pxPerSecond }, duration));
    }
  };

  const dragging = useRef<{
    ref: KeyframeRef;
    originalTime: number;
    /** The lane element, which holds the pointer capture. See below. */
    lane: HTMLElement | null;
    captured: boolean;
  } | null>(null);

  const onKeyframePointerDown = (e: React.PointerEvent, ref: KeyframeRef) => {
    e.stopPropagation();

    const alreadySelected = selectedKeyframes.some(
      (k) => k.layerId === ref.layerId && k.prop === ref.prop && Math.abs(k.time - ref.time) < 1e-6,
    );
    if (e.shiftKey) selectKeyframes([...selectedKeyframes, ref]);
    else if (!alreadySelected) selectKeyframes([ref]);

    /*
     * Capture is deliberately NOT taken here — see onKeyframePointerMove.
     *
     * The lane is resolved now, though, because by the time the first move
     * arrives the diamond that was pressed may already have been replaced.
     */
    dragging.current = {
      ref,
      originalTime: ref.time,
      lane: (e.currentTarget as HTMLElement).closest('.keyframe-lane'),
      captured: false,
    };
  };

  const onKeyframePointerMove = (e: React.PointerEvent) => {
    const drag = dragging.current;
    if (!drag || e.buttons !== 1) return;

    /*
     * Capture the lane, on the first real move rather than on pointer-down.
     *
     * Two constraints meet here. A keyframe's React key is its time, so the
     * first move of a drag unmounts the diamond under the pointer and mounts a
     * new one — capture taken on that node dies with it, and the rest of the
     * gesture went wherever the cursor happened to be. A keyframe therefore
     * moved exactly once and then froze, however far the pointer traveled. The
     * lane is keyed by property and outlives the gesture, so it is the thing to
     * capture.
     *
     * But capturing on pointer-down retargets the following pointerup to the
     * lane, and the browser derives click and dblclick from those targets — so
     * the diamond stopped receiving the double-click that opens the easing
     * editor. Deferring until the pointer has actually moved keeps a stationary
     * press a plain click, and a press that moves a drag.
     */
    if (!drag.captured) {
      (drag.lane ?? (e.currentTarget as HTMLElement)).setPointerCapture(e.pointerId);
      drag.captured = true;
    }

    const raw = pxToTime(view, localX(e.clientX));
    // Exclude the keyframe being dragged from its own snap targets, or it
    // sticks to where it started and refuses to move.
    const targets = snapTargets.filter((t) => Math.abs(t.time - drag.ref.time) > 1e-6);
    const { time } = snapTime(raw, targets, view, fps);

    if (Math.abs(time - drag.ref.time) < 1e-9) return;
    run({ kind: 'moveKeyframe', layerId: drag.ref.layerId, prop: drag.ref.prop, from: drag.ref.time, to: time });
    dragging.current = { ...drag, ref: { ...drag.ref, time } };
    selectKeyframes([{ ...drag.ref, time }]);
  };

  const onKeyframePointerUp = () => {
    dragging.current = null;
  };

  const markerDrag = useRef<number | null>(null);

  /* ------------------------------------------------------ layer lifetimes */

  interface BarDrag {
    layerId: string;
    mode: 'move' | 'in' | 'out';
    /** Time under the pointer when the gesture began. */
    grabbedAt: number;
    start: Lifetime;
    /**
     * True once this gesture has written at least one patch.
     *
     * Distinguishes "this gesture has not moved the layer" from "this gesture
     * moved the layer and has come back to where it started". Both compute a
     * zero delta against `start`, but only the first should be ignored — the
     * second has to be dispatched to undo the moves already applied.
     */
    applied: boolean;
  }

  const barDrag = useRef<BarDrag | null>(null);

  const beginBarDrag = (
    e: React.PointerEvent,
    layer: Layer,
    mode: BarDrag['mode'],
  ) => {
    // Without this the row's click handler also fires and the ruler scrubs.
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    selectLayers([layer.id]);

    barDrag.current = {
      layerId: layer.id,
      mode,
      grabbedAt: pxToTime(view, localX(e.clientX)),
      start: { in: layer.in ?? 0, out: layer.out },
      applied: false,
    };
  };

  const onBarPointerMove = (e: React.PointerEvent) => {
    const drag = barDrag.current;
    if (!drag || e.buttons !== 1) return;

    const pointerTime = pxToTime(view, localX(e.clientX));

    // Exclude the edge being dragged from its own snap targets, or it sticks
    // where it started and refuses to move.
    const exclude = drag.mode === 'out' ? drag.start.out : drag.start.in;
    const targets = snapTargets.filter(
      (t) => exclude === undefined || Math.abs(t.time - exclude) > 1e-6,
    );

    let next: Lifetime;
    if (drag.mode === 'move') {
      const { time } = snapTime(
        drag.start.in + (pointerTime - drag.grabbedAt),
        targets,
        view,
        fps,
      );
      // `duration` resolves an open-ended window so both edges travel together.
      // Without it the right edge stays pinned to the end of the composition and
      // a move silently becomes a stretch — which, since layers are created
      // without an explicit out-point, was what nearly every drag did.
      next = moveLifetime(drag.start, time - drag.start.in, duration);
      /*
       * moveLifetime hands back the original window when the move clamped to
       * nothing. Skipping the dispatch is right only while the gesture has not
       * written anything yet — otherwise a click with a bit of jitter in it
       * would materialise an out-point on a layer that never moved.
       *
       * Once the gesture *has* written, the same zero delta means the opposite:
       * the pointer has traveled out and come back, and the document is still
       * holding the last position it was dragged to. That has to be dispatched,
       * or the bar stays where it was and the only way to recover the original
       * window is to release and drag again — which is exactly what was
       * reported. A layer with no out-point is the case that shows it, because
       * it already ends at the composition end and so cannot be dragged right
       * past its origin to correct itself.
       */
      if (next === drag.start && !drag.applied) return;
    } else if (drag.mode === 'in') {
      const { time } = snapTime(pointerTime, targets, view, fps);
      next = trimIn(drag.start, time, fps, duration);
    } else {
      const { time } = snapTime(pointerTime, targets, view, fps);
      next = trimOut(drag.start, time, fps, duration);
    }

    // A plain layer patch: `in`/`out` are not animatable. The coalescing key is
    // stable for the gesture, so the whole drag is one undo step.
    run({
      kind: 'patchLayer',
      layerId: drag.layerId,
      patch: { in: round(next.in), out: next.out === undefined ? undefined : round(next.out) },
    });
    drag.applied = true;
  };

  const endBarDrag = () => {
    barDrag.current = null;
  };

  /* ------------------------------------------------------------ render */

  if (!composition) return <div className="panel-empty">—</div>;

  const tickTimes = ticks(view);
  const playheadPx = timeToPx(view, playhead);

  const propLanes = (layer: Layer): AnimatableProp[] =>
    Object.keys(layer.keyframes ?? {}) as AnimatableProp[];

  return (
    <div className="panel timeline-panel" onWheel={onWheel}>
      <div className="timeline-toolbar">
        <button onClick={() => setPlaying(!playing)} title={playing ? 'Pause' : 'Play preview'}>
          {playing ? '⏸' : '▶'}
        </button>
        <button onClick={() => { setPlaying(false); setPlayhead(0); }} title="Go to start">⏮</button>
        <label
          className="toggle"
          title="Pause at STOP markers, as the graphic will on air. Off, the preview runs end to end."
        >
          <input
            type="checkbox"
            checked={honourHolds}
            onChange={(e) => setHonourHolds(e.target.checked)}
          />
          Holds
        </label>
        <span className="timecode">{formatTimecode(playhead, fps)}</span>
        <button
          onClick={() => run({ kind: 'addMarker', marker: { type: 'stop', time: playhead } })}
          title="Add a STOP marker at the playhead — where the graphic holds on air"
        >
          + STOP
        </button>
        <span className="spacer" />
        <button
          onClick={() => setView((v) => clampView(zoomAround(v, v.width / 2, 1 / 1.4), duration))}
          title="Zoom out"
        >−</button>
        <button
          onClick={() => setView((v) => clampView(zoomAround(v, v.width / 2, 1.4), duration))}
          title="Zoom in"
        >+</button>
        <button
          onClick={requestFit}
          /*
            Title left exactly as it was. Six e2e locators address toolbar
            buttons by their exact `title`, so this string is a test contract as
            well as a tooltip — enriching the wording to describe the new
            behavior broke the Fit test and nothing else, which is the worst
            kind of failure to read. What Fit now does is explained in the user
            guide, not in a hover.
          */
          title="Fit the whole composition"
        >Fit</button>
      </div>

      <div className="timeline-body" ref={bodyRef}>
        <div className="timeline-labels" style={{ width: LABEL_WIDTH }}>
          {/*
            One label row per track row, in the same order and at the same
            heights, or the two columns drift apart. The head pairs with the
            ruler and the "Markers" row with the marker lane — previously the
            head carried the "Markers" caption and the marker lane had no
            counterpart at all, so every layer sat 22px below its own name.
          */}
          <div className="timeline-label-head" aria-hidden="true" />
          <div className="timeline-label marker-label">Markers</div>
          {rows.map(({ layer, isCell }) => (
            <div key={layer.id}>
              <div
                className={`timeline-label${isCell ? ' cell' : ''}${selectedLayerIds.includes(layer.id) ? ' selected' : ''}`}
                onClick={() => selectLayers([layer.id])}
                title={isCell ? `Row-template cell${layer.cell ? ` — column ${layer.cell}` : ''}` : undefined}
              >
                {layer.name ?? layer.id}
                {isCell && layer.cell ? <span className="label-cell-key">{layer.cell}</span> : null}
              </div>
              {propLanes(layer).map((prop) => (
                <div key={prop} className="timeline-label lane">{prop}</div>
              ))}
            </div>
          ))}
        </div>

        <div className="timeline-tracks" ref={attachTrack}>
          <div
            className="timeline-ruler"
            onPointerDown={onRulerPointerDown}
            onPointerMove={onRulerPointerMove}
          >
            {tickTimes.map((t) => (
              <div key={t} className="tick" style={{ left: timeToPx(view, t) }}>
                <span>{t.toFixed(t < 1 ? 2 : 2)}s</span>
              </div>
            ))}
          </div>

          {/* Marker lane */}
          <div className="timeline-row marker-lane">
            {(composition.markers ?? []).map((marker, index) => (
              <div
                key={`${marker.type}-${index}`}
                className={`marker ${marker.type}`}
                style={{ left: timeToPx(view, marker.time) }}
                title={`${marker.type} @ ${marker.time.toFixed(3)}s — double-click to delete`}
                onPointerDown={(e) => {
                  (e.target as HTMLElement).setPointerCapture(e.pointerId);
                  markerDrag.current = index;
                }}
                onPointerMove={(e) => {
                  if (markerDrag.current === null || e.buttons !== 1) return;
                  const { time } = snapTime(pxToTime(view, localX(e.clientX)), snapTargets, view, fps);
                  run({ kind: 'moveMarker', index: markerDrag.current, time });
                }}
                onPointerUp={() => { markerDrag.current = null; }}
                onDoubleClick={() => run({ kind: 'deleteMarker', index })}
              />
            ))}
          </div>

          {rows.map(({ layer, isCell }) => (
            <div key={layer.id}>
              <div
                className={`timeline-row layer-row${isCell ? ' cell-row' : ''}${selectedLayerIds.includes(layer.id) ? ' selected' : ''}`}
                onClick={() => selectLayers([layer.id])}
              >
                {/*
                  Lifetime bar: where the layer exists at all. Draggable to
                  move the whole window, with edge handles to trim in and out
                  independently. A layer added while the playhead sat near the
                  end used to be stranded there — its bar was a sliver with no
                  way to move it, and the only route back was the properties
                  panel or deleting the layer.

                  Cells have none: see the `rows` memo above. Their clock is
                  their row's arrival, and `in`/`out` are never read for them.
                */}
                {isCell ? null : (() => {
                  const barWidth = Math.max(
                    MIN_LIFETIME_PX,
                    timeToPx(view, layer.out ?? duration) - timeToPx(view, layer.in ?? 0),
                  );
                  const trimmable = barWidth >= MIN_TRIMMABLE_PX;
                  return (
                    <div
                      className="lifetime"
                      data-trimmable={trimmable ? '1' : '0'}
                      title={
                        `${(layer.in ?? 0).toFixed(2)}s → ${layer.out?.toFixed(2) ?? 'end'} — drag to move` +
                        (trimmable ? ', edges to trim' : ' (zoom in to trim)')
                      }
                      style={{
                        left: timeToPx(view, layer.in ?? 0),
                        width: barWidth,
                      }}
                      onPointerDown={(e) => beginBarDrag(e, layer, 'move')}
                      onPointerMove={onBarPointerMove}
                      onPointerUp={endBarDrag}
                    >
                      {trimmable && (
                        <>
                          <span
                            className="trim trim-in"
                            onPointerDown={(e) => beginBarDrag(e, layer, 'in')}
                            onPointerMove={onBarPointerMove}
                            onPointerUp={endBarDrag}
                          />
                          <span
                            className="trim trim-out"
                            onPointerDown={(e) => beginBarDrag(e, layer, 'out')}
                            onPointerMove={onBarPointerMove}
                            onPointerUp={endBarDrag}
                          />
                        </>
                      )}
                    </div>
                  );
                })()}
              </div>

              {propLanes(layer).map((prop) => (
                // Move and up live on the lane because that is what holds the
                // pointer capture — see onKeyframePointerDown.
                <div
                  key={prop}
                  className="timeline-row keyframe-lane"
                  onPointerMove={onKeyframePointerMove}
                  onPointerUp={onKeyframePointerUp}
                >
                  {(layer.keyframes?.[prop] ?? []).map((kf) => {
                    const isSelected = selectedKeyframes.some(
                      (k) => k.layerId === layer.id && k.prop === prop && Math.abs(k.time - kf.t) < 1e-6,
                    );
                    const ref: KeyframeRef = { layerId: layer.id, prop, time: kf.t };
                    return (
                      <div
                        key={kf.t}
                        className={`keyframe${isSelected ? ' selected' : ''}`}
                        style={{ left: timeToPx(view, kf.t) }}
                        title={`${prop} = ${kf.v} @ ${kf.t.toFixed(3)}s\ndouble-click to edit easing`}
                        onPointerDown={(e) => onKeyframePointerDown(e, ref)}
                        onDoubleClick={() => setEasingTarget(ref)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          ))}

          {/*
            The head is its own sticky element rather than a ::before on the
            line. Drawn at the top of the *content*, it scrolled away with the
            first layer row while the ruler — which is sticky — stayed put, so
            past a few layers the time axis had a line crossing it and no marker
            saying which line. Sticky inside the full-height line pins it to the
            top of .timeline-body, the same scrollport the ruler anchors to.
          */}
          <div className="playhead" style={{ left: playheadPx }}>
            <span className="playhead-head" />
          </div>
        </div>
      </div>

      {easingTarget && (
        <EasingEditor target={easingTarget} onClose={() => setEasingTarget(null)} />
      )}
    </div>
  );
}
