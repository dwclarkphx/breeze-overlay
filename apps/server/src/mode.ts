// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * A project's mode (CYCLE.md, Wave 6) — the one value every graphic's layer
 * rules can read: `first-alert`, `election-night`, '' for none.
 *
 * Per project, not per channel: a station going into severe-weather coverage
 * goes in everywhere at once, and every graphic that has a rule for it
 * follows. Kept on disk (`projects/<id>/mode.json`) because a restart in the
 * middle of a warning must not quietly drop the channel back to normal. Not
 * part of a backup: it is the state of the air, not of the project.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { MODE_PATTERN, modesIn, walkLayers, type Layer, type Project } from '@breeze/schema';

import { projectDir } from './config.js';

/** Longest mode name accepted. A mode is a word on a button, not a sentence. */
export const MODE_MAX_LENGTH = 48;

const cache = new Map<string, string>();

const file = (projectId: string) => path.join(projectDir(projectId), 'mode.json');

export async function readMode(projectId: string): Promise<string> {
  const cached = cache.get(projectId);
  if (cached !== undefined) return cached;
  let mode = '';
  try {
    const parsed = JSON.parse(await fs.readFile(file(projectId), 'utf8')) as { mode?: unknown };
    if (typeof parsed.mode === 'string') mode = parsed.mode;
  } catch {
    // No file is no mode — every project before this wave.
  }
  cache.set(projectId, mode);
  return mode;
}

export async function writeMode(projectId: string, mode: string): Promise<void> {
  const target = file(projectId);
  // A name of its own per write: two presses at once must not share a temp file.
  const tmp = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ mode }), 'utf8');
  await fs.rename(tmp, target);
  cache.set(projectId, mode);
}

const chains = new Map<string, Promise<unknown>>();

/**
 * Run mode changes for one project one at a time, in the order they arrived —
 * a panel and Companion pressed together must leave the disk, the cache and
 * the graphics agreeing on the last one.
 */
export function serially<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(projectId) ?? Promise.resolve()).then(fn, fn);
  chains.set(projectId, run.catch(() => undefined));
  return run;
}

/** Forget a cached mode — the project was deleted or restored. */
export function forgetMode(projectId: string): void {
  cache.delete(projectId);
}

/**
 * Clean a requested mode, or say why it cannot be one. Trimmed; '' clears.
 * Letters, digits, spaces and `-_.` only — it lands on buttons and in the
 * activity log, and a control character in either is a bug waiting.
 */
export function cleanMode(raw: unknown): string | { error: string } {
  const value = typeof raw === 'string' ? raw.trim() : raw === undefined || raw === null ? '' : String(raw).trim();
  if (value.length > MODE_MAX_LENGTH) return { error: `a mode is at most ${MODE_MAX_LENGTH} characters` };
  if (value && !MODE_PATTERN.test(value)) return { error: 'a mode may use letters, digits, spaces, dot, dash and underscore' };
  return value;
}

/** The spelling the project's rules use for a mode, if they name it — `first-alert` for `First-Alert`. */
export function canonicalMode(value: string, known: readonly string[]): string {
  return known.find((m) => m.toLowerCase() === value.toLowerCase()) ?? value;
}

/** Every mode any rule in the project names — the buttons a panel offers. */
export function projectModes(project: Project): string[] {
  const modes = new Map<string, string>();
  const visit = (layer: Layer): void => {
    for (const m of modesIn(layer.rules)) if (!modes.has(m.toLowerCase())) modes.set(m.toLowerCase(), m);
    if (layer.type === 'table') for (const cell of layer.row.cells) visit(cell);
  };
  for (const comp of project.compositions) walkLayers(comp.layers, visit);
  return [...modes.values()].sort((a, b) => a.localeCompare(b));
}
