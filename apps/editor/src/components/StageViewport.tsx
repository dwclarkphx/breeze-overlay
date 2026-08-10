// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Stage viewport — the live preview and the direct-manipulation surface.
 *
 * The preview is an actual `BreezeRuntime`, not a re-implementation. This is
 * the project's first rule: the editor preview *is* the playout renderer, which
 * is the only way to guarantee what the operator builds is what goes to air.
 *
 * The runtime is rebuilt when the document changes and seeked when only the
 * playhead moves. Rebuilding is debounced because constructing a GSAP timeline
 * on every keystroke would make property fields feel like treacle.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import Moveable, { type OnDrag, type OnResize, type OnRotate } from 'react-moveable';
import { BreezeRuntime } from '@breeze/runtime';
import { DATA_UPDATE_KEY, type Composition, type Layer } from '@breeze/schema';

import { useEditor } from '../state/store.js';
import { findLayer, isCell } from '../state/commands.js';
import {
  canvasFitsGuides,
  clampZoom,
  distance,
  fitZoom,
  midpoint,
  stageWantsGuides,
  zoomAtPoint,
  MIN_GUIDE_CANVAS_WIDTH,
  TAP_SLOP_PX,
  type Point,
} from '../state/stage-math.js';

const REBUILD_DEBOUNCE_MS = 60;

/** Breathing room between the stage and the edge of the canvas when fitted. */
const FIT_PADDING_PX = 24;

/** Broadcast title/action safe areas, as fractions of the stage. */
const SAFE_AREAS = [
  { label: 'action safe', inset: 0.035 },
  { label: 'title safe', inset: 0.1 },
];

export function StageViewport(): JSX.Element {
  const composition = useEditor((s) => s.composition);
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const selectedLayerIds = useEditor((s) => s.selectedLayerIds);
  const selectLayers = useEditor((s) => s.selectLayers);
  const run = useEditor((s) => s.run);
  /*
   * A counter, not the datasets themselves. Selecting the object would give a
   * new reference on every poll and rebuild the preview every five seconds; the
   * store only advances this when the rows genuinely differ.
   */
  const datasetRevision = useEditor((s) => s.datasetRevision);

  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<BreezeRuntime | null>(null);
  const moveableRef = useRef<Moveable>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showGuides, setShowGuides] = useState(true);
  const [target, setTarget] = useState<HTMLElement | null>(null);

  /* ------------------------------------------------------------- zoom */

  /**
   * Measured size of the canvas, and the fit derived from it.
   *
   * The zoom was previously a hardcoded 0.45 for both the initial value and the
   * Fit button, which assumes a desktop-sized panel. On a tablet — or any narrow
   * window, or a rotation from landscape to portrait — a 1920×1080 stage at 45%
   * is far wider than the panel, so the preview was cropped on both sides and
   * Fit returned it to the same cropped state. The stage now scales to whatever
   * space it actually has.
   */
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  /**
   * The canvas element itself, in state rather than a ref.
   *
   * A ref plus a mount effect does not work here and shipped broken: this
   * component returns "No composition loaded" until the project arrives over the
   * API, so on first mount there is no canvas to observe. A `[]` effect runs
   * exactly then, finds `null`, and never runs again — the canvas was never
   * measured, `fitZoom` had a zero-size box to work from, and the zoom sat on its
   * 0.45 fallback forever. Which is to say the tablet fix was inert, and looked
   * exactly like the bug it was fixing.
   *
   * A callback ref re-renders when the node appears, so the effect below is keyed
   * on the element and attaches the moment there is something to attach to.
   */
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);

  /**
   * The operator's zoom, or null for "follow the fit".
   *
   * Two states, not one: a device rotation must re-fit a viewport nobody has
   * touched, and must NOT throw away a zoom somebody chose deliberately. A
   * single number cannot distinguish them, so an auto-fit on resize would either
   * never happen or silently undo the operator's own zoom mid-edit.
   */
  const [userZoom, setUserZoom] = useState<number | null>(null);

  useEffect(() => {
    if (!canvasEl) return;
    const measure = () =>
      setCanvasSize({ width: canvasEl.clientWidth, height: canvasEl.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvasEl);
    return () => observer.disconnect();
  }, [canvasEl]);

  const stageSize = composition
    ? { width: composition.stage.width, height: composition.stage.height }
    : { width: 0, height: 0 };

  const fitted = fitZoom(canvasSize, stageSize, FIT_PADDING_PX);
  // `fitted` is null until the canvas has been measured; falling back to the old
  // 0.45 for that single frame avoids a zero-scale flash on first paint.
  const zoom = userZoom ?? fitted ?? 0.45;

  /*
   * Guides switch themselves off in a narrow pane.
   *
   * Derived rather than written back into `showGuides`, deliberately: the
   * checkbox holds what the operator *asked for*, and squeezing the panel
   * should not silently discard that. Widen it again and the guides come back
   * on their own, which is the behavior you want when the cause is usually a
   * splitter drag rather than a decision.
   */
  const guidesFit = canvasFitsGuides(canvasSize);
  const guidesVisible = showGuides && guidesFit;

  /*
   * Opening a composition sets the toggle's *starting* position from its stage.
   *
   * Two different questions, and the split matters. `canvasFitsGuides` above is
   * about the panel and is derived every render, so it reverses itself when the
   * splitter moves. This is about the document — a 120×40 badge is an element,
   * not a frame, and safe-area insets computed as fractions of it describe
   * nothing anyone will honour. So it is *written* to state: an author who then
   * ticks the box to line something up against the center lines keeps them.
   *
   * Written on composition change rather than once at mount, which is the bug
   * this fixes: `useState(true)` ran on the first composition the editor
   * happened to open and was never revisited, so switching from a 1920×1080
   * lower third to the badge carried the guides across with it.
   *
   * The stage is read from the store rather than closed over, matching how the
   * rest of this component reaches for current values — the effect keys on the
   * id alone, so a closed-over stage would be a render behind.
   */
  useEffect(() => {
    const stage = useEditor.getState().composition?.stage;
    if (stage) setShowGuides(stageWantsGuides(stage));
  }, [composition?.id]);

  /** Whether this stage is an element rather than a full frame — for the tooltip. */
  const elementStage = composition ? !stageWantsGuides(composition.stage) : false;

  /**
   * A new stage size is a new fit. Keyed on the dimensions rather than the
   * composition reference, which changes on every edit — re-fitting on each
   * keystroke would yank the view out from under whoever was typing.
   */
  const stageKey = `${stageSize.width}x${stageSize.height}`;
  useEffect(() => {
    setUserZoom(null);
    setPan({ x: 0, y: 0 });
  }, [stageKey]);

  /** Center of the canvas in client coordinates — the anchor zoom is measured from. */
  const canvasCentre = (): Point => {
    const rect = canvasEl?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };

  /** Change zoom while holding `pointer` (client coords) over the same stage point. */
  const zoomTo = (next: number, pointer?: Point) => {
    const clamped = clampZoom(next);
    if (clamped === zoom) return;
    if (pointer) setPan((p) => zoomAtPoint(p, zoom, clamped, pointer, canvasCentre()));
    setUserZoom(clamped);
  };

  const resetView = () => {
    setUserZoom(null);
    setPan({ x: 0, y: 0 });
  };

  const resolveComposition = useMemo(() => {
    const byId = new Map((project?.compositions ?? []).map((c) => [c.id, c]));
    return (id: string) => byId.get(id);
  }, [project]);

  /* ------------------------------------------------- build / rebuild */

  /**
   * Bumped every time the runtime is replaced.
   *
   * Everything downstream — the Moveable target, playback state — is derived
   * from DOM nodes owned by the runtime, and the rebuild is debounced. Without
   * a signal that the rebuild finished, those derivations run against the
   * *outgoing* runtime: handles never appeared after adding a layer, and after
   * a property edit they pointed at a node the rebuild had already destroyed.
   */
  const [runtimeVersion, setRuntimeVersion] = useState(0);

  /**
   * True for the duration of a drag/resize/rotate gesture.
   *
   * Moveable requires its target element to survive the whole gesture — it
   * derives `beforeTranslate` by measuring that element. The rebuild below
   * destroys and recreates every layer node, so when one fired mid-drag,
   * Moveable re-based itself on an element that already contained the drag so
   * far and then applied the pointer delta again: a 120px drag overshot by
   * ~7.7×, and the gesture split into several undo entries.
   *
   * The debounce alone was not protection. A fast drag keeps resetting it, but
   * any pause longer than the debounce lets a rebuild through, so the bug
   * appeared only on slower or stepped movement — the worst kind of flaw to
   * catch by hand.
   */
  const gestureActive = useRef(false);
  const [gestureNonce, setGestureNonce] = useState(0);

  const beginGesture = () => { gestureActive.current = true; };
  const endGesture = () => {
    gestureActive.current = false;
    // Reconcile the preview with the document now the gesture is over.
    setGestureNonce((n) => n + 1);
  };

  useEffect(() => {
    if (!composition || !hostRef.current) return;
    if (gestureActive.current) return;

    const timer = window.setTimeout(() => {
      runtimeRef.current?.destroy();

      /*
       * The preview is built *with* the project's data, exactly as `/play` is.
       *
       * Without this the editor was the one consumer that never saw a DataSet:
       * a table fell back to its authored snapshot (which looks plausible, so
       * nobody noticed) and a source-fed ticker showed its placeholder, so the
       * only way to check a feed was actually bound was to put the graphic on
       * air. Passing it at construction rather than pushing it afterwards
       * matters — the runtime fills crawl loops during `build()`, and a ticker
       * that has already started rotating adopts new copy a lap later.
       */
      const datasets = useEditor.getState().datasets;

      const runtime = new BreezeRuntime({
        container: hostRef.current!,
        composition,
        resolveComposition,
        resolveAsset: (src) =>
          /^(https?:)?\/\//.test(src) || src.startsWith('data:')
            ? src
            : `/assets/${useEditor.getState().projectId ?? ''}/${src.replace(/^assets\//, '')}`,
        autoPlay: false,
        ...(Object.keys(datasets).length ? { data: { [DATA_UPDATE_KEY]: datasets } } : {}),
      });

      runtimeRef.current = runtime;
      // Restore the playhead: a rebuild that snapped back to 0 would make
      // editing a keyframe at 2s unusable.
      runtime.seek(useEditor.getState().playhead);
      /*
       * Publish what only a built runtime knows: how many pieces each reveal
       * animates, and which straps overflow their box. Both depend on real text
       * measurement in the real font, so the panel cannot work them out from the
       * document — and both are warnings an author wants now rather than on air.
       */
      useEditor.setState({
        textPieces: runtime.textAnimPieceCounts,
        overflowingText: runtime.overflowingTextLayers,
        // Same argument for tables: how many rows fit is a fact about the
        // rendered box, so only the built runtime can answer it.
        overflowingTables: runtime.overflowingTables,
        tablePages: runtime.tablePages,
      });
      setRuntimeVersion((v) => v + 1);
    }, REBUILD_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
    /*
     * Keyed on the composition *reference*, not a JSON signature of it. The
     * command reducers preserve object identity when nothing changed, so the
     * reference is already an exact change signal — and stringifying the whole
     * document on every render meant serializing it 60 times a second while
     * the timeline was playing.
     *
     * `datasetRevision` rebuilds rather than pushing an update, deliberately.
     * A push would be cheaper, but a crawl adopts new copy at its loop seam and
     * a preview parked at frame 0 has no seam coming — so new headlines would
     * sit queued and invisible, which is the bug this whole change is fixing.
     * A rebuild starts the ticker from the new rows. Data changes at poll
     * intervals, not per keystroke, so the cost is irrelevant here.
     */
  }, [composition, resolveComposition, gestureNonce, datasetRevision]);

  useEffect(() => () => runtimeRef.current?.destroy(), []);

  /* ---------------------------------------------------------- playback */

  // Start and stop only when the flag actually flips. Folding `playhead` into
  // this effect meant play() ran on every frame while playing, which restarts
  // crawl tweens and re-seeks every video 60 times a second.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (!playing) {
      runtime.seek(useEditor.getState().playhead);
      return;
    }
    // `playThrough` ignores STOP markers; `play` steps between them exactly as
    // the graphic will on air. The toolbar toggle picks which you are watching.
    if (useEditor.getState().honourHolds) runtime.play();
    else runtime.playThrough();
  }, [playing, runtimeVersion]);

  // Scrubbing. While playing, the runtime owns the clock and the rAF loop
  // below pushes it into the store — following the store here would fight it.
  useEffect(() => {
    if (playing) return;
    runtimeRef.current?.seek(playhead);
  }, [playhead, playing, runtimeVersion]);

  // While playing, mirror the runtime clock back into the store so the
  // timeline playhead tracks it.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const runtime = runtimeRef.current;
      if (runtime) {
        useEditor.setState({ playhead: runtime.currentTime });
        if (runtime.playbackState === 'finished' || runtime.playbackState === 'holding') {
          useEditor.setState({ playing: false });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  /* -------------------------------------------------------- selection */

  const selectedId = selectedLayerIds[0];

  /**
   * Is the selection a row-template cell rather than a stage layer?
   *
   * Derived from the document, not from the element: a table whose source has
   * not resolved yet has no rows and therefore no cell elements at all, and
   * inferring "cell" from a failed element lookup would classify every
   * not-yet-rendered layer the same way.
   */
  const selectedIsCell =
    composition && selectedId ? isCell(composition.layers, selectedId) : false;

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !selectedId) {
      setTarget(null);
      return;
    }
    setTarget(
      (selectedIsCell ? runtime.getCellElement(selectedId) : runtime.getLayerElement(selectedId)) ??
        null,
    );
  }, [selectedId, selectedIsCell, runtimeVersion, playhead]);

  const selectedLayer: Layer | null =
    composition && selectedId ? findLayer(composition.layers, selectedId) ?? null : null;

  /**
   * Re-measure the transform handles whenever the layer moves underneath them.
   *
   * Moveable measures its target once and caches the rect. Everything that moves
   * a layer on screen here happens outside Moveable's knowledge — a seek
   * repositions it through GSAP, a rebuild replaces the node, and a zoom or pan
   * changes the ancestor transform — so without this the handles stay where the
   * layer was when it was selected.
   *
   * The symptom was a drag that did nothing. Select Bar at t=0 (x=-960, mostly
   * off-stage left), scrub to 0.97s (x=120, on stage), and the handles are still
   * 1080 stage px to the left of the layer: the overlay you have to grab is not
   * over the layer you can see. At 45% zoom that stale overlay still happened to
   * fall inside the canvas, so a drag aimed at its center worked by luck and the
   * e2e suite passed. Once the stage fitted its viewport properly the same
   * overlay landed at x≈20 — inside the layers panel — and the press never
   * reached the stage at all.
   *
   * Not during a gesture: Moveable derives `beforeTranslate` from the rect it
   * measured at gesture start, and re-measuring mid-drag re-bases it on an
   * element that already contains the drag so far. That is the ×7.7 overshoot
   * documented above, arrived at from the other direction.
   */
  useEffect(() => {
    if (gestureActive.current) return;
    moveableRef.current?.updateRect();
  }, [target, playhead, zoom, pan, composition, runtimeVersion]);

  /**
   * Mark the selected layer so it can be outlined.
   *
   * Moveable's handles are the interaction surface, but they are sized for
   * ordinary layers. On a thin layer — the demo's 14px accent bar is 6px on
   * screen at default zoom — they collapse into a sliver that reads as "no
   * selection at all", especially when a much larger layer sits underneath.
   *
   * A data attribute rather than an inline `outline` style: selection is a
   * state, and encoding it in a CSS shorthand made it impossible to read back
   * unambiguously — computed `outline-width` reports `medium` (3px) in some
   * states whether or not an outline is actually drawn. The attribute is
   * exact for both the stylesheet and any test asking "is this selected?".
   * Zoom compensation lives in `--bz-select-width` on the stage.
   */
  useEffect(() => {
    if (!target) return;
    target.dataset['selected'] = '1';
    return () => {
      // The element may already be gone if the runtime rebuilt underneath us.
      if (target.isConnected) delete target.dataset['selected'];
    };
  }, [target]);

  /**
   * Why can't I see the layer I just selected? Almost always one of two
   * reasons, and both are invisible without being told.
   */
  const [visibility, setVisibility] = useState<'visible' | 'off-stage' | 'hidden'>('visible');

  useEffect(() => {
    if (!target || !composition) {
      setVisibility('visible');
      return;
    }

    if (target.dataset['hidden'] === '1') {
      setVisibility('hidden');
      return;
    }

    const layerBox = target.getBoundingClientRect();
    const stageBox = hostRef.current?.getBoundingClientRect();
    if (!stageBox || layerBox.width === 0) {
      setVisibility('visible');
      return;
    }

    const intersects =
      layerBox.right > stageBox.left &&
      layerBox.left < stageBox.right &&
      layerBox.bottom > stageBox.top &&
      layerBox.top < stageBox.bottom;

    setVisibility(intersects ? 'visible' : 'off-stage');
  }, [target, composition, playhead, zoom, pan, runtimeVersion]);

  /* ------------------------------------------------ direct manipulation */

  /**
   * Commit values through the same command the properties panel uses, so the
   * reducer decides per property whether this is a keyframe at the playhead or
   * the static baseline. Dragging an animated layer used to write the baseline,
   * which the planner ignores — the layer simply never moved.
   */
  const commitValues = (values: Record<string, number>) => {
    if (!selectedLayer) return;
    run({ kind: 'setValues', layerId: selectedLayer.id, values, time: playhead });
  };

  /**
   * NOTE: nothing here may write the target element's transform.
   *
   * 0.14 tried to give live feedback by doing exactly that, and it produced an
   * exponential runaway. Moveable re-reads the element's transform to derive
   * `beforeTranslate`, so our write became its next baseline:
   *
   *     x_n = dragStart + (x_{n-1} + pointerDelta) / zoom
   *
   * At 45% zoom that is a ×2.22 multiplier per pointer event — a 120px drag
   * sent a layer from x=660 to x=-4,952,441. Two owners of one transform.
   *
   * The layer therefore moves on release rather than during the gesture.
   * Restoring live feedback means giving Moveable something to measure that we
   * do not also animate — moving `.bz-content` instead of the `.bz-layer` root
   * looks most promising — and it needs verifying in a real browser, which is
   * how this regression got shipped in the first place.
   */

  const beginDrag = () => {
    beginGesture();
  };

  /**
   * `beforeTranslate` is the new ABSOLUTE translate, already expressed in the
   * element's own coordinate space — Moveable reads the existing transform at
   * gesture start and converts pointer movement through the ancestor scale
   * itself.
   *
   * It was previously treated as a screen-space delta, so the code added the
   * starting position a second time and then divided by the stage zoom:
   *
   *     x = start + beforeTranslate / zoom
   *
   * With a layer at x=660 and 45% zoom, nudging it a few pixels produced
   * 660 + 660/0.45 = 2126. Both corrections were wrong; the value needs
   * neither.
   */
  const onDrag = ({ beforeTranslate }: OnDrag) => {
    commitValues({
      x: Math.round((beforeTranslate[0] ?? 0) * 100) / 100,
      y: Math.round((beforeTranslate[1] ?? 0) * 100) / 100,
    });
  };

  const onResize = ({ width, height, drag }: OnResize) => {
    if (!selectedLayer) return;

    // One command, not a size patch plus a position change. Those alternate,
    // and coalescing only inspects the immediately previous entry — so a resize
    // produced two undo entries per pointer event and could never be undone in
    // a single step.
    run({
      kind: 'resizeLayer',
      layerId: selectedLayer.id,
      size: { width: Math.round(width), height: Math.round(height) },
      values: {
        x: Math.round((drag.beforeTranslate[0] ?? 0) * 100) / 100,
        y: Math.round((drag.beforeTranslate[1] ?? 0) * 100) / 100,
      },
      time: playhead,
    });
  };

  const onRotate = ({ beforeRotate }: OnRotate) => {
    commitValues({ rotation: Math.round(beforeRotate * 100) / 100 });
  };

  /* -------------------------------------------------------------- pan */

  const panning = useRef<{ x: number; y: number } | null>(null);

  /**
   * Live touch points, and the pinch gesture derived from them.
   *
   * A tablet has no middle button, no Alt key and no Ctrl+wheel, so every zoom
   * and pan affordance the viewport had was mouse-only: the stage could be
   * neither scaled nor moved by touch at all. Two fingers pinch to zoom, one
   * finger drags to pan, and a finger that barely moves is a tap that clears the
   * selection.
   */
  const touches = useRef(new Map<number, Point>());
  const pinch = useRef<{ distance: number; zoom: number; pan: Point } | null>(null);
  /** Set once a touch has traveled far enough to be a pan rather than a tap. */
  const touchMoved = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (touches.current.size === 2) {
        // A pinch supersedes whatever the first finger was doing.
        const [a, b] = [...touches.current.values()] as [Point, Point];
        pinch.current = { distance: distance(a, b), zoom, pan };
        panning.current = null;
        return;
      }

      if (touches.current.size === 1 && e.target === e.currentTarget) {
        // Deferred: whether this is a pan or a deselect tap is not known until
        // the finger either moves or lifts.
        panning.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
        touchMoved.current = false;
      }
      return;
    }

    // Middle button or Alt-drag pans; left click selects.
    if (e.button === 1 || e.altKey) {
      panning.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      e.preventDefault();
    } else if (e.target === e.currentTarget) {
      selectLayers([]);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (touches.current.has(e.pointerId)) {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    const gesture = pinch.current;
    if (gesture && touches.current.size >= 2) {
      const [a, b] = [...touches.current.values()] as [Point, Point];
      const spread = distance(a, b);
      // Two fingers that land in the same spot would divide by ~0 and send the
      // zoom to a limit.
      if (gesture.distance < 1) return;
      const next = clampZoom(gesture.zoom * (spread / gesture.distance));
      setPan(zoomAtPoint(gesture.pan, gesture.zoom, next, midpoint(a, b), canvasCentre()));
      setUserZoom(next);
      return;
    }

    if (!panning.current) return;

    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      const from = { x: panning.current.x + pan.x, y: panning.current.y + pan.y };
      if (!touchMoved.current && distance(from, { x: e.clientX, y: e.clientY }) < TAP_SLOP_PX) {
        return;
      }
      touchMoved.current = true;
    }

    setPan({ x: e.clientX - panning.current.x, y: e.clientY - panning.current.y });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (touches.current.delete(e.pointerId)) {
      if (touches.current.size < 2) pinch.current = null;
      // A tap on empty canvas clears the selection, matching the mouse.
      if (
        touches.current.size === 0 &&
        !touchMoved.current &&
        panning.current &&
        e.target === e.currentTarget
      ) {
        selectLayers([]);
      }
    }
    panning.current = null;
  };

  /**
   * Ctrl/Cmd+wheel zooms about the cursor. Trackpad pinch arrives here as
   * ctrl+wheel, so this covers laptops; genuine touch goes through the pinch
   * handler above.
   */
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomTo(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX, y: e.clientY });
  };

  if (!composition) {
    return <div className="stage-empty">No composition loaded</div>;
  }

  return (
    <div className="stage-wrap">
      <div className="stage-toolbar">
        <button onClick={() => zoomTo(zoom / 1.25)} title="Zoom out">−</button>
        <span className="zoom-readout" data-fitted={userZoom === null ? '1' : '0'}>
          {Math.round(zoom * 100)}%
        </span>
        <button onClick={() => zoomTo(zoom * 1.25)} title="Zoom in">+</button>
        {/* Fit hands the zoom back to the measured canvas, so it keeps tracking
            resizes and rotations until the operator zooms again. */}
        <button onClick={resetView} title="Fit the stage to the viewport">Fit</button>
        <label className="toggle" data-auto-off={guidesFit ? undefined : '1'}>
          <input
            type="checkbox"
            checked={guidesVisible}
            disabled={!guidesFit}
            title={
              !guidesFit
                ? `Guides are hidden below ${MIN_GUIDE_CANVAS_WIDTH}px of stage width — widen the panel to bring them back`
                : elementStage
                  ? 'Safe-area guides and center lines. Off by default here: this stage is an element rather than a full frame, so its safe areas are fractions of the element, not of the raster it will sit on.'
                  : 'Safe-area guides and center lines'
            }
            onChange={(e) => setShowGuides(e.target.checked)}
          />
          Guides
        </label>

        {selectedLayer && visibility !== 'visible' && (
          <span className="selection-hint" data-state={visibility}>
            {visibility === 'off-stage'
              ? `“${selectedLayer.name ?? selectedLayer.id}” is off-stage at this time`
              : `“${selectedLayer.name ?? selectedLayer.id}” is not shown at this time`}
          </span>
        )}

        <span className="stage-size">{composition.stage.width}×{composition.stage.height} @ {composition.stage.fps}fps</span>
      </div>

      <div
        className="stage-canvas"
        ref={setCanvasEl}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <div
          className="stage-transform"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            // Divided by zoom so the selection outline stays a constant 2px on
            // screen rather than shrinking with the stage.
            '--bz-select-width': `${(2 / zoom).toFixed(2)}px`,
          } as React.CSSProperties}
        >
          {/* Checkerboard: the stage is transparent, and a flat gray backdrop
              would make an all-white graphic invisible. */}
          <div
            className="stage-checker"
            style={{ width: composition.stage.width, height: composition.stage.height }}
          />
          <div ref={hostRef} className="stage-host" />

          {guidesVisible && (
            <svg
              className="stage-guides"
              width={composition.stage.width}
              height={composition.stage.height}
              viewBox={`0 0 ${composition.stage.width} ${composition.stage.height}`}
            >
              {SAFE_AREAS.map((area) => (
                <rect
                  key={area.label}
                  x={composition.stage.width * area.inset}
                  y={composition.stage.height * area.inset}
                  width={composition.stage.width * (1 - area.inset * 2)}
                  height={composition.stage.height * (1 - area.inset * 2)}
                />
              ))}
              <line x1={composition.stage.width / 2} y1={0} x2={composition.stage.width / 2} y2={composition.stage.height} />
              <line x1={0} y1={composition.stage.height / 2} x2={composition.stage.width} y2={composition.stage.height / 2} />
            </svg>
          )}

          {/*
            No transform handles on a cell, on purpose.

            A cell is authored once and drawn once per row, so there is no single
            element a drag could mean — and the copy the stage points at is the
            first row's, chosen only because something has to be outlined. Worse,
            its transform already has an owner: GSAP for a cell carrying
            keyframes, `TableBlock.staticTransform` for one that does not. A
            drag would be a third writer of the same string, and GSAP's cache
            means whoever writes first silently loses.

            Cells are positioned numerically in the properties panel instead.
            Outline yes, handles no.
          */}
          {target && selectedLayer && !selectedLayer.locked && !selectedIsCell && (
            <Moveable
              /*
                Remount when the element underneath is replaced.

                A gesture ends, the runtime rebuilds, and every layer node is
                destroyed and recreated. Handing Moveable the new element through
                `target` moved its control box to the right place but left the
                `dragArea` overlay sized 0×0 — `updateRect()` repositions, it does
                not resize that overlay. So the surface you grab to move a layer
                had no area: the press fell through to the nw resize handle
                sitting at that point, and the layer could not be dragged again.

                Deselecting and reselecting fixed it because that unmounts this
                component and mounts a fresh one, which is precisely what the key
                does — without making the operator discover the workaround.

                Rebuilds are suppressed for the duration of a gesture, so this can
                never remount mid-drag.
              */
              key={`${selectedId ?? ''}:${runtimeVersion}`}
              ref={moveableRef}
              target={target}
              /*
                `dragArea` renders an overlay across the selection bounds and
                makes that the drag surface.

                Dragging the layer element itself (`dragTarget`) seems more
                natural but fails wherever another layer overlaps: the demo's
                bar spans y 870–970, its center sits under the name strap, and
                a pointer there lands on the strap so the drag never starts.
                A selected layer has to be draggable from anywhere inside its
                own box, which means an overlay above the stage.

                Note this is not the same element as `.moveable-control-box`,
                which has a zero-size box with its handles positioned by
                transform — aiming at *its* center hits a corner resize handle.
              */
              dragArea
              draggable
              resizable
              rotatable
              throttleDrag={0}
              throttleResize={0}
              throttleRotate={0}
              origin={false}
              onDragStart={beginDrag}
              onDrag={onDrag}
              onDragEnd={endGesture}
              onResizeStart={beginDrag}
              onResize={onResize}
              onResizeEnd={endGesture}
              onRotateStart={beginDrag}
              onRotate={onRotate}
              onRotateEnd={endGesture}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export function stageSignature(comp: Composition | null): string {
  return comp ? `${comp.stage.width}x${comp.stage.height}` : '';
}
