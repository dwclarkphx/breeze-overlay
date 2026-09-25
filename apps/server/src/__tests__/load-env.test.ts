// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The settings file for a directly-run server.
 *
 * What must hold: the real environment beats `.env`, which beats the template;
 * a value the environment overrode is reported rather than silently lost; and
 * nothing is fatal. Every test passes its own env object, so none of this ever
 * touches the process environment of the suite.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  USER_SETTINGS_TEMPLATE,
  describeSettings,
  ensureUserSettingsFile,
  loadSettings,
  settingsFilesEnabled,
} from '../load-env.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-env-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const write = (name: string, text: string) => fs.writeFile(path.join(root, name), text);

describe('loadSettings', () => {
  it('reads .env', async () => {
    await write('.env', '# a comment\nBREEZE_PORT=7400\n# BREEZE_CONTACT=example.com\nBREEZE_API_KEY=\n');
    const env: NodeJS.ProcessEnv = {};
    const load = loadSettings(root, env);

    expect(env['BREEZE_PORT']).toBe('7400');
    // Commented out stays out.
    expect(env['BREEZE_CONTACT']).toBeUndefined();
    // Present but empty: set to '', which config treats as "use the default".
    expect(env['BREEZE_API_KEY']).toBe('');
    expect(load.files.map((f) => path.basename(f.file))).toEqual(['.env']);
  });

  it('never reads env.breeze — it is reference, not settings', async () => {
    // The one rule this file exists to hold: editing the tracked template must
    // not change a running server, or a key typed into it would both work and
    // be published with the next push.
    await write('env.breeze', 'BREEZE_PORT=7400\nBREEZE_API_KEY=typed-into-the-template\n');
    const env: NodeJS.ProcessEnv = {};
    const load = loadSettings(root, env);
    expect(env).toEqual({});
    expect(load.files).toEqual([]);
  });

  it('lets the environment win over .env, and reports what it overrode', async () => {
    await write('.env', 'BREEZE_PORT=7400\nBREEZE_CONSOLE=log\n');
    const env: NodeJS.ProcessEnv = { BREEZE_CONSOLE: 'dashboard' };
    const load = loadSettings(root, env);

    expect(env).toMatchObject({ BREEZE_PORT: '7400', BREEZE_CONSOLE: 'dashboard' });
    expect(load.files[0]?.applied).toEqual(['BREEZE_PORT']);
    expect(load.files[0]?.overridden).toEqual(['BREEZE_CONSOLE']);
  });

  it('does not report an override that sets the same value', async () => {
    await write('.env', 'BREEZE_PORT=7331\n');
    const load = loadSettings(root, { BREEZE_PORT: '7331' });
    expect(load.files[0]?.overridden).toEqual([]);
  });

  it('handles quoting the way a dotenv file is expected to', async () => {
    await write('.env', 'BREEZE_CONTACT="mystation.com, ops@mystation.com"\n');
    const env: NodeJS.ProcessEnv = {};
    loadSettings(root, env);
    expect(env['BREEZE_CONTACT']).toBe('mystation.com, ops@mystation.com');
  });

  it('reports a file it cannot read, and carries on with the defaults', async () => {
    await fs.mkdir(path.join(root, '.env'));
    const env: NodeJS.ProcessEnv = {};
    const load = loadSettings(root, env);
    expect(load.errors).toHaveLength(1);
    expect(env).toEqual({});
  });
});

describe('describeSettings', () => {
  it('names the file read and warns about what the environment overrode', async () => {
    await write('.env', 'BREEZE_PORT=7331\nBREEZE_LOCALE=fr\n');
    const lines = describeSettings(loadSettings(root, { BREEZE_LOCALE: 'en' }));
    expect(lines[0]).toEqual({ level: 'info', text: `Settings file: ${path.join(root, '.env')}` });
    expect(lines[1]?.level).toBe('warn');
    expect(lines[1]?.text).toContain('BREEZE_LOCALE');
  });

  it('says where it looked, and that the defaults apply, when there is nothing to read', async () => {
    await write('env.breeze', 'BREEZE_PORT=7331\n');
    const lines = describeSettings(loadSettings(root, {}));
    expect(lines).toEqual([
      { level: 'info', text: `Settings file: none (no .env in ${root}) — using built-in defaults` },
    ]);
  });
});

describe('ensureUserSettingsFile', () => {
  it('creates a comments-only .env beside the template, and it changes nothing', async () => {
    await write('env.breeze', 'BREEZE_PORT=7400\n');
    const result = ensureUserSettingsFile(root);
    expect(result).toEqual({ created: path.join(root, '.env') });
    expect(await fs.readFile(path.join(root, '.env'), 'utf8')).toBe(USER_SETTINGS_TEMPLATE);

    const env: NodeJS.ProcessEnv = {};
    const load = loadSettings(root, env);
    // Read, but supplies nothing — the example lines are all commented out,
    // and the template's 7400 is not picked up either.
    expect(load.files[0]?.applied).toEqual([]);
    expect(env).toEqual({});
  });

  it('never touches a .env that already exists', async () => {
    await write('env.breeze', 'BREEZE_PORT=7331\n');
    await write('.env', 'BREEZE_API_KEY=mine\n');
    expect(ensureUserSettingsFile(root)).toBeNull();
    expect(await fs.readFile(path.join(root, '.env'), 'utf8')).toBe('BREEZE_API_KEY=mine\n');
  });

  it('does nothing where there is no template — the Docker image', async () => {
    expect(ensureUserSettingsFile(root)).toBeNull();
    await expect(fs.stat(path.join(root, '.env'))).rejects.toThrow();
  });

  it('turns a failed create into a warning line, not a crash', () => {
    // Forcing a real permissions failure is not portable (chmod does not stop
    // writes on Windows), so this checks what the caller does with one.
    const lines = describeSettings(loadSettings(root, {}), { error: 'could not create X (EACCES)' });
    expect(lines[0]).toMatchObject({ level: 'warn' });
    expect(lines[0]?.text).toContain('create it by hand');
  });

  it('says it created the file', () => {
    const lines = describeSettings(loadSettings(root, {}), { created: '/x/.env' });
    expect(lines[0]).toEqual({ level: 'info', text: 'Created /x/.env for your own settings — open it to see how' });
  });
});

describe('BREEZE_SETTINGS_FILES', () => {
  it('is on unless switched off', () => {
    expect(settingsFilesEnabled({})).toBe(true);
    expect(settingsFilesEnabled({ BREEZE_SETTINGS_FILES: 'on' })).toBe(true);
    for (const v of ['off', 'OFF', '0', 'false', 'no']) {
      expect(settingsFilesEnabled({ BREEZE_SETTINGS_FILES: v }), v).toBe(false);
    }
  });

  it('says so in the log when off', () => {
    expect(describeSettings(null)).toEqual([
      { level: 'info', text: 'Settings files: off (BREEZE_SETTINGS_FILES) — using the environment only' },
    ]);
  });
});
