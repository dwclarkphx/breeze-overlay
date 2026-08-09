// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * ffmpeg detection and the transcode queue.
 *
 * The container these run in has no ffmpeg, which makes the *absent* path — the
 * one an operator on a fresh box actually hits — the easy case to cover and the
 * important one to get right. Everything that needs a real encoder is factored
 * into pure functions and tested directly.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-media-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';
// A name nothing will resolve, so the suite tests the "not installed" path
// regardless of what the host running it happens to have.
process.env['BREEZE_FFMPEG_PATH'] = 'breeze-no-such-ffmpeg';
process.env['BREEZE_FFPROBE_PATH'] = 'breeze-no-such-ffprobe';

const { buildApp } = await import('../app.js');
const { capabilities, resetCapabilities, hasAlpha, parseFrameRate, pixelFormatHasAlpha, run } =
  await import('../media/ffmpeg.js');
const { lastMeaningfulLine } = await import('../media/transcode.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => resetCapabilities());

describe('probing for ffmpeg', () => {
  it('reports unavailable rather than throwing when it is not installed', async () => {
    const caps = await capabilities();
    expect(caps.available).toBe(false);
    expect(caps.vp9Alpha).toBe(false);
    expect(caps.version).toBeNull();
  });

  it('says what to do about it', async () => {
    // The reason is the whole point of this endpoint: without it a disabled
    // button gets reported as a bug instead of installing ffmpeg.
    const caps = await capabilities();
    expect(caps.reason).toContain('ffmpeg');
    expect(caps.reason).toContain('BREEZE_FFMPEG_PATH');
  });

  it('caches, so the editor asking on every load costs one probe', async () => {
    const a = await capabilities();
    const b = await capabilities();
    expect(b).toBe(a);
  });

  it('returns not-ok for a command that does not exist, rather than rejecting', async () => {
    // `spawn` raises ENOENT asynchronously; an unhandled version of that would
    // take the server down at boot on any machine without ffmpeg.
    const result = await run('breeze-definitely-not-a-command', ['-version']);
    expect(result.ok).toBe(false);
  });
});

describe('capabilities endpoint', () => {
  it('answers even with no ffmpeg, and explains why', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/media/capabilities' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(false);
    expect(body.reason).toBeTruthy();
  });
});

describe('transcode routes without ffmpeg', () => {
  const uploadVideo = async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/demo/assets?name=stinger.mov',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('not-really-a-mov'),
    });
    return res.json().asset as { id: string };
  };

  it('refuses a transcode with 503, not 400', async () => {
    // The request is well formed and the machine cannot serve it — and may be
    // able to after an install and a restart. A 400 would say the client was
    // wrong, which would send someone looking in the wrong place.
    const asset = await uploadVideo();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/demo/assets/${asset.id}/transcode`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain('ffmpeg');
  });

  it('reports 503 from probe too', async () => {
    const asset = await uploadVideo();
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/demo/assets/${asset.id}/probe`,
    });
    expect(res.statusCode).toBe(503);
  });

  it('404s probing an asset that is not there', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/demo/assets/nope/probe' });
    expect(res.statusCode).toBe(404);
  });

  it('lists an empty job queue rather than failing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/demo/transcodes' });
    expect(res.statusCode).toBe(200);
    expect(res.json().jobs).toEqual([]);
  });

  it('404s canceling a job that does not exist', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/projects/demo/transcodes/job99' });
    expect(res.statusCode).toBe(404);
  });
});

describe('alpha detection', () => {
  it('recognizes the formats that carry transparency', () => {
    // ProRes 4444 arrives as yuva444p10le — the format this whole phase exists
    // to convert, and the one that must not be missed.
    for (const fmt of ['yuva444p10le', 'yuva420p', 'rgba', 'bgra', 'argb', 'ya8']) {
      expect(pixelFormatHasAlpha(fmt)).toBe(true);
    }
  });

  it('does not mistake opaque formats for transparent ones', () => {
    for (const fmt of ['yuv420p', 'yuv444p10le', 'rgb24', 'gray', null, undefined, '']) {
      expect(pixelFormatHasAlpha(fmt)).toBe(false);
    }
  });

  /*
   * WebM answers this question differently from every other container, and
   * getting it wrong means reporting "no alpha" about the exact files this
   * server produces.
   *
   * A VP9 alpha channel is not part of the primary video stream: it rides
   * alongside as a separate Matroska BlockAdditional layer, flagged by the
   * container's AlphaMode element. Verified against ffmpeg 8.0.1 — a
   * transcoded ProRes 4444 reports `pix_fmt=yuv420p` and `alpha_mode=1` on the
   * same stream, and decodes to yuva420p under the libvpx-vp9 decoder.
   */
  it('trusts the container AlphaMode flag over the pixel format', () => {
    expect(hasAlpha('yuv420p', '1')).toBe(true);
  });

  it('still reads the pixel format when there is no AlphaMode tag', () => {
    // Every non-WebM container: ProRes 4444 arrives as yuva444p10le or
    // yuva444p12le with no tag at all.
    expect(hasAlpha('yuva444p12le', undefined)).toBe(true);
    expect(hasAlpha('yuv420p', undefined)).toBe(false);
  });

  it('treats AlphaMode 0 and an absent tag the same', () => {
    expect(hasAlpha('yuv420p', '0')).toBe(false);
    expect(hasAlpha('yuv420p', '')).toBe(false);
    expect(hasAlpha('yuv420p', null)).toBe(false);
  });
});

describe('frame rate parsing', () => {
  it('reads ffprobe rationals, including drop-frame rates', () => {
    expect(parseFrameRate('25/1')).toBe(25);
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFrameRate('60/1')).toBe(60);
  });

  it('returns null for the values ffprobe emits when it does not know', () => {
    // `0/0` is what a stream with no usable rate reports; dividing it gives NaN,
    // which would propagate into a progress calculation as a silent wrong answer.
    for (const value of ['0/0', 'N/A', '', undefined]) {
      expect(parseFrameRate(value)).toBeNull();
    }
  });
});

describe('ffmpeg error reporting', () => {
  it('picks the line that says what went wrong', () => {
    const stderr = [
      'ffmpeg version 6.1',
      '  configuration: --enable-gpl --enable-libvpx',
      'Stream #0:0: Video: prores',
      'Unknown encoder "libvpx-vp9"',
    ].join('\n');
    expect(lastMeaningfulLine(stderr)).toBe('Unknown encoder "libvpx-vp9"');
  });

  it('has nothing to say about empty output', () => {
    expect(lastMeaningfulLine('')).toBeNull();
    expect(lastMeaningfulLine('\n  \n')).toBeNull();
  });
});
