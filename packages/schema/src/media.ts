// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Live media (CYCLE.md, Wave 8): what a media layer can play, how a URL says
 * which kind it is, and the columns a source's media checks add to its rows.
 *
 * Shared by the renderer, which plays the URL, and the server, which checks it
 * and proxies it — so the two can never disagree about whether a URL is a
 * snapshot or a stream.
 */

/**
 * - `image` — a still, optionally re-fetched every `refresh` seconds: a
 *   webcam's snapshot URL.
 * - `mjpeg` — a motion-JPEG stream (`multipart/x-mixed-replace`), as most IP
 *   cameras serve (`/axis-cgi/mjpg/video.cgi`). An `<img>` plays it.
 * - `video` — a file: MP4, WebM.
 * - `youtube` — a YouTube video or live stream, embedded muted.
 * - `hls` — an `.m3u8` live stream.
 */
export const MEDIA_KINDS = ['image', 'mjpeg', 'video', 'youtube', 'hls'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** What a media layer does when its source fails or stalls on air. */
export const MEDIA_ON_ERROR = ['hide', 'hold', 'skip'] as const;
export type MediaOnError = (typeof MEDIA_ON_ERROR)[number];

/** Seconds a source gets to show a first frame before it counts as failed. */
export const DEFAULT_MEDIA_TIMEOUT = 10;

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv)(?:$|[?#])/i;
const HLS_EXT = /\.m3u8(?:$|[?#])/i;
/** The shapes camera makers give their motion-JPEG endpoints. */
const MJPEG_HINT =
  /(?:\.mjpe?g(?:$|[?#])|\/mjpe?g\/|mjpg\/video|video\.cgi|videostream\.cgi|faststream|action=stream|[?&]stream=|\/stream(?:\.cgi)?(?:$|[?#])|\/media\/[^/]+\/[^/]+\/[^/]+\/stream(?:$|[?#]))/i;

/**
 * The YouTube video id in any of the URL shapes people paste — `watch?v=`,
 * `youtu.be/`, `/live/`, `/embed/`, `/shorts/` — or null when it is not a
 * YouTube URL.
 */
export function youtubeId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  const valid = (id: string | null | undefined): string | null =>
    id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
  if (host === 'youtu.be') return valid(u.pathname.slice(1).split('/')[0]);
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
  if (u.pathname === '/watch') return valid(u.searchParams.get('v'));
  const m = /^\/(?:embed|live|shorts|v)\/([^/?#]+)/.exec(u.pathname);
  return valid(m?.[1]);
}

/**
 * The kind a URL most likely is. A snapshot is the default: it is what most
 * webcam links are, and an `<img>` pointed at a stream still shows it.
 */
export function mediaKindOf(url: string): MediaKind {
  const text = url.trim();
  if (youtubeId(text)) return 'youtube';
  if (HLS_EXT.test(text)) return 'hls';
  if (VIDEO_EXT.test(text)) return 'video';
  if (MJPEG_HINT.test(text)) return 'mjpeg';
  return 'image';
}

/** A written kind — `MJPEG`, ` youtube ` — or null for anything else. */
export function parseMediaKind(value: unknown): MediaKind | null {
  if (typeof value !== 'string') return null;
  const k = value.trim().toLowerCase();
  return (MEDIA_KINDS as readonly string[]).includes(k) ? (k as MediaKind) : null;
}

/* --------------------------------------------------------- source checks */

/**
 * A source whose rows are media — a list of cameras — can have the server
 * check each one (`DataSourceBase.media`). Every row then carries four more
 * columns, `MEDIA_COLUMNS`, so a table can filter out a camera that is down
 * or frozen, and play it through the server's proxy.
 */
export interface MediaCheck {
  /** The column holding each row's URL. */
  column: string;
  /** A column naming each row's kind. Absent, or blank on a row: worked out from the URL. */
  kindColumn?: string;
  /** Seconds between checks of every row. Default 60, at least 15. */
  every?: number;
  /**
   * Seconds a snapshot or stream may show the same picture before it counts
   * as frozen. Default 300; 0 switches frozen detection off — a camera
   * pointed at a car park at night can legitimately not change.
   */
  frozenAfter?: number;
  /**
   * Play snapshots and streams through this server (default true). The
   * browser then only ever talks to Breeze: one connection to a camera
   * however many outputs show it, no mixed-content or login problems, and the
   * last good frame to show while a stream connects.
   */
  proxy?: boolean;
}

export const MEDIA_CHECK_DEFAULTS = { every: 60, frozenAfter: 300, minEvery: 15 } as const;

export const MEDIA_STATES = ['ok', 'failed', 'frozen', 'unchecked'] as const;
export type MediaState = (typeof MEDIA_STATES)[number];

/** The columns a media check adds to every row. */
export const MEDIA_COLUMNS = {
  /** `ok`, `failed`, `frozen` or `unchecked` (not checked yet). */
  state: 'mediaState',
  /** True when the state is `ok` or `unchecked` — the column to filter on. */
  ok: 'mediaOk',
  /** The URL to play: the server's proxy for snapshots and streams, the original otherwise. */
  src: 'mediaSrc',
  /** The kind, as written in the kind column or worked out from the URL. */
  kind: 'mediaKind',
} as const;

/** A source's media at a glance, in its status. */
export interface MediaSummary {
  ok: number;
  failed: number;
  frozen: number;
  unchecked: number;
  /** When the last full round of checks finished. */
  checkedAt?: string;
}

/** One row's check, from `GET …/datasources/:id/media`. */
export interface MediaRowStatus {
  /** Stable for a URL — the proxy's address for it. */
  key: string;
  url: string;
  kind: MediaKind;
  state: MediaState;
  /** Why it failed, when it did. */
  error?: string;
  lastOk?: string;
  lastCheck?: string;
  /** When the picture last changed, for snapshots and streams. */
  lastChange?: string;
}
