// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import { compareReports, joinTarget, onAirSources, reportAgeSeconds, reportOf, SYNC_TOLERANCE, type SourceLike } from '../../client/join.js';

const holding = { state: 'holding', time: 1, step: 1 };
const source = (id: string, over: Partial<SourceLike> = {}): SourceLike => ({
  id,
  page: `page-${id}`,
  label: 'OBS on Windows',
  ip: '10.0.0.5',
  connectedAt: 1,
  playback: holding,
  reportedAt: 9_000,
  ...over,
});

describe('joinTarget', () => {
  it('takes the most recent report among outputs on air, aged by the hub clock', () => {
    const state = {
      now: 10_000,
      sources: [source('a', { reportedAt: 8_000 }), source('b', { reportedAt: 9_500, playback: { ...holding, step: 1 } })],
    };
    expect(joinTarget(state, 'auto')).toMatchObject({ state: 'holding', ageMs: 500 });
  });

  it('skips outputs that are not on air, and the page asking', () => {
    const state = {
      now: 10_000,
      sources: [
        source('off', { playback: { state: 'idle', time: 0, step: 0 }, reportedAt: 9_900 }),
        source('me', { page: 'mine', reportedAt: 9_950 }),
        source('on', { reportedAt: 9_000 }),
      ],
    };
    expect(joinTarget(state, 'auto', 'mine')?.ageMs).toBe(1_000);
    expect(onAirSources(state, 'mine').map((s) => s.id)).toEqual(['on']);
  });

  it('follows a chosen output by page id, and shows nothing while that output is off air', () => {
    const state = {
      now: 10_000,
      sources: [source('a', { reportedAt: 9_900 }), source('b', { playback: { state: 'finished', time: 2, step: 1 } })],
    };
    expect(joinTarget(state, 'page-a')?.ageMs).toBe(100);
    expect(joinTarget(state, 'page-b')).toBeNull();
  });

  it('falls back to auto when the chosen output has gone', () => {
    const state = { now: 10_000, sources: [source('a')] };
    expect(joinTarget(state, 'page-gone')).not.toBeNull();
  });

  it('never joins when sync is off', () => {
    expect(joinTarget({ now: 1, sources: [source('a')] }, 'off')).toBeNull();
  });

  it('uses the channel’s own report only when no output is connected at all', () => {
    expect(joinTarget({ now: 10_000, playback: holding, reportedAt: 7_000, sources: [] }, 'auto')?.ageMs).toBe(3_000);
    const offAir = source('a', { playback: { state: 'idle', time: 0, step: 0 } });
    expect(joinTarget({ now: 10_000, playback: holding, reportedAt: 7_000, sources: [offAir] }, 'auto')).toBeNull();
  });
});


describe('reportOf', () => {
  it('lists paging tables only, and tickers when there are any', () => {
    const report = reportOf({
      playbackState: 'holding', currentTime: 1, currentStep: 1, stepCount: 1,
      tableStates: [
        { table: 'city', page: 2, pageCount: 38, key: 'Buckeye', hasCycle: true, cycling: true, held: false, secondsLeft: 4, group: 'cities' },
        { table: 'still', page: 0, pageCount: 1, key: null, hasCycle: false, cycling: false, held: false, secondsLeft: null },
      ],
      crawlStates: [{ layer: 'm-alerts/al-crawl', text: 'A • ', staged: null, offsetMs: 10, passMs: 1000 }],
    });
    expect(report.tables!.map((t) => t.table)).toEqual(['city']);
    expect(report.crawls).toHaveLength(1);
  });
});

describe('compareReports', () => {
  const output = {
    state: 'holding', time: 1, step: 1,
    tables: [{ table: 'city', page: 2, pageCount: 38, key: 'Buckeye', secondsLeft: 6 }],
    crawls: [{ layer: 'al', text: 'Flood Watch • ', staged: null, offsetMs: 1_000, passMs: 20_000 }],
  };

  it('passes a preview in step, allowing for the report’s age', () => {
    const preview = {
      ...output,
      tables: [{ ...output.tables[0]!, secondsLeft: 4 }],
      crawls: [{ ...output.crawls[0]!, offsetMs: 3_050 }],
    };
    const checks = compareReports(output, 2_000, preview);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.kind)).toEqual(['playback', 'table', 'crawl']);
  });

  it('flags a different page, and a page whose time is out by more than the tolerance', () => {
    const wrongPage = compareReports(output, 0, { ...output, tables: [{ ...output.tables[0]!, page: 3, key: 'Bullhead City' }] });
    expect(wrongPage.find((c) => c.kind === 'table')!.ok).toBe(false);
    const late = compareReports(output, 0, { ...output, tables: [{ ...output.tables[0]!, secondsLeft: 6 - SYNC_TOLERANCE.pageSeconds - 0.5 }] });
    expect(late.find((c) => c.kind === 'table')!.ok).toBe(false);
  });

  it('does not call a page wrong when the report is old enough to have turned since', () => {
    const checks = compareReports(output, 7_000, { ...output, tables: [{ ...output.tables[0]!, page: 3, key: 'Bullhead City', secondsLeft: 9 }] });
    expect(checks.find((c) => c.kind === 'table')!.ok).toBe(true);
  });

  it('flags a ticker on other copy, or out of position, and measures position round the loop', () => {
    const otherCopy = compareReports(output, 0, { ...output, crawls: [{ ...output.crawls[0]!, text: 'Heat Warning • ' }] });
    expect(otherCopy.find((c) => c.kind === 'crawl')!.ok).toBe(false);
    const behind = compareReports(output, 0, { ...output, crawls: [{ ...output.crawls[0]!, offsetMs: 600 }] });
    expect(behind.find((c) => c.kind === 'crawl')!.ok).toBe(false);
    // 19.9 s into a 20 s pass is 0.1 s from 0.0 s into the next — in step, not 19.9 s apart.
    const wrapped = compareReports(
      { ...output, crawls: [{ ...output.crawls[0]!, offsetMs: 19_950 }] }, 0,
      { ...output, crawls: [{ ...output.crawls[0]!, offsetMs: 50 }] },
    );
    expect(wrapped.find((c) => c.kind === 'crawl')!.ok).toBe(true);
  });

  it('flags a table or ticker the preview does not have', () => {
    const checks = compareReports(output, 0, { state: 'holding', time: 1, step: 1 });
    expect(checks.filter((c) => !c.ok).map((c) => c.kind)).toEqual(['table', 'crawl']);
  });

  it('flags a preview that is not on the same hold', () => {
    expect(compareReports(output, 0, { ...output, state: 'idle', step: 0 })[0]!.ok).toBe(false);
  });
});

describe('reportAgeSeconds (0.76.0)', () => {
  it('is how long the hub had held the report when it sent it', () => {
    expect(reportAgeSeconds({ reportedAt: 10_000, now: 16_500 })).toBe(6.5);
  });

  it('is zero for a report made this instant, or with no clock to read', () => {
    expect(reportAgeSeconds({ reportedAt: 10_000, now: 10_000 })).toBe(0);
    expect(reportAgeSeconds({ reportedAt: null, now: 10_000 })).toBe(0);
    expect(reportAgeSeconds({ reportedAt: 10_000 })).toBe(0);
    expect(reportAgeSeconds(undefined)).toBe(0);
  });

  it('is never negative, whatever order the two stamps come in', () => {
    expect(reportAgeSeconds({ reportedAt: 12_000, now: 10_000 })).toBe(0);
  });
});
