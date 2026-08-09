// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Demo projects — installed into the data directory as ordinary projects.
 *
 * A fresh clone should be able to `pnpm dev`, open a browser and immediately
 * have something to point vMix at: an empty server is a bad first impression
 * and a bad smoke test.
 *
 * **These are real projects, not fixtures.** They land in `projects/<id>/` with
 * the same layout `POST /api/projects` produces — `project.json`, an `assets/`
 * directory, and `datasources.json` where the graphics are bound to a feed.
 * Nothing marks them as special, nothing protects them, and an operator can
 * rename, edit or delete any of them from the editor exactly as they would
 * their own work. That is the point: a demo an operator cannot take apart is a
 * demo they cannot learn from.
 *
 * **Deleting one keeps it deleted.** Installation is recorded in a ledger next
 * to `projects/`, and each demo is installed at most once ever. The previous
 * rule — seed when the data directory has no projects at all — got this wrong
 * in both directions: an operator who deleted every demo found them all back
 * after the next restart, and one who created their own project first never saw
 * the newer demos at all.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { FORMAT_VERSION, type DataSourceDef, type Project } from '@breeze/schema';
import { assertValidProject } from '@breeze/schema/validate';

import { REPO_ROOT, config } from './config.js';
import { writeDataSources } from './data/sources.js';
import { readProject, writeProject } from './store.js';

const examples = (file: string): string => path.join(REPO_ROOT, 'examples', file);

/** Where the ledger lives — beside `projects/`, not inside it. */
export const SEED_LEDGER_PATH = (): string => path.join(config.dataDir, 'seeded.json');

interface SeedLedger {
  formatVersion: typeof FORMAT_VERSION;
  /**
   * Project ids that have been installed at some point.
   *
   * Ids rather than filenames, because the id is what an operator deletes and
   * what has to stay deleted. A demo renamed in `examples/` is still the same
   * project to the person who threw it away.
   */
  installed: string[];
}

export interface Demo {
  /** Project document under `examples/`. */
  file: string;
  /** Its data sources, where the graphics are bound to one. */
  sources?: string;
}

/**
 * What ships.
 *
 * Ordered so the simplest lands first: a project index sorted by `updatedAt`
 * puts the last one written at the top, and the World Cup scene is a poor
 * first thing to meet.
 */
export const DEMOS: Demo[] = [
  { file: 'world-cup-scene.json', sources: 'world-cup-datasources.json' },
  { file: 'world-cup-bracket.json', sources: 'world-cup-datasources.json' },
  { file: 'lower-third.json', sources: 'datasources.json' },
];

/* Kept for the tests and tooling that reference the original demo by name. */
export const EXAMPLE_PROJECT_PATH = examples('lower-third.json');
export const EXAMPLE_DATASOURCES_PATH = examples('datasources.json');

export async function loadExampleProject(): Promise<Project> {
  return loadDemo(EXAMPLE_PROJECT_PATH);
}

async function loadDemo(file: string): Promise<Project> {
  const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  assertValidProject(parsed);
  return parsed;
}

async function readLedger(): Promise<SeedLedger> {
  try {
    const parsed = JSON.parse(await fs.readFile(SEED_LEDGER_PATH(), 'utf8')) as Partial<SeedLedger>;
    return {
      formatVersion: FORMAT_VERSION,
      installed: Array.isArray(parsed.installed) ? parsed.installed.filter((s) => typeof s === 'string') : [],
    };
  } catch {
    // Absent on a fresh install, and unreadable is treated the same. The cost
    // of guessing wrong is one demo reappearing, not a lost project.
    return { formatVersion: FORMAT_VERSION, installed: [] };
  }
}

async function writeLedger(ledger: SeedLedger): Promise<void> {
  const tmp = `${SEED_LEDGER_PATH()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, SEED_LEDGER_PATH());
}

/** Does a project already exist on disk? */
async function exists(id: string): Promise<boolean> {
  try {
    await readProject(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install any demo that has never been installed.
 *
 * Returns the ids actually written, so the caller can log something true rather
 * than "seeded" every boot.
 */
export async function seedDemos(): Promise<string[]> {
  const ledger = await readLedger();
  const installed = new Set(ledger.installed);
  const written: string[] = [];

  for (const demo of DEMOS) {
    let project: Project;
    try {
      project = await loadDemo(examples(demo.file));
    } catch {
      // A missing or invalid example is not fatal — the server still runs, and
      // the other demos still install.
      continue;
    }

    if (installed.has(project.id)) continue;

    /*
     * Already on disk, but not in the ledger: an installation that predates the
     * ledger, or a project an operator happened to name the same thing. Marked
     * as installed and left completely alone — overwriting would destroy work,
     * and this is the upgrade path from the old seed rule.
     */
    if (await exists(project.id)) {
      installed.add(project.id);
      continue;
    }

    try {
      await writeProject(project);
    } catch {
      continue;
    }

    /*
     * Sources are seeded with the project because the graphics are bound to
     * them. Without this a fresh clone opens the standings graphic on its
     * authored snapshot with an empty data panel, which looks exactly like the
     * feature not working.
     *
     * Its own try/catch: a project that installed is better than no project,
     * and sources are recoverable by hand where a composition is not.
     */
    if (demo.sources) {
      try {
        const raw = await fs.readFile(examples(demo.sources), 'utf8');
        const parsed = JSON.parse(raw) as { sources?: DataSourceDef[] };
        if (parsed.sources?.length) await writeDataSources(project.id, parsed.sources);
      } catch {
        /* No example sources, or unreadable. The project still works. */
      }
    }

    installed.add(project.id);
    written.push(project.id);
  }

  if (installed.size !== ledger.installed.length) {
    await writeLedger({ formatVersion: FORMAT_VERSION, installed: [...installed] });
  }

  return written;
}
