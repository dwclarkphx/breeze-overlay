// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Who is talking to this server — the peers page and the console dashboard.
 *
 * Two very different kinds of peer, and the difference is the whole design:
 *
 *   Sockets — browser sources, control panels, editors. They stay connected, so
 *   the hub can say exactly who is on right now. See `ControlHub.peers()`.
 *
 *   API callers — Companion, a Stream Deck URL, curl, a script. REST is
 *   stateless: they send a request and are gone. There is no "connected" to
 *   report, so this reports *recently active* instead, over a fixed window, and
 *   says so wherever it is shown. Presenting a poller as a connection would be
 *   fine right up until it stopped polling and stayed on the list.
 *
 * Our own pages are left out of the API list. The editor, portal and control
 * panel call `/api/*` constantly, and each is already listed as a socket (or,
 * for the portal, is the page doing the looking). What separates them is that a
 * browser page sends a same-origin `Referer` / `Origin`; Companion and curl send
 * neither. That is a heuristic, not a security boundary — anything can forge a
 * header — and nothing here is used to decide anything but what to display.
 */

import type { ControlHub, PeerSnapshot } from './hub.js';

/** How long an API caller stays listed after its last request. */
export const API_WINDOW_MS = 60_000;

/**
 * Upper bound on remembered callers. A port scanner or a misconfigured loop
 * with a changing User-Agent must not grow this without limit; the oldest is
 * evicted first, which is the one least likely to still matter.
 */
const MAX_TRACKED = 200;

export interface ApiPeer {
  ip: string;
  agent: string;
  /** Requests seen since this caller was first listed. */
  requests: number;
  /** `POST /api/control/demo/lower-third/play` — never with its query string. */
  last: string;
  lastStatus: number;
  firstSeen: number;
  lastSeen: number;
}

export interface PeersReport {
  sockets: PeerSnapshot[];
  api: ApiPeer[];
  /** The API list's window, so a reader is told what "recent" means. */
  apiWindowSeconds: number;
  /** Server clock, epoch ms — durations are computed against this, not the viewer's. */
  now: number;
}

interface RequestLike {
  ip?: string;
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

function header(req: RequestLike, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The path without its query.
 *
 * Not cosmetic: the API key may travel as `?key=` for header-less devices, and
 * this string is shown on a page that needs no key to read.
 */
export function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** Host part of an absolute URL, or null if it is not one. */
function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * Is this an `/api/*` call from something other than one of our own pages?
 *
 * `Sec-Fetch-Site: same-origin` is the direct answer and every current browser
 * sends it. `Referer` / `Origin` matching `Host` covers the rest.
 */
export function isExternalApiCall(req: RequestLike): boolean {
  if (!stripQuery(req.url).startsWith('/api/')) return false;
  if (header(req, 'sec-fetch-site') === 'same-origin') return false;
  const host = header(req, 'host');
  if (host) {
    if (hostOf(header(req, 'origin')) === host) return false;
    if (hostOf(header(req, 'referer')) === host) return false;
  }
  return true;
}

export class ApiClients {
  private entries = new Map<string, ApiPeer>();

  constructor(
    private readonly windowMs = API_WINDOW_MS,
    /** Injected so tests can move time without waiting for it. */
    private readonly clock: () => number = Date.now,
  ) {}

  note(req: RequestLike, status: number): void {
    const now = this.clock();
    const ip = req.ip ?? 'unknown';
    const agent = header(req, 'user-agent') ?? 'unknown';
    // Keyed on both: two Companion instances behind one NAT are two callers,
    // and one machine running Companion and curl is two as well.
    const key = `${ip}\u0000${agent}`;
    const last = `${req.method} ${stripQuery(req.url)}`;

    const existing = this.entries.get(key);
    if (existing) {
      existing.requests += 1;
      existing.last = last;
      existing.lastStatus = status;
      existing.lastSeen = now;
      // Re-inserted so Map order stays least-recently-seen first for eviction.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return;
    }

    this.entries.set(key, {
      ip,
      agent,
      requests: 1,
      last,
      lastStatus: status,
      firstSeen: now,
      lastSeen: now,
    });
    while (this.entries.size > MAX_TRACKED) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Callers seen inside the window, most recent first. Prunes as it goes. */
  list(): ApiPeer[] {
    const cutoff = this.clock() - this.windowMs;
    for (const [key, entry] of this.entries) {
      if (entry.lastSeen < cutoff) this.entries.delete(key);
    }
    return [...this.entries.values()]
      .map((e) => ({ ...e }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  get windowSeconds(): number {
    return Math.round(this.windowMs / 1000);
  }
}

export function peersReport(hub: ControlHub, api: ApiClients, now = Date.now()): PeersReport {
  return {
    sockets: hub.peers(),
    api: api.list(),
    apiWindowSeconds: api.windowSeconds,
    now,
  };
}

/** `h:mm:ss`, or `m:ss` under an hour. Numerals only, so nothing to translate. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
