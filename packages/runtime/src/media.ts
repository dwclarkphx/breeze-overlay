// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The media layer's player (CYCLE.md, Wave 8): one URL at a time, in whichever
 * element plays its kind, with a timeout that turns "nothing arrived" into a
 * failure the layer can act on.
 *
 * Live media is not on the graphic's timeline. A `video` layer scrubs with the
 * playhead; this plays whatever is live when it is shown, so it has no `seek`
 * and nothing here reads the timeline.
 *
 * **Every element this creates is released explicitly.** An `<img>` holding a
 * motion-JPEG stream keeps its connection open after it leaves the DOM, until
 * the garbage collector gets to it — so a camera rotation that only removed
 * rows would stack up one open connection per camera shown. `destroy()` drops
 * each source, and `stopMediaIn` finds every player under a subtree.
 */

import {
  DEFAULT_MEDIA_TIMEOUT,
  mediaKindOf,
  youtubeId,
  type MediaKind,
  type MediaLayer,
} from '@breeze/schema';

export type MediaPlayState = 'idle' | 'loading' | 'playing' | 'failed';

/** What the player needs from its surroundings — the build context's subset. */
export interface MediaEnv {
  doc: Document;
  resolveAsset: (src: string) => string;
  still?: boolean;
  /** Where hls.js lives, for a browser that cannot play HLS itself. */
  hlsScript?: string;
  /**
   * Whether media should be playing now — the graphic is on air. Absent is
   * always. While it answers false a player remembers its source and holds
   * no connection and makes no sound; it starts when the graphic plays.
   */
  isLive?: () => boolean;
}

const players = new WeakMap<HTMLElement, MediaPlayer>();

/** Destroy every player at or under `root` — before a row or a graphic is torn down. */
export function stopMediaIn(root: Element): void {
  const hosts: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.classList.contains('bz-media')) hosts.push(root);
  root.querySelectorAll<HTMLElement>('.bz-media').forEach((el) => hosts.push(el));
  for (const host of hosts) players.get(host)?.destroy();
}

/** The player built into a media host, if any. */
export function playerOf(host: HTMLElement): MediaPlayer | undefined {
  return players.get(host);
}

/* ------------------------------------------------------------------ urls */

/** A URL, a protocol-relative URL, a data: URL or a server path — played as written. */
const PLAYABLE_AS_IS = /^(?:[a-z][a-z0-9+.-]*:|\/)/i;

export function resolveMediaSrc(src: string, resolveAsset: (src: string) => string): string {
  return PLAYABLE_AS_IS.test(src) ? src : resolveAsset(src);
}

/**
 * The snapshot URL for a refresh period: the same for every output and every
 * preload within one period, so the cache warmed ahead of a page turn is the
 * one the turn reads.
 */
export function snapshotUrl(url: string, refresh: number | undefined, now = Date.now()): string {
  if (!refresh || refresh <= 0 || url.startsWith('data:')) return url;
  const bucket = Math.floor(now / (refresh * 1000));
  return `${url}${url.includes('?') ? '&' : '?'}_bz=${bucket}`;
}

/** The server proxy's still frame for one of its streams. */
export function proxySnapshotOf(url: string): string | null {
  const m = /^(.*\/media\/[^/]+\/[^/]+\/[^/?#]+)\/stream(?=$|[?#])/.exec(url);
  return m ? `${m[1]}/snapshot` : null;
}

/**
 * URLs a preload found broken, and until when. A page turn onto one fails at
 * once rather than after the timeout — which is what lets `skip` move past a
 * dead camera before anyone sees the gap.
 */
const knownBad = new Map<string, number>();
const BAD_FOR_MS = 60_000;

function isKnownBad(url: string): boolean {
  const until = knownBad.get(url);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  knownBad.delete(url);
  return false;
}

/** Forget every preload failure — for tests. */
export function resetMediaPreloads(): void {
  knownBad.clear();
}

/**
 * Warm what can be warmed before a page turn shows it: a snapshot is fetched
 * into the cache (under the URL the turn will ask for), a proxied stream's
 * last frame likewise. Streams, files and embeds cannot be usefully fetched
 * ahead without playing them, so they are left alone.
 */
export function preloadMedia(
  url: string,
  kind: MediaKind,
  refresh: number | undefined,
  doc: Document,
  /** When the page will show — the refresh period the turn itself will ask for. */
  at = Date.now(),
): void {
  const target =
    kind === 'image' ? snapshotUrl(url, refresh, at)
    : kind === 'mjpeg' ? proxySnapshotOf(url)
    : null;
  if (!target) return;
  const img = doc.createElement('img');
  img.onerror = () => {
    knownBad.set(url, Date.now() + BAD_FOR_MS);
  };
  img.onload = () => {
    knownBad.delete(url);
  };
  img.src = target;
}

/* ------------------------------------------------------------------- hls */

interface HlsLike {
  loadSource(url: string): void;
  attachMedia(el: HTMLVideoElement): void;
  on(event: string, cb: (event: string, data: { fatal?: boolean; details?: string }) => void): void;
  destroy(): void;
}
interface HlsCtor {
  new (config?: Record<string, unknown>): HlsLike;
  isSupported(): boolean;
  Events: { ERROR: string };
}

let hlsLoading: Promise<HlsCtor | null> | null = null;

function hlsGlobal(): HlsCtor | null {
  const h = (globalThis as { Hls?: HlsCtor }).Hls;
  return h && typeof h.isSupported === 'function' ? h : null;
}

/** hls.js, from the page if it is there, else loaded once from `script`. */
function loadHls(doc: Document, script: string | undefined): Promise<HlsCtor | null> {
  const present = hlsGlobal();
  if (present) return Promise.resolve(present);
  if (!script) return Promise.resolve(null);
  if (!hlsLoading) {
    hlsLoading = new Promise((resolve) => {
      const tag = doc.createElement('script');
      tag.src = script;
      tag.async = true;
      tag.onload = () => resolve(hlsGlobal());
      tag.onerror = () => {
        hlsLoading = null;
        resolve(null);
      };
      doc.head.appendChild(tag);
    });
  }
  return hlsLoading;
}

/* ---------------------------------------------------------------- player */

export interface MediaPlayerOptions {
  layer: MediaLayer;
  /** The `.bz-media` element; the player owns its children. */
  host: HTMLElement;
  env: MediaEnv;
}

export class MediaPlayer {
  /** Told once per source that fails — `skip` hangs off this. */
  onFail: ((reason: string) => void) | null = null;
  /** Told when a source first shows a picture. */
  onPlay: (() => void) | null = null;

  private stateValue: MediaPlayState = 'idle';
  private url: string | null = null;
  private kindValue: MediaKind | null = null;
  private reason = '';
  private destroyed = false;
  /** Whether the current source has been started — false while the graphic is off air. */
  private started = false;
  /** Everything the current source holds: timers, listeners, elements, hls.js. */
  private releases: Array<() => void> = [];

  constructor(private readonly opts: MediaPlayerOptions) {
    const { host, layer } = opts;
    host.classList.add('bz-media');
    host.dataset['onError'] = layer.onError ?? 'hide';
    host.dataset['state'] = 'idle';
    players.set(host, this);
  }

  get state(): MediaPlayState {
    return this.stateValue;
  }
  get kind(): MediaKind | null {
    return this.kindValue;
  }
  get src(): string | null {
    return this.url;
  }
  get error(): string {
    return this.reason;
  }

  /**
   * Play `src` — a URL, a server path or an asset path — as `kind`, or as the
   * kind its URL looks like. The same source again is a no-op, unless it has
   * failed: a row pushed again is a reason to try again.
   */
  show(src: string | null | undefined, kind?: MediaKind | null): void {
    if (this.destroyed) return;
    const url = src ? resolveMediaSrc(String(src).trim(), this.opts.env.resolveAsset) : null;
    const resolvedKind = url ? kind ?? this.opts.layer.kind ?? mediaKindOf(url) : null;
    if (url === this.url && resolvedKind === this.kindValue && this.stateValue !== 'failed') return;

    this.release();
    this.url = url;
    this.kindValue = resolvedKind;
    this.reason = '';
    this.started = false;
    const host = this.opts.host;
    if (!url || !resolvedKind) {
      delete host.dataset['kind'];
      this.setState('idle');
      return;
    }
    host.dataset['kind'] = resolvedKind;
    if (this.live()) this.start();
    else this.setState('idle');
  }

  /**
   * The graphic went on or off air. Off, the source is let go of — no camera
   * connection held for a graphic nobody can see, and no sound before TAKE or
   * after CLEAR — and remembered, so going on air again starts it afresh.
   */
  setLive(live: boolean): void {
    if (this.destroyed || !this.url) return;
    if (live && !this.started) this.start();
    else if (!live && this.started && !this.opts.env.still) {
      this.release();
      this.started = false;
      this.setState('idle');
    }
  }

  private live(): boolean {
    return this.opts.env.still === true || (this.opts.env.isLive?.() ?? true);
  }

  private start(): void {
    const url = this.url;
    const resolvedKind = this.kindValue;
    if (!url || !resolvedKind) return;
    this.started = true;
    this.setState('loading');

    if (this.opts.env.still) {
      this.showStill(url, resolvedKind);
      return;
    }
    if (isKnownBad(url)) {
      this.fail('failed to load just now');
      return;
    }
    switch (resolvedKind) {
      case 'image': this.startImage(url); break;
      case 'mjpeg': this.startMjpeg(url); break;
      case 'video': this.startVideo(url, false); break;
      case 'hls': this.startVideo(url, true); break;
      case 'youtube': this.startYoutube(url); break;
    }
    this.armTimeout(resolvedKind === 'youtube' ? Math.max(15, this.timeoutSeconds()) : this.timeoutSeconds());
  }

  /** Stop and let go of the source; the player can `show` again. */
  stop(): void {
    this.release();
    this.url = null;
    this.kindValue = null;
    this.started = false;
    this.setState('idle');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    this.onFail = null;
    this.onPlay = null;
    players.delete(this.opts.host);
  }

  /* ------------------------------------------------------------ internals */

  private timeoutSeconds(): number {
    return this.opts.layer.timeout ?? DEFAULT_MEDIA_TIMEOUT;
  }

  private setState(state: MediaPlayState): void {
    this.stateValue = state;
    this.opts.host.dataset['state'] = state;
  }

  private playing(): void {
    if (this.destroyed || this.stateValue === 'playing') return;
    this.setState('playing');
    this.reason = '';
    this.onPlay?.();
  }

  private fail(reason: string): void {
    if (this.destroyed || this.stateValue === 'failed') return;
    this.reason = reason;
    this.setState('failed');
    this.opts.host.title = reason;
    this.onFail?.(reason);
  }

  private release(): void {
    const all = this.releases;
    this.releases = [];
    for (const r of all.reverse()) {
      try {
        r();
      } catch {
        // Letting go must never throw a teardown off course.
      }
    }
    this.opts.host.replaceChildren();
    this.opts.host.style.backgroundImage = '';
    this.opts.host.removeAttribute('title');
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(fn, ms);
    this.releases.push(() => clearTimeout(t));
  }

  private every(ms: number, fn: () => void): void {
    const t = setInterval(fn, ms);
    this.releases.push(() => clearInterval(t));
  }

  private armTimeout(seconds: number): void {
    this.later(seconds * 1000, () => {
      if (this.stateValue === 'loading') this.fail(`nothing to show after ${seconds}s`);
    });
  }

  private img(): HTMLImageElement {
    const img = this.opts.env.doc.createElement('img');
    img.draggable = false;
    img.alt = '';
    img.style.objectFit = this.opts.layer.fit ?? 'contain';
    // An `<img>` keeps a stream open until it is collected; take the source
    // away explicitly so the connection closes now.
    this.releases.push(() => {
      img.onload = null;
      img.onerror = null;
      img.removeAttribute('src');
    });
    return img;
  }

  /**
   * A snapshot, double-buffered: the next frame loads out of sight and swaps
   * in only once it has decoded, so a refresh never flashes empty. A refresh
   * that fails keeps the last picture; two in a row count as a failure, and
   * the next good one recovers.
   */
  private startImage(url: string): void {
    const refresh = this.opts.layer.refresh ?? 0;
    const a = this.img();
    const b = this.img();
    a.className = 'bz-media-front';
    b.className = 'bz-media-back';
    this.opts.host.append(a, b);
    let front = a;
    let back = b;
    let misses = 0;

    const load = (): void => {
      const next = snapshotUrl(url, refresh);
      back.onload = () => {
        misses = 0;
        [front, back] = [back, front];
        front.className = 'bz-media-front';
        back.className = 'bz-media-back';
        this.playing();
      };
      back.onerror = () => {
        misses += 1;
        if (this.stateValue === 'loading' || misses >= 2) this.fail('the picture did not load');
      };
      back.src = next;
    };
    load();
    if (refresh > 0) this.every(refresh * 1000, load);
  }

  /**
   * A motion-JPEG stream in an `<img>`. Browsers do not agree on when — or
   * whether — `load` fires for a multipart stream, so a decoded frame is also
   * noticed by its size. A stream from Breeze's proxy shows the proxy's last
   * frame underneath while it connects.
   */
  private startMjpeg(url: string): void {
    const still = proxySnapshotOf(url);
    if (still) {
      const fit = this.opts.layer.fit ?? 'contain';
      this.opts.host.style.backgroundSize = fit === 'fill' ? '100% 100%' : fit;
      this.opts.host.style.backgroundImage = `url("${still}")`;
    }
    const img = this.img();
    img.className = 'bz-media-front';
    img.onload = () => this.playing();
    let retries = 0;
    img.onerror = () => {
      /*
       * A stream that played and then dropped is opened again rather than
       * left frozen on its last frame — a camera rebooting, a proxy's
       * upstream reconnecting. Three tries, then it has failed.
       */
      if (this.stateValue === 'playing' && retries < 3) {
        retries += 1;
        this.later(2000 * retries, () => {
          img.src = `${url}${url.includes('?') ? '&' : '?'}_bzr=${Date.now()}`;
        });
        return;
      }
      this.fail('the stream did not open');
    };
    this.opts.host.append(img);
    img.src = url;
    const poll = setInterval(() => {
      if (this.stateValue !== 'loading') {
        clearInterval(poll);
        return;
      }
      if (img.naturalWidth > 0) this.playing();
    }, 500);
    this.releases.push(() => clearInterval(poll));
  }

  private startVideo(url: string, hls: boolean): void {
    const doc = this.opts.env.doc;
    const video = doc.createElement('video');
    video.className = 'bz-media-front';
    video.muted = !this.opts.layer.audio;
    video.loop = !hls;
    video.playsInline = true;
    video.autoplay = true;
    video.preload = 'auto';
    video.style.objectFit = this.opts.layer.fit ?? 'contain';
    video.addEventListener('playing', () => this.playing());
    video.addEventListener('error', () => this.fail('the video did not play'));
    this.releases.push(() => {
      video.pause();
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // happy-dom and some embedded engines do not implement load().
      }
    });
    this.opts.host.append(video);

    const start = (): void => {
      const played = video.play();
      if (played && typeof played.catch === 'function') played.catch(() => undefined);
    };
    if (!hls || video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      start();
      return;
    }
    // Most engines a graphic plays in (OBS, vMix, Chrome) need hls.js.
    let cancelled = false;
    this.releases.push(() => {
      cancelled = true;
    });
    void loadHls(doc, this.opts.env.hlsScript).then((Hls) => {
      if (cancelled || this.destroyed) return;
      if (!Hls || !Hls.isSupported()) {
        this.fail('this browser cannot play HLS');
        return;
      }
      const player = new Hls({ lowLatencyMode: true });
      this.releases.push(() => player.destroy());
      player.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) this.fail(`HLS: ${data.details ?? 'stream error'}`);
      });
      player.loadSource(url);
      player.attachMedia(video);
      start();
    });
  }

  /**
   * YouTube, embedded muted with no controls, looping. The embed reports its
   * state over `postMessage` once asked to (`listening`) — no script from
   * YouTube is loaded into the graphic. Playing, or any sign of life by the
   * timeout, counts; only an error the player reports is a failure.
   */
  private startYoutube(url: string): void {
    const id = youtubeId(url);
    if (!id) {
      this.fail('not a YouTube address');
      return;
    }
    const doc = this.opts.env.doc;
    const view = doc.defaultView;
    const origin = view?.location?.origin && view.location.origin !== 'null' ? view.location.origin : '';
    const params = new URLSearchParams({
      autoplay: '1',
      mute: this.opts.layer.audio ? '0' : '1',
      controls: '0',
      disablekb: '1',
      fs: '0',
      iv_load_policy: '3',
      modestbranding: '1',
      playsinline: '1',
      rel: '0',
      loop: '1',
      playlist: id,
      enablejsapi: '1',
      ...(origin ? { origin } : {}),
    });
    const frame = doc.createElement('iframe');
    frame.className = 'bz-media-front';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture';
    frame.setAttribute('frameborder', '0');
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.src = `https://www.youtube-nocookie.com/embed/${id}?${params}`;
    this.releases.push(() => frame.removeAttribute('src'));

    let alive = false;
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frame.contentWindow) return;
      let data: { event?: string; info?: unknown } | null = null;
      try {
        data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (!data || typeof data !== 'object') return;
      alive = true;
      if (data.event === 'onError') this.fail(`YouTube error ${String(data.info)}`);
      const info = data.info as { playerState?: number } | number | undefined;
      const state = typeof info === 'number' ? info : info?.playerState;
      if ((data.event === 'onStateChange' || data.event === 'infoDelivery') && state === 1) this.playing();
    };
    view?.addEventListener('message', onMessage);
    this.releases.push(() => view?.removeEventListener('message', onMessage));
    frame.addEventListener('load', () => {
      frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*');
    });
    this.opts.host.append(frame);
    // Autoplay can be held back (a background tab, a policy) with nothing wrong.
    this.later(Math.max(15, this.timeoutSeconds()) * 1000 - 50, () => {
      if (this.stateValue === 'loading' && alive) this.playing();
    });
  }

  /**
   * One paused frame — a thumbnail. Nothing is streamed: a still of a rotation
   * would otherwise open every camera for the sake of a 200-pixel preview.
   */
  private showStill(url: string, kind: MediaKind): void {
    const picture =
      kind === 'image' ? url
      : kind === 'mjpeg' ? proxySnapshotOf(url)
      : kind === 'youtube' ? (youtubeId(url) ? `https://i.ytimg.com/vi/${youtubeId(url)}/hqdefault.jpg` : null)
      : null;
    if (!picture) return;
    const img = this.img();
    img.className = 'bz-media-front';
    img.onload = () => this.playing();
    this.opts.host.append(img);
    img.src = picture;
  }
}
