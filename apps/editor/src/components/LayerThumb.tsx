// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Layer thumbnail renderer — the impure half of `layer-thumb.ts`.
 *
 * Everything here is either a DOM element the browser already knows how to draw
 * (an `<img>`, a styled `<div>`) or one canvas draw for a video poster frame.
 * No bitmap rasterisation of the stage, and no dependency to do it with.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';

import { useT, type Translate } from '@breeze/i18n/react';
import { capturePoster } from '@breeze/runtime';
import type { Layer } from '@breeze/schema';

import {
  mountCompositionThumb,
  placePreview,
  type ThumbMount,
} from '../state/composition-thumb.js';

/** Longest side of a hover preview, in px. */
const PREVIEW_MAX_PX = 320;

/** How long the pointer must rest on a thumbnail before a preview opens. */
const HOVER_INTENT_MS = 350;
import { layerThumb, TYPE_GLYPH, type LayerThumb as Thumb } from '../state/layer-thumb.js';
import { useEditor } from '../state/store.js';

export interface LayerThumbProps {
  layer: Layer;
  /** Resolves `assets/logo.png` to a URL the editor can load. */
  assetBase?: string;
  size?: number;
}

function resolve(src: string, assetBase: string | undefined): string {
  if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) return src;
  if (!assetBase) return src;
  return `${assetBase}/${src.replace(/^assets\//, '')}`;
}

/**
 * A nested composition, rendered as a still posed at its rest frame.
 *
 * Phase 7.6's payoff: without this, every `composition` layer in a project is
 * the same `⧉` and two nested comps in a list are indistinguishable.
 *
 * Scenes render too: the mount builds one runtime per independent element, each
 * posed at its own rest frame.
 *
 * **Falls back to the glyph in two cases, both honest.** A `ref` that resolves
 * to nothing has no graphic to draw. And a build that throws takes the glyph
 * rather than the panel: a thumbnail is a convenience, and one bad composition
 * must not blank the layers list.
 */
function CompositionThumb({
  refId,
  glyph,
  size,
}: {
  refId: string;
  glyph: string;
  size: number;
}): JSX.Element {
  const host = useRef<HTMLSpanElement>(null);
  const project = useEditor((s) => s.project);
  const projectId = useEditor((s) => s.projectId);
  const [failed, setFailed] = useState(false);

  /*
   * The live mount, held so the preview can clone it.
   *
   * A ref rather than state: it changes as a side effect of the build and no
   * render depends on its identity, so putting it in state would re-render the
   * row for nothing every time the panel rebuilt.
   */
  const mountRef = useRef<ThumbMount | null>(null);
  const [preview, setPreview] = useState<{ x: number; y: number } | null>(null);
  const pending = useRef<HTMLElement | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);

  const composition = useMemo(
    () => project?.compositions.find((c) => c.id === refId),
    [project, refId],
  );

  useEffect(() => {
    const box = host.current;
    if (!box || !composition) return;

    // Typed as the real thing rather than a structural subset: the local shape
    // was written before `preview` existed and silently stopped matching.
    let mount: ThumbMount | null = null;
    try {
      mount = mountCompositionThumb({
        composition,
        size,
        resolveComposition: (id) => project?.compositions.find((c) => c.id === id),
        resolveAsset: (src) =>
          /^(https?:)?\/\//.test(src) || src.startsWith('data:')
            ? src
            : `/assets/${projectId ?? ''}/${src.replace(/^assets\//, '')}`,
      });
      box.appendChild(mount.element);
      mountRef.current = mount;
      setFailed(false);
    } catch {
      setFailed(true);
    }

    // Ownership is ours. A still no longer holds a clock timer or a live
    // `<video>` — both were cost this phase removed — but it still holds masks,
    // a GSAP timeline and any poster capture in flight, and a panel that
    // re-renders per keystroke would leak one set per render.
    return () => {
      mountRef.current = null;
      mount?.destroy();
    };
  }, [composition, project, projectId, size]);

  /*
   * Hover intent, not hover.
   *
   * A preview that opens the instant the pointer touches a row strobes as the
   * mouse crosses the panel on its way somewhere else. The delay is the whole
   * difference between a preview and a flicker.
   */
  const openLater = (): void => {
    if (!mountRef.current) return;
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      const anchor = host.current?.getBoundingClientRect();
      const mount = mountRef.current;
      if (!anchor || !mount) return;

      const element = mount.preview(PREVIEW_MAX_PX);
      const box = {
        width: Number.parseFloat(element.style.width),
        height: Number.parseFloat(element.style.height),
      };
      pending.current = element;
      setPreview(
        placePreview(
          { x: anchor.left, y: anchor.top, width: anchor.width, height: anchor.height },
          box,
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    }, HOVER_INTENT_MS);
  };

  const close = (): void => {
    window.clearTimeout(hoverTimer.current);
    pending.current = null;
    setPreview(null);
  };

  // Timer cleared on unmount too: a row removed while its preview was pending
  // would otherwise open one for a thumbnail that no longer exists.
  useEffect(() => close, []);

  const drawable = composition && !failed;

  if (!drawable) return <span className="layer-thumb glyph">{glyph}</span>;

  return (
    <>
      <span
        className="layer-thumb comp-thumb-host"
        ref={host}
        onPointerEnter={openLater}
        onPointerLeave={close}
      />
      {preview &&
        createPortal(
          /*
           * Portalled to `body` and `position: fixed`, because `.layer-list` is
           * `overflow: auto` — a preview rendered inside the row is clipped by
           * the panel it is trying to escape.
           *
           * `pointer-events: none` so the preview cannot sit under the cursor
           * and fight its own hover boundary, which is the classic way a
           * tooltip flickers forever.
           */
          <div
            className="comp-preview-layer"
            /*
             * `placePreview` works in client space from
             * `getBoundingClientRect`, which is physical whatever the document
             * direction, and it already chooses a side by measuring the real
             * anchor. A logical property here would mirror a number that has
             * been mirrored once already, putting the preview on the wrong
             * side under RTL.
             */
            // dir-ok — a computed viewport coordinate, not chrome
            style={{ left: preview.x, top: preview.y }}
            ref={(node) => {
              if (node && pending.current) node.appendChild(pending.current);
            }}
          />,
          document.body,
        )}
    </>
  );
}

/**
 * One frame from a video, drawn once.
 *
 * The draw itself lives in `@breeze/runtime`'s `capturePoster`, not here. It
 * started in this file and moved when a still runtime needed exactly the same
 * thing: a video layer inside a composition thumbnail used to build a real
 * `<video>` with `preload="auto"`, so a panel of twenty comps with stingers in
 * them held twenty decoders that would never play a frame. The runtime is the
 * only place that can decide a layer renders as a poster, so the helper went to
 * the runtime and this component calls in — one implementation, and the seek
 * rule that keeps a thumbnail off a black first frame is stated once.
 *
 * The glyph is the fallback for every failure: a missing asset, a codec the
 * browser will not open, a cross-origin file that taints the canvas.
 */
function VideoThumb({ src, size }: { src: string; size: number }): JSX.Element {
  const [poster, setPoster] = useState<string | null>(null);

  useEffect(() => {
    setPoster(null);
    let live = true;
    // Device pixels, so the bitmap survives a 2× display.
    const capture = capturePoster({ doc: document, src, maxSize: size * 2 });

    void capture.frame.then((url) => {
      if (live && url) setPoster(url);
    });

    return () => {
      live = false;
      capture.cancel();
    };
  }, [src, size]);

  if (!poster) return <span className="layer-thumb glyph">{TYPE_GLYPH.video}</span>;
  return <img className="layer-thumb" src={poster} alt="" width={size} height={size} />;
}

/**
 * `t` is a parameter rather than a hook because `render` is a plain function
 * that recurses into itself for stacked thumbs — making it a component to reach
 * `useT()` would remount every nested thumbnail on each render.
 */
function render(
  thumb: Thumb,
  size: number,
  assetBase: string | undefined,
  t: Translate,
): JSX.Element {
  switch (thumb.kind) {
    case 'image':
      return (
        <img
          className="layer-thumb"
          src={resolve(thumb.src, assetBase)}
          alt=""
          width={size}
          height={size}
          style={{ objectFit: thumb.fit as 'contain' }}
          // A missing asset falls back to the glyph rather than the browser's
          // broken-image icon, which reads as a bug in the editor.
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
        />
      );

    case 'video':
      return <VideoThumb src={resolve(thumb.src, assetBase)} size={size} />;

    case 'composition':
      return <CompositionThumb refId={thumb.ref} glyph={thumb.glyph} size={size} />;

    /*
     * Frame 0 of the sheet, by the same percentage rule the runtime uses.
     *
     * No canvas and no draw — a background-image sized to the grid crops to one
     * cell for free, so unlike the video poster there is nothing async to fail
     * and nothing to taint. `0% 0%` is frame 0 under
     * `applySpriteFrame`'s `(col / (cols - 1)) * 100` for every grid, including
     * the single-column case it pins to zero.
     */
    case 'sprite':
      return (
        <span
          className="layer-thumb"
          style={{
            display: 'inline-block',
            width: size,
            height: size,
            backgroundImage: `url("${resolve(thumb.src, assetBase)}")`,
            backgroundSize: `${thumb.cols * 100}% ${thumb.rows * 100}%`, // i18n-ignore — CSS value
            backgroundPosition: '0% 0%',
            backgroundRepeat: 'no-repeat',
          }}
        />
      );

    /*
     * The drawing itself, scaled into the thumb by its own layer box.
     *
     * `preserveAspectRatio` defaults to `xMidYMid meet`, which is exactly the
     * fit wanted here — the same "letterbox it and centre it" the composition
     * thumbnail computes by hand, except SVG does it for free because this one
     * has a viewBox to do it with.
     */
    case 'path':
      return (
        <svg
          className="layer-thumb"
          width={size}
          height={size}
          viewBox={`0 0 ${thumb.width} ${thumb.height}`} // i18n-ignore — SVG viewBox
          aria-hidden="true"
        >
          <path
            d={thumb.d}
            fill={thumb.fill}
            {...(thumb.stroke
              ? {
                  stroke: thumb.stroke.color,
                  // Scaled with the drawing, or a 2px stroke on a 1920-wide
                  // layer vanishes entirely at thumbnail size.
                  strokeWidth: thumb.stroke.width,
                  strokeLinejoin: 'round' as const,
                  strokeLinecap: 'round' as const,
                }
              : {})}
          />
        </svg>
      );

    case 'shape':
      return (
        <span
          className="layer-thumb swatch"
          style={{
            background: thumb.fill,
            borderRadius: thumb.ellipse ? '50%' : `${thumb.radius}%`,
            ...(thumb.stroke
              ? { boxShadow: `inset 0 0 0 ${Math.min(3, thumb.stroke.width)}px ${thumb.stroke.color}` } // i18n-ignore — CSS value
              : {}),
          }}
        />
      );

    case 'text':
      return (
        <span
          className="layer-thumb sample"
          style={{
            fontFamily: thumb.fontFamily,
            color: thumb.color,
            fontWeight: thumb.weight,
            fontStyle: thumb.italic ? 'italic' : 'normal',
          }}
        >
          {thumb.sample}
        </span>
      );

    case 'table':
      return (
        <span className="layer-thumb table-thumb" title={t('editor.thumb.rows', { count: thumb.rows })}>
          {thumb.columns.length
            ? thumb.columns.slice(0, 3).map((c, i) => <i key={i}>{c.slice(0, 2)}</i>)
            : <i>▦</i>}
        </span>
      );

    case 'stack':
      return (
        <span className="layer-thumb stack" title={t('editor.thumb.layers', { count: thumb.count })}>
          {thumb.children.map((child, i) => (
            <span
              key={i}
              className="stack-item"
              // A thumbnail is a miniature of the graphic, and the graphic does
              // not mirror (I18N.md §6.1).
              // dir-ok
              style={{ left: i * 3, top: i * 3 }}
            >
              {render(child, size - 6, assetBase, t)}
            </span>
          ))}
          {thumb.children.length === 0 && <i>{TYPE_GLYPH.group}</i>}
        </span>
      );

    default:
      return <span className="layer-thumb glyph">{thumb.glyph}</span>;
  }
}

export function LayerThumb({ layer, assetBase, size = 22 }: LayerThumbProps): JSX.Element {
  const t = useT();
  return render(layerThumb(layer), size, assetBase, t);
}
