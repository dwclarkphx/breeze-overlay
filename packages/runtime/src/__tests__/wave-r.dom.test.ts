// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

/**
 * Phase 9 Wave R in the runtime: rolls, drives, counting numbers, plotted
 * lines and tables along x (ROLLS.md, CHARTS.md).
 *
 * happy-dom measures every element as 0, so geometry is tested through an
 * injected `measure`, and the transport through injected clocks and tickers —
 * the same seams the crawl and timer tests use.
 */

import { gsap } from 'gsap';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SCROLLS_UPDATE_KEY,
  applyScrollAction,
  createComposition,
  createRollLayer,
  createShapeLayer,
  createTableLayer,
  createTextLayer,
  parseTextBody,
  type Composition,
  type Layer,
  type RollLayer,
  type TableLayer,
} from '@breeze/schema';

import { applyDriveValue, countTo, drawPlot, type ChartAnimator } from '../charts.js';
import { buildLayerElement, type LayerNodes } from '../dom.js';
import { applyRuleResult } from '../rules.js';
import { RollBlock, RollSync, rollGeometry, rollRowViews, type RollTicker } from '../roll.js';
import { BreezeRuntime } from '../runtime.js';

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
  vi.useRealTimers();
  document.body.textContent = '';
});

/** Records `set`s as GSAP would leave them, and keeps `to`s for a test to run by hand. */
function recorder() {
  const sets: Array<{ target: unknown; vars: Record<string, unknown> }> = [];
  const tos: Array<{ target: Record<string, number>; vars: Record<string, unknown> }> = [];
  const animator: ChartAnimator = {
    set(target, vars) {
      sets.push({ target, vars });
      if (target && typeof target === 'object' && 'style' in (target as object)) {
        const el = target as HTMLElement;
        if ('y' in vars || 'x' in vars) el.dataset['pos'] = `${vars['x'] ?? 0},${vars['y'] ?? 0}`;
      }
    },
    to(target, vars) {
      tos.push({ target: target as Record<string, number>, vars });
      return { kill: () => undefined };
    },
  };
  /** Run the last tween to its end, calling its callbacks as GSAP would. */
  const finish = () => {
    const t = tos[tos.length - 1]!;
    for (const [k, v] of Object.entries(t.vars)) if (typeof v === 'number' && k in t.target) t.target[k] = v;
    (t.vars['onUpdate'] as (() => void) | undefined)?.();
    (t.vars['onComplete'] as (() => void) | undefined)?.();
  };
  return { animator, sets, tos, finish };
}

function nodesFor(layer: Layer): LayerNodes {
  const nodes = buildLayerElement(
    { id: layer.id, layer, parentId: null, offset: 0, depth: 0, pinnedBindings: new Set(), overrides: {} },
    { doc: document, resolveAsset: (s) => s },
  );
  document.body.appendChild(nodes.el);
  return nodes;
}

/* --------------------------------------------------------------- rolls */

describe('roll geometry', () => {
  const roll = { direction: 'up', from: 'enter', to: 'exit' } as const;

  it('enters from the bottom and runs until the last line has gone', () => {
    expect(rollGeometry(roll, 600, 1000, 0)).toEqual({ start: 600, end: -1000, distance: 1600 });
  });

  it('starts with its first lines showing and parks its last at the bottom', () => {
    expect(rollGeometry({ ...roll, from: 'top', to: 'bottom' }, 600, 1000, 0)).toEqual({ start: 0, end: -400, distance: 400 });
  });

  it('mirrors for down and right', () => {
    expect(rollGeometry({ ...roll, direction: 'down' }, 600, 1000, 0)).toEqual({ start: -1000, end: 600, distance: 1600 });
    expect(rollGeometry({ ...roll, direction: 'right', from: 'top', to: 'bottom' }, 1920, 3000, 0)).toEqual({ start: -1080, end: 0, distance: 1080 });
  });

  it('a loop travels one copy and its gap', () => {
    expect(rollGeometry({ ...roll, end: 'loop' }, 600, 1000, 40).distance).toBe(1040);
  });
});

describe('roll rows', () => {
  it('lays out headings, pairs and gaps from a text source', () => {
    const layer = { ...createRollLayer(), id: 'r' } as RollLayer;
    const nodes = nodesFor(layer);
    const block = new RollBlock({ layer, window: nodes.rollWindow!, track: nodes.rollTrack!, animator: recorder().animator, measure: () => 900 });
    const rows = parseTextBody('t', '# Credits\nCamera | Pat Smith\n\nThanks').rows;
    block.setRows(rollRowViews(rows, layer));
    const copy = nodes.rollTrack!.querySelector('.bz-roll-copy')!;
    expect(copy.children).toHaveLength(4);
    expect(copy.children[0]!.textContent).toBe('Credits');
    expect((copy.children[0] as HTMLElement).style.fontWeight).toBe('700');
    expect(copy.querySelector('.bz-roll-pair')!.textContent).toBe('CameraPat Smith');
    expect(copy.querySelector('.bz-roll-gap')).not.toBeNull();
    // 600 window + 900 text, at the factory's 60 px/s.
    expect(block.extent).toBeCloseTo(1500 / 60, 6);
  });

  it('reads any source as lines of its column', () => {
    const layer = { ...createRollLayer(), column: 'title' } as RollLayer;
    expect(rollRowViews([{ title: 'Storm warning', kind: 'nonsense' }], layer)).toEqual([
      { kind: 'line', text: 'Storm warning', left: '', right: '' },
    ]);
  });

  it('a loop renders the text twice', () => {
    const layer = { ...createRollLayer(), end: 'loop' } as RollLayer;
    const nodes = nodesFor(layer);
    const block = new RollBlock({ layer, window: nodes.rollWindow!, track: nodes.rollTrack!, animator: recorder().animator, measure: () => 500 });
    block.setRows([{ kind: 'line', text: 'A', left: '', right: '' }]);
    expect(nodes.rollTrack!.querySelectorAll('.bz-roll-copy')).toHaveLength(2);
  });
});

describe('roll transport', () => {
  function setup(extra: Partial<RollLayer> = {}) {
    let now = 1_000_000;
    const fns = new Set<() => void>();
    const ticker: RollTicker = { add: (f) => fns.add(f), remove: (f) => fns.delete(f) };
    const rec = recorder();
    const layer = { ...createRollLayer(), id: 'r', speed: 100, ...extra } as RollLayer;
    const nodes = nodesFor(layer);
    const finished = vi.fn();
    const sync = new RollSync({ animator: rec.animator, ticker, now: () => now, onFinished: finished });
    const block = new RollBlock({ layer, window: nodes.rollWindow!, track: nodes.rollTrack!, animator: rec.animator, measure: () => 400 });
    block.setRows([{ kind: 'line', text: 'A', left: '', right: '' }]);
    sync.add('r', block);
    const pos = () => nodes.rollTrack!.dataset['pos'];
    const tick = (ms: number) => {
      now += ms;
      for (const f of [...fns]) f();
    };
    return { sync, pos, tick, fns, finished, at: () => now };
  }

  it('waits at the start until played, then moves from the hub anchor', () => {
    const t = setup();
    // Window 600: travel 0 puts the text just below it.
    expect(t.pos()).toBe('0,600');
    t.sync.setPayload({ clock: t.at(), scrolls: {}, playAt: t.at() });
    expect(t.fns.size).toBe(1);
    t.tick(2_000);
    expect(t.pos()).toBe('0,400');
  });

  it('pauses, reverses and stops ticking at the end', () => {
    const t = setup();
    const start = t.at();
    let state = applyScrollAction(undefined, 'play', start);
    t.sync.setPayload({ clock: start, scrolls: { main: state } });
    t.tick(1_000);
    state = applyScrollAction(state, 'pause', t.at());
    t.sync.setPayload({ clock: t.at(), scrolls: { main: state } });
    expect(t.fns.size).toBe(0);
    t.tick(5_000);
    expect(t.pos()).toBe('0,500');
    state = applyScrollAction(state, 'backward', t.at());
    t.sync.setPayload({ clock: t.at(), scrolls: { main: state } });
    t.tick(500);
    expect(t.pos()).toBe('0,550');
    t.tick(5_000);
    // Back at the start and parked: nothing left to tick for.
    expect(t.pos()).toBe('0,600');
    expect(t.fns.size).toBe(0);
  });

  it('a continue roll says so once when it runs out', () => {
    const t = setup({ end: 'continue' });
    t.sync.setPayload({ clock: t.at(), scrolls: {}, playAt: t.at() });
    t.tick(9_000);
    t.tick(2_000);
    t.tick(2_000);
    expect(t.finished).toHaveBeenCalledTimes(1);
    expect(t.sync.continueDone).toBe(true);
  });

  it('reports each scroll for the hub and the panel', () => {
    const t = setup({ scrollId: 'credits' });
    t.sync.setPayload({ clock: t.at(), scrolls: {}, playAt: t.at() });
    t.tick(3_000);
    expect(t.sync.reports).toEqual([{ id: 'credits', extent: 10, end: 'hold', start: 'play', travel: 3, running: true, rate: 1 }]);
  });

  it('an operator-started roll stays put on PLAY', () => {
    const t = setup({ start: 'operator' });
    t.sync.setPayload({ clock: t.at(), scrolls: {}, playAt: t.at() });
    t.tick(3_000);
    expect(t.pos()).toBe('0,600');
  });
});

/* ------------------------------------------------------------- drives */

describe('driven properties', () => {
  it('sets a width at once, then tweens it, growing from the far edge', () => {
    const layer = { ...createShapeLayer({ id: 'bar', size: { width: 400, height: 40 } }) };
    const nodes = nodesFor(layer);
    const rec = recorder();
    const drive = { property: 'width' as const, from: { binding: 'v' }, range: [0, 400] as [number, number], grow: 'end' as const, tween: { duration: 0.5 } };
    applyDriveValue(nodes, drive, 0, 100, rec.animator, 'set');
    expect(nodes.el.style.width).toBe('100px');
    expect(nodes.el.style.marginLeft).toBe('300px');
    applyDriveValue(nodes, drive, 0, 300, rec.animator, 'tween');
    expect(rec.tos).toHaveLength(1);
    // The same target again while on its way changes nothing.
    applyDriveValue(nodes, drive, 0, 300, rec.animator, 'tween');
    expect(rec.tos).toHaveLength(1);
    rec.finish();
    expect(nodes.el.style.width).toBe('300px');
    expect(nodes.el.style.marginLeft).toBe('100px');
  });

  it('redraws an arc as its sweep is driven, and draws a path on', () => {
    const gauge = { ...createShapeLayer({ id: 'g', shape: 'ellipse', size: { width: 200, height: 200 } }), arc: { sweep: 0, thickness: 20 } };
    const nodes = nodesFor(gauge);
    expect(nodes.shapePath!.getAttribute('d')).toBe('');
    applyDriveValue(nodes, { property: 'sweep', from: { binding: 'v' }, range: [0, 360] }, 0, 90, recorder().animator, 'set');
    expect(nodes.shapePath!.getAttribute('d')).toBe('M100 10 A90 90 0 0 1 190 100');
    applyDriveValue(nodes, { property: 'trim', from: { binding: 'v' }, range: [0, 1] }, 1, 0.25, recorder().animator, 'set');
    expect(nodes.shapePath!.getAttribute('stroke-dasharray')).toBe('0.25 1');
  });

  it('a centred text of several lines centres each line', () => {
    const verse = createTextLayer({ id: 'v', text: 'One line\nand a longer second line' });
    const nodes = nodesFor({ ...verse, style: { ...verse.style, align: 'center' } });
    expect(nodes.textInner!.style.textAlign).toBe('center');
    expect(nodesFor({ ...verse, id: 'r', style: { ...verse.style, align: 'right' } }).textInner!.style.textAlign).toBe('end');
  });

  it('a rule recolours a ring arc by its stroke, not its fill', () => {
    const ring = { ...createShapeLayer({ id: 'r', shape: 'ellipse', fill: '#888888', size: { width: 200, height: 200 } }), arc: { sweep: 90, thickness: 20 } };
    const nodes = nodesFor(ring);
    applyRuleResult(nodes, { hidden: false, color: '#ff0000' }, (s) => s);
    expect(nodes.shapePath!.getAttribute('stroke')).toBe('#ff0000');
    expect(nodes.shapePath!.getAttribute('fill')).toBe('none');
    applyRuleResult(nodes, { hidden: false }, (s) => s);
    expect(nodes.shapePath!.getAttribute('stroke')).toBe('#888888');
  });

  it('a field drives a top-level bar through update()', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const bar = {
      ...createShapeLayer({ id: 'bar', size: { width: 500, height: 30 } }),
      drives: [{ property: 'width', from: { binding: 'raised' }, domain: { max: { binding: 'goal' } }, range: [0, 500] }],
    } as Layer;
    const composition: Composition = createComposition({ id: 'meter', name: 'Meter', duration: 1, layers: [bar] });
    const runtime = new BreezeRuntime({ container, composition, injectStyles: false, data: { raised: 250, goal: 1000 } });
    cleanup.push(() => runtime.destroy());
    expect(runtime.getLayerElement('bar')!.style.width).toBe('125px');
    runtime.update({ raised: 1000 });
    expect(runtime.getLayerElement('bar')!.style.width).toBe('500px');
  });

  it('bars in a table scale against the leading row', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const table = createTableLayer({ id: 'poll' }) as TableLayer;
    const bar = {
      ...createShapeLayer({ id: 'bar', size: { width: 400, height: 40 } }),
      drives: [{ property: 'width', from: { column: 'votes' }, range: [0, 400] }],
    } as Layer;
    const layer: TableLayer = {
      ...table,
      data: { columns: [{ key: 'label', type: 'string' }, { key: 'votes', type: 'number' }], rows: [{ label: 'A', votes: 10 }, { label: 'B', votes: 40 }] },
      row: { height: 50, cells: [bar] },
    };
    const composition: Composition = createComposition({ id: 'p', name: 'P', duration: 1, layers: [layer] });
    const runtime = new BreezeRuntime({ container, composition, injectStyles: false });
    cleanup.push(() => runtime.destroy());
    const widths = [...container.querySelectorAll<HTMLElement>('[data-cell="bar"]')].map((el) => el.style.width);
    expect(widths).toEqual(['100px', '400px']);
  });
});

/* ------------------------------------------------------- counts, plots */

describe('counting and plotting', () => {
  it('writes the first number straight away and counts to the next', () => {
    const inner = document.createElement('span');
    const rec = recorder();
    countTo(inner, 38, { duration: 1, suffix: '%' }, {}, rec.animator);
    expect(inner.textContent).toBe('38%');
    expect(rec.tos).toHaveLength(0);
    countTo(inner, 41, { duration: 1, suffix: '%' }, {}, rec.animator);
    expect(rec.tos).toHaveLength(1);
    expect(inner.textContent).toBe('38%');
    rec.finish();
    expect(inner.textContent).toBe('41%');
  });

  it('a bound number field counts on update()', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const layer = { ...createTextLayer({ id: 'pct', text: '0', binding: 'pct' }), count: { duration: 0, suffix: '%' } } as Layer;
    const runtime = new BreezeRuntime({ container, composition: createComposition({ id: 'c', name: 'C', duration: 1, layers: [layer] }), injectStyles: false, data: { pct: 12 } });
    cleanup.push(() => runtime.destroy());
    runtime.update({ pct: '57' });
    expect(container.querySelector('.bz-text-inner')!.textContent).toBe('57%');
  });

  it('draws a plot from its source rows', () => {
    const line = { ...createShapeLayer({ id: 'line', shape: 'path', size: { width: 100, height: 50 } }), plot: { source: 'w', y: 't' } } as Layer;
    const nodes = nodesFor(line);
    drawPlot(nodes, [{ t: 10 }, { t: 20 }, { t: 15 }], recorder().animator, false);
    expect(nodes.shapePath!.getAttribute('d')).toBe('M0 50 L50 0 L100 25');
  });

  it('a runtime draws a plot from booted data and redraws on a push', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const line = { ...createShapeLayer({ id: 'line', shape: 'path', size: { width: 100, height: 50 } }), plot: { source: 'w', y: 't' } } as Layer;
    const set = (rows: Array<{ t: number }>) => ({ $data: { w: { id: 'w', columns: [{ key: 't', type: 'number' }], rows } } });
    const runtime = new BreezeRuntime({ container, composition: createComposition({ id: 'l', name: 'L', duration: 1, layers: [line] }), injectStyles: false, data: set([{ t: 1 }, { t: 2 }]) });
    cleanup.push(() => runtime.destroy());
    const path = () => container.querySelector('path')!.getAttribute('d');
    expect(path()).toBe('M0 50 L100 0');
    runtime.update(set([{ t: 2 }, { t: 1 }]));
    expect(path()).toBe('M0 0 L100 50');
  });
});

/* ---------------------------------------------------------- table axis */

describe('tables along x', () => {
  it('steps rows across instead of down', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const table = createTableLayer({ id: 'cols' }) as TableLayer;
    const layer: TableLayer = {
      ...table,
      axis: 'x',
      size: { width: 600, height: 300 },
      data: { columns: [{ key: 'team', type: 'string' }], rows: [{ team: 'A' }, { team: 'B' }, { team: 'C' }] },
      row: { height: 100, gap: 20, cells: [createTextLayer({ id: 'name', cell: 'team', text: '' })] },
    };
    const runtime = new BreezeRuntime({ container, composition: createComposition({ id: 'x', name: 'X', duration: 1, layers: [layer] }), injectStyles: false });
    cleanup.push(() => runtime.destroy());
    const rows = [...container.querySelectorAll<HTMLElement>('.bz-table-row')];
    expect(rows.map((r) => r.style.width)).toEqual(['100px', '100px', '100px']);
    expect(rows.map((r) => [gsap.getProperty(r, 'x'), gsap.getProperty(r, 'y')])).toEqual([[0, 0], [120, 0], [240, 0]]);
  });
});

/* ------------------------------------------------------ runtime rolls */

describe('a roll in a runtime', () => {
  it('takes the hub scroll state and reports its scroll', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const roll = { ...createRollLayer(), id: 'credits', scrollId: 'credits' } as Layer;
    const runtime = new BreezeRuntime({ container, composition: createComposition({ id: 'r', name: 'R', duration: 1, layers: [roll] }), injectStyles: false });
    cleanup.push(() => runtime.destroy());
    expect(runtime.scrollIds).toEqual(['credits']);
    const seen = vi.fn();
    runtime.on('scroll', seen);
    runtime.update({ [SCROLLS_UPDATE_KEY]: { clock: Date.now(), scrolls: { credits: applyScrollAction(undefined, 'play', Date.now()) } } });
    expect(seen).toHaveBeenCalled();
    expect(runtime.scrollStates[0]).toMatchObject({ id: 'credits', running: true, rate: 1, start: 'play', end: 'hold' });
  });
});
