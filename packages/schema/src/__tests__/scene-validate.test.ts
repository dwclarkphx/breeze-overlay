// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import { createComposition, createProject } from '../factory.js';
import type { Composition, Layer } from '../types.js';
import { validateComposition, validateProject } from '../validate.js';

const element = (id: string, ref: string, extra: Record<string, unknown> = {}): Layer =>
  ({ id, type: 'composition', ref, independent: true, ...extra }) as Layer;

const scene = (layers: Layer[]): Composition => createComposition({ id: 'scene', layers });

const messages = (comp: Composition): string[] =>
  validateComposition(comp).errors.map((e) => e.message);

describe('independent composition layers', () => {
  it('accepts a plain scene', () => {
    const result = validateComposition(scene([element('e1', 'bug'), element('e2', 'lt')]));
    expect(result.valid).toBe(true);
  });

  it('accepts an independent layer with a transform', () => {
    // Position stays legal: it is how a full-frame bug gets nudged without
    // editing the bug composition itself.
    const result = validateComposition(
      scene([element('e1', 'bug', { transform: { x: 40, y: -12 } })]),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects keyframes on an independent layer', () => {
    const errs = messages(scene([element('e1', 'bug', { keyframes: { x: [{ t: 0, v: 0 }] } })]));
    expect(errs.some((m) => m.includes('cannot carry keyframes'))).toBe(true);
  });

  it('rejects in/out on an independent layer', () => {
    expect(messages(scene([element('e1', 'bug', { in: 2 })])).some((m) => m.includes('`in`/`out`'))).toBe(true);
    expect(messages(scene([element('e1', 'bug', { out: 9 })])).some((m) => m.includes('`in`/`out`'))).toBe(true);
  });

  it('still allows keyframes and in/out on a flattened composition layer', () => {
    const comp = scene([
      { id: 'badge', type: 'composition', ref: 'badge', in: 1, keyframes: { x: [{ t: 0, v: 0 }] } } as Layer,
    ]);
    expect(validateComposition(comp).valid).toBe(true);
  });

  it('rejects a channel without independent', () => {
    const comp = scene([{ id: 'b', type: 'composition', ref: 'badge', channel: 'bug' } as Layer]);
    expect(messages(comp).some((m) => m.includes('requires `independent: true`'))).toBe(true);
  });

  it('rejects a channel that is not a valid URL key', () => {
    for (const bad of ['Bug', 'a b', 'a/b', '-bug', 'abcdefghijklm']) {
      const errs = messages(scene([element('e1', 'bug', { channel: bad })]));
      expect(errs.some((m) => m.includes('not a valid URL key')), bad).toBe(true);
    }
  });

  it('rejects two elements sharing a channel', () => {
    // The whole reason `channel` exists: two copies of one composition would
    // otherwise both answer every trigger, and nothing says so until air.
    const errs = messages(scene([element('e1', 'badge'), element('e2', 'badge')]));
    expect(errs.some((m) => m.includes('is already used by'))).toBe(true);
  });

  it('accepts two instances of one composition once they are distinguished', () => {
    const comp = scene([
      element('e1', 'badge', { channel: 'badge-home' }),
      element('e2', 'badge', { channel: 'badge-away' }),
    ]);
    expect(validateComposition(comp).valid).toBe(true);
  });

  it('catches a clash between an explicit channel and another element default', () => {
    const comp = scene([element('e1', 'bug'), element('e2', 'weather', { channel: 'bug' })]);
    expect(messages(comp).some((m) => m.includes('is already used by'))).toBe(true);
  });
});

describe('id patterns', () => {
  it('accepts ids generated before the hyphenated format existed', () => {
    // This is the whole point of validating against the legacy pattern:
    // assertValidProject runs on every read, so a stricter pattern here would
    // make existing projects unopenable rather than merely un-creatable.
    expect(validateComposition(createComposition({ id: 'comp1a2b' })).valid).toBe(true);
    expect(validateProject(createProject({ id: 'proj1k3f9', compositions: [] })).valid).toBe(true);
  });

  it('accepts the new hyphenated format', () => {
    expect(validateComposition(createComposition({ id: 'bug-1a2b' })).valid).toBe(true);
    expect(validateProject(createProject({ id: 'rah-b-1k3f9', compositions: [] })).valid).toBe(true);
  });

  it('rejects ids that could escape the data directory', () => {
    // The pattern is anchored for exactly this reason.
    for (const bad of ['../evil', 'a/b', '', ' lead']) {
      expect(validateComposition(createComposition({ id: bad })).valid, bad).toBe(false);
    }
  });
});
