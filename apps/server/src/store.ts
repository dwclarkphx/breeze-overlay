// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Project store — plain JSON on disk.
 *
 * ROADMAP §1 chose files over SQLite for v1: projects stay git-diffable and
 * portable, and a broadcast engineer can drop a project folder onto another
 * machine without an export step. Writes are atomic (tmp + rename) because a
 * half-written project.json during a save would take a graphic off air.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  FORMAT_VERSION,
  assertKey,
  assetReferences,
  createProject,
  makeKeyedId,
  normalizeFolder,
  normalizeTags,
  referencedAssets,
  rewriteAssetReferences,
  sceneElements,
  type AssetEdit,
  type AssetRef,
  type AssetUsage,
  type Composition,
  type Project,
} from '@breeze/schema';
import {
  CompositionValidationError,
  assertValidProject,
  validateAssets,
} from '@breeze/schema/validate';

import {
  projectAssetsDir,
  projectAssetsFile,
  projectDir,
  projectFile,
  projectsDir,
} from './config.js';

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

/** Reject ids that could escape the data directory. */
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id) || id.includes('..')) {
    throw new Error(`invalid id "${id}"`);
  }
}

export async function ensureDataDirs(): Promise<void> {
  await fs.mkdir(projectsDir(), { recursive: true });
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, contents, 'utf8');
  await fs.rename(tmp, file);
}

export async function listProjects(): Promise<Array<Pick<Project, 'id' | 'name' | 'updatedAt'> & { compositions: Array<{ id: string; name: string }> }>> {
  await ensureDataDirs();
  const entries = await fs.readdir(projectsDir(), { withFileTypes: true });
  const out = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const project = await readProject(entry.name);
      out.push({
        id: project.id,
        name: project.name,
        updatedAt: project.updatedAt,
        compositions: project.compositions.map((c) => ({ id: c.id, name: c.name })),
      });
    } catch {
      // A broken project must not break the list; the editor surfaces it later.
      continue;
    }
  }

  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readProject(id: string): Promise<Project> {
  assertSafeId(id);
  let raw: string;
  try {
    raw = await fs.readFile(projectFile(id), 'utf8');
  } catch {
    throw new NotFoundError(`project "${id}"`);
  }
  const parsed: unknown = JSON.parse(raw);
  assertValidProject(parsed);
  return parsed;
}

export async function writeProject(project: Project): Promise<Project> {
  assertSafeId(project.id);
  assertValidProject(project);

  /*
   * The legacy asset index is dropped here, not in `readAssets`.
   *
   * `readAssets` migrates on read, and a read that also rewrites `project.json`
   * would need the project's write lock and would turn `listProjects` into a
   * write across every project directory it walks. Leaving the key in place
   * until the next ordinary project write is harmless — `readAssets` prefers
   * `assets.json` once it exists — and costs nothing.
   */
  const { assets: _legacy, ...rest } = project;
  const next: Project = { ...rest, updatedAt: new Date().toISOString() };

  await fs.mkdir(projectAssetsDir(project.id), { recursive: true });
  await writeAtomic(projectFile(project.id), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Create a project.
 *
 * `id` is a fully explicit id — the power-user escape hatch, kept because the
 * route has always accepted it. `key` is the guided path: the chosen half of
 * the id, with the generated half appended (SCENES.md §6). An explicit `id`
 * wins if both arrive.
 */
export async function newProject(name: string, id?: string, key?: string): Promise<Project> {
  /*
   * Trimmed and lowercased, then validated — deliberately *not* run through
   * `normalizeKey`.
   *
   * `normalizeKey` is the editor's as-you-type coercion helper: it truncates
   * and rewrites illegal characters so a field stays usable while someone is
   * still typing. Applying it here would mean an API caller asking for
   * `this-key-is-far-too-long` silently gets `this-key-is-` and a URL they
   * never chose. Case is the one exception, coerced rather than rejected,
   * because `RAHB` is unambiguous and the lowercase rule exists for the
   * filesystem's benefit rather than the caller's.
   */
  const chosen = key !== undefined && key.trim().length > 0 ? key.trim().toLowerCase() : undefined;
  if (chosen !== undefined) assertKey(chosen);

  const explicitId = id ?? (chosen ? makeKeyedId('proj', chosen) : undefined);
  const project = createProject({ name, ...(explicitId ? { id: explicitId } : {}) });
  assertSafeId(project.id);

  try {
    await fs.access(projectFile(project.id));
    throw new Error(`project "${project.id}" already exists`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) throw err;
  }

  return writeProject(project);
}

export async function deleteProject(id: string): Promise<void> {
  assertSafeId(id);
  await fs.rm(projectDir(id), { recursive: true, force: true });
}

export async function getComposition(projectId: string, compId: string): Promise<Composition> {
  const project = await readProject(projectId);
  const comp = project.compositions.find((c) => c.id === compId);
  if (!comp) throw new NotFoundError(`composition "${compId}"`);
  return comp;
}

/**
 * Every composition a graphic can nest, transitively, excluding itself.
 * Walks `composition` layers with a visited set so a cyclic project — which
 * the validator rejects on save but an older file may still contain — cannot
 * hang the request.
 */
export async function getDependencies(
  projectId: string,
  compId: string,
): Promise<Composition[]> {
  const project = await readProject(projectId);
  const byId = new Map(project.compositions.map((c) => [c.id, c]));

  const collected = new Map<string, Composition>();
  const queue = [compId];
  const seen = new Set<string>([compId]);

  while (queue.length) {
    const current = byId.get(queue.shift()!);
    if (!current) continue;

    const walk = (layers: Composition['layers']): void => {
      for (const layer of layers) {
        if (layer.type === 'group') {
          walk(layer.children);
          continue;
        }
        if (layer.type !== 'composition') continue;
        if (seen.has(layer.ref)) continue;
        seen.add(layer.ref);
        const child = byId.get(layer.ref);
        if (child) {
          collected.set(child.id, child);
          queue.push(child.id);
        }
      }
    };

    walk(current.layers);
  }

  return [...collected.values()];
}

/** One composition that mounts another as a layer. */
export interface CompositionReferrer {
  id: string;
  name: string;
  /** Name of the layer doing the mounting, so the user knows what to unlink. */
  layer: string;
  /** True when it is mounted as an independently triggered scene element. */
  independent: boolean;
}

/**
 * Which compositions mount this one — the inverse of `getDependencies`.
 *
 * The reason deleting a scene is not just a delete. A `composition` layer holds
 * its target by id, and removing the target does not remove the layer: the
 * parent still loads, still plays, and is simply missing a graphic, with
 * nothing on air or in the editor saying why. That failure surfaces during a
 * show, so the delete is refused up front instead.
 *
 * Direct referrers only, deliberately. Transitive ones are already broken by
 * whatever sits between them and this composition, and naming them would bury
 * the one layer someone actually has to go and unlink.
 */
export async function compositionReferrers(
  projectId: string,
  compId: string,
): Promise<CompositionReferrer[]> {
  const project = await readProject(projectId);
  const referrers: CompositionReferrer[] = [];

  for (const candidate of project.compositions) {
    if (candidate.id === compId) continue;

    // Groups nest arbitrarily deep, and a composition layer inside one counts
    // exactly the same — the walk in `getDependencies` descends for the same
    // reason.
    const walk = (layers: Composition['layers']): void => {
      for (const layer of layers) {
        if (layer.type === 'group') {
          walk(layer.children);
          continue;
        }
        if (layer.type !== 'composition' || layer.ref !== compId) continue;
        referrers.push({
          id: candidate.id,
          name: candidate.name,
          // `name` is optional on a layer, and the id is what the editor's
          // layer list falls back to showing when it is absent. Sending
          // `undefined` here would render as "layer" followed by nothing —
          // an instruction to go and unlink something unidentifiable.
          layer: layer.name ?? layer.id,
          independent: layer.independent === true,
        });
      }
    };

    walk(candidate.layers);
  }

  return referrers;
}

export async function putComposition(projectId: string, comp: Composition): Promise<Project> {
  const project = await readProject(projectId);
  const index = project.compositions.findIndex((c) => c.id === comp.id);
  if (index === -1) project.compositions.push(comp);
  else project.compositions[index] = comp;
  return writeProject(project);
}

/* ------------------------------------------------------------- channels */

/**
 * Something that can be addressed by a control trigger.
 *
 * Every composition contributes itself, plus one entry per independent element
 * it mounts. This is the first enumerable answer to "what can be triggered in
 * this project" — the control routes use it to widen their 404 guard, and the
 * panel and project index both want it for their own reasons.
 */
export interface ChannelRef {
  /** The addressable name — second segment of the channel key. */
  channel: string;
  /** Composition rendered on it. */
  ref: string;
  /** Scene it is mounted in, or null when the composition is played directly. */
  sceneId: string | null;
  /** Layer id within the scene; null when the composition is played directly. */
  layerId: string | null;
}

/*
 * Cached per project, keyed on the project's own `updatedAt`.
 *
 * A REST trigger would otherwise re-read and re-validate project.json on every
 * button press, and an operator leaning on a Stream Deck button is a realistic
 * load pattern. `writeProject` stamps `updatedAt` on every save, so the key
 * invalidates itself and there is no cache to remember to clear.
 */
const channelCache = new Map<string, { updatedAt: string; channels: ChannelRef[] }>();

export async function listChannels(projectId: string): Promise<ChannelRef[]> {
  const project = await readProject(projectId);

  const cached = channelCache.get(projectId);
  if (cached && cached.updatedAt === project.updatedAt) return cached.channels;

  const channels: ChannelRef[] = [];
  const seen = new Set<string>();

  const claim = (entry: ChannelRef): void => {
    // First claim wins. A duplicate is an authoring error the validator already
    // rejects on save; if an older file carries one, the index must still be a
    // map rather than a list with two entries under one key.
    if (seen.has(entry.channel)) return;
    seen.add(entry.channel);
    channels.push(entry);
  };

  for (const comp of project.compositions) {
    claim({ channel: comp.id, ref: comp.id, sceneId: null, layerId: null });
  }

  for (const comp of project.compositions) {
    for (const element of sceneElements(comp)) {
      claim({
        channel: element.channel,
        ref: element.ref,
        sceneId: comp.id,
        layerId: element.layerId,
      });
    }
  }

  channelCache.set(projectId, { updatedAt: project.updatedAt, channels });
  return channels;
}

/**
 * Resolve an addressable name, or throw NotFoundError.
 *
 * Replaces `getComposition` as the control routes' guard: an element's channel
 * is a legal trigger target but is not a composition id, so the old guard 404'd
 * on exactly the URLs scenes exist to provide.
 */
export async function getChannel(projectId: string, channel: string): Promise<ChannelRef> {
  const found = (await listChannels(projectId)).find((c) => c.channel === channel);
  if (!found) throw new NotFoundError(`channel "${channel}"`);
  return found;
}

export async function deleteComposition(projectId: string, compId: string): Promise<Project> {
  const project = await readProject(projectId);
  project.compositions = project.compositions.filter((c) => c.id !== compId);
  return writeProject(project);
}

export async function assetPath(projectId: string, relative: string): Promise<string> {
  assertSafeId(projectId);
  const base = projectAssetsDir(projectId);
  const resolved = path.resolve(base, relative);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error('asset path escapes project directory');
  }
  return resolved;
}

/* ----------------------------------------------------------- asset index */

/**
 * The asset index — `projects/<id>/assets.json`.
 *
 * Moved out of `project.json` in Phase 7.5. `registerAsset` used to do a full
 * `readProject` → mutate → `writeProject`, so every upload rewrote every
 * composition in the project: the document grew with asset count, composition
 * saves slowed as the bin filled, and two callers raced for one file.
 */
export interface AssetsFile {
  formatVersion: typeof FORMAT_VERSION;
  assets: AssetRef[];
  /** The project's controlled vocabulary — terms the bin offers as suggestions. */
  tags: string[];
}

/**
 * Serializes writes to one project's index.
 *
 * `readAssets` → mutate → `writeAssets` is a read-modify-write, and the editor
 * only happens not to race it because `uploadAssets` awaits each file in turn.
 * Two tabs, two operators or one script do race it, and the loser's asset
 * vanishes from the index while its bytes sit on disk — an orphan nobody can
 * see. A promise chain per project id is the whole fix: the file has exactly
 * one writer path, which is the property the split bought.
 *
 * Per project rather than global so an upload to one project cannot be delayed
 * behind an upload to another. Entries are dropped when the chain drains, so
 * this does not grow with the number of projects ever touched.
 */
const assetLocks = new Map<string, Promise<unknown>>();

async function withAssetLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = assetLocks.get(projectId) ?? Promise.resolve();

  // `then(fn, fn)` so a failed predecessor still releases the lock: the next
  // write is a different write and has no reason to inherit the last one's
  // error.
  const run = previous.then(fn, fn);

  // The chain is held as a swallowed copy. Storing `run` itself would make one
  // rejected write poison every write queued behind it for the life of the
  // process — a single bad upload turning into a bin that can never be changed
  // again until a restart.
  const tail = run.catch(() => undefined);
  assetLocks.set(projectId, tail);

  try {
    return await run;
  } finally {
    // Only when nothing queued behind us; otherwise the newcomer owns the entry.
    if (assetLocks.get(projectId) === tail) assetLocks.delete(projectId);
  }
}

/**
 * Read a project's asset index, migrating a pre-7.5 project on the way.
 *
 * A missing `assets.json` is not an error. It means one of two things and both
 * are handled here: a project created before the split (its index is still in
 * `project.json`, so it is lifted across and written once), or a project with
 * no assets yet (an empty index, not written until something is added).
 *
 * One-way and idempotent. The legacy key is left in `project.json` rather than
 * stripped eagerly — `writeProject` drops it on the next project write, so a
 * read never has to take a write lock on the project document.
 */
export async function readAssets(projectId: string): Promise<AssetsFile> {
  assertSafeId(projectId);

  let raw: string | null = null;
  try {
    raw = await fs.readFile(projectAssetsFile(projectId), 'utf8');
  } catch {
    raw = null;
  }

  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Partial<AssetsFile>;
      return {
        formatVersion: FORMAT_VERSION,
        assets: Array.isArray(parsed.assets) ? parsed.assets : [],
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      };
    } catch {
      /*
       * A corrupt index must not take the project down with it — same call as
       * `readDataSources`. Falling through to the legacy path is deliberate:
       * on a project mid-migration the assets may still be recoverable from
       * `project.json`, and an empty bin is the worst case rather than the
       * first one.
       */
    }
  }

  // Legacy: the index is still inside project.json.
  const project = await readProject(projectId);
  const legacy = project.assets ?? [];
  const file: AssetsFile = { formatVersion: FORMAT_VERSION, assets: legacy, tags: [] };

  // Only materialise when there is something to migrate. A project with no
  // assets gets its file on first upload rather than on first read, which keeps
  // `listProjects` from writing to every project directory it walks.
  if (legacy.length > 0) await writeAssetsFile(projectId, file);
  return file;
}

/** Write the index. Callers that mutate must hold the lock — see `updateAssets`. */
async function writeAssetsFile(projectId: string, file: AssetsFile): Promise<AssetsFile> {
  assertSafeId(projectId);

  const result = validateAssets(file);
  if (!result.valid) {
    const detail = result.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new Error(`invalid asset index — ${detail}`);
  }

  await fs.mkdir(projectDir(projectId), { recursive: true });
  await writeAtomic(projectAssetsFile(projectId), `${JSON.stringify(file, null, 2)}\n`);
  return file;
}

/**
 * Read-modify-write the index under the project's lock.
 *
 * Every mutation goes through here. The mutator receives the current index and
 * returns the next one; it must not perform its own writes.
 */
export async function updateAssets(
  projectId: string,
  mutate: (current: AssetsFile) => AssetsFile | Promise<AssetsFile>,
): Promise<AssetsFile> {
  return withAssetLock(projectId, async () => {
    const current = await readAssets(projectId);
    return writeAssetsFile(projectId, await mutate(current));
  });
}

export async function registerAsset(projectId: string, asset: AssetRef): Promise<AssetsFile> {
  return updateAssets(projectId, (file) => ({
    ...file,
    // Re-registering the same id replaces in place rather than appending, which
    // is what makes re-uploading identical bytes a no-op in the bin as well as
    // on disk.
    assets: [...file.assets.filter((a) => a.id !== asset.id), asset],
  }));
}

/* ----------------------------------------------------------------- assets */

/**
 * Extension → asset kind.
 *
 * The kind decides which layer types may use a file and what the bin shows, so
 * it is recorded once at upload rather than re-sniffed from the extension at
 * every read. Anything unrecognised is `other` rather than rejected: refusing
 * an unknown extension would block a legitimate format the runtime happens to
 * support through the browser, and the layer that references it will fail
 * visibly anyway.
 */
const ASSET_KINDS: Record<string, AssetRef['kind']> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
  '.webp': 'image', '.avif': 'image', '.svg': 'image',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.mkv': 'video', '.m4v': 'video',
  '.woff': 'font', '.woff2': 'font', '.ttf': 'font', '.otf': 'font',
  '.mp3': 'audio', '.wav': 'audio', '.aac': 'audio', '.ogg': 'audio',
};

export function assetKindFor(filename: string): AssetRef['kind'] {
  return ASSET_KINDS[path.extname(filename).toLowerCase()] ?? 'other';
}

/**
 * Pixel dimensions from an image header.
 *
 * A header read, not a decode, and deliberately not a dependency. The four
 * formats below cover everything a graphics designer delivers; anything else —
 * SVG, AVIF, a format added later — returns nothing and the bin simply does not
 * show a size. Every failure mode here is "no dimensions", never a rejected
 * upload: this is metadata about a file the browser is going to render anyway,
 * and a stricter reader would turn an unusual-but-valid PNG into a file the
 * operator cannot upload.
 *
 * Bounds are checked before every read. The buffer is attacker-supplied, and a
 * truncated header that walked off the end would throw inside the upload route
 * rather than in a parser nobody is looking at.
 */
export function imageDimensions(buf: Buffer): { width?: number; height?: number } {
  // PNG — IHDR is always the first chunk, at a fixed offset.
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF — little-endian, fixed offset.
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // WebP (VP8/VP8L/VP8X) — RIFF container, three sub-formats with three layouts.
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && buf.length >= 30) {
      // 24-bit little-endian, stored as one less than the real dimension.
      return {
        width: (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)) + 1,
        height: (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) + 1,
      };
    }
    return {};
  }

  // JPEG — no fixed offset. Walk the segment chain to the first frame header.
  if (buf.length >= 4 && buf.readUInt16BE(0) === 0xffd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1]!;
      // SOF0..SOF15, excluding the four that are not frame headers (DHT c4,
      // JPGA c8, DAC cc) — those carry a length like any other segment.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      const length = buf.readUInt16BE(offset + 2);
      // A zero or negative-length segment would loop forever on a crafted file.
      if (length < 2) return {};
      offset += 2 + length;
    }
  }

  return {};
}

/**
 * A filename safe to write into a project's assets directory.
 *
 * Not a sanitiser bolted onto the original name — a rewrite. Everything outside
 * a conservative allowlist collapses to a hyphen, and the result is prefixed
 * with a content hash. Three problems that solves at once:
 *
 * - **Traversal.** The name arrives from a multipart header, which is attacker
 *   controlled in any deployment reachable from more than one desk. Stripping
 *   `..` is a game you can lose; allowlisting is one you cannot.
 * - **Case collisions.** A project directory is written on Windows and read
 *   inside the Alpine container the harness runs in. `Logo.PNG` and `logo.png`
 *   are one file on one and two on the other — the same reason project ids are
 *   forced lowercase (SCENES.md, URL keys).
 * - **Cache busting.** Output pages are long-lived browser sources and assets
 *   are served immutable. Re-uploading a corrected logo under the same name
 *   would leave the old one on air until someone cleared a cache in vMix.
 */
export function assetFilename(originalName: string, hash: string): string {
  const ext = path.extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const stem = path
    .basename(originalName, path.extname(originalName))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  // A name that was entirely non-Latin — a Cyrillic or CJK filename — reduces
  // to nothing here. `asset` keeps it addressable rather than producing a file
  // called `.png` that is hidden on every Unix host.
  return `${stem || 'asset'}-${hash.slice(0, 8)}${ext}`;
}

/**
 * Write an uploaded file into a project and record it.
 *
 * Content-addressed: the same bytes uploaded twice land on the same path and
 * the second write is a no-op. That is what makes re-uploading safe, and it is
 * the cache the ProRes transcode will key off — transcoding is minutes of CPU,
 * and doing it twice for a file that has not changed is the difference between
 * a usable tool and one nobody waits for.
 */
export async function saveAsset(
  projectId: string,
  originalName: string,
  contents: Buffer,
): Promise<AssetRef> {
  const asset = await writeAssetBytes(projectId, originalName, contents);
  await registerAsset(projectId, asset);
  return asset;
}

/**
 * Put the bytes on disk and describe them, without touching the index.
 *
 * Split out of `saveAsset` for Replace, which needs the same file written the
 * same way but has to make its index change — new row in, old row retired — as
 * a single mutation. Two `registerAsset` calls either side of a project rewrite
 * would leave a window where the bin holds two live rows with the same name,
 * which is the exact state Replace exists to prevent.
 */
async function writeAssetBytes(
  projectId: string,
  originalName: string,
  contents: Buffer,
): Promise<AssetRef> {
  assertSafeId(projectId);
  // Confirms the project exists before writing anything into its directory.
  await readProject(projectId);

  const hash = createHash('sha256').update(contents).digest('hex');
  const filename = assetFilename(originalName, hash);
  const relative = `assets/${filename}`;
  const target = await assetPath(projectId, filename);

  await fs.mkdir(projectAssetsDir(projectId), { recursive: true });

  // Atomic for the same reason project writes are: a browser source may be
  // reading this directory right now, and a half-written video is a graphic
  // that fails on air rather than at upload time.
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, contents);
  await fs.rename(tmp, target);

  const kind = assetKindFor(filename);

  return {
    // The hash *is* the identity. Re-uploading identical bytes updates the
    // existing entry in place instead of adding a duplicate row to the bin.
    id: hash.slice(0, 16),
    path: relative,
    kind,
    originalName,
    bytes: contents.byteLength,
    addedAt: new Date().toISOString(),
    /*
     * Dimensions read from the file header, for images.
     *
     * Cheap — a few dozen bytes off the front of the buffer we are already
     * holding, no decode — and it is what lets the bin say "1920×1080" rather
     * than making an author open the file to find out whether a plate is
     * full-frame. Failure is silently no dimensions: an unrecognised or
     * truncated header is a file the browser may still render, and refusing
     * the upload over a metadata read would be the tail wagging the dog.
     */
    ...(kind === 'image' ? imageDimensions(contents) : {}),
  };
}

/**
 * Fields Replace carries from the superseded asset to its successor.
 *
 * Everything a person typed, and nothing derived from the bytes. A corrected
 * logo is the same logo: it belongs in the same folder, under the same tags,
 * with the same license and the same expiry, and an operator who has to re-file
 * and re-tag after every correction stops filing. The technical fields are
 * excluded for the reason `EDITABLE_ASSET_FIELDS` exists — carrying `hasAlpha`
 * or `codec` across would be a statement about the new bytes derived from the
 * old ones, which is how a flattened .mov comes to be marked transparent.
 *
 * `title` is included and it is the interesting case: it is the label the bin
 * shows, so dropping it would make a replaced asset appear to have been renamed.
 */
const CARRIED_ON_REPLACE = [
  'title', 'description', 'tags', 'folder', 'notes', 'source', 'usage', 'expiresAt',
] as const;

export interface AssetReplacement {
  /** The newly uploaded asset, carrying `supersedes`. */
  asset: AssetRef;
  /** The superseded asset, now retired. Null when the bytes were unchanged. */
  retired: AssetRef | null;
  /** How many `src` references across the project were repointed. */
  rewritten: number;
  /** Which compositions those references were in. */
  compositions: Array<{ id: string; name: string }>;
}

/**
 * Replace one asset's bytes and repoint everything that referred to it.
 *
 * ASSETS.md §2 lists "no replace, no versioning" as the fifth wall: a corrected
 * logo is a new path, and every `src` pointing at the old one keeps pointing at
 * it. §8 specifies the fix in one line — new bytes, rewrite every referencing
 * `src`, keep `supersedes` — and the usage index landed in 0.56.0 precisely so
 * this could be built. This is that.
 *
 * **The old file is retired, not deleted.** The bytes stay on disk and the row
 * stays in the bin marked `retired`, so a replacement done to the wrong asset
 * ten minutes before a show is recoverable by an operator rather than from a
 * backup. The cost is disk, and the orphan report is already the place that
 * cost gets noticed — a retired asset nothing references is exactly what it
 * lists.
 *
 * **Identical bytes are not a replacement.** Content addressing means the same
 * file produces the same id and the same path, so there is nothing to repoint
 * and nothing to supersede. Treated as a plain re-upload rather than as an
 * error: an operator who picks Replace and happens to choose the file already
 * there has not done anything wrong, and retiring an asset in favor of itself
 * would empty the bin row they were trying to update.
 *
 * **Order is chosen for the failure, not the success.** Bytes, then references,
 * then the index. A crash after the bytes leaves an unreferenced file the
 * orphan report will offer to sweep. A crash after the references leaves
 * graphics pointing at the new file — which exists and serves — and a bin
 * missing a row, so air is right and the bookkeeping is wrong. The opposite
 * order fails the other way round: a tidy bin and a graphic pointing at
 * nothing.
 */
export async function replaceAsset(
  projectId: string,
  supersededId: string,
  originalName: string,
  contents: Buffer,
): Promise<AssetReplacement> {
  const old = await getAsset(projectId, supersededId);
  const incoming = await writeAssetBytes(projectId, originalName, contents);

  if (incoming.id === old.id) {
    // Same bytes. `writeAssetBytes` has rewritten the file with its own
    // content, which is a no-op, and there is nothing else to do.
    return { asset: old, retired: null, rewritten: 0, compositions: [] };
  }

  /*
   * References first, in one project write.
   *
   * Read-modify-write against `project.json` the same way `putComposition`
   * does, so a replace is no more dangerous than an ordinary composition save
   * against a concurrent editor — and no less. Compositions with nothing to
   * change are left byte-identical rather than re-serialised.
   */
  const project = await readProject(projectId);
  const touched: Array<{ id: string; name: string }> = [];
  let rewritten = 0;

  const compositions = project.compositions.map((comp) => {
    const result = rewriteAssetReferences(comp.layers, old.path, incoming.path);
    if (result.count === 0) return comp;
    rewritten += result.count;
    touched.push({ id: comp.id, name: comp.name });
    return { ...comp, layers: result.layers };
  });

  if (rewritten > 0) await writeProject({ ...project, compositions });

  /*
   * Then the index, as one mutation: the successor added, the predecessor
   * retired. Done inside a single `updateAssets` so the bin never holds two
   * live rows with the same name, not even for the length of a second write.
   */
  const carried: Partial<AssetRef> = {};
  for (const key of CARRIED_ON_REPLACE) {
    const value = old[key];
    if (value !== undefined) (carried as Record<string, unknown>)[key] = value;
  }

  const successor: AssetRef = {
    ...incoming,
    ...carried,
    /*
     * State is carried with one exception: a retired predecessor.
     *
     * Replacing a retired asset is how an operator un-retires one — they have
     * gone looking for the old file and put a corrected version over it — and
     * inheriting `retired` would hide the result from the default bin view,
     * which reads as the upload having silently failed.
     */
    ...(old.state && old.state !== 'retired' ? { state: old.state } : {}),
    supersedes: old.id,
  };

  await updateAssets(projectId, (file) => ({
    ...file,
    assets: [
      ...file.assets
        .filter((a) => a.id !== successor.id)
        .map((a) => (a.id === old.id ? { ...a, state: 'retired' as const } : a)),
      successor,
    ],
  }));

  return {
    asset: successor,
    retired: { ...old, state: 'retired' },
    rewritten,
    compositions: touched,
  };
}

/**
 * Merge freshly-derived technical metadata into an existing row.
 *
 * Separate from `saveAsset` because the two facts arrive at different times:
 * bytes and dimensions are known the moment the upload lands, but duration,
 * codec and alpha come from ffprobe, which is a subprocess and may not exist on
 * this machine at all. The upload must not wait on it and must not fail with it.
 *
 * Technical fields only, and it overwrites rather than fills gaps — these are
 * derived facts about bytes that cannot change, so a stale value is always
 * wrong and never a preference someone set.
 */
export async function recordAssetProbe(
  projectId: string,
  assetId: string,
  probe: Pick<AssetRef, 'width' | 'height' | 'duration' | 'hasAlpha' | 'codec'>,
): Promise<AssetRef | null> {
  let updated: AssetRef | null = null;

  await updateAssets(projectId, (file) => ({
    ...file,
    assets: file.assets.map((a) => {
      if (a.id !== assetId) return a;
      updated = {
        ...a,
        ...Object.fromEntries(Object.entries(probe).filter(([, v]) => v !== undefined)),
      };
      return updated;
    }),
  }));

  return updated;
}

/**
 * Apply an edit to one or more assets, and fold any new tags into the project's
 * vocabulary.
 *
 * Editable fields only — `AssetEdit` is `Pick`ed from the descriptive,
 * administrative and rights groups, and the route rejects unknown keys before
 * they reach here. Technical fields are derived from the bytes, so a hand-set
 * value is not a preference, it is a false statement about the file.
 *
 * Setting a field to `null` clears it. `undefined` leaves it alone, which is
 * what makes one code path serve both "rename this" and "tag these forty".
 *
 * The vocabulary only grows. A term survives the deletion of the last asset
 * using it, which is what stops a bin quietly re-fragmenting: the suggestion is
 * still there next time, so nobody re-invents `station-logo` as `stationlogo`.
 */
export async function editAssets(
  projectId: string,
  assetIds: readonly string[],
  edit: AssetEdit,
  /**
   * Tags merged into whatever each asset already carries, rather than replacing.
   *
   * Exists because "tag these forty as sponsors" has no single value to set:
   * each asset's resulting tag list depends on its own, so a plain `tags` edit
   * would either need one request per asset or would quietly discard whatever
   * distinct tags the other thirty-nine had. Merging server-side keeps a bulk
   * edit one lock, one read, one write — which is the only reason bulk is
   * faster than a loop.
   */
  addTags: readonly string[] = [],
): Promise<AssetRef[]> {
  const wanted = new Set(assetIds);
  const merge = normalizeTags(addTags);
  const touched: AssetRef[] = [];

  await updateAssets(projectId, (file) => {
    const assets = file.assets.map((asset) => {
      if (!wanted.has(asset.id)) return asset;

      const next: AssetRef = { ...asset };

      if (merge.length > 0) {
        next.tags = normalizeTags([...(asset.tags ?? []), ...merge]);
      }

      for (const [key, value] of Object.entries(edit)) {
        if (value === undefined) continue;
        if (value === null || value === '') {
          delete next[key as keyof AssetRef];
          continue;
        }
        if (key === 'tags') {
          next.tags = normalizeTags(value as string[]);
          if (next.tags.length === 0) delete next.tags;
          continue;
        }
        if (key === 'folder') {
          const folder = normalizeFolder(value as string);
          if (folder) next.folder = folder;
          else delete next.folder;
          continue;
        }
        (next as unknown as Record<string, unknown>)[key] = value;
      }

      touched.push(next);
      return next;
    });

    const vocabulary = new Set(file.tags);
    for (const asset of touched) for (const tag of asset.tags ?? []) vocabulary.add(tag);

    return { ...file, assets, tags: [...vocabulary].sort() };
  });

  return touched;
}

/** The project's tag vocabulary — the terms the bin offers as suggestions. */
export async function assetVocabulary(projectId: string): Promise<string[]> {
  return (await readAssets(projectId)).tags;
}

/**
 * Add terms to the vocabulary without attaching them to anything.
 *
 * Lets a station seed its own taxonomy before the first upload, which is the
 * difference between a controlled vocabulary and a record of whatever got typed
 * first.
 */
export async function addVocabulary(projectId: string, tags: readonly string[]): Promise<string[]> {
  const added = normalizeTags(tags);
  const file = await updateAssets(projectId, (current) => ({
    ...current,
    tags: [...new Set([...current.tags, ...added])].sort(),
  }));
  return file.tags;
}

export async function listAssets(projectId: string): Promise<AssetRef[]> {
  return (await readAssets(projectId)).assets;
}

export async function getAsset(projectId: string, assetId: string): Promise<AssetRef> {
  const found = (await readAssets(projectId)).assets.find((a) => a.id === assetId);
  if (!found) throw new NotFoundError(`asset ${assetId}`);
  return found;
}

/**
 * Forget an asset and delete its file.
 *
 * The index entry is dropped first. If the unlink then fails — a file already
 * gone, or one held open by a browser source mid-read — the bin is still
 * correct, which is the state the author can act on. An orphaned file on disk
 * costs space; a bin listing a file that is not there costs a graphic that
 * renders blank with no explanation.
 */
export async function deleteAsset(projectId: string, assetId: string): Promise<AssetsFile> {
  // Read before the lock only to produce a clean 404; the authoritative read
  // happens inside the mutation.
  const asset = await getAsset(projectId, assetId);

  const next = await updateAssets(projectId, (file) => ({
    ...file,
    assets: file.assets.filter((a) => a.id !== assetId),
  }));

  try {
    await fs.unlink(await assetPath(projectId, asset.path.replace(/^assets\//, '')));
  } catch {
    /* Already gone, or locked by a reader. The bin is what matters. */
  }
  return next;
}

/* --------------------------------------------------------------- usage */

/**
 * Which compositions reference a given asset path.
 *
 * The answer the bin could never give: `referencedAssets` ran in the editor
 * against the composition currently open, so "in use" meant "in use *here*" and
 * delete was a judgment call. Asked across the whole project, it makes delete
 * honest, scopes a composition export, and turns an expiry date into something
 * an operator can act on.
 *
 * Keyed on `path` rather than on the asset id because that is what a layer
 * actually holds. An imported project whose index was rebuilt may carry a
 * different id for the same file; the path is the reference that has to match.
 */
export async function assetUsage(projectId: string, assetPathValue: string): Promise<AssetUsage[]> {
  const project = await readProject(projectId);
  const out: AssetUsage[] = [];

  for (const comp of project.compositions) {
    const references = assetReferences(comp.layers).filter((r) => r.src === assetPathValue);
    if (references.length > 0) {
      out.push({ compositionId: comp.id, compositionName: comp.name, references });
    }
  }

  return out;
}

/**
 * Assets no composition in the project references.
 *
 * The other direction, and the one that makes tidying safe. A transcode source
 * counts as an orphan the moment its WebM is the thing on air, which is correct
 * — that ProRes is exactly what an operator wants to find and archive.
 */
export async function orphanAssets(projectId: string): Promise<AssetRef[]> {
  const project = await readProject(projectId);
  const referenced = new Set<string>();
  for (const comp of project.compositions) {
    for (const src of referencedAssets(comp.layers)) referenced.add(src);
  }

  const { assets } = await readAssets(projectId);
  return assets.filter((a) => !referenced.has(a.path));
}

export { CompositionValidationError };
