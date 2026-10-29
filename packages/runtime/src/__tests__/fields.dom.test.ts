// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/** Typed fields in the runtime (Phase 9 Wave B): how a bound layer shows each kind. */

import { afterEach, describe, expect, it } from 'vitest';
import { createComposition, createShapeLayer, createTextLayer, type Composition, type Layer } from '@breeze/schema';

import { BreezeRuntime } from '../runtime.js';

const comp: Composition = {
  ...createComposition({
    id: 'bug',
    name: 'Scorebug',
    duration: 1,
    layers: [
      { ...createTextLayer({ id: 'home', text: '0' }), binding: 'homeScore', colorBinding: 'homeColor' } as Layer,
      { ...createTextLayer({ id: 'per', text: '1' }), binding: 'period' } as Layer,
      { ...createTextLayer({ id: 'bonus', text: '' }), binding: 'bonus' } as Layer,
      { ...createShapeLayer({ id: 'bar' }), colorBinding: 'homeColor' } as Layer,
      {
        ...createTextLayer({ id: 'flag', text: 'BONUS' }),
        rules: [{ when: [{ binding: 'bonus', cmp: 'eq', value: true }], show: true }],
      } as Layer,
    ],
  }),
  fields: {
    homeScore: { kind: 'number', pad: 2 },
    period: { kind: 'enum', options: [{ value: '1', label: '1st' }, { value: '2', label: '2nd' }] },
    bonus: { kind: 'boolean', onText: 'BONUS', offText: '' },
    homeColor: { kind: 'color' },
  },
};

let runtime: BreezeRuntime;
afterEach(() => {
  runtime.destroy();
  document.body.textContent = '';
});

function mount(): BreezeRuntime {
  const container = document.createElement('div');
  document.body.appendChild(container);
  runtime = new BreezeRuntime({ container, composition: comp, injectStyles: false });
  return runtime;
}

const inner = (id: string) => runtime.getLayerElement(id)!.querySelector<HTMLElement>('.bz-text-inner')!;

describe('typed fields', () => {
  it('formats a number, an option and a toggle', () => {
    mount();
    runtime.update({ homeScore: 7, period: '2', bonus: true });
    expect(inner('home').textContent).toBe('07');
    expect(inner('per').textContent).toBe('2nd');
    expect(inner('bonus').textContent).toBe('BONUS');
    runtime.update({ bonus: 'off' });
    expect(inner('bonus').textContent).toBe('');
  });

  it('recolours from a colour field without touching the text', () => {
    mount();
    runtime.update({ homeScore: 3, homeColor: '#c8102e' });
    expect(inner('home').textContent).toBe('03');
    expect(inner('home').style.color).toMatch(/#c8102e|rgb\(200, 16, 46\)/i);
    const bar = runtime.getLayerElement('bar')!.querySelector<HTMLElement>('.bz-shape')!;
    expect(bar.style.background).toMatch(/#c8102e|rgb\(200, 16, 46\)/i);
  });

  it('ignores a colour that is not one rather than blanking the layer', () => {
    mount();
    runtime.update({ homeColor: '#00ff00' });
    runtime.update({ homeColor: 'red; display:none' });
    expect(inner('home').style.color).toMatch(/#00ff00|rgb\(0, 255, 0\)/i);
  });

  it('lets a rule read a toggle', () => {
    mount();
    const flag = runtime.getLayerElement('flag')!;
    expect(flag.dataset['ruleHidden']).toBe('1');
    runtime.update({ bonus: true });
    expect(flag.dataset['ruleHidden']).toBeUndefined();
  });
});
