// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Server status — what the portal's header strip reports.
 *
 * Two questions, and only two, because they are the two that have honest
 * answers here:
 *
 *   "Is anything actually watching?" — the hub knows exactly. A renderer is a
 *   browser source in vMix or OBS; a controller is an operator panel or the
 *   editor. Counted from live socket subscriptions, not inferred from request
 *   logs, so a browser source that was closed an hour ago is not still counted.
 *
 *   "Is this server struggling?" — `process.cpuUsage()`, which is *this
 *   process*, not the machine. Deliberately not `os.loadavg()`: it returns
 *   `[0,0,0]` on Windows, which is where a lot of graphics boxes live, and a
 *   status strip that always reads zero is worse than no status strip. Machine-
 *   wide CPU would also mostly report whatever else is on the box, which is not
 *   the number anyone opens this page to find.
 */

import os from 'node:os';

import type { ControlHub } from './hub.js';

export interface ChannelViewers {
  channel: string;
  projectId: string;
  compositionId: string;
  /** Browser sources — vMix / OBS inputs and preview tabs. */
  renderers: number;
  /** Operator panels and editor windows. */
  controllers: number;
}

export interface StatusReport {
  version: string;
  /** Whole seconds since the process started. */
  uptime: number;
  viewers: {
    renderers: number;
    controllers: number;
    /** Only channels with someone on them — an empty list honestly means nothing is up. */
    channels: ChannelViewers[];
  };
  cpu: {
    /**
     * Percent of one core, averaged over the interval since the last sample.
     * May exceed 100 on a multi-core box: this is CPU *time*, and ffmpeg
     * transcodes are the reason it can.
     */
    percent: number;
    cores: number;
  };
  memory: {
    /** Resident set size, bytes. */
    rss: number;
    heapUsed: number;
    /** Machine total, for the denominator the number is meaningless without. */
    systemTotal: number;
  };
}

/**
 * CPU percentage needs two samples, so the sampler carries the previous one.
 *
 * One instance per app rather than a module-level pair of numbers: a test suite
 * that builds several apps would otherwise have them all differencing against
 * each other's clock and reporting nonsense.
 */
export class StatusSampler {
  private lastCpu = process.cpuUsage();
  private lastAt = process.hrtime.bigint();

  /**
   * CPU used since the previous call, as a percentage of one core.
   *
   * The first call after construction covers the interval since the process
   * started, which is usually a large number reflecting boot — the portal polls
   * every couple of seconds, so it corrects itself immediately and there is
   * nothing to special-case.
   */
  private cpuPercent(): number {
    const now = process.hrtime.bigint();
    const usage = process.cpuUsage(this.lastCpu);
    const elapsedMicros = Number(now - this.lastAt) / 1000;

    this.lastCpu = process.cpuUsage();
    this.lastAt = now;

    if (elapsedMicros <= 0) return 0;
    const busyMicros = usage.user + usage.system;
    return Math.round((busyMicros / elapsedMicros) * 1000) / 10;
  }

  report(hub: ControlHub, version: string): StatusReport {
    let renderers = 0;
    let controllers = 0;
    const channels: ChannelViewers[] = [];

    for (const channel of hub.activeChannels) {
      const state = hub.state(channel);
      renderers += state.renderers;
      controllers += state.controllers;
      if (state.renderers === 0 && state.controllers === 0) continue;

      // Channel keys are `projectId/compositionId`, and a composition id may
      // not contain a slash — see `channelKey`. Split on the first only, so a
      // future key shape does not silently mangle the project id.
      const slash = channel.indexOf('/');
      channels.push({
        channel,
        projectId: slash === -1 ? channel : channel.slice(0, slash),
        compositionId: slash === -1 ? '' : channel.slice(slash + 1),
        renderers: state.renderers,
        controllers: state.controllers,
      });
    }

    const mem = process.memoryUsage();
    return {
      version,
      uptime: Math.floor(process.uptime()),
      viewers: { renderers, controllers, channels },
      cpu: { percent: this.cpuPercent(), cores: os.cpus().length },
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, systemTotal: os.totalmem() },
    };
  }
}
