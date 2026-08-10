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

import { useEffect, useRef, useState, type JSX } from 'react';
import type { Layer } from '@breeze/schema';

import { layerThumb, TYPE_GLYPH, type LayerThumb as Thumb } from '../state/layer-thumb.js';

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
 * One frame from a video, drawn once.
 *
 * Seeks a hair past zero rather than to zero: several encoders put a black or
 * near-black frame first, and a poster of black is indistinguishable from a
 * failed load — the one thing a thumbnail exists to rule out.
 */
function VideoThumb({ src, size }: { src: string; size: number }): JSX.Element {
  const [poster, setPoster] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'metadata';
    video.src = src;

    const draw = (): void => {
      if (cancelled.current) return;
      const canvas = document.createElement('canvas');
      canvas.width = size * 2;
      canvas.height = size * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
      const w = video.videoWidth * scale;
      const h = video.videoHeight * scale;
      try {
        ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        setPoster(canvas.toDataURL('image/png'));
      } catch {
        // A cross-origin asset taints the canvas. The glyph fallback is fine —
        // this is a convenience, not a feature worth an error for.
      }
    };

    const onLoaded = (): void => {
      video.currentTime = Math.min(0.1, (video.duration || 1) / 10);
    };
    video.addEventListener('loadeddata', onLoaded, { once: true });
    video.addEventListener('seeked', draw, { once: true });

    return () => {
      cancelled.current = true;
      video.removeAttribute('src');
      video.load();
    };
  }, [src, size]);

  if (!poster) return <span className="layer-thumb glyph">{TYPE_GLYPH.video}</span>;
  return <img className="layer-thumb" src={poster} alt="" width={size} height={size} />;
}

function render(thumb: Thumb, size: number, assetBase: string | undefined): JSX.Element {
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
            backgroundSize: `${thumb.cols * 100}% ${thumb.rows * 100}%`,
            backgroundPosition: '0% 0%',
            backgroundRepeat: 'no-repeat',
          }}
        />
      );

    case 'shape':
      return (
        <span
          className="layer-thumb swatch"
          style={{
            background: thumb.fill,
            borderRadius: thumb.ellipse ? '50%' : `${thumb.radius}%`,
            ...(thumb.stroke
              ? { boxShadow: `inset 0 0 0 ${Math.min(3, thumb.stroke.width)}px ${thumb.stroke.color}` }
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
        <span className="layer-thumb table-thumb" title={`${thumb.rows} rows`}>
          {thumb.columns.length
            ? thumb.columns.slice(0, 3).map((c, i) => <i key={i}>{c.slice(0, 2)}</i>)
            : <i>▦</i>}
        </span>
      );

    case 'stack':
      return (
        <span className="layer-thumb stack" title={`${thumb.count} layers`}>
          {thumb.children.map((child, i) => (
            <span key={i} className="stack-item" style={{ left: i * 3, top: i * 3 }}>
              {render(child, size - 6, assetBase)}
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
  return render(layerThumb(layer), size, assetBase);
}
