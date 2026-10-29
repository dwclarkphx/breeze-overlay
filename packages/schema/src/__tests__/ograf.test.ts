// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * OGraf interop (Phase 9 Wave D): ids, the step rule, the GDD data schema and
 * the manifest — the last checked against the EBU's own JSON Schemas for
 * OGraf v1, vendored under `fixtures/ograf-v1` (MIT, see the README there),
 * for every composition in the shipped examples as well as a hand-built one
 * carrying every field kind.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { bindingsJsonSchema } from '../bindings.js';
import { createComposition, createTableLayer, createTextLayer } from '../factory.js';
import {
  OGRAF_MANIFEST_SCHEMA,
  ografActionDurations,
  ografCurrentStep,
  ografCustomActions,
  ografDataSchema,
  ografGraphicId,
  ografManifest,
  ografStepCount,
  ografTargetStep,
  parseOgrafGraphicId,
} from '../ograf.js';
import { pagedTables } from '../paging.js';
import { collectTimers } from '../timer.js';
import type { Composition, Project } from '../types.js';

const here = import.meta.dirname;
const fixtures = path.join(here, 'fixtures', 'ograf-v1');

/** The OGraf manifest validator, built from the vendored schemas — no network. */
function manifestValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) ajv.addSchema(JSON.parse(readFileSync(full, 'utf8')));
    }
  };
  walk(fixtures);
  const validate = ajv.getSchema(OGRAF_MANIFEST_SCHEMA);
  if (!validate) throw new Error('OGraf manifest schema missing from fixtures');
  return (manifest: unknown): string[] =>
    validate(manifest) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message} ${JSON.stringify(e.params)}`);
}

const validateManifest = manifestValidator();

function manifestFor(comp: Composition, all: Composition[] = [comp]) {
  const byId = new Map(all.map((c) => [c.id, c]));
  const resolve = (id: string) => byId.get(id);
  return ografManifest({
    projectId: 'demo-1iixd',
    projectName: 'Demo',
    composition: comp,
    version: '2026-10-26T10:00:00.000Z',
    server: 'http://10.0.0.5:7331',
    dataSchema: bindingsJsonSchema(comp, resolve),
    tables: pagedTables(comp, resolve),
    timers: collectTimers(comp.layers, resolve).length > 0,
    main: 'graphic.mjs',
  });
}

/** A composition carrying every kind of field the schema can describe. */
function everything(): Composition {
  return {
    ...createComposition({
      id: 'everything',
      name: 'Everything',
      duration: 6,
      markers: [
        { type: 'stop', time: 2 },
        { type: 'cue', time: 2.5 },
        { type: 'stop', time: 3.5 },
      ],
      layers: [
        { ...createTextLayer({ id: 'name', text: 'Jane Doe' }), binding: 'name' },
        { ...createTextLayer({ id: 'score', text: '0' }), binding: 'homeScore', colorBinding: 'teamColour' },
        { ...createTextLayer({ id: 'per', text: '1st' }), binding: 'period' },
        { ...createTextLayer({ id: 'clock', text: '12:00' }), timer: { mode: 'countdown', duration: 720 } },
        { ...createTableLayer({ id: 'standings', rowsPerPage: 2 }), binding: 'standings' },
        {
          id: 'ticker',
          type: 'crawl',
          name: 'Ticker',
          binding: 'headlines',
          items: ['One', 'Two'],
          size: { width: 1920, height: 60 },
          transform: { x: 0, y: 1000 },
          opacity: 1,
        },
      ] as Composition['layers'],
    }),
    fields: {
      homeScore: { kind: 'number', min: 0, max: 199, buttons: [1, 2, 3] },
      period: { kind: 'enum', options: [{ value: '1', label: '1st' }, { value: '2', label: '2nd' }, { value: 'OT' }] },
      teamColour: { kind: 'color', default: '#C8102E' },
      bonus: { kind: 'boolean', label: 'Bonus' },
      logo: { kind: 'asset', assetKind: 'image' },
    },
  };
}

describe('graphic ids', () => {
  it('joins and splits on ~, which no key alphabet contains', () => {
    const id = ografGraphicId('demo-1iixd', 'l3rd-name-2a94g');
    expect(id).toBe('demo-1iixd~l3rd-name-2a94g');
    expect(parseOgrafGraphicId(id)).toEqual({ project: 'demo-1iixd', composition: 'l3rd-name-2a94g' });
    // Legacy ids may carry dots and underscores; the split does not care.
    expect(parseOgrafGraphicId('old.project~my_comp.v2')).toEqual({ project: 'old.project', composition: 'my_comp.v2' });
  });

  it('refuses what is not one of ours', () => {
    for (const bad of ['', 'demo', '~comp', 'demo~', 'a~b~c', 'a/b~c', 'a~b/c']) expect(parseOgrafGraphicId(bad)).toBeNull();
  });
});

describe('steps', () => {
  it('counts STOP markers only, and a marker-less graphic has none', () => {
    expect(ografStepCount(everything())).toBe(2);
    expect(ografStepCount({ markers: [] })).toBe(0);
    expect(ografStepCount({})).toBe(0);
  });

  it('applies the specification’s target-step table', () => {
    // Every row of the table in the Graphics specification, §playAction.
    const rows: Array<[number | undefined, number, number | undefined, number | undefined, number | undefined]> = [
      [undefined, 1, undefined, undefined, 0],
      [undefined, 1, 0, undefined, 0],
      [undefined, 1, undefined, 1, 0],
      [undefined, 2, 1, 2, 1],
      [0, 2, 1, undefined, 1],
      [0, 3, undefined, 2, 2],
      [2, 3, 1, undefined, 1],
      [2, 3, undefined, -2, 0],
      [0, 1, undefined, 1, undefined],
    ];
    for (const [current, stepCount, goto, delta, expected] of rows) {
      expect(ografTargetStep({ current, stepCount, goto, delta }), JSON.stringify({ current, stepCount, goto, delta })).toBe(expected);
    }
  });

  it('clamps a step before the first to the first, and ignores junk', () => {
    expect(ografTargetStep({ current: 0, stepCount: 3, delta: -5 })).toBe(0);
    expect(ografTargetStep({ current: undefined, stepCount: 3, goto: -1, delta: 2 })).toBe(1);
    expect(ografTargetStep({ current: undefined, stepCount: 3, goto: '2', delta: 'x' })).toBe(0);
  });

  it('reads a Breeze playback report as an OGraf step', () => {
    expect(ografCurrentStep({ state: 'holding', step: 1 }, 2)).toBe(0);
    expect(ografCurrentStep({ state: 'holding', step: 2 }, 2)).toBe(1);
    expect(ografCurrentStep({ state: 'playing-in', step: 0 }, 2)).toBe(0);
    expect(ografCurrentStep({ state: 'playing-in', step: 1 }, 2)).toBe(1);
    for (const state of ['idle', 'finished', 'playing-out']) expect(ografCurrentStep({ state, step: 1 }, 2)).toBeUndefined();
    expect(ografCurrentStep(null, 2)).toBeUndefined();
    expect(ografCurrentStep({ state: 'holding', step: 1 }, 0)).toBeUndefined();
  });
});

describe('the data schema in GDD', () => {
  const schema = ografDataSchema(bindingsJsonSchema(everything()));
  const props = schema['properties'] as Record<string, Record<string, unknown>>;

  it('turns options into a GDD select with labels', () => {
    expect(props['period']).toMatchObject({
      type: 'string',
      enum: ['1', '2', 'OT'],
      gddType: 'select',
      gddOptions: { labels: { '1': '1st', '2': '2nd', OT: 'OT' } },
    });
    expect(props['period']!['oneOf']).toBeUndefined();
  });

  it('turns a colour into color-rrggbb with a default its pattern accepts', () => {
    expect(props['teamColour']).toMatchObject({ gddType: 'color-rrggbb', pattern: '^#[0-9a-f]{6}$', default: '#c8102e' });
  });

  it('keeps Breeze’s field order and its own keywords', () => {
    const orders = Object.values(props).map((p) => p['order']);
    expect(orders).toEqual(orders.map((_, i) => i));
    expect(props['homeScore']).toMatchObject({ type: 'number', minimum: 0, maximum: 199, 'x-breeze-buttons': [1, 2, 3] });
  });

  it('gives a dataset’s nested nodes the types GDD insists on', () => {
    const table = props['standings']!;
    const columns = (table['properties'] as Record<string, Record<string, unknown>>)['columns']!;
    const column = (columns['items'] as Record<string, unknown>)['properties'] as Record<string, Record<string, unknown>>;
    expect(column['type']).toMatchObject({ type: 'string', enum: ['string', 'number', 'boolean', 'date'] });
    const rows = (table['properties'] as Record<string, Record<string, unknown>>)['rows']!;
    expect(rows['items']).toEqual({ type: 'object', properties: {} });
  });

  it('drops a default of the wrong type rather than ship it', () => {
    const out = ografDataSchema({ properties: { a: { type: 'string', default: null }, b: { type: 'number', default: '3' } } });
    const p = out['properties'] as Record<string, Record<string, unknown>>;
    expect('default' in p['a']!).toBe(false);
    expect('default' in p['b']!).toBe(false);
  });
});

describe('custom actions', () => {
  it('offers only what applies', () => {
    expect(ografCustomActions({ tables: [], timers: false })).toEqual([]);
    expect(ografCustomActions({ tables: [{ cycle: false }], timers: false }).map((a) => a.id)).toEqual(['next', 'prev', 'page']);
    expect(ografCustomActions({ tables: [{ cycle: true }], timers: true }).map((a) => a.id)).toEqual([
      'next',
      'prev',
      'page',
      'cycle',
      'timer',
    ]);
  });
});

describe('action durations', () => {
  it('times the intro to each hold and the outro when the length is stated', () => {
    expect(ografActionDurations(everything())).toEqual([
      { type: 'playAction', duration: 2000, steps: [{ step: 0, duration: 2000 }, { step: 1, duration: 1500 }] },
      { type: 'stopAction', duration: 2500 },
      { type: 'updateAction', duration: 0 },
    ]);
  });

  it('says nothing it does not know', () => {
    expect(ografActionDurations({ markers: [{ type: 'stop', time: 1 }] })).toEqual([
      { type: 'playAction', duration: 1000 },
      { type: 'updateAction', duration: 0 },
    ]);
    expect(ografActionDurations({ duration: 4 })).toEqual([
      { type: 'playAction', duration: 4000 },
      { type: 'updateAction', duration: 0 },
    ]);
  });
});

describe('the manifest', () => {
  it('is a valid OGraf v1 manifest for a graphic with every field kind', () => {
    const manifest = manifestFor(everything());
    expect(validateManifest(manifest)).toEqual([]);
    expect(manifest).toMatchObject({
      $schema: OGRAF_MANIFEST_SCHEMA,
      id: 'demo-1iixd~everything',
      name: 'Everything',
      main: 'graphic.mjs',
      supportsRealTime: true,
      supportsNonRealTime: false,
      stepCount: 2,
      v_breeze: { kind: 'pointer', server: 'http://10.0.0.5:7331', project: 'demo-1iixd', composition: 'everything' },
    });
    expect((manifest['customActions'] as Array<{ id: string }>).map((a) => a.id)).toEqual(['next', 'prev', 'page', 'timer']);
  });

  it('is valid for every composition in the shipped examples', () => {
    const examples = path.resolve(here, '../../../../examples');
    let checked = 0;
    for (const file of ['breeze-demo.json', 'world-cup-bracket.json', 'world-cup-scene.json']) {
      const project = JSON.parse(readFileSync(path.join(examples, file), 'utf8')) as Project;
      for (const comp of project.compositions) {
        const errors = validateManifest(manifestFor(comp, project.compositions));
        expect(errors, `${file} / ${comp.id}`).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('rejects what the specification rejects — the validator is not a rubber stamp', () => {
    const manifest = manifestFor(everything());
    expect(validateManifest({ ...manifest, rogue: true })).not.toEqual([]);
    expect(validateManifest({ ...manifest, $schema: 'https://example.com' })).not.toEqual([]);
    const badColour = structuredClone(manifest) as { schema: { properties: Record<string, Record<string, unknown>> } };
    badColour.schema.properties['teamColour']!['pattern'] = '^#.*$';
    expect(validateManifest(badColour)).not.toEqual([]);
  });
});
