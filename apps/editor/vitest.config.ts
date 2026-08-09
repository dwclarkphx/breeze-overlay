// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { defineConfig } from 'vitest/config';

/**
 * Deliberately plugin-free. Everything under test here — commands, history,
 * timeline geometry — is pure TypeScript, so no JSX transform is needed, and
 * leaving the React plugin out avoids Vitest's bundled Vite disagreeing with
 * the app's newer one.
 */
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
});
