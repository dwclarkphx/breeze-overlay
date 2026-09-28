// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * JPEG frames out of a byte stream — a camera's motion-JPEG body (CYCLE.md,
 * Wave 8).
 *
 * The multipart wrapping is not trusted. Cameras disagree about boundaries,
 * whether a part carries `Content-Length`, and whether that length is right,
 * so the frames are found in the bytes themselves: from a start-of-image
 * marker, segment by segment, to the end-of-image marker.
 *
 * Walking the segments rather than searching for the first `FF D9` is what
 * makes this correct. An EXIF header carries a whole thumbnail JPEG, end
 * marker and all, inside its APP1 segment — a byte search would cut the frame
 * off there and hand on a picture with its bottom missing. Segment lengths
 * step over it. Inside the compressed data an `FF` is always followed by `00`
 * or a restart marker, so the first other marker there is genuinely the next
 * one.
 */

const SOI = Buffer.from([0xff, 0xd8, 0xff]);

/** Index just past the frame's end-of-image marker; -1 more bytes needed; -2 not a JPEG. */
export function jpegFrameEnd(b: Buffer): number {
  let i = 2;
  for (;;) {
    if (i + 2 > b.length) return -1;
    if (b[i] !== 0xff) return -2;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd9) return i + 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (i + 4 > b.length) return -1;
    const length = b.readUInt16BE(i + 2);
    if (length < 2) return -2;
    const segmentEnd = i + 2 + length;
    if (marker !== 0xda) {
      if (segmentEnd > b.length) return -1;
      i = segmentEnd;
      continue;
    }
    // Start of scan: compressed data runs to the next real marker.
    let j = segmentEnd;
    for (;;) {
      const k = b.indexOf(0xff, j);
      if (k < 0 || k + 1 >= b.length) return -1;
      const next = b[k + 1]!;
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        j = k + 2;
        continue;
      }
      if (next === 0xff) {
        j = k + 1;
        continue;
      }
      if (next === 0xd9) return k + 2;
      // A progressive JPEG: more tables and scans follow.
      i = k;
      break;
    }
  }
}

export class JpegSplitter {
  private buf: Buffer = Buffer.alloc(0);
  /** Chunks received since `buf` was last assembled — joined only when a frame may be complete. */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** The last byte seen, so an end marker split across two chunks is still noticed. */
  private lastByte = -1;

  constructor(private readonly maxFrameBytes = 4 * 1024 * 1024) {}

  /**
   * Feed bytes; get back every frame they completed. Throws past `maxFrameBytes`.
   *
   * A 2 MB frame arrives in a hundred chunks; joining and re-walking it on
   * every one is quadratic. So chunks are only collected until one holds an
   * end-of-image marker, and the frame is assembled and walked then.
   */
  push(chunk: Uint8Array): Buffer[] {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const endsHere = bytes.indexOf(Buffer.from([0xff, 0xd9])) >= 0 || (this.lastByte === 0xff && bytes[0] === 0xd9);
    this.lastByte = bytes.length ? bytes[bytes.length - 1]! : this.lastByte;
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    if (!endsHere) {
      if (this.buf.length + this.pendingBytes > this.maxFrameBytes * 2) {
        this.buf = Buffer.alloc(0);
        this.pending = [];
        this.pendingBytes = 0;
        throw new Error(`a frame over ${this.maxFrameBytes} bytes`);
      }
      return [];
    }
    this.buf = Buffer.concat([this.buf, ...this.pending]);
    this.pending = [];
    this.pendingBytes = 0;
    const frames: Buffer[] = [];
    for (;;) {
      const start = this.buf.indexOf(SOI);
      if (start < 0) {
        // Keep a tail that could be the start of a marker split across chunks.
        this.buf = this.buf.subarray(Math.max(0, this.buf.length - 2));
        break;
      }
      if (start > 0) this.buf = this.buf.subarray(start);
      const end = jpegFrameEnd(this.buf);
      if (end === -1) {
        if (this.buf.length > this.maxFrameBytes) {
          this.buf = Buffer.alloc(0);
          throw new Error(`a frame over ${this.maxFrameBytes} bytes`);
        }
        break;
      }
      if (end === -2) {
        this.buf = this.buf.subarray(2);
        continue;
      }
      frames.push(Buffer.from(this.buf.subarray(0, end)));
      this.buf = this.buf.subarray(end);
    }
    return frames;
  }
}

/** What an image's first bytes say it is, or null when it is not a picture a browser shows. */
export function imageType(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
