// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import { joinTarget, onAirSources, type SourceLike } from '../../client/join.js';

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
