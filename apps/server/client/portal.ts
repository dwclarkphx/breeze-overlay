// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Portal status strip.
 *
 * The only job on this page. Tiles open and every link works with this script
 * absent — `<details>` and anchors need nothing from us — so a failure here
 * degrades to "the numbers do not update", never to "the portal is broken".
 *
 * Polls rather than holding a socket. The hub's channels are per graphic, and a
 * server-wide feed would be a new kind of channel in a protocol that has
 * exactly one; polling also reconnects for free across a server restart, which
 * is the case this page most needs to survive — an operator watching the strip
 * to find out when the server comes back.
 */

export {};

/** Matches the shape of `StatusReport` in src/status.ts. */
interface Status {
  version: string;
  uptime: number;
  viewers: {
    renderers: number;
    controllers: number;
    channels: Array<{
      channel: string;
      projectId: string;
      compositionId: string;
      renderers: number;
      controllers: number;
    }>;
  };
  cpu: { percent: number; cores: number };
  memory: { rss: number; heapUsed: number; systemTotal: number };
}

const POLL_MS = 2000;

const el = (id: string) => document.getElementById(id);

function text(id: string, value: string): void {
  const node = el(id);
  if (node) node.textContent = value;
}

/** Bytes to a short human string. Graphics boxes have gigabytes; show one decimal. */
function bytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * Seconds to `3d 4h` / `2h 15m` / `45s`.
 *
 * Two units at most. "How long has this been up" is answered by an order of
 * magnitude, and a strip that reads `3d 4h 17m 09s` is harder to scan for it.
 */
function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Badge text for a scene or project.
 *
 * Browser sources are what matters — a scene with a source attached is on air,
 * or one keystroke from it. Panels are counted separately and mentioned only
 * when there is no source, so the common "1 source" case stays a short badge.
 */
function badge(renderers: number, controllers: number): string {
  if (renderers > 0) {
    const src = `${renderers} source${renderers === 1 ? '' : 's'}`;
    return controllers > 0 ? `${src} · ${controllers} panel${controllers === 1 ? '' : 's'}` : src;
  }
  if (controllers > 0) return `${controllers} panel${controllers === 1 ? '' : 's'}`;
  return '';
}

function setBadge(node: Element | null, label: string): void {
  if (!(node instanceof HTMLElement)) return;
  node.textContent = label;
  node.hidden = label === '';
}

function paint(status: Status): void {
  const strip = el('status');
  if (strip) strip.classList.remove('stale');

  const { renderers, controllers } = status.viewers;

  // The count stands alone — no caption. Green only when something is
  // genuinely connected: a permanently coloured readout stops carrying
  // information the second day you look at it.
  text('stat-renderers', String(renderers));
  el('stat-renderers')?.classList.toggle('live', renderers > 0);

  text('stat-controllers', String(controllers));

  text('stat-cpu', `${status.cpu.percent.toFixed(1)}%`);
  // The denominator matters: 140% is unremarkable on an 8-core box mid-encode
  // and alarming on a single-core VM, and the number alone cannot say which.
  text('stat-cpu-sub', `of one core · ${status.cpu.cores} cores`);

  text('stat-mem', bytes(status.memory.rss));
  text('stat-uptime', duration(status.uptime));

  /* Per-scene badges, and a project rollup on each closed tile. */
  const byChannel = new Map(status.viewers.channels.map((c) => [c.channel, c]));
  const perProject = new Map<string, { renderers: number; controllers: number }>();

  for (const scene of document.querySelectorAll<HTMLElement>('.scene[data-channel]')) {
    const channel = scene.dataset.channel ?? '';
    const entry = byChannel.get(channel);
    setBadge(
      scene.querySelector('[data-role="viewers"]'),
      entry ? badge(entry.renderers, entry.controllers) : '',
    );
  }

  for (const entry of status.viewers.channels) {
    const running = perProject.get(entry.projectId) ?? { renderers: 0, controllers: 0 };
    running.renderers += entry.renderers;
    running.controllers += entry.controllers;
    perProject.set(entry.projectId, running);
  }

  for (const tile of document.querySelectorAll<HTMLElement>('.tile[data-project]')) {
    const totals = perProject.get(tile.dataset.project ?? '');
    setBadge(
      tile.querySelector('[data-role="project-viewers"]'),
      totals ? badge(totals.renderers, totals.controllers) : '',
    );
  }
}

/**
 * One poll.
 *
 * A failure dims the strip rather than blanking it or showing an error. The
 * last numbers were true a moment ago, which is more use than a dash, and the
 * dimming is what says "these are no longer live" — the distinction an operator
 * needs when the thing that just went quiet is the server itself.
 */
async function poll(): Promise<void> {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    paint((await res.json()) as Status);
  } catch {
    el('status')?.classList.add('stale');
  }
}

void poll();
let timer = window.setInterval(() => void poll(), POLL_MS);

/*
 * Stop polling while the tab is hidden. The portal is a page people leave open
 * on a second monitor for a whole shift, and a request every two seconds for
 * eight hours against a server that is also feeding graphics to air is a cost
 * with no reader. Polls again immediately on return, so the numbers are current
 * by the time the tab has finished painting.
 */
document.addEventListener('visibilitychange', () => {
  window.clearInterval(timer);
  if (document.hidden) return;
  void poll();
  timer = window.setInterval(() => void poll(), POLL_MS);
});
