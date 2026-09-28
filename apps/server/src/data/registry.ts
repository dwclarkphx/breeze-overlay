// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * DataSet cache, poller and push.
 *
 * The rules this exists to enforce, in the order they matter on air:
 *
 *  1. **A dead feed never blanks a graphic.** Last-good data survives an origin
 *     outage, a DNS failure and a server restart mid-show. An error updates the
 *     status the editor shows; it does not touch the rows.
 *  2. **Push only on change.** A source polled every five seconds must not
 *     re-render a table every five seconds. A SHA-256 of the normalised content
 *     decides, so an origin that re-serialises its JSON with different key order
 *     — which several do — still counts as unchanged.
 *  3. **One slow origin cannot starve the loop.** Per-source timers, per-source
 *     timeouts, exponential backoff on failure.
 *
 * And, since Wave 5 (CYCLE.md), two rules about data that arrives but is wrong:
 *
 *  4. **A fetch must pass its guard to go on air.** One that fails it is treated
 *     like one that failed to connect — rule 1 applies.
 *  5. **What is on air is not always the source's own rows.** `own` is this
 *     source's last-good; `data` is what is served under its id — `own`, or
 *     its backup's rows when `own` has nothing fit to show or an operator has
 *     said so. Everything that reads `data` (pages, places lookups, the editor)
 *     sees what the audience sees.
 */

import { createHash } from 'node:crypto';

import {
  GUARD_DROP_CONFIRMATIONS,
  applyGuard,
  emptyDataSet,
  conform,
  placesFromRows,
  placesSourceOf,
  pollFloor,
  type DataSet,
  type DataSourceDef,
  type DataSourceStatus,
  type PlaceRef,
  type SourceUse,
  type UrlDataSource,
} from '@breeze/schema';

import { config } from '../config.js';
import { loadAirQuality } from './airquality.js';
import { capDueIn, capToDataSet } from './cap.js';
import { fetchText, userAgent } from './fetch.js';
import { ftpToDataSet } from './ftp.js';
import { csvToDataSet, jsonToDataSet } from './parse.js';
import { feedToDataSet, xmlToDataSet } from './parse-xml.js';
import { resolveSheetsCredential, sheetsToDataSet } from './sheets.js';
import { effectiveExpiry, effectiveInterval, readDataSources } from './sources.js';
import { loadWeather } from './weather.js';

/**
 * What a load can see of the rest of the project: another source's current
 * rows, for a `placesFrom` table. Absent in contexts with no registry — the
 * editor's preview of an unsaved def — where a table-fed source says so.
 */
export interface LoadContext {
  lookup?: (sourceId: string) => DataSet | undefined;
}

/** Resolve a `placesFrom` table to places, or undefined when it has not loaded. */
function resolvePlaces(def: DataSourceDef, ctx: LoadContext): PlaceRef[] | undefined {
  if (def.type !== 'weather' && def.type !== 'air-quality') return undefined;
  const from = def.placesFrom;
  if (!from) return undefined;
  const table = ctx.lookup?.(from.source);
  if (!table || table.rows.length === 0) return undefined;
  const { source: _source, ...map } = from;
  return placesFromRows(table.rows, map);
}

/** A comparable form of a source's resolved places — undefined for sources without a table. */
function placesSignature(def: DataSourceDef, ctx: LoadContext): string | undefined {
  if (placesSourceOf(def) === undefined) return undefined;
  return JSON.stringify(resolvePlaces(def, ctx) ?? null);
}

export interface DataEntry {
  projectId: string;
  def: DataSourceDef;
  /** What is on air under this source's id: `own`, emptied, or the backup's rows. */
  data: DataSet;
  /** This source's own last-good rows. */
  own: DataSet;
  /** Content hash of `own` — `hash` is of `data`. */
  ownHash: string;
  /** `own` has been loaded at least once. Until then there is nothing of its own to publish. */
  ownLoaded?: boolean;
  /** An operator's override (`use`). Absent is automatic. Held in memory: a restart is automatic again. */
  use?: 'primary' | 'backup';
  /** A refused row-count drop, watched to see whether it holds — `hash` is the row count it fell to. */
  dropHold?: { hash: string; count: number };
  status: DataSourceStatus;
  /** Conditional-request state from the last successful fetch. */
  etag?: string | undefined;
  lastModified?: string | undefined;
  hash: string;
  /**
   * CAP only: the last body fetched, so that while the origin is unreachable
   * the alerts can still be re-read against the clock and an expired warning
   * still leaves the screen. Last-good must never mean "last-good forever" for
   * something with an end time written into it.
   */
  body?: string | undefined;
  /** The fetch in flight, so a second caller waits on it rather than racing it. */
  inflight?: Promise<DataEntry> | undefined;
  /** Set while in flight when the places table changed under it: run again after. */
  rerun?: boolean;
  /** The places the last fetch was started with, for `placesFrom` sources. */
  placesSig?: string | undefined;
}

export type DataPushListener = (projectId: string, data: DataSet) => void;

/** A fetch the guard refused — reported like a failed fetch, with the guard's reason. */
export class GuardRefusal extends Error {
  constructor(reason: string) {
    super(`refused by guard: ${reason}`);
    this.name = 'GuardRefusal';
  }
}

/** What `served` resolves to: the rows, whose they are, and whether they are fit to show. */
interface Served {
  data: DataSet;
  from: string;
  usable: boolean;
}

/** Backoff schedule, in multiples of the source's own interval. */
const BACKOFF_STEPS = [1, 2, 4, 8, 15, 30];

export function backoffMultiplier(failures: number): number {
  if (failures <= 0) return 1;
  return BACKOFF_STEPS[Math.min(failures, BACKOFF_STEPS.length) - 1] ?? 30;
}

/**
 * Content hash of a DataSet, ignoring anything that changes without the data
 * changing. `fetchedAt` moves on every poll and `revision` is derived from this
 * very hash, so including either would make every source look permanently dirty.
 */
export function hashDataSet(data: DataSet): string {
  const canonical = JSON.stringify({
    columns: data.columns.map((c) => [c.key, c.type]),
    rows: data.rows.map((row) =>
      Object.keys(row)
        .sort()
        .map((k) => [k, row[k]]),
    ),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Turn a definition plus a fetched body into a DataSet. */
export async function loadDataSource(def: DataSourceDef, prior?: DataEntry, ctx: LoadContext = {}): Promise<{
  data: DataSet | null;
  etag?: string | undefined;
  lastModified?: string | undefined;
  /** A partial success — see DataSourceStatus.warning. */
  warning?: string | undefined;
  /**
   * CAP only: the body just fetched. Handed back rather than stored on
   * `prior`, so the registry keeps it only once the guard has accepted it — a
   * refused body must not become the one alerts are re-read from.
   */
  body?: string | undefined;
}> {
  if (def.type === 'manual') {
    return { data: { id: def.id, columns: def.columns, rows: conform(def.rows, def.columns) } };
  }

  /*
   * Sheets addresses its origin by spreadsheet id, not URL, and mints its own
   * bearer token from a service-account key — so it takes neither the shared
   * fetch below nor the shared secret lookup. It also cannot use conditional
   * requests: `values.get` does not answer with an ETag, and the content hash in
   * `ingest` is what suppresses a no-op push for it instead.
   */
  if (def.type === 'sheets') {
    const credential = resolveSheetsCredential(def.secretId);
    const data = await sheetsToDataSet(def.id, def.spreadsheet, {
      ...(def.range ? { range: def.range } : {}),
      ...(def.header !== undefined ? { header: def.header } : {}),
      ...(def.columns ? { columns: def.columns } : {}),
      apiKey: credential.apiKey,
      serviceAccount: credential.serviceAccount,
    });
    return { data };
  }

  /*
   * Weather and FTP address their origins the same way Sheets does — by
   * something that is not a URL — so they take neither the shared fetcher nor
   * the shared conditional-request state. Neither origin supports conditional
   * requests usefully in any case: NWS needs two round trips whose first answer
   * has its own ETag, and an FTP listing has none at all. The content hash in
   * `ingest` is what suppresses a no-op push for both.
   */
  /*
   * Weather and air quality can report on many places, read from another
   * source's rows. The prior rows go in too: a place that fails keeps its
   * last-good rows rather than dropping out of the rotation.
   */
  if (def.type === 'weather' || def.type === 'air-quality') {
    // Its *own* last-good: `data` may be a backup's rows, or blank while
    // expired, and neither is what a failed place should fall back to.
    const placeCtx = { places: resolvePlaces(def, ctx), prior: prior?.ownLoaded ? prior.own : undefined };
    const result = def.type === 'weather' ? await loadWeather(def, placeCtx) : await loadAirQuality(def, placeCtx);
    return { data: result.data, warning: result.warning };
  }

  if (def.type === 'ftp') {
    return { data: await ftpToDataSet(def) };
  }

  const secret = def.secretId ? config.dataSecrets[def.secretId] : undefined;
  if (def.secretId && !secret) {
    throw new Error(
      `secret "${def.secretId}" is not configured on this server (set BREEZE_DATA_SECRETS or BREEZE_DATA_SECRETS_FILE)`,
    );
  }

  /*
   * CAP names who is asking, like the weather adapter: NWS's alerts API is the
   * same service and refuses the same anonymous traffic. The def's own
   * headers still win, for an operator who has been told to send something
   * specific.
   */
  const headers: Record<string, string> = {
    ...(def.type === 'cap' ? { 'user-agent': userAgent(def.contact) } : {}),
    ...(def.headers ?? {}),
  };

  /*
   * No conditional request for CAP. Its rows depend on the clock as well as the
   * body — an alert drops out when it expires whether or not the feed changed —
   * so a 304 that skipped the parse would leave an ended warning on air. The
   * content hash still stops an unchanged result from being pushed.
   */
  const conditional = def.type !== 'cap';
  const result = await fetchText(def.url, {
    headers,
    etag: conditional ? prior?.etag : undefined,
    lastModified: conditional ? prior?.lastModified : undefined,
    bearerToken: secret,
  });

  // 304: the origin says nothing changed. Believe it and skip the parse.
  if (result.body === null) {
    return { data: null, etag: result.etag, lastModified: result.lastModified };
  }

  const data = parseBody(def, result.body);
  return {
    data,
    etag: result.etag,
    lastModified: result.lastModified,
    ...(def.type === 'cap' ? { body: result.body } : {}),
  };
}

/** Body → DataSet for the URL-addressed adapters. Split out so it is testable. */
function parseBody(def: UrlDataSource, body: string): DataSet {
  switch (def.type) {
    case 'http-csv':
      return csvToDataSet(def.id, body, {
        ...(def.delimiter ? { delimiter: def.delimiter } : {}),
        ...(def.header !== undefined ? { header: def.header } : {}),
        ...(def.columns ? { columns: def.columns } : {}),
      });
    case 'http-json':
      return jsonToDataSet(def.id, JSON.parse(body), {
        ...(def.rowPath !== undefined ? { rowPath: def.rowPath } : {}),
        ...(def.columns ? { columns: def.columns } : {}),
      });
    case 'rss':
      return feedToDataSet(def.id, body, {
        ...(def.columns ? { columns: def.columns } : {}),
      });
    case 'xml':
      return xmlToDataSet(def.id, body, {
        ...(def.rowPath !== undefined ? { rowPath: def.rowPath } : {}),
        ...(def.columns ? { columns: def.columns } : {}),
      });
    case 'cap':
      return capToDataSet(def, body);
    default: {
      const exhaustive: never = def;
      throw new Error(`unknown data source type ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * What the registry needs from the media checks (Wave 8, `media/monitor.ts`):
 * to be told a source's rows, and to add the check's columns to them.
 */
export interface MediaDecorator {
  sync(projectId: string, def: DataSourceDef, data: DataSet): void;
  decorate(projectId: string, sourceId: string, data: DataSet): DataSet;
  summary(projectId: string, sourceId: string): DataSourceStatus['media'];
  remove(projectId: string, sourceId: string): void;
  onChange(listener: (projectId: string, sourceId: string) => void): () => void;
}

export class DataRegistry {
  private entries = new Map<string, DataEntry>();
  private media: MediaDecorator | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  private listeners = new Set<DataPushListener>();
  private stopped = false;

  private key(projectId: string, sourceId: string): string {
    return `${projectId}/${sourceId}`;
  }

  /**
   * Media checks for sources that ask for them: their rows are published with
   * the check's columns, and published again whenever a check changes them.
   */
  attachMedia(media: MediaDecorator): void {
    this.media = media;
    media.onChange((projectId, sourceId) => {
      const entry = this.entries.get(this.key(projectId, sourceId));
      if (entry) this.publish(entry);
    });
  }

  onPush(listener: DataPushListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Load a project's defs and start (or restart) their timers. */
  async register(projectId: string): Promise<void> {
    const defs = await readDataSources(projectId);
    const wanted = new Set(defs.map((d) => this.key(projectId, d.id)));

    // Sources removed from the file stop polling and drop their cache.
    for (const key of [...this.entries.keys()]) {
      if (!key.startsWith(`${projectId}/`) || wanted.has(key)) continue;
      this.clearTimer(key);
      const gone = this.entries.get(key)!;
      this.entries.delete(key);
      this.media?.remove(projectId, gone.def.id);
      this.republishBackedBy(projectId, gone.def.id);
    }

    for (const def of defs) await this.upsert(projectId, def);
  }

  async upsert(projectId: string, def: DataSourceDef): Promise<DataEntry> {
    const key = this.key(projectId, def.id);
    const existing = this.entries.get(key);

    const entry: DataEntry = existing
      ? // A fetch in flight belongs to the old object; this one starts clean,
        // with a status of its own for that fetch to leave alone.
        { ...existing, def, projectId, status: { ...existing.status }, inflight: undefined, rerun: false }
      : {
          projectId,
          def,
          data: emptyDataSet(def.id),
          own: emptyDataSet(def.id),
          ownHash: '',
          status: { id: def.id, revision: 0, rowCount: 0 },
          hash: '',
        };
    // Forcing a backup that is no longer configured would force nothing.
    if (entry.use === 'backup' && def.fallback === undefined) {
      delete entry.use;
      delete entry.status.use;
    }
    this.entries.set(key, entry);

    // A manual source needs no fetch — its rows are the definition.
    if (def.type === 'manual') {
      this.clearTimer(key);
      this.ingest(entry, { id: def.id, columns: def.columns, rows: conform(def.rows, def.columns) });
      return entry;
    }

    // A changed backup setting may change what is on air before any fetch.
    this.publish(entry);
    this.schedule(projectId, def.id, 0);
    return entry;
  }

  remove(projectId: string, sourceId: string): void {
    const key = this.key(projectId, sourceId);
    this.clearTimer(key);
    this.entries.delete(key);
    this.media?.remove(projectId, sourceId);
    this.republishBackedBy(projectId, sourceId);
  }

  /** Sources whose backup is `sourceId` look again at what they serve. */
  private republishBackedBy(projectId: string, sourceId: string): void {
    for (const other of this.entries.values()) {
      if (other.projectId === projectId && other.def.fallback === sourceId) this.publish(other);
    }
  }

  /**
   * An operator's choice (`use`): `backup` puts the backup's rows on air
   * whatever state this source is in, `primary` keeps this source's own even
   * when it has nothing, `auto` hands the choice back to the rules.
   *
   * In memory only. A restart is back to automatic, which is the state an
   * operator arriving to a restarted server expects to find.
   */
  setUse(projectId: string, sourceId: string, use: SourceUse): DataEntry {
    const entry = this.entries.get(this.key(projectId, sourceId));
    if (!entry) throw new Error(`data source "${sourceId}" is not registered`);
    if (use === 'auto') {
      delete entry.use;
      delete entry.status.use;
    } else {
      entry.use = use;
      entry.status.use = use;
    }
    this.publish(entry);
    return entry;
  }

  get(projectId: string, sourceId: string): DataEntry | undefined {
    return this.entries.get(this.key(projectId, sourceId));
  }

  list(projectId: string): DataEntry[] {
    return [...this.entries.values()].filter((e) => e.projectId === projectId);
  }

  /** DataSets for a project, keyed by source id — inlined into /play pages. */
  datasets(projectId: string): Record<string, DataSet> {
    const out: Record<string, DataSet> = {};
    for (const entry of this.list(projectId)) out[entry.def.id] = entry.data;
    return out;
  }

  /**
   * Fetch now, regardless of the schedule. Errors are returned in the status
   * rather than thrown: a manual refresh that fails is information, and the
   * cached rows are still what should be on air.
   */
  async refresh(projectId: string, sourceId: string): Promise<DataEntry> {
    const key = this.key(projectId, sourceId);
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`data source "${sourceId}" is not registered`);

    /*
     * One fetch per source at a time. A second caller — the refresh button, or
     * a places table changing mid-fetch — waits for the one in flight; a
     * places change additionally asks for a re-run afterwards (see `ingest`),
     * because the fetch in flight was started with the old list.
     */
    if (entry.inflight) return entry.inflight;
    entry.inflight = this.fetchInto(projectId, entry);
    try {
      return await entry.inflight;
    } finally {
      entry.inflight = undefined;
      if (entry.rerun) {
        entry.rerun = false;
        this.schedule(projectId, entry.def.id, 0);
      }
    }
  }

  private async fetchInto(projectId: string, entry: DataEntry): Promise<DataEntry> {
    const now = new Date().toISOString();
    const lookup = (id: string): DataSet | undefined => this.entries.get(this.key(projectId, id))?.data;
    // What the places table said when this fetch started — `ingest` compares
    // against it to decide whether a table change is a change of places.
    entry.placesSig = placesSignature(entry.def, { lookup });
    /*
     * The source was edited while this fetch was out — `upsert` replaced the
     * entry. The fetch was made, and would be guarded, under the old
     * definition; the new entry has its own fetch scheduled. Drop the result.
     */
    const current = (): boolean => this.entries.get(this.key(projectId, entry.def.id)) === entry;
    try {
      const result = await loadDataSource(entry.def, entry, { lookup });
      if (!current()) return entry;
      // Guarded before anything about the entry changes: a refusal must leave
      // it exactly as a failed connection would (rule 4).
      const guarded: { data: DataSet | null; dropped: number; accepted?: string | undefined } = result.data
        ? this.guard(entry, result.data)
        : { data: null, dropped: 0 };
      if (result.body !== undefined) entry.body = result.body;
      entry.etag = result.etag;
      entry.lastModified = result.lastModified;
      entry.status.lastFetch = now;
      entry.status.lastSuccess = now;
      entry.status.failures = 0;
      delete entry.status.lastError;
      delete entry.status.expired;
      if (result.data) {
        if (guarded.dropped) entry.status.dropped = guarded.dropped;
        else delete entry.status.dropped;
      }
      const warnings = [
        result.warning,
        guarded.dropped ? `the guard dropped ${guarded.dropped} ${guarded.dropped === 1 ? 'row' : 'rows'}` : undefined,
        guarded.accepted,
      ].filter((w): w is string => Boolean(w));
      if (warnings.length) entry.status.warning = warnings.join('; ');
      else delete entry.status.warning;
      if (guarded.data) this.ingest(entry, guarded.data);
    } catch (err) {
      if (!current()) return entry;
      entry.status.lastFetch = now;
      entry.status.failures = (entry.status.failures ?? 0) + 1;
      entry.status.lastError = err instanceof Error ? err.message : String(err);
      // Deliberately no fresh `entry.own`. Rule 1: last-good stays on air —
      // except where the data itself says it has run out.
      this.staleCheck(entry);
    }
    // Success or failure can change whether the backup serves (a `failing`
    // trigger, an expiry, a recovery) without the rows themselves changing.
    this.publish(entry);
    return entry;
  }

  /**
   * Apply the def's guard to a fetched DataSet. Throws `GuardRefusal` for a
   * fetch that may not go on air.
   *
   * A refused *drop* is watched: the same content refused
   * `GUARD_DROP_CONFIRMATIONS` times in a row is believed, because a list that
   * really did shrink — a tournament down to its last eight — would otherwise
   * be refused for ever against a last-good that no longer exists anywhere.
   */
  private guard(entry: DataEntry, data: DataSet): { data: DataSet; dropped: number; accepted?: string } {
    const guardDef = entry.def.type === 'manual' ? undefined : entry.def.guard;
    const checked = applyGuard(guardDef, data, entry.ownLoaded ? entry.own : undefined);
    if (checked.ok) {
      delete entry.dropHold;
      return { data: checked.data, dropped: checked.dropped };
    }
    if (checked.kind !== 'drop') {
      delete entry.dropHold;
      throw new GuardRefusal(checked.reason);
    }
    // Confirmed on the row count, not the content: a feed carrying a timestamp
    // per row changes on every fetch, and a real shrink must still be believed.
    const hash = String(checked.data.rows.length);
    const count = entry.dropHold?.hash === hash ? entry.dropHold.count + 1 : 1;
    if (count < GUARD_DROP_CONFIRMATIONS) {
      entry.dropHold = { hash, count };
      throw new GuardRefusal(`${checked.reason} (${count} of ${GUARD_DROP_CONFIRMATIONS} before it is believed)`);
    }
    delete entry.dropHold;
    return {
      data: checked.data,
      dropped: checked.dropped,
      accepted: `accepted a drop the guard refused, after it held for ${GUARD_DROP_CONFIRMATIONS} fetches — ${checked.reason}`,
    };
  }

  /**
   * The two ways last-good may stop being shown while the origin is down.
   *
   * CAP: the cached alerts are re-read against the clock, so a warning whose
   * `expires` has passed leaves the screen on time, feed or no feed.
   *
   * `expireAfter`: once the last success is older than that, the rows are
   * emptied — the columns stay, so bound cells render blank rather than the
   * layout breaking. The source comes back on its own at the next success.
   */
  private staleCheck(entry: DataEntry, now = new Date()): void {
    /*
     * Expiry first, and final. Once the limit has passed the rows stay empty
     * until a fetch succeeds; re-reading cached alerts after that would put
     * them back on air for as long as the feed stayed down.
     */
    const expiry = effectiveExpiry(entry.def);
    const since = entry.status.lastSuccess ? Date.parse(entry.status.lastSuccess) : NaN;
    if (expiry !== undefined && Number.isFinite(since) && now.getTime() - since >= expiry * 1000) {
      // `own` is kept: what goes on air is decided in `publish`, which serves
      // an expired source blank — or its backup.
      entry.status.expired = true;
      return;
    }

    if (entry.def.type === 'cap' && entry.body !== undefined) {
      try {
        // Through the guard too: the cached body may be the very fetch the
        // guard refused, and a re-read must not be a way round it.
        const checked = applyGuard(entry.def.guard, capToDataSet(entry.def, entry.body, now), entry.own);
        if (checked.ok) this.ingest(entry, checked.data);
      } catch {
        // The body parsed when it arrived; if it somehow does not now, the
        // rows already on air are the best there is.
      }
    }
  }

  /**
   * Milliseconds until something must be re-checked even without a fetch —
   * the moment `expireAfter` runs out — or undefined when nothing is pending.
   * Keeps a backed-off source (up to thirty intervals) from holding expired
   * rows on air for hours past their limit.
   */
  private expiryDueIn(entry: DataEntry, now = Date.now()): number | undefined {
    const expiry = effectiveExpiry(entry.def);
    if (expiry === undefined || entry.status.expired || !entry.status.lastSuccess) return undefined;
    return Math.max(1000, Date.parse(entry.status.lastSuccess) + expiry * 1000 - now);
  }

  /** Milliseconds until the guard's `maxUnchanged` runs out, or undefined. */
  private stuckDueIn(entry: DataEntry, now = Date.now()): number | undefined {
    const limit = entry.def.type === 'manual' ? undefined : entry.def.guard?.maxUnchanged;
    if (limit === undefined || entry.status.stuck || !entry.status.lastChange) return undefined;
    return Math.max(1000, Date.parse(entry.status.lastChange) + limit * 1000 - now);
  }

  /** Set or clear `stuck`: own content unchanged for longer than the guard allows. */
  private flagStuck(entry: DataEntry, now = Date.now()): void {
    const limit = entry.def.type === 'manual' ? undefined : entry.def.guard?.maxUnchanged;
    const since = entry.status.lastChange ? Date.parse(entry.status.lastChange) : NaN;
    if (limit !== undefined && Number.isFinite(since) && now - since >= limit * 1000) entry.status.stuck = true;
    else delete entry.status.stuck;
  }

  /**
   * Set `expired` once `expireAfter` has run out, whatever the fetch path.
   *
   * `staleCheck` does this after a failed fetch; this catches the sources that
   * never fetch at all — a disabled one, which keeps its rows and whose limit
   * would otherwise never be read again, and a backup, which is judged by its
   * own state when a primary asks for it. Cleared only by a success.
   */
  private flagExpired(entry: DataEntry, now = Date.now()): void {
    const expiry = effectiveExpiry(entry.def);
    const since = entry.status.lastSuccess ? Date.parse(entry.status.lastSuccess) : NaN;
    if (expiry !== undefined && Number.isFinite(since) && now - since >= expiry * 1000) entry.status.expired = true;
  }

  /** Whether this source's own rows are fit for air. */
  private ownUsable(entry: DataEntry): boolean {
    if (entry.def.type === 'manual') return true;
    if (!entry.ownLoaded) return false;
    this.flagExpired(entry);
    this.flagStuck(entry);
    return !entry.status.expired && !entry.status.stuck;
  }

  /** Whether the backup should be asked for its rows. */
  private wantsBackup(entry: DataEntry, ownUsable: boolean): boolean {
    if (entry.use === 'primary') return false;
    if (entry.use === 'backup') return true;
    // Nothing fit of its own. A source that has not been tried yet is not a
    // failure: a restart would otherwise flash the backup before every first fetch.
    if (!ownUsable) return entry.status.lastSuccess !== undefined || (entry.status.failures ?? 0) > 0;
    return entry.def.fallbackOn === 'failing' && (entry.status.failures ?? 0) > 0;
  }

  /**
   * What goes on air for a source: its own rows, blank, or its backup's —
   * following a chain of backups, never round a loop.
   *
   * A backup is only used if it has something fit to show itself; a backup
   * that is down too leaves the primary's own (possibly stale) rows up, since
   * stale is better than blank. The exception is an operator's `backup`,
   * which is obeyed as given.
   */
  private served(entry: DataEntry, seen: Set<string>): Served {
    const id = entry.def.id;
    seen.add(id);
    const usable = this.ownUsable(entry);
    /*
     * An operator's "own rows" overrides a frozen verdict — `maxUnchanged` can
     * be wrong about a table that is simply quiet — but not an expiry, which
     * is a limit a publisher's terms may set.
     */
    const shown = usable || (entry.use === 'primary' && Boolean(entry.ownLoaded) && !entry.status.expired);
    const own: Served = { data: shown ? entry.own : { ...entry.own, rows: [] }, from: id, usable };
    const backupId = entry.def.fallback;
    if (backupId === undefined || seen.has(backupId) || !this.wantsBackup(entry, usable)) return own;
    const backup = this.entries.get(this.key(entry.projectId, backupId));
    if (!backup) return own;
    const theirs = this.served(backup, seen);
    return entry.use === 'backup' || theirs.usable ? theirs : own;
  }

  /** Adopt a DataSet as this source's own rows, then publish what that puts on air. */
  private ingest(entry: DataEntry, data: DataSet): void {
    const hash = hashDataSet(data);
    entry.ownLoaded = true;
    if (hash !== entry.ownHash) {
      entry.ownHash = hash;
      entry.own = data;
      // The last real change to the content — what `maxUnchanged` counts from.
      entry.status.lastChange = new Date().toISOString();
    }
    this.publish(entry);
  }

  /**
   * Work out what is on air under this source's id and push it if it changed,
   * then do the same for every source this one is the backup of.
   *
   * Bumps the revision and pushes only on a real change (rule 2), and does
   * nothing at all for a source that has neither loaded nor fallen back: an
   * empty push at registration would blank every table showing its authored
   * snapshot until the first fetch came in.
   */
  private publish(entry: DataEntry, visiting = new Set<DataEntry>()): void {
    if (visiting.has(entry)) return;
    visiting.add(entry);
    this.flagStuck(entry);

    const served = this.served(entry, new Set());
    const fromOwn = served.from === entry.def.id;
    if (fromOwn) delete entry.status.serving;
    else entry.status.serving = served.from;

    if (fromOwn && !entry.ownLoaded && entry.hash === '') {
      entry.status.rowCount = entry.data.rows.length;
    } else {
      let data: DataSet = fromOwn ? served.data : { id: entry.def.id, columns: served.data.columns, rows: served.data.rows };
      // A camera list carries each camera's check (Wave 8); a change in one is a change on air.
      if (this.media) {
        this.media.sync(entry.projectId, entry.def, data);
        if (entry.def.media) {
          data = this.media.decorate(entry.projectId, entry.def.id, data);
          const summary = this.media.summary(entry.projectId, entry.def.id);
          if (summary) entry.status.media = summary;
        } else {
          delete entry.status.media;
        }
      }
      const hash = hashDataSet(data);
      entry.status.rowCount = data.rows.length;
      const fetchedAt = (fromOwn ? undefined : served.data.fetchedAt) ?? new Date().toISOString();
      if (hash === entry.hash) {
        entry.data = { ...entry.data, fetchedAt };
      } else {
        entry.hash = hash;
        entry.status.revision += 1;
        entry.data = { ...data, id: entry.def.id, fetchedAt, revision: entry.status.revision };
        for (const listener of this.listeners) listener(entry.projectId, entry.data);
        this.refetchPlacesReaders(entry);
      }
    }

    for (const other of this.entries.values()) {
      if (other.projectId === entry.projectId && other.def.fallback === entry.def.id) this.publish(other, visiting);
    }
  }

  private refetchPlacesReaders(entry: DataEntry): void {
    /*
     * Sources reading their places from this one fetch again — adding
     * Flagstaff to the Cities table should reach the screen on the next page
     * turn, not at the end of a fifteen-minute poll.
     *
     * Only when the *places* changed, not any column: a Cities feed with a
     * timestamp in it, polled every five seconds, would otherwise re-fetch
     * fifty forecasts every five seconds. And never sooner than the
     * dependent's provider allows after its last fetch; a fetch already in
     * flight is asked to run again when it finishes instead of racing it.
     */
    const lookup = (id: string): DataSet | undefined => this.entries.get(this.key(entry.projectId, id))?.data;
    for (const other of this.entries.values()) {
      if (other === entry || other.projectId !== entry.projectId) continue;
      if (placesSourceOf(other.def) !== entry.def.id) continue;
      if (placesSignature(other.def, { lookup }) === other.placesSig) continue;
      if (other.inflight) {
        other.rerun = true;
        continue;
      }
      const last = other.status.lastFetch ? Date.parse(other.status.lastFetch) : NaN;
      const wait = Number.isFinite(last) ? Math.max(0, last + pollFloor(other.def) * 1000 - Date.now()) : 0;
      this.schedule(other.projectId, other.def.id, wait);
    }
  }

  private schedule(projectId: string, sourceId: string, delayMs: number): void {
    if (this.stopped || !config.dataPolling) return;
    const key = this.key(projectId, sourceId);
    this.clearTimer(key);

    const timer = setTimeout(() => {
      void this.tick(projectId, sourceId);
    }, delayMs);
    // Never hold the process open for a poll — a server told to shut down
    // between shows should not wait out a 30-second interval first.
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private async tick(projectId: string, sourceId: string): Promise<void> {
    const entry = this.entries.get(this.key(projectId, sourceId));
    if (!entry || this.stopped) return;

    if (entry.def.enabled === false) {
      // Not fetching, but its rows can still run out.
      this.publish(entry);
      this.schedule(projectId, sourceId, effectiveInterval(entry.def) * 1000);
      return;
    }

    await this.refresh(projectId, sourceId);

    const base = effectiveInterval(entry.def) * 1000;
    let next = base * backoffMultiplier(entry.status.failures ?? 0);
    // A failing source still has to wake when its data runs out.
    const due = (entry.status.failures ?? 0) > 0 ? this.expiryDueIn(entry) : undefined;
    if (due !== undefined) next = Math.min(next, due);
    // And a frozen feed has to be noticed when it freezes, not a poll later.
    const stuck = this.stuckDueIn(entry);
    if (stuck !== undefined) next = Math.min(next, stuck);
    if (entry.def.type === 'cap') {
      // Alerts are re-read against the clock on each failed tick, so their
      // backoff is capped: an ended warning may linger two minutes, not fifteen.
      next = Math.min(next, Math.max(base, 120_000));
      // And whether or not the feed is up, wake when an alert on screen ends
      // or starts (or at local midnight, reading whole days) rather than at
      // the next poll.
      const change = capDueIn(entry.def, entry.own.rows, new Date());
      if (change !== undefined) next = Math.min(next, Math.max(1000, change));
    }
    this.schedule(projectId, sourceId, next);
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
  }
}
