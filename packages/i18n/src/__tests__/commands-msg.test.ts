// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The editor's command labels lean on `select` and `plural` harder than
 * anything else in the catalogue, so they get their own coverage: a `select`
 * that silently falls through to `other` would put a raw enum in the undo
 * tooltip, and nothing else would notice.
 */

import { describe, expect, it } from 'vitest';

import { formatMessage } from '../format.js';

const ADD_LAYER =
  'Add {type, select, text {text} shape {shape} image {image} video {video} ' +
  'sprite {sprite} crawl {crawl} table {table} composition {composition} ' +
  'group {group} other {{type}}} layer';

const DELETE_LAYERS = '{count, plural, one {Delete layer} other {Delete # layers}}';

describe('command labels', () => {
  it('selects a branch per layer type', () => {
    expect(formatMessage(ADD_LAYER, 'en', { type: 'text' })).toBe('Add text layer');
    expect(formatMessage(ADD_LAYER, 'en', { type: 'sprite' })).toBe('Add sprite layer');
    expect(formatMessage(ADD_LAYER, 'en', { type: 'composition' })).toBe('Add composition layer');
  });

  it('echoes an unknown type rather than dropping it', () => {
    // A LayerType added later must not silently render "Add  layer".
    expect(formatMessage(ADD_LAYER, 'en', { type: 'mask' })).toBe('Add mask layer');
  });

  it('switches singular and plural without a ternary at the call site', () => {
    expect(formatMessage(DELETE_LAYERS, 'en', { count: 1 })).toBe('Delete layer');
    expect(formatMessage(DELETE_LAYERS, 'en', { count: 4 })).toBe('Delete 4 layers');
  });

  it('keeps the count out of the singular branch', () => {
    expect(formatMessage(DELETE_LAYERS, 'en', { count: 1 })).not.toContain('1');
  });
});
