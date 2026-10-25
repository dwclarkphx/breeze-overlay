/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (C) 2026 Dave Clark
 * SPDX-License-Identifier: MPL-2.0
 */

/**
 * Interface themes — the colours of Breeze's own chrome.
 *
 * **Chrome only, never graphics.** The portal, editor, control panels, backup,
 * activity, connections and guide pages take a theme. `/play` does not and
 * never will: it is frozen (I18N.md §2) and what it draws is the show. Inside
 * the editor the same line holds — a theme recolours panels, the timeline and
 * the pasteboard around the stage, never a layer on it.
 *
 * **Why this set.** There is no formal standard list of accessible themes.
 * WCAG sets the floors — 4.5:1 for text (1.4.3), 3:1 for UI parts (1.4.11),
 * and never colour alone (1.4.1) — and the de facto product convention is
 * GitHub's: dark, dimmed, high contrast, light, and red–green and blue–yellow
 * colour-blind variants. Breeze's palette was already GitHub's dark one, so
 * that convention is what operators will recognise. The values are Breeze's
 * own, tuned against the floors above rather than copied:
 *
 * - every text token is ≥ 4.5:1 on `bg`, `panel` and `panel-2`, and every label
 *   on a filled button is ≥ 4.5:1 on its fill — in every theme, including the
 *   dimmed one, which is softer but not below the floor;
 * - the high-contrast themes also keep `border` ≥ 3:1 on every surface;
 * - in the two colour-blind themes, danger, success and warning stay at least
 *   ΔE 20 (CAM02-UCS) apart under a full-severity Machado 2009 simulation of
 *   the deficiency they are for. The default dark theme fails that badly for
 *   deuteranopia — danger red and success green land ΔE 3.7 apart, which is
 *   the reason the red–green theme exists.
 *
 * `theme.test.ts` re-checks the contrast floors, so a token edited here cannot
 * quietly drop under them.
 *
 * **How it reaches a page.** One classic script, `/theme.js`, loaded
 * synchronously in `<head>` before any stylesheet that uses the tokens. It
 * injects the theme rules, reads the viewer's choice from `localStorage` and
 * sets `data-theme` on `<html>` before first paint, so there is no flash of
 * the wrong theme. A classic script rather than a module (modules are
 * deferred) and a script rather than a stylesheet link, because Vite rewrites
 * stylesheet links in the editor's `index.html` and leaves classic scripts with
 * absolute URLs alone — the GSAP tags rely on the same rule.
 *
 * The choice is per browser, not per server: a phone running a control panel
 * in a dark gallery and the laptop next to it can disagree, and they should.
 * It is stored under one key, so every open Breeze tab on that browser follows
 * a change at once through the `storage` event.
 *
 * Dark is also the fallback written into every page's own `:root`, so a page
 * whose script failed still looks like Breeze — `theme.test.ts` holds the
 * editor stylesheet's copy equal to the table below.
 */

/** A concrete theme. `system` is a choice that resolves to one of these. */
export type ThemeId = 'dark' | 'dark-dimmed' | 'dark-hc' | 'light' | 'light-hc' | 'dark-rg' | 'dark-by';
export type ThemeChoice = ThemeId | 'system';

/** Picker order: the automatic choice, then the dark family, then light. */
export const THEME_CHOICES: readonly ThemeChoice[] = [
  'system', 'dark', 'dark-dimmed', 'dark-hc', 'dark-rg', 'dark-by', 'light', 'light-hc',
];

/** The `localStorage` key every page reads. */
export const THEME_STORAGE_KEY = 'breeze.theme';

export interface Theme {
  /** The CSS `color-scheme`, so scrollbars and native form controls match. */
  scheme: 'dark' | 'light';
  tokens: Record<string, string>;
}

export const THEMES: Record<ThemeId, Theme> = {
  'dark': {
    scheme: 'dark',
    tokens: {
      'bg': '#0d1117',
      'panel': '#161b22',
      'panel-2': '#1c2129',
      'border': '#30363d',
      'border-muted': '#21262d',
      'text': '#c9d1d9',
      'muted': '#8b949e',
      'accent': '#58a6ff',
      'accent-dim': '#1f6feb',
      'accent-border': '#388bfd',
      'on-accent': '#ffffff',
      'danger': '#f85149',
      'danger-emphasis': '#a52834',
      'danger-border': '#c9313f',
      'danger-bg': '#3d1518',
      'danger-on-bg': '#ffdcd8',
      'danger-soft': '#ff9d95',
      'success': '#3fb950',
      'success-emphasis': '#238636',
      'success-border': '#2ea043',
      'attention': '#d29922',
      'attention-soft': '#ffcf7a',
      'key': '#e3b341',
      'key-border': '#7a5c14',
      'key-selected': '#ffffff',
      'checker-a': '#2a2f36',
      'checker-b': '#1b1f24',
      'stage-checker-a': '#23282f',
      'stage-checker-b': '#191d23',
      'stage-backdrop': '#05070a',
      'graph-bg': '#0b0f14',
    },
  },
  'dark-dimmed': {
    scheme: 'dark',
    tokens: {
      'bg': '#22272e',
      'panel': '#2d333b',
      'panel-2': '#373e47',
      'border': '#4b545f',
      'border-muted': '#373e47',
      'text': '#adbac7',
      'muted': '#a3afbc',
      'accent': '#6cb6ff',
      'accent-dim': '#2c64b8',
      'accent-border': '#4184e4',
      'on-accent': '#e6edf3',
      'danger': '#ff8f87',
      'danger-emphasis': '#a8322d',
      'danger-border': '#d6443e',
      'danger-bg': '#422325',
      'danger-on-bg': '#f4c7c4',
      'danger-soft': '#ff938a',
      'success': '#6bc46d',
      'success-emphasis': '#2f6f37',
      'success-border': '#46954a',
      'attention': '#daaa3f',
      'attention-soft': '#eac55f',
      'key': '#daaa3f',
      'key-border': '#6c5a24',
      'key-selected': '#e6edf3',
      'checker-a': '#3a414a',
      'checker-b': '#2d333b',
      'stage-checker-a': '#323942',
      'stage-checker-b': '#282e36',
      'stage-backdrop': '#1c2128',
      'graph-bg': '#1c2128',
    },
  },
  'dark-hc': {
    scheme: 'dark',
    tokens: {
      'bg': '#010409',
      'panel': '#0a0c10',
      'panel-2': '#151a21',
      'border': '#7a828e',
      'border-muted': '#525964',
      'text': '#ffffff',
      'muted': '#d1d7e0',
      'accent': '#71b7ff',
      'accent-dim': '#0e5cc9',
      'accent-border': '#91cbff',
      'on-accent': '#ffffff',
      'danger': '#ff8080',
      'danger-emphasis': '#c1121c',
      'danger-border': '#ff9492',
      'danger-bg': '#4a0c12',
      'danger-on-bg': '#ffffff',
      'danger-soft': '#ffb1af',
      'success': '#4ae168',
      'success-emphasis': '#08711f',
      'success-border': '#4ae168',
      'attention': '#f7c843',
      'attention-soft': '#ffdb63',
      'key': '#f7c843',
      'key-border': '#b08800',
      'key-selected': '#ffffff',
      'checker-a': '#2a2f37',
      'checker-b': '#0a0c10',
      'stage-checker-a': '#22262d',
      'stage-checker-b': '#0a0c10',
      'stage-backdrop': '#000000',
      'graph-bg': '#000000',
    },
  },
  'light': {
    scheme: 'light',
    tokens: {
      'bg': '#ffffff',
      'panel': '#f6f8fa',
      'panel-2': '#f0f3f6',
      'border': '#d0d7de',
      'border-muted': '#e4e8ec',
      'text': '#1f2328',
      'muted': '#59636e',
      'accent': '#0969da',
      'accent-dim': '#0969da',
      'accent-border': '#0550ae',
      'on-accent': '#ffffff',
      'danger': '#cf222e',
      'danger-emphasis': '#cf222e',
      'danger-border': '#a40e26',
      'danger-bg': '#ffebe9',
      'danger-on-bg': '#82071e',
      'danger-soft': '#a40e26',
      'success': '#1a7f37',
      'success-emphasis': '#1a7f37',
      'success-border': '#116329',
      'attention': '#875b00',
      'attention-soft': '#7d4e00',
      'key': '#d4a72c',
      'key-border': '#7d4e00',
      'key-selected': '#1f2328',
      'checker-a': '#e3e7eb',
      'checker-b': '#ffffff',
      'stage-checker-a': '#dde2e7',
      'stage-checker-b': '#f3f5f7',
      'stage-backdrop': '#c9d1d9',
      'graph-bg': '#ffffff',
    },
  },
  'light-hc': {
    scheme: 'light',
    tokens: {
      'bg': '#ffffff',
      'panel': '#ffffff',
      'panel-2': '#e7ecf0',
      'border': '#20252c',
      'border-muted': '#88929d',
      'text': '#0e1116',
      'muted': '#33393f',
      'accent': '#0349b4',
      'accent-dim': '#0349b4',
      'accent-border': '#022f7a',
      'on-accent': '#ffffff',
      'danger': '#a0111f',
      'danger-emphasis': '#a0111f',
      'danger-border': '#6e011a',
      'danger-bg': '#fff0ee',
      'danger-on-bg': '#6e011a',
      'danger-soft': '#a0111f',
      'success': '#055d20',
      'success-emphasis': '#055d20',
      'success-border': '#024c1a',
      'attention': '#744500',
      'attention-soft': '#603700',
      'key': '#b58407',
      'key-border': '#4e2c00',
      'key-selected': '#0e1116',
      'checker-a': '#c9d0d8',
      'checker-b': '#ffffff',
      'stage-checker-a': '#c9d0d8',
      'stage-checker-b': '#f0f3f6',
      'stage-backdrop': '#88929d',
      'graph-bg': '#ffffff',
    },
  },
  'dark-rg': {
    scheme: 'dark',
    tokens: {
      'bg': '#0d1117',
      'panel': '#161b22',
      'panel-2': '#1c2129',
      'border': '#30363d',
      'border-muted': '#21262d',
      'text': '#c9d1d9',
      'muted': '#8b949e',
      'accent': '#58a6ff',
      'accent-dim': '#1f6feb',
      'accent-border': '#388bfd',
      'on-accent': '#ffffff',
      'danger': '#e2733a',
      'danger-emphasis': '#9b4215',
      'danger-border': '#db6d28',
      'danger-bg': '#3d1f0a',
      'danger-on-bg': '#ffdfb6',
      'danger-soft': '#f0a070',
      'success': '#58a6ff',
      'success-emphasis': '#1f6feb',
      'success-border': '#388bfd',
      'attention': '#ffe066',
      'attention-soft': '#ffe98f',
      'key': '#ffe066',
      'key-border': '#8a7400',
      'key-selected': '#ffffff',
      'checker-a': '#2a2f36',
      'checker-b': '#1b1f24',
      'stage-checker-a': '#23282f',
      'stage-checker-b': '#191d23',
      'stage-backdrop': '#05070a',
      'graph-bg': '#0b0f14',
    },
  },
  'dark-by': {
    scheme: 'dark',
    tokens: {
      'bg': '#0d1117',
      'panel': '#161b22',
      'panel-2': '#1c2129',
      'border': '#30363d',
      'border-muted': '#21262d',
      'text': '#c9d1d9',
      'muted': '#8b949e',
      'accent': '#58a6ff',
      'accent-dim': '#1f6feb',
      'accent-border': '#388bfd',
      'on-accent': '#ffffff',
      'danger': '#ff6a69',
      'danger-emphasis': '#b62324',
      'danger-border': '#da3633',
      'danger-bg': '#3d1518',
      'danger-on-bg': '#ffdcd8',
      'danger-soft': '#ff9d95',
      'success': '#58a6ff',
      'success-emphasis': '#1f6feb',
      'success-border': '#388bfd',
      'attention': '#e3b341',
      'attention-soft': '#f2cc60',
      'key': '#e3b341',
      'key-border': '#7a5c14',
      'key-selected': '#ffffff',
      'checker-a': '#2a2f36',
      'checker-b': '#1b1f24',
      'stage-checker-a': '#23282f',
      'stage-checker-b': '#191d23',
      'stage-backdrop': '#05070a',
      'graph-bg': '#0b0f14',
    },
  },
};

/**
 * Names the pages already used before the tokens were unified, kept as
 * aliases so no stylesheet had to be rewritten for the rename.
 * `--fg` was referenced by the editor and the backup page and defined by
 * neither, so those rules had silently fallen back to inherited colour.
 */
const ALIASES = '--panel2:var(--panel-2);--fg:var(--text);';

function declarations(theme: Theme): string {
  return Object.entries(theme.tokens).map(([k, v]) => `--${k}:${v};`).join('') + ALIASES;
}

/**
 * The dark theme as plain `:root` declarations, for a page's own stylesheet —
 * the fallback if `/theme.js` never runs. No `color-scheme` here: pages set
 * that through their `<meta>` and the script.
 */
export const DARK_ROOT_DECLS = declarations(THEMES.dark);

/**
 * Every theme as a rule. `:root[data-theme=…]` outranks a page's bare
 * `:root`, so the order the two stylesheets arrive in does not matter.
 */
export function themeCss(): string {
  return (Object.entries(THEMES) as Array<[ThemeId, Theme]>)
    .map(([id, theme]) => `:root[data-theme="${id}"]{color-scheme:${theme.scheme};${declarations(theme)}}`)
    .join('\n');
}

/**
 * The script served at `/theme.js`. ES5 on purpose: it runs before anything
 * else on every page, including control panels opened on old tablets, and a
 * syntax error here would leave the page unthemed rather than merely
 * un-switchable.
 *
 * `system` follows `prefers-color-scheme`, and `prefers-contrast: more` picks
 * the high-contrast twin — so an operator who has asked their OS for more
 * contrast gets it here without visiting the picker. Windows contrast themes
 * (`forced-colors`) need nothing from us: the browser replaces every colour
 * itself, and these rules simply stop mattering.
 *
 * Exposes `window.breezeTheme` for the portal's picker: `choice()`,
 * `resolved()`, `set(id)` and `ids`.
 */
export function themeScript(): string {
  const ids = JSON.stringify(THEME_CHOICES);
  const css = JSON.stringify(themeCss());
  const key = JSON.stringify(THEME_STORAGE_KEY);
  return `/*! Breeze Overlay — interface themes. MPL-2.0. */
(function () {
  'use strict';
  var KEY = ${key};
  var IDS = ${ids};
  var root = document.documentElement;
  if (!document.getElementById('breeze-theme')) {
    var style = document.createElement('style');
    style.id = 'breeze-theme';
    style.textContent = ${css};
    (document.head || root).appendChild(style);
  }
  var mm = window.matchMedia ? function (q) { return window.matchMedia(q); } : function () { return null; };
  var light = mm('(prefers-color-scheme: light)');
  var more = mm('(prefers-contrast: more)');
  function choice() {
    try {
      var v = window.localStorage.getItem(KEY);
      if (v && IDS.indexOf(v) !== -1) return v;
    } catch (e) { /* storage blocked: private window, locked-down profile */ }
    return 'system';
  }
  function resolve(c) {
    if (c !== 'system') return c;
    var l = !!(light && light.matches), m = !!(more && more.matches);
    return l ? (m ? 'light-hc' : 'light') : (m ? 'dark-hc' : 'dark');
  }
  function apply() {
    var c = choice();
    root.setAttribute('data-theme', resolve(c));
    root.setAttribute('data-theme-choice', c);
  }
  function watch(q) {
    if (!q) return;
    if (q.addEventListener) q.addEventListener('change', apply);
    else if (q.addListener) q.addListener(apply);
  }
  apply();
  watch(light);
  watch(more);
  window.addEventListener('storage', function (e) { if (e.key === KEY || e.key === null) apply(); });
  window.breezeTheme = {
    ids: IDS.slice(),
    choice: choice,
    resolved: function () { return root.getAttribute('data-theme'); },
    set: function (id) {
      if (IDS.indexOf(id) === -1) return;
      try {
        if (id === 'system') window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, id);
      } catch (e) { /* not remembered, but still applied to this page */ }
      if (id === 'system') apply();
      else { root.setAttribute('data-theme', id); root.setAttribute('data-theme-choice', id); }
    }
  };
})();
`;
}

/** The `<head>` tag. First in `<head>`, before any `<style>` that reads a token. */
export const THEME_SCRIPT_TAG = '<script src="/theme.js"></script>';
