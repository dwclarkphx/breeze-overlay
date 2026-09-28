// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Media checks and the camera proxy (CYCLE.md, Wave 8).
 *
 * A source with `media` set is a list of cameras. Every `every` seconds each
 * row's URL is checked the way its kind needs — a snapshot fetched, one frame
 * read off a stream, a playlist read, YouTube asked whether the video can be
 * embedded — and the result goes back into the rows as four columns
 * (`MEDIA_COLUMNS`). A table filtering on `mediaOk` then simply does not have
 * the dead camera in it, on every output at once.
 *
 * **Frozen** is the failure a browser cannot see. A camera whose encoder has
 * hung keeps serving the same JPEG with a 200, and a stream keeps its
 * connection open sending nothing new; both look healthy to an `<img>`, and a
 * canvas cannot read the pixels of another origin's picture to tell. Here the
 * bytes are hashed, and a picture that has not changed for `frozenAfter`
 * seconds is frozen.
 *
 * **The proxy** plays snapshots and streams from this server. One connection
 * to a camera however many outputs show it (`StreamHub` fans the frames out),
 * no mixed-content or login trouble in the browser, and the last frame to show
 * at once while a stream connects. Only URLs that are rows of a checked
 * source can be proxied — the key is a hash of one — so this is not an open
 * relay for anything a caller cares to name.
 */

import { createHash } from 'node:crypto';

import {
  MEDIA_CHECK_DEFAULTS,
  MEDIA_COLUMNS,
  mediaKindOf,
  parseMediaKind,
  youtubeId,
  type DataColumn,
  type DataRow,
  type DataSet,
  type DataSourceDef,
  type MediaCheck,
  type MediaKind,
  type MediaRowStatus,
  type MediaState,
  type MediaSummary,
} from '@breeze/schema';

import { fetchStream } from '../data/fetch.js';
import { JpegSplitter, imageType } from './jpeg.js';

/** A URL with any login taken out — for anything that leaves the server. */
export function redactLogin(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
}

/** A URL's key: the proxy's address for it and the monitor's name for it. */
export function mediaKey(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 12);
}

export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_PLAYLIST_BYTES = 1024 * 1024;
/** A frame this fresh is served as it is rather than fetched again. */
const FRAME_FRESH_MS = 2000;
/** Checks running at once, per source. */
const CONCURRENCY = 4;
/** An upstream stream with nobody watching is closed after this long. */
const STREAM_LINGER_MS = 5000;
/** How long a failed proxy fetch is answered from memory. */
const FAILURE_HOLD_MS = 3000;
/** Frames hashed per second off a live stream — enough to see it freeze. */
const HASH_EVERY_MS = 1000;
/**
 * A stream that sends no frame for this long is closed. A camera connection
 * can hang open sending nothing, and every viewer would sit on the last frame
 * for ever; closed, the next viewer opens a fresh one.
 */
export const STREAM_STALL_MS = 20_000;
/** Reopenings of a dropped stream before its viewers are let go. */
const STREAM_RETRIES = 5;

export interface Frame {
  body: Buffer;
  type: string;
  at: number;
}

interface Target {
  key: string;
  url: string;
  kind: MediaKind;
  state: MediaState;
  error?: string;
  lastOk?: number;
  lastCheck?: number;
  hash?: string;
  /** When the current picture first appeared. */
  hashSince?: number;
  frame?: Frame;
  /** A fetch for the proxy in flight, shared by every request that wants it. */
  fetching?: Promise<Frame>;
  /** When a proxy fetch last failed — held briefly rather than retried per request. */
  failedAt?: number;
}

interface SourceMedia {
  projectId: string;
  sourceId: string;
  config: MediaCheck;
  targets: Map<string, Target>;
  timer?: NodeJS.Timeout;
  running?: Promise<void>;
  checkedAt?: number;
}

export interface MonitorOptions {
  /** How a URL is opened — `fetchStream`, replaced in tests. */
  open?: typeof fetchStream;
  now?: () => number;
  /** Each check, headers and body together. */
  checkTimeoutMs?: number;
  /** Where the proxy lives, for `mediaSrc`. */
  proxyBase?: string;
}

type ChangeListener = (projectId: string, sourceId: string) => void;

export class MediaMonitor {
  private readonly sources = new Map<string, SourceMedia>();
  private readonly hubs = new Map<string, StreamHub>();
  private readonly listeners = new Set<ChangeListener>();
  private readonly open: typeof fetchStream;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly proxyBase: string;
  private stopped = false;

  constructor(options: MonitorOptions = {}) {
    this.open = options.open ?? fetchStream;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.checkTimeoutMs ?? 10_000;
    this.proxyBase = options.proxyBase ?? '/media';
  }

  /** Told when a check changed what a source's rows say. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private id(projectId: string, sourceId: string): string {
    return `${projectId}/${sourceId}`;
  }

  /**
   * A source's rows or definition changed: follow its URLs. New URLs are
   * checked within a second; ones that left are forgotten; a source whose
   * definition no longer asks for checks stops being checked.
   */
  sync(projectId: string, def: DataSourceDef, data: DataSet): void {
    if (this.stopped) return;
    if (!def.media) {
      this.remove(projectId, def.id);
      return;
    }
    const id = this.id(projectId, def.id);
    let source = this.sources.get(id);
    const configChanged = source !== undefined && JSON.stringify(source.config) !== JSON.stringify(def.media);
    if (!source) {
      source = { projectId, sourceId: def.id, config: def.media, targets: new Map() };
      this.sources.set(id, source);
    }
    source.config = def.media;

    const next = new Map<string, Target>();
    let added = false;
    for (const row of data.rows) {
      const found = this.urlOf(row, def.media);
      if (!found) continue;
      const key = mediaKey(found.url);
      // The same camera twice is one camera: the first row's kind stands.
      if (next.has(key)) continue;
      const had = source.targets.get(key);
      if (had && had.kind === found.kind) {
        next.set(key, had);
        continue;
      }
      next.set(key, { key, url: found.url, kind: found.kind, state: 'unchecked' });
      added = true;
    }
    for (const [key, hub] of this.hubs) {
      if (key.startsWith(`${id}/`) && !next.has(key.slice(id.length + 1))) {
        hub.close(new Error('no longer in the source'));
        this.hubs.delete(key);
      }
    }
    source.targets = next;
    if (added || configChanged) this.scheduleRound(source, 500);
    else if (!source.timer && !source.running) this.scheduleRound(source, this.everyMs(source));
  }

  private urlOf(row: DataRow, config: MediaCheck): { url: string; kind: MediaKind } | null {
    const raw = row[config.column];
    const url = raw === null || raw === undefined ? '' : String(raw).trim();
    if (!url) return null;
    const written = config.kindColumn ? parseMediaKind(row[config.kindColumn]) : null;
    return { url, kind: written ?? mediaKindOf(url) };
  }

  private everyMs(source: SourceMedia): number {
    return Math.max(MEDIA_CHECK_DEFAULTS.minEvery, source.config.every ?? MEDIA_CHECK_DEFAULTS.every) * 1000;
  }

  remove(projectId: string, sourceId: string): void {
    const id = this.id(projectId, sourceId);
    const source = this.sources.get(id);
    if (source?.timer) clearTimeout(source.timer);
    this.sources.delete(id);
    for (const [key, hub] of this.hubs) {
      if (key.startsWith(`${id}/`)) {
        hub.close(new Error('source removed'));
        this.hubs.delete(key);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    for (const source of this.sources.values()) if (source.timer) clearTimeout(source.timer);
    this.sources.clear();
    for (const hub of this.hubs.values()) hub.close(new Error('server stopping'));
    this.hubs.clear();
    this.listeners.clear();
  }

  /* ---------------------------------------------------------------- rows */

  /**
   * The rows with their media columns. A URL not checked yet counts as ok —
   * a camera list that went on air before its first round must not be empty.
   */
  decorate(projectId: string, sourceId: string, data: DataSet): DataSet {
    const source = this.sources.get(this.id(projectId, sourceId));
    if (!source) return data;
    const proxy = source.config.proxy !== false;
    const known = new Set(data.columns.map((c) => c.key));
    const added: DataColumn[] = [
      { key: MEDIA_COLUMNS.state, type: 'string' },
      { key: MEDIA_COLUMNS.ok, type: 'boolean' },
      { key: MEDIA_COLUMNS.src, type: 'string' },
      { key: MEDIA_COLUMNS.kind, type: 'string' },
    ].filter((c) => !known.has(c.key)) as DataColumn[];
    const rows = data.rows.map((row) => {
      const found = this.urlOf(row, source.config);
      const target = found ? source.targets.get(mediaKey(found.url)) : undefined;
      if (!found || !target) {
        return { ...row, [MEDIA_COLUMNS.state]: 'failed', [MEDIA_COLUMNS.ok]: false, [MEDIA_COLUMNS.src]: '', [MEDIA_COLUMNS.kind]: found?.kind ?? '' };
      }
      const proxied = proxy && (target.kind === 'image' || target.kind === 'mjpeg');
      /*
       * Through the proxy the login never needs to leave the server — so it
       * does not: the URL column goes out with it taken out. Rows reach every
       * output, and /play inlines them.
       */
      const own = proxied && found.url !== redactLogin(found.url) ? { [source.config.column]: redactLogin(found.url) } : {};
      const src = proxied
        ? `${this.proxyBase}/${encodeURIComponent(projectId)}/${encodeURIComponent(sourceId)}/${target.key}/${target.kind === 'image' ? 'snapshot' : 'stream'}`
        : target.url;
      return {
        ...row,
        ...own,
        [MEDIA_COLUMNS.state]: target.state,
        [MEDIA_COLUMNS.ok]: target.state === 'ok' || target.state === 'unchecked',
        [MEDIA_COLUMNS.src]: src,
        [MEDIA_COLUMNS.kind]: target.kind,
      };
    });
    return { ...data, columns: [...data.columns, ...added], rows };
  }

  summary(projectId: string, sourceId: string): MediaSummary | undefined {
    const source = this.sources.get(this.id(projectId, sourceId));
    if (!source) return undefined;
    const out: MediaSummary = { ok: 0, failed: 0, frozen: 0, unchecked: 0 };
    for (const t of source.targets.values()) out[t.state] += 1;
    if (source.checkedAt !== undefined) out.checkedAt = new Date(source.checkedAt).toISOString();
    return out;
  }

  rows(projectId: string, sourceId: string): MediaRowStatus[] {
    const source = this.sources.get(this.id(projectId, sourceId));
    if (!source) return [];
    return [...source.targets.values()].map((t) => ({
      key: t.key,
      url: redactLogin(t.url),
      kind: t.kind,
      state: t.state,
      ...(t.error ? { error: redactLogin(t.error) } : {}),
      ...(t.lastOk !== undefined ? { lastOk: new Date(t.lastOk).toISOString() } : {}),
      ...(t.lastCheck !== undefined ? { lastCheck: new Date(t.lastCheck).toISOString() } : {}),
      ...(t.hashSince !== undefined ? { lastChange: new Date(t.hashSince).toISOString() } : {}),
    }));
  }

  /** The URL a proxy key stands for, in this source — or nothing, for any other key. */
  target(projectId: string, sourceId: string, key: string): { url: string; kind: MediaKind } | undefined {
    const t = this.sources.get(this.id(projectId, sourceId))?.targets.get(key);
    return t ? { url: t.url, kind: t.kind } : undefined;
  }

  /* -------------------------------------------------------------- checks */

  /** Check every row now; resolves when the round is done. */
  async checkNow(projectId: string, sourceId: string): Promise<void> {
    const source = this.sources.get(this.id(projectId, sourceId));
    if (!source) return;
    if (source.running) await source.running;
    await this.round(source);
  }

  private scheduleRound(source: SourceMedia, delayMs: number): void {
    if (this.stopped) return;
    if (source.timer) clearTimeout(source.timer);
    source.timer = setTimeout(() => {
      source.timer = undefined;
      void this.round(source);
    }, delayMs);
    // Checks never keep the process alive on their own, as the registry's polls do not.
    source.timer.unref?.();
  }

  private async round(source: SourceMedia): Promise<void> {
    if (this.stopped) return;
    if (source.running) return source.running;
    const run = (async () => {
      const targets = [...source.targets.values()];
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < targets.length) {
          const t = targets[next++]!;
          await this.check(t, source);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
      source.checkedAt = this.now();
      // Every round, not only a changed one: the status carries when it ran.
      // Publishing rows that did not change pushes nothing. Only if still
      // current — a removed source's round finishing is not news.
      if (this.sources.get(this.id(source.projectId, source.sourceId)) === source) {
        for (const listener of this.listeners) listener(source.projectId, source.sourceId);
      }
    })();
    source.running = run;
    try {
      await run;
    } finally {
      source.running = undefined;
      if (this.sources.get(this.id(source.projectId, source.sourceId)) === source) {
        this.scheduleRound(source, this.everyMs(source));
      }
    }
  }

  /** One URL, checked the way its kind needs. Never throws. */
  private async check(t: Target, source: SourceMedia): Promise<void> {
    const at = this.now();
    try {
      if (t.kind === 'image' || t.kind === 'mjpeg') {
        // A stream already open through the proxy is its own proof of life.
        const hub = this.hubs.get(`${this.id(source.projectId, source.sourceId)}/${t.key}`);
        const live = hub?.lastFrame && at - hub.lastFrame.at < FRAME_FRESH_MS * 5 ? hub.lastFrame : null;
        if (!live) this.record(t, await this.grab(t));
      } else if (t.kind === 'video') {
        await this.probe(t.url, { range: 'bytes=0-65535' });
      } else if (t.kind === 'hls') {
        const text = (await this.readAll(t.url, MAX_PLAYLIST_BYTES)).toString('utf8');
        if (!text.includes('#EXTM3U')) throw new Error('not an HLS playlist');
      } else {
        await this.checkYoutube(t.url);
      }
      t.lastOk = at;
      delete t.error;
      t.state = this.frozen(t, source, at) ? 'frozen' : 'ok';
      if (t.state === 'frozen') t.error = 'the picture has not changed';
    } catch (err) {
      t.error = err instanceof Error ? err.message : String(err);
      t.state = 'failed';
    } finally {
      t.lastCheck = at;
    }
  }

  private frozen(t: Target, source: SourceMedia, now: number): boolean {
    const after = source.config.frozenAfter ?? MEDIA_CHECK_DEFAULTS.frozenAfter;
    if (!after || t.hashSince === undefined) return false;
    return now - t.hashSince >= after * 1000;
  }

  private record(t: Target, frame: Frame): void {
    const hash = createHash('sha1').update(frame.body).digest('hex');
    if (hash !== t.hash) {
      t.hash = hash;
      t.hashSince = frame.at;
    }
    t.frame = frame;
  }

  /** Open with the overall check timeout covering the body too. */
  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fn(controller.signal);
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`no answer within ${Math.round(this.timeoutMs / 1000)}s`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async probe(url: string, { range }: { range?: string } = {}): Promise<void> {
    await this.withTimeout(async (signal) => {
      const res = await this.open(url, { signal, timeoutMs: this.timeoutMs, ...(range ? { headers: { range } } : {}) });
      await res.body?.cancel().catch(() => undefined);
    });
  }

  private async readAll(url: string, max: number): Promise<Buffer> {
    return this.withTimeout(async (signal) => {
      const res = await this.open(url, { signal, timeoutMs: this.timeoutMs });
      return readCapped(res, max);
    });
  }

  /** One picture: the snapshot, or the first frame of a stream. */
  private async grab(t: { url: string; kind: MediaKind }): Promise<Frame> {
    return this.withTimeout(async (signal) => {
      const res = await this.open(t.url, { signal, timeoutMs: this.timeoutMs });
      // Whatever the camera calls its stream — multipart, x-motion-jpeg, nothing
      // — or a single JPEG: the first whole frame in the bytes.
      if (t.kind === 'mjpeg') {
        const frame = await firstJpeg(res);
        return { body: frame, type: 'image/jpeg', at: this.now() };
      }
      const body = await readCapped(res, MAX_SNAPSHOT_BYTES);
      const type = imageType(body);
      if (!type) throw new Error('not a picture');
      return { body, type, at: this.now() };
    });
  }

  private async checkYoutube(url: string): Promise<void> {
    const id = youtubeId(url);
    if (!id) throw new Error('not a YouTube address');
    const oembed = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
    try {
      await this.probe(oembed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/HTTP 40[13]/.test(message)) throw new Error('the owner does not allow this video to be embedded');
      if (/HTTP 404/.test(message)) throw new Error('no such video, or it is private');
      throw err;
    }
  }

  /* --------------------------------------------------------------- proxy */

  /**
   * A picture for the proxy: the frame just fetched if it is fresh, else a
   * new one — one fetch however many outputs ask at the same moment. Feeds
   * the frozen check too, so a snapshot shown every ten seconds is watched
   * every ten seconds.
   */
  async snapshot(projectId: string, sourceId: string, key: string): Promise<Frame> {
    const source = this.sources.get(this.id(projectId, sourceId));
    const t = source?.targets.get(key);
    // Only a picture: a video, a playlist or an embed is played from where it is.
    if (!source || !t || (t.kind !== 'image' && t.kind !== 'mjpeg')) throw new NotProxied();
    const now = this.now();
    const hub = this.hubs.get(`${this.id(projectId, sourceId)}/${key}`);
    if (hub?.lastFrame && now - hub.lastFrame.at < FRAME_FRESH_MS) return hub.lastFrame;
    if (t.frame && now - t.frame.at < FRAME_FRESH_MS) return t.frame;
    // A camera that just failed is not asked again by every output that refreshes.
    if (t.failedAt !== undefined && now - t.failedAt < FAILURE_HOLD_MS) throw new Error(t.error ?? 'the camera is down');
    /*
     * A stream's still comes off the stream's shared connection — opened for
     * it if nobody is watching, and closed again shortly after — so a page
     * showing the proxy's frame while its stream connects does not cost a
     * cheap camera a second connection.
     */
    if (t.kind === 'mjpeg') {
      try {
        const frame = await this.stream(projectId, sourceId, key).nextFrame(this.timeoutMs);
        delete t.failedAt;
        return frame;
      } catch (err) {
        t.failedAt = this.now();
        t.error = 'the stream sent no picture';
        throw err instanceof Error && err.message !== 'no frame yet' ? err : new Error(t.error);
      }
    }
    if (!t.fetching) {
      t.fetching = this.grab(t)
        .then((frame) => {
          this.record(t, frame);
          delete t.failedAt;
          return frame;
        }, (err: unknown) => {
          t.failedAt = this.now();
          throw err;
        })
        .finally(() => {
          t.fetching = undefined;
        });
    }
    return t.fetching;
  }

  /** The shared upstream for a stream, opened on first use. */
  stream(projectId: string, sourceId: string, key: string): StreamHub {
    const source = this.sources.get(this.id(projectId, sourceId));
    const t = source?.targets.get(key);
    if (!source || !t || t.kind !== 'mjpeg') throw new NotProxied();
    const id = `${this.id(projectId, sourceId)}/${key}`;
    let hub = this.hubs.get(id);
    if (!hub) {
      let hashedAt = 0;
      hub = new StreamHub(t.url, this.open, this.now, (frame) => {
        if (frame.at - hashedAt < HASH_EVERY_MS) return;
        hashedAt = frame.at;
        this.record(t, frame);
      }, () => {
        if (this.hubs.get(id) === hub) this.hubs.delete(id);
      });
      this.hubs.set(id, hub);
    }
    return hub;
  }

  /** Open upstream streams — for the status page and tests. */
  get openStreams(): number {
    return [...this.hubs.values()].filter((h) => h.connected).length;
  }
}

/** A key this monitor does not know: not a row of a checked source. */
export class NotProxied extends Error {
  constructor() {
    super('not a camera of this source');
  }
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`over the ${max}-byte limit`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`over the ${max}-byte limit`);
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

async function firstJpeg(res: Response): Promise<Buffer> {
  if (!res.body) throw new Error('the stream sent nothing');
  const reader = res.body.getReader();
  const splitter = new JpegSplitter();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error('the stream ended before a whole frame');
      const frames = splitter.push(value);
      if (frames.length) return frames[0]!;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/* ------------------------------------------------------------ stream hub */

/** What a proxied stream writes to — an HTTP response, in practice. */
export interface StreamClient {
  write(chunk: Buffer): boolean;
  end(): void;
  once(event: 'drain', cb: () => void): unknown;
}

export const STREAM_BOUNDARY = 'breezeframe';

/**
 * One upstream motion-JPEG connection, fanned out to every client watching.
 *
 * Frames are re-wrapped in a multipart body of our own rather than passed
 * through, so a camera's odd boundary or missing lengths reach no browser.
 * A client that cannot keep up misses frames rather than buffering them: a
 * picture from a minute ago is worse than a skipped one.
 *
 * **An upstream that drops or stalls is reopened** while anyone is watching,
 * backing off from a second to half a minute, and the viewers' connections
 * stay open through it — they see the last frame, then the camera again. An
 * `<img>` whose stream ended would sit on its last frame for ever with no
 * error to act on. Only after five failed reopenings are the viewers let go,
 * and their pages then see the failure.
 */
export class StreamHub {
  lastFrame: Frame | null = null;
  connected = false;
  /** Closed and not coming back — the next request opens a new hub. */
  closedForGood = false;
  private readonly clients = new Map<StreamClient, { busy: boolean }>();
  private controller: AbortController | null = null;
  private linger: NodeJS.Timeout | null = null;
  private running = false;
  private retries = 0;
  private waiters: Array<{ resolve: (f: Frame) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  private wake: (() => void) | null = null;

  constructor(
    private readonly url: string,
    private readonly open: typeof fetchStream,
    private readonly now: () => number,
    private readonly onFrame: (frame: Frame) => void,
    private readonly onClosed: () => void,
  ) {}

  add(client: StreamClient): void {
    if (this.closedForGood) {
      client.end();
      return;
    }
    if (this.linger) clearTimeout(this.linger);
    this.linger = null;
    this.clients.set(client, { busy: false });
    // The last frame straight away, so a new viewer is not looking at nothing.
    if (this.lastFrame) this.send(client, this.lastFrame.body);
    if (!this.running) void this.run();
  }

  remove(client: StreamClient): void {
    this.clients.delete(client);
    if (this.clients.size === 0 && !this.linger && !this.closedForGood) {
      this.linger = setTimeout(() => this.close(null), STREAM_LINGER_MS);
    }
  }

  get viewers(): number {
    return this.clients.size;
  }

  /** The next frame to arrive — for a snapshot asked for while the stream connects. */
  nextFrame(timeoutMs: number): Promise<Frame> {
    if (this.closedForGood) return Promise.reject(new Error('stream closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error('no frame yet'));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
      if (!this.running) void this.run();
    });
  }

  close(err: Error | null): void {
    if (this.closedForGood) return;
    this.closedForGood = true;
    void err;
    if (this.linger) clearTimeout(this.linger);
    this.controller?.abort();
    this.wake?.();
    for (const client of this.clients.keys()) client.end();
    this.clients.clear();
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('stream closed'));
    }
    this.waiters = [];
    this.connected = false;
    this.onClosed();
  }

  private send(client: StreamClient, frame: Buffer): void {
    const state = this.clients.get(client);
    if (!state || state.busy) return;
    const head = Buffer.from(`--${STREAM_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    const ok = client.write(Buffer.concat([head, frame, Buffer.from('\r\n')]));
    if (!ok) {
      state.busy = true;
      client.once('drain', () => {
        const s = this.clients.get(client);
        if (s) s.busy = false;
      });
    }
  }

  private deliver(body: Buffer): void {
    const frame = { body, type: 'image/jpeg', at: this.now() };
    this.lastFrame = frame;
    this.retries = 0;
    this.onFrame(frame);
    for (const client of this.clients.keys()) this.send(client, body);
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) {
      clearTimeout(w.timer);
      w.resolve(frame);
    }
    // Opened only for a still: let it go shortly, as if its last viewer had left.
    if (this.clients.size === 0 && !this.linger && !this.closedForGood) {
      this.linger = setTimeout(() => this.close(null), STREAM_LINGER_MS);
    }
  }

  /** One connection's life: open, split, deliver, until it ends, fails or stalls. */
  private async once(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    let stall: NodeJS.Timeout | null = null;
    const watch = (): void => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => controller.abort(), STREAM_STALL_MS);
    };
    try {
      watch();
      const res = await this.open(this.url, { signal: controller.signal });
      if (!res.body) return;
      this.connected = true;
      const splitter = new JpegSplitter();
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const body of splitter.push(value)) {
          watch();
          this.deliver(body);
        }
      }
    } catch {
      // Ended, failed or stalled: the caller decides whether to go again.
    } finally {
      if (stall) clearTimeout(stall);
      this.connected = false;
      controller.abort();
    }
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      while (!this.closedForGood) {
        await this.once();
        if (this.closedForGood) break;
        // Nobody left watching or waiting: nothing to reopen for.
        if (this.clients.size === 0 && this.waiters.length === 0) {
          this.close(null);
          break;
        }
        this.retries += 1;
        if (this.retries > STREAM_RETRIES) {
          this.close(new Error('the camera stream keeps failing'));
          break;
        }
        const delay = Math.min(30_000, 1000 * 2 ** (this.retries - 1));
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = null;
      }
    } finally {
      this.running = false;
    }
  }
}
