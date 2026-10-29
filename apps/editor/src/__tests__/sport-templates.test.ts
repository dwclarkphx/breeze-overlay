// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The sport-template creator's source definitions (Phase 9 Wave B): every feed
 * kind makes a definition the server will save, carrying its template.
 */

import { describe, expect, it } from 'vitest';
import { SPORT_TABLES } from '@breeze/schema';
// Tests are tooling, so they may import the validator.
import { validateDataSources } from '@breeze/schema/validate';

import { sportSourceDef, type SportFeed } from '../components/SportTemplates.js';
import { applyCommand } from '../state/commands.js';
import { createComposition } from '@breeze/schema';

describe('sportSourceDef', () => {
  const where: Record<SportFeed, string> = {
    manual: '',
    sheets: '1AbCdEfGh',
    'http-csv': 'https://example.com/teams.csv',
    'http-json': 'https://example.com/teams.json',
  };

  for (const feed of Object.keys(where) as SportFeed[]) {
    it(`makes a valid ${feed} source for every table`, () => {
      const sources = SPORT_TABLES.map((table) =>
        sportSourceDef({ sport: 'tennis', ruleset: 'best-of-5', table }, feed, `ten-${table}`, `Tennis ${table}`, where[feed]),
      );
      const result = validateDataSources({ formatVersion: 1, sources });
      expect(result.errors).toEqual([]);
      for (const def of sources) expect(def.template?.sport).toBe('tennis');
    });
  }

  it('gives each Sheets table its own tab', () => {
    const def = sportSourceDef({ sport: 'basketball', ruleset: 'nba', table: 'players' }, 'sheets', 'b-players', 'B', 'sheet');
    expect(def).toMatchObject({ type: 'sheets', spreadsheet: 'sheet', range: 'players' });
  });
});

describe('setField', () => {
  const comp = createComposition({ id: 'c', name: 'C', duration: 1, layers: [] });

  it('declares, changes and removes a typed field, dropping an empty map', () => {
    const one = applyCommand(comp, { kind: 'setField', name: 'score', spec: { kind: 'number', buttons: [1, 2, 3] } });
    expect(one.fields).toEqual({ score: { kind: 'number', buttons: [1, 2, 3] } });
    expect(applyCommand(one, { kind: 'setField', name: 'score', spec: { kind: 'number', buttons: [1, 2, 3] } })).toBe(one);
    const gone = applyCommand(one, { kind: 'setField', name: 'score' });
    expect('fields' in gone).toBe(false);
  });
});
