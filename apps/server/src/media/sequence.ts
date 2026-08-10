// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * PNG image sequences → VP9/WebM with alpha.
 *
 * The second half of Phase 7's media work, and the same destination as the
 * ProRes path by a different road: a motion designer who cannot deliver ProRes
 * delivers a numbered PNG sequence, and a browser will play neither.
 *
 * Three things differ from a single-file transcode and each one is a decision.
 *
 * **The cache key is the manifest, not a file.** The queue's whole cache
 * property comes from naming the output after the *source* hash, so the same
 * source lands on the same path and skips minutes of CPU. A sequence has no
 * single source, so the key is a hash over the ordered list of per-frame
 * hashes. That makes it sensitive to exactly what it should be — a frame's
 * bytes changing, or the *order* changing — and insensitive to what it should
 * not, like the zip's compression level or its name.
 *
 * **Frames are inputs, not assets.** They are staged outside the assets
 * directory and deleted when the encode finishes. Registering 300 PNGs in the
 * bin would undo what Phase 7.5 Wave B built: a library whose purpose is
 * finding one logo among 200 does not survive three hundred rows nobody will
 * ever pick from a dropdown.
 *
 * **ffmpeg is fed a concat list, not a `%04d` pattern.** The pattern requires
 * contiguous numbering from a known start, and real exports are not reliably
 * padded, do not reliably start at 0 or 1, and sometimes have gaps. Renumbering
 * the operator's files to satisfy the pattern is work that can be wrong;
 * writing the sorted names into a list file cannot be.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { projectDir } from '../config.js';
import { naturalCompare, type ZipEntry } from '../archive/zip.js';

/** Frames staged here, outside `assets/`, so nothing lands in the bin. */
export const sequenceStagingDir = (projectId: string, key: string): string =>
  path.join(projectDir(projectId), '.sequences', key);

/** Image types a sequence may be built from. */
const FRAME_EXTENSIONS = new Set(['.png', '.tga', '.tiff', '.tif']);

export interface StagedSequence {
  /** Content key over the ordered frames — the cache key and the staging dir name. */
  key: string;
  /** Absolute path to the concat list ffmpeg reads. */
  listFile: string;
  dir: string;
  frameCount: number;
}

export class SequenceError extends Error {}

/**
 * Pick the frames out of an archive and put them in playback order.
 *
 * Non-image entries are dropped rather than refused: an export folder routinely
 * carries a `.txt` render log or a `.aep` project file beside the frames, and
 * failing the upload over one would be refusing the archive the operator
 * actually has. Anything dangerous was already refused by the reader.
 */
export function orderFrames(entries: ZipEntry[]): ZipEntry[] {
  const frames = entries.filter((e) => FRAME_EXTENSIONS.has(path.extname(e.base).toLowerCase()));
  if (frames.length === 0) {
    throw new SequenceError('no PNG, TGA or TIFF frames found in the archive');
  }
  if (frames.length < 2) {
    throw new SequenceError('a sequence needs at least two frames — upload a single image as an asset instead');
  }

  /*
   * Sorted on the basename, not the full path.
   *
   * A zip of an export folder has every frame under the same directory, so the
   * prefix is identical and sorting on it is harmless — until the archive was
   * made by selecting the folder rather than its contents, at which point a
   * stray sibling directory sorts its frames into the middle of the sequence.
   */
  return [...frames].sort((a, b) => naturalCompare(a.base, b.base));
}

/**
 * Hash the ordered frames.
 *
 * Per-frame digests folded into one, rather than hashing the concatenated
 * bytes, so the boundary between frames is part of the key: two different
 * splits of the same total bytes must not collide. The index goes in too,
 * which is what makes a reordered sequence a different key — the case the
 * natural sort exists to get right, and therefore the case a cache must not
 * quietly answer from a previous run.
 */
export function manifestKey(frames: readonly ZipEntry[]): string {
  const outer = createHash('sha256');
  frames.forEach((frame, i) => {
    outer.update(String(i));
    outer.update(':');
    outer.update(createHash('sha256').update(frame.bytes).digest());
  });
  return outer.digest('hex').slice(0, 16);
}

/**
 * Write the frames and the concat list to disk.
 *
 * Returns early when the staging directory is already populated for this key —
 * the same sequence uploaded twice is the same bytes in the same order, and
 * re-writing 300 files to reach an output the queue is about to find in its
 * cache anyway is pure cost.
 */
export async function stageSequence(projectId: string, frames: readonly ZipEntry[]): Promise<StagedSequence> {
  const key = manifestKey(frames);
  const dir = sequenceStagingDir(projectId, key);
  const listFile = path.join(dir, 'frames.txt');

  await fs.mkdir(dir, { recursive: true });

  try {
    await fs.access(listFile);
    return { key, listFile, dir, frameCount: frames.length };
  } catch {
    /* Not staged yet, which is the normal path. */
  }

  /*
   * Frames are renamed to a fixed-width index, and the operator's names are
   * discarded on purpose.
   *
   * The order has already been decided by `orderFrames`; carrying the original
   * names forward would mean the concat list is the only thing that knows the
   * order, and any later code that globbed the directory — a debug script, a
   * cleanup pass, a future resume-after-crash — would silently see them in
   * lexicographic order again. Writing the order into the filenames makes the
   * directory self-describing.
   */
  const ext = path.extname(frames[0]!.base).toLowerCase();
  const names: string[] = [];
  for (const [i, frame] of frames.entries()) {
    const name = `${String(i).padStart(6, '0')}${ext}`;
    await fs.writeFile(path.join(dir, name), frame.bytes);
    names.push(name);
  }

  /*
   * Relative names in the list, with ffmpeg run from the staging directory.
   *
   * `-safe 0` is what a concat list needs to accept absolute paths, and it
   * disables the very check that stops a list file naming something outside its
   * own tree. Keeping the names relative means the list stays safe with `-safe`
   * left at its default — the paths cannot escape because they have nowhere to
   * escape to.
   *
   * The list is written last. Its presence is what the early return above tests
   * for, so a run that dies partway through writing frames leaves a directory
   * with no list, and the next attempt re-stages instead of encoding a
   * truncated sequence.
   */
  const list = names.map((n) => `file '${n}'`).join('\n');
  await fs.writeFile(`${listFile}.part`, `${list}\n`, 'utf8');
  await fs.rename(`${listFile}.part`, listFile);

  return { key, listFile, dir, frameCount: frames.length };
}

/** Drop a staged sequence once its output exists. */
export async function discardStaged(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
