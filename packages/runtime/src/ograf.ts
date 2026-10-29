// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The OGraf Graphic actions, answered by a runtime (Phase 9 Wave D, D2).
 *
 * A pointer package's `graphic.mjs` carries no runtime: it frames the output
 * page from the Breeze server and forwards each OGraf action into it (the
 * bridge is in `client/player.ts`). This is what the page does with them —
 * the step rule, when each promise settles, and what a custom action means —
 * kept beside the runtime so it is tested against a real one.
 *
 * An OGraf instance is its own graphic, not a Breeze channel. Its fields, its
 * transport and its timers belong to the controller driving it; what is
 * project-wide on the server — data sources, the project mode — the page
 * follows from the hub (`?hub=data`).
 */

import {
  DEFAULT_SCROLL_ID,
  SCROLLS_UPDATE_KEY,
  SCROLL_ACTIONS,
  SCROLL_ID_PATTERN,
  applyScrollAction,
  type ScrollAction,
  type ScrollState,
  TIMERS_UPDATE_KEY,
  TIMER_ACTIONS,
  TIMER_ID_PATTERN,
  DEFAULT_TIMER_ID,
  applyTimerAction,
  ografCurrentStep,
  ografStepCount,
  ografTargetStep,
  type TimerAction,
  type TimerState,
} from '@breeze/schema';

import type { BreezeRuntime, RuntimeEvent } from './runtime.js';

/** What an OGraf action resolves to (Graphics specification, "ReturnPayload"). */
export interface OgrafReturn {
  statusCode: number;
  statusMessage?: string;
  currentStep?: number;
  result?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

export class OgrafAdapter {
  /** This instance's own operator timers — see the module comment. */
  private timers: Record<string, TimerState> = {};
  /** A scroll verb has pinned this instance's rolls (Wave R); a fresh run must unpin them. */
  private scrollsPinned = false;

  constructor(private readonly runtime: BreezeRuntime) {}

  /** OGraf's stepCount: the STOP markers. */
  get stepCount(): number {
    return ografStepCount(this.runtime.composition);
  }

  /** 0-based hold the graphic is on or heading to; undefined at start or end. */
  get currentStep(): number | undefined {
    return ografCurrentStep({ state: this.runtime.playbackState, step: this.runtime.currentStep }, this.stepCount);
  }

  /**
   * Resolves once the graphic has got where it was sent — the intro reached
   * its hold, the outro finished — which is what OGraf means by "ready for the
   * next action". Capped, so a hidden tab whose animation clock has stopped
   * cannot hang a controller: past the cap it resolves anyway and the reply
   * says where the graphic actually is.
   */
  private settle(done: () => boolean): Promise<void> {
    if (done()) return Promise.resolve();
    const capMs = Math.max(5_000, this.runtime.duration * 1000 + 2_000);
    return new Promise((resolve) => {
      const offs: Array<() => void> = [];
      const finish = (): void => {
        for (const off of offs) off();
        clearTimeout(timer);
        resolve();
      };
      const check = (): void => {
        if (done()) finish();
      };
      for (const event of ['hold', 'stop', 'finished', 'play'] as RuntimeEvent[]) offs.push(this.runtime.on(event, check));
      const timer = setTimeout(finish, capMs);
    });
  }

  async playAction(params: { goto?: unknown; delta?: unknown; skipAnimation?: unknown } = {}): Promise<OgrafReturn> {
    const skip = params.skipAnimation === true;
    const stepCount = this.stepCount;

    /*
     * The zero-step model: in, and out by itself. Resolved at once, as the
     * specification asks of a graphic whose animation runs on — the controller
     * is free for its next action while this one plays out.
     */
    this.freshRunScrolls();
    if (stepCount === 0) {
      if (skip) this.runtime.clear();
      else this.runtime.play();
      return { statusCode: 200 };
    }

    const target = ografTargetStep({ current: this.currentStep, stepCount, goto: params.goto, delta: params.delta });
    if (target === undefined) {
      const stopped = await this.stopAction({ skipAnimation: skip });
      return { ...stopped };
    }
    if (!this.runtime.goToStep(target + 1, { cut: skip })) {
      return { statusCode: 400, statusMessage: `no step ${target}` };
    }
    if (!skip) await this.settle(() => this.runtime.playbackState !== 'playing-in');
    return { statusCode: 200, currentStep: this.currentStep ?? target };
  }

  /**
   * A run starting from off air takes its rolls back to the top (Wave R). Once
   * a scroll verb has given this instance a payload the runtime stops timing
   * rolls from its own PLAY, so the reset is sent here, as the hub sends it
   * for a channel.
   */
  private freshRunScrolls(): void {
    if (!this.scrollsPinned) return;
    const state = this.runtime.playbackState;
    if (state !== 'idle' && state !== 'finished' && state !== 'playing-out') return;
    const now = Date.now();
    this.runtime.update({ [SCROLLS_UPDATE_KEY]: { clock: now, scrolls: {}, playAt: now } });
  }

  async stopAction(params: { skipAnimation?: unknown } = {}): Promise<OgrafReturn> {
    if (params.skipAnimation === true) {
      this.runtime.clear();
      return { statusCode: 200 };
    }
    this.runtime.stop();
    await this.settle(() => this.runtime.playbackState !== 'playing-out');
    return { statusCode: 200 };
  }

  async updateAction(params: { data?: unknown } = {}): Promise<OgrafReturn> {
    if (!isRecord(params.data)) return { statusCode: 400, statusMessage: 'data must be an object' };
    this.runtime.update(params.data);
    return { statusCode: 200 };
  }

  async customAction(params: { id?: unknown; payload?: unknown } = {}): Promise<OgrafReturn> {
    const payload = isRecord(params.payload) ? params.payload : {};
    const table = str(payload['table']);
    switch (params.id) {
      case 'next':
        this.runtime.next(table);
        return { statusCode: 200 };
      case 'prev':
        this.runtime.prev(table);
        return { statusCode: 200 };
      case 'page': {
        const key = str(payload['key']);
        const n = payload['page'];
        if (key !== undefined) return { statusCode: 200, result: this.runtime.goToPage({ key }, table) };
        if (typeof n === 'number' && Number.isInteger(n) && n >= 1) {
          return { statusCode: 200, result: this.runtime.goToPage({ n }, table) };
        }
        return { statusCode: 400, statusMessage: 'give page (a whole number, 1 or more) or key' };
      }
      case 'cycle': {
        const state = payload['state'];
        if (state !== 'hold' && state !== 'resume') return { statusCode: 400, statusMessage: 'state must be hold or resume' };
        return { statusCode: 200, result: this.runtime.setCycle(state, table) };
      }
      case 'timer':
        return this.timer(payload);
      case 'scroll':
        return this.scroll(payload);
      default:
        return { statusCode: 404, statusMessage: `no custom action "${String(params.id)}"` };
    }
  }

  /**
   * A roll transport verb (Wave R), kept on this instance like its timers. The
   * instance runs its rolls from its own PLAY until told otherwise, so the
   * first verb pins every roll's current state before changing the one named —
   * an untouched credits roll must not stop because its neighbour was paused.
   */
  private scroll(payload: Record<string, unknown>): OgrafReturn {
    const action = payload['action'];
    if (typeof action !== 'string' || !(SCROLL_ACTIONS as readonly string[]).includes(action)) {
      return { statusCode: 400, statusMessage: `action must be one of ${SCROLL_ACTIONS.join(', ')}` };
    }
    const id = str(payload['id']) ?? DEFAULT_SCROLL_ID;
    if (!SCROLL_ID_PATTERN.test(id)) return { statusCode: 400, statusMessage: `bad scroll id "${id}"` };
    const raw = payload['value'];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
    const now = Date.now();
    const scrolls: Record<string, ScrollState> = {};
    for (const sid of this.runtime.scrollIds) scrolls[sid] = this.runtime.scrollState(sid);
    const info = this.runtime.scrollStates.find((r) => r.id === id);
    scrolls[id] = applyScrollAction(
      scrolls[id],
      action as ScrollAction,
      now,
      { ...(value !== undefined ? { value } : {}), ...(payload['percent'] === true ? { percent: true } : {}) },
      info,
    );
    this.scrollsPinned = true;
    this.runtime.update({ [SCROLLS_UPDATE_KEY]: { clock: now, scrolls } });
    return { statusCode: 200, result: scrolls[id] };
  }

  /** An operator timer verb, kept on this instance and shown through the runtime's timers. */
  private timer(payload: Record<string, unknown>): OgrafReturn {
    const action = payload['action'];
    if (typeof action !== 'string' || !(TIMER_ACTIONS as readonly string[]).includes(action)) {
      return { statusCode: 400, statusMessage: `action must be one of ${TIMER_ACTIONS.join(', ')}` };
    }
    const id = str(payload['id']) ?? DEFAULT_TIMER_ID;
    if (!TIMER_ID_PATTERN.test(id)) return { statusCode: 400, statusMessage: `bad timer id "${id}"` };
    const raw = payload['value'];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
    if ((action === 'set' || action === 'add') && value === undefined) {
      return { statusCode: 400, statusMessage: `${action} needs a value in milliseconds` };
    }
    const now = Date.now();
    this.timers = { ...this.timers, [id]: applyTimerAction(this.timers[id], action as TimerAction, now, value) };
    this.runtime.update({ [TIMERS_UPDATE_KEY]: { clock: now, timers: this.timers } });
    return { statusCode: 200, result: this.timers[id] };
  }
}
