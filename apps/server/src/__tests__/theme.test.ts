/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (C) 2026 Dave Clark
 * SPDX-License-Identifier: MPL-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DARK_ROOT_DECLS, THEMES, THEME_CHOICES, themeCss, themeScript, type ThemeId } from '../theme.js';

/** WCAG 2.x relative luminance and contrast ratio. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = ['text', 'muted', 'accent', 'danger', 'success', 'attention', 'attention-soft', 'danger-soft'];
const SURFACES = ['bg', 'panel', 'panel-2'];
const FILLED: Array<[string, string]> = [
  ['on-accent', 'accent-dim'],
  ['on-accent', 'danger-emphasis'],
  ['on-accent', 'success-emphasis'],
  ['danger-on-bg', 'danger-bg'],
];
const ids = Object.keys(THEMES) as ThemeId[];

describe('interface themes', () => {
  it('every theme defines exactly the tokens dark does', () => {
    const want = Object.keys(THEMES.dark.tokens).sort();
    for (const id of ids) expect(Object.keys(THEMES[id].tokens).sort(), id).toEqual(want);
  });

  it('offers every theme in the picker, plus system', () => {
    expect([...THEME_CHOICES].sort()).toEqual([...ids, 'system'].sort());
  });

  // WCAG 1.4.3. The dimmed theme is the one most at risk: softer is the point
  // of it, and the first draft of its muted grey was 3.9:1 on an input.
  it.each(ids)('%s: text tokens are at least 4.5:1 on every surface', (id) => {
    const t = THEMES[id].tokens;
    for (const fg of TEXT) {
      for (const bg of SURFACES) {
        expect(contrast(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(ids)('%s: labels on filled buttons are at least 4.5:1', (id) => {
    const t = THEMES[id].tokens;
    for (const [fg, bg] of FILLED) expect(contrast(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  // WCAG 1.4.11, held to the high-contrast themes only: in the others a
  // hairline border is deliberately quiet and the panel edge carries the shape.
  it.each(['dark-hc', 'light-hc'] as ThemeId[])('%s: borders are at least 3:1 on every surface', (id) => {
    const t = THEMES[id].tokens;
    for (const bg of SURFACES) expect(contrast(t.border!, t[bg]!), `border on ${bg}`).toBeGreaterThanOrEqual(3);
  });

  /*
   * The editor's stylesheet carries its own copy of the dark values as the
   * fallback for a page whose /theme.js never ran. That copy is the one thing
   * here that can drift, so it is held to the table.
   */
  it("the editor stylesheet's fallback :root matches the dark theme", () => {
    const css = fs.readFileSync(path.resolve(import.meta.dirname, '../../../editor/src/styles.css'), 'utf8');
    const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    for (const [k, v] of Object.entries(THEMES.dark.tokens)) {
      expect(root, `--${k}`).toMatch(new RegExp(`--${k}:\\s*${v};`, 'i'));
    }
  });

  it('writes one rule per theme and the dark fallback declarations', () => {
    const css = themeCss();
    for (const id of ids) expect(css).toContain(`:root[data-theme="${id}"]{color-scheme:${THEMES[id].scheme};`);
    expect(DARK_ROOT_DECLS).toContain('--bg:#0d1117;');
    expect(DARK_ROOT_DECLS).toContain('--panel2:var(--panel-2);');
  });

  /*
   * The script runs before anything else on every themed page. Run it against
   * a minimal document so a syntax error or a wrong resolution shows up here
   * rather than as an unthemed control panel.
   */
  function run(stored: string | null, prefersLight = false, prefersMore = false) {
    const attrs: Record<string, string> = {};
    const store = new Map<string, string>(stored === null ? [] : [['breeze.theme', stored]]);
    const appended: Array<{ id: string; textContent: string }> = [];
    const win: Record<string, unknown> = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
      matchMedia: (q: string) => ({
        matches: q.includes('light') ? prefersLight : q.includes('more') ? prefersMore : false,
        addEventListener: () => {},
      }),
      addEventListener: () => {},
    };
    const doc = {
      documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; }, getAttribute: (k: string) => attrs[k] ?? null },
      head: { appendChild: (el: { id: string; textContent: string }) => void appended.push(el) },
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
    };
    new Function('window', 'document', themeScript())(win, doc);
    return { attrs, appended, store, api: win.breezeTheme as { set(id: string): void; choice(): string } };
  }

  it('applies the stored choice, and follows the OS when there is none', () => {
    expect(run('dark-rg').attrs['data-theme']).toBe('dark-rg');
    expect(run(null).attrs['data-theme']).toBe('dark');
    expect(run(null, true).attrs['data-theme']).toBe('light');
    expect(run(null, true, true).attrs['data-theme']).toBe('light-hc');
    expect(run(null, false, true).attrs['data-theme']).toBe('dark-hc');
    // A value from a future or older build is ignored, not applied as a broken theme.
    expect(run('neon').attrs['data-theme']).toBe('dark');
  });

  it('injects its rules once and remembers a change', () => {
    const r = run(null);
    expect(r.appended).toHaveLength(1);
    expect(r.appended[0]!.textContent).toContain('[data-theme="dark-by"]');
    r.api.set('light-hc');
    expect(r.attrs['data-theme']).toBe('light-hc');
    expect(r.store.get('breeze.theme')).toBe('light-hc');
    r.api.set('system');
    expect(r.store.has('breeze.theme')).toBe(false);
    expect(r.attrs['data-theme']).toBe('dark');
  });
});
