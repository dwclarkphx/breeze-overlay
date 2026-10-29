// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Rundowns, cue → take, and outputs (Phase 9 Wave A, PHASE9.md §3).
 *
 *  - `GET/PUT /api/projects/:id/rundowns` — the document, `rundowns.json`.
 *  - `/api/rundown/:id/:rundownId/{cue,next,prev,take,out}` — verbs, GET or
 *    POST like every other control verb, key-gated by `app.ts`.
 *  - `GET /api/rundown/:id/:rundownId/state` — armed item, what each target
 *    shows.
 *  - `/api/out/:id/:output/{stop,next,prev,clear}` and `/state` — an output's
 *    own verbs, `?mount=` to aim at one composition on it.
 *  - `/out/:id/:output` — the output page; `/rundown/:id` — the panel.
 *
 * **Cue is a buffer, take is a command.** Arming an item changes nothing on
 * air; it is server state (`RundownLive`), broadcast on the rundown channel so
 * every panel shows it and a refreshed panel comes back on the same item. TAKE
 * sends values and PLAY as one hub command (`take`), and the runtime runs the
 * outro of what is on air before the new values go up.
 *
 * Live state is in memory, like the hub's: a server restart forgets what was
 * armed. Persisting it is Wave F's.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  DATA_UPDATE_KEY,
  MOUNTS_UPDATE_KEY,
  OUTPUT_NAME_PATTERN,
  RUNDOWNS_REVISION_KEY,
  RUNDOWN_UPDATE_KEY,
  adjacentItem,
  channelKind,
  itemTarget,
  orderMounts,
  outputChannel,
  outputMountChannel,
  rundownChannel,
  type OutputMount,
  type Rundown,
  type RundownItem,
  type RundownLive,
  type RundownsFile,
} from '@breeze/schema';

import type { ControlCommand, ControlHub } from '../hub.js';
import type { DataRegistry } from '../data/registry.js';
import { fail } from '../errors.js';
import { readTimerRequest } from '../timer-request.js';
import { readScrollRequest } from '../scroll-request.js';
import { readMode } from '../mode.js';
import { outPage, rundownPage } from '../pages.js';
import { panelBindingsFor } from '../panel-bindings.js';
import { keyingOf } from './play.js';
import { RundownValidationError, getComposition, readProject, readRundowns, writeRundowns } from '../store.js';

/** A refusal the routes turn into a status and an error code. */
export class RundownError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(code);
    this.name = 'RundownError';
  }
}

export interface TakeResult {
  item: RundownItem;
  target: string;
  channel: string;
  delivered: number;
  /** The item armed after this take, when it advanced. */
  armed: string | null;
}

export class RundownController {
  /** projectId → rundownId → live state. */
  private live = new Map<string, Map<string, RundownLive>>();
  /** Output routing channel → what is mounted on it. */
  private mounts = new Map<string, OutputMount[]>();
  private revisions = new Map<string, number>();
  /** projectId → the last queued rundown verb. See `serial`. */
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly hub: ControlHub,
    private readonly data?: DataRegistry,
  ) {}

  liveOf(projectId: string, rundownId: string): RundownLive {
    let byRundown = this.live.get(projectId);
    if (!byRundown) this.live.set(projectId, (byRundown = new Map()));
    let live = byRundown.get(rundownId);
    if (!live) byRundown.set(rundownId, (live = { armed: null, onAir: {} }));
    return live;
  }

  mountsOf(projectId: string, output: string): OutputMount[] {
    return orderMounts(this.mounts.get(outputChannel(projectId, output)) ?? []);
  }

  /** Tell every panel on the project's rundown channel. */
  private publish(projectId: string): void {
    const all: Record<string, RundownLive> = {};
    for (const [id, live] of this.live.get(projectId) ?? []) all[id] = { armed: live.armed, onAir: { ...live.onAir } };
    this.hub.dispatch(rundownChannel(projectId), { verb: 'update', data: { [RUNDOWN_UPDATE_KEY]: all } });
  }

  /** `rundowns.json` changed: panels re-read it. */
  saved(projectId: string, doc: RundownsFile): void {
    // Forget armed and on-air items that no longer exist.
    const byRundown = this.live.get(projectId);
    if (byRundown) {
      for (const [id, live] of byRundown) {
        const rundown = doc.rundowns.find((r) => r.id === id);
        if (!rundown) {
          byRundown.delete(id);
          continue;
        }
        const ids = new Set(rundown.items.map((i) => i.id));
        if (live.armed && !ids.has(live.armed)) live.armed = null;
        for (const [target, item] of Object.entries(live.onAir)) if (!ids.has(item)) delete live.onAir[target];
      }
    }
    const rev = (this.revisions.get(projectId) ?? 0) + 1;
    this.revisions.set(projectId, rev);
    this.hub.dispatch(rundownChannel(projectId), { verb: 'update', data: { [RUNDOWNS_REVISION_KEY]: rev } });
    this.publish(projectId);
  }

  private async rundown(projectId: string, rundownId: string): Promise<Rundown> {
    const doc = await readRundowns(projectId);
    const rundown = doc.rundowns.find((r) => r.id === rundownId);
    if (!rundown) throw new RundownError(404, 'error.rundownNotFound', { rundown: rundownId });
    return rundown;
  }

  private static item(rundown: Rundown, itemId: string): RundownItem {
    const item = rundown.items.find((i) => i.id === itemId);
    if (!item) throw new RundownError(404, 'error.rundownItemNotFound', { item: itemId });
    return item;
  }

  /**
   * Run rundown verbs for one project one at a time, in arrival order.
   *
   * Every verb reads `rundowns.json` before it touches the live state, and two
   * reads started together may finish in either order. Sent back to back —
   * a Companion button doing CUE then TAKE, or the socket test that caught
   * this on a loaded Windows run — TAKE could finish its read first, find
   * nothing armed and refuse, and the CUE would land after it. Queuing per
   * project keeps the operator's order. A failed verb does not block the next:
   * the chain carries on from its settlement, not its result.
   */
  private serial<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(projectId) ?? Promise.resolve()).then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    this.chains.set(projectId, tail);
    // Drop the entry once nothing is queued behind it.
    void tail.then(() => {
      if (this.chains.get(projectId) === tail) this.chains.delete(projectId);
    });
    return run;
  }

  cue(projectId: string, rundownId: string, itemId: string | null): Promise<RundownLive> {
    return this.serial(projectId, () => this.cueNow(projectId, rundownId, itemId));
  }

  step(projectId: string, rundownId: string, delta: 1 | -1): Promise<RundownLive> {
    return this.serial(projectId, () => this.stepNow(projectId, rundownId, delta));
  }

  take(
    projectId: string,
    rundownId: string,
    opts: { item?: string; advance?: boolean; source?: string } = {},
  ): Promise<TakeResult> {
    return this.serial(projectId, () => this.takeNow(projectId, rundownId, opts));
  }

  out(projectId: string, rundownId: string, target?: string): Promise<{ target: string; delivered: number }> {
    return this.serial(projectId, () => this.outNow(projectId, rundownId, target));
  }

  /** Arm an item, or nothing with `null`. Changes nothing on air. */
  private async cueNow(projectId: string, rundownId: string, itemId: string | null): Promise<RundownLive> {
    const rundown = await this.rundown(projectId, rundownId);
    if (itemId !== null) RundownController.item(rundown, itemId);
    const live = this.liveOf(projectId, rundownId);
    live.armed = itemId;
    this.publish(projectId);
    return live;
  }

  /**
   * Arm the next or previous item. From nothing armed, NEXT starts after the
   * item most recently taken — an operator who took the third name and then
   * pressed NEXT wants the fourth, not the first.
   */
  private async stepNow(projectId: string, rundownId: string, delta: 1 | -1): Promise<RundownLive> {
    const rundown = await this.rundown(projectId, rundownId);
    const live = this.liveOf(projectId, rundownId);
    let from = live.armed;
    if (!from) {
      const taken = Object.values(live.onAir);
      const last = rundown.items.filter((i) => taken.includes(i.id)).at(-1);
      from = last?.id ?? null;
    }
    const next = adjacentItem(rundown, from, delta);
    if (next) live.armed = next.id;
    this.publish(projectId);
    return live;
  }

  /**
   * TAKE: the armed item, or `itemId`. With `advance` (the default) the next
   * item is armed afterwards, so one button walks a list of fifteen names.
   */
  private async takeNow(
    projectId: string,
    rundownId: string,
    opts: { item?: string; advance?: boolean; source?: string },
  ): Promise<TakeResult> {
    const rundown = await this.rundown(projectId, rundownId);
    const live = this.liveOf(projectId, rundownId);
    const itemId = opts.item ?? live.armed;
    if (!itemId) throw new RundownError(409, 'error.rundownNothingArmed');
    const item = RundownController.item(rundown, itemId);
    // The composition must still exist — the rundown may predate a delete.
    await getComposition(projectId, item.composition);

    const { channel, delivered } = this.takeItem(projectId, item, opts.source ?? 'rundown');
    const target = itemTarget(item);
    live.onAir[target] = item.id;
    if (opts.advance !== false) {
      const next = adjacentItem(rundown, item.id, 1);
      live.armed = next ? next.id : null;
    } else if (live.armed === item.id) {
      live.armed = null;
    }
    this.publish(projectId);
    return { item, target, channel, delivered, armed: live.armed };
  }

  /** Put one item on air: its own channel, or mounted on an output. */
  takeItem(projectId: string, item: RundownItem, source: string): { channel: string; delivered: number } {
    const values = item.data ?? {};
    if (!item.output) {
      const channel = `${projectId}/${item.composition}`;
      return { channel, delivered: this.hub.dispatch(channel, { verb: 'take', data: values, source }) };
    }

    const channel = this.mountOnOutput(projectId, item.output, item.composition, values, {
      item: item.id,
      layer: item.layer ?? 0,
    });
    return {
      channel,
      delivered: this.hub.dispatch(channel, { verb: 'take', mount: item.composition, data: values, source }),
    };
  }

  /**
   * Put a composition on an output without playing it, and return the output's
   * routing channel. What a TAKE does before it plays, and all an OGraf `load`
   * onto an output does (Phase 9 Wave D) — one list of mounts per output,
   * whichever of the two put a graphic there.
   *
   * A mount already there keeps its place in the stack unless `layer` says
   * otherwise, and keeps the rundown item that put it there unless `item` does.
   */
  mountOnOutput(
    projectId: string,
    output: string,
    composition: string,
    values: Record<string, unknown>,
    opts: { item?: string; layer?: number } = {},
  ): string {
    const channel = outputChannel(projectId, output);
    const list = this.mounts.get(channel) ?? [];
    const existing = list.find((m) => m.composition === composition);
    if (existing) {
      if (opts.item !== undefined) existing.item = opts.item;
      if (opts.layer !== undefined) existing.layer = opts.layer;
    } else {
      list.push({
        composition,
        ...(opts.item !== undefined ? { item: opts.item } : {}),
        layer: opts.layer ?? 0,
        since: Date.now(),
      });
    }
    this.mounts.set(channel, list);

    /*
     * The mount's own channel is welcomed with these values and the project's
     * current rows. A newly mounted element subscribes there and starts from
     * them; a reloaded output page comes back showing the right name.
     */
    this.hub.retain(outputMountChannel(projectId, output, composition), {
      ...values,
      ...(this.data ? { [DATA_UPDATE_KEY]: this.data.datasets(projectId) } : {}),
    });
    this.hub.dispatch(channel, { verb: 'update', data: { [MOUNTS_UPDATE_KEY]: orderMounts(list) } });
    return channel;
  }

  /**
   * Take a target off air: the graphic on its own channel, or the
   * composition on an output that this rundown last took there. With no
   * target, the armed item's.
   */
  private async outNow(projectId: string, rundownId: string, target?: string): Promise<{ target: string; delivered: number }> {
    const rundown = await this.rundown(projectId, rundownId);
    const live = this.liveOf(projectId, rundownId);
    let aim = target;
    if (!aim) {
      const armed = live.armed ? rundown.items.find((i) => i.id === live.armed) : undefined;
      if (!armed) throw new RundownError(409, 'error.rundownNothingArmed');
      aim = itemTarget(armed);
    }
    let delivered = 0;
    if (aim.startsWith('@')) {
      const onAir = live.onAir[aim] ? rundown.items.find((i) => i.id === live.onAir[aim]) : undefined;
      const output = aim.slice(1);
      delivered = this.hub.dispatch(outputChannel(projectId, output), {
        verb: 'stop',
        source: 'rundown',
        ...(onAir ? { mount: onAir.composition } : {}),
      });
    } else {
      delivered = this.hub.dispatch(`${projectId}/${aim}`, { verb: 'stop', source: 'rundown' });
    }
    delete live.onAir[aim];
    this.publish(projectId);
    return { target: aim, delivered };
  }

  /** An output verb: `stop`, `next`, `prev` or `clear`, at one mount or all. */
  outputVerb(projectId: string, output: string, verb: 'stop' | 'next' | 'prev' | 'clear', mount?: string): number {
    const channel = outputChannel(projectId, output);
    const delivered = this.hub.dispatch(channel, { verb, source: 'rest', ...(mount ? { mount } : {}) });
    if (verb === 'clear') {
      const list = mount ? (this.mounts.get(channel) ?? []).filter((m) => m.composition !== mount) : [];
      this.mounts.set(channel, list);
      this.hub.dispatch(channel, { verb: 'update', data: { [MOUNTS_UPDATE_KEY]: orderMounts(list) } });
      for (const live of this.live.get(projectId)?.values() ?? []) {
        if (!mount) delete live.onAir[`@${output}`];
      }
      this.publish(projectId);
    }
    return delivered;
  }

  /** What each target this rundown uses is doing — for the panel's readout. */
  async state(projectId: string, rundownId: string) {
    const rundown = await this.rundown(projectId, rundownId);
    const live = this.liveOf(projectId, rundownId);
    const targets = new Map<
      string,
      { target: string; item: string | null; state: string; renderers: number; scrolls: ReturnType<ControlHub['scrollSummary']>; clock: number }
    >();
    for (const item of rundown.items) {
      const target = itemTarget(item);
      if (targets.has(target)) continue;
      const onAirId = live.onAir[target] ?? null;
      const onAir = onAirId ? rundown.items.find((i) => i.id === onAirId) : undefined;
      let state = 'idle';
      let renderers = 0;
      // Rolls on the target (Wave R) — the panel's transport for each.
      const scrolls = this.hub.scrollSummary(item.output ? outputChannel(projectId, item.output) : `${projectId}/${item.composition}`);
      if (item.output) {
        renderers = this.hub.state(outputChannel(projectId, item.output)).renderers;
        if (onAir) state = this.hub.state(outputMountChannel(projectId, item.output, onAir.composition)).playback?.state ?? 'idle';
      } else {
        const s = this.hub.state(`${projectId}/${item.composition}`);
        renderers = s.renderers;
        state = s.playback?.state ?? 'idle';
      }
      targets.set(target, { target, item: onAirId, state, renderers, scrolls, clock: Date.now() });
    }
    return { rundown: rundown.id, armed: live.armed, onAir: { ...live.onAir }, targets: [...targets.values()] };
  }
}

/* ------------------------------------------------------------------ routes */

function params(req: FastifyRequest): Record<string, unknown> {
  const query = { ...(req.query as Record<string, unknown>) };
  delete query['key'];
  const body =
    req.method === 'POST' && req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  return { ...query, ...body };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

async function answer<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RundownError) {
      reply.code(err.status);
      return fail(err.code, err.params);
    }
    if (err instanceof RundownValidationError) {
      reply.code(422);
      return { ...fail('error.rundownInvalid'), issues: err.issues };
    }
    throw err;
  }
}

function assertOutput(output: string): void {
  if (!OUTPUT_NAME_PATTERN.test(output)) throw new RundownError(400, 'error.outputName');
}

export async function registerRundownRoutes(
  app: FastifyInstance,
  hub: ControlHub,
  data?: DataRegistry,
): Promise<RundownController> {
  const rundowns = new RundownController(hub, data);

  /* -------------------------------------------------------------- document */

  app.get<{ Params: { id: string } }>('/api/projects/:id/rundowns', async (req) => {
    await readProject(req.params.id);
    return readRundowns(req.params.id);
  });

  app.put<{ Params: { id: string }; Body: RundownsFile }>('/api/projects/:id/rundowns', async (req, reply) =>
    answer(reply, async () => {
      const doc = await writeRundowns(req.params.id, req.body);
      rundowns.saved(req.params.id, doc);
      return doc;
    }),
  );

  /* ----------------------------------------------------------------- verbs */

  type RundownReq = FastifyRequest<{ Params: { id: string; rundownId: string } }>;
  const verb = (name: string, fn: (req: RundownReq) => Promise<unknown>) => {
    const handler = async (req: RundownReq, reply: FastifyReply) => answer(reply, () => fn(req));
    app.get(`/api/rundown/:id/:rundownId/${name}`, handler);
    app.post(`/api/rundown/:id/:rundownId/${name}`, handler);
  };

  verb('cue', async (req) => {
    const item = str(params(req)['item']) ?? null;
    const live = await rundowns.cue(req.params.id, req.params.rundownId, item);
    return { ok: true, verb: 'cue', armed: live.armed };
  });
  verb('next', async (req) => {
    const live = await rundowns.step(req.params.id, req.params.rundownId, 1);
    return { ok: true, verb: 'next', armed: live.armed };
  });
  verb('prev', async (req) => {
    const live = await rundowns.step(req.params.id, req.params.rundownId, -1);
    return { ok: true, verb: 'prev', armed: live.armed };
  });
  verb('take', async (req) => {
    const p = params(req);
    const advanceRaw = p['advance'];
    const advance = !(advanceRaw === false || advanceRaw === '0' || advanceRaw === 'false');
    const item = str(p['item']);
    const result = await rundowns.take(req.params.id, req.params.rundownId, {
      ...(item ? { item } : {}),
      advance,
      source: 'rest',
    });
    return {
      ok: true,
      verb: 'take',
      item: result.item.id,
      target: result.target,
      channel: result.channel,
      delivered: result.delivered,
      armed: result.armed,
    };
  });
  verb('out', async (req) => {
    const target = str(params(req)['target']);
    const result = await rundowns.out(req.params.id, req.params.rundownId, target);
    return { ok: true, verb: 'out', ...result };
  });

  app.get<{ Params: { id: string; rundownId: string } }>('/api/rundown/:id/:rundownId/state', async (req, reply) =>
    answer(reply, () => rundowns.state(req.params.id, req.params.rundownId)),
  );

  /* --------------------------------------------------------------- outputs */

  type OutReq = FastifyRequest<{ Params: { id: string; output: string } }>;
  for (const name of ['stop', 'next', 'prev', 'clear'] as const) {
    const handler = async (req: OutReq, reply: FastifyReply) =>
      answer(reply, async () => {
        assertOutput(req.params.output);
        await readProject(req.params.id);
        const mount = str(params(req)['mount']);
        const delivered = rundowns.outputVerb(req.params.id, req.params.output, name, mount);
        return { ok: true, verb: name, channel: outputChannel(req.params.id, req.params.output), delivered, ...(mount ? { mount } : {}) };
      });
    app.get(`/api/out/:id/:output/${name}`, handler);
    app.post(`/api/out/:id/:output/${name}`, handler);
  }

  /** An output's timers — shared by every composition mounted on it (`ControlHub.timerHome`). */
  const outTimer = async (req: OutReq, reply: FastifyReply) =>
    answer(reply, async () => {
      assertOutput(req.params.output);
      await readProject(req.params.id);
      const parsed = readTimerRequest(params(req));
      if (!parsed.ok) throw new RundownError(400, parsed.code, parsed.params);
      const channel = outputChannel(req.params.id, req.params.output);
      const delivered = hub.dispatch(channel, {
        verb: 'timer',
        timer: { action: parsed.action, id: parsed.id, ...(parsed.value !== undefined ? { value: parsed.value } : {}) },
        source: 'rest',
      });
      return {
        ok: true,
        verb: 'timer',
        channel,
        delivered,
        timer: { id: parsed.id, action: parsed.action, state: hub.timerState(channel, parsed.id) ?? null },
      };
    });
  app.get('/api/out/:id/:output/timer', outTimer);
  app.post('/api/out/:id/:output/timer', outTimer);

  /** An output's roll transport (Wave R) — shared by every composition mounted on it, like its timers. */
  const outScroll = async (req: OutReq, reply: FastifyReply) =>
    answer(reply, async () => {
      assertOutput(req.params.output);
      await readProject(req.params.id);
      const parsed = readScrollRequest(params(req));
      if (!parsed.ok) throw new RundownError(400, parsed.code, parsed.params);
      const channel = outputChannel(req.params.id, req.params.output);
      const delivered = hub.dispatch(channel, {
        verb: 'scroll',
        scroll: {
          action: parsed.action,
          id: parsed.id,
          ...(parsed.value !== undefined ? { value: parsed.value } : {}),
          ...(parsed.percent ? { percent: true } : {}),
        },
        source: 'rest',
      });
      return {
        ok: true,
        verb: 'scroll',
        channel,
        delivered,
        scroll: { id: parsed.id, action: parsed.action, state: hub.scrollState(channel, parsed.id), info: hub.scrollInfo(channel, parsed.id) ?? null },
      };
    });
  app.get('/api/out/:id/:output/scroll', outScroll);
  app.post('/api/out/:id/:output/scroll', outScroll);

  app.get<{ Params: { id: string; output: string } }>('/api/out/:id/:output/state', async (req, reply) =>
    answer(reply, async () => {
      assertOutput(req.params.output);
      const channel = outputChannel(req.params.id, req.params.output);
      const mounts = rundowns.mountsOf(req.params.id, req.params.output).map((m) => ({
        ...m,
        state: hub.state(outputMountChannel(req.params.id, req.params.output, m.composition)).playback?.state ?? 'idle',
      }));
      const timers = hub.timersPayload(channel);
      // The same shape as a graphic's `/state`: each scroll's state and what the outputs said about it.
      const scrolls = hub.scrollSummary(channel);
      return {
        channel,
        renderers: hub.state(channel).renderers,
        mounts,
        ...(timers ? { timers } : {}),
        ...(scrolls.length ? { scrolls: { clock: Date.now(), items: scrolls } } : {}),
      };
    }),
  );

  /* ------------------------------------------------------------- websocket */

  /*
   * Rundown verbs over the socket: a panel or a control surface subscribed to
   * `${project}/#rundowns` sends `{ verb: 'cue' | 'take' | 'rundownNext' |
   * 'rundownPrev' | 'out', rundown, item?, target? }`. Everything sent on that
   * channel is handled here and never dispatched — nothing renders on it.
   */
  hub.intercept((channel, command: ControlCommand, client) => {
    if (channelKind(channel) !== 'rundown') return false;
    const projectId = channel.slice(0, channel.indexOf('/'));
    const rundownId = command.rundown;
    if (!rundownId) {
      client.send({ type: 'error', message: 'rundown commands need a rundown id', code: 'error.rundownNotFound' });
      return true;
    }
    const run = async (): Promise<unknown> => {
      switch (command.verb) {
        case 'cue': return rundowns.cue(projectId, rundownId, command.item ?? null);
        case 'rundownNext': return rundowns.step(projectId, rundownId, 1);
        case 'rundownPrev': return rundowns.step(projectId, rundownId, -1);
        case 'take':
          return rundowns.take(projectId, rundownId, {
            ...(command.item ? { item: command.item } : {}),
            advance: command.advance !== false,
            source: 'panel',
          });
        case 'out': return rundowns.out(projectId, rundownId, command.target);
        default: return undefined;
      }
    };
    run().catch((err: unknown) => {
      const code = err instanceof RundownError ? err.code : 'error.rundownFailed';
      const params = err instanceof RundownError ? err.params : undefined;
      client.send({ type: 'error', message: fail(code, params).error, code });
    });
    return true;
  });

  /* ----------------------------------------------------------------- pages */

  app.get<{ Params: { id: string; output: string } }>('/out/:id/:output', async (req, reply) => {
    const project = await readProject(req.params.id);
    if (!OUTPUT_NAME_PATTERN.test(req.params.output)) {
      reply.code(400);
      return fail('error.outputName');
    }
    reply.type('text/html; charset=utf-8');
    reply.header('cache-control', 'no-store, must-revalidate');
    return outPage({
      projectId: project.id,
      output: req.params.output,
      compositions: project.compositions,
      assetBase: `/assets/${encodeURIComponent(project.id)}`,
      cacheBust: project.updatedAt,
      datasets: data?.datasets(project.id) ?? {},
      mode: await readMode(project.id),
      keying: keyingOf(req.url),
    });
  });

  app.get<{ Params: { id: string } }>('/rundown/:id', async (req, reply) => {
    const project = await readProject(req.params.id);
    const compositions = await Promise.all(
      project.compositions.map(async (c) => ({
        id: c.id,
        name: c.name,
        bindings: await panelBindingsFor(project, c),
      })),
    );
    reply.type('text/html; charset=utf-8');
    reply.header('cache-control', 'no-store');
    return rundownPage({ project, compositions });
  });

  return rundowns;
}
