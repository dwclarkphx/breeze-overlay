// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Sport templates on the server (Phase 9 Wave B, sports.ts).
 *
 *  - `GET /api/sports` — the catalogue: sports, rulesets, timers, scoring
 *    buttons and each table's columns, for a control surface building buttons.
 *  - `POST /api/projects/:id/datasources/:sourceId/game` — act on a sport's
 *    **game** table: `{ type: 'score', side, action }`, `unscore`, `point`,
 *    `adjust` (`column`, `delta`), `set` (`column`, `value`), `period`
 *    (`delta`), `reset`. GET with the same query parameters too, for a
 *    header-less button; gated either way, like every control action.
 *
 * The game state lives in the table, not on one graphic (decided 2026-10-25):
 * the scorebug, the full-screen recap and the lower third all read one row, so
 * a +2 reaches every one of them on the next push. Each action is a
 * read-modify-write of `datasources.json`, serialised per project so two taps
 * a frame apart both land.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  SIDES,
  SPORT_TABLES,
  SPORT_TEMPLATES,
  applyGameAction,
  newGameRow,
  sportRuleset,
  sportTableColumns,
  sportTemplate,
  type DataValue,
  type GameAction,
  type Side,
} from '@breeze/schema';

import type { DataRegistry } from '../data/registry.js';
import { getDataSource, putDataSource, withSourcesLock } from '../data/sources.js';
import { fail } from '../errors.js';

function params(req: FastifyRequest): Record<string, unknown> {
  const query = { ...(req.query as Record<string, unknown>) };
  delete query['key'];
  const body =
    req.method === 'POST' && req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  return { ...query, ...body };
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** A `GameAction` from request parameters, or the error code that says why not. */
export function readGameAction(p: Record<string, unknown>): GameAction | { error: string } {
  const type = str(p['type']);
  const side = str(p['side']) as Side;
  const needsSide = type === 'score' || type === 'unscore' || type === 'point';
  if (needsSide && !(SIDES as readonly string[]).includes(side)) return { error: 'error.gameSide' };
  switch (type) {
    case 'score':
    case 'unscore': {
      const action = str(p['action']);
      if (!action) return { error: 'error.gameScoring' };
      return { type, side, action };
    }
    case 'point':
      return { type, side };
    case 'adjust': {
      const column = str(p['column']);
      const delta = Number(p['delta']);
      if (!column || !Number.isFinite(delta)) return { error: 'error.gameColumn' };
      return { type, column, delta };
    }
    case 'set': {
      const column = str(p['column']);
      if (!column || !('value' in p)) return { error: 'error.gameColumn' };
      const raw = p['value'];
      const value: DataValue = typeof raw === 'number' || typeof raw === 'boolean' || raw === null ? raw : str(raw);
      return { type, column, value };
    }
    case 'period': {
      const delta = Number(p['delta'] ?? 1);
      return { type, delta: delta < 0 ? -1 : 1 };
    }
    case 'reset':
      return { type };
    default:
      return { error: 'error.gameAction' };
  }
}

export async function registerSportRoutes(app: FastifyInstance, registry: DataRegistry): Promise<void> {
  app.get('/api/sports', async () => ({
    tables: SPORT_TABLES,
    sports: SPORT_TEMPLATES.map((t) => ({
      id: t.id,
      group: t.group,
      labelKey: t.labelKey,
      prefix: t.prefix,
      scoring: t.scoring,
      actions: t.actions.map(({ id, label, adds }) => ({ id, label, adds })),
      rulesets: t.rulesets.map((r) => ({
        id: r.id,
        labelKey: r.labelKey,
        periods: r.periods,
        periodName: r.periodName,
        timers: r.timers,
        columns: Object.fromEntries(SPORT_TABLES.map((table) => [table, sportTableColumns(t, r, table)])),
      })),
    })),
  }));

  const game = async (req: FastifyRequest<{ Params: { id: string; sourceId: string } }>, reply: FastifyReply) => {
    const parsed = readGameAction(params(req));
    if ('error' in parsed) {
      reply.code(400);
      return fail(parsed.error);
    }
    return withSourcesLock(req.params.id, async () => {
      const def = await getDataSource(req.params.id, req.params.sourceId);
      const sport = def.template ? sportTemplate(def.template.sport) : undefined;
      if (def.type !== 'manual' || !def.template || def.template.table !== 'game' || !sport) {
        reply.code(409);
        return fail('error.gameNotGameTable', { source: def.id });
      }
      const ruleset = sportRuleset(sport, def.template.ruleset);
      const before = def.rows[0] ?? newGameRow(sport, ruleset);
      const row = applyGameAction(sport, ruleset, before, parsed);
      const next = { ...def, rows: [row, ...def.rows.slice(1)] };
      await putDataSource(req.params.id, next);
      await registry.upsert(req.params.id, next);
      return { ok: true, source: def.id, action: parsed, row };
    });
  };
  app.get<{ Params: { id: string; sourceId: string } }>('/api/projects/:id/datasources/:sourceId/game', game);
  app.post<{ Params: { id: string; sourceId: string } }>('/api/projects/:id/datasources/:sourceId/game', game);
}
