// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * ffmpeg discovery and probing.
 *
 * **Nothing is bundled.** The server looks for `ffmpeg` and `ffprobe` on `PATH`
 * at boot and disables transcoding cleanly when they are absent. Shipping a
 * static build would be redistributing ffmpeg, and the common static builds are
 * GPL — a license question this project does not need to answer, since it
 * never redistributes ffmpeg. Detection also means an operator who
 * already has a tuned ffmpeg (hardware encoders, a specific libvpx) keeps it.
 *
 * Framed the same way as the FTP adapter in Phase 6 Wave 3: an optional
 * capability that announces its own absence, rather than a hard dependency that
 * makes the whole server refuse to start on a box that will never transcode
 * anything.
 */

import { spawn } from 'node:child_process';

import { config } from '../config.js';

export interface FfmpegCapabilities {
  available: boolean;
  /** Resolved command for each binary — a bare name found on PATH, or an override. */
  ffmpeg: string;
  ffprobe: string;
  /** First line of `ffmpeg -version`, for the diagnostics panel. */
  version: string | null;
  /**
   * Whether this build can encode VP9 with an alpha channel.
   *
   * The distinction that matters, and it is not the same as "ffmpeg exists". A
   * build without `libvpx-vp9` transcodes a ProRes 4444 stinger perfectly
   * happily and silently discards its transparency, which is exactly the defect
   * the operator is transcoding to avoid — and it only shows up on air, over a
   * black box where the graphic should have been.
   */
  vp9Alpha: boolean;
  /** Why transcoding is unavailable, in words an operator can act on. */
  reason: string | null;
}

/**
 * Longest any probe may take.
 *
 * Short: these run at boot and block nothing else useful, and a hang here would
 * be a server that never finishes starting. `ffmpeg -version` on a working
 * install answers in milliseconds; anything near this is a broken binary, a
 * stale symlink or a network filesystem, all of which mean "unavailable".
 */
const PROBE_TIMEOUT_MS = 5000;

/** Run a command and collect stdout. Never throws — absence is an answer. */
export function run(
  command: string,
  args: string[],
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      /*
       * `shell: false` is the default and is load-bearing, so it is stated.
       * Arguments here eventually include filesystem paths derived from
       * uploaded assets; through a shell, a filename would be a command
       * injection. The argument array is the boundary that makes that
       * impossible rather than merely unlikely.
       */
      child = spawn(command, args, { shell: false });
    } catch {
      // ENOENT for a command that is not installed at all.
      resolve({ ok: false, stdout: '', stderr: '' });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

let cached: FfmpegCapabilities | null = null;

/**
 * What this machine can do, probed once and remembered.
 *
 * Cached because it is asked on every page load of the editor and cannot change
 * without a restart — installing ffmpeg under a running server is not a case
 * worth re-probing for on every request. `resetCapabilities` exists for tests.
 */
export async function capabilities(): Promise<FfmpegCapabilities> {
  if (cached) return cached;

  const ffmpeg = config.ffmpegPath;
  const ffprobe = config.ffprobePath;

  const version = await run(ffmpeg, ['-version']);
  if (!version.ok) {
    cached = {
      available: false,
      ffmpeg,
      ffprobe,
      version: null,
      vp9Alpha: false,
      reason:
        `ffmpeg was not found (looked for "${ffmpeg}"). Install it and restart, ` +
        'or set BREEZE_FFMPEG_PATH. Video transcoding is unavailable until then; ' +
        'MP4 and WebM files already in a usable format still play.',
    };
    return cached;
  }

  const probe = await run(ffprobe, ['-version']);
  if (!probe.ok) {
    cached = {
      available: false,
      ffmpeg,
      ffprobe,
      version: version.stdout.split('\n')[0] ?? null,
      vp9Alpha: false,
      // Separated from the ffmpeg case on purpose: these ship together, so one
      // without the other is a partial install or a wrong override, and saying
      // which half is missing is the difference between a two-minute fix and an
      // afternoon.
      reason:
        `ffmpeg was found but ffprobe was not (looked for "${ffprobe}"). ` +
        'They normally install together — check the install, or set BREEZE_FFPROBE_PATH.',
    };
    return cached;
  }

  const encoders = await run(ffmpeg, ['-hide_banner', '-encoders']);
  const vp9Alpha = /\blibvpx-vp9\b/.test(encoders.stdout);

  cached = {
    available: true,
    ffmpeg,
    ffprobe,
    version: version.stdout.split('\n')[0] ?? null,
    vp9Alpha,
    reason: vp9Alpha
      ? null
      : 'This ffmpeg build has no libvpx-vp9 encoder, so it cannot produce WebM ' +
        'with an alpha channel. Transcoding is disabled rather than silently ' +
        'flattening transparency — a stinger would go to air over a black box.',
  };
  return cached;
}

/** Test seam. Nothing in the running server calls this. */
export function resetCapabilities(): void {
  cached = null;
}

export interface MediaInfo {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  pixelFormat: string | null;
  /** True when the source carries transparency worth preserving. */
  hasAlpha: boolean;
  frameRate: number | null;
}

/**
 * Pixel formats that carry an alpha channel.
 *
 * Matched on the `a` in the family name rather than by listing every format,
 * because the list is long and grows: `yuva420p`, `yuva444p10le`, `rgba`,
 * `bgra`, `argb`, `ya8`. ProRes 4444 arrives as `yuva444p10le`.
 */
export function pixelFormatHasAlpha(pixelFormat: string | null | undefined): boolean {
  if (!pixelFormat) return false;
  return /^(yuva|ya|rgba|bgra|argb|abgr|gbra)/.test(pixelFormat);
}

/**
 * Inspect a media file.
 *
 * Duration is what the progress bar is a fraction *of*, so a transcode of a
 * file this cannot read reports indeterminate progress rather than a wrong
 * percentage — an operator watching a bar stuck at 340% has learned nothing.
 */
export async function inspect(file: string): Promise<MediaInfo | null> {
  const caps = await capabilities();
  if (!caps.available) return null;

  const result = await run(caps.ffprobe, [
    '-v', 'error',
    '-select_streams', 'v:0',
    // `stream_tags` is what carries `alpha_mode` — see `hasAlpha` below.
    '-show_entries',
    'stream=codec_name,width,height,pix_fmt,r_frame_rate:stream_tags=alpha_mode:format=duration',
    '-of', 'json',
    file,
  ]);
  if (!result.ok) return null;

  try {
    const parsed = JSON.parse(result.stdout) as {
      streams?: Array<{
        codec_name?: string;
        width?: number;
        height?: number;
        pix_fmt?: string;
        r_frame_rate?: string;
        tags?: { alpha_mode?: string };
      }>;
      format?: { duration?: string };
    };

    const stream = parsed.streams?.[0];
    const duration = Number(parsed.format?.duration);

    return {
      durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
      width: stream?.width ?? null,
      height: stream?.height ?? null,
      codec: stream?.codec_name ?? null,
      pixelFormat: stream?.pix_fmt ?? null,
      hasAlpha: hasAlpha(stream?.pix_fmt, stream?.tags?.alpha_mode),
      frameRate: parseFrameRate(stream?.r_frame_rate),
    };
  } catch {
    return null;
  }
}

/**
 * Does this stream carry transparency?
 *
 * Two signals, because WebM answers differently from every other container.
 *
 * A VP9 alpha channel is **not** part of the primary video stream: it rides
 * alongside it as a separate Matroska `BlockAdditional` layer, flagged by the
 * container-level `AlphaMode` element. So ffprobe reports our own transcode
 * output as `yuv420p` — the primary stream genuinely is — while the file is
 * fully transparent and decodes to `yuva420p` under the `libvpx-vp9` decoder.
 *
 * Reading only the pixel format therefore says "no alpha" about the exact files
 * this server produces, which is the most confusing possible place to be wrong:
 * verified against ffmpeg 8.0.1, where a transcoded ProRes 4444 reports
 * `pix_fmt=yuv420p` and `alpha_mode=1` on the same stream.
 */
export function hasAlpha(
  pixelFormat: string | null | undefined,
  alphaMode?: string | null,
): boolean {
  // Matroska AlphaMode: 1 means an alpha layer is present.
  if (alphaMode !== undefined && alphaMode !== null && alphaMode !== '' && alphaMode !== '0') {
    return true;
  }
  return pixelFormatHasAlpha(pixelFormat);
}

/** ffprobe reports frame rate as a rational string — `30000/1001`. */
export function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const parts = value.split('/');
  if (parts.length !== 2) return null;

  const num = Number(parts[0]);
  const den = Number(parts[1]);
  // `0/0` is what ffprobe reports for a stream with no usable rate. Dividing it
  // gives NaN, which would travel into a progress calculation as a silently
  // wrong answer rather than an obviously absent one.
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;

  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}
