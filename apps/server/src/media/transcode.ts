// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Transcode queue — ProRes 4444 (and anything else ffmpeg reads) → VP9/WebM
 * with alpha.
 *
 * The Phase 7 acceptance criterion was "an animated
 * alpha stinger plays inside a graphic in OBS with clean edges". A ProRes 4444
 * `.mov` is what a motion designer delivers and what no browser will play, so
 * this is the conversion that makes the format usable at all.
 *
 * In-process and in-memory, deliberately. A job queue that survived a restart
 * would need a store, a schema and a recovery path for jobs that were mid-encode
 * when the process died — and the thing it would be protecting is cheap to
 * repeat: the output is content-addressed, so re-requesting a lost transcode
 * either finds the finished file already there or starts again from a source
 * that has not moved. Persistence would buy nothing an operator would notice.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config, projectAssetsDir } from '../config.js';
import { assetPath, listAssets, registerAsset, readProject } from '../store.js';
import { capabilities, inspect } from './ffmpeg.js';
import type { AssetRef } from '@breeze/schema';

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TranscodeJob {
  id: string;
  projectId: string;
  /** Asset this job reads. */
  sourceAssetId: string;
  sourceName: string;
  state: JobState;
  /** 0..1, or null when the source duration could not be read. */
  progress: number | null;
  /** Set once the job succeeds. */
  outputAsset?: AssetRef;
  error?: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * Encoder settings.
 *
 * `yuva420p` is the whole point — it is what carries the alpha channel through
 * to the WebM, and without it the transcode succeeds and silently produces an
 * opaque video. `auto-alt-ref 0` is required alongside it: libvpx's alternate
 * reference frames are incompatible with alpha, and leaving them on produces a
 * file whose transparency breaks up in motion, which is far worse than losing it
 * outright because it survives a spot-check on the first frame.
 *
 * CRF 30 with `-b:v 0` is constant-quality VP9. A stinger is short and plays
 * over live pictures, so quality matters more than a predictable bitrate.
 * `row-mt 1` uses the cores that are there; concurrency is capped at the queue
 * instead, where the broadcast argument belongs.
 */
const ENCODER_ARGS = [
  '-c:v', 'libvpx-vp9',
  '-pix_fmt', 'yuva420p',
  '-auto-alt-ref', '0',
  '-b:v', '0',
  '-crf', '30',
  '-row-mt', '1',
  // No audio track. These are graphics: a browser source with sound is a
  // problem to be discovered on air, and every one of these gets composited
  // over a program feed that already has its own.
  '-an',
];

let nextId = 1;

export class TranscodeQueue {
  private jobs = new Map<string, TranscodeJob>();
  private waiting: string[] = [];
  private running = new Set<string>();
  private children = new Map<string, ChildProcess>();
  private stopped = false;

  /**
   * Enqueue a transcode, or hand back the job that is already doing it.
   *
   * Deduplicated on project + source asset. Double-clicking Transcode is the
   * obvious thing to do when a long encode shows no progress for a few seconds,
   * and two ffmpeg processes writing the same output path is a corrupt file
   * rather than a slow one.
   */
  async enqueue(projectId: string, sourceAssetId: string): Promise<TranscodeJob> {
    const existing = [...this.jobs.values()].find(
      (j) =>
        j.projectId === projectId &&
        j.sourceAssetId === sourceAssetId &&
        (j.state === 'queued' || j.state === 'running'),
    );
    if (existing) return existing;

    // Confirms the project exists, so a bad id is a 404 rather than an empty index.
    await readProject(projectId);
    const source = (await listAssets(projectId)).find((a) => a.id === sourceAssetId);
    if (!source) throw new Error(`asset ${sourceAssetId} not found in ${projectId}`);

    const job: TranscodeJob = {
      id: `job${nextId++}`,
      projectId,
      sourceAssetId,
      sourceName: source.originalName ?? source.path,
      state: 'queued',
      progress: null,
      queuedAt: new Date().toISOString(),
    };

    this.jobs.set(job.id, job);
    this.waiting.push(job.id);
    void this.pump();
    return job;
  }

  list(projectId?: string): TranscodeJob[] {
    const all = [...this.jobs.values()];
    return projectId ? all.filter((j) => j.projectId === projectId) : all;
  }

  get(jobId: string): TranscodeJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Stop a job.
   *
   * A queued job is dropped; a running one has its ffmpeg killed. The partial
   * output is removed by the runner's cleanup, so a canceled encode never
   * leaves a truncated WebM behind that would play as a graphic ending
   * mid-motion.
   */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    if (job.state === 'queued') {
      this.waiting = this.waiting.filter((id) => id !== jobId);
      job.state = 'cancelled';
      job.finishedAt = new Date().toISOString();
      return true;
    }
    if (job.state === 'running') {
      job.state = 'cancelled';
      this.children.get(jobId)?.kill('SIGKILL');
      return true;
    }
    return false;
  }

  /** Kill everything in flight. Called from the server's `onClose` hook. */
  stop(): void {
    this.stopped = true;
    this.waiting = [];
    for (const child of this.children.values()) child.kill('SIGKILL');
  }

  private async pump(): Promise<void> {
    if (this.stopped) return;
    while (this.running.size < config.transcodeConcurrency && this.waiting.length > 0) {
      const id = this.waiting.shift()!;
      const job = this.jobs.get(id);
      if (!job || job.state !== 'queued') continue;

      this.running.add(id);
      // Not awaited: the loop's job is to fill the slots, and `runJob` releases
      // its own slot and re-pumps when it finishes.
      void this.runJob(job).finally(() => {
        this.running.delete(id);
        this.children.delete(id);
        void this.pump();
      });
    }
  }

  private async runJob(job: TranscodeJob): Promise<void> {
    const caps = await capabilities();
    if (!caps.available || !caps.vp9Alpha) {
      this.fail(job, caps.reason ?? 'ffmpeg is unavailable');
      return;
    }

    let input: string;
    let output: string;
    let outputName: string;
    try {
      const source = (await listAssets(job.projectId)).find((a) => a.id === job.sourceAssetId);
      if (!source) throw new Error('source asset has been deleted');

      input = await assetPath(job.projectId, source.path.replace(/^assets\//, ''));
      /*
       * The output name carries the *source* hash, not its own.
       *
       * That is what makes this a cache: the same source transcoded again lands
       * on the same path, so the check below finds it and skips minutes of CPU.
       * Hashing the output instead would mean encoding the file to discover
       * what to call it, which is the entire cost this avoids.
       */
      outputName = `${path.basename(source.path, path.extname(source.path))}-alpha.webm`;
      output = await assetPath(job.projectId, outputName);
    } catch (err) {
      this.fail(job, err instanceof Error ? err.message : String(err));
      return;
    }

    job.state = 'running';
    job.startedAt = new Date().toISOString();

    // Already transcoded — same source bytes, same output. Register and return.
    try {
      await fs.access(output);
      await this.finish(job, outputName, output);
      return;
    } catch {
      /* Not there yet, which is the normal path. */
    }

    /*
     * A source with no alpha is transcoded anyway, not refused.
     *
     * Refusing would be second-guessing the operator: an opaque `.mov` that no
     * browser can decode is still worth converting, and "this has no
     * transparency" is not the same as "this does not need transcoding". The
     * editor reports `hasAlpha` before the job is queued, which is where that
     * decision belongs.
     */
    const info = await inspect(input);
    const total = info?.durationSeconds ?? null;
    job.progress = total === null ? null : 0;

    /*
     * A temporary output, renamed on success.
     *
     * ffmpeg writes its output progressively, so the final path must not exist
     * until the encode is complete — otherwise the `fs.access` cache check
     * above would find a half-written file from a crashed run and hand a
     * truncated stinger to air.
     */
    const tmp = `${output}.${process.pid}.part`;
    await fs.mkdir(projectAssetsDir(job.projectId), { recursive: true });

    const args = [
      '-hide_banner',
      '-nostdin',
      // Overwrite the temp file: a previous crashed run may have left one, and
      // ffmpeg would otherwise sit waiting for a confirmation nobody can type.
      '-y',
      '-i', input,
      ...ENCODER_ARGS,
      // Machine-readable progress on stdout. Parsing the human stderr output
      // is the usual approach and it changes between ffmpeg releases; this is
      // a stable key=value stream that exists for exactly this purpose.
      '-progress', 'pipe:1',
      '-nostats',
      '-f', 'webm',
      tmp,
    ];

    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(caps.ffmpeg, args, { shell: false });
      this.children.set(job.id, child);

      let stderr = '';
      let buffer = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        // Keep the trailing partial line for the next chunk.
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const microseconds = /^out_time_us=(\d+)/.exec(line.trim());
          if (microseconds && total) {
            const seconds = Number(microseconds[1]) / 1_000_000;
            // Clamped: ffmpeg can report a time slightly past the container
            // duration on the final frames, and a bar that reads 101% looks
            // like a bug in the thing the operator is waiting on.
            job.progress = Math.max(0, Math.min(1, seconds / total));
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        // Bounded: a failing encode can produce megabytes of warnings, and this
        // is held for the lifetime of the job purely to explain a failure.
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });

      child.on('error', () => {
        job.error = 'ffmpeg could not be started';
        resolve(null);
      });
      child.on('close', (exitCode) => {
        if (exitCode !== 0 && !job.error) {
          job.error = lastMeaningfulLine(stderr) ?? `ffmpeg exited with code ${exitCode}`;
        }
        resolve(exitCode);
      });
    });

    if (wasCancelled(job)) {
      await fs.rm(tmp, { force: true });
      job.finishedAt = new Date().toISOString();
      return;
    }

    if (code !== 0) {
      await fs.rm(tmp, { force: true });
      this.fail(job, job.error ?? 'transcode failed');
      return;
    }

    await fs.rename(tmp, output);
    await this.finish(job, outputName, output);
  }

  private async finish(job: TranscodeJob, outputName: string, output: string): Promise<void> {
    const stat = await fs.stat(output);

    /*
     * Probed before it is registered, so the bin knows the output's duration and
     * alpha the moment the row appears.
     *
     * This is the one place the answer really matters: the whole point of the
     * transcode is transparency, and `hasAlpha` here is read from the
     * container's `alpha_mode` tag rather than the pixel format — ffprobe
     * reports this file's primary stream as `yuv420p` even when it is fully
     * transparent. A cheap probe of a file we just
     * finished writing turns "did that work?" into a fact on the row.
     */
    const info = await inspect(output);

    const asset: AssetRef = {
      // Derived from the source, so re-running the job updates this entry in
      // place rather than adding a second row to the bin for the same file.
      id: `${job.sourceAssetId}-webm`,
      path: `assets/${outputName}`,
      kind: 'video',
      originalName: outputName,
      bytes: stat.size,
      addedAt: new Date().toISOString(),
      ...(info
        ? {
            ...(info.width !== null ? { width: info.width } : {}),
            ...(info.height !== null ? { height: info.height } : {}),
            ...(info.durationSeconds !== null ? { duration: info.durationSeconds } : {}),
            ...(info.codec !== null ? { codec: info.codec } : {}),
            hasAlpha: info.hasAlpha,
          }
        : {}),
    };

    await registerAsset(job.projectId, asset);
    job.outputAsset = asset;
    job.progress = 1;
    job.state = 'done';
    job.finishedAt = new Date().toISOString();
  }

  private fail(job: TranscodeJob, error: string): void {
    job.state = 'failed';
    job.error = error;
    job.finishedAt = new Date().toISOString();
  }
}

/**
 * Did someone cancel this job while ffmpeg was running?
 *
 * A function rather than an inline `job.state === 'canceled'`, because the
 * compiler has narrowed `state` to `'running'` since this method set it and
 * cannot see that `cancel()` mutates the same object from another turn of the
 * event loop — the comparison reads as provably false and is rejected. Passing
 * the job through a parameter drops the narrowing, which is honest: the state
 * genuinely can have changed under an `await`.
 */
function wasCancelled(job: TranscodeJob): boolean {
  return job.state === 'cancelled';
}

/**
 * The last line of ffmpeg's stderr that says something.
 *
 * ffmpeg's failure message is nearly always the final non-empty line; what
 * precedes it is build configuration and stream metadata. Showing the operator
 * the whole dump means they read none of it.
 */
export function lastMeaningfulLine(stderr: string): string | null {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('configuration:'));
  return lines.length ? lines[lines.length - 1]! : null;
}
