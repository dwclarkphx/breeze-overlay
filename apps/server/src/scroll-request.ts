// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Reading a scroll command off a request (Phase 9 Wave R, ROLLS.md §5.3) —
 * shared by the graphic's `/api/control/:id/:compId/scroll` and the output's
 * `/api/out/:id/:output/scroll`, so both say the same thing about a bad one.
 *
 * `action=` one of `SCROLL_ACTIONS`, `id=` (default `main`) and `value=`:
 * for `speed` a multiple (`1.5`, `x2`); for `jog` signed seconds (`-3`,
 * `+0:05`); for `seek` seconds or a percentage (`1:30`, `90`, `50%`).
 */

import {
  DEFAULT_SCROLL_ID,
  SCROLL_ACTIONS,
  SCROLL_ID_PATTERN,
  parseScrollSeek,
  parseTimerInput,
  type ScrollAction,
} from '@breeze/schema';

export type ScrollRequest =
  | { ok: true; action: ScrollAction; id: string; value?: number; percent?: boolean }
  | { ok: false; code: string; params?: Record<string, string> };

export function readScrollRequest(params: Record<string, unknown>): ScrollRequest {
  const action = typeof params['action'] === 'string' ? params['action'].trim() : '';
  if (!(SCROLL_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, code: 'error.scrollAction', params: { actions: SCROLL_ACTIONS.join(', ') } };
  }
  const rawId = typeof params['id'] === 'string' && params['id'].trim() !== '' ? params['id'].trim() : DEFAULT_SCROLL_ID;
  if (!SCROLL_ID_PATTERN.test(rawId)) return { ok: false, code: 'error.scrollId' };
  const raw = params['value'];
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  const act = action as ScrollAction;

  if (act === 'speed') {
    const n = Number(text.replace(/^[x×]/i, ''));
    if (text === '' || !Number.isFinite(n) || n <= 0) return { ok: false, code: 'error.scrollValue' };
    return { ok: true, action: act, id: rawId, value: n };
  }
  if (act === 'jog') {
    const sign = text.startsWith('-') ? -1 : 1;
    const ms = parseTimerInput(text.replace(/^[+-]/, ''));
    if (ms === null) return { ok: false, code: 'error.scrollValue' };
    return { ok: true, action: act, id: rawId, value: (sign * ms) / 1000 };
  }
  if (act === 'seek') {
    const parsed = parseScrollSeek(text);
    if (!parsed || parsed.value === undefined) return { ok: false, code: 'error.scrollValue' };
    return { ok: true, action: act, id: rawId, value: parsed.value, ...(parsed.percent ? { percent: true } : {}) };
  }
  return { ok: true, action: act, id: rawId };
}
