// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Switcher-friendly outputs (Phase 9 Wave C): `?bg=` and `?matte=1`.
 *
 * An output page is transparent, which is right for a browser source and no use
 * to a hardware switcher: an ATEM's HDMI input has no alpha. Two query
 * parameters shape the same page for one:
 *
 *   - `?bg=<colour>` paints an opaque background behind the graphic, for a
 *     switcher with no alpha input that keys on colour (chroma) instead.
 *   - `?matte=1` renders the graphic as a **key signal**: white where it is
 *     opaque, black where it is clear, grey in between. Paired with a fill page
 *     on a second output, an upstream luma key with "pre-multiplied" on cuts the
 *     graphic in with clean semi-transparent edges.
 *
 * Both are CSS on the page, never a second renderer: the matte is a filter over
 * the same runtime, so it has the same timing and the same late join as the
 * fill beside it. NDI and SDI output are not goals (PHASE9.md §4).
 *
 * Pure and DOM-free: the server renders the CSS into the page head so the first
 * frame is already right, and the output page reads the same parse to tell the
 * hub it is a matte and to print what it ignored.
 */

/**
 * Names `?bg=` accepts besides a hex colour.
 *
 * Digital primaries rather than the paint chroma colours (#00B140, #0047BB):
 * nothing here passes through a camera, so the keyer sees exactly this value,
 * and the purest one is the easiest to key.
 */
export const KEY_BACKGROUNDS: Readonly<Record<string, string>> = Object.freeze({
  black: '#000000',
  white: '#ffffff',
  green: '#00ff00',
  blue: '#0000ff',
  magenta: '#ff00ff',
});

/** The query parameters this module owns. An output page never seeds a field from them. */
export const KEYING_PARAMS = ['bg', 'matte'] as const;

export interface OutputKeying {
  /** Opaque background, `#rrggbb` lower case, or null for the usual transparent page. */
  bg: string | null;
  /** Render the key signal instead of the fill. */
  matte: boolean;
  /**
   * What was asked for and not done, in frozen English for the console — the
   * same register as every other `/play` diagnostic (I18N.md §2).
   */
  problems: string[];
}

/** What `outputKeying` reads: a `URLSearchParams`, or anything with its `get`. */
export interface ParamsLike {
  get(name: string): string | null;
}

/**
 * A `?bg=` value as `#rrggbb`, or null for none.
 *
 * Six- and three-digit hex, with or without the `#`. Without is the form to
 * use in a URL: a bare `#` starts the fragment, so `?bg=#00ff00` reaches the
 * server as `?bg=` and is ignored, while `?bg=00ff00` and `?bg=%2300ff00` work.
 * No alpha digits: a background with alpha is the transparent page again with
 * extra steps, and a keyer cannot use it. `undefined` when the value is
 * unusable, so the caller can say so.
 */
export function parseKeyBackground(raw: string | null | undefined): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'none' || value === 'transparent') return null;
  const named = KEY_BACKGROUNDS[value];
  if (named) return named;
  const hex = value.startsWith('#') ? value.slice(1) : value;
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{3}$/.test(hex)) return `#${[...hex].map((c) => c + c).join('')}`;
  return undefined;
}

/** Read `?bg=` and `?matte=` off a query string. Never throws. */
export function outputKeying(params: ParamsLike): OutputKeying {
  const problems: string[] = [];

  const rawMatte = params.get('matte');
  let matte = false;
  if (rawMatte !== null) {
    const m = rawMatte.trim().toLowerCase();
    if (m === '1' || m === 'true' || m === '') matte = true;
    else if (m !== '0' && m !== 'false') {
      problems.push(`?matte=${rawMatte} is not understood; use ?matte=1. This page renders the fill.`);
    }
  }

  const rawBg = params.get('bg');
  let bg = parseKeyBackground(rawBg);
  if (bg === undefined) {
    problems.push(
      `?bg=${rawBg} is not a colour this page understands. Use a hex colour without the # ` +
        `(?bg=00ff00) or one of ${Object.keys(KEY_BACKGROUNDS).join(', ')}. The background stays transparent.`,
    );
    bg = null;
  }

  /*
   * A key signal is always on black: black is "nothing here" to the keyer.
   * Painting a matte page any other colour would key a box, so the colour is
   * dropped rather than obeyed, and the console says why.
   */
  if (matte && bg !== null) {
    problems.push(`?bg= is ignored on a matte page: a key signal is always white on black.`);
    bg = null;
  }

  return { bg, matte, problems };
}

/**
 * The CSS that makes a page what `keying` asks for, or `''` when it is the
 * usual transparent page.
 *
 * `:root` on purpose. The output bundle injects its own
 * `html, body { background: transparent !important }` into the head after this
 * block has been written, and a rule of equal specificity that comes later
 * wins. A pseudo-class outranks two type selectors, so this one holds whatever
 * order the styles arrive in.
 *
 * The matte filter is on `#breeze-stage`, the one element every graphic on the
 * page is mounted under, not on each runtime's root. A filter makes its element
 * a group: everything under it is composited first, and the filter then sees
 * the combined coverage. One group means a scene or an output stacking three
 * graphics produces one key — the same coverage the fill page shows — with no
 * double-counting where two of them overlap.
 *
 * `brightness(0)` takes every colour to black and leaves alpha alone;
 * `invert(1)` takes black to white. What is left is white at the graphic's own
 * alpha, composited over a black body: grey level = alpha.
 */
export function keyingCss(keying: Pick<OutputKeying, 'bg' | 'matte'>): string {
  if (keying.matte) {
    return ':root,:root>body{background:#000!important}#breeze-stage{filter:brightness(0) invert(1)}';
  }
  if (keying.bg) return `:root,:root>body{background:${keying.bg}!important}`;
  return '';
}
