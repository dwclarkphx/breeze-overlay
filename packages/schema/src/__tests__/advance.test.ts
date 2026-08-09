// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * `{ op: 'advance' }` — bracket resolution.
 *
 * The rule this suite exists to hold: an undecided match advances nobody. Half
 * a bracket is unplayed for most of a tournament, and a transform that guesses
 * puts the wrong nation in a semi-final on air. Every "does not advance" case
 * below is load-bearing.
 */

import { describe, expect, it } from 'vitest';

import { applyTransforms, type DataRow, type DataSet } from '../data.js';
import type { Composition, TableLayer } from '../types.js';
import { validateCompositionSemantics } from '../validate.js';

const columns: DataSet['columns'] = [
  { key: 'slot', type: 'string' },
  { key: 'round', type: 'string' },
  { key: 'homeTeam', type: 'string' },
  { key: 'awayTeam', type: 'string' },
  { key: 'homeScore', type: 'number' },
  { key: 'awayScore', type: 'number' },
  { key: 'winner', type: 'string' },
];

const bracket = (rows: DataRow[]): DataSet => ({ id: 'b', columns, rows });

/** slot → [home, away], which is the only thing any of these assert about. */
const sides = (d: DataSet): Record<string, [unknown, unknown]> =>
  Object.fromEntries(d.rows.map((r) => [String(r.slot), [r.homeTeam ?? null, r.awayTeam ?? null]]));

describe('advance — implied topology', () => {
  it('sends position p of a round to position floor(p/2) of the next', () => {
    const out = applyTransforms(
      bracket([
        { slot: 'SF1', round: 'SF', homeTeam: 'Spain', awayTeam: 'France', winner: 'Spain' },
        { slot: 'SF2', round: 'SF', homeTeam: 'England', awayTeam: 'Argentina', winner: 'Argentina' },
        { slot: 'F', round: 'F' },
      ]),
      [{ op: 'advance' }],
    );
    expect(sides(out).F).toEqual(['Spain', 'Argentina']);
  });

  it('needs no configuration at all for an ordinary bracket', () => {
    const out = applyTransforms(
      bracket([
        { slot: 'Q1', round: 'QF', homeTeam: 'A', awayTeam: 'B', winner: 'A' },
        { slot: 'Q2', round: 'QF', homeTeam: 'C', awayTeam: 'D', winner: 'D' },
        { slot: 'Q3', round: 'QF', homeTeam: 'E', awayTeam: 'F', winner: 'F' },
        { slot: 'Q4', round: 'QF', homeTeam: 'G', awayTeam: 'H', winner: 'G' },
        { slot: 'S1', round: 'SF' },
        { slot: 'S2', round: 'SF' },
        { slot: 'FN', round: 'F' },
      ]),
      [{ op: 'advance' }],
    );
    const s = sides(out);
    expect(s.S1).toEqual(['A', 'D']);
    expect(s.S2).toEqual(['F', 'G']);
    expect(s.FN).toEqual([null, null]);
  });

  it('leaves later rounds blank while earlier ones are still being played', () => {
    const out = applyTransforms(
      bracket([
        { slot: 'Q1', round: 'QF', homeTeam: 'A', awayTeam: 'B', winner: 'A' },
        { slot: 'Q2', round: 'QF', homeTeam: 'C', awayTeam: 'D', winner: null },
        { slot: 'S1', round: 'SF' },
      ]),
      [{ op: 'advance' }],
    );
    expect(sides(out).S1).toEqual(['A', null]);
  });
});

describe('advance — deciding a winner', () => {
  it('accepts the literal side, in any case', () => {
    const out = applyTransforms(
      bracket([
        { slot: 'SF1', round: 'SF', homeTeam: 'Spain', awayTeam: 'France', winner: 'away' },
        { slot: 'SF2', round: 'SF', homeTeam: 'England', awayTeam: 'Argentina', winner: 'HOME' },
        { slot: 'F', round: 'F' },
      ]),
      [{ op: 'advance' }],
    );
    expect(sides(out).F).toEqual(['France', 'England']);
  });

  it('accepts the team name, which is what an operator actually types', () => {
    const out = applyTransforms(
      bracket([
        { slot: 'SF1', round: 'SF', homeTeam: 'Spain', awayTeam: 'France', winner: 'France' },
        { slot: 'F', round: 'F' },
      ]),
      [{ op: 'advance' }],
    );
    expect(sides(out).F[0]).toBe('France');
  });

  it('refuses to guess when the named winner matches neither side', () => {
    const out = applyTransforms(
      bracket([
        { slot: 'SF1', round: 'SF', homeTeam: 'Spain', awayTeam: 'France', winner: 'Portugal' },
        { slot: 'F', round: 'F' },
      ]),
      [{ op: 'advance' }],
    );
    expect(sides(out).F).toEqual([null, null]);
  });

  it('falls back to scores only when no winner is named', () => {
    const out = applyTransforms(
      bracket([
        { slot: 'SF1', round: 'SF', homeTeam: 'Spain', awayTeam: 'France', homeScore: 0, awayScore: 2 },
        { slot: 'F', round: 'F' },
      ]),
      [{ op: 'advance', scores: { home: 'homeScore', away: 'awayScore' } }],
    );
    expect(sides(out).F[0]).toBe('France');
  });

  it('treats a draw as undecided rather than picking the home side', () => {
    const out = applyTransforms(
      bracket([
        { slot: 'SF1', round: 'SF', homeTeam: 'Spain', awayTeam: 'France', homeScore: 1, awayScore: 1 },
        { slot: 'F', round: 'F' },
      ]),
      [{ op: 'advance', scores: { home: 'homeScore', away: 'awayScore' } }],
    );
    expect(sides(out).F).toEqual([null, null]);
  });

  it('lets a shoot-out settle a draw', () => {
    const out = applyTransforms(
      {
        id: 'b',
        columns: [...columns, { key: 'homePens', type: 'number' }, { key: 'awayPens', type: 'number' }],
        rows: [
          {
            slot: 'SF1', round: 'SF', homeTeam: 'Spain', awayTeam: 'France',
            homeScore: 1, awayScore: 1, homePens: 4, awayPens: 3,
          },
          { slot: 'F', round: 'F' },
        ],
      },
      [
        {
          op: 'advance',
          scores: {
            home: 'homeScore',
            away: 'awayScore',
            shootout: { home: 'homePens', away: 'awayPens' },
          },
        },
      ],
    );
    expect(sides(out).F[0]).toBe('Spain');
  });

  it('ignores a level shoot-out and falls through to the score', () => {
    const out = applyTransforms(
      {
        id: 'b',
        columns: [...columns, { key: 'homePens', type: 'number' }, { key: 'awayPens', type: 'number' }],
        rows: [
          {
            slot: 'SF1', round: 'SF', homeTeam: 'Spain', awayTeam: 'France',
            homeScore: 3, awayScore: 1, homePens: 0, awayPens: 0,
          },
          { slot: 'F', round: 'F' },
        ],
      },
      [
        {
          op: 'advance',
          scores: {
            home: 'homeScore',
            away: 'awayScore',
            shootout: { home: 'homePens', away: 'awayPens' },
          },
        },
      ],
    );
    expect(sides(out).F[0]).toBe('Spain');
  });
});

describe('advance — explicit routing', () => {
  it('overrides the implied route', () => {
    const out = applyTransforms(
      bracket([
        { slot: 'A', round: 'R1', homeTeam: 'X', awayTeam: 'Y', winner: 'X', feeds: 'F:away' },
        { slot: 'B', round: 'R1', homeTeam: 'P', awayTeam: 'Q', winner: 'Q', feeds: 'F:home' },
        { slot: 'F', round: 'R2' },
      ]),
      [{ op: 'advance' }],
    );
    expect(sides(out).F).toEqual(['Q', 'X']);
  });

  it('fills a third-place play-off from the losers', () => {
    // Both deciders sit in one round, so the implied route would collide on
    // position 0. The play-off is exactly the case a pure tree cannot express.
    const out = applyTransforms(
      bracket([
        {
          slot: 'SF1', round: 'SF', homeTeam: 'Spain', awayTeam: 'France',
          winner: 'Spain', feeds: 'F:home', feedsLoser: '3RD:home',
        },
        {
          slot: 'SF2', round: 'SF', homeTeam: 'England', awayTeam: 'Argentina',
          winner: 'Argentina', feeds: 'F:away', feedsLoser: '3RD:away',
        },
        { slot: '3RD', round: 'DECIDER' },
        { slot: 'F', round: 'DECIDER' },
      ]),
      [{ op: 'advance' }],
    );
    expect(sides(out)['3RD']).toEqual(['France', 'England']);
    expect(sides(out).F).toEqual(['Spain', 'Argentina']);
  });

  it('drops a route that points backwards instead of looping over it', () => {
    const out = applyTransforms(
      bracket([
        { slot: 'A', round: 'R1', homeTeam: 'X', awayTeam: 'Y', winner: 'X' },
        { slot: 'B', round: 'R2', homeTeam: 'P', awayTeam: 'Q', winner: 'P', feeds: 'A:home' },
      ]),
      [{ op: 'advance' }],
    );
    expect(sides(out).A).toEqual(['X', 'Y']);
  });

  it('ignores a route naming a slot that does not exist', () => {
    const out = applyTransforms(
      bracket([
        { slot: 'A', round: 'R1', homeTeam: 'X', awayTeam: 'Y', winner: 'X', feeds: 'NOPE:home' },
        { slot: 'F', round: 'R2' },
      ]),
      [{ op: 'advance' }],
    );
    expect(sides(out).F).toEqual([null, null]);
  });

  it('does not fall back to the implied route when an override is a typo', () => {
    // Blank means "no opinion, use the tree". A typo means the author had an
    // opinion that did not parse, and substituting the convention would put a
    // team in a slot nobody asked for.
    const typo = applyTransforms(
      bracket([
        { slot: 'A', round: 'R1', homeTeam: 'X', awayTeam: 'Y', winner: 'X', feeds: 'F:middle' },
        { slot: 'F', round: 'R2' },
      ]),
      [{ op: 'advance' }],
    );
    expect(sides(typo).F).toEqual([null, null]);

    const blank = applyTransforms(
      bracket([
        { slot: 'A', round: 'R1', homeTeam: 'X', awayTeam: 'Y', winner: 'X', feeds: '' },
        { slot: 'F', round: 'R2' },
      ]),
      [{ op: 'advance' }],
    );
    expect(sides(blank).F[0]).toBe('X');
  });
});

describe('advance — carried fields', () => {
  it('moves a code alongside the name in one step', () => {
    const out = applyTransforms(
      {
        id: 'b',
        columns: [
          { key: 'slot', type: 'string' },
          { key: 'round', type: 'string' },
          { key: 'homeTeam', type: 'string' },
          { key: 'homeCode', type: 'string' },
          { key: 'awayTeam', type: 'string' },
          { key: 'awayCode', type: 'string' },
          { key: 'winner', type: 'string' },
        ],
        rows: [
          {
            slot: 'A', round: 'R1', homeTeam: 'Spain', homeCode: 'ESP',
            awayTeam: 'France', awayCode: 'FRA', winner: 'Spain',
          },
          {
            slot: 'B', round: 'R1', homeTeam: 'England', homeCode: 'ENG',
            awayTeam: 'Argentina', awayCode: 'ARG', winner: 'Argentina',
          },
          { slot: 'F', round: 'R2' },
        ],
      },
      [{ op: 'advance', fields: ['Team', 'Code'] }],
    );
    const final = out.rows.at(-1)!;
    expect([final.homeTeam, final.homeCode, final.awayTeam, final.awayCode]).toEqual([
      'Spain', 'ESP', 'Argentina', 'ARG',
    ]);
  });

  it('declares the columns it carries so a cell can bind to them', () => {
    const out = applyTransforms(
      { id: 'b', columns: [{ key: 'slot', type: 'string' }], rows: [{ slot: 'A' }] },
      [{ op: 'advance', fields: ['Team', 'Code'] }],
    );
    expect(out.columns.map((c) => c.key)).toEqual([
      'slot', 'homeTeam', 'awayTeam', 'homeCode', 'awayCode',
    ]);
  });
});

describe('advance — pipeline behavior', () => {
  it('leaves the input DataSet untouched', () => {
    const data = bracket([
      { slot: 'A', round: 'R1', homeTeam: 'X', awayTeam: 'Y', winner: 'X' },
      { slot: 'F', round: 'R2', homeTeam: null, awayTeam: null },
    ]);
    applyTransforms(data, [{ op: 'advance' }]);
    expect(data.rows[1]!.homeTeam).toBeNull();
  });

  it('resolves nothing when the rounds it needs were filtered away first', () => {
    // The order-sensitivity that makes `rank` useful makes this a footgun, so
    // pin the behavior rather than pretend the pipeline reorders itself.
    const out = applyTransforms(
      bracket([
        { slot: 'A', round: 'R1', homeTeam: 'X', awayTeam: 'Y', winner: 'X' },
        { slot: 'F', round: 'R2' },
      ]),
      [{ op: 'filter', key: 'round', cmp: 'eq', value: 'R2' }, { op: 'advance' }],
    );
    expect(sides(out).F).toEqual([null, null]);
  });

  it('resolves first and narrows after, which is the usable order', () => {
    const out = applyTransforms(
      bracket([
        { slot: 'A', round: 'R1', homeTeam: 'X', awayTeam: 'Y', winner: 'X' },
        { slot: 'F', round: 'R2' },
      ]),
      [{ op: 'advance' }, { op: 'filter', key: 'round', cmp: 'eq', value: 'R2' }],
    );
    expect(sides(out).F[0]).toBe('X');
  });

  it('still advances a row that has no slot id of its own', () => {
    const out = applyTransforms(
      bracket([
        { slot: null, round: 'R1', homeTeam: 'X', awayTeam: 'Y', winner: 'X' },
        { slot: 'F', round: 'R2' },
      ]),
      [{ op: 'advance' }],
    );
    expect(sides(out).F).toEqual(['X', null]);
  });
});

/* ------------------------------------------------------------- validation */

const tableWith = (layer: Partial<TableLayer>): Composition => ({
  formatVersion: 1,
  id: 'c',
  name: 'c',
  stage: { width: 1920, height: 1080, fps: 60, background: 'transparent' },
  layers: [
    {
      id: 'tbl',
      type: 'table',
      row: { height: 20, cells: [] },
      ...layer,
    } as TableLayer,
  ],
});

const messages = (comp: Composition): string[] =>
  validateCompositionSemantics(comp).map((i) => i.message);

describe('advance — validation', () => {
  it('says nothing about a bracket running on defaults', () => {
    const comp = tableWith({
      transforms: [{ op: 'advance' }],
      data: { columns: [{ key: 'slot', type: 'string' }], rows: [{ slot: 'A' }] },
    });
    expect(messages(comp)).toEqual([]);
  });

  it('reports a column the author named that does not exist', () => {
    const comp = tableWith({
      transforms: [{ op: 'advance', winner: 'victor' }],
      data: { columns: [{ key: 'slot', type: 'string' }], rows: [] },
    });
    expect(messages(comp)).toEqual(['advance references unknown column "victor"']);
  });

  it('reports a repeated slot id, which makes the bracket ambiguous', () => {
    const comp = tableWith({
      transforms: [{ op: 'advance' }],
      data: {
        columns: [{ key: 'slot', type: 'string' }],
        rows: [{ slot: 'A' }, { slot: 'A' }],
      },
    });
    expect(messages(comp)[0]).toContain('duplicate slot id "A"');
  });

  it('counts the columns advance carries as declared, so cells may bind to them', () => {
    const comp = tableWith({
      transforms: [{ op: 'advance', fields: ['Team', 'Code'] }],
      data: { columns: [{ key: 'slot', type: 'string' }], rows: [] },
      row: {
        height: 20,
        cells: [
          { id: 'a', type: 'text', text: '', cell: 'homeTeam', style: { fontFamily: 'x', fontSize: 10 } },
          { id: 'b', type: 'text', text: '', cell: 'awayCode', style: { fontFamily: 'x', fontSize: 10 } },
        ],
      },
    });
    expect(messages(comp)).toEqual([]);
  });
});
