// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root — dist/ and src/ are both one level under apps/server. */
export const APP_ROOT = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');

export interface Config {
  host: string;
  port: number;
  /** Where projects and uploaded assets live. */
  dataDir: string;
  /** Bundled browser assets (player.js) produced by scripts/build-client.mjs. */
  publicDir: string;
  /** Vite build output for the React editor. */
  editorDir: string;
  /** Optional shared secret for the REST control API. Empty = no auth (LAN use). */
  apiKey: string;
  logLevel: string;
  /**
   * Hosts the data fetcher may reach even though they resolve to private
   * addresses. A leading dot matches subdomains. Empty by default: this server
   * runs on the same LAN as the switcher, so "fetch any URL" is a request
   * forgery primitive until an operator says otherwise.
   */
  dataAllowHosts: string[];
  /**
   * Credentials for data sources, keyed by id. Source definitions carry only
   * the id, because they get exported and shared; the value never leaves the
   * server. Populated from `BREEZE_DATA_SECRETS` (`id=value` pairs) and
   * `BREEZE_DATA_SECRETS_FILE` (a JSON object, for values with newlines in).
   */
  dataSecrets: Record<string, string>;
  /**
   * Who this server is, for the outgoing `User-Agent` — `mystation.com,
   * ops@mystation.com`.
   *
   * Several origins ask for it and one of them enforces it: api.weather.gov
   * documents that a request must identify itself and that a *more unique*
   * string is less likely to be caught by a security event. That cuts both
   * ways, and it is the reason this exists. Breeze's built-in fallback is
   * shared by every install in the world, so one careless deployment hammering
   * NWS can get the string throttled for everyone using the default. A station
   * that fills this in is no longer downstream of anybody else's behavior, and
   * is contactable before it gets blocked rather than after.
   *
   * Server-wide because it is a property of the *deployment*, not of a source;
   * a weather source may override it for the rare shared-server case.
   */
  contact: string;
  /** Master switch for polling. Off in tests, so no suite touches the network. */
  dataPolling: boolean;
  /**
   * How to invoke ffmpeg and ffprobe.
   *
   * Bare names by default, resolved through `PATH`. Nothing is bundled — see
   * `media/ffmpeg.ts` for why — so these exist for the install that has ffmpeg
   * somewhere unusual: a portable build on a Windows graphics box, or a
   * hardware-accelerated one an engineer put outside `PATH` deliberately.
   */
  ffmpegPath: string;
  ffprobePath: string;
  /**
   * How many transcodes may run at once.
   *
   * One, and that is a broadcast decision rather than a scheduling one. This
   * process is also serving live graphics to a switcher; a video encode will
   * take every core it is given, and a dropped frame on air costs more than a
   * stinger finishing two minutes later. Raise it only on a box that is not
   * also on air.
   */
  transcodeConcurrency: number;
}

function envList(name: string): string[] {
  return env(name, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `BREEZE_DATA_SECRETS=sheets=abc123,league=xyz`.
 *
 * Environment rather than a file so a Docker deployment can inject them without
 * a bind mount, and so they never land in the project directory that gets
 * copied between machines.
 */
function envSecrets(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of envList(name)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

/**
 * `BREEZE_DATA_SECRETS_FILE=/etc/breeze/secrets.json` — a JSON object of
 * `id → value`, merged over anything the environment variable set.
 *
 * Added in Wave 2 because a Google service-account key is a multi-line JSON
 * document with commas and equals signs in it, and the comma-separated
 * `id=value` env format cannot represent one. A value may be a string or, for
 * exactly that case, a nested object — which is re-serialised here so every
 * consumer downstream still sees a plain string.
 *
 * Read synchronously at import: a server that cannot load its credentials
 * should fail at boot, not on the first poll of the show.
 */
function fileSecrets(name: string): Record<string, string> {
  const file = env(name, '');
  if (!file) return {};

  let raw: string;
  try {
    raw = readFileSync(path.resolve(file), 'utf8');
  } catch (err) {
    throw new Error(
      `${name} points at ${file}, which could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} (${file}) is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} (${file}) must contain a JSON object of id → credential`);
  }

  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    out[id] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return out;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const config: Config = {
  // 0.0.0.0 so vMix/OBS on another machine on the LAN can reach the output page.
  host: env('BREEZE_HOST', '0.0.0.0'),
  port: Number(env('BREEZE_PORT', '7331')),
  dataDir: path.resolve(env('BREEZE_DATA_DIR', path.join(REPO_ROOT, 'data'))),
  publicDir: path.join(APP_ROOT, 'public'),
  editorDir: path.resolve(env('BREEZE_EDITOR_DIR', path.join(REPO_ROOT, 'apps', 'editor', 'dist'))),
  apiKey: env('BREEZE_API_KEY', ''),
  logLevel: env('BREEZE_LOG_LEVEL', 'info'),
  dataAllowHosts: envList('BREEZE_DATA_ALLOW_HOSTS'),
  // File last: it is the one that can hold a service-account key, so it should
  // win over an env entry of the same id rather than lose to one.
  dataSecrets: { ...envSecrets('BREEZE_DATA_SECRETS'), ...fileSecrets('BREEZE_DATA_SECRETS_FILE') },
  contact: env('BREEZE_CONTACT', ''),
  dataPolling: env('BREEZE_DATA_POLLING', '1') !== '0',
  ffmpegPath: env('BREEZE_FFMPEG_PATH', 'ffmpeg'),
  ffprobePath: env('BREEZE_FFPROBE_PATH', 'ffprobe'),
  // Clamped rather than trusted: a 0 or a typo would mean a queue that never
  // drains, which looks exactly like a hung transcode.
  transcodeConcurrency: Math.max(1, Number(env('BREEZE_TRANSCODE_CONCURRENCY', '1')) || 1),
};

export const projectsDir = () => path.join(config.dataDir, 'projects');
export const projectDir = (id: string) => path.join(projectsDir(), id);
export const projectFile = (id: string) => path.join(projectDir(id), 'project.json');
export const projectAssetsDir = (id: string) => path.join(projectDir(id), 'assets');
export const projectDataSourcesFile = (id: string) =>
  path.join(projectDir(id), 'datasources.json');
/** The asset index. Split out of project.json in Phase 7.5 — see ASSETS.md §6. */
export const projectAssetsFile = (id: string) => path.join(projectDir(id), 'assets.json');
