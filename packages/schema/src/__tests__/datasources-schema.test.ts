// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * `dataSourcesSchema`, against every source type it claims to describe.
 *
 * This exists because the schema shipped in Wave 1 and nothing ever called it.
 * Adding a source type means editing `DataSourceDef` in `data.ts` *and*
 * `dataSourcesSchema` in `schema.ts`, and until now nothing checked that the two
 * agreed — a type present in the union and missing from the schema would be
 * rejected on write, and one present in the schema with the wrong required
 * fields would be accepted and then fail to fetch, which is the worse of the two
 * because the symptom is a graphic that is quietly never populated.
 *
 * Each case below is typed as `DataSourceDef`, so a mismatch between the union
 * and these fixtures is a compile error and a mismatch between the fixtures and
 * the schema is a test failure. Both edits are needed to add a type, and both
 * are now enforced.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DATA_SOURCE_TYPES, type DataSourceDef } from '../data.js';
import { validateDataSources } from '../validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const examplePath = path.resolve(here, '../../../../examples/datasources.json');

const wrap = (sources: DataSourceDef[]) => ({ formatVersion: 1 as const, sources });

const ONE_OF_EACH: Record<DataSourceDef['type'], DataSourceDef> = {
  manual: {
    id: 'manual-src',
    name: 'Typed table',
    type: 'manual',
    columns: [{ key: 'team', label: 'Team', type: 'string' }],
    rows: [{ team: 'Mesa' }],
  },
  'http-json': {
    id: 'json-src',
    name: 'REST feed',
    type: 'http-json',
    url: 'https://example.test/standings.json',
    rowPath: 'data.standings[0].teams',
    pollInterval: 30,
    enabled: true,
  },
  'http-csv': {
    id: 'csv-src',
    name: 'Published sheet',
    type: 'http-csv',
    url: 'https://docs.google.com/spreadsheets/d/abc/pub?output=csv',
    delimiter: ',',
    header: true,
  },
  rss: {
    id: 'rss-src',
    name: 'Newsroom feed',
    type: 'rss',
    url: 'https://example.test/rss',
    pollInterval: 300,
  },
  xml: {
    id: 'xml-src',
    name: 'Results export',
    type: 'xml',
    url: 'https://example.test/results.xml',
    rowPath: 'results/game',
  },
  sheets: {
    id: 'sheets-src',
    name: 'Private sheet',
    type: 'sheets',
    spreadsheet: '1AbC-dEf_23',
    range: 'Standings!A1:F30',
    secretId: 'league-sheets',
    header: true,
  },
  weather: {
    id: 'weather-src',
    name: 'Phoenix weather',
    type: 'weather',
    provider: 'nws',
    latitude: 33.4484,
    longitude: -112.074,
    place: 'Phoenix, AZ',
    units: 'imperial',
    mode: 'current',
    pollInterval: 900,
  },
  ftp: {
    id: 'ftp-src',
    name: 'Results drop',
    type: 'ftp',
    protocol: 'sftp',
    host: 'drop.league.test',
    port: 22,
    path: '/results',
    pattern: 'results-*.csv',
    format: 'csv',
    username: 'scorer',
    secretId: 'results-drop',
    header: true,
  },
};

describe('data sources schema', () => {
  it('covers every declared source type', () => {
    // Guards the case where a type is added to DATA_SOURCE_TYPES and nowhere
    // else — the fixtures above would silently stop being exhaustive.
    expect(Object.keys(ONE_OF_EACH).sort()).toEqual([...DATA_SOURCE_TYPES].sort());
  });

  for (const [type, def] of Object.entries(ONE_OF_EACH)) {
    it(`accepts a ${type} source`, () => {
      const result = validateDataSources(wrap([def]));
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });
  }

  it('accepts all of them together', () => {
    const result = validateDataSources(wrap(Object.values(ONE_OF_EACH)));
    expect(result.errors).toEqual([]);
  });

  it('accepts the shipped example file', () => {
    // The demo project's sources ship in the repo and are what a first-run
    // server seeds itself from. One that does not validate is a shipping bug.
    const result = validateDataSources(JSON.parse(readFileSync(examplePath, 'utf8')));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe('data sources schema rejections', () => {
  it('rejects an unknown property', () => {
    // `additionalProperties: false` throughout, so a typo'd field is caught at
    // write time rather than being silently ignored at fetch time.
    expect(validateDataSources(wrap([{ ...ONE_OF_EACH.rss, rowPath: 'x' } as never])).valid).toBe(false);
  });

  it('rejects an http source with no url', () => {
    const { url: _drop, ...noUrl } = ONE_OF_EACH.xml as Extract<DataSourceDef, { url: string }>;
    void _drop;
    expect(validateDataSources(wrap([noUrl as never])).valid).toBe(false);
  });

  it('rejects a sheets source with no spreadsheet', () => {
    const { spreadsheet: _drop, ...bare } = ONE_OF_EACH.sheets as Extract<
      DataSourceDef,
      { spreadsheet: string }
    >;
    void _drop;
    expect(validateDataSources(wrap([bare as never])).valid).toBe(false);
  });

  it('rejects a sheets source given a url instead of an id', () => {
    /*
     * The rule from DATA-SOURCES §3: a Sheets def does not address an arbitrary
     * origin. Accepting a `url` here would hand an operator a way to point a
     * server-held credential at something that is not Sheets.
     */
    expect(
      validateDataSources(wrap([{ ...ONE_OF_EACH.sheets, url: 'https://evil.test' } as never])).valid,
    ).toBe(false);
  });

  it('rejects an unknown source type', () => {
    /*
     * This case used `type: 'ftp'` until Wave 3 made ftp a real type. It kept
     * passing — an ftp def with no host or pattern fails the schema anyway — but
     * for the wrong reason, which is the same failure mode as an e2e drag test
     * that asserts only the end state: it could no longer fail for the reason it
     * was written. Pinned to a string that will never become a source type.
     */
    expect(
      validateDataSources(wrap([{ id: 'x', name: 'x', type: 'carrier-pigeon' } as never])).valid,
    ).toBe(false);
  });

  it('rejects a self-hosted weather source with no baseUrl', () => {
    /*
     * The expensive failure this guards. `open-meteo-self` exists precisely
     * because the hosted API is non-commercial; a def that names it and then
     * silently falls back to api.open-meteo.com would put a commercial station
     * on the non-commercial tier with nobody told.
     */
    const result = validateDataSources(
      wrap([{ ...ONE_OF_EACH.weather, provider: 'open-meteo-self' } as DataSourceDef]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/baseUrl/);
  });

  it('accepts a self-hosted weather source that has one', () => {
    const result = validateDataSources(
      wrap([
        {
          ...ONE_OF_EACH.weather,
          provider: 'open-meteo-self',
          baseUrl: 'http://localhost:8282',
        } as DataSourceDef,
      ]),
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a baseUrl on a provider that addresses a fixed origin', () => {
    // Otherwise a def that had been self-hosted and was switched back would keep
    // a stale instance URL that reads as though it were in use.
    const result = validateDataSources(
      wrap([{ ...ONE_OF_EACH.weather, baseUrl: 'http://localhost:8282' } as DataSourceDef]),
    );
    expect(result.valid).toBe(false);
  });

  it('rejects a weather source with an out-of-range coordinate', () => {
    expect(
      validateDataSources(wrap([{ ...ONE_OF_EACH.weather, latitude: 120 } as DataSourceDef])).valid,
    ).toBe(false);
  });

  it('rejects an ftp source with no pattern — it would take an arbitrary file', () => {
    const { pattern: _drop, ...bare } = ONE_OF_EACH.ftp as Extract<
      DataSourceDef,
      { pattern: string }
    >;
    void _drop;
    expect(validateDataSources(wrap([bare as never])).valid).toBe(false);
  });

  it('rejects a literal password on an ftp source', () => {
    // §6: a def carries a secret *id*, never a value. `additionalProperties:
    // false` is what enforces it — there is no `password` field to fill in.
    expect(
      validateDataSources(wrap([{ ...ONE_OF_EACH.ftp, password: 'hunter2' } as never])).valid,
    ).toBe(false);
  });

  it('rejects two sources sharing an id', () => {
    // JSON Schema's uniqueItems compares whole objects, so two sources with the
    // same id but different urls would sail past it. Checked semantically.
    const clash = [ONE_OF_EACH.rss, { ...ONE_OF_EACH.xml, id: ONE_OF_EACH.rss.id }];
    const result = validateDataSources(wrap(clash as DataSourceDef[]));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/duplicate data source id/);
  });

  it('rejects a wrong formatVersion', () => {
    expect(validateDataSources({ formatVersion: 2, sources: [] }).valid).toBe(false);
  });
});
