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
 */

import { createHash } from 'node:crypto';

import {
  emptyDataSet,
  conform,
  type DataSet,
  type DataSourceDef,
  type DataSourceStatus,
  type UrlDataSource,
} from '@breeze/schema';

import { config } from '../config.js';
import { fetchText } from './fetch.js';
import { ftpToDataSet } from './ftp.js';
import { csvToDataSet, jsonToDataSet } from './parse.js';
import { feedToDataSet, xmlToDataSet } from './parse-xml.js';
import { resolveSheetsCredential, sheetsToDataSet } from './sheets.js';
import { effectiveInterval, readDataSources } from './sources.js';
import { weatherToDataSet } from './weather.js';

export interface DataEntry {
  projectId: string;
  def: DataSourceDef;
  data: DataSet;
  status: DataSourceStatus;
  /** Conditional-request state from the last successful fetch. */
  etag?: string | undefined;
  lastModified?: string | undefined;
  hash: string;
}

export type DataPushListener = (projectId: string, data: DataSet) => void;

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
export async function loadDataSource(def: DataSourceDef, prior?: DataEntry): Promise<{
  data: DataSet | null;
  etag?: string | undefined;
  lastModified?: string | undefined;
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
  if (def.type === 'weather') {
    return { data: await weatherToDataSet(def) };
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

  const result = await fetchText(def.url, {
    ...(def.headers ? { headers: def.headers } : {}),
    etag: prior?.etag,
    lastModified: prior?.lastModified,
    bearerToken: secret,
  });

  // 304: the origin says nothing changed. Believe it and skip the parse.
  if (result.body === null) {
    return { data: null, etag: result.etag, lastModified: result.lastModified };
  }

  const data = parseBody(def, result.body);
  return { data, etag: result.etag, lastModified: result.lastModified };
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
    default: {
      const exhaustive: never = def;
      throw new Error(`unknown data source type ${JSON.stringify(exhaustive)}`);
    }
  }
}

export class DataRegistry {
  private entries = new Map<string, DataEntry>();
  private timers = new Map<string, NodeJS.Timeout>();
  private listeners = new Set<DataPushListener>();
  private stopped = false;

  private key(projectId: string, sourceId: string): string {
    return `${projectId}/${sourceId}`;
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
      this.entries.delete(key);
    }

    for (const def of defs) await this.upsert(projectId, def);
  }

  async upsert(projectId: string, def: DataSourceDef): Promise<DataEntry> {
    const key = this.key(projectId, def.id);
    const existing = this.entries.get(key);

    const entry: DataEntry = existing
      ? { ...existing, def, projectId }
      : {
          projectId,
          def,
          data: emptyDataSet(def.id),
          status: { id: def.id, revision: 0, rowCount: 0 },
          hash: '',
        };
    this.entries.set(key, entry);

    // A manual source needs no fetch — its rows are the definition.
    if (def.type === 'manual') {
      this.clearTimer(key);
      this.ingest(entry, { id: def.id, columns: def.columns, rows: conform(def.rows, def.columns) });
      return entry;
    }

    this.schedule(projectId, def.id, 0);
    return entry;
  }

  remove(projectId: string, sourceId: string): void {
    const key = this.key(projectId, sourceId);
    this.clearTimer(key);
    this.entries.delete(key);
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

    const now = new Date().toISOString();
    try {
      const result = await loadDataSource(entry.def, entry);
      entry.etag = result.etag;
      entry.lastModified = result.lastModified;
      entry.status.lastFetch = now;
      entry.status.failures = 0;
      delete entry.status.lastError;
      if (result.data) this.ingest(entry, result.data);
      else entry.status.rowCount = entry.data.rows.length;
    } catch (err) {
      entry.status.lastFetch = now;
      entry.status.failures = (entry.status.failures ?? 0) + 1;
      entry.status.lastError = err instanceof Error ? err.message : String(err);
      // Deliberately no `entry.data = ...`. Rule 1: last-good stays on air.
    }
    return entry;
  }

  /** Adopt a DataSet, bumping the revision and pushing only on a real change. */
  private ingest(entry: DataEntry, data: DataSet): void {
    const hash = hashDataSet(data);
    entry.status.rowCount = data.rows.length;

    if (hash === entry.hash) {
      entry.data = { ...entry.data, fetchedAt: new Date().toISOString() };
      return;
    }

    entry.hash = hash;
    entry.status.revision += 1;
    entry.status.lastChange = new Date().toISOString();
    entry.data = {
      ...data,
      fetchedAt: new Date().toISOString(),
      revision: entry.status.revision,
    };

    for (const listener of this.listeners) listener(entry.projectId, entry.data);
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
      this.schedule(projectId, sourceId, effectiveInterval(entry.def) * 1000);
      return;
    }

    await this.refresh(projectId, sourceId);

    const base = effectiveInterval(entry.def) * 1000;
    const next = base * backoffMultiplier(entry.status.failures ?? 0);
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
