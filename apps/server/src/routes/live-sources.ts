// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Sources an operator changes on air (Phase 9 Wave R, ROLLS.md §3, CHARTS.md §5).
 *
 *  - `PUT /api/projects/:id/datasources/:sourceId/text` — replace a text
 *    source's body: `{ body }`. Only a text kept in the project, and only when
 *    its designer ticked **Operator changeable** (decided 2026-10-26).
 *  - `POST /api/projects/:id/datasources/:sourceId/poll` — act on a poll:
 *    `vote` (`option`, `delta`, default +1), `set` (`option`, `value`), `open`,
 *    `close`, `reset`. GET with the same query parameters too, for a
 *    header-less button; gated either way, like every control action.
 *  - `PUT /api/projects/:id/datasources/:sourceId/poll` — change the question
 *    and options, when the poll is operator changeable. Votes for an option
 *    that remains are kept.
 *
 * Each is a read-modify-write of `datasources.json` on the lock score taps use
 * (`withSourcesLock`), and each re-registers the source, so every graphic
 * reading it has the new rows on the next push.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  POLL_ACTIONS,
  POLL_OPTIONS_MAX,
  POLL_OPTION_ID_PATTERN,
  TEXT_BODY_MAX_BYTES,
  applyPollAction,
  pollActionProblem,
  pollDataSet,
  pollDefProblems,
  textBodyProblem,
  type PollAction,
  type PollDataSource,
  type PollOption,
} from '@breeze/schema';

import { actorOf, record } from '../audit.js';
import type { DataRegistry } from '../data/registry.js';
import { getDataSource, putDataSource, withSourcesLock } from '../data/sources.js';
import { fail } from '../errors.js';

type SourceParams = { id: string; sourceId: string };

function params(req: FastifyRequest): Record<string, unknown> {
  const query = { ...(req.query as Record<string, unknown>) };
  delete query['key'];
  const body =
    req.method !== 'GET' && req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  return { ...query, ...body };
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** A `PollAction` from request parameters, or the error code that says why not. */
export function readPollAction(p: Record<string, unknown>): PollAction | { error: string } {
  const type = str(p['type'] ?? p['action']);
  if (!(POLL_ACTIONS as readonly string[]).includes(type)) return { error: 'error.pollAction' };
  const option = str(p['option']);
  switch (type) {
    case 'vote': {
      if (!option) return { error: 'error.pollOption' };
      const raw = p['delta'];
      const delta = raw === undefined || raw === '' ? 1 : Number(raw);
      if (!Number.isFinite(delta)) return { error: 'error.pollValue' };
      return { type, option, delta };
    }
    case 'set': {
      if (!option) return { error: 'error.pollOption' };
      const value = Number(p['value']);
      if (!Number.isFinite(value)) return { error: 'error.pollValue' };
      return { type, option, value };
    }
    case 'open':
    case 'close':
    case 'reset':
      return { type };
    default:
      return { error: 'error.pollAction' };
  }
}

/** Options from a request, cleaned, or an error code. */
function readOptions(raw: unknown): PollOption[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > POLL_OPTIONS_MAX) return { error: 'error.pollOptions' };
  const out: PollOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { error: 'error.pollOptions' };
    const o = item as Record<string, unknown>;
    const id = str(o['id']);
    if (!POLL_OPTION_ID_PATTERN.test(id)) return { error: 'error.pollOptions' };
    const color = str(o['color']);
    const image = str(o['image']);
    out.push({ id, label: str(o['label']), ...(color ? { color } : {}), ...(image ? { image } : {}) });
  }
  return out;
}

export async function registerLiveSourceRoutes(app: FastifyInstance, registry: DataRegistry): Promise<void> {
  app.put<{ Params: SourceParams }>('/api/projects/:id/datasources/:sourceId/text', async (req, reply) => {
    const raw = typeof req.body === 'string' ? req.body : (req.body as { body?: unknown } | undefined)?.body;
    if (typeof raw !== 'string') {
      reply.code(400);
      return fail('error.textBody');
    }
    if (textBodyProblem(raw)) {
      reply.code(413);
      return fail('error.textTooLong', { limit: Math.round(TEXT_BODY_MAX_BYTES / 1024) });
    }
    return withSourcesLock(req.params.id, async () => {
      const def = await getDataSource(req.params.id, req.params.sourceId);
      if (def.type !== 'text') {
        reply.code(409);
        return fail('error.textNotText', { source: def.id });
      }
      if (def.url !== undefined) {
        reply.code(409);
        return fail('error.textFetched', { source: def.id });
      }
      if (!def.operatorEditable) {
        reply.code(403);
        return fail('error.textNotEditable', { source: def.id });
      }
      const next = { ...def, body: raw };
      await putDataSource(req.params.id, next);
      const entry = await registry.upsert(req.params.id, next);
      // Logged: a lyric changed on air is a question someone asks afterwards.
      void record({
        action: 'source.text',
        actor: actorOf(req),
        project: req.params.id,
        name: def.name,
        detail: { source: def.id, rows: entry.data.rows.length },
      });
      return { ok: true, source: def.id, rows: entry.data.rows.length };
    });
  });

  const act = async (req: FastifyRequest<{ Params: SourceParams }>, reply: FastifyReply) => {
    const parsed = readPollAction(params(req));
    if ('error' in parsed) {
      reply.code(400);
      return fail(parsed.error);
    }
    return withSourcesLock(req.params.id, async () => {
      const def = await getDataSource(req.params.id, req.params.sourceId);
      if (def.type !== 'poll') {
        reply.code(409);
        return fail('error.pollNotPoll', { source: def.id });
      }
      const problem = pollActionProblem(def, parsed);
      if (problem) {
        reply.code(400);
        return fail(problem, { source: def.id });
      }
      const next = applyPollAction(def, parsed);
      await putDataSource(req.params.id, next);
      await registry.upsert(req.params.id, next);
      // Opening, closing and resetting are logged; single votes would bury them.
      if (parsed.type === 'open' || parsed.type === 'close' || parsed.type === 'reset') {
        void record({
          action: 'source.poll',
          actor: actorOf(req),
          project: req.params.id,
          name: def.name,
          detail: { source: def.id, action: parsed.type },
        });
      }
      return { ok: true, source: def.id, action: parsed, rows: pollDataSet(next).rows };
    });
  };
  app.get<{ Params: SourceParams }>('/api/projects/:id/datasources/:sourceId/poll', act);
  app.post<{ Params: SourceParams }>('/api/projects/:id/datasources/:sourceId/poll', act);

  app.put<{ Params: SourceParams }>('/api/projects/:id/datasources/:sourceId/poll', async (req, reply) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const question = body['question'];
    if (question !== undefined && typeof question !== 'string') {
      reply.code(400);
      return fail('error.pollQuestion');
    }
    const options = body['options'] !== undefined ? readOptions(body['options']) : undefined;
    if (options && 'error' in options) {
      reply.code(400);
      return fail(options.error);
    }
    return withSourcesLock(req.params.id, async () => {
      const def = await getDataSource(req.params.id, req.params.sourceId);
      if (def.type !== 'poll') {
        reply.code(409);
        return fail('error.pollNotPoll', { source: def.id });
      }
      if (!def.operatorEditable) {
        reply.code(403);
        return fail('error.pollNotEditable', { source: def.id });
      }
      const nextOptions = options ?? def.options;
      const kept = new Set(nextOptions.map((o) => o.id));
      const votes = Object.fromEntries(Object.entries(def.votes ?? {}).filter(([id]) => kept.has(id)));
      const next: PollDataSource = {
        ...def,
        ...(typeof question === 'string' ? { question: question.trim() } : {}),
        options: nextOptions,
        votes,
      };
      if (pollDefProblems(next).length) {
        reply.code(400);
        return fail('error.pollOptions');
      }
      await putDataSource(req.params.id, next);
      await registry.upsert(req.params.id, next);
      void record({
        action: 'source.poll',
        actor: actorOf(req),
        project: req.params.id,
        name: def.name,
        detail: { source: def.id, action: 'edit' },
      });
      return { ok: true, source: def.id, rows: pollDataSet(next).rows };
    });
  });
}
