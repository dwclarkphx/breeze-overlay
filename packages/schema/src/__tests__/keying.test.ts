// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/** Switcher-friendly outputs (Phase 9 Wave C): `?bg=` and `?matte=1`. */

import { describe, expect, it } from 'vitest';

import { KEY_BACKGROUNDS, keyingCss, outputKeying, parseKeyBackground } from '../keying.js';

const q = (s: string) => outputKeying(new URLSearchParams(s));

describe('parseKeyBackground', () => {
  it('takes six- and three-digit hex, with or without #, in any case', () => {
    expect(parseKeyBackground('00ff00')).toBe('#00ff00');
    expect(parseKeyBackground('#00FF00')).toBe('#00ff00');
    expect(parseKeyBackground('0f0')).toBe('#00ff00');
    expect(parseKeyBackground(' #ABC ')).toBe('#aabbcc');
  });

  it('takes the named backgrounds', () => {
    for (const [name, hex] of Object.entries(KEY_BACKGROUNDS)) expect(parseKeyBackground(name)).toBe(hex);
    expect(parseKeyBackground('GREEN')).toBe('#00ff00');
  });

  it('reads empty, none and transparent as no background', () => {
    expect(parseKeyBackground(null)).toBeNull();
    expect(parseKeyBackground('')).toBeNull();
    expect(parseKeyBackground('none')).toBeNull();
    expect(parseKeyBackground('transparent')).toBeNull();
  });

  it('refuses alpha digits, CSS functions and anything that could escape the rule', () => {
    for (const bad of ['00ff0080', '#0f08', 'rgb(0,255,0)', 'chartreuse', 'red;}body{x:y', '00ff00!important', 'zzzzzz']) {
      expect(parseKeyBackground(bad), bad).toBeUndefined();
    }
  });
});

describe('outputKeying', () => {
  it('is the transparent fill page with no parameters', () => {
    expect(q('')).toEqual({ bg: null, matte: false, problems: [] });
    expect(q('name=Jane&autoplay=1')).toEqual({ bg: null, matte: false, problems: [] });
  });

  it('reads ?bg=', () => {
    expect(q('bg=green')).toEqual({ bg: '#00ff00', matte: false, problems: [] });
    expect(q('bg=%2300b140')).toMatchObject({ bg: '#00b140', problems: [] });
  });

  it('says so when ?bg= is unusable, and stays transparent', () => {
    const k = q('bg=rgb(0,255,0)');
    expect(k.bg).toBeNull();
    expect(k.problems).toHaveLength(1);
    expect(k.problems[0]).toMatch(/\?bg=00ff00/);
  });

  it('reads ?matte=1, true and a bare ?matte as on; 0 and false as off', () => {
    for (const s of ['matte=1', 'matte=true', 'matte=TRUE', 'matte']) expect(q(s).matte, s).toBe(true);
    for (const s of ['matte=0', 'matte=false']) expect(q(s)).toEqual({ bg: null, matte: false, problems: [] });
  });

  it('reports a ?matte= it does not understand and renders the fill', () => {
    const k = q('matte=yes');
    expect(k.matte).toBe(false);
    expect(k.problems[0]).toMatch(/\?matte=yes/);
  });

  it('drops ?bg= on a matte page, because a key signal is always on black', () => {
    const k = q('matte=1&bg=green');
    expect(k).toMatchObject({ bg: null, matte: true });
    expect(k.problems[0]).toMatch(/ignored on a matte page/);
  });
});

describe('keyingCss', () => {
  it('writes nothing for the usual page', () => {
    expect(keyingCss({ bg: null, matte: false })).toBe('');
  });

  it('outranks the bundle’s own transparent rule with :root', () => {
    const css = keyingCss({ bg: '#00ff00', matte: false });
    expect(css).toBe(':root,:root>body{background:#00ff00!important}');
  });

  it('turns the stage into white-at-alpha over black for a matte', () => {
    const css = keyingCss({ bg: null, matte: true });
    expect(css).toContain(':root,:root>body{background:#000!important}');
    expect(css).toContain('#breeze-stage{filter:brightness(0) invert(1)}');
  });

  it('ignores bg when matte is set, even if a caller passes both', () => {
    expect(keyingCss({ bg: '#00ff00', matte: true })).not.toContain('#00ff00');
  });
});
