// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The archive reader and the sequence assembler.
 *
 * This is the one parser the server allows in front of a filesystem write, so
 * the refusals are tested as behaviour rather than assumed from the code. Every
 * traversal case below is a real archive that a real zip writer can produce.
 */

import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';

import { ArchiveError, naturalCompare, readArchive, unsafeEntryName } from '../archive/zip.js';
import { SequenceError, manifestKey, orderFrames } from '../media/sequence.js';
import type { ZipEntry } from '../archive/zip.js';

const LIMITS = { maxEntries: 100, maxTotalBytes: 1_000_000, maxEntryBytes: 500_000 };

/** A minimal PNG-ish payload; nothing here decodes it. */
const px = (seed = 'x'): Uint8Array => strToU8(`\x89PNG${seed}`);

function zip(files: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync(files));
}

describe('unsafeEntryName', () => {
  it('accepts an ordinary nested name', () => {
    expect(unsafeEntryName('burst/frame001.png')).toBeNull();
  });

  it('refuses an absolute path', () => {
    expect(unsafeEntryName('/etc/passwd')).toContain('absolute');
  });

  it('refuses a parent-directory segment', () => {
    expect(unsafeEntryName('../../etc/passwd')).toContain('parent-directory');
  });

  it('refuses a parent segment buried mid-path', () => {
    // The case a naive `startsWith('..')` check misses entirely.
    expect(unsafeEntryName('frames/../../escape.png')).toContain('parent-directory');
  });

  it('refuses a drive-letter path', () => {
    expect(unsafeEntryName('C:/windows/system32/evil.dll')).toContain('drive-letter');
  });

  it('refuses a backslash rather than translating it', () => {
    // Translating would make the traversal check pass on Linux and fail on
    // Windows, which is the worst of both.
    expect(unsafeEntryName('..\\..\\evil.png')).toContain('backslash');
  });

  it('refuses a NUL byte', () => {
    expect(unsafeEntryName('frame\0.png')).toContain('NUL');
  });

  it('does not mistake a dotted filename for traversal', () => {
    // `..` is refused as a whole path *segment*, not as a substring — a file
    // genuinely called `my..frames.png` is not an attack.
    expect(unsafeEntryName('my..frames.png')).toBeNull();
  });
});

describe('readArchive', () => {
  it('reads the files out of an ordinary archive', () => {
    const entries = readArchive(zip({ 'a.png': px('1'), 'b.png': px('2') }), LIMITS);
    expect(entries.map((e) => e.base).sort()).toEqual(['a.png', 'b.png']);
  });

  it('refuses a traversing entry', () => {
    expect(() => readArchive(zip({ '../escape.png': px() }), LIMITS)).toThrow(ArchiveError);
  });

  it('refuses an executable type even inside an archive', () => {
    // The reason the REFUSED list moved out of the upload route: an archive
    // that unpacks into the served directory has to apply the same rule.
    expect(() => readArchive(zip({ 'a.png': px(), 'payload.html': px() }), LIMITS)).toThrow(/not accepted/);
  });

  it('caps the entry count', () => {
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 200; i++) many[`f${i}.png`] = px(String(i));
    expect(() => readArchive(zip(many), LIMITS)).toThrow(/over the 100 limit/);
  });

  it('caps the inflated total', () => {
    const big = new Uint8Array(300_000);
    expect(() =>
      readArchive(zip({ 'a.png': big, 'b.png': big, 'c.png': big, 'd.png': big }), LIMITS),
    ).toThrow(/inflates past/);
  });

  it('caps a single entry', () => {
    expect(() => readArchive(zip({ 'a.png': new Uint8Array(600_000) }), LIMITS)).toThrow(/per-file limit/);
  });

  it('skips macOS resource forks instead of refusing them', () => {
    // Archive Utility writes these unasked. Refusing would make "zip the
    // folder" fail on the most common way to zip a folder.
    const entries = readArchive(
      zip({ 'a.png': px('1'), '__MACOSX/._a.png': px('2'), '._a.png': px('3') }),
      LIMITS,
    );
    expect(entries.map((e) => e.base)).toEqual(['a.png']);
  });

  it('rejects something that is not a zip at all', () => {
    expect(() => readArchive(Buffer.from('not a zip'), LIMITS)).toThrow(ArchiveError);
  });

  it('rejects an archive with nothing usable in it', () => {
    expect(() => readArchive(zip({ '__MACOSX/._a.png': px() }), LIMITS)).toThrow(/no usable files/);
  });
});

describe('naturalCompare', () => {
  it('orders unpadded numbers the way a human numbered them', () => {
    // Lexicographic order puts frame10 before frame9 and produces a video whose
    // frames are in the wrong order — which fails silently, on air.
    const names = ['frame9.png', 'frame10.png', 'frame1.png'];
    expect([...names].sort(naturalCompare)).toEqual(['frame1.png', 'frame9.png', 'frame10.png']);
  });

  it('agrees with lexicographic order when the export was padded', () => {
    const names = ['f0010.png', 'f0002.png'];
    expect([...names].sort(naturalCompare)).toEqual(['f0002.png', 'f0010.png']);
  });

  it('handles a start index other than zero or one', () => {
    const names = ['shot_1001.png', 'shot_999.png', 'shot_1000.png'];
    expect([...names].sort(naturalCompare)).toEqual(['shot_999.png', 'shot_1000.png', 'shot_1001.png']);
  });
});

describe('orderFrames', () => {
  const entry = (name: string): ZipEntry => ({ name, base: name.split('/').pop()!, bytes: px(name) });

  it('drops non-image siblings rather than failing', () => {
    // An export folder routinely carries a render log beside the frames.
    const frames = orderFrames([entry('a1.png'), entry('render.log'), entry('a2.png')]);
    expect(frames.map((f) => f.base)).toEqual(['a1.png', 'a2.png']);
  });

  it('sorts naturally, not lexicographically', () => {
    const frames = orderFrames([entry('f10.png'), entry('f2.png'), entry('f1.png')]);
    expect(frames.map((f) => f.base)).toEqual(['f1.png', 'f2.png', 'f10.png']);
  });

  it('sorts on the basename so a stray directory cannot interleave', () => {
    const frames = orderFrames([entry('z/f2.png'), entry('a/f1.png')]);
    expect(frames.map((f) => f.base)).toEqual(['f1.png', 'f2.png']);
  });

  it('refuses an archive with no frames', () => {
    expect(() => orderFrames([entry('notes.txt')])).toThrow(SequenceError);
  });

  it('refuses a single-frame sequence', () => {
    expect(() => orderFrames([entry('only.png')])).toThrow(/at least two frames/);
  });
});

describe('manifestKey', () => {
  const entry = (name: string, seed: string): ZipEntry => ({ name, base: name, bytes: px(seed) });

  it('is stable for the same frames in the same order', () => {
    const a = [entry('1.png', 'a'), entry('2.png', 'b')];
    const b = [entry('1.png', 'a'), entry('2.png', 'b')];
    expect(manifestKey(a)).toBe(manifestKey(b));
  });

  it('changes when a frame changes', () => {
    const a = [entry('1.png', 'a'), entry('2.png', 'b')];
    const b = [entry('1.png', 'a'), entry('2.png', 'CHANGED')];
    expect(manifestKey(a)).not.toBe(manifestKey(b));
  });

  it('changes when the order changes', () => {
    // The case the natural sort exists to get right, and therefore the case the
    // cache must never answer from a previous run.
    const a = [entry('1.png', 'a'), entry('2.png', 'b')];
    const b = [entry('2.png', 'b'), entry('1.png', 'a')];
    expect(manifestKey(a)).not.toBe(manifestKey(b));
  });

  it('ignores the frames\u2019 names', () => {
    // Renaming an export must not cost a re-encode; only the pixels and their
    // order decide the output.
    const a = [entry('1.png', 'a'), entry('2.png', 'b')];
    const b = [entry('shot_0001.png', 'a'), entry('shot_0002.png', 'b')];
    expect(manifestKey(a)).toBe(manifestKey(b));
  });
});
