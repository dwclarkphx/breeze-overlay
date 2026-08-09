// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Activity log — a record of who did what.
 *
 * Breeze has no accounts. The only shared secret is an optional server-wide API
 * key, so an actor can be identified by where the request came from and what it
 * came from, and nothing stronger. That is a real limit and the log states it
 * plainly rather than implying a person: `192.168.1.40 · Chrome on Windows`.
 * On a gallery LAN with assigned machines that usually names someone; over a
 * VPN or behind a reverse proxy it may not, and the log should not pretend.
 *
 * What is recorded is deliberately narrow — the destructive, irreversible
 * things (projects and scenes created and deleted) plus control panels
 * connecting. Browser sources are excluded on purpose: a flapping OBS source
 * reconnecting every few seconds would bury the four lines a month that anyone
 * actually needs to find, and the status strip already answers "is it up now?".
 *
 * JSON Lines, one file per month. Append-only, greppable with the tools already
 * on the box, and a corrupt tail costs one line rather than the file.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';

export type AuditAction =
  | 'project.create'
  | 'project.delete'
  | 'scene.create'
  | 'scene.delete'
  | 'panel.connect'
  | 'panel.disconnect';

export interface AuditActor {
  /** Remote address, as the server saw it. */
  ip: string;
  /** Raw User-Agent. Long, but the only other distinguishing thing we have. */
  agent: string;
}

export interface AuditEntry {
  at: string;
  action: AuditAction;
  actor: AuditActor;
  /** Project this concerns, when there is one. */
  project?: string;
  /** Scene or channel this concerns, when there is one. */
  scene?: string;
  /** Human-readable name at the time — the id alone is unreadable after a delete. */
  name?: string;
  /** Anything else worth keeping, kept small. */
  detail?: Record<string, string | number | boolean>;
}

/** `data/audit-2026-08.jsonl`. */
export function auditFile(when = new Date()): string {
  const month = `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, '0')}`;
  return path.join(config.dataDir, `audit-${month}.jsonl`);
}

/**
 * Writes are serialized through one promise chain.
 *
 * Two concurrent appends to the same file can interleave and produce a line
 * that is two half-entries, which is unparseable and — worse — silently
 * discarded by the reader. Chaining costs nothing at this volume.
 *
 * The chain deliberately swallows failures rather than propagating them: a full
 * disk must not turn a successful project delete into a 500, and the log is a
 * record of the work rather than part of it.
 */
let queue: Promise<void> = Promise.resolve();

export function record(entry: Omit<AuditEntry, 'at'> & { at?: string }): Promise<void> {
  const line = JSON.stringify({ at: entry.at ?? new Date().toISOString(), ...entry }) + '\n';
  queue = queue.then(async () => {
    try {
      await fs.mkdir(config.dataDir, { recursive: true });
      await fs.appendFile(auditFile(), line, 'utf8');
    } catch {
      // Deliberately silent — see above.
    }
  });
  return queue;
}

/** Test seam: wait for every queued write to land. */
export async function flush(): Promise<void> {
  await queue;
}

/**
 * Identify the actor behind a request.
 *
 * `req.ip` respects Fastify's `trustProxy` setting, which is off by default —
 * so behind a reverse proxy this is the proxy's address, and that is the honest
 * answer for a server that has not been told to trust the header.
 */
export function actorOf(req: {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}): AuditActor {
  const agent = req.headers['user-agent'];
  return {
    ip: req.ip ?? 'unknown',
    agent: (Array.isArray(agent) ? agent[0] : agent) ?? 'unknown',
  };
}

/**
 * Most recent entries first.
 *
 * Reads the current month, and the one before it when that does not fill the
 * limit — enough for the page to stay useful on the first of the month, without
 * walking a year of files to render a table.
 */
export async function recent(limit = 200): Promise<AuditEntry[]> {
  const now = new Date();
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  const entries: AuditEntry[] = [];
  for (const file of [auditFile(now), auditFile(previous)]) {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }

    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // One torn line — from a process killed mid-append — must not cost the
        // whole page.
      }
    }

    if (entries.length >= limit) break;
  }

  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return entries.slice(0, limit);
}

/**
 * "Chrome on Windows" from a User-Agent.
 *
 * A best-effort squint, not detection: the full string is kept in the entry and
 * shown on hover. The point is a column that can be scanned down, which a
 * 140-character UA cannot be.
 */
export function describeAgent(agent: string): string {
  if (agent === 'unknown' || agent.trim() === '') return 'unknown';

  // Breeze's own outgoing fetches, and anything else honest about itself.
  if (agent.startsWith('BreezeOverlay/')) return agent.split(' ')[0] ?? agent;

  const browser =
    /\bOBS\b/i.test(agent) ? 'OBS'
    : /vMix/i.test(agent) ? 'vMix'
    : /\bEdg\//.test(agent) ? 'Edge'
    : /\bOPR\//.test(agent) ? 'Opera'
    : /\bFirefox\//.test(agent) ? 'Firefox'
    // Chrome must be tested after the others: they all claim to be Chrome too.
    : /\bChrome\//.test(agent) ? 'Chrome'
    : /\bSafari\//.test(agent) ? 'Safari'
    : /curl\//i.test(agent) ? 'curl'
    : null;

  const os =
    /Windows/i.test(agent) ? 'Windows'
    : /Android/i.test(agent) ? 'Android'
    : /(iPhone|iPad|iOS)/i.test(agent) ? 'iOS'
    : /Mac OS X|Macintosh/i.test(agent) ? 'macOS'
    : /Linux/i.test(agent) ? 'Linux'
    : null;

  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  return agent.length > 40 ? `${agent.slice(0, 37)}…` : agent;
}
