// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import type { FastifyInstance } from 'fastify';

import {
  InvalidKeyError,
  KEY_MAX_LENGTH,
  assertKey,
  bindingsJsonSchema,
  collectBindings,
  createComposition,
  isValidKey,
  stepCount,
  suggestKey,
  uniqueKeyedId,
  type Composition,
  type Project,
} from '@breeze/schema';
import { CompositionValidationError, assertValidComposition } from '@breeze/schema/validate';

import { actorOf, record } from '../audit.js';
import {
  NotFoundError,
  compositionReferrers,
  deleteComposition,
  deleteProject,
  getComposition,
  listAllChannels,
  listChannels,
  listProjects,
  newProject,
  putComposition,
  readProject,
  writeProject,
} from '../store.js';

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/projects', async () => ({ projects: await listProjects() }));

  app.post<{ Body: { name?: string; id?: string; key?: string } }>('/api/projects', async (req, reply) => {
    const name = req.body?.name ?? 'Untitled project';
    try {
      const project = await newProject(name, req.body?.id, req.body?.key);
      void record({
        action: 'project.create',
        actor: actorOf(req),
        project: project.id,
        name: project.name,
      });
      reply.code(201);
      return project;
    } catch (err) {
      // A bad URL key is user input from a form field, not a server fault. 400
      // with the rule that was broken, so the editor can put it under the input.
      if (err instanceof InvalidKeyError) {
        reply.code(400);
        return { error: err.message, field: 'key' };
      }
      throw err;
    }
  });

  /**
   * Everything addressable in this project — compositions plus the independent
   * elements any of them mount. The editor uses it to warn about a channel
   * clash before a save is attempted, and it is the honest answer to "what URLs
   * does this project answer to".
   */
  app.get<{ Params: { id: string } }>('/api/projects/:id/channels', async (req) => ({
    channels: await listChannels(req.params.id),
  }));

  /**
   * The same thing for every project at once.
   *
   * For control surfaces building a button set: one request instead of one per
   * project. A GET, so a Stream Deck or a Companion module can discover what
   * exists without needing the API key.
   */
  app.get('/api/channels', async (_req, reply) => {
    // Never cached: a scene added in the editor should appear the next time a
    // control surface asks, not after a proxy's TTL.
    reply.header('cache-control', 'no-store');
    return { projects: await listAllChannels() };
  });

  /** Suggest a URL key from a name, using the same rules the server enforces. */
  app.get<{ Querystring: { name?: string } }>('/api/keys/suggest', async (req) => {
    const name = req.query?.name ?? '';
    const key = suggestKey(name);
    return { key, valid: key.length > 0 && isValidKey(key), maxLength: KEY_MAX_LENGTH };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req) => readProject(req.params.id));

  app.put<{ Params: { id: string }; Body: Project }>('/api/projects/:id', async (req) => {
    const body = { ...req.body, id: req.params.id };
    return writeProject(body);
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    /*
     * Read the name *before* deleting it. After `fs.rm` there is nothing left to
     * look it up in, and `proj-1k3f9` in a log entry three weeks later is not an
     * answer to "which project went missing".
     */
    const name = await readProject(req.params.id)
      .then((p) => p.name)
      .catch(() => undefined);

    await deleteProject(req.params.id);
    void record({
      action: 'project.delete',
      actor: actorOf(req),
      project: req.params.id,
      ...(name ? { name } : {}),
    });
    reply.code(204);
    return null;
  });

  /* ------------------------------------------------------- compositions */

  app.get<{ Params: { id: string } }>('/api/projects/:id/compositions', async (req) => {
    const project = await readProject(req.params.id);
    return { compositions: project.compositions };
  });

  /**
   * Create a scene.
   *
   * Mirrors `POST /api/projects` deliberately, down to the 400 with
   * `field: 'key'`: both mint an id whose front half the user chose, both
   * enforce the same key rules, and the editor puts both errors under the same
   * kind of input. Creating a composition by PUTting to an id the caller
   * invented would put id generation in the browser, where the collision check
   * below cannot run.
   *
   * `uniqueKeyedId` is given every *channel* in the project, not just the
   * composition ids. A scene's independent elements are addressable at the same
   * level as compositions, so a new composition called `bug` in a project whose
   * game scene already mounts an element on channel `bug` is a routing clash —
   * `/control/<project>/bug` would have two answers.
   */
  app.post<{ Params: { id: string }; Body: { name?: string; key?: string } }>(
    '/api/projects/:id/compositions',
    async (req, reply) => {
      const project = await readProject(req.params.id);
      const name = req.body?.name?.trim() || 'Untitled scene';

      const chosen =
        req.body?.key !== undefined && req.body.key.trim().length > 0
          ? req.body.key.trim().toLowerCase()
          : undefined;
      if (chosen !== undefined) {
        try {
          assertKey(chosen);
        } catch (err) {
          if (err instanceof InvalidKeyError) {
            reply.code(400);
            return { error: err.message, field: 'key' };
          }
          throw err;
        }
      }

      const taken = (await listChannels(req.params.id)).map((c) => c.channel);
      const comp = createComposition({
        id: uniqueKeyedId('comp', chosen, taken),
        name,
        // Inherit the project's stage rather than the schema default. A project
        // authored at 1280×720 should not get a 1920×1080 scene added to it
        // silently — every other scene in it would be a different size.
        ...(project.compositions[0]?.stage ? { stage: project.compositions[0].stage } : {}),
      });

      assertValidComposition(comp);
      await putComposition(req.params.id, comp);
      void record({
        action: 'scene.create',
        actor: actorOf(req),
        project: req.params.id,
        scene: comp.id,
        name: comp.name,
      });
      reply.code(201);
      return comp;
    },
  );

  app.get<{ Params: { id: string; compId: string } }>(
    '/api/projects/:id/compositions/:compId',
    async (req) => getComposition(req.params.id, req.params.compId),
  );

  app.put<{ Params: { id: string; compId: string }; Body: Composition }>(
    '/api/projects/:id/compositions/:compId',
    async (req) => {
      const comp = { ...req.body, id: req.params.compId };
      assertValidComposition(comp);
      return putComposition(req.params.id, comp);
    },
  );

  /**
   * Everything that mounts this composition. The editor asks before offering
   * the delete, so the button can say what it will refuse to do rather than
   * refusing after the click.
   */
  app.get<{ Params: { id: string; compId: string } }>(
    '/api/projects/:id/compositions/:compId/referrers',
    async (req) => {
      // Confirms the composition exists — a referrer list for a nonexistent id
      // is an empty array, which reads as "safe to delete".
      await getComposition(req.params.id, req.params.compId);
      return { referrers: await compositionReferrers(req.params.id, req.params.compId) };
    },
  );

  app.delete<{ Params: { id: string; compId: string } }>(
    '/api/projects/:id/compositions/:compId',
    async (req, reply) => {
      /*
       * Refused, not warned about.
       *
       * A `composition` layer holds its target by id. Deleting the target
       * leaves the layer in place pointing at nothing: the parent still loads
       * and still plays, minus one graphic, with nothing anywhere saying why.
       * That is a fault that shows up on air, so it is worth a 409 and a list
       * of exactly which layers to unlink first.
       *
       * 409 rather than 422: the request is well-formed and would be valid the
       * moment those references are gone.
       */
      const referrers = await compositionReferrers(req.params.id, req.params.compId);
      if (referrers.length > 0) {
        reply.code(409);
        return {
          error: `still used by ${referrers.length} composition${referrers.length === 1 ? '' : 's'}`,
          referrers,
        };
      }
      // Same reason as a project delete: the name has to be read while it still
      // exists. A refused delete above is not logged — nothing changed.
      const name = await getComposition(req.params.id, req.params.compId)
        .then((c) => c.name)
        .catch(() => undefined);

      const project = await deleteComposition(req.params.id, req.params.compId);
      void record({
        action: 'scene.delete',
        actor: actorOf(req),
        project: req.params.id,
        scene: req.params.compId,
        ...(name ? { name } : {}),
      });
      return project;
    },
  );

  /**
   * Dynamic-field descriptor. Drives the Phase-4 operator form, and gives any
   * external caller the same field list the panel sees — one source, no drift.
   */
  app.get<{ Params: { id: string; compId: string } }>(
    '/api/projects/:id/compositions/:compId/bindings',
    async (req) => {
      const comp = await getComposition(req.params.id, req.params.compId);
      return {
        bindings: collectBindings(comp),
        schema: bindingsJsonSchema(comp),
        stepCount: stepCount(comp),
      };
    },
  );

  /** Validate a composition without saving — the editor calls this on change. */
  app.post<{ Body: unknown }>('/api/validate/composition', async (req) => {
    try {
      assertValidComposition(req.body);
      return { valid: true, errors: [] };
    } catch (err) {
      if (err instanceof CompositionValidationError) {
        return { valid: false, errors: err.issues };
      }
      throw err;
    }
  });
}

export { NotFoundError };
