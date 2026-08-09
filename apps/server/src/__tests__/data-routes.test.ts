// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Route-level helpers for the data-source API.
 *
 * `clampRows` is small but it is the only thing bounding how much a single
 * request can pull out of the registry. The editor asks for 500; nothing stops
 * a client asking for ten million, and the sources this serves are polled feeds
 * that grow on their own.
 */

import { describe, expect, it } from 'vitest';

import { MAX_LIST_ROWS, clampRows } from '../routes/datasources.js';

describe('clampRows', () => {
  it('passes a sensible request through', () => {
    expect(clampRows('500')).toBe(500);
  });

  it('caps an oversized request rather than refusing it', () => {
    // A 400 here would be a worse answer: the caller wants rows, and the cap is
    // a resource decision rather than a contract violation. `truncated` in the
    // response is what tells them they did not get everything.
    expect(clampRows('10000000')).toBe(MAX_LIST_ROWS);
  });

  it('treats zero, negatives and junk as "no rows please"', () => {
    // 0 is the default path — the data panel's health poll wants counts only,
    // and shipping every row of every source every five seconds to render a
    // timestamp would be pure waste.
    for (const raw of ['0', '-1', '', 'all', 'NaN', 'Infinity']) {
      expect(clampRows(raw), raw).toBe(0);
    }
  });

  it('floors a fractional request instead of returning one', () => {
    // `rows=10.9` reaching Array#slice as a float is the kind of thing that
    // works until it does not.
    expect(clampRows('10.9')).toBe(10);
    expect(Number.isInteger(clampRows('10.9'))).toBe(true);
  });
});
