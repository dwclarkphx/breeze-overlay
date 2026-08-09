// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Package barrel — everything a browser consumer needs.
 *
 * `validate.js` is deliberately absent. It instantiates Ajv and compiles the
 * schemas at module load, which is an untree-shakeable side effect, so barrel
 * consumers were inheriting ~250 kB of validator they never called. Import it
 * explicitly as `@breeze/schema/validate` where validation is actually wanted
 * — the server, and tooling.
 */

export * from './data.js';
export * from './types.js';
export * from './schema.js';
export * from './duration.js';
export * from './bindings.js';
export * from './factory.js';
export * from './keys.js';
export * from './scene.js';
export * from './assets.js';
