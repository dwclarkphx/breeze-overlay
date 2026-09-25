// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * `env.breeze` is the reference list of settings and their defaults. The
 * server never reads it, but people copy it — `cp -n env.breeze .env` is the
 * documented start for Docker — so a value in it that is not the real default
 * would silently become that install's setting. It must match the code.
 *
 * Checked the honest way: build `config` once with no BREEZE_* variables and
 * once with the template applied, and require the two to be identical. Any
 * template value that differs from the built-in default fails here, whichever
 * setting it is, including ones added after this test was written.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { REPO_ROOT } from '../config.js';
import { loadSettings } from '../load-env.js';

const saved = { ...process.env };

function clearBreeze(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('BREEZE_')) delete process.env[key];
  }
}

async function freshConfig() {
  vi.resetModules();
  return (await import('../config.js')).config;
}

afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

describe('env.breeze', () => {
  it('changes nothing when left as shipped', async () => {
    clearBreeze();
    const defaults = await freshConfig();

    clearBreeze();
    // The template alone — a developer's own .env must not decide this test.
    const load = loadSettings(REPO_ROOT, process.env, ['env.breeze']);
    // Guard against a vacuous pass: the file must exist and set something.
    expect(load.files.map((f) => f.file.endsWith('env.breeze'))).toContain(true);
    expect(load.files.find((f) => f.file.endsWith('env.breeze'))?.applied.length).toBeGreaterThan(0);

    expect(await freshConfig()).toEqual(defaults);
  });

  it('ships with no credential filled in', () => {
    const env: NodeJS.ProcessEnv = {};
    loadSettings(REPO_ROOT, env, ['env.breeze']);
    for (const key of ['BREEZE_API_KEY', 'BREEZE_DATA_SECRETS', 'BREEZE_DATA_SECRETS_FILE', 'BREEZE_CONTACT']) {
      expect(env[key] ?? '', key).toBe('');
    }
  });
});
