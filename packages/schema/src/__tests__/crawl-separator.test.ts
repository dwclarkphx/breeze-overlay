// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Crawl separator presets.
 *
 * These live in the schema package rather than the editor because three places
 * have to agree on the default: the factory that creates a crawl layer, the
 * runtime that falls back when `separator` is absent, and the panel that offers
 * the list. They were three separate string literals before, which is exactly
 * the arrangement that drifts.
 */

import { describe, expect, it } from 'vitest';

import { CRAWL_SEPARATOR_PRESETS, DEFAULT_CRAWL_SEPARATOR } from '../types.js';
import { createLayer } from '../factory.js';

describe('crawl separator presets', () => {
  it('offers the default as one of the choices', () => {
    /*
     * The picker shows the current value as a selected option, so a separator
     * missing from this list opens the control on "Custom…". If the default
     * were absent, every freshly created crawl would do that — the control
     * would look wrong on the most common case there is.
     */
    expect(CRAWL_SEPARATOR_PRESETS.map((p) => p.value)).toContain(DEFAULT_CRAWL_SEPARATOR);
  });

  it('is what the factory puts on a new crawl layer', () => {
    // The drift this file exists to prevent, caught at its most likely point.
    const layer = createLayer('crawl');
    expect(layer.type).toBe('crawl');
    expect(layer.type === 'crawl' && layer.separator).toBe(DEFAULT_CRAWL_SEPARATOR);
  });

  it('pads every preset, because padding is part of the value', () => {
    // A separator renders inside one continuous text run, so the only air
    // around a glyph is what the string itself carries. An unpadded bullet
    // gives "storyone•storytwo".
    for (const preset of CRAWL_SEPARATOR_PRESETS) {
      expect(preset.value, preset.label).toMatch(/^\s.*\s$|^\s+$/);
    }
  });

  it('has unique values and unique labels', () => {
    // Values are the <option> values and labels are what tells them apart; a
    // duplicate of either makes one entry unreachable in the picker.
    const values = CRAWL_SEPARATOR_PRESETS.map((p) => p.value);
    const labels = CRAWL_SEPARATOR_PRESETS.map((p) => p.label);
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('has no empty separator', () => {
    // An empty separator runs every headline into the next with no break at
    // all. Someone who wants that can type it into Custom; it should not be
    // one click away in a list of suggestions.
    for (const preset of CRAWL_SEPARATOR_PRESETS) {
      expect(preset.value.length, preset.label).toBeGreaterThan(0);
    }
  });
});
