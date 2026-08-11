// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Project backup and restore bundles.
 *
 * ASSETS.md's rule, and the reason this is a *backup* rather than an export:
 * **a bundle carries data, never the runtime.** Composition JSON,
 * `datasources.json` and referenced assets — nothing executable. That is what
 * makes it inert without a Breeze install, so it can be copied, archived or
 * handed to whoever is covering next Sunday with no question about what travels
 * with it. Anything that would put the runtime back inside the zip — a
 * self-restoring archive, an embedded preview player "so the client can look
 * without installing Breeze" — reopens that question and is out of scope.
 *
 * Server-side rather than zipped in the page, because a 900 MB project bundle
 * does not belong in browser memory.
 *
 * **Layout.** One shape for one and for many, so restore has a single path:
 *
 *   breeze-bundle.json                     manifest
 *   projects/<id>/project.json
 *   projects/<id>/assets.json
 *   projects/<id>/datasources.json         (omitted when the project has none)
 *   projects/<id>/assets/<file>
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { FORMAT_VERSION, assetReferences, type AssetRef, type Composition, type Project } from '@breeze/schema';

import { projectAssetsDir, projectDataSourcesFile, projectDir } from '../config.js';
import { readDataSources } from '../data/sources.js';
import { APP_VERSION } from '../version.js';
import {
  getDependencies,
  listAssets,
  readAssets,
  readProject,
  updateAssets,
  writeProject,
} from '../store.js';
import { ArchiveError, readArchive, writeArchive, type ZipEntry } from './zip.js';

/** What a bundle says about itself. */
export interface BundleManifest {
  formatVersion: typeof FORMAT_VERSION;
  kind: 'breeze-backup';
  createdAt: string;
  /** The Breeze that wrote it. Diagnostic only — restore does not gate on it. */
  appVersion: string;
  /**
   * Present when the bundle was scoped to one composition.
   *
   * Its absence means "whole project", so a bundle written before this field
   * existed reads correctly as what it is. What it buys is the restore
   * offering "merge this graphic into an existing project" — a choice that
   * only makes sense for one composition, and which would otherwise have to be
   * guessed from a project that happens to hold a single graphic.
   */
  scope?: { composition: string; name: string };
  projects: Array<{ id: string; name: string; compositions: number; assets: number }>;
}

export class BundleError extends Error {}

const MANIFEST = 'breeze-bundle.json';

const utf8 = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

/**
 * Remove credentials from a data source before it goes into a bundle.
 *
 * **Not `redact()`.** That one masks values with `••••` so the editor can show
 * an operator *that* a header is set without showing what it is, which is right
 * for the wire and wrong here: a restored source would carry a literal
 * `Authorization: ••••`, which looks configured, is not, and fails at the worst
 * moment with a message about a bad credential rather than a missing one. A
 * bundle drops the key entirely, so the source restores visibly incomplete and
 * the operator is told to re-enter it.
 *
 * `secretId` survives for the same reason it survives redaction — it is a name,
 * not a credential, and it is what lets a restored project find the same
 * credential on a machine that already has it.
 */
export function stripSecrets<T extends Record<string, unknown>>(def: T): T {
  const { headers, ...rest } = def as { headers?: Record<string, string> };
  if (!headers) return def;
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!/auth|key|token|secret|cookie|password/i.test(key)) safe[key] = value;
  }
  return { ...rest, headers: safe } as unknown as T;
}

/**
 * Build a bundle for one or more whole projects.
 *
 * Assets are read off disk rather than out of the index, and the two are
 * reconciled: an index row whose file is missing is skipped rather than
 * failing the backup. A project that has lost a file is exactly the project
 * someone is trying to back up, and refusing to write anything because one
 * logo went missing would deny them the other 199.
 */
export async function buildBundle(projectIds: readonly string[]): Promise<{
  buffer: Buffer;
  manifest: BundleManifest;
  missing: string[];
}> {
  if (projectIds.length === 0) throw new BundleError('no projects selected');

  const files: Record<string, Uint8Array> = {};
  const manifest: BundleManifest = {
    formatVersion: FORMAT_VERSION,
    kind: 'breeze-backup',
    createdAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    projects: [],
  };
  const missing: string[] = [];

  for (const id of projectIds) {
    const project = await readProject(id);
    const assetsFile = await readAssets(id);
    const assets = await listAssets(id);

    files[`projects/${id}/project.json`] = utf8(project);
    files[`projects/${id}/assets.json`] = utf8(assetsFile);

    const sources = await readDataSources(id);
    if (sources.length) {
      files[`projects/${id}/datasources.json`] = utf8({
        formatVersion: FORMAT_VERSION,
        sources: sources.map((s) => stripSecrets(s as unknown as Record<string, unknown>)),
      });
    }

    let present = 0;
    for (const asset of assets) {
      const relative = asset.path.replace(/^assets\//, '');
      try {
        files[`projects/${id}/assets/${relative}`] = await fs.readFile(
          path.join(projectAssetsDir(id), relative),
        );
        present += 1;
      } catch {
        missing.push(`${id}/${asset.path}`);
      }
    }

    manifest.projects.push({
      id: project.id,
      name: project.name,
      compositions: project.compositions.length,
      assets: present,
    });
  }

  files[MANIFEST] = utf8(manifest);
  return { buffer: writeArchive(files), manifest, missing };
}

/**
 * Build a bundle carrying one composition and nothing else.
 *
 * ASSETS.md's "the usage index read backwards", and the difference between a
 * 4 MB handover and a 900 MB one. A project bundle answers "everything here";
 * this answers "what does *this graphic* need", which is the question someone
 * asks when they are sending one lower third to whoever is covering next
 * Sunday.
 *
 * **The closure is compositions first, then assets.** A composition that mounts
 * another — a reusable badge, or a scene's independently-triggered elements —
 * is useless without it, so `getDependencies` runs first and the asset walk
 * then runs over the whole set. Doing it the other way would carry the parent's
 * logo and drop the badge's.
 *
 * The result is still a project bundle in shape, carrying a project document
 * trimmed to the compositions that matter. That keeps `openBundle` and
 * `restoreProject` on one path rather than two, and it means a composition
 * bundle restored onto a clean install is a working project rather than a
 * fragment needing somewhere to live.
 */
export async function buildCompositionBundle(
  projectId: string,
  compositionId: string,
): Promise<{ buffer: Buffer; manifest: BundleManifest; missing: string[] }> {
  const project = await readProject(projectId);
  const root = project.compositions.find((c) => c.id === compositionId);
  if (!root) throw new BundleError(`composition "${compositionId}" is not in ${projectId}`);

  const dependencies = await getDependencies(projectId, compositionId);
  const kept = [root, ...dependencies];
  const keptIds = new Set(kept.map((c) => c.id));

  /*
   * Only the assets these compositions name.
   *
   * `assetReferences` is the same walk the delete confirmation and Replace use,
   * which is the point — a reference it misses here is a bundle that restores
   * into a graphic with a hole in it, and that bug would be identical to the
   * one those two features exist to prevent. One walk, three callers.
   */
  const referenced = new Set<string>();
  for (const comp of kept) {
    for (const ref of assetReferences(comp.layers)) referenced.add(ref.src);
  }

  const assetsFile = await readAssets(projectId);
  const keptAssets = assetsFile.assets.filter((a) => referenced.has(a.path));

  const trimmed: Project = {
    ...project,
    compositions: project.compositions.filter((c) => keptIds.has(c.id)),
  };

  const files: Record<string, Uint8Array> = {};
  files[`projects/${projectId}/project.json`] = utf8(trimmed);
  files[`projects/${projectId}/assets.json`] = utf8({ ...assetsFile, assets: keptAssets });

  /*
   * Data sources come across whole, not filtered.
   *
   * A layer names its source by id and the binding is resolved at playout, so
   * working out which sources a composition "uses" means reading every binding
   * on every layer — and getting it wrong produces a graphic that restores,
   * loads, and then shows nothing where the scores should be. The file is
   * kilobytes of URLs with the credentials already stripped; carrying all of
   * it is cheap and cannot be wrong.
   */
  const sources = await readDataSources(projectId);
  if (sources.length) {
    files[`projects/${projectId}/datasources.json`] = utf8({
      formatVersion: FORMAT_VERSION,
      sources: sources.map((s) => stripSecrets(s as unknown as Record<string, unknown>)),
    });
  }

  const missing: string[] = [];
  let present = 0;
  for (const asset of keptAssets) {
    const relative = asset.path.replace(/^assets\//, '');
    try {
      files[`projects/${projectId}/assets/${relative}`] = await fs.readFile(
        path.join(projectAssetsDir(projectId), relative),
      );
      present += 1;
    } catch {
      missing.push(`${projectId}/${asset.path}`);
    }
  }

  const manifest: BundleManifest = {
    formatVersion: FORMAT_VERSION,
    kind: 'breeze-backup',
    createdAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    // Named so a restore can offer "merge this composition into…" rather than
    // guessing from a project that happens to hold one graphic.
    scope: { composition: compositionId, name: root.name },
    projects: [
      { id: project.id, name: project.name, compositions: kept.length, assets: present },
    ],
  };
  files[MANIFEST] = utf8(manifest);

  return { buffer: writeArchive(files), manifest, missing };
}

/* --------------------------------------------------------------- restore */

/**
 * Paths a restore will act on, as an allowlist.
 *
 * The reader's `REFUSED` list answers "would a browser execute this in our
 * origin", which is the right question for a sequence unpacking into a served
 * directory and **not sufficient here**: a restore also writes files the
 * *server* parses, and `project.json` is not dangerous because of its
 * extension. So the restore path does not ask what is forbidden, it asks what
 * is understood — anything not matching one of these is ignored.
 *
 * An allowlist rather than a blacklist for the same reason `assetFilename`
 * rewrites rather than sanitises: the failure mode of a missed entry is
 * "something unexpected landed in the data directory", and there is no list of
 * unexpected things to enumerate.
 */
const PROJECT_FILE = /^projects\/([a-z0-9][a-z0-9._-]{0,63})\/(project|assets|datasources)\.json$/;
const PROJECT_ASSET = /^projects\/([a-z0-9][a-z0-9._-]{0,63})\/assets\/([A-Za-z0-9._-]+)$/;

export interface BundleContents {
  manifest: BundleManifest;
  /** Project id → its files, keyed by the path within the project folder. */
  projects: Map<string, Map<string, Uint8Array>>;
}

/**
 * Read and validate a bundle without writing anything.
 *
 * Split from the write deliberately: the editor asks what a bundle contains so
 * it can name the projects and detect id collisions *before* offering
 * overwrite-or-rename, which is the same argument that put collision detection
 * for asset Replace in the client — a question you answer after the write is
 * a question asked too late.
 */
export function openBundle(buffer: Buffer, limits: Parameters<typeof readArchive>[1]): BundleContents {
  let entries: ZipEntry[];
  try {
    entries = readArchive(buffer, limits);
  } catch (err) {
    if (err instanceof ArchiveError) throw new BundleError(err.message);
    throw err;
  }

  const manifestEntry = entries.find((e) => e.name === MANIFEST);
  if (!manifestEntry) {
    throw new BundleError(
      `not a Breeze backup — no ${MANIFEST} at the archive root. A zip of a project folder is not a bundle.`,
    );
  }

  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestEntry.bytes));
  } catch {
    throw new BundleError(`${MANIFEST} is not readable JSON`);
  }
  if (manifest.kind !== 'breeze-backup') throw new BundleError(`${MANIFEST} is not a Breeze backup manifest`);
  if (manifest.formatVersion > FORMAT_VERSION) {
    throw new BundleError(
      `bundle was written by a newer Breeze (format ${manifest.formatVersion}, this server reads ${FORMAT_VERSION})`,
    );
  }

  const projects = new Map<string, Map<string, Uint8Array>>();
  const put = (id: string, key: string, bytes: Uint8Array): void => {
    if (!projects.has(id)) projects.set(id, new Map());
    projects.get(id)!.set(key, bytes);
  };

  for (const entry of entries) {
    if (entry.name === MANIFEST) continue;
    const asJson = PROJECT_FILE.exec(entry.name);
    if (asJson) {
      put(asJson[1]!, `${asJson[2]!}.json`, entry.bytes);
      continue;
    }
    const asAsset = PROJECT_ASSET.exec(entry.name);
    if (asAsset) {
      put(asAsset[1]!, `assets/${asAsset[2]!}`, entry.bytes);
      continue;
    }
    // Silently ignored rather than refused: a bundle that has been through a
    // zip tool may carry directory entries or metadata we did not write, and
    // the allowlist above means none of it can reach the disk.
  }

  if (projects.size === 0) throw new BundleError('bundle carries no projects');

  for (const [id, files] of projects) {
    if (!files.has('project.json')) throw new BundleError(`project "${id}" has no project.json`);
  }

  return { manifest, projects };
}

/** The project document inside a bundle, parsed and checked. */
export function bundledProject(files: Map<string, Uint8Array>, id: string): Project {
  const raw = files.get('project.json');
  if (!raw) throw new BundleError(`project "${id}" has no project.json`);
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as Project;
  } catch {
    throw new BundleError(`project "${id}" has an unreadable project.json`);
  }
}

/**
 * Merge a bundle's compositions into a project that already exists.
 *
 * The handover case: a colleague sends one lower third and it belongs in the
 * show project you have open, not in a project of its own.
 *
 * **Three id spaces collide here, not one.** A whole-project restore only has
 * to resolve the project id; a merge has to resolve composition ids and asset
 * paths as well, and they fail differently. A colliding composition id would
 * silently replace a graphic that may be on air. A colliding asset path is
 * *not* a collision at all — asset paths carry a content hash, so the same path
 * means the same bytes, and writing it again is a no-op. That asymmetry is why
 * this is worth its own function rather than a flag on `restoreProject`.
 */
export async function mergeIntoProject(
  contents: BundleContents,
  bundledId: string,
  targetId: string,
): Promise<{ id: string; added: string[]; renamed: Array<{ from: string; to: string }>; assets: number }> {
  const files = contents.projects.get(bundledId);
  if (!files) throw new BundleError(`bundle has no project "${bundledId}"`);

  const incoming = bundledProject(files, bundledId);
  const target = await readProject(targetId);

  const existingComps = new Set(target.compositions.map((c) => c.id));
  const renamed: Array<{ from: string; to: string }> = [];
  const idMap = new Map<string, string>();

  for (const comp of incoming.compositions) {
    if (!existingComps.has(comp.id)) {
      idMap.set(comp.id, comp.id);
      continue;
    }
    let n = 2;
    while (existingComps.has(`${comp.id}-${n}`)) n += 1;
    const to = `${comp.id}-${n}`;
    idMap.set(comp.id, to);
    renamed.push({ from: comp.id, to });
    existingComps.add(to);
  }

  /*
   * A renamed composition has to be renamed everywhere it is *mounted*, too.
   *
   * `composition` layers hold their target by id. Renaming the badge without
   * repointing the lower third that mounts it produces exactly the failure
   * `compositionReferrers` exists to prevent — a parent that loads, plays, and
   * is missing a graphic with nothing saying why. This is the same class of bug
   * as an asset reference the rewriter misses, and it is why the rename map is
   * applied to layers rather than only to ids.
   */
  const repoint = (layers: Composition['layers']): Composition['layers'] =>
    layers.map((layer) => {
      if (layer.type === 'group') return { ...layer, children: repoint(layer.children) };
      if (layer.type === 'composition') {
        const to = idMap.get(layer.ref);
        return to && to !== layer.ref ? { ...layer, ref: to } : layer;
      }
      return layer;
    });

  const added: string[] = [];
  const merged = incoming.compositions.map((comp) => {
    const id = idMap.get(comp.id) ?? comp.id;
    added.push(id);
    return { ...comp, id, layers: repoint(comp.layers) };
  });

  // Assets are written before the document that references them, same order and
  // same reason as `restoreProject`.
  const assetsDir = projectAssetsDir(targetId);
  await fs.mkdir(assetsDir, { recursive: true });

  let assets = 0;
  for (const [key, bytes] of files) {
    if (!key.startsWith('assets/')) continue;
    await fs.writeFile(path.join(assetsDir, path.basename(key.slice('assets/'.length))), bytes);
    assets += 1;
  }

  /*
   * The incoming asset index is merged by path, not appended.
   *
   * Content addressing means the same path is the same bytes, so a row that is
   * already there needs no second entry — and appending would give the library
   * two rows for one file, which is the duplicate the index split in Wave A was
   * meant to stop appearing.
   */
  const targetAssets = await readAssets(targetId);
  const incomingAssets = files.get('assets.json');
  if (incomingAssets) {
    const parsed = JSON.parse(new TextDecoder().decode(incomingAssets)) as {
      assets?: AssetRef[];
      tags?: string[];
    };
    const byPath = new Map(targetAssets.assets.map((a) => [a.path, a]));
    for (const asset of parsed.assets ?? []) if (!byPath.has(asset.path)) byPath.set(asset.path, asset);
    await updateAssets(targetId, (current) => ({
      ...current,
      assets: [...byPath.values()],
      tags: [...new Set([...current.tags, ...(parsed.tags ?? [])])],
    }));
  }

  await writeProject({
    ...target,
    compositions: [...target.compositions, ...merged],
    updatedAt: new Date().toISOString(),
  });

  return { id: targetId, added, renamed, assets };
}

export interface RestoreOutcome {
  /** Id it actually landed under, which is not the bundled id when renamed. */
  id: string;
  bundledId: string;
  name: string;
  overwrote: boolean;
  assets: number;
}

/**
 * Write one project out of an opened bundle.
 *
 * **The id is decided by the caller, not the bundle.** A bundle naming the
 * project it wants to become is a bundle that can overwrite a live graphic by
 * being dropped on the wrong server, so the route resolves the collision and
 * passes the answer in. `assertSafeId` and `writeProject`'s own validation are
 * still the last word: a hand-edited bundle does not get to name a directory.
 *
 * Assets are written before the project document. A project.json referencing
 * files that are not there yet is a graphic that renders empty for however long
 * the write takes; the reverse — files on disk that nothing references yet — is
 * invisible and is cleaned up by the orphan pass that already exists.
 */
export async function restoreProject(
  contents: BundleContents,
  bundledId: string,
  targetId: string,
  opts: { overwrite: boolean },
): Promise<RestoreOutcome> {
  const files = contents.projects.get(bundledId);
  if (!files) throw new BundleError(`bundle has no project "${bundledId}"`);

  const project = bundledProject(files, bundledId);

  /*
   * Rewriting the id also rewrites nothing else, and that is correct.
   *
   * A project id appears in exactly one place inside the document — the `id`
   * field. Composition ids, channel keys and asset paths are all relative to
   * the project, which is what makes `${projectId}/${name}` a stable channel
   * key and what lets a project folder be dropped on another machine without
   * an export step (SCENES.md, store.ts). If that ever stops being true, this
   * is the function that will be wrong.
   */
  const restored: Project = { ...project, id: targetId, updatedAt: new Date().toISOString() };

  const assetsDir = projectAssetsDir(targetId);
  await fs.mkdir(assetsDir, { recursive: true });

  let written = 0;
  for (const [key, bytes] of files) {
    if (!key.startsWith('assets/')) continue;
    const base = key.slice('assets/'.length);
    // `path.basename` rather than trust: the allowlist in `openBundle` already
    // refused a separator here, and this is the second lock on the same door.
    await fs.writeFile(path.join(assetsDir, path.basename(base)), bytes);
    written += 1;
  }

  const assetsJson = files.get('assets.json');
  if (assetsJson) {
    await fs.writeFile(
      path.join(projectDir(targetId), 'assets.json'),
      Buffer.from(assetsJson),
    );
  }

  const sourcesJson = files.get('datasources.json');
  if (sourcesJson) {
    await fs.writeFile(projectDataSourcesFile(targetId), Buffer.from(sourcesJson));
  }

  await writeProject(restored);

  return {
    id: targetId,
    bundledId,
    name: restored.name,
    overwrote: opts.overwrite,
    assets: written,
  };
}
