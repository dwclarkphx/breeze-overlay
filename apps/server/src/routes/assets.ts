// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Asset routes — upload, list, delete.
 *
 * ROADMAP §4 Phase 2 listed an "asset bin (upload images/fonts)" and it never
 * landed: `registerAsset` and `assetPath` have sat in the store with no caller,
 * and every image, video and font has been referenced by a path typed into a
 * text field and copied into the project directory by hand. That is workable
 * for one demo and untenable for a station, and Phase 7 cannot start without
 * it — "upload a ProRes .mov and transcode it" has nowhere to put the .mov.
 *
 * **Raw body, not multipart.** The upload is a `POST` whose entire body is the
 * file, with the name in the query string. Same argument as the CSV parser in
 * Wave 1 and the XML reader in Wave 2, and it lands harder here than either:
 * multipart is a parser, parsers have bugs, and this one would sit directly in
 * front of a filesystem write taking an attacker-supplied filename. A server
 * that cannot parse multipart cannot be confused by a crafted boundary,
 * a smuggled second part, or a filename split across a header continuation.
 * There is nothing to get wrong because there is nothing to parse.
 *
 * The cost is one request per file. The editor wanted that anyway: a per-file
 * request is a per-file progress bar and a per-file failure, and a 400MB stinger
 * that fails on byte one should not take four logo PNGs down with it.
 */

import type { FastifyInstance } from 'fastify';

import { capabilities, inspect } from '../media/ffmpeg.js';
import type { TranscodeQueue } from '../media/transcode.js';
import { EDITABLE_ASSET_FIELDS, type AssetEdit, type AssetRef } from '@breeze/schema';

import {
  NotFoundError,
  addVocabulary,
  assetPath,
  assetUsage,
  assetVocabulary,
  deleteAsset,
  editAssets,
  getAsset,
  listAssets,
  orphanAssets,
  recordAssetProbe,
  replaceAsset,
  saveAsset,
} from '../store.js';

/**
 * Largest single upload.
 *
 * Above the app-wide `bodyLimit` (64MB), which is sized for compositions
 * carrying base64 assets, because a ProRes 4444 stinger is routinely hundreds
 * of megabytes — that is the format's whole point and the reason it needs
 * transcoding at all. Rejecting one at the door would make the phase's
 * headline feature unusable.
 */
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;

/**
 * Extensions refused outright.
 *
 * Not a virus check and not pretending to be one. The assets directory is
 * served as static files, so the only thing that matters here is that nothing
 * lands in it which a browser would execute in the server's origin — an
 * uploaded `.html` runs with the editor's cookies and the operator's session.
 * `assetKindFor` already returns `other` for these; this is the separate
 * question of whether `other` is allowed to be *served*.
 */
const REFUSED = new Set([
  '.html', '.htm', '.xhtml', '.svgz', '.js', '.mjs', '.cjs', '.wasm',
  '.php', '.jsp', '.asp', '.aspx', '.exe', '.dll', '.so', '.sh', '.bat', '.cmd',
]);

function refusedExtension(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = name.slice(dot).toLowerCase();
  return REFUSED.has(ext) ? ext : null;
}

export async function registerAssetRoutes(
  app: FastifyInstance,
  transcodes: TranscodeQueue,
): Promise<void> {
  /*
   * Registered inside a plugin so the catch-all body parser is encapsulated.
   *
   * Fastify content-type parsers inherit down the tree, not up. Adding `'*'` on
   * the root instance would hand every unrecognised content type on every route
   * to this buffer parser — including the API routes, where an unparseable body
   * should stay a 415 rather than silently arriving as a Buffer.
   */
  await app.register(async (scope) => {
    /*
     * Anything not otherwise claimed arrives as a Buffer.
     *
     * `'*'` in Fastify means "content types with no registered parser", so the
     * JSON parser still wins for `application/json` — a client that uploads a
     * .json asset with an honest content type would otherwise have its file
     * parsed as a body and lost. That case is handled by the guard below
     * rather than by fighting the parser.
     */
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_ASSET_BYTES }, (_req, body, done) => {
      done(null, body);
    });

    /**
     * Probe time-based media and fold the result into the row.
     *
     * `saveAsset` reads image dimensions off the header of the buffer it is
     * already holding, but duration, codec and alpha need ffprobe — a
     * subprocess, which the store deliberately knows nothing about. Doing it
     * here and inline means the row arrives in the bin already carrying its
     * duration, rather than appearing bare and filling in later or never.
     *
     * Cheap enough to be worth blocking on: ffprobe reads a header, not a file,
     * and `inspect` returns null immediately on a machine with no ffmpeg — the
     * capability answer is cached from boot. Returns the original row on any
     * failure, because a probe that fails is not an upload that fails: the
     * bytes are already safely on disk and the row is already correct without
     * it.
     */
    async function enrich(projectId: string, asset: AssetRef): Promise<AssetRef> {
      if (asset.kind !== 'video' && asset.kind !== 'audio') return asset;

      try {
        const file = await assetPath(projectId, asset.path.replace(/^assets\//, ''));
        const info = await inspect(file);
        if (!info) return asset;

        const enriched = await recordAssetProbe(projectId, asset.id, {
          ...(info.width !== null ? { width: info.width } : {}),
          ...(info.height !== null ? { height: info.height } : {}),
          ...(info.durationSeconds !== null ? { duration: info.durationSeconds } : {}),
          ...(info.codec !== null ? { codec: info.codec } : {}),
          hasAlpha: info.hasAlpha,
        });
        return enriched ?? asset;
      } catch {
        /* Metadata is a nicety; the upload succeeded. */
        return asset;
      }
    }

    scope.post<{ Params: { id: string }; Querystring: { name?: string; replaces?: string } }>(
      '/api/projects/:id/assets',
      { bodyLimit: MAX_ASSET_BYTES },
      async (req, reply) => {
        const name = req.query.name?.trim();
        if (!name) {
          reply.code(400);
          return { error: 'a ?name= query parameter carrying the original filename is required' };
        }

        const refused = refusedExtension(name);
        if (refused) {
          reply.code(415);
          return {
            error: `${refused} files are not accepted as assets — the assets directory is served to browsers`,
          };
        }

        const body = req.body;
        if (!Buffer.isBuffer(body) || body.byteLength === 0) {
          reply.code(400);
          return {
            error:
              'the request body must be the file itself. Send the bytes raw with any binary ' +
              'content type (application/octet-stream), not as a multipart form.',
          };
        }

        /*
         * `?replaces=` turns the upload into a Replace.
         *
         * A query parameter on the existing route rather than a route of its
         * own, because everything else about the request is identical — same
         * raw body, same 1 GB cap, same refused extensions, same probe — and a
         * second endpoint would be that whole list duplicated for the sake of
         * one extra argument.
         *
         * The server does not detect the collision itself, and that is
         * deliberate. It would have to be detected *after* the bytes arrived,
         * so a 409 asking "replace or keep both?" would mean re-uploading a
         * 400 MB stinger to answer a question — over a venue LAN, twice, while
         * a show waits. The editor knows the bin contents already, so it asks
         * before the first byte leaves and sends the answer with the upload.
         * An API client that does not ask keeps today's behavior exactly.
         */
        const replaces = req.query.replaces?.trim();

        try {
          if (replaces) {
            const result = await replaceAsset(req.params.id, replaces, name, body);
            reply.code(201);
            return {
              asset: await enrich(req.params.id, result.asset),
              replaced: result.retired,
              rewritten: result.rewritten,
              compositions: result.compositions,
            };
          }

          const asset = await saveAsset(req.params.id, name, body);
          reply.code(201);
          return { asset: await enrich(req.params.id, asset) };
        } catch (err) {
          if (err instanceof NotFoundError) {
            reply.code(404);
            return { error: err.message };
          }
          throw err;
        }
      },
    );
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/assets', async (req, reply) => {
    try {
      return { assets: await listAssets(req.params.id) };
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  /**
   * Forget an asset.
   *
   * Deliberately does not check whether a layer still references it. The
   * reference is a string in a composition, possibly in another composition in
   * the same project, possibly in one an operator has open and unsaved — so a
   * "safe delete" would be answering a question this endpoint cannot answer
   * completely, which is worse than not claiming to. The bin warns instead.
   */
  app.delete<{ Params: { id: string; assetId: string } }>(
    '/api/projects/:id/assets/:assetId',
    async (req, reply) => {
      try {
        await deleteAsset(req.params.id, req.params.assetId);
        reply.code(204);
        return null;
      } catch (err) {
        if (err instanceof NotFoundError) {
          reply.code(404);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  /** Exposed for the editor's client-side guard, so both sides agree. */
  app.get('/api/assets/limits', async () => ({
    maxBytes: MAX_ASSET_BYTES,
    refused: [...REFUSED],
  }));

  /* ------------------------------------------------------------- metadata */

  /**
   * Reject anything that is not an editable field, and anything of the wrong
   * shape, before it reaches the store.
   *
   * A 400 naming the offending key rather than a silent drop. Silently ignoring
   * `hasAlpha` in a PATCH body is how a caller comes to believe it set it — and
   * the derived fields are exactly the ones where a false belief is expensive:
   * an operator who thinks they have marked a flattened .mov as transparent
   * finds out over live pictures.
   */
  function checkEdit(body: unknown): { edit: AssetEdit } | { error: string } {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { error: 'the request body must be a JSON object of field → value' };
    }

    const edit: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (!(EDITABLE_ASSET_FIELDS as readonly string[]).includes(key)) {
        return {
          error:
            `"${key}" is not an editable field. Technical fields are derived from the ` +
            `file and cannot be set by hand. Editable: ${EDITABLE_ASSET_FIELDS.join(', ')}.`,
        };
      }

      if (value === null) {
        edit[key] = null;
        continue;
      }

      if (key === 'tags') {
        if (!Array.isArray(value) || value.some((t) => typeof t !== 'string')) {
          return { error: 'tags must be an array of strings' };
        }
      } else if (key === 'state') {
        if (!['draft', 'approved', 'retired'].includes(value as string)) {
          return { error: 'state must be one of draft, approved, retired' };
        }
      } else if (key === 'usage') {
        if (!['unrestricted', 'licensed', 'single-use'].includes(value as string)) {
          return { error: 'usage must be one of unrestricted, licensed, single-use' };
        }
      } else if (key === 'expiresAt') {
        if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
          return { error: 'expiresAt must be an ISO date string' };
        }
      } else if (typeof value !== 'string') {
        return { error: `${key} must be a string` };
      }

      edit[key] = value;
    }

    return { edit: edit as AssetEdit };
  }

  /** Edit one asset's descriptive, administrative or rights fields. */
  app.patch<{ Params: { id: string; assetId: string }; Body: unknown }>(
    '/api/projects/:id/assets/:assetId',
    async (req, reply) => {
      const checked = checkEdit(req.body);
      if ('error' in checked) {
        reply.code(400);
        return { error: checked.error };
      }

      try {
        // Read first so a bad id is a 404 rather than a silent no-op — an edit
        // that reports success and changed nothing is the worst answer here.
        await getAsset(req.params.id, req.params.assetId);
        const [asset] = await editAssets(req.params.id, [req.params.assetId], checked.edit);
        return { asset };
      } catch (err) {
        if (err instanceof NotFoundError) {
          reply.code(404);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  /**
   * Apply one edit to many assets.
   *
   * The whole point of a bulk edit is that it is one write: forty individual
   * PATCHes would each take the index lock in turn, and an operator filing a
   * shoot before a show would watch forty round trips. This is one lock, one
   * read, one write.
   *
   * Unknown ids are reported rather than ignored. A bulk edit that silently
   * touched thirty-eight of forty is one nobody would notice had failed.
   */
  app.patch<{
    Params: { id: string };
    Body: { ids?: unknown; edit?: unknown; addTags?: unknown };
  }>(
    '/api/projects/:id/assets',
    async (req, reply) => {
      const ids = req.body?.ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => typeof i !== 'string')) {
        reply.code(400);
        return { error: 'ids must be a non-empty array of asset ids' };
      }

      const checked = checkEdit(req.body?.edit ?? {});
      if ('error' in checked) {
        reply.code(400);
        return { error: checked.error };
      }

      const addTags = req.body?.addTags ?? [];
      if (!Array.isArray(addTags) || addTags.some((t) => typeof t !== 'string')) {
        reply.code(400);
        return { error: 'addTags must be an array of strings' };
      }

      try {
        const known = new Set((await listAssets(req.params.id)).map((a) => a.id));
        const unknown = (ids as string[]).filter((i) => !known.has(i));
        if (unknown.length > 0) {
          reply.code(404);
          return { error: `no such asset: ${unknown.join(', ')}` };
        }

        return {
          assets: await editAssets(
            req.params.id,
            ids as string[],
            checked.edit,
            addTags as string[],
          ),
        };
      } catch (err) {
        if (err instanceof NotFoundError) {
          reply.code(404);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  /**
   * The project's tag vocabulary.
   *
   * Served separately from the assets because it outlives them: a term stays
   * available as a suggestion after the last asset carrying it is deleted,
   * which is what stops the vocabulary re-fragmenting one typo at a time.
   */
  app.get<{ Params: { id: string } }>('/api/projects/:id/assets/tags', async (req, reply) => {
    try {
      return { tags: await assetVocabulary(req.params.id) };
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string }; Body: { tags?: unknown } }>(
    '/api/projects/:id/assets/tags',
    async (req, reply) => {
      const tags = req.body?.tags;
      if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
        reply.code(400);
        return { error: 'tags must be an array of strings' };
      }
      try {
        return { tags: await addVocabulary(req.params.id, tags as string[]) };
      } catch (err) {
        if (err instanceof NotFoundError) {
          reply.code(404);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  /* ---------------------------------------------------------------- usage */

  /**
   * Which compositions reference this asset.
   *
   * The question the bin could never answer. `referencedAssets` ran in the
   * editor against the composition currently open, so "in use" meant "in use
   * *here*" and the delete confirmation was explicit about not claiming more
   * than that. Asked across the project, it is what makes delete honest.
   *
   * Registered **before** the `:assetId` routes below is not required — Fastify
   * routes on a radix tree, not in declaration order — but `orphans` is a
   * static segment where an asset id would otherwise sit, and static wins over
   * parametric, so the two cannot collide.
   */
  app.get<{ Params: { id: string; assetId: string } }>(
    '/api/projects/:id/assets/:assetId/usage',
    async (req, reply) => {
      try {
        const asset = await getAsset(req.params.id, req.params.assetId);
        return { usage: await assetUsage(req.params.id, asset.path) };
      } catch (err) {
        if (err instanceof NotFoundError) {
          reply.code(404);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  /**
   * Assets nothing in the project references.
   *
   * The other direction, and the one that makes tidying a bin safe rather than
   * a guess. A transcode source shows up here once its WebM is what the graphic
   * points at, which is correct — that ProRes is exactly the file an operator
   * wants to find and archive off the graphics box.
   */
  app.get<{ Params: { id: string } }>('/api/projects/:id/assets/orphans', async (req, reply) => {
    try {
      return { assets: await orphanAssets(req.params.id) };
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  /* ------------------------------------------------------------ transcode */

  /**
   * What this machine can do.
   *
   * Answered even when ffmpeg is absent — especially then. The editor uses it
   * to explain *why* a Transcode button is disabled, which is the difference
   * between an operator installing ffmpeg and an operator filing a bug about a
   * greyed-out button.
   */
  app.get('/api/media/capabilities', async () => {
    const caps = await capabilities();
    return {
      available: caps.available && caps.vp9Alpha,
      version: caps.version,
      vp9Alpha: caps.vp9Alpha,
      reason: caps.reason,
    };
  });

  /**
   * Inspect a source before committing to a transcode.
   *
   * Duration, dimensions and — the one that matters — whether it actually
   * carries an alpha channel. Transcoding is minutes of CPU, and the commonest
   * wasted run is a `.mov` exported from the wrong preset with the transparency
   * already flattened. Better to say so before the queue than after.
   */
  app.get<{ Params: { id: string; assetId: string } }>(
    '/api/projects/:id/assets/:assetId/probe',
    async (req, reply) => {
      try {
        const asset = await getAsset(req.params.id, req.params.assetId);
        const file = await assetPath(req.params.id, asset.path.replace(/^assets\//, ''));
        const info = await inspect(file);
        if (!info) {
          reply.code(503);
          return { error: (await capabilities()).reason ?? 'ffprobe could not read this file' };
        }
        return { info };
      } catch (err) {
        if (err instanceof NotFoundError) {
          reply.code(404);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string; assetId: string } }>(
    '/api/projects/:id/assets/:assetId/transcode',
    async (req, reply) => {
      const caps = await capabilities();
      if (!caps.available || !caps.vp9Alpha) {
        // 503 rather than 400: the request is fine, the machine cannot serve it,
        // and it may be able to after an install and a restart.
        reply.code(503);
        return { error: caps.reason ?? 'transcoding is unavailable on this server' };
      }
      try {
        const job = await transcodes.enqueue(req.params.id, req.params.assetId);
        reply.code(202);
        return { job };
      } catch (err) {
        if (err instanceof NotFoundError) {
          reply.code(404);
          return { error: err.message };
        }
        reply.code(400);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id/transcodes', async (req) => ({
    jobs: transcodes.list(req.params.id),
  }));

  app.delete<{ Params: { id: string; jobId: string } }>(
    '/api/projects/:id/transcodes/:jobId',
    async (req, reply) => {
      if (!transcodes.cancel(req.params.jobId)) {
        reply.code(404);
        return { error: 'no such job, or it has already finished' };
      }
      reply.code(204);
      return null;
    },
  );
}
