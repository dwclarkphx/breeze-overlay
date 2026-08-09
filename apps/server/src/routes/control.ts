// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Control surface: WebSocket for live operation, REST for hardware triggers.
 *
 * Both funnel into the same `ControlHub`, so a Stream Deck button and an
 * operator's browser cannot get out of step — whichever fires, every renderer
 * and every panel sees the same command and the same resulting state.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { actorOf, record } from '../audit.js';
import { controlPage, isFedSource, type ControlPanelBinding } from '../pages.js';
import { channelKey, parseClientMessage, type ControlHub, type ControlVerb } from '../hub.js';
import type { DataRegistry } from '../data/registry.js';
import { readDataSources } from '../data/sources.js';
import { getChannel, getComposition } from '../store.js';
import {
  bindingsJsonSchema,
  collectBindings,
  collectSources,
  sceneElements,
  stepCount,
  type DataSourceDef,
} from '@breeze/schema';

const VERBS: ControlVerb[] = ['play', 'stop', 'next', 'clear'];

/**
 * `projectId/compositionId` → the two halves.
 *
 * Split on the first slash only: a project id may not contain one, so anything
 * after the first belongs to the composition side.
 */
function splitChannel(channel: string): [string, string] {
  const at = channel.indexOf('/');
  return at === -1 ? [channel, ''] : [channel.slice(0, at), channel.slice(at + 1)];
}

/*
 * Authentication is not repeated here. The single `onRequest` hook in app.ts
 * gates every control action — including the GET triggers — and accepts the key
 * as either a header or a query parameter. Two auth checks in two places is how
 * they end up disagreeing.
 */

export async function registerControlRoutes(
  app: FastifyInstance,
  hub: ControlHub,
  /** Optional so tests can register the routes without a polling registry. */
  data?: DataRegistry,
): Promise<void> {
  /* ------------------------------------------------------------ websocket */

  app.get('/ws/control', { websocket: true }, (socket, req) => {
    const id = `c${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

    const client = hub.addClient(id, (message) => {
      // readyState 1 === OPEN. Sending to a closing socket throws and would
      // take down the broadcast loop for every other client.
      if (socket.readyState === 1) socket.send(JSON.stringify(message));
    });

    /*
     * Audit is done here rather than in the hub, which is deliberately
     * dependency-free and knows nothing about disks or requests.
     *
     * Only control panels. Browser sources are excluded because a source that
     * flaps reconnects every few seconds and would bury the entries anyone
     * actually goes looking for; editors are excluded because they now hold a
     * presence subscription of their own and would double the volume with
     * design-time noise. Both are still visible live on the status strip.
     */
    const actor = actorOf(req);
    let panel: string | null = null;

    socket.on('message', (raw: Buffer | string) => {
      const message = parseClientMessage(raw.toString());
      if (!message) {
        client.send({ type: 'error', message: 'unrecognised message' });
        return;
      }

      // First subscribe only. A re-subscribe is an editor changing scene, and
      // that is not a connection event.
      if (
        panel === null &&
        message.type === 'subscribe' &&
        message.role === 'controller' &&
        (message.client ?? 'panel') === 'panel'
      ) {
        panel = message.channel;
        const [project, scene] = splitChannel(message.channel);
        void record({
          action: 'panel.connect',
          actor,
          ...(project ? { project } : {}),
          ...(scene ? { scene } : {}),
        });
      }

      hub.handle(id, message);
    });

    const gone = (): void => {
      hub.removeClient(id);
      if (panel === null) return;
      const [project, scene] = splitChannel(panel);
      // Nulled first: `close` after `error` would otherwise log twice.
      panel = null;
      void record({
        action: 'panel.disconnect',
        actor,
        ...(project ? { project } : {}),
        ...(scene ? { scene } : {}),
      });
    };

    socket.on('close', gone);
    socket.on('error', gone);
  });

  /* ----------------------------------------------------------------- REST */

  /**
   * Verb triggers. Both GET and POST are accepted.
   *
   * A side-effecting GET is poor REST, and deliberate: every broadcast control
   * surface in this space works that way (CasparCG AMCP over HTTP bridges,
   * vMix's API, Companion's generic HTTP module), and an operator wiring a
   * button in a hurry will reach for a URL.
   */
  for (const verb of VERBS) {
    const handler = async (
      req: FastifyRequest<{ Params: { id: string; compId: string } }>,
    ) => {
      /*
       * 404 rather than silently succeeding into a channel nothing renders.
       *
       * Resolved against the channel index, not `getComposition`. An element's
       * channel is a legal trigger target and is *not* a composition id, so the
       * old guard rejected exactly the URLs scenes exist to provide.
       */
      await getChannel(req.params.id, req.params.compId);

      const channel = channelKey(req.params.id, req.params.compId);
      const delivered = hub.dispatch(channel, { verb, source: 'rest' });
      return { ok: true, verb, channel, delivered };
    };

    app.get(`/api/control/:id/:compId/${verb}`, handler);
    app.post(`/api/control/:id/:compId/${verb}`, handler);
  }

  /**
   * Take a whole scene down in one call.
   *
   * A page reload does the same thing far more bluntly — it drops the sockets,
   * rebuilds every runtime and flashes — so an operator needs a way to clear a
   * shared page without it.
   *
   * A separate path rather than `clear?all=1`: the panic button is the wrong
   * place to be clever, and an operator reading a URL off a Stream Deck button
   * should be able to tell what it does.
   *
   * There is deliberately no `play-all` or `stop-all`. Rolling every element at
   * once is not a real broadcast operation — they have different in-points and
   * different reasons to be on air — and offering it would invite a habit that
   * produces a mess on screen.
   */
  const clearAll = async (req: FastifyRequest<{ Params: { id: string; compId: string } }>) => {
    const composition = await getComposition(req.params.id, req.params.compId);

    const channels = [
      req.params.compId,
      ...sceneElements(composition).map((element) => element.channel),
    ];

    const delivered: Record<string, number> = {};
    for (const name of channels) {
      const channel = channelKey(req.params.id, name);
      delivered[channel] = hub.dispatch(channel, { verb: 'clear', source: 'rest' });
    }

    return { ok: true, verb: 'clear-all', channels: Object.keys(delivered), delivered };
  };

  app.get('/api/control/:id/:compId/clear-all', clearAll);
  app.post('/api/control/:id/:compId/clear-all', clearAll);

  /** Push dynamic field values. Body for POST, query string for GET. */
  const update = async (
    req: FastifyRequest<{ Params: { id: string; compId: string }; Body?: Record<string, unknown> }>,
    reply: FastifyReply,
  ) => {
    await getChannel(req.params.id, req.params.compId);

    const query = { ...(req.query as Record<string, unknown>) };
    delete query['key'];
    const data = req.method === 'POST' && req.body ? req.body : query;

    if (!data || Object.keys(data).length === 0) {
      reply.code(400);
      return { error: 'no fields supplied' };
    }

    const channel = channelKey(req.params.id, req.params.compId);
    const delivered = hub.dispatch(channel, { verb: 'update', data, source: 'rest' });
    return { ok: true, verb: 'update', channel, delivered, data };
  };

  app.get('/api/control/:id/:compId/update', update);
  app.post('/api/control/:id/:compId/update', update);

  /** What is this graphic doing right now? */
  app.get<{ Params: { id: string; compId: string } }>(
    '/api/control/:id/:compId/state',
    async (req) => {
      const channel = channelKey(req.params.id, req.params.compId);
      return { channel, state: hub.state(channel) };
    },
  );

  /* --------------------------------------------------------- operator page */

  app.get<{ Params: { id: string; compId: string } }>(
    '/control/:id/:compId',
    async (req, reply) => {
      const composition = await getComposition(req.params.id, req.params.compId);

      /*
       * Resolve each binding against the project's data sources.
       *
       * Done here rather than in `collectBindings` because it is the one piece
       * of the answer the composition does not contain: a layer knows it reads
       * `wx-current`, but only the source file knows whether that is a weather
       * feed or a table somebody types into. Failure to read the file is not
       * fatal — the panel then behaves exactly as it did before this existed,
       * which is the right fallback.
       */
      let defs: DataSourceDef[] = [];
      try {
        defs = await readDataSources(req.params.id);
      } catch {
        defs = [];
      }
      const byId = new Map(defs.map((d) => [d.id, d]));

      /*
       * Fed panels come from `collectSources`, not from `collectBindings`.
       *
       * A layer reading a feed does not need a `binding` at all — the screen
       * bug's temperature has none, deliberately, so that nothing can push a
       * placeholder over the live value. Built from bindings alone the panel
       * for that graphic was empty, which is the opposite of showing the
       * operator what is on air.
       *
       * Fed entries come first: they are the status of the graphic, and an
       * operator scanning the panel wants "what is it showing" above "what can
       * I change".
       */
      const feds: ControlPanelBinding[] = [];
      const fedSourceIds = new Set<string>();
      for (const ref of collectSources(composition)) {
        const def = byId.get(ref.id);
        if (!def || !isFedSource(def.type)) continue;
        fedSourceIds.add(ref.id);
        feds.push({
          name: `$source:${ref.id}`,
          kind: ref.kind,
          label: ref.label,
          defaultValue: null,
          source: ref.id,
          ...(ref.column ? { column: ref.column } : {}),
          readOnly: true,
          sourceName: def.name,
          sourceType: def.type,
        });
      }

      /*
       * Editable fields, minus anything already shown as fed. A layer carrying
       * both a fetched source and a binding would otherwise appear twice — once
       * read-only and once as an input that silently loses to the next poll.
       */
      const editable: ControlPanelBinding[] = collectBindings(composition)
        .filter((b) => !(b.source && fedSourceIds.has(b.source)))
        .map((b) => {
          const def = b.source ? byId.get(b.source) : undefined;
          return def ? { ...b, sourceName: def.name, sourceType: def.type } : b;
        });

      const bindings = [...feds, ...editable];

      reply.type('text/html; charset=utf-8');
      reply.header('cache-control', 'no-store');
      return controlPage({
        projectId: req.params.id,
        composition,
        bindings,
        schema: bindingsJsonSchema(composition),
        stepCount: stepCount(composition),
        datasets: data?.datasets(req.params.id) ?? {},
      });
    },
  );
}
