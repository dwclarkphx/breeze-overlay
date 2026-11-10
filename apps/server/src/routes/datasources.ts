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
 *
 * Every route here exists twice (0.80.0): under `/api/projects/:id/…` for a
 * project's sources, and under `/api/server/…` for the server-level ones that
 * projects link to. One set of handlers, mounted on both prefixes — the Data
 * sources page is the editor's own source form pointed at the other prefix,
 * and two implementations would be two forms that drift.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  MIN_POLL_INTERVAL,
  SERVER_SCOPE,
  SOURCE_USES,
  applyGuard,
  applyTransforms,
  canBeServerSource,
  isInlineSource,
  isLinkSource,
  isPolledSource,
  placesSourceOf,
  type DataSourceDef,
  type LinkDataSource,
  type SourceUse,
  type DataTransform,
} from '@breeze/schema';

import type { DataEntry, DataRegistry } from '../data/registry.js';
import { loadDataSource } from '../data/registry.js';
import { guessRowPath } from '../data/parse.js';
import { feedTitle, inspectXml } from '../data/parse-xml.js';
import {
  assertSafeSourceId,
  deleteDataSource,
  effectiveInterval,
  getDataSource,
  isServerScope,
  putDataSource,
  readDataSources,
  redact,
  withSourcesLock,
} from '../data/sources.js';
import { actorOf, record } from '../audit.js';
import { fetchText } from '../data/fetch.js';
import { NotFoundError, listProjects, readProject } from '../store.js';

/** `id` is the project; absent on the `/api/server` mount, where the scope is the server's. */
interface ProjectParams {
  id?: string;
}
interface SourceParams extends ProjectParams {
  sourceId: string;
}

/** The two mounts: a project's sources, and the server's. */
export const PROJECT_SOURCES_PREFIX = '/api/projects/:id';
export const SERVER_SOURCES_PREFIX = '/api/server';

const scopeOf = (params: ProjectParams): string => params.id ?? SERVER_SCOPE;

/** 404 for a project that is not there. The server scope always is. */
async function ensureScope(scope: string): Promise<void> {
  if (!isServerScope(scope)) await readProject(scope);
}

const EMPTY_STATUS = (id: string) => ({ id, revision: 0, rowCount: 0 });

/** What a link points at, for a list row: enough to name it and say what kind it is. */
function linkedSummary(registry: DataRegistry, def: DataSourceDef): { linked?: { id: string; name: string; type: string; interval: number } | null } {
  if (!isLinkSource(def)) return {};
  const target = registry.get(SERVER_SCOPE, def.source);
  return {
    linked: target
      ? { id: target.def.id, name: target.def.name, type: target.def.type, interval: effectiveInterval(target.def) }
      : null,
  };
}

/** A refresh on request, held to the source's poll floor (`DataRegistry.refreshDueIn`). */
async function refreshWithinLimits(
  registry: DataRegistry,
  scope: string,
  sourceId: string,
): Promise<{ entry: DataEntry; retryIn?: number }> {
  const wait = registry.refreshDueIn(scope, sourceId);
  if (wait > 0) return { entry: registry.get(scope, sourceId)!, retryIn: Math.ceil(wait / 1000) };
  return { entry: await registry.refresh(scope, sourceId) };
}

export async function registerDataSourceRoutes(
  app: FastifyInstance,
  registry: DataRegistry,
): Promise<void> {
  mountSourceRoutes(app, registry, PROJECT_SOURCES_PREFIX);
  mountSourceRoutes(app, registry, SERVER_SOURCES_PREFIX);

  /**
   * Every source on this server, for the Data sources page: the server-level
   * ones with the projects linked to each, then each project's own.
   *
   * One call rather than one per project, on the argument the per-project list
   * already makes — the page shows definitions and health side by side, and
   * here also across projects.
   */
  app.get('/api/sources', async () => {
    const projects = await listProjects();
    const nameOf = new Map(projects.map((p) => [p.id, p.name]));
    const row = (scope: string, def: DataSourceDef) => {
      const entry = registry.get(scope, def.id);
      return {
        def: redact(def),
        interval: effectiveInterval(def),
        status: entry?.status ?? EMPTY_STATUS(def.id),
        columns: entry?.data.columns ?? [],
        rowCount: entry?.data.rows.length ?? 0,
        ...linkedSummary(registry, def),
      };
    };
    const server = (await readDataSources(SERVER_SCOPE)).map((def) => ({
      ...row(SERVER_SCOPE, def),
      refreshIn: Math.ceil(registry.refreshDueIn(SERVER_SCOPE, def.id) / 1000),
      links: registry
        .linksTo(def.id)
        .map((l) => ({ project: l.projectId, projectName: nameOf.get(l.projectId) ?? l.projectId, id: l.id, name: l.name }))
        .sort((a, b) => a.projectName.localeCompare(b.projectName)),
    }));
    const local = [];
    for (const project of projects) {
      const defs = (await readDataSources(project.id)).filter((def) => !isLinkSource(def));
      if (defs.length === 0) continue;
      local.push({
        id: project.id,
        name: project.name,
        sources: defs.map((def) => ({
          ...row(project.id, def),
          refreshIn: Math.ceil(registry.refreshDueIn(project.id, def.id) / 1000),
        })),
      });
    }
    return { server, projects: local, minPollInterval: MIN_POLL_INTERVAL };
  });

  /**
   * Move a project's source to the server level, leaving a link in its place.
   *
   * The link keeps the source's id, so every layer bound to it, every backup
   * and places table naming it, goes on working without being touched; and the
   * registry's entry for that id keeps its rows across the change, so nothing
   * on air blinks while the server-level source makes its first fetch.
   *
   * A backup stays with the project: it names a source in the project, which
   * the server scope cannot see, so it rides on the link instead.
   */
  app.post<{ Params: { id: string; sourceId: string } }>(
    '/api/projects/:id/datasources/:sourceId/move-to-server',
    async (req, reply) => {
      const projectId = req.params.id;
      await readProject(projectId);
      return withSourcesLock(SERVER_SCOPE, () =>
        withSourcesLock(projectId, async () => {
          const def = await getDataSource(projectId, req.params.sourceId);
          if (!canBeServerSource(def)) {
            reply.code(409);
            return {
              error: isLinkSource(def)
                ? `"${def.name}" is already a link to a server-level source`
                : `"${def.name}" holds this project's own rows — only fetched sources can be server-level`,
            };
          }
          const places = placesSourceOf(def);
          if (places !== undefined) {
            reply.code(409);
            return {
              error: `"${def.name}" reads its places from the table "${places}" in this project, which a server-level source cannot see — give it its places directly first`,
            };
          }

          const taken = new Set((await readDataSources(SERVER_SCOPE)).map((s) => s.id));
          let serverId = def.id;
          // Its own id if that is free, so the two lists read the same.
          for (let n = 2; taken.has(serverId); n += 1) serverId = `${def.id.slice(0, 60)}-${n}`;

          const { fallback, fallbackOn, ...rest } = def;
          const moved = { ...rest, id: serverId } as DataSourceDef;
          const link: LinkDataSource = {
            id: def.id,
            name: def.name,
            type: 'link',
            source: serverId,
            ...(fallback !== undefined ? { fallback } : {}),
            ...(fallback !== undefined && fallbackOn !== undefined ? { fallbackOn } : {}),
          };

          // Server first: a link to a source that is not there yet is the one
          // state worth never being in, even for a moment.
          await putDataSource(SERVER_SCOPE, moved);
          await registry.upsert(SERVER_SCOPE, moved);
          await putDataSource(projectId, link);
          await registry.upsert(projectId, link);
          await registry.refresh(SERVER_SCOPE, serverId);

          void record({
            action: 'source.move',
            actor: actorOf(req),
            project: projectId,
            name: def.name,
            detail: { source: def.id, server: serverId },
          });
          const entry = registry.get(projectId, link.id);
          return {
            def: link,
            status: entry?.status ?? EMPTY_STATUS(link.id),
            server: redact(moved),
          };
        }),
      );
    },
  );
}

function mountSourceRoutes(app: FastifyInstance, registry: DataRegistry, prefix: string): void {
  /* --------------------------------------------------------------- read */

  app.get<{ Params: ProjectParams; Querystring: { rows?: string } }>(
    `${prefix}/datasources`,
    async (req) => {
      const scope = scopeOf(req.params);
      await ensureScope(scope);
      const defs = await readDataSources(scope);

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
          const entry = registry.get(scope, def.id);
          const rows = entry?.data.rows ?? [];
          return {
            def: redact(def),
            interval: effectiveInterval(def),
            status: entry?.status ?? EMPTY_STATUS(def.id),
            columns: entry?.data.columns ?? [],
            rowCount: rows.length,
            // A link names what it points at, or `null` when that is missing.
            ...linkedSummary(registry, def),
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
    `${prefix}/datasources/:sourceId`,
    async (req) => {
      const scope = scopeOf(req.params);
      const def = await getDataSource(scope, req.params.sourceId);
      const entry = registry.get(scope, req.params.sourceId);
      const limit = Number(req.query.rows ?? '200');
      const data = entry?.data ?? { id: def.id, columns: [], rows: [] };
      return {
        def: redact(def),
        interval: effectiveInterval(def),
        status: entry?.status ?? EMPTY_STATUS(def.id),
        data: { ...data, rows: data.rows.slice(0, Number.isFinite(limit) ? limit : 200) },
        truncated: data.rows.length > limit,
        ...linkedSummary(registry, def),
      };
    },
  );

  /* -------------------------------------------------------------- write */

  app.put<{ Params: SourceParams; Body: DataSourceDef }>(
    `${prefix}/datasources/:sourceId`,
    async (req, reply) => {
      const scope = scopeOf(req.params);
      await ensureScope(scope);
      assertSafeSourceId(req.params.sourceId);
      const def = { ...req.body, id: req.params.sourceId };

      if (isServerScope(scope)) {
        // Answered here as a 400 with the reason; `writeDataSources` holds the
        // same line for every other way of writing the file.
        if (!canBeServerSource(def)) {
          reply.code(400);
          return {
            error: isLinkSource(def)
              ? 'a server-level data source cannot itself be a link'
              : `a ${def.type} source belongs to a project — only fetched sources can be server-level`,
          };
        }
      } else if (isLinkSource(def)) {
        // A link to nothing would save, sit there, and show an error for ever.
        if (!registry.get(SERVER_SCOPE, def.source) && !(await readDataSources(SERVER_SCOPE)).some((s) => s.id === def.source)) {
          reply.code(409);
          return { error: `there is no server-level data source "${def.source}" to link to` };
        }
      }

      await putDataSource(scope, def);
      // Registered immediately, so a manual table is queryable and an HTTP
      // source has fired its first poll before the editor asks for a preview.
      const entry = await registry.upsert(scope, def);
      if (isPolledSource(def)) await registry.refresh(scope, def.id);
      return { def: redact(def), status: entry.status, interval: effectiveInterval(def), ...linkedSummary(registry, def) };
    },
  );

  app.delete<{ Params: SourceParams }>(
    `${prefix}/datasources/:sourceId`,
    async (req, reply) => {
      const scope = scopeOf(req.params);
      /*
       * A server-level source cannot be deleted while a project links to it.
       *
       * This is the asymmetry that made the shared asset store copy rather
       * than link (ASSETS.md §3): a central delete reaches projects nobody has
       * open, mid-show. Refusing with the list is the other way to close it,
       * and the one that keeps a single poll per source. Read from disk, not
       * the registry, so a project that failed to register still counts.
       */
      if (isServerScope(scope)) {
        const links = [];
        for (const project of await listProjects()) {
          for (const def of await readDataSources(project.id)) {
            if (isLinkSource(def) && def.source === req.params.sourceId) {
              links.push({ project: project.id, projectName: project.name, id: def.id, name: def.name });
            }
          }
        }
        if (links.length > 0) {
          const names = [...new Set(links.map((l) => l.projectName))].sort((a, b) => a.localeCompare(b));
          reply.code(409);
          return {
            error: `this source is linked from ${names.length === 1 ? 'a project' : `${names.length} projects`} (${names.join(', ')}) — unlink it there first`,
            links,
          };
        }
      }
      await deleteDataSource(scope, req.params.sourceId);
      registry.remove(scope, req.params.sourceId);
      reply.code(204);
      return null;
    },
  );

  /* ------------------------------------------------------------ actions */

  /**
   * Fetch now — within the source's limits (0.80.0).
   *
   * A source fetched less than its poll floor ago is not fetched again: the
   * answer carries `throttled.retryIn` (seconds) beside the rows it already
   * has, with a 200, because "asked too soon" is information for a button to
   * show, not a failure. The floor is the provider's for weather, air quality
   * and alerts, and `MIN_POLL_INTERVAL` for everything else — the same clamp
   * the scheduler works under, so no button, script or Stream Deck key can
   * poll a provider faster than a saved interval could.
   */
  app.post<{ Params: SourceParams }>(
    `${prefix}/datasources/:sourceId/refresh`,
    async (req) => {
      const scope = scopeOf(req.params);
      await getDataSource(scope, req.params.sourceId);
      if (!registry.get(scope, req.params.sourceId)) {
        await registry.register(scope);
      }
      const { entry, retryIn } = await refreshWithinLimits(registry, scope, req.params.sourceId);
      return {
        status: entry.status,
        data: entry.data,
        ...(retryIn !== undefined ? { throttled: { retryIn } } : {}),
      };
    },
  );

  /**
   * Choose whose rows go on air: `auto`, `primary` or `backup` (CYCLE.md,
   * Wave 5) — the operator's switch for a feed that is up and wrong, which no
   * guard can see.
   *
   * GET as well as POST for header-less panels, and gated either way: the auth
   * hook treats `…/use` as an action, because a GET that changes what is on
   * air is a write.
   */
  const use = async (
    req: FastifyRequest<{ Params: SourceParams; Querystring: { mode?: string } }>,
    reply: FastifyReply,
  ) => {
    const body = req.body && typeof req.body === 'object' ? (req.body as { mode?: unknown }) : {};
    const mode = String(body.mode ?? req.query.mode ?? '').trim().toLowerCase();
    if (!(SOURCE_USES as readonly string[]).includes(mode)) {
      reply.code(400);
      return { error: `mode must be one of ${SOURCE_USES.join(', ')}` };
    }
    const scope = scopeOf(req.params);
    const def = await getDataSource(scope, req.params.sourceId);
    if (mode === 'backup' && def.fallback === undefined) {
      reply.code(409);
      return {
        error: isLinkSource(def)
          ? `"${def.name}" is a link with no backup of its own in this project — switch the server-level source on the Data sources page`
          : `data source "${def.id}" has no backup to use`,
      };
    }
    if (!registry.get(scope, def.id)) await registry.register(scope);
    const entry = registry.setUse(scope, def.id, mode as SourceUse);
    // Logged: "who put the backup on air at 3 a.m." is a question someone asks.
    void record({
      action: 'source.use',
      actor: actorOf(req),
      ...(isServerScope(scope) ? {} : { project: scope }),
      name: def.name,
      detail: { source: def.id, mode, ...(isServerScope(scope) ? { server: true } : {}) },
    });
    return { status: entry.status };
  };
  app.get<{ Params: SourceParams; Querystring: { mode?: string } }>(`${prefix}/datasources/:sourceId/use`, use);
  app.post<{ Params: SourceParams; Querystring: { mode?: string } }>(`${prefix}/datasources/:sourceId/use`, use);

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
    `${prefix}/datasources-preview`,
    async (req, reply) => {
      const scope = scopeOf(req.params);
      const def = req.body?.def;
      if (!def || !def.type) {
        reply.code(400);
        return { error: 'a data source definition is required' };
      }

      try {
        // A table-fed source previews against the project's live tables, so
        // "read places from Cities" shows real cities before it is saved.
        const result = await loadDataSource({ ...def, id: def.id || 'preview' }, undefined, {
          lookup: (sourceId) => registry.get(scope, sourceId)?.data,
        });
        const fetched = result.data ?? { id: def.id || 'preview', columns: [], rows: [] };
        /*
         * The guard, as the registry would apply it — minus the row-count drop,
         * which needs a last-good a preview does not have. A refusal still
         * shows the rows: the author needs to see what the guard objected to.
         */
        const guard = isInlineSource(def) ? undefined : def.guard;
        const checked = applyGuard(guard, fetched);
        const data = checked.ok ? checked.data : fetched;
        // A lookup or union in the pipeline reads the project's other live sources.
        const shaped = applyTransforms(data, req.body.transforms ?? [], {
          now: new Date(),
          source: (sourceId) => registry.get(scope, sourceId)?.data,
        });
        return {
          ok: true,
          data: { ...shaped, rows: shaped.rows.slice(0, 50) },
          rowCount: shaped.rows.length,
          truncated: shaped.rows.length > 50,
          ...(result.warning ? { warning: result.warning } : {}),
          ...(!checked.ok ? { refused: checked.reason } : {}),
          ...(checked.ok && checked.dropped ? { dropped: checked.dropped } : {}),
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
    `${prefix}/datasources-inspect`,
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
    `${prefix}/datasources-inspect-xml`,
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
