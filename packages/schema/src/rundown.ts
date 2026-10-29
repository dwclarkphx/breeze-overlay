// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Rundowns and outputs (Phase 9 Wave A, PHASE9.md §3).
 *
 * **A rundown is a project document, not panel state.** It lives in
 * `projects/<id>/rundowns.json` beside `assets.json`, so two panels on two
 * laptops see the same list and a browser refreshed mid-service loses nothing.
 * Each item names a composition, the field values to send it, an optional
 * label and an optional **output**.
 *
 * **An output is a channel with no composition of its own.** `/out/<project>/<output>`
 * subscribes to `${projectId}/@<output>` and mounts whichever compositions the
 * rundown takes onto it — one vMix input carrying the lower thirds, the slate
 * and the bug. `@` is not a legal id character (`LEGACY_KEY_PATTERN`), so an
 * output name can never collide with a composition id, and the channel key
 * keeps the `${projectId}/${name}` shape SCENES.md fixed.
 *
 * Each composition mounted on an output gets a channel of its own,
 * `${projectId}/@<output>~<compositionId>`, so late join, playback reports and
 * retained field data work for it exactly as they do for a scene element.
 * `~` is outside the id alphabet too, so the split is unambiguous.
 *
 * Free of I/O and of Ajv: the control panel and the editor import it from the
 * barrel.
 */

import { FORMAT_VERSION } from './types.js';

/** Output names: lowercase, digits and inner hyphens, up to 24 characters. */
export const OUTPUT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;

/** The output a new item goes to when the operator picks "an output" without naming one. */
export const DEFAULT_OUTPUT = 'main';

/** Upper bounds, so a hand-edited file cannot make the panel lay out a million rows. */
export const MAX_RUNDOWNS = 50;
export const MAX_RUNDOWN_ITEMS = 500;
export const MAX_RUNDOWN_LABEL = 120;

/** Item and rundown ids: what the panel and Companion address them by. */
export const RUNDOWN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface RundownItem {
  id: string;
  /** Composition id in the same project. */
  composition: string;
  /** What the operator reads in the list. Absent shows the first field value. */
  label?: string;
  /**
   * The `update` payload TAKE sends — field values by binding name, including
   * `<mount>.<binding>` override addresses (0.72.0).
   */
  data?: Record<string, unknown>;
  /**
   * Output to take it onto. Absent takes it on the composition's own channel —
   * the `/play` URL that graphic already has.
   */
  output?: string;
  /**
   * Stacking on an output: higher is in front. Absent is 0; equal layers stack
   * in the order they were first taken. Ignored without `output`.
   */
  layer?: number;
}

export interface Rundown {
  id: string;
  name: string;
  items: RundownItem[];
}

export interface RundownsFile {
  formatVersion: typeof FORMAT_VERSION;
  rundowns: Rundown[];
}

export function emptyRundowns(): RundownsFile {
  return { formatVersion: FORMAT_VERSION, rundowns: [] };
}

/* ------------------------------------------------------------- channels */

/** `${projectId}/@<output>` — the output page's routing channel. */
export function outputChannel(projectId: string, output: string): string {
  return `${projectId}/@${output}`;
}

/** `${projectId}/@<output>~<compositionId>` — one composition mounted on an output. */
export function outputMountChannel(projectId: string, output: string, compositionId: string): string {
  return `${projectId}/@${output}~${compositionId}`;
}

/** `${projectId}/#rundowns` — where panels hear about cue and take. Never a renderer's. */
export function rundownChannel(projectId: string): string {
  return `${projectId}/#rundowns`;
}

/**
 * What a channel key addresses, by its second segment.
 *
 * `graphic` is a composition or scene element; `output` an output's routing
 * channel; `mount` a composition on an output; `rundown` the panels' channel.
 */
export type ChannelKind = 'graphic' | 'output' | 'mount' | 'rundown';

export function channelKind(channel: string): ChannelKind {
  const at = channel.indexOf('/');
  const name = at === -1 ? channel : channel.slice(at + 1);
  if (name.startsWith('#')) return 'rundown';
  if (name.startsWith('@')) return name.includes('~') ? 'mount' : 'output';
  return 'graphic';
}

/**
 * Whether data-source and mode pushes should reach this channel. An output's
 * routing channel and the rundown channel render nothing, and a weather
 * project's DataSets sent to them on every poll would be traffic for nobody.
 */
export function channelTakesData(channel: string): boolean {
  const kind = channelKind(channel);
  return kind === 'graphic' || kind === 'mount';
}

/** The target an item is taken onto: `@<output>` or the composition id. */
export function itemTarget(item: Pick<RundownItem, 'composition' | 'output'>): string {
  return item.output ? `@${item.output}` : item.composition;
}

/* ------------------------------------------------------------ navigation */

/**
 * The item `delta` places from `from` (−1 previous, +1 next). With no `from`,
 * the first item for +1 and the last for −1. Stops at the ends rather than
 * wrapping: an operator pressing NEXT past the last name of a service must not
 * find the first one armed again.
 */
export function adjacentItem(rundown: Rundown, from: string | null | undefined, delta: 1 | -1): RundownItem | null {
  const items = rundown.items;
  if (items.length === 0) return null;
  const at = from ? items.findIndex((i) => i.id === from) : -1;
  if (at === -1) return delta === 1 ? items[0]! : items[items.length - 1]!;
  const next = at + delta;
  return next >= 0 && next < items.length ? items[next]! : null;
}

/** The text a list row shows: the label, else the first non-empty string field, else the composition. */
export function itemTitle(item: RundownItem, compositionName?: string): string {
  if (item.label?.trim()) return item.label.trim();
  for (const value of Object.values(item.data ?? {})) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return compositionName || item.composition;
}

/** A fresh id that `RUNDOWN_ID_PATTERN` accepts and `taken` does not contain. */
export function newRundownId(prefix: string, taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.has(id)) return id;
  }
}

/* ------------------------------------------------------------ validation */

export interface RundownIssue {
  path: string;
  message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Check a rundowns document. `compositionIds`, when given, also checks every
 * item names a composition that exists — the server passes it on save; a
 * restore checks shape only, since the project arrives with it.
 *
 * Hand-written rather than Ajv so the panel can call it from the barrel.
 */
export function validateRundowns(doc: unknown, compositionIds?: ReadonlySet<string>): RundownIssue[] {
  const issues: RundownIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });

  if (!isRecord(doc)) return [{ path: '', message: 'must be an object' }];
  if (doc['formatVersion'] !== FORMAT_VERSION) push('/formatVersion', `must be ${FORMAT_VERSION}`);
  const rundowns = doc['rundowns'];
  if (!Array.isArray(rundowns)) return [...issues, { path: '/rundowns', message: 'must be an array' }];
  if (rundowns.length > MAX_RUNDOWNS) push('/rundowns', `at most ${MAX_RUNDOWNS} rundowns`);

  const rundownIds = new Set<string>();
  rundowns.forEach((r: unknown, ri) => {
    const base = `/rundowns/${ri}`;
    if (!isRecord(r)) return push(base, 'must be an object');
    const id = r['id'];
    if (typeof id !== 'string' || !RUNDOWN_ID_PATTERN.test(id)) push(`${base}/id`, 'must be an id (letters, digits, - and _)');
    else if (rundownIds.has(id)) push(`${base}/id`, `duplicate rundown id "${id}"`);
    else rundownIds.add(id);
    if (typeof r['name'] !== 'string' || r['name'].length > MAX_RUNDOWN_LABEL) {
      push(`${base}/name`, `must be a string of at most ${MAX_RUNDOWN_LABEL} characters`);
    }
    const items = r['items'];
    if (!Array.isArray(items)) return push(`${base}/items`, 'must be an array');
    if (items.length > MAX_RUNDOWN_ITEMS) push(`${base}/items`, `at most ${MAX_RUNDOWN_ITEMS} items`);
    const itemIds = new Set<string>();
    items.forEach((item: unknown, ii) => {
      const at = `${base}/items/${ii}`;
      if (!isRecord(item)) return push(at, 'must be an object');
      const iid = item['id'];
      if (typeof iid !== 'string' || !RUNDOWN_ID_PATTERN.test(iid)) push(`${at}/id`, 'must be an id (letters, digits, - and _)');
      else if (itemIds.has(iid)) push(`${at}/id`, `duplicate item id "${iid}"`);
      else itemIds.add(iid);
      const comp = item['composition'];
      if (typeof comp !== 'string' || comp === '') push(`${at}/composition`, 'must name a composition');
      else if (compositionIds && !compositionIds.has(comp)) push(`${at}/composition`, `no composition "${comp}" in this project`);
      if (item['label'] !== undefined && (typeof item['label'] !== 'string' || item['label'].length > MAX_RUNDOWN_LABEL)) {
        push(`${at}/label`, `must be a string of at most ${MAX_RUNDOWN_LABEL} characters`);
      }
      if (item['data'] !== undefined && !isRecord(item['data'])) push(`${at}/data`, 'must be an object of field values');
      const output = item['output'];
      if (output !== undefined && (typeof output !== 'string' || !OUTPUT_NAME_PATTERN.test(output))) {
        push(`${at}/output`, 'must be an output name: lowercase letters, digits and inner hyphens, up to 24');
      }
      const layer = item['layer'];
      if (layer !== undefined && (typeof layer !== 'number' || !Number.isInteger(layer) || Math.abs(layer) > 1000)) {
        push(`${at}/layer`, 'must be a whole number between -1000 and 1000');
      }
      for (const key of Object.keys(item)) {
        if (!['id', 'composition', 'label', 'data', 'output', 'layer'].includes(key)) push(`${at}/${key}`, 'unknown property');
      }
    });
  });
  return issues;
}

/* ----------------------------------------------------------- live state */

/**
 * What the panels are told about one rundown: the armed item, and the item
 * last taken onto each target (`itemTarget`). Kept by the server; broadcast on
 * the rundown channel so a refreshed panel comes back on the same armed item.
 */
export interface RundownLive {
  armed: string | null;
  onAir: Record<string, string>;
}

/** One composition mounted on an output, as the output page is told about it. */
export interface OutputMount {
  composition: string;
  /** The rundown item that put it there, for the panel. */
  item?: string;
  layer: number;
  /** Hub clock, epoch ms, when it was first mounted — the tiebreak for equal layers. */
  since: number;
}

/** Reserved update key on an output's routing channel: `OutputMount[]`, in stacking order. */
export const MOUNTS_UPDATE_KEY = '$mounts';
/** Reserved update key on the rundown channel: `Record<rundownId, RundownLive>`. */
export const RUNDOWN_UPDATE_KEY = '$rundown';
/** Reserved update key on the rundown channel: bumped when `rundowns.json` is saved. */
export const RUNDOWNS_REVISION_KEY = '$rundownsRev';

/** Mounts in stacking order: layer, then first mounted. */
export function orderMounts(mounts: readonly OutputMount[]): OutputMount[] {
  return [...mounts].sort((a, b) => a.layer - b.layer || a.since - b.since);
}
