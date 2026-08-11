// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The shared store — one station's logos, fonts and plates, reusable across
 * every project without being *shared* by any of them.
 *
 * **It copies. It does not link.** ASSETS.md §3, and the decision the whole
 * file turns on. A `shared://` reference was considered and rejected on one
 * asymmetry: a central delete reaches projects nobody has open, mid-show.
 * Stale is a stale logo; a broken link is a blank graphic over live pictures.
 * Linking would also contradict `store.ts`'s own promise that a project folder
 * can be dropped on another machine without an export step — a promise
 * `buildBundle` now depends on.
 *
 * What copying costs is propagation, and what buys it back is `origin`.
 * A copied asset records the slug it came from and the hash of the bytes it
 * copied, so "this project is behind the shared store" is a comparison the bin
 * can make: **same slug, different hash**. The operator is told, and re-pulls
 * per project, when they choose to. Propagation is deliberate rather than
 * automatic, which is what a rebrand actually wants — the graphics that are on
 * air tonight should not change under the show.
 *
 * Assets get in by being **promoted from a project bin**, not uploaded here.
 * The file has already been uploaded, hashed, probed and tagged by the time
 * anyone knows it is worth keeping; a second upload path would duplicate all of
 * that and have to be kept in step with it forever.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { FORMAT_VERSION, type AssetRef } from '@breeze/schema';

import { config } from './config.js';
import { NotFoundError, assetPath, getAsset, readAssets, updateAssets } from './store.js';
import { refusedExtension } from './refused.js';

export const sharedDir = (): string => path.join(config.dataDir, 'shared');
const sharedIndexFile = (): string => path.join(sharedDir(), 'shared.json');

/**
 * One entry in the shared store.
 *
 * `slug` is the stable identity and the thing a project's `origin.slug` points
 * at; `hash` is the identity of the current bytes. Replacing a logo keeps the
 * slug and changes the hash, which is exactly the difference every project's
 * staleness check reads.
 */
export interface SharedAsset {
  slug: string;
  /** Filename within `data/shared/`, content-addressed like a project asset. */
  file: string;
  hash: string;
  kind: AssetRef['kind'];
  originalName?: string;
  bytes?: number;
  updatedAt: string;
  title?: string;
  tags?: string[];
  width?: number;
  height?: number;
  duration?: number;
  hasAlpha?: boolean;
  codec?: string;
  fontFamily?: string;
}

export interface SharedIndex {
  formatVersion: typeof FORMAT_VERSION;
  assets: SharedAsset[];
}

export class SharedStoreError extends Error {}

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A slug from a filename.
 *
 * The same allowlist rewrite `assetFilename` uses, and for the same reasons —
 * a slug becomes a filename component and is compared across machines with
 * different case rules. The hash is deliberately *not* in it: a slug has to
 * survive the bytes changing, or a rebrand would look like a different asset
 * and no project would ever report itself stale.
 */
export function slugFor(name: string): string {
  const stem = path
    .basename(name, path.extname(name))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return stem || 'asset';
}

/*
 * Serialised the same way a project's index is.
 *
 * Two operators promoting assets at the same moment is a read-modify-write on
 * one file, and the shared store has no per-project lock to hide behind — it is
 * the one index every project can write to.
 */
let writeChain: Promise<unknown> = Promise.resolve();

export async function readSharedIndex(): Promise<SharedIndex> {
  try {
    const raw = await fs.readFile(sharedIndexFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SharedIndex>;
    return { formatVersion: FORMAT_VERSION, assets: parsed.assets ?? [] };
  } catch {
    // Absent is the ordinary state on a server nobody has promoted anything on.
    return { formatVersion: FORMAT_VERSION, assets: [] };
  }
}

async function updateSharedIndex(
  mutate: (current: SharedIndex) => SharedIndex,
): Promise<SharedIndex> {
  const run = writeChain.then(async () => {
    await fs.mkdir(sharedDir(), { recursive: true });
    const next = mutate(await readSharedIndex());
    const tmp = `${sharedIndexFile()}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, sharedIndexFile());
    return next;
  });
  // The chain must not break on a failed write, or every later promotion on
  // this process hangs behind a rejected promise nobody is awaiting.
  writeChain = run.catch(() => undefined);
  return run;
}

/**
 * Copy an asset out of a project and into the shared store.
 *
 * Promoting the same slug again **replaces** the shared copy rather than
 * refusing. That is what a rebrand is, and it is the only way any project ever
 * becomes stale — refusing would mean deleting and re-promoting, which loses
 * the slug and with it every project's ability to notice.
 */
export async function promoteAsset(
  projectId: string,
  assetId: string,
  opts: { slug?: string; title?: string } = {},
): Promise<SharedAsset> {
  const asset = await getAsset(projectId, assetId);

  const refused = refusedExtension(asset.path);
  if (refused) {
    throw new SharedStoreError(`${refused} files are not accepted — the shared store is served to browsers`);
  }

  const slug = opts.slug?.trim() || slugFor(asset.originalName ?? asset.path);
  if (!SAFE_SLUG.test(slug)) {
    throw new SharedStoreError(`invalid slug "${slug}" — lowercase letters, digits and hyphens only`);
  }

  const from = await assetPath(projectId, asset.path.replace(/^assets\//, ''));
  const bytes = await fs.readFile(from);
  const hash = createHash('sha256').update(bytes).digest('hex');

  const ext = path.extname(asset.path).toLowerCase();
  const file = `${slug}-${hash.slice(0, 8)}${ext}`;

  await fs.mkdir(sharedDir(), { recursive: true });
  await fs.writeFile(path.join(sharedDir(), file), bytes);

  const entry: SharedAsset = {
    slug,
    file,
    hash,
    kind: asset.kind,
    updatedAt: new Date().toISOString(),
    ...(asset.originalName ? { originalName: asset.originalName } : {}),
    ...(asset.bytes !== undefined ? { bytes: asset.bytes } : {}),
    ...(opts.title ?? asset.title ? { title: opts.title ?? asset.title } : {}),
    ...(asset.tags?.length ? { tags: asset.tags } : {}),
    ...(asset.width !== undefined ? { width: asset.width } : {}),
    ...(asset.height !== undefined ? { height: asset.height } : {}),
    ...(asset.duration !== undefined ? { duration: asset.duration } : {}),
    ...(asset.hasAlpha !== undefined ? { hasAlpha: asset.hasAlpha } : {}),
    ...(asset.codec ? { codec: asset.codec } : {}),
    ...(asset.fontFamily ? { fontFamily: asset.fontFamily } : {}),
  };

  await updateSharedIndex((current) => ({
    ...current,
    assets: [...current.assets.filter((a) => a.slug !== slug), entry],
  }));

  /*
   * The promoting project is marked as having come from the store too.
   *
   * Without this the project that contributed the logo is the one project that
   * never learns it is behind — it holds the same bytes, but nothing records
   * where they now live, so a later rebrand would flag every project except
   * the one the file came from.
   */
  await updateAssets(projectId, (current) => ({
    ...current,
    assets: current.assets.map((a) =>
      a.id === assetId ? { ...a, origin: { store: 'shared' as const, slug, hash } } : a,
    ),
  }));

  return entry;
}

/**
 * Copy a shared asset into a project.
 *
 * Goes through the project's own `saveAsset` path so the copy is content
 * addressed, probed and indexed exactly like an upload — a shared asset that
 * arrived by a different route would be a second kind of asset, and the bin
 * would eventually find a way to treat it differently.
 */
export async function pullIntoProject(
  projectId: string,
  slug: string,
  save: (projectId: string, name: string, body: Buffer) => Promise<AssetRef>,
): Promise<AssetRef> {
  const index = await readSharedIndex();
  const entry = index.assets.find((a) => a.slug === slug);
  if (!entry) throw new NotFoundError(`no shared asset "${slug}"`);

  const bytes = await fs.readFile(path.join(sharedDir(), entry.file));
  const asset = await save(projectId, entry.originalName ?? entry.file, bytes);

  await updateAssets(projectId, (current) => ({
    ...current,
    assets: current.assets.map((a) =>
      a.id === asset.id
        ? { ...a, origin: { store: 'shared' as const, slug: entry.slug, hash: entry.hash } }
        : a,
    ),
  }));

  return { ...asset, origin: { store: 'shared', slug: entry.slug, hash: entry.hash } };
}

export interface StaleAsset {
  assetId: string;
  path: string;
  slug: string;
  /** The hash this project copied. */
  have: string;
  /** The hash the shared store holds now. */
  available: string;
  title?: string;
}

/**
 * Which of a project's assets are behind the shared store.
 *
 * **Same slug, different hash.** An asset whose slug is no longer in the store
 * is *not* stale — it is an asset whose origin was deleted centrally, and the
 * copy is still perfectly good. Reporting it would be reporting the exact
 * failure the copy-don't-link decision exists to prevent.
 */
export async function staleAssets(projectId: string): Promise<StaleAsset[]> {
  const [index, assets] = await Promise.all([readSharedIndex(), readAssets(projectId)]);
  const bySlug = new Map(index.assets.map((a) => [a.slug, a]));

  const out: StaleAsset[] = [];
  for (const asset of assets.assets) {
    if (!asset.origin || asset.origin.store !== 'shared') continue;
    const shared = bySlug.get(asset.origin.slug);
    if (!shared) continue;
    if (shared.hash === asset.origin.hash) continue;
    out.push({
      assetId: asset.id,
      path: asset.path,
      slug: asset.origin.slug,
      have: asset.origin.hash,
      available: shared.hash,
      ...(shared.title ? { title: shared.title } : {}),
    });
  }
  return out;
}

/** Remove a shared entry. Copies already made are untouched, by design. */
export async function deleteShared(slug: string): Promise<void> {
  const index = await readSharedIndex();
  const entry = index.assets.find((a) => a.slug === slug);
  if (!entry) throw new NotFoundError(`no shared asset "${slug}"`);

  await updateSharedIndex((current) => ({
    ...current,
    assets: current.assets.filter((a) => a.slug !== slug),
  }));

  // The file goes; every project's copy stays. That is the whole point.
  await fs.rm(path.join(sharedDir(), entry.file), { force: true });
}
