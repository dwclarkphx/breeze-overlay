// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Data-source API.
 *
 * CRUD over the definitions, plus the two things the editor actually needs to
 * build a source against a feed it has never seen: `preview`, which fetches a
 * candidate URL without saving anything, and `refresh`, which forces a poll.
 */

import type { FastifyInstance } from 'fastify';

import {
  MIN_POLL_INTERVAL,
  applyTransforms,
  type DataSourceDef,
  type DataTransform,
} from '@breeze/schema';

import type { DataRegistry } from '../data/registry.js';
import { loadDataSource } from '../data/registry.js';
import { guessRowPath } from '../data/parse.js';
import { feedTitle, inspectXml } from '../data/parse-xml.js';
import {
  assertSafeSourceId,
  deleteDataSource,
  effectiveInterval,
  getDataSource,
  putDataSource,
  readDataSources,
  redact,
} from '../data/sources.js';
import { fetchText } from '../data/fetch.js';
import { NotFoundError, readProject } from '../store.js';

interface ProjectParams {
  id: string;
}
interface SourceParams extends ProjectParams {
  sourceId: string;
}

export async function registerDataSourceRoutes(
  app: FastifyInstance,
  registry: DataRegistry,
): Promise<void> {
  /* --------------------------------------------------------------- read */

  app.get<{ Params: ProjectParams; Querystring: { rows?: string } }>(
    '/api/projects/:id/datasources',
    async (req) => {
      await readProject(req.params.id);
      const defs = await readDataSources(req.params.id);

      /*
       * `?rows=N` includes each source's rows, capped at N.
       *
       * Added for the editor's stage preview, which has to render source-fed
       * layers with the *real* rows — a ticker bound to a feed showed its
       * placeholder while authoring, because the panel only ever needed column
       * names and that is all this returned. Fetching them per source would be
       * a request per source on every project load; they come down with the
       * list they belong to instead.
       *
       * Off by default. The data panel polls this every five seconds while it
       * is open, and shipping every row of every source on that interval to
       * populate a health readout would be pure waste.
       */
      const rowLimit = req.query.rows === undefined ? 0 : clampRows(req.query.rows);

      /*
       * Definitions and health together, in one response.
       *
       * The editor's data panel shows them side by side and would otherwise fan
       * out a status request per source on every render. More to the point, the
       * two must agree: a source whose def says "every 10s" and whose status says
       * "last fetch 40 minutes ago" is the exact picture an operator needs, and
       * assembling it from two round trips invites showing a stale half of it.
       */
      return {
        sources: defs.map((def) => {
          const entry = registry.get(req.params.id, def.id);
          const rows = entry?.data.rows ?? [];
          return {
            def: redact(def),
            interval: effectiveInterval(def),
            status: entry?.status ?? { id: def.id, revision: 0, rowCount: 0 },
            columns: entry?.data.columns ?? [],
            rowCount: rows.length,
            ...(rowLimit > 0
              ? {
                  data: {
                    id: def.id,
                    columns: entry?.data.columns ?? [],
                    rows: rows.slice(0, rowLimit),
                    ...(entry?.data.revision !== undefined
                      ? { revision: entry.data.revision }
                      : {}),
                  },
                  truncated: rows.length > rowLimit,
                }
              : {}),
          };
        }),
        minPollInterval: MIN_POLL_INTERVAL,
      };
    },
  );

  app.get<{ Params: SourceParams; Querystring: { rows?: string } }>(
    '/api/projects/:id/datasources/:sourceId',
    async (req) => {
      const def = await getDataSource(req.params.id, req.params.sourceId);
      const entry = registry.get(req.params.id, req.params.sourceId);
      const limit = Number(req.query.rows ?? '200');
      const data = entry?.data ?? { id: def.id, columns: [], rows: [] };
      return {
        def: redact(def),
        interval: effectiveInterval(def),
        status: entry?.status ?? { id: def.id, revision: 0, rowCount: 0 },
        data: { ...data, rows: data.rows.slice(0, Number.isFinite(limit) ? limit : 200) },
        truncated: data.rows.length > limit,
      };
    },
  );

  /* -------------------------------------------------------------- write */

  app.put<{ Params: SourceParams; Body: DataSourceDef }>(
    '/api/projects/:id/datasources/:sourceId',
    async (req) => {
      await readProject(req.params.id);
      assertSafeSourceId(req.params.sourceId);
      const def = { ...req.body, id: req.params.sourceId };
      await putDataSource(req.params.id, def);
      // Registered immediately, so a manual table is queryable and an HTTP
      // source has fired its first poll before the editor asks for a preview.
      const entry = await registry.upsert(req.params.id, def);
      if (def.type !== 'manual') await registry.refresh(req.params.id, def.id);
      return { def: redact(def), status: entry.status, interval: effectiveInterval(def) };
    },
  );

  app.delete<{ Params: SourceParams }>(
    '/api/projects/:id/datasources/:sourceId',
    async (req, reply) => {
      await deleteDataSource(req.params.id, req.params.sourceId);
      registry.remove(req.params.id, req.params.sourceId);
      reply.code(204);
      return null;
    },
  );

  /* ------------------------------------------------------------ actions */

  app.post<{ Params: SourceParams }>(
    '/api/projects/:id/datasources/:sourceId/refresh',
    async (req) => {
      await getDataSource(req.params.id, req.params.sourceId);
      if (!registry.get(req.params.id, req.params.sourceId)) {
        await registry.register(req.params.id);
      }
      const entry = await registry.refresh(req.params.id, req.params.sourceId);
      return { status: entry.status, data: entry.data };
    },
  );

  /**
   * Fetch a candidate source without saving it.
   *
   * This is what makes the path picker usable: paste a URL, see the columns and
   * the first rows, then decide. Nothing is written and nothing is scheduled, so
   * a URL that turns out to be wrong leaves no poller behind. The SSRF guard
   * applies here exactly as it does to a saved source — an unsaved fetch is
   * still a fetch this server makes.
   */
  app.post<{ Params: ProjectParams; Body: { def: DataSourceDef; transforms?: DataTransform[] } }>(
    '/api/projects/:id/datasources-preview',
    async (req, reply) => {
      const def = req.body?.def;
      if (!def || !def.type) {
        reply.code(400);
        return { error: 'a data source definition is required' };
      }

      try {
        const result = await loadDataSource({ ...def, id: def.id || 'preview' });
        const data = result.data ?? { id: def.id || 'preview', columns: [], rows: [] };
        const shaped = applyTransforms(data, req.body.transforms ?? []);
        return {
          ok: true,
          data: { ...shaped, rows: shaped.rows.slice(0, 50) },
          rowCount: shaped.rows.length,
          truncated: shaped.rows.length > 50,
        };
      } catch (err) {
        // 200 with `ok: false`. The editor renders this into the panel beside
        // the URL field; a 4xx would make it an exception to handle rather than
        // a message to show, and a bad URL while typing one is not exceptional.
        reply.code(200);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  /**
   * Fetch a JSON URL and suggest where the rows are. Used once, when a source
   * is first pointed at a feed; a saved source always carries an explicit path.
   */
  app.post<{ Params: ProjectParams; Body: { url: string; headers?: Record<string, string> } }>(
    '/api/projects/:id/datasources-inspect',
    async (req, reply) => {
      const url = req.body?.url;
      if (!url) {
        reply.code(400);
        return { error: 'a url is required' };
      }
      try {
        const result = await fetchText(url, req.body.headers ? { headers: req.body.headers } : {});
        const payload: unknown = JSON.parse(result.body ?? 'null');
        return { ok: true, rowPath: guessRowPath(payload) ?? '', sample: sample(payload) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  /**
   * The XML equivalent, and it returns more than its JSON sibling does.
   *
   * A JSON feed's rows are usually the one obvious array, so a single suggested
   * path is enough. An XML export rarely is — `results/game`, `results/game/team`
   * and `results/game/team/player` are all repeating, all plausible, and which
   * one is "a row" is a question only the person building the graphic can
   * answer. So the candidates come back with their counts and the panel offers
   * them as a list. `feed` is included so the editor can tell someone who picked
   * Generic XML that they pasted an RSS URL and should use the feed type.
   */
  app.post<{ Params: ProjectParams; Body: { url: string; headers?: Record<string, string> } }>(
    '/api/projects/:id/datasources-inspect-xml',
    async (req, reply) => {
      const url = req.body?.url;
      if (!url) {
        reply.code(400);
        return { error: 'a url is required' };
      }
      try {
        const result = await fetchText(url, req.body.headers ? { headers: req.body.headers } : {});
        const body = result.body ?? '';
        const found = inspectXml(body);
        return {
          ok: true,
          rowPath: found.rowPath,
          feed: found.feed,
          candidates: found.candidates,
          title: found.feed ? feedTitle(body) : '',
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}

/**
 * Row cap for the list endpoint.
 *
 * Bounded server-side rather than trusted from the query string: this is what
 * stands between an editor page and a source that has grown to a hundred
 * thousand rows. 2000 is far more than any graphic renders and small enough to
 * stay a normal JSON response.
 */
export const MAX_LIST_ROWS = 2000;

export function clampRows(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), MAX_LIST_ROWS);
}

/**
 * A shallow slice of a payload, so the editor can show its shape without
 * shipping a megabyte of feed into a browser to render a tree view.
 */
function sample(value: unknown, depth = 0): unknown {
  if (depth > 3 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 2).map((v) => sample(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    out[key] = sample(v, depth + 1);
  }
  return out;
}

export { NotFoundError };
