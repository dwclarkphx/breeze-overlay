// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Backup and restore routes.
 *
 * Phase 7.5's last wave, and the second caller the archive reader was written
 * for. The reader shipped with sequences in 0.65.0 on the argument that a
 * reader exercised weekly is safer than one written the day it ships; this is
 * where that bet is settled.
 *
 * **The reader's `REFUSED` list is not the policy here.** It answers "would a
 * browser execute this in our origin", which is the right question for a
 * sequence unpacking into a served directory and the wrong one for a restore,
 * which also writes files the *server* parses. `openBundle` therefore
 * allowlists the paths it understands rather than blacklisting the ones it
 * fears — see `archive/bundle.ts`.
 */

import type { FastifyInstance } from 'fastify';

import {
  BundleError,
  buildBundle,
  buildCompositionBundle,
  mergeIntoProject,
  openBundle,
  restoreProject,
  type RestoreOutcome,
} from '../archive/bundle.js';
import { backupPage } from '../pages.js';
import { NotFoundError, listProjects, readProject } from '../store.js';

/**
 * Ceilings on a bundle being restored.
 *
 * Larger than the sequence limits because a whole-project backup legitimately
 * carries every asset a station has accumulated, and this archive was written
 * by a Breeze rather than handed over by a stranger — but still bounded,
 * because "written by a Breeze" is a claim the file makes about itself.
 */
const BUNDLE_LIMITS = {
  maxEntries: 20_000,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxEntryBytes: 1024 * 1024 * 1024,
};

const MAX_BUNDLE_BYTES = 8 * 1024 * 1024 * 1024;

/** A filename an operator can find again in six months. */
function bundleName(ids: readonly string[]): string {
  const stamp = new Date().toISOString().slice(0, 10);
  // One project is named after it; several are named by count, because a
  // filename listing eleven project ids is one nobody can read.
  const what = ids.length === 1 ? ids[0] : `${ids.length}-projects`;
  return `breeze-backup-${what}-${stamp}.zip`;
}

export async function registerBackupRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The page.
   *
   * A GET with no key, matching `/activity` and the portal. Worth being
   * explicit about what that means here, because this page is a bigger lever
   * than either: on a server with no API key set, anyone who can reach it can
   * download every project. That is not a new exposure — the same reachability
   * already allows reading and editing them — but it is a more convenient one.
   */
  app.get('/backup', async (_req, reply) => {
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    const projects = await listProjects();
    return backupPage(
      projects.map((p) => ({ id: p.id, name: p.name, compositions: p.compositions.length })),
    );
  });

  /**
   * What could be backed up.
   *
   * The page needs names and sizes to render checkboxes, and it needs them
   * before anything is zipped — a picker that has to build a 900 MB archive to
   * populate itself is not a picker.
   */
  app.get('/api/backup/projects', async () => {
    const projects = await listProjects();
    return {
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        compositions: p.compositions.length,
      })),
    };
  });

  /**
   * Download a bundle.
   *
   * `?projects=a,b` selects; `?projects=all` takes everything. Required rather
   * than defaulting to all: the difference between backing up one project and
   * backing up the station is minutes of disk and a very different file, and a
   * default would make the expensive one the accident.
   */
  app.get<{ Querystring: { projects?: string } }>('/api/backup', async (req, reply) => {
    const raw = req.query.projects?.trim();
    if (!raw) {
      reply.code(400);
      return { error: 'a ?projects= query parameter is required — a comma-separated list of ids, or "all"' };
    }

    let ids: string[];
    if (raw === 'all') {
      ids = (await listProjects()).map((p) => p.id);
      if (ids.length === 0) {
        reply.code(400);
        return { error: 'there are no projects to back up' };
      }
    } else {
      ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
      if (ids.length === 0) {
        reply.code(400);
        return { error: 'no project ids in ?projects=' };
      }
    }

    try {
      const { buffer, manifest, missing } = await buildBundle(ids);

      /*
       * Assets the index knew about but disk did not are reported in a header,
       * not by failing.
       *
       * A project that has lost a file is precisely the project someone is
       * backing up, and refusing to write anything because one logo is missing
       * would deny them the other 199. Silence would be worse than either —
       * the operator would discover it on restore, months later.
       */
      if (missing.length) {
        reply.header('x-breeze-missing-assets', String(missing.length));
      }
      reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${bundleName(ids)}"`)
        .header('x-breeze-projects', manifest.projects.map((p) => p.id).join(','));
      return reply.send(buffer);
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof BundleError) {
        reply.code(400);
        return { error: err.message };
      }
      throw err;
    }
  });

  await app.register(async (scope) => {
    /*
     * Same encapsulated catch-all parser as the asset routes, and for the same
     * reason: registered on the root instance it would claim every unrecognised
     * content type on every route, and a malformed body on the JSON API would
     * arrive as a Buffer instead of being rejected.
     */
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_BUNDLE_BYTES }, (_req, body, done) => {
      done(null, body);
    });

    /**
     * Inspect a bundle without writing anything.
     *
     * What the page calls before offering overwrite-or-rename. The collision
     * has to be answered *before* the write for the same reason asset Replace
     * detects collisions in the client: a question you answer after the write
     * is a question asked too late.
     */
    scope.post('/api/restore/inspect', { bodyLimit: MAX_BUNDLE_BYTES }, async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        reply.code(400);
        return { error: 'the request body must be the .zip bundle itself, sent raw' };
      }

      try {
        const contents = openBundle(body, BUNDLE_LIMITS);
        const existing = new Set((await listProjects()).map((p) => p.id));
        return {
          manifest: contents.manifest,
          projects: [...contents.projects.keys()].map((id) => ({
            id,
            collides: existing.has(id),
            assets: [...contents.projects.get(id)!.keys()].filter((k) => k.startsWith('assets/')).length,
          })),
        };
      } catch (err) {
        if (err instanceof BundleError) {
          reply.code(400);
          return { error: err.message };
        }
        throw err;
      }
    });

    /**
     * Restore.
     *
     * `?mode=overwrite` replaces colliding projects in place; `?mode=rename`
     * gives them a fresh id. There is no default — both answers are legitimate
     * (recovering a damaged project, versus taking in a colleague's copy), and
     * guessing means guessing destructively half the time.
     */
    scope.post<{ Querystring: { mode?: string; only?: string; into?: string } }>(
      '/api/restore',
      { bodyLimit: MAX_BUNDLE_BYTES },
      async (req, reply) => {
        const mode = req.query.mode;
        if (mode !== 'overwrite' && mode !== 'rename' && mode !== 'merge') {
          reply.code(400);
          return { error: 'a ?mode=overwrite, ?mode=rename or ?mode=merge query parameter is required' };
        }

        /*
         * Merge takes the bundle's compositions into a project that already
         * exists, rather than creating one. It is the handover case, and it is
         * the only mode that needs a destination — which is why `?into=` is
         * required here and meaningless everywhere else.
         */
        if (mode === 'merge') {
          const into = req.query.into?.trim();
          if (!into) {
            reply.code(400);
            return { error: '?mode=merge needs an ?into= project id to merge the compositions into' };
          }

          const body = req.body;
          if (!Buffer.isBuffer(body) || body.byteLength === 0) {
            reply.code(400);
            return { error: 'the request body must be the .zip bundle itself, sent raw' };
          }

          try {
            const contents = openBundle(body, BUNDLE_LIMITS);
            const merged = [];
            for (const bundledId of contents.projects.keys()) {
              merged.push(await mergeIntoProject(contents, bundledId, into));
            }
            reply.code(201);
            return { merged };
          } catch (err) {
            if (err instanceof NotFoundError) {
              reply.code(404);
              return { error: err.message };
            }
            if (err instanceof BundleError) {
              reply.code(400);
              return { error: err.message };
            }
            throw err;
          }
        }

        const body = req.body;
        if (!Buffer.isBuffer(body) || body.byteLength === 0) {
          reply.code(400);
          return { error: 'the request body must be the .zip bundle itself, sent raw' };
        }

        try {
          const contents = openBundle(body, BUNDLE_LIMITS);

          // `?only=` restores a subset of a multi-project bundle — the case of
          // one project going wrong out of a station-wide backup.
          const wanted = req.query.only?.trim()
            ? new Set(req.query.only.split(',').map((s) => s.trim()).filter(Boolean))
            : null;

          const existing = new Set((await listProjects()).map((p) => p.id));
          const restored: RestoreOutcome[] = [];

          for (const bundledId of contents.projects.keys()) {
            if (wanted && !wanted.has(bundledId)) continue;

            const collides = existing.has(bundledId);
            let targetId = bundledId;

            if (collides && mode === 'rename') {
              /*
               * A numeric suffix, checked against the live set rather than
               * assumed free.
               *
               * Restoring the same bundle three times should give three
               * projects, not overwrite the second with the third — which is
               * what a fixed `-restored` suffix would do.
               */
              let n = 2;
              while (existing.has(`${bundledId}-${n}`)) n += 1;
              targetId = `${bundledId}-${n}`;
            }

            const outcome = await restoreProject(contents, bundledId, targetId, {
              overwrite: collides && mode === 'overwrite',
            });
            existing.add(targetId);
            restored.push(outcome);
          }

          if (restored.length === 0) {
            reply.code(400);
            return { error: '?only= named no project present in this bundle' };
          }

          reply.code(201);
          return { restored };
        } catch (err) {
          if (err instanceof BundleError) {
            reply.code(400);
            return { error: err.message };
          }
          throw err;
        }
      },
    );
  });

  /**
   * One composition and what it needs — the handover bundle.
   *
   * Carries the composition, every composition it mounts, and only the assets
   * that set references. The difference between a 4 MB handover and a 900 MB
   * one.
   */
  app.get<{ Params: { id: string; compId: string } }>(
    '/api/projects/:id/compositions/:compId/backup',
    async (req, reply) => {
      try {
        const { buffer, manifest, missing } = await buildCompositionBundle(
          req.params.id,
          req.params.compId,
        );
        if (missing.length) reply.header('x-breeze-missing-assets', String(missing.length));
        const stamp = new Date().toISOString().slice(0, 10);
        reply
          .header('content-type', 'application/zip')
          .header(
            'content-disposition',
            `attachment; filename="breeze-${req.params.compId}-${stamp}.zip"`,
          )
          .header('x-breeze-compositions', String(manifest.projects[0]?.compositions ?? 0));
        return reply.send(buffer);
      } catch (err) {
        if (err instanceof NotFoundError) {
          reply.code(404);
          return { error: err.message };
        }
        if (err instanceof BundleError) {
          reply.code(404);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  /**
   * A single project's bundle, by id.
   */
  app.get<{ Params: { id: string } }>('/api/projects/:id/backup', async (req, reply) => {
    try {
      await readProject(req.params.id);
      const { buffer, missing } = await buildBundle([req.params.id]);
      if (missing.length) reply.header('x-breeze-missing-assets', String(missing.length));
      reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${bundleName([req.params.id])}"`);
      return reply.send(buffer);
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });
}
