// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Demo installation.
 *
 * The demos ship as ordinary projects in the data directory rather than as
 * fixtures, so the properties worth testing are the ones an operator would
 * notice: that all of them arrive, that they look like anything else they might
 * have made, and — the one the old rule got wrong — that throwing one away
 * keeps it thrown away.
 *
 * `seedDemos()` is called directly rather than through `buildApp`, because a
 * restart is exactly "run this again against the same directory" and that is
 * cheaper and clearer than standing a server up twice.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, afterAll, describe, expect, it } from 'vitest';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-seed-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { DEMOS, seedDemos } = await import('../seed.js');
const store = await import('../store.js');
const { readDataSources } = await import('../data/sources.js');

/** Every demo id that ships, read from the manifest rather than hard-coded. */
let demoIds: string[] = [];

beforeAll(async () => {
  await store.ensureDataDirs();
  demoIds = await Promise.all(
    DEMOS.map(async (d) => {
      const raw = await fs.readFile(
        path.join(process.cwd(), 'examples', d.file),
        'utf8',
      );
      return (JSON.parse(raw) as { id: string }).id;
    }),
  );
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const projectDir = (id: string): string => path.join(tmpDir, 'projects', id);

const exists = async (p: string): Promise<boolean> =>
  fs.access(p).then(() => true, () => false);

describe('installing demos', () => {
  it('installs every demo on a fresh data directory', async () => {
    // The old rule installed exactly one of the three. An operator who never
    // read the examples folder had no way to know the other two existed.
    const written = await seedDemos();
    expect(written.sort()).toEqual([...demoIds].sort());
    expect(demoIds.length).toBeGreaterThan(1);
  });

  it('writes them as ordinary projects, not as fixtures', async () => {
    for (const id of demoIds) {
      // The same layout `POST /api/projects` produces: a project document and
      // an assets directory. Nothing marks these as special, because nothing
      // should treat them as special.
      expect(await exists(path.join(projectDir(id), 'project.json')), id).toBe(true);
      expect(await exists(path.join(projectDir(id), 'assets')), id).toBe(true);
    }
  });

  it('does not write an asset index for a bin nobody has filled', async () => {
    // What an operator-created project actually looks like before its first
    // upload — `readAssets` materialises the file on demand (ASSETS.md §6).
    for (const id of demoIds) {
      expect(await exists(path.join(projectDir(id), 'assets.json')), id).toBe(false);
      expect(await store.listAssets(id)).toEqual([]);
    }
  });

  it('seeds the data sources the graphics are bound to', async () => {
    /*
     * Without this a fresh clone opens the standings graphic on its authored
     * snapshot with an empty data panel, which looks exactly like the feature
     * being broken rather than unconfigured.
     */
    for (const id of demoIds) {
      const sources = await readDataSources(id);
      expect(sources.length, `${id} sources`).toBeGreaterThan(0);
    }
  });

  it('binds every source a demo references', async () => {
    // A composition pointing at a source id that was never seeded renders its
    // fallback, silently.
    for (const id of demoIds) {
      const project = await store.readProject(id);
      const seeded = new Set((await readDataSources(id)).map((s) => s.id));

      const referenced = new Set<string>();
      const walk = (layers: readonly unknown[]): void => {
        for (const raw of layers) {
          const layer = raw as { source?: string; children?: unknown[]; row?: { cells?: unknown[] } };
          if (layer.source) referenced.add(layer.source);
          if (layer.children) walk(layer.children);
          if (layer.row?.cells) walk(layer.row.cells);
        }
      };
      for (const comp of project.compositions) walk(comp.layers);

      for (const source of referenced) {
        expect(seeded.has(source), `${id} references "${source}"`).toBe(true);
      }
    }
  });

  it('records what it installed', async () => {
    const ledger = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'seeded.json'), 'utf8'),
    ) as { installed: string[] };
    expect(ledger.installed.sort()).toEqual([...demoIds].sort());
  });
});

describe('restarting', () => {
  it('installs nothing the second time', async () => {
    expect(await seedDemos()).toEqual([]);
  });

  it('does not overwrite an edited demo', async () => {
    /*
     * The demos are meant to be taken apart. An operator who renames one and
     * restarts must not find their work replaced by the shipped copy.
     */
    const id = demoIds[0]!;
    const edited = { ...(await store.readProject(id)), name: 'My Own Thing' };
    await store.writeProject(edited);

    await seedDemos();

    expect((await store.readProject(id)).name).toBe('My Own Thing');
  });
});

describe('deleting a demo', () => {
  it('keeps it deleted across a restart', async () => {
    /*
     * The regression this rewrite exists for.
     *
     * The old guard was "install when the data directory has no projects at
     * all", so an operator who cleared out the demos they did not want found
     * every one of them back after the next restart — and no way to stop it
     * short of editing the examples folder.
     */
    const id = demoIds[0]!;
    await store.deleteProject(id);
    expect(await exists(projectDir(id))).toBe(false);

    await seedDemos();

    expect(await exists(projectDir(id))).toBe(false);
  });

  it('keeps them deleted even when every project is gone', async () => {
    // The exact shape of the old bug: an empty data directory used to mean
    // "fresh install", and a deliberately emptied one is indistinguishable
    // from it without the ledger.
    for (const id of demoIds) await store.deleteProject(id);
    expect(await store.listProjects()).toEqual([]);

    await seedDemos();

    expect(await store.listProjects()).toEqual([]);
  });
});

describe('upgrading an existing install', () => {
  it('adopts a project that predates the ledger instead of overwriting it', async () => {
    /*
     * The 0.57-and-earlier path: `demo` is already on disk from the old seed
     * rule, and there is no ledger. It must be recorded as installed and left
     * exactly alone — overwriting would destroy whatever was built on top of it.
     */
    /*
     * Reconstructed in place rather than in a second data directory: `config`
     * reads the environment once at import, so a second directory would need a
     * second module registry, and the state that actually matters — a project
     * on disk with no ledger entry for it — is reproducible here exactly.
     */
    await fs.rm(path.join(tmpDir, 'seeded.json'), { force: true });
    for (const id of demoIds) await store.deleteProject(id);

    // Stand in for the old seed rule: one demo present, edited, no ledger.
    const last = DEMOS[DEMOS.length - 1]!;
    const id = demoIds[demoIds.length - 1]!;
    const raw = await fs.readFile(path.join(process.cwd(), 'examples', last.file), 'utf8');
    await store.writeProject({ ...(JSON.parse(raw) as never), name: 'Renamed Before Upgrade' });

    const written = await seedDemos();

    // Adopted, not overwritten — whatever was built on top of it survives.
    expect(written).not.toContain(id);
    expect((await store.readProject(id)).name).toBe('Renamed Before Upgrade');

    // And the demos this install had never seen do arrive.
    expect(written.sort()).toEqual(demoIds.filter((d) => d !== id).sort());
  });
});
