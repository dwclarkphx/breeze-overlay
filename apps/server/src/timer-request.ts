// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Reading a timer command off a request (Phase 9 Wave B) — shared by the
 * graphic's `/api/control/:id/:compId/timer` and the output's
 * `/api/out/:id/:output/timer`, so both say the same thing about a bad one.
 *
 * `action=start|pause|toggle|reset|set|add`, `id=` (default `main`) and
 * `value=` — for `set` a time (`8:00`, `480`, `1:02:03`, `12.5`), for `add` a
 * signed one (`-10`, `+0:30`). Seconds, as an operator types them; the hub
 * takes milliseconds.
 */

import {
  DEFAULT_TIMER_ID,
  TIMER_ACTIONS,
  TIMER_ID_PATTERN,
  parseTimerInput,
  type TimerAction,
} from '@breeze/schema';

export type TimerRequest =
  | { ok: true; action: TimerAction; id: string; value?: number }
  | { ok: false; code: string; params?: Record<string, string> };

export function readTimerRequest(params: Record<string, unknown>): TimerRequest {
  const action = typeof params['action'] === 'string' ? params['action'].trim() : '';
  if (!(TIMER_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, code: 'error.timerAction', params: { actions: TIMER_ACTIONS.join(', ') } };
  }
  const rawId = typeof params['id'] === 'string' && params['id'].trim() !== '' ? params['id'].trim() : DEFAULT_TIMER_ID;
  if (!TIMER_ID_PATTERN.test(rawId)) return { ok: false, code: 'error.timerId' };

  const raw = params['value'];
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (action === 'set' || action === 'add') {
    const sign = action === 'add' && text.startsWith('-') ? -1 : 1;
    const ms = parseTimerInput(action === 'add' ? text.replace(/^[+-]/, '') : text);
    if (ms === null) return { ok: false, code: 'error.timerValue' };
    return { ok: true, action: action as TimerAction, id: rawId, value: sign * ms };
  }
  return { ok: true, action: action as TimerAction, id: rawId };
}
