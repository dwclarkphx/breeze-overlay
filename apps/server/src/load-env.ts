// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The settings file, for a server started directly rather than under Docker.
 *
 * Every setting is an environment variable, and until 0.73.0 that was the only
 * way in: Compose fed `.env` to the container, but `node dist/index.js` read
 * nothing, so editing `env.breeze` and restarting changed nothing at all — the
 * most natural thing to try, silently ignored.
 *
 * Now the server reads `.env` from the install folder itself. The real
 * environment — a shell `$env:`, `setx`, a service definition — still wins over
 * it; anything set in neither falls back to the default in `config.ts`.
 *
 * `env.breeze` is deliberately NOT read. It is reference: every setting, its
 * default and what it does, tracked by git and published. Reading it as well
 * made two files decide one value, and the tracked one looked like the place
 * to type a key. It is the starting point for a Docker `.env` and nothing else.
 *
 * The environment winning is the rule every dotenv loader and Node's own
 * `--env-file` follow, and it is what lets a one-off `$env:BREEZE_PORT=7400`
 * try something without editing a file. It is also how a setting gets "stuck":
 * a `setx` from months ago beats the file forever. So the startup log names the
 * file that was read *and* every value in it the environment overrode — the
 * answer to "I changed it and nothing happened" is then on screen.
 *
 * Everything here is a pure function of its arguments. The side effects —
 * creating `.env`, writing into `process.env` — happen in `boot-settings.ts`,
 * which only the entry point imports: tests build apps from `app.ts` and must
 * never pick up a developer's `.env`, let alone create one in the checkout.
 *
 * Docker is unaffected. The image copies neither file in, so inside a
 * container this finds nothing and Compose's `environment:` block stays the
 * only source.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The install folder — `src/` and `dist/` are both two levels under it. Same rule as `config.ts`. */
export const SETTINGS_ROOT = path.resolve(here, '..', '..', '..');

/** What a directly-run server reads. `env.breeze` is reference only — see above. */
export const SETTINGS_FILES = ['.env'] as const;

/**
 * `BREEZE_SETTINGS_FILES=off` — use the environment alone: read neither file
 * and create no `.env`.
 *
 * For anything that starts a server from a checkout and needs to know exactly
 * what it is running: the e2e suite above all, where a developer's own `.env`
 * with an API key in it would 401 every write the tests make. Also for a
 * service manager that already supplies every value and wants no surprises.
 */
export function settingsFilesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['BREEZE_SETTINGS_FILES'] ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

export interface SettingsFile {
  file: string;
  /** Names this file supplied. */
  applied: string[];
  /** Names in this file that the real environment already set — the file lost. */
  overridden: string[];
}

export interface SettingsLoad {
  root: string;
  files: SettingsFile[];
  /** A file that exists but could not be read. Logged; never fatal. */
  errors: Array<{ file: string; message: string }>;
}

export function loadSettings(
  root: string = SETTINGS_ROOT,
  env: NodeJS.ProcessEnv = process.env,
  /** Which files, in precedence order. A test reading only the template passes `['env.breeze']`. */
  names: readonly string[] = SETTINGS_FILES,
): SettingsLoad {
  // Captured before any file is applied, so "overridden" means the real
  // environment and never an earlier file.
  const fromEnvironment = new Set(Object.keys(env).filter((k) => env[k] !== undefined));
  const result: SettingsLoad = { root, files: [], errors: [] };

  for (const name of names) {
    const file = path.join(root, name);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') result.errors.push({ file, message: (err as Error).message });
      continue;
    }

    const parsed = parseEnv(text);
    const entry: SettingsFile = { file, applied: [], overridden: [] };
    for (const [key, value] of Object.entries(parsed)) {
      if (fromEnvironment.has(key)) {
        // Only worth reporting when it actually differs — a service definition
        // that repeats the file's own value is not a surprise to anyone.
        if (env[key] !== value) entry.overridden.push(key);
        continue;
      }
      // Set by a file earlier in the list (`.env` over the template).
      if (env[key] !== undefined) continue;
      env[key] = value;
      entry.applied.push(key);
    }
    result.files.push(entry);
  }
  return result;
}

/** One line per fact, for the startup log. Plain English, like every log line. */
export function describeSettings(
  /** `null` when `BREEZE_SETTINGS_FILES=off`. */
  load: SettingsLoad | null,
  created: ReturnType<typeof ensureUserSettingsFile> = null,
): Array<{ level: 'info' | 'warn'; text: string }> {
  const lines: Array<{ level: 'info' | 'warn'; text: string }> = [];
  if (load === null) {
    lines.push({ level: 'info', text: 'Settings files: off (BREEZE_SETTINGS_FILES) — using the environment only' });
    return lines;
  }
  if (created && 'created' in created) {
    lines.push({ level: 'info', text: `Created ${created.created} for your own settings — open it to see how` });
  }
  if (created && 'error' in created) {
    lines.push({ level: 'warn', text: `Settings: ${created.error}; create it by hand to keep your own settings` });
  }
  for (const { file, message } of load.errors) {
    lines.push({ level: 'warn', text: `Settings file ${file} could not be read (${message}); ignoring it` });
  }
  if (load.files.length === 0) {
    lines.push({
      level: 'info',
      text: `Settings file: none (no ${SETTINGS_FILES.join(', ')} in ${load.root}) — using built-in defaults`,
    });
    return lines;
  }
  for (const f of load.files) {
    lines.push({ level: 'info', text: `Settings file: ${f.file}` });
    if (f.overridden.length > 0) {
      lines.push({
        level: 'warn',
        text: `  ignored from that file, because the environment already sets them: ${f.overridden.join(', ')}`,
      });
    }
  }
  return lines;
}

/**
 * What a first run writes to `.env`: comments only, so creating it changes
 * nothing — the install behaves exactly as before until someone edits it.
 */
export const USER_SETTINGS_TEMPLATE = `# Your settings for this Breeze Overlay install.
#
# The server created this file because there was none. It is yours: git never
# tracks it, a release never includes it, and an upgrade never overwrites it —
# so this is the place for a real API key.
#
# This is the only settings file the server reads. Anything not set here uses
# the built-in default. env.breeze, beside this file, lists every setting with
# its default and what it does — it is reference only, and editing it changes
# nothing. Add just the lines you want to change here. For example:
#
# BREEZE_CONTACT=yourstation.com, you@yourstation.com
# BREEZE_API_KEY=a-long-random-string
# BREEZE_CONSOLE=dashboard
#
# Remove the # from a line to use it. Restart the server after editing — no
# rebuild needed.
#
# Variables set in the environment itself ($env:..., setx, a service
# definition) still win over this file. If an edit here seems to do nothing,
# the startup log lists every value the environment overrode.
`;

/**
 * Give a new install its own `.env`, once.
 *
 * Only where `env.breeze` sits beside it — that is what marks a source or
 * release install. The Docker image carries neither file, and a container
 * writing a settings file nobody can see or edit would only confuse. Never
 * overwrites, and never fatal: a read-only install folder just goes without.
 */
export function ensureUserSettingsFile(
  root: string = SETTINGS_ROOT,
): { created: string } | { error: string } | null {
  const file = path.join(root, '.env');
  if (!existsSync(path.join(root, 'env.breeze')) || existsSync(file)) return null;
  try {
    // `wx` fails if the file appeared between the check and the write — two
    // servers starting at once must not clobber each other.
    writeFileSync(file, USER_SETTINGS_TEMPLATE, { flag: 'wx' });
    return { created: file };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    return { error: `could not create ${file} (${(err as Error).message})` };
  }
}
