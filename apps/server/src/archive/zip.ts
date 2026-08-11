// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Hardened zip reading.
 *
 * The one parser this server allows in front of a filesystem write, and it is
 * allowed on a narrower argument than the one Wave 0 rejected multipart on.
 * Multipart is delimiter-scanned: its failure modes are crafted boundaries,
 * smuggled second parts and filenames split across header continuations, and
 * they exist because the format has no index. A zip has a central directory —
 * a length-prefixed table of contents — so entry names and sizes are known
 * before a single byte is inflated, which is exactly what makes the checks
 * below possible at all.
 *
 * The bit-level parsing is `fflate`'s. What is ours, and what actually keeps
 * this safe, is the policy: no path escapes the destination, no archive is
 * allowed to be a decompression bomb, and nothing lands in a served directory
 * that a browser would execute.
 *
 * **Written for two callers on purpose.** Phase 7.5's project and composition
 * restore is next and needs the identical guarantees; a second reader written
 * then would be a second set of these checks to get right, and the one that
 * gets it wrong is the one nobody exercised. This one runs on every sequence
 * upload.
 */

import { unzipSync, zipSync } from 'fflate';

import { refusedExtension } from '../refused.js';

export interface ZipEntry {
  /** Normalised, forward-slashed, relative path as it appeared in the archive. */
  name: string;
  /** The file's basename — what a sequence sorts on. */
  base: string;
  bytes: Uint8Array;
}

export interface ZipLimits {
  /**
   * Cap on entry count.
   *
   * An archive of a million empty files inflates to nothing and still costs an
   * hour of syscalls, so a total-bytes cap alone does not cover it.
   */
  maxEntries: number;
  /** Cap on the sum of uncompressed sizes — the decompression-bomb ceiling. */
  maxTotalBytes: number;
  /** Cap on any single entry. */
  maxEntryBytes: number;
}

export class ArchiveError extends Error {}

/**
 * Is this entry name safe to join onto a destination directory?
 *
 * Refusal rather than sanitisation, on the same principle `assetFilename` was
 * written to: stripping `..` is a game you can lose — `....//` survives one
 * pass, and a sanitiser that runs once on a name the caller then re-joins is
 * how traversal bugs come back. Refusing is a game you cannot lose, and an
 * archive containing such a name is not one an operator meant to upload.
 *
 * Backslashes are rejected rather than translated. A zip is specified to use
 * forward slashes; a backslash is a literal character in an entry name on
 * every conforming writer, and treating it as a separator on Windows and a
 * character on Linux is precisely the divergence that makes a traversal check
 * pass on the developer's machine and fail on the operator's.
 */
export function unsafeEntryName(name: string): string | null {
  if (name === '') return 'an empty entry name';
  if (name.includes('\0')) return 'a NUL byte in an entry name';
  if (name.includes('\\')) return `a backslash in "${name}"`;
  if (name.startsWith('/')) return `an absolute path "${name}"`;
  if (/^[a-zA-Z]:/.test(name)) return `a drive-letter path "${name}"`;
  if (name.split('/').includes('..')) return `a parent-directory segment in "${name}"`;
  return null;
}

/**
 * Read an archive into memory, refusing anything that breaks the policy.
 *
 * Whole-archive rather than streaming, deliberately. The caps are what make
 * that safe — nothing above `maxTotalBytes` is ever held — and a streaming
 * reader would have to decide what to do with the files it had already written
 * when entry 200 turns out to be malicious. Buffering means the archive is
 * accepted or rejected before anything touches the disk, which is the property
 * the restore path will want even more than this one does.
 */
export function readArchive(buffer: Buffer, limits: ZipLimits): ZipEntry[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch (err) {
    throw new ArchiveError(`not a readable zip archive: ${err instanceof Error ? err.message : String(err)}`);
  }

  const names = Object.keys(files);
  if (names.length > limits.maxEntries) {
    throw new ArchiveError(`archive holds ${names.length} entries, over the ${limits.maxEntries} limit`);
  }

  const out: ZipEntry[] = [];
  let total = 0;

  for (const name of names) {
    const bytes = files[name];
    if (!bytes) continue;

    // Directory entries are zero-length names ending in a slash. Nothing is
    // created from them — the destination tree is made by the caller — so they
    // are skipped rather than refused.
    if (name.endsWith('/')) continue;

    const unsafe = unsafeEntryName(name);
    if (unsafe) throw new ArchiveError(`archive rejected: ${unsafe}`);

    /*
     * Dot-underscore files and __MACOSX are skipped, not refused.
     *
     * macOS's Archive Utility writes a resource-fork sibling for every file it
     * compresses. They are not the operator's doing, they are not visible in
     * Finder, and refusing the archive over them would make "zip the folder"
     * fail on the most common way to zip a folder.
     */
    if (name.startsWith('__MACOSX/') || name.split('/').pop()?.startsWith('._')) continue;

    const refused = refusedExtension(name);
    if (refused) {
      throw new ArchiveError(
        `archive rejected: ${refused} files are not accepted — the assets directory is served to browsers`,
      );
    }

    if (bytes.byteLength > limits.maxEntryBytes) {
      throw new ArchiveError(`"${name}" is ${bytes.byteLength} bytes, over the per-file limit`);
    }

    total += bytes.byteLength;
    if (total > limits.maxTotalBytes) {
      throw new ArchiveError(`archive inflates past the ${limits.maxTotalBytes}-byte limit`);
    }

    out.push({ name, base: name.split('/').pop() ?? name, bytes });
  }

  if (out.length === 0) throw new ArchiveError('archive holds no usable files');
  return out;
}

/**
 * Write an archive.
 *
 * The counterpart the reader shipped without, added when backup and restore
 * arrived. Deliberately much smaller than the reader, and that asymmetry is the
 * point: reading is where the danger is, because the bytes come from outside.
 * Everything written here was assembled by this server from its own data
 * directory.
 *
 * **Assets are stored, not deflated.** A project's bulk is PNGs, WebMs and
 * fonts, all of which are already compressed — running deflate over them costs
 * CPU on a box that may be feeding a switcher and typically *adds* a percent or
 * two. The JSON is compressed, because that is where the redundancy is and it
 * is small enough to be free.
 */
export function writeArchive(files: Record<string, Uint8Array>): Buffer {
  const shaped: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const [name, bytes] of Object.entries(files)) {
    // A bundle we wrote should still not be able to name something that a
    // restore would refuse — better to fail here, where the developer sees it,
    // than to ship an archive nobody can read back.
    const unsafe = unsafeEntryName(name);
    if (unsafe) throw new ArchiveError(`refusing to write ${unsafe}`);
    shaped[name] = [bytes, { level: name.endsWith('.json') ? 6 : 0 }];
  }
  return Buffer.from(zipSync(shaped));
}

/**
 * Order frames the way a human numbered them.
 *
 * Lexicographic order puts `frame10.png` before `frame9.png`, which does not
 * fail loudly — it produces a video whose frames are in the wrong order, and
 * on a 300-frame stinger nobody notices until it is on air. Real exports are
 * also not reliably zero-padded and do not reliably start at 1 or 0, which is
 * why the frames are ordered here and then handed to ffmpeg through a concat
 * list rather than through a `%04d` input pattern: the pattern requires
 * contiguous numbering from a known start, and renumbering the operator's
 * files to satisfy it is work that can be wrong.
 */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const as = a.toLowerCase().match(re) ?? [];
  const bs = b.toLowerCase().match(re) ?? [];

  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const x = as[i]!;
    const y = bs[i]!;
    const xn = /^\d/.test(x);
    const yn = /^\d/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return as.length - bs.length;
}
