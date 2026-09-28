// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The project mode API (CYCLE.md, Wave 6; see `mode.ts`).
 *
 * `GET /api/projects/:id/mode` reads it, with every mode the project's rules
 * name. `…/mode/set?value=first-alert` sets it — GET as well as POST, for
 * header-less panels, and gated by the API key either way (`app.ts`): it
 * changes what is on air. The new mode goes out as an ordinary `update` to
 * every open graphic in the project, so it rides the hub's retained data and
 * a browser source that reconnects comes back in the right mode.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { MODE_UPDATE_KEY } from '@breeze/schema';

import { actorOf, record } from '../audit.js';
import type { ControlHub } from '../hub.js';
import { canonicalMode, cleanMode, projectModes, readMode, serially, writeMode } from '../mode.js';
import { readProject } from '../store.js';

interface Params {
  id: string;
}

export async function registerModeRoutes(app: FastifyInstance, hub: ControlHub): Promise<void> {
  app.get<{ Params: Params }>('/api/projects/:id/mode', async (req) => {
    const project = await readProject(req.params.id);
    return { mode: await readMode(project.id), modes: projectModes(project) };
  });

  const set = async (
    req: FastifyRequest<{ Params: Params; Querystring: { value?: string } }>,
    reply: FastifyReply,
  ) => {
    const body = req.body && typeof req.body === 'object' ? (req.body as { value?: unknown }) : {};
    const raw = body.value ?? req.query.value;
    /*
     * The whole request takes its turn, from the first line — not only the
     * write. Queued after reading the project, the order was whichever file
     * read finished first: four presses at once on Windows left the second-last
     * one on air. A press's place is the moment it arrived.
     */
    return serially(req.params.id, async () => {
      const project = await readProject(req.params.id);
      const cleaned = cleanMode(raw);
      if (typeof cleaned !== 'string') {
        reply.code(400);
        return { error: cleaned.error };
      }
      const modes = projectModes(project);
      const mode = canonicalMode(cleaned, modes);
      const before = await readMode(project.id);
      await writeMode(project.id, mode);
      // To every graphic of this project that is open — the same fan-out a
      // data-source push takes.
      const prefix = `${project.id}/`;
      let delivered = 0;
      for (const channel of hub.activeChannels) {
        if (!channel.startsWith(prefix)) continue;
        delivered += hub.dispatch(channel, { verb: 'update', data: { [MODE_UPDATE_KEY]: mode } });
      }

      if (before !== mode) {
        void record({
          action: 'mode.set',
          actor: actorOf(req),
          project: project.id,
          name: project.name,
          detail: { mode: mode || '(none)', was: before || '(none)' },
        });
      }
      return { ok: true, mode, modes, delivered };
    });
  };
  app.get('/api/projects/:id/mode/set', set);
  app.post('/api/projects/:id/mode/set', set);
}
