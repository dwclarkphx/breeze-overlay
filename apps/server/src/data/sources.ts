// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Data-source definitions on disk — `projects/<id>/datasources.json`.
 *
 * A separate file from `project.json` on purpose. Source defs are project
 * *infrastructure*: they hold URLs and secret ids, and they change on a
 * different clock from the graphics. Keeping them out of the composition is also
 * what makes the no-secrets-in-a-composition rule enforceable — a composition
 * gets exported, embedded
 * in a single-file template and handed to a playout server, and nothing that
 * travels that way may carry a URL that only works inside the venue.
 */

import fs from 'node:fs/promises';

import {
  DEFAULT_POLL_INTERVAL,
  DEFAULT_WEATHER_POLL_INTERVAL,
  FORMAT_VERSION,
  pollFloor,
  type DataSourceDef,
} from '@breeze/schema';
import { validateDataSources } from '@breeze/schema/validate';

import { projectDataSourcesFile, projectDir } from '../config.js';
import { NotFoundError, assertSafeId } from '../store.js';

export interface DataSourcesFile {
  formatVersion: typeof FORMAT_VERSION;
  sources: DataSourceDef[];
}

const SAFE_SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function assertSafeSourceId(id: string): void {
  if (!SAFE_SOURCE_ID.test(id)) throw new Error(`invalid data source id "${id}"`);
}

/**
 * Poll interval actually used, after the floor.
 *
 * Clamped rather than rejected. A weather source asking for five seconds is an
 * operator who has not read a license page, not an attacker — and refusing to
 * save the def would leave them with a graphic that does not work and no data
 * at all. Clamping gives them the graphic, at the rate the provider permits.
 */
export function effectiveInterval(def: DataSourceDef): number {
  if (def.type === 'manual') return 0;
  const fallback = def.type === 'weather' ? DEFAULT_WEATHER_POLL_INTERVAL : DEFAULT_POLL_INTERVAL;
  const requested = def.pollInterval ?? fallback;
  return Math.max(pollFloor(def), requested);
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, contents, 'utf8');
  await fs.rename(tmp, file);
}

/**
 * Read a project's sources. A missing file is an empty list, not an error:
 * every project predating this phase has no such file, and none of them should
 * fail to open because of it.
 */
export async function readDataSources(projectId: string): Promise<DataSourceDef[]> {
  assertSafeId(projectId);
  let raw: string;
  try {
    raw = await fs.readFile(projectDataSourcesFile(projectId), 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DataSourcesFile>;
    return Array.isArray(parsed.sources) ? parsed.sources : [];
  } catch {
    // A corrupt file must not take the project down with it; the editor's
    // health panel is where the operator finds out.
    return [];
  }
}

export async function writeDataSources(
  projectId: string,
  sources: DataSourceDef[],
): Promise<DataSourceDef[]> {
  assertSafeId(projectId);
  for (const source of sources) assertSafeSourceId(source.id);

  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.id)) throw new Error(`duplicate data source id "${source.id}"`);
    seen.add(source.id);
  }

  const file: DataSourcesFile = { formatVersion: FORMAT_VERSION, sources };

  /*
   * Validated before it reaches disk, on the same argument as compositions.
   *
   * A malformed def does not fail loudly — it fails as a graphic that is quietly
   * never populated, discovered on air. The schema is `additionalProperties:
   * false` throughout, so this also catches a misspelled field that would
   * otherwise be silently ignored by the adapter that was supposed to read it.
   */
  const result = validateDataSources(file);
  if (!result.valid) {
    const detail = result.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new Error(`invalid data source definition — ${detail}`);
  }

  await fs.mkdir(projectDir(projectId), { recursive: true });
  await writeAtomic(
    projectDataSourcesFile(projectId),
    `${JSON.stringify(file, null, 2)}\n`,
  );
  return sources;
}

export async function getDataSource(projectId: string, sourceId: string): Promise<DataSourceDef> {
  const sources = await readDataSources(projectId);
  const found = sources.find((s) => s.id === sourceId);
  if (!found) throw new NotFoundError(`data source "${sourceId}"`);
  return found;
}

export async function putDataSource(
  projectId: string,
  def: DataSourceDef,
): Promise<DataSourceDef[]> {
  assertSafeSourceId(def.id);
  const sources = await readDataSources(projectId);
  const index = sources.findIndex((s) => s.id === def.id);
  if (index === -1) sources.push(def);
  else sources[index] = def;
  return writeDataSources(projectId, sources);
}

export async function deleteDataSource(
  projectId: string,
  sourceId: string,
): Promise<DataSourceDef[]> {
  const sources = await readDataSources(projectId);
  return writeDataSources(projectId, sources.filter((s) => s.id !== sourceId));
}

/**
 * Strip anything that must not leave the server before a def goes over the wire.
 *
 * `secretId` stays — it is a name, and the editor has to show which credential a
 * source uses. The values never enter a def in the first place; this is the
 * belt to that braces, and the place to add fields to if one ever does.
 */
export function redact(def: DataSourceDef): DataSourceDef {
  /*
   * Manual, Sheets, weather and FTP defs carry no header map. Each addresses its
   * origin by something other than a URL and authenticates (where it does at
   * all) from the server-side secret store, so there is no operator-supplied
   * header to leak. FTP's `username` is intentionally *not* redacted: an
   * operator has to be able to see which account a failing drop box is using,
   * and a username without its password is not a credential.
   */
  if (
    def.type === 'manual' ||
    def.type === 'sheets' ||
    def.type === 'weather' ||
    def.type === 'ftp'
  ) {
    return def;
  }
  const { headers, ...rest } = def;
  if (!headers) return def;
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    safe[key] = /auth|key|token|secret|cookie/i.test(key) ? '••••' : value;
  }
  return { ...rest, headers: safe } as DataSourceDef;
}
