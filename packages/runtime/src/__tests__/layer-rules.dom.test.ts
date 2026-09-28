// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Layers that react to data (CYCLE.md, Wave 6), through the runtime: rules on
 * ordinary layers read fields, sources and the mode; rules on table cells read
 * their own row as well. Every change goes back when the rule stops holding.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DATA_UPDATE_KEY,
  MODE_UPDATE_KEY,
  createComposition,
  createShapeLayer,
  createTableLayer,
  createTextLayer,
  type ImageLayer,
  type Layer,
  type LayerRule,
} from '@breeze/schema';

import { BreezeRuntime } from '../runtime.js';

let runtime: BreezeRuntime;

function mount(layers: Layer[], data: Record<string, unknown> = {}): BreezeRuntime {
  const container = document.createElement('div');
  document.body.appendChild(container);
  runtime = new BreezeRuntime({
    container,
    composition: createComposition({ id: 'wx', name: 'WX', duration: 2, layers }),
    injectStyles: false,
    data,
  });
  return runtime;
}

afterEach(() => {
  runtime?.destroy();
  document.body.innerHTML = '';
});

const el = (id: string) => runtime.getLayerElement(id)!;
const hidden = (id: string) => el(id).dataset['ruleHidden'] === '1';
const textColor = (id: string) => (el(id).querySelector('.bz-text-inner') as HTMLElement).style.color;
const fill = (id: string) => (el(id).querySelector('.bz-shape') as HTMLElement).style.background;

const image = (id: string, src: string, rules: LayerRule[]): ImageLayer => ({
  id, type: 'image', name: id, src, size: { width: 64, height: 64 }, transform: { x: 0, y: 0 }, opacity: 1, rules,
});

describe('rules on layers', () => {
  it('recolours text while a field is over a value, and puts the colour back', () => {
    mount([
      createTextLayer({
        id: 'temp', binding: 'temp', text: '90',
        style: { fontFamily: 'Inter', fontSize: 40, fill: '#ffffff' },
        rules: [{ when: [{ binding: 'temp', cmp: 'gt', value: 100 }], color: '#ff7a00' }],
      }),
    ]);
    expect(textColor('temp')).toBe('#ffffff');
    runtime.update({ temp: 104 });
    expect(textColor('temp')).toBe('#ff7a00');
    runtime.update({ temp: 98 });
    expect(textColor('temp')).toBe('#ffffff');
  });

  it('shows a banner only in its mode — "show when" hides it otherwise', () => {
    mount([
      createShapeLayer({
        id: 'banner', fill: '#1f6feb',
        rules: [{ when: [{ mode: true, cmp: 'eq', value: 'first-alert' }], show: true }],
      }),
    ]);
    expect(hidden('banner')).toBe(true);
    runtime.setMode('first-alert');
    expect(runtime.mode).toBe('first-alert');
    expect(hidden('banner')).toBe(false);
    runtime.update({ [MODE_UPDATE_KEY]: '' });
    expect(hidden('banner')).toBe(true);
  });

  it('recolours a shape in a mode, and hides a layer while a source has no rows', () => {
    mount([
      createShapeLayer({
        id: 'bar', fill: '#1f6feb',
        rules: [
          { when: [{ mode: true, cmp: 'eq', value: 'first-alert' }], color: '#c8102e' },
          { when: [{ source: 'alerts', cmp: 'empty' }], show: false },
        ],
      }),
    ]);
    // No data yet counts as no rows.
    expect(hidden('bar')).toBe(true);
    runtime.update({ [DATA_UPDATE_KEY]: { alerts: { id: 'alerts', columns: [{ key: 'event', type: 'string' }], rows: [{ event: 'Heat Warning' }] } } });
    expect(hidden('bar')).toBe(false);
    runtime.setMode('first-alert');
    expect(fill('bar')).toBe('#c8102e');
    runtime.setMode('');
    expect(fill('bar')).toBe('#1f6feb');
  });

  it('reads a source row picked by `where`, and fills an image source from it', () => {
    const forecast = {
      id: 'wx', columns: [{ key: 'place', type: 'string' as const }, { key: 'icon', type: 'string' as const }],
      rows: [{ place: 'Phoenix', icon: 'sunny' }, { place: 'Flagstaff', icon: 'snow' }],
    };
    mount(
      [image('icon', 'icons/blank.png', [{ when: [{ source: 'wx', column: 'icon', where: { column: 'place', value: 'flagstaff' }, cmp: 'notEmpty' }], src: 'icons/{icon}.png' }])],
      { [DATA_UPDATE_KEY]: { wx: forecast } },
    );
    expect(el('icon').querySelector('img')!.getAttribute('src')).toBe('icons/snow.png');
    runtime.update({ [DATA_UPDATE_KEY]: { wx: { ...forecast, rows: [{ place: 'Phoenix', icon: 'sunny' }] } } });
    expect(el('icon').querySelector('img')!.getAttribute('src')).toBe('icons/blank.png');
  });

  it('starts in the mode the page was loaded with', () => {
    mount([
      createShapeLayer({ id: 'banner', rules: [{ when: [{ mode: true, cmp: 'eq', value: 'first-alert' }], show: true }] }),
    ], { [MODE_UPDATE_KEY]: 'first-alert' });
    expect(hidden('banner')).toBe(false);
  });
});

describe('rules on table cells', () => {
  const rows = [
    { place: 'Phoenix', hi: 108, icon: 'sunny' },
    { place: 'Flagstaff', hi: 71, icon: 'snow' },
  ];
  const table = () =>
    createTableLayer({
      id: 'tiles',
      size: { width: 600, height: 200 },
      row: {
        height: 50,
        cells: [
          createTextLayer({
            id: 'hi', cell: 'hi', size: { width: 100, height: 50 },
            style: { fontFamily: 'Inter', fontSize: 30, fill: '#ffffff' },
            rules: [{ when: [{ column: 'hi', cmp: 'gte', value: 100 }], color: '#ff7a00' }],
          }),
          image('icon', 'icons/blank.png', [{ when: [{ column: 'icon', cmp: 'notEmpty' }], src: 'icons/{icon}.png' }]),
          createShapeLayer({
            id: 'alert', size: { width: 20, height: 20 },
            rules: [{ when: [{ mode: true, cmp: 'eq', value: 'first-alert' }, { column: 'place', cmp: 'eq', value: 'Phoenix' }], show: true }],
          }),
        ],
      },
      data: { columns: [{ key: 'place', type: 'string' }, { key: 'hi', type: 'number' }, { key: 'icon', type: 'string' }], rows },
    });
  const cells = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-cell="${id}"]`)];

  it('reads each row: colour, image and visibility per row', () => {
    mount([table()]);
    const [phx, flg] = cells('hi');
    expect((phx!.querySelector('.bz-text-inner') as HTMLElement).style.color).toBe('#ff7a00');
    expect((flg!.querySelector('.bz-text-inner') as HTMLElement).style.color).toBe('#ffffff');
    expect(cells('icon').map((c) => c.querySelector('img')!.getAttribute('src'))).toEqual(['icons/sunny.png', 'icons/snow.png']);
    expect(cells('alert').map((c) => c.dataset['ruleHidden'])).toEqual(['1', '1']);
  });

  it('re-reads cell rules when the mode changes, without new rows', () => {
    mount([table()]);
    runtime.setMode('first-alert');
    expect(cells('alert').map((c) => c.dataset['ruleHidden'])).toEqual([undefined, '1']);
    runtime.setMode('');
    expect(cells('alert').map((c) => c.dataset['ruleHidden'])).toEqual(['1', '1']);
  });
});

describe('review fixes', () => {
  it('recolours a path shape’s path, not its box', () => {
    mount([
      createShapeLayer({
        id: 'line', shape: 'path', fill: '#1f6feb',
        path: 'M0 0 L10 0 L10 10 Z',
        rules: [{ when: [{ mode: true, cmp: 'eq', value: 'first-alert' }], color: '#c8102e' }],
      } as never),
    ]);
    const path = el('line').querySelector('path')!;
    const before = path.getAttribute('fill');
    runtime.setMode('FIRST-ALERT');
    expect(path.getAttribute('fill')).toBe('#c8102e');
    expect((el('line').querySelector('svg') as unknown as HTMLElement).style.background).toBe('');
    runtime.setMode('');
    expect(path.getAttribute('fill')).toBe(before);
  });

  it('lets a bound image change under a rule, and shows the new picture when the rule ends', () => {
    mount([{
      ...image('icon', 'icons/cloud.png', [{ when: [{ mode: true, cmp: 'eq', value: 'first-alert' }], src: 'icons/alert.png' }]),
      binding: 'icon',
    } as ImageLayer]);
    const img = () => el('icon').querySelector('img')!.getAttribute('src');
    runtime.setMode('first-alert');
    expect(img()).toBe('icons/alert.png');
    runtime.update({ icon: 'icons/sun.png' });
    expect(img()).toBe('icons/alert.png');
    runtime.setMode('');
    expect(img()).toBe('icons/sun.png');
  });

  it('clears a table image cell for a row with no picture, whatever came before', () => {
    mount([
      createTableLayer({
        id: 't', source: 'feed', size: { width: 200, height: 100 },
        row: { height: 50, cells: [image('pic', '', [{ when: [{ column: 'sev', cmp: 'eq', value: 'high' }], src: 'icons/alert.png' }])].map((c) => ({ ...c, cell: 'icon' })) },
        data: { columns: [{ key: 'sev', type: 'string' }, { key: 'icon', type: 'string' }], rows: [{ sev: 'high', icon: '' }] },
      }),
    ]);
    const img = () => document.querySelector('[data-cell="pic"] img')!;
    expect(img().getAttribute('src')).toBe('icons/alert.png');
    runtime.update({ [DATA_UPDATE_KEY]: { feed: { id: 'feed', columns: [{ key: 'sev', type: 'string' }, { key: 'icon', type: 'string' }], rows: [{ sev: 'low', icon: '' }] } } });
    expect(img().hasAttribute('src')).toBe(false);
  });
});
