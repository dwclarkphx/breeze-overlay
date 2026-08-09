// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Global control verbs for an output page.
 *
 * `play()`, `stop()`, `next()` and `update(jsonString)` are written onto
 * `window` so a graphic can be driven from outside the page without a socket.
 * That matters for three callers: vMix Web Scripting, OBS's
 * `executeJavaScript`, and the Playwright suite, which drives output pages
 * through exactly these verbs rather than through the UI.
 *
 * The verb set is borrowed from CasparCG's template contract. It is a good
 * vocabulary and the one broadcast operators already know — Breeze does not
 * target CasparCG itself.
 *
 * `update()` takes a string as well as an object because every one of those
 * callers passes a string: a vMix script, an OBS `executeJavaScript` payload
 * and a console paste all arrive as text.
 */

import type { BreezeRuntime } from './runtime.js';

export interface BreezeGlobals {
  play: () => void;
  stop: () => void;
  next: () => void;
  update: (payload: string | Record<string, unknown>) => void;
  /** Non-standard but universally useful for debugging in a browser source. */
  seek: (time: number) => void;
  runtime: BreezeRuntime;
  /**
   * Independently triggered elements sharing this page, by channel.
   *
   * Empty on an ordinary single-graphic page.
   */
  elements: Map<string, BreezeGlobals>;
  /** Convenience for the console: `breeze.get('bug').play()`. */
  get: (channel: string) => BreezeGlobals | undefined;
}

/** Build the verb set for one runtime without touching any host object. */
export function makeGlobals(runtime: BreezeRuntime): BreezeGlobals {
  // Closed over rather than reached through `this`: these verbs get pulled off
  // the object and called bare from a console and from host scripting, and a
  // `this` that depends on the call site is a bug waiting for the worst moment.
  const elements = new Map<string, BreezeGlobals>();

  return {
    play: () => runtime.play(),
    stop: () => runtime.stop(),
    next: () => runtime.next(),
    update: (payload) => {
      const data = typeof payload === 'string' ? safeParse(payload) : payload;
      if (data) runtime.update(data);
    },
    seek: (time) => runtime.seek(time),
    runtime,
    elements,
    get: (channel) => elements.get(channel),
  };
}

/**
 * Attach the verb set to `window` (or any host object).
 *
 * `elements` carries the independently triggered graphics sharing the page.
 * The bare `window.play()` family is bound **only when there is exactly one
 * runtime** — with a scene on screen those verbs cannot say which graphic they
 * mean, and guessing is worse than not offering them. Single-graphic pages are
 * completely unaffected; a scene page reaches its graphics through
 * `window.breeze.get(channel)`.
 */
export function installGlobals(
  runtime: BreezeRuntime,
  host: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
  elements: ReadonlyMap<string, BreezeRuntime> = new Map(),
): BreezeGlobals {
  const globals = makeGlobals(runtime);

  for (const [channel, elementRuntime] of elements) {
    globals.elements.set(channel, makeGlobals(elementRuntime));
  }

  if (globals.elements.size === 0) {
    host['play'] = globals.play;
    host['stop'] = globals.stop;
    host['next'] = globals.next;
    host['update'] = globals.update;
    host['seek'] = globals.seek;
  }

  host['breeze'] = globals;

  return globals;
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    // Host scripting environments send double-encoded and half-built payloads
    // more often than you would like; a bad update must never take the graphic
    // off air.
    console.warn('[breeze] update() received unparseable payload', raw);
    return null;
  }
}
