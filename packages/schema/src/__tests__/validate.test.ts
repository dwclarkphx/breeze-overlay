// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { bindingsJsonSchema, collectBindings, collectSources, stepCount } from '../bindings.js';
import { createComposition, createShapeLayer, createTextLayer } from '../factory.js';
import { compositionDuration, validateComposition, validateProject } from '../validate.js';
import type { Composition, Project } from '../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const examplePath = path.resolve(here, '../../../../examples/lower-third.json');
const example = JSON.parse(readFileSync(examplePath, 'utf8')) as Project;

// Look compositions up by id, not array position — adding one to the example
// project should not silently repoint an unrelated test at a different graphic.
const exampleComp = (id: string): Composition => {
  const found = example.compositions.find((c) => c.id === id);
  if (!found) throw new Error(`example project has no composition "${id}"`);
  return found;
};

describe('project validation', () => {
  it('accepts the shipped example project', () => {
    const result = validateProject(example);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects an unknown layer property', () => {
    const comp = createComposition({
      layers: [{ ...createShapeLayer(), bogus: true } as never],
    });
    expect(validateComposition(comp).valid).toBe(false);
  });

  it('rejects a wrong formatVersion', () => {
    const comp = { ...createComposition(), formatVersion: 2 };
    expect(validateComposition(comp).valid).toBe(false);
  });

  it('rejects duplicate layer ids', () => {
    const a = createShapeLayer({ id: 'dup' });
    const b = createShapeLayer({ id: 'dup' });
    const result = validateComposition(createComposition({ layers: [a, b] }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toMatch(/duplicate layer id/);
  });

  it('rejects out-of-order keyframes', () => {
    const layer = createShapeLayer({
      keyframes: { x: [{ t: 1, v: 0 }, { t: 0.5, v: 100 }] },
    });
    const result = validateComposition(createComposition({ layers: [layer] }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toMatch(/sorted by time/);
  });

  it('rejects a marker past the end of the composition', () => {
    const layer = createShapeLayer({ keyframes: { x: [{ t: 0, v: 0 }, { t: 1, v: 100 }] } });
    const comp = createComposition({ layers: [layer], markers: [{ type: 'stop', time: 9 }] });
    const result = validateComposition(comp);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toMatch(/past the composition duration/);
  });

  it('rejects a self-referencing nested composition', () => {
    const project: Project = {
      formatVersion: 1,
      id: 'p',
      name: 'p',
      createdAt: '',
      updatedAt: '',
      compositions: [
        createComposition({
          id: 'a',
          layers: [{ id: 'nest', type: 'composition', ref: 'a' }],
        }),
      ],
    };
    const result = validateProject(project);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /cannot reference itself/.test(e.message))).toBe(true);
  });
});

describe('factories', () => {
  it('carries mask, effects and in/out through instead of dropping them', () => {
    // Editors clone layers through these; a lossy factory loses work silently.
    const layer = createShapeLayer({
      mask: { type: 'rect', x: 0, y: 0, width: 10, height: 10, feather: 4 },
      effects: { blur: 3 },
      in: 0.5,
      out: 2,
      blendMode: 'screen',
      visible: false,
    });

    expect(layer.mask).toMatchObject({ feather: 4 });
    expect(layer.effects).toEqual({ blur: 3 });
    expect(layer.in).toBe(0.5);
    expect(layer.out).toBe(2);
    expect(layer.blendMode).toBe('screen');
    expect(layer.visible).toBe(false);
  });

  it('produces layers that pass schema validation', () => {
    const comp = createComposition({
      layers: [createShapeLayer({ mask: { type: 'ellipse', x: 0, y: 0, width: 8, height: 8 } })],
    });
    expect(validateComposition(comp).errors).toEqual([]);
  });
});

describe('duration', () => {
  it('derives duration from the latest keyframe', () => {
    const layer = createShapeLayer({ keyframes: { x: [{ t: 0, v: 0 }, { t: 3.25, v: 1 }] } });
    expect(compositionDuration(createComposition({ layers: [layer] }))).toBe(3.25);
  });

  it('ignores markers when deriving duration', () => {
    // A marker past the last keyframe is an error, not a reason to extend the
    // composition — otherwise the outro would have nowhere to play.
    const layer = createShapeLayer({ keyframes: { x: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } });
    const comp = createComposition({ layers: [layer], markers: [{ type: 'cue', time: 2 }] });
    expect(compositionDuration(comp)).toBe(1);
  });
});

describe('bindings', () => {
  const lowerThird = exampleComp('l3rd-name');

  it('collects every bound layer', () => {
    const names = collectBindings(lowerThird).map((b) => b.name).sort();
    expect(names).toEqual(['name', 'title']);
  });

  it('uses authored text as the form default', () => {
    const nameBinding = collectBindings(lowerThird).find((b) => b.name === 'name');
    expect(nameBinding?.defaultValue).toBe('JANE DOE');
    expect(nameBinding?.kind).toBe('string');
  });

  it('merges layers that share a binding name', () => {
    const comp = createComposition({
      layers: [
        createTextLayer({ id: 't1', binding: 'shared', text: 'a' }),
        createTextLayer({ id: 't2', binding: 'shared', text: 'b' }),
      ],
    });
    const bindings = collectBindings(comp);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.layerIds).toEqual(['t1', 't2']);
  });

  it('types a crawl binding as a string list', () => {
    const ticker = exampleComp('ticker');
    const schema = bindingsJsonSchema(ticker) as { properties: Record<string, { type: string }> };
    expect(schema.properties['headlines']!.type).toBe('array');
  });

  it('counts one step per stop marker, not per marker plus outro', () => {
    // The lower third has a single STOP marker, so exactly one holdable state.
    expect(stepCount(lowerThird)).toBe(1);
  });

  it('counts each additional stop marker as another step', () => {
    const comp = createComposition({
      layers: [createShapeLayer({ keyframes: { x: [{ t: 0, v: 0 }, { t: 3, v: 1 }] } })],
      markers: [
        { type: 'stop', time: 0.8 },
        { type: 'stop', time: 1.6 },
        { type: 'stop', time: 2.4 },
      ],
    });
    expect(stepCount(comp)).toBe(3);
  });

  it('ignores cue markers, which are labels rather than holds', () => {
    const comp = createComposition({
      layers: [createShapeLayer({ keyframes: { x: [{ t: 0, v: 0 }, { t: 2, v: 1 }] } })],
      markers: [
        { type: 'stop', time: 0.5 },
        { type: 'cue', time: 1 },
      ],
    });
    expect(stepCount(comp)).toBe(1);
  });

  it('treats a straight-through graphic as a single step', () => {
    const comp = createComposition({
      layers: [createShapeLayer({ keyframes: { x: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } })],
    });
    expect(stepCount(comp)).toBe(1);
  });
});

describe('clock layers', () => {
  const clockComp = (clock: unknown, extra: Record<string, unknown> = {}): Composition =>
    createComposition({
      layers: [
        createShapeLayer({ id: 'bg', keyframes: { x: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } }),
        { ...createTextLayer({ id: 'time', text: '6:42 PM' }), clock, ...extra } as never,
      ],
    });

  it('accepts a clock with a token format', () => {
    expect(validateComposition(clockComp({ format: 'h:mm A' })).valid).toBe(true);
    expect(
      validateComposition(clockComp({ format: 'HH:mm:ss', timezone: 'America/Phoenix' })).valid,
    ).toBe(true);
    expect(validateComposition(clockComp({ format: 'ddd D MMM', tickSeconds: 30 })).valid).toBe(
      true,
    );
  });

  it('rejects a clock and a binding on the same layer', () => {
    // Both would be writing the same node; the clock wins within the second,
    // so the operator's field is an input that visibly does nothing.
    const result = validateComposition(clockComp({ format: 'h:mm A' }, { binding: 'time' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /both `clock` and `binding`/.test(e.message))).toBe(true);
  });

  it('rejects a format with no recognized token', () => {
    /*
     * A tokenless format renders as its own literal text and never changes,
     * which on air is indistinguishable from a clock that failed to start.
     * Caught on save, where the author is looking.
     */
    const result = validateComposition(clockComp({ format: 'oclock' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /no recognized token/.test(e.message))).toBe(true);
  });

  it('rejects an unknown time zone', () => {
    const result = validateComposition(clockComp({ format: 'h:mm A', timezone: 'Mars/Olympus' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /unknown IANA time zone/.test(e.message))).toBe(true);
  });

  it('rejects a misspelled clock property rather than ignoring it', () => {
    expect(validateComposition(clockComp({ fmt: 'h:mm A' })).valid).toBe(false);
  });

  it('keeps a clock layer out of the operator field list', () => {
    // A clock is not an operator field. It has no binding, so it must not
    // appear on the control panel as something to type into.
    expect(collectBindings(clockComp({ format: 'h:mm A' }))).toEqual([]);
  });
});

describe('source collection', () => {
  it('finds a source on a layer that carries no binding', () => {
    // The screen bug's weather table is exactly this shape, deliberately: no
    // binding means nothing can push a placeholder over the live value.
    const sources = collectSources(exampleComp('screen-bug'));
    expect(sources).toEqual([
      expect.objectContaining({ id: 'wx-current', kind: 'dataset' }),
    ]);
    expect(collectBindings(exampleComp('screen-bug'))).toEqual([]);
  });

  it('reports the column a crawl reads', () => {
    expect(collectSources(exampleComp('news-ticker'))).toEqual([
      expect.objectContaining({ id: 'headlines', kind: 'stringList', column: 'title' }),
    ]);
  });

  it('reports nothing for a composition that reads no source', () => {
    expect(collectSources(exampleComp('l3rd-name'))).toEqual([]);
  });
});
