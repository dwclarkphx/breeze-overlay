// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Undo/redo.
 *
 * Two representations are kept deliberately:
 *  - a log of serializable `Command`s, which is what ROADMAP §4 asks for and
 *    what a future scripting or collaboration layer will consume
 *  - the document snapshot from *before* each command, which is what undo
 *    actually restores
 *
 * Inverting commands analytically would be the clever option and the wrong one:
 * every new command kind would need a matching inverse, and a single missing or
 * subtly wrong inverse corrupts a document silently. Compositions are a few KB
 * and unchanged branches are shared by reference, so snapshots cost almost
 * nothing and cannot drift out of sync with the reducer.
 */

import type { Composition } from '@breeze/schema';

import { applyCommand, coalesceKey, describeCommand, type Command } from './commands.js';

export interface HistoryEntry {
  command: Command;
  label: string;
  /** Document as it was *before* `command` ran. */
  before: Composition;
  /** Coalescing key, or null when this entry must stand alone. */
  key: string | null;
  /** ms timestamp, used to stop unrelated edits merging after a pause. */
  at: number;
}

export interface HistoryState {
  past: HistoryEntry[];
  future: HistoryEntry[];
}

export const emptyHistory: HistoryState = { past: [], future: [] };

/** Beyond this gap, two same-key commands are separate user intentions. */
export const COALESCE_WINDOW_MS = 600;

/** Cap on retained snapshots; a long session should not grow without bound. */
export const HISTORY_LIMIT = 200;

export interface PushResult {
  composition: Composition;
  history: HistoryState;
}

export function pushCommand(
  composition: Composition,
  history: HistoryState,
  command: Command,
  now = Date.now(),
): PushResult {
  const next = applyCommand(composition, command);

  // A command that changes nothing must not consume an undo slot — otherwise
  // clicking a field and tabbing away eats the user's real undo step.
  if (next === composition) return { composition, history };

  const key = coalesceKey(command);
  const last = history.past[history.past.length - 1];

  if (key !== null && last && last.key === key && now - last.at <= COALESCE_WINDOW_MS) {
    // Merge: keep the ORIGINAL `before` so one undo reverts the whole gesture.
    const merged: HistoryEntry = { ...last, command, label: describeCommand(command), at: now };
    return {
      composition: next,
      history: { past: [...history.past.slice(0, -1), merged], future: [] },
    };
  }

  const entry: HistoryEntry = {
    command,
    label: describeCommand(command),
    before: composition,
    key,
    at: now,
  };

  const past = [...history.past, entry];
  return {
    composition: next,
    // Any new edit discards the redo branch, as in every other editor.
    history: { past: past.slice(-HISTORY_LIMIT), future: [] },
  };
}

export function undo(composition: Composition, history: HistoryState): PushResult {
  const entry = history.past[history.past.length - 1];
  if (!entry) return { composition, history };

  return {
    composition: entry.before,
    history: {
      past: history.past.slice(0, -1),
      // Stash the current document so redo can restore it without re-running
      // the command — which matters because commands are not always
      // idempotent against a changed document.
      future: [{ ...entry, before: composition }, ...history.future],
    },
  };
}

export function redo(composition: Composition, history: HistoryState): PushResult {
  const entry = history.future[0];
  if (!entry) return { composition, history };

  return {
    composition: entry.before,
    history: {
      past: [...history.past, { ...entry, before: composition }],
      future: history.future.slice(1),
    },
  };
}

export function canUndo(history: HistoryState): boolean {
  return history.past.length > 0;
}

export function canRedo(history: HistoryState): boolean {
  return history.future.length > 0;
}

export function undoLabel(history: HistoryState): string | null {
  return history.past[history.past.length - 1]?.label ?? null;
}

export function redoLabel(history: HistoryState): string | null {
  return history.future[0]?.label ?? null;
}

/** The serializable command log, oldest first — for scripting and debugging. */
export function commandLog(history: HistoryState): Command[] {
  return history.past.map((e) => e.command);
}
