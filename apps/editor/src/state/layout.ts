// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Editor panel sizes — pure functions, no React.
 *
 * Clamping and persistence have exact answers, so they live here rather than
 * inside the component where they would only be reachable through a rendered
 * DOM and a real `localStorage`.
 */

export interface LayoutSizes {
  /** Layers panel width, px. */
  left: number;
  /** Properties panel width, px. */
  right: number;
  /** Timeline height, px. */
  timeline: number;
}

export type PanelKey = keyof LayoutSizes;

/** The sizes the editor shipped with, and what a double-click restores. */
export const DEFAULT_LAYOUT: LayoutSizes = { left: 260, right: 300, timeline: 280 };

/**
 * Hard limits per panel.
 *
 * The minimums are the point below which a panel stops being usable rather than
 * merely small: the layer rows need room for a name and three toggles, the
 * properties fields for a label and a number, and the timeline for the ruler,
 * the marker lane and at least one track.
 */
export const LAYOUT_LIMITS: Record<PanelKey, { min: number; max: number }> = {
  left: { min: 180, max: 480 },
  right: { min: 220, max: 520 },
  timeline: { min: 120, max: 600 },
};

/**
 * Largest share of the window any one panel may take.
 *
 * The fixed maximums above are not enough on their own: two 480px panels on a
 * 1024px laptop leave the stage nothing at all. This is what stops a resize
 * squeezing out the thing being edited.
 */
const MAX_SHARE = 0.45;

/**
 * Clamp one panel to its limits, and to the space actually available.
 *
 * `available` is the window dimension the panel is measured along — width for
 * the side panels, height for the timeline. When it is unknown (server render,
 * or a test that does not care) the share cap is simply not applied.
 *
 * The minimum always wins over the share cap. A window too narrow to grant a
 * panel its minimum is a window the editor cannot lay out anyway, and silently
 * returning something below the minimum would produce a panel that renders but
 * cannot be used.
 */
export function clampPanel(key: PanelKey, value: number, available = Infinity): number {
  const { min, max } = LAYOUT_LIMITS[key];
  if (!Number.isFinite(value)) return DEFAULT_LAYOUT[key];

  const share = Number.isFinite(available) && available > 0 ? available * MAX_SHARE : Infinity;
  const ceiling = Math.max(min, Math.min(max, share));
  return Math.round(Math.min(Math.max(value, min), ceiling));
}

/** Clamp every panel at once. */
export function clampLayout(sizes: LayoutSizes, window?: { width: number; height: number }): LayoutSizes {
  return {
    left: clampPanel('left', sizes.left, window?.width),
    right: clampPanel('right', sizes.right, window?.width),
    timeline: clampPanel('timeline', sizes.timeline, window?.height),
  };
}

export const LAYOUT_STORAGE_KEY = 'breeze.editor.layout';

/**
 * Read saved sizes, falling back to the defaults for anything missing or
 * unusable.
 *
 * Deliberately total: a corrupt or hand-edited entry, a key written by an older
 * version, or storage being unavailable entirely (private browsing, a locked-down
 * kiosk profile) must all degrade to the default layout rather than throwing on
 * the way to first paint.
 */
export function loadLayout(storage?: Pick<Storage, 'getItem' | 'setItem'> | null): LayoutSizes {
  const store = storage ?? safeStorage();
  if (!store) return { ...DEFAULT_LAYOUT };

  try {
    const raw = store.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };

    const parsed = JSON.parse(raw) as Partial<Record<PanelKey, unknown>>;
    const read = (key: PanelKey): number => {
      const value = parsed[key];
      return typeof value === 'number' && Number.isFinite(value)
        ? clampPanel(key, value)
        : DEFAULT_LAYOUT[key];
    };

    return { left: read('left'), right: read('right'), timeline: read('timeline') };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

/** Persist sizes. Failure to write is not worth interrupting an edit over. */
export function saveLayout(
  sizes: LayoutSizes,
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null,
): void {
  const store = storage ?? safeStorage();
  if (!store) return;
  try {
    store.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(sizes));
  } catch {
    /* Quota, disabled storage, or a sandboxed iframe. Not fatal. */
  }
}

/** `localStorage` access throws outright in some privacy modes, not just on write. */
function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
