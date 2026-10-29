// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * OGraf interop (Phase 9 Wave D, PHASE9.md §3).
 *
 * **D1 — the OGraf Server API, renderer side**, at `/ograf/v1`. The EBU's
 * controller ↔ renderer REST API (v1, stable since 2026-08-13), laid over the
 * hub so an OGraf controller — SPX, coralPlay, Sofie and SuperConductor when
 * they ship — drives Breeze graphics exactly as a Companion button does. The
 * mapping:
 *
 *  - a **graphic** is a composition, id `<project>~<composition>`;
 *  - a **renderer** is a project, id the project id;
 *  - a **render target** is a channel the renderer can show a graphic on —
 *    `{ "channel": "<composition or scene element>" }`, which shows its own
 *    composition and nothing else, or `{ "channel": "@<output>" }`, which
 *    shows any composition of the project (Phase 9 Wave A outputs);
 *  - a **graphic instance** is a graphic on a target, and its id is the hub
 *    channel it plays on: the channel name, or `@<output>~<composition>`.
 *    Deterministic on purpose: an id survives a server restart, and a
 *    controller and the control panel are looking at the same thing.
 *
 * `load` on a composition's own channel sends the values as `update` — a
 * Breeze channel *is* its graphic, so there is nothing to put there first,
 * and on air that is a live edit, as typing in the panel is. On an output it
 * mounts the composition without playing it. `playAction` resolves when the
 * outputs report the hold (or the end), so `currentStep` is what is on air,
 * not what was asked for; with no output connected it says what was asked.
 *
 * **D2 — the pointer package**: `GET /api/projects/:id/compositions/:compId/ograf`
 * zips a manifest and `graphic.mjs` (`ograf-package.ts`). The same two files
 * are served unzipped under `/ograf/package/<graphic id>/`, and `GET
 * /ograf/v1/graphics/<id>` points at them in `metadata.content` — the
 * convention SuperFly's reference server and the OGraf DevTool use to load a
 * graphic straight from a server.
 *
 * Reads are open, like every read on this server; the actions need the API
 * key when one is set (`app.ts`) — as `X-Breeze-Key`, `?key=`, or
 * `Authorization: Bearer`. CORS is open on `/ograf/`, as the Server API
 * suggests, so a web-based controller can reach it.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  OUTPUT_NAME_PATTERN,
  TIMER_ACTIONS,
  TIMER_ID_PATTERN,
  DEFAULT_TIMER_ID,
  DEFAULT_SCROLL_ID,
  SCROLL_ACTIONS,
  SCROLL_ID_PATTERN,
  bindingsJsonSchema,
  collectScrolls,
  collectTimers,
  displayName,
  ografCurrentStep,
  ografGraphicId,
  ografManifest,
  ografStepCount,
  ografTargetStep,
  outputChannel,
  outputMountChannel,
  pagedTables,
  parseOgrafGraphicId,
  type Composition,
  type Project,
} from '@breeze/schema';

import { actorOf } from '../audit.js';
import type { ControlCommand, ControlHub } from '../hub.js';
import { writeArchive } from '../archive/zip.js';
import { OGRAF_MAIN, ografManifestFile, pointerModule, serverOrigin } from '../ograf-package.js';
import { NotFoundError, listChannels, listProjects, readProject, readRundowns } from '../store.js';
import { APP_VERSION } from '../version.js';
import { setProjectMode } from './mode.js';
import type { RundownController } from './rundowns.js';

/** Where the Server API lives. The `/ograf/v1` prefix is the specification's own example. */
export const OGRAF_BASE = '/ograf/v1';
/** Where a graphic's pointer files are served, unzipped. */
export const OGRAF_PACKAGE_BASE = '/ograf/package';

/** The Server API's CORS headers, verbatim, plus the two ways our key travels. */
export function ografCors(reply: FastifyReply): void {
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-allow-methods', 'GET, PUT, POST, HEAD, OPTIONS, DELETE');
  reply.header('access-control-allow-headers', 'Content-Type, Accept, Authorization, X-Breeze-Key');
  reply.header('access-control-max-age', '3600');
}

/* ------------------------------------------------------------- refusals */

/** An RFC 7807 problem, the Server API's error body, with our code beside it. */
class OgrafProblem extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'OgrafProblem';
  }
}

function sendProblem(reply: FastifyReply, req: FastifyRequest, err: OgrafProblem): unknown {
  reply.code(err.status);
  return { title: err.title, status: err.status, detail: err.detail, instance: req.url.split('?')[0] };
}

const notFound = (detail: string) => new OgrafProblem(404, 'Not Found', detail);
const badRequest = (detail: string) => new OgrafProblem(400, 'Bad Request', detail);

/** Run a handler, answering a refusal — ours or the store's — as a problem. */
async function answer<T>(req: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OgrafProblem) return sendProblem(reply, req, err);
    if (err instanceof NotFoundError) return sendProblem(reply, req, notFound(err.message));
    throw err;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  return isRecord(req.body) ? req.body : {};
}

/** The origin a client reached this server on — what a pointer package must call back to. */
function requestOrigin(req: FastifyRequest): string {
  const host = req.headers.host ?? `localhost`;
  return `${req.protocol}://${host}`;
}

/* -------------------------------------------------------------- targets */

/** A place a graphic can be shown, resolved. */
type Target =
  | { kind: 'channel'; channel: string; ref: string; name: string }
  | { kind: 'output'; output: string };

/** The identifier a controller sends back — a shallow object, as the API requires. */
function targetId(target: Target): { channel: string } {
  return { channel: target.kind === 'channel' ? target.channel : `@${target.output}` };
}

/** Hub channel of an instance of `composition` on `target`. */
function instanceChannel(projectId: string, target: Target, composition: string): string {
  return target.kind === 'channel'
    ? `${projectId}/${target.channel}`
    : outputMountChannel(projectId, target.output, composition);
}

/** The project half of a hub channel key. */
function projectOf(channel: string): string {
  return channel.slice(0, channel.indexOf('/'));
}

/** The instance id: the channel name after the project. */
function instanceId(target: Target, composition: string): string {
  return target.kind === 'channel' ? target.channel : `@${target.output}~${composition}`;
}

/* ------------------------------------------------------------- the facade */

interface Instance {
  target: Target;
  composition: Composition;
  /** Hub channel the graphic plays on. */
  channel: string;
  id: string;
}

export class OgrafFacade {
  /**
   * The step each instance was last sent to, for an answer when no output is
   * connected to report one. Reports win whenever there are any.
   */
  private sent = new Map<string, number | undefined>();

  constructor(
    private readonly hub: ControlHub,
    private readonly rundowns: RundownController,
  ) {}

  /* ---------------------------------------------------------- reading */

  /** Outputs a controller can be offered: any a rundown names, has open, or has something on. */
  async outputs(projectId: string): Promise<string[]> {
    const names = new Set<string>();
    try {
      for (const r of (await readRundowns(projectId)).rundowns) for (const i of r.items) if (i.output) names.add(i.output);
    } catch {
      // No rundowns, or none readable: the other two sources still count.
    }
    const prefix = `${projectId}/@`;
    for (const channel of this.hub.activeChannels) {
      if (!channel.startsWith(prefix)) continue;
      const name = channel.slice(prefix.length).split('~')[0]!;
      if (OUTPUT_NAME_PATTERN.test(name)) names.add(name);
    }
    return [...names].sort();
  }

  async resolveTarget(projectId: string, raw: unknown): Promise<Target> {
    let value = raw;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        throw badRequest('renderTarget must be a JSON object, such as {"channel":"lower-third"}.');
      }
    }
    const channel = isRecord(value) && typeof value['channel'] === 'string' ? value['channel'].trim() : '';
    if (!channel) throw badRequest('renderTarget needs a "channel": a composition or scene element, or "@<output>".');
    if (channel.startsWith('@')) {
      const output = channel.slice(1);
      if (!OUTPUT_NAME_PATTERN.test(output)) throw badRequest(`"${output}" is not a usable output name.`);
      return { kind: 'output', output };
    }
    const found = (await listChannels(projectId)).find((c) => c.channel === channel);
    if (!found) throw notFound(`Renderer "${projectId}" has no render target "${channel}".`);
    return { kind: 'channel', channel: found.channel, ref: found.ref, name: found.name };
  }

  /** Every instance on a renderer: each channel's own graphic, and what is mounted on each output. */
  async instances(project: Project): Promise<Instance[]> {
    const byId = new Map(project.compositions.map((c) => [c.id, c]));
    const out: Instance[] = [];
    for (const ref of await listChannels(project.id)) {
      const composition = byId.get(ref.ref);
      if (!composition) continue;
      const target: Target = { kind: 'channel', channel: ref.channel, ref: ref.ref, name: ref.name };
      out.push({ target, composition, channel: instanceChannel(project.id, target, ref.ref), id: instanceId(target, ref.ref) });
    }
    for (const output of await this.outputs(project.id)) {
      const target: Target = { kind: 'output', output };
      for (const mount of this.rundowns.mountsOf(project.id, output)) {
        const composition = byId.get(mount.composition);
        if (!composition) continue;
        out.push({
          target,
          composition,
          channel: instanceChannel(project.id, target, composition.id),
          id: instanceId(target, composition.id),
        });
      }
    }
    return out;
  }

  /** The instance a request names, checked against the target it names. */
  async instance(projectId: string, rawTarget: unknown, rawId: unknown): Promise<Instance & { project: Project }> {
    const project = await readProject(projectId);
    const target = await this.resolveTarget(project.id, rawTarget);
    const id = typeof rawId === 'string' ? rawId : '';
    let compositionId: string | undefined;
    if (target.kind === 'channel') {
      if (id === target.channel) compositionId = target.ref;
    } else {
      const prefix = `@${target.output}~`;
      const comp = id.startsWith(prefix) ? id.slice(prefix.length) : '';
      if (comp && this.rundowns.mountsOf(project.id, target.output).some((m) => m.composition === comp)) compositionId = comp;
    }
    const composition = compositionId ? project.compositions.find((c) => c.id === compositionId) : undefined;
    if (!composition) {
      throw notFound(`No graphic instance "${id}" on render target ${JSON.stringify(targetId(target))} — load one first.`);
    }
    return { project, target, composition, channel: instanceChannel(project.id, target, composition.id), id };
  }

  targetInfo(project: Project, target: Target, instances: Instance[]): Record<string, unknown> {
    const mine = instances.filter((i) => JSON.stringify(targetId(i.target)) === JSON.stringify(targetId(target)));
    return {
      renderTarget: targetId(target),
      name: target.kind === 'channel' ? target.name : `Output ${target.output}`,
      description:
        target.kind === 'channel'
          ? `Shows “${target.name}” — /play/${project.id}/${target.channel}`
          : `Shows any graphic of this project, stacked — /out/${project.id}/${target.output}`,
      graphicInstances: mine.map((i) => ({
        graphicInstanceId: i.id,
        graphic: { id: ografGraphicId(project.id, i.composition.id), name: displayName(i.composition.name, i.composition.id) },
      })),
    };
  }

  async rendererInfo(project: Project): Promise<Record<string, unknown>> {
    const channels = await listChannels(project.id);
    const outputs = await this.outputs(project.id);
    const instances = await this.instances(project);
    const targets: Target[] = [
      ...channels.map((c): Target => ({ kind: 'channel', channel: c.channel, ref: c.ref, name: c.name })),
      ...outputs.map((output): Target => ({ kind: 'output', output })),
    ];

    // Output pages connected to anything in this project — a renderer with none renders nothing.
    let pages = 0;
    const prefix = `${project.id}/`;
    for (const channel of this.hub.activeChannels) {
      if (!channel.startsWith(prefix) || channel.includes('~') || channel.includes('#')) continue;
      pages += this.hub.state(channel).renderers;
    }

    const values = targets.map((t) => targetId(t).channel);
    const labels: Record<string, string> = {};
    for (const t of targets) labels[targetId(t).channel] = t.kind === 'channel' ? t.name : `Output ${t.output}`;

    return {
      id: project.id,
      name: displayName(project.name, project.id),
      description: `Breeze Overlay project “${displayName(project.name, project.id)}”. Each render target is a channel its output pages follow.`,
      customActions: [
        {
          id: 'mode',
          name: 'Project mode',
          description: 'Set the mode every graphic in the project reads in its layer rules. Empty clears it.',
          schema: { type: 'object', properties: { mode: { type: 'string', title: 'Mode' } }, required: ['mode'] },
        },
      ],
      renderTargetSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            title: 'Channel',
            description: 'A graphic’s own channel shows that graphic; an output (@name) shows any graphic of the project.',
            ...(values.length ? { enum: values, gddType: 'select', gddOptions: { labels } } : {}),
          },
        },
        required: ['channel'],
      },
      status:
        pages > 0
          ? { status: 'OK', message: `${pages} output page${pages === 1 ? '' : 's'} connected.` }
          : { status: 'WARNING', message: 'No output page is connected: commands are accepted, and nothing shows them.' },
      renderTargets: targets.map((t) => this.targetInfo(project, t, instances)),
    };
  }

  /* -------------------------------------------------------- the actions */

  /** Where a channel is, in OGraf steps: the outputs' report, else what was last sent. */
  currentStep(instance: Instance): number | undefined {
    const state = this.hub.state(instance.channel);
    const stepCount = ografStepCount(instance.composition);
    // A connected output's own report — not the channel's retained one, which
    // may be the last word of an output that has since gone.
    if (state.sources.some((s) => s.playback !== null) && state.playback) return ografCurrentStep(state.playback, stepCount);
    return this.sent.get(instance.channel);
  }

  /** Send a transport command to an instance: to its channel, or through its output for a mount. */
  transport(projectId: string, instance: Instance, command: ControlCommand): number {
    if (instance.target.kind === 'channel') return this.hub.dispatch(instance.channel, command);
    return this.hub.dispatch(outputChannel(projectId, instance.target.output), { ...command, mount: instance.composition.id });
  }

  /**
   * Wait until the instance's outputs report a state `done` accepts, after
   * `since`. Polled rather than hooked into the hub: it costs nothing while no
   * OGraf call is waiting, and the hub stays free of request lifetimes.
   */
  private async settle(
    instance: Instance,
    since: number,
    done: (playback: { state: string; step: number }) => boolean,
    capMs: number,
  ): Promise<void> {
    const deadline = Date.now() + capMs;
    while (Date.now() < deadline) {
      const state = this.hub.state(instance.channel);
      // Nothing will report: no output on the channel — or, for a mount, on the
      // output, whose page may be mounting it this moment.
      if (state.renderers === 0 && !this.mountComing(projectOf(instance.channel), instance)) return;
      if (state.playback && state.reportedAt !== null && state.reportedAt >= since && done(state.playback)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  /** A mount whose output page is connected, so a report from the mount is on its way. */
  private mountComing(projectId: string, instance: Instance): boolean {
    return instance.target.kind === 'output' && this.hub.state(outputChannel(projectId, instance.target.output)).renderers > 0;
  }

  /** How long to wait for an animation, at most: the graphic's length and a margin, within reason. */
  private cap(composition: Composition, skip: boolean): number {
    if (skip) return 2_000;
    return Math.min(30_000, Math.max(3_000, ((composition.duration ?? 10) + 2) * 1000));
  }

  async play(projectId: string, instance: Instance, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const skip = params['skipAnimation'] === true;
    const stepCount = ografStepCount(instance.composition);
    const since = Date.now();

    // The zero-step model: in, and out by itself. Answered at once.
    if (stepCount === 0) {
      this.transport(projectId, instance, skip ? { verb: 'stop', cut: true, source: 'ograf' } : { verb: 'play', source: 'ograf' });
      this.sent.set(instance.channel, undefined);
      return { graphicInstanceId: instance.id, statusCode: 200 };
    }

    const target = ografTargetStep({
      current: this.currentStep(instance),
      stepCount,
      goto: params['goto'],
      delta: params['delta'],
    });

    if (target === undefined) {
      await this.stop(projectId, instance, { skipAnimation: skip });
      return { graphicInstanceId: instance.id, statusCode: 200 };
    }

    const delivered = this.transport(projectId, instance, { verb: 'step', step: target + 1, ...(skip ? { cut: true } : {}), source: 'ograf' });
    this.sent.set(instance.channel, target);
    if (delivered > 0) {
      await this.settle(instance, since, (p) => p.state !== 'playing-in' && p.state !== 'idle', this.cap(instance.composition, skip));
    }
    const reached = this.currentStep(instance);
    return {
      graphicInstanceId: instance.id,
      statusCode: 200,
      ...(reached !== undefined ? { currentStep: reached } : {}),
      v_delivered: delivered,
    };
  }

  async stop(projectId: string, instance: Instance, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const skip = params['skipAnimation'] === true;
    const since = Date.now();
    // On a graphic's own channel a cut is CLEAR; on an output, CLEAR would unmount it.
    const delivered =
      skip && instance.target.kind === 'channel'
        ? this.hub.dispatch(instance.channel, { verb: 'clear', source: 'ograf' })
        : this.transport(projectId, instance, { verb: 'stop', ...(skip ? { cut: true } : {}), source: 'ograf' });
    this.sent.set(instance.channel, undefined);
    if (delivered > 0) {
      await this.settle(instance, since, (p) => p.state !== 'playing-out' && p.state !== 'holding', this.cap(instance.composition, skip));
    }
    return { graphicInstanceId: instance.id, statusCode: 200, v_delivered: delivered };
  }

  update(instance: Instance, data: Record<string, unknown>): number {
    return this.hub.dispatch(instance.channel, { verb: 'update', data, source: 'ograf' });
  }

  /** A graphic's custom action — page controls and timers, as the manifest lists them. */
  custom(projectId: string, instance: Instance, id: string, payload: Record<string, unknown>): Record<string, unknown> {
    const table = typeof payload['table'] === 'string' && payload['table'].trim() !== '' ? payload['table'].trim() : undefined;
    const withTable = table !== undefined ? { table } : {};
    let delivered: number;
    switch (id) {
      case 'next':
      case 'prev':
        delivered = this.transport(projectId, instance, { verb: id, ...withTable, source: 'ograf' });
        break;
      case 'page': {
        const key = typeof payload['key'] === 'string' && payload['key'].trim() !== '' ? payload['key'].trim() : undefined;
        const n = payload['page'];
        if (key === undefined && !(typeof n === 'number' && Number.isInteger(n) && n >= 1)) {
          throw badRequest('page needs "page" (a whole number, 1 or more) or "key".');
        }
        delivered = this.transport(projectId, instance, {
          verb: 'page',
          ...(key !== undefined ? { key } : { page: n as number }),
          ...withTable,
          source: 'ograf',
        });
        break;
      }
      case 'cycle': {
        const state = payload['state'];
        if (state !== 'hold' && state !== 'resume') throw badRequest('cycle needs "state": hold or resume.');
        delivered = this.transport(projectId, instance, { verb: 'cycle', cycle: state, ...withTable, source: 'ograf' });
        break;
      }
      case 'timer': {
        const action = payload['action'];
        if (typeof action !== 'string' || !(TIMER_ACTIONS as readonly string[]).includes(action)) {
          throw badRequest(`timer needs "action": one of ${TIMER_ACTIONS.join(', ')}.`);
        }
        const timerId = typeof payload['id'] === 'string' && payload['id'].trim() !== '' ? payload['id'].trim() : DEFAULT_TIMER_ID;
        if (!TIMER_ID_PATTERN.test(timerId)) throw badRequest(`"${timerId}" is not a timer id.`);
        const value = typeof payload['value'] === 'number' && Number.isFinite(payload['value']) ? payload['value'] : undefined;
        if ((action === 'set' || action === 'add') && value === undefined) throw badRequest(`timer ${action} needs "value" in milliseconds.`);
        // Timers live on the channel — an output's are shared by its mounts (`ControlHub.timerHome`).
        delivered = this.hub.dispatch(instance.channel, {
          verb: 'timer',
          timer: { action: action as (typeof TIMER_ACTIONS)[number], id: timerId, ...(value !== undefined ? { value } : {}) },
          source: 'ograf',
        });
        return {
          graphicInstanceId: instance.id,
          statusCode: 200,
          result: this.hub.timerState(instance.channel, timerId) ?? null,
          v_delivered: delivered,
        };
      }
      case 'scroll': {
        // Wave R: the roll transport, homed like timers (`ControlHub.timerHome`).
        const action = payload['action'];
        if (typeof action !== 'string' || !(SCROLL_ACTIONS as readonly string[]).includes(action)) {
          throw badRequest(`scroll needs "action": one of ${SCROLL_ACTIONS.join(', ')}.`);
        }
        const scrollId = typeof payload['id'] === 'string' && payload['id'].trim() !== '' ? payload['id'].trim() : DEFAULT_SCROLL_ID;
        if (!SCROLL_ID_PATTERN.test(scrollId)) throw badRequest(`"${scrollId}" is not a scroll id.`);
        const value = typeof payload['value'] === 'number' && Number.isFinite(payload['value']) ? payload['value'] : undefined;
        if ((action === 'speed' || action === 'jog' || action === 'seek') && value === undefined) {
          throw badRequest(`scroll ${action} needs a numeric "value".`);
        }
        delivered = this.hub.dispatch(instance.channel, {
          verb: 'scroll',
          scroll: {
            action: action as (typeof SCROLL_ACTIONS)[number],
            id: scrollId,
            ...(value !== undefined ? { value } : {}),
            ...(payload['percent'] === true ? { percent: true } : {}),
          },
          source: 'ograf',
        });
        return {
          graphicInstanceId: instance.id,
          statusCode: 200,
          result: this.hub.scrollState(instance.channel, scrollId),
          v_delivered: delivered,
        };
      }
      default:
        throw notFound(`Graphic "${ografGraphicId(projectId, instance.composition.id)}" has no custom action "${id}".`);
    }
    return { graphicInstanceId: instance.id, statusCode: 200, v_delivered: delivered };
  }
}

/* ------------------------------------------------------------- manifests */

/** The manifest of one composition, pointing at `server`. */
function manifestFor(project: Project, composition: Composition, server: string): Record<string, unknown> {
  const byId = new Map(project.compositions.map((c) => [c.id, c]));
  const resolve = (id: string) => byId.get(id);
  return ografManifest({
    projectId: project.id,
    projectName: project.name,
    composition,
    version: project.updatedAt,
    server,
    dataSchema: bindingsJsonSchema(composition, resolve),
    tables: pagedTables(composition, resolve),
    timers: collectTimers(composition.layers, resolve).length > 0,
    scrolls: collectScrolls(composition.layers, resolve).length > 0,
    main: OGRAF_MAIN,
  });
}

async function graphicOf(rawId: string): Promise<{ project: Project; composition: Composition }> {
  const parsed = parseOgrafGraphicId(rawId);
  if (!parsed) throw notFound(`No graphic "${rawId}". Graphic ids here are <project>~<composition>.`);
  let project: Project;
  try {
    project = await readProject(parsed.project);
  } catch {
    throw notFound(`No graphic "${rawId}": there is no project "${parsed.project}".`);
  }
  const composition = project.compositions.find((c) => c.id === parsed.composition);
  if (!composition) throw notFound(`No graphic "${rawId}": project "${project.id}" has no composition "${parsed.composition}".`);
  return { project, composition };
}

/** The files of a pointer package, by name. */
function packageFiles(project: Project, composition: Composition, server: string): Record<string, string> {
  return {
    [ografManifestFile(composition.id)]: `${JSON.stringify(manifestFor(project, composition, server), null, 2)}\n`,
    [OGRAF_MAIN]: pointerModule({
      server,
      projectId: project.id,
      compositionId: composition.id,
      name: displayName(composition.name, composition.id),
    }),
  };
}

/* ---------------------------------------------------------------- routes */

export async function registerOgrafRoutes(
  app: FastifyInstance,
  hub: ControlHub,
  rundowns: RundownController,
): Promise<OgrafFacade> {
  const facade = new OgrafFacade(hub, rundowns);
  const at = (path: string) => `${OGRAF_BASE}${path}`;

  // Preflight for a browser-based controller. Headers come from the hook in app.ts.
  app.options('/ograf/*', async (_req, reply) => reply.code(204).send());

  /* ---------------------------------------------------------- server */

  const info = async () => ({
    name: 'Breeze Overlay OGraf server',
    description:
      'Breeze Overlay, speaking the OGraf Server API: each project is a renderer, each composition a graphic, ' +
      'and each channel a render target its output pages follow.',
    author: { name: 'Breeze Overlay', url: 'https://github.com/dwclarkphx/breeze-overlay' },
    version: APP_VERSION,
  });
  app.get(OGRAF_BASE, info);
  app.get(at('/'), info);

  /* -------------------------------------------------------- graphics */

  app.get(at('/graphics'), async () => {
    const graphics: Array<Record<string, unknown>> = [];
    for (const summary of await listProjects()) {
      for (const c of summary.compositions) {
        graphics.push({
          id: ografGraphicId(summary.id, c.id),
          name: displayName(c.name, c.id),
          description: `${displayName(summary.name, summary.id)} — Breeze Overlay`,
        });
      }
    }
    return { graphics };
  });

  app.get<{ Params: { graphicId: string } }>(at('/graphics/:graphicId'), async (req, reply) =>
    answer(req, reply, async () => {
      const { project, composition } = await graphicOf(req.params.graphicId);
      const id = ografGraphicId(project.id, composition.id);
      return {
        graphic: manifestFor(project, composition, requestOrigin(req)),
        metadata: {
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          // Not in the specification yet; the reference server's convention, which the DevTool reads.
          content: {
            url: `${OGRAF_PACKAGE_BASE}/${encodeURIComponent(id)}/`,
            files: [{ path: ografManifestFile(composition.id) }, { path: OGRAF_MAIN }],
          },
        },
      };
    }),
  );

  /*
   * A graphic is a composition, and deleting one is the editor's business —
   * it checks what mounts it first (delete guards, 0.62). A controller's
   * DELETE is refused rather than quietly taking a show's graphic away.
   */
  app.delete<{ Params: { graphicId: string } }>(at('/graphics/:graphicId'), async (req, reply) =>
    answer(req, reply, async () => {
      await graphicOf(req.params.graphicId);
      throw new OgrafProblem(403, 'Forbidden', 'Breeze graphics are compositions; delete them in the Breeze editor.');
    }),
  );

  app.get<{ Params: { graphicId: string } }>(at('/graphics/:graphicId/thumbnail'), async (req, reply) =>
    answer(req, reply, async () => {
      await graphicOf(req.params.graphicId);
      throw notFound('Breeze graphics have no thumbnail files.');
    }),
  );

  /* ------------------------------------------------------- renderers */

  app.get(at('/renderers'), async () => {
    const renderers = (await listProjects()).map((p) => ({
      id: p.id,
      name: displayName(p.name, p.id),
      description: `Breeze Overlay project — ${p.compositions.length} graphic${p.compositions.length === 1 ? '' : 's'}`,
    }));
    return { renderers };
  });

  type R = { Params: { rendererId: string } };
  const rendererOf = async (id: string): Promise<Project> => {
    try {
      return await readProject(id);
    } catch {
      throw notFound(`No renderer "${id}". Renderers here are Breeze projects.`);
    }
  };

  app.get<R>(at('/renderers/:rendererId'), async (req, reply) =>
    answer(req, reply, async () => ({ renderer: await facade.rendererInfo(await rendererOf(req.params.rendererId)) })),
  );

  app.get<R & { Querystring: { renderTarget?: string } }>(at('/renderers/:rendererId/target'), async (req, reply) =>
    answer(req, reply, async () => {
      const project = await rendererOf(req.params.rendererId);
      const target = await facade.resolveTarget(project.id, req.query.renderTarget);
      return facade.targetInfo(project, target, await facade.instances(project));
    }),
  );

  app.post<R & { Params: { customActionId: string } }>(
    at('/renderers/:rendererId/customActions/:customActionId'),
    async (req, reply) =>
      answer(req, reply, async () => {
        const project = await rendererOf(req.params.rendererId);
        if (req.params.customActionId !== 'mode') {
          throw notFound(`Renderer "${project.id}" has no custom action "${req.params.customActionId}".`);
        }
        const payload = bodyOf(req)['payload'];
        const mode = isRecord(payload) ? payload['mode'] : undefined;
        const result = await setProjectMode(hub, project.id, mode ?? '', actorOf(req));
        if (!result.ok) throw badRequest(result.error);
        return { result: { mode: result.mode, delivered: result.delivered } };
      }),
  );

  /* ----------------------------------------------- graphic instances */

  app.post<R>(at('/renderers/:rendererId/target/graphicInstance/load'), async (req, reply) =>
    answer(req, reply, async () => {
      const project = await rendererOf(req.params.rendererId);
      const body = bodyOf(req);
      const target = await facade.resolveTarget(project.id, body['renderTarget']);
      const graphicId = typeof body['graphicId'] === 'string' ? body['graphicId'] : '';
      const { project: owner, composition } = await graphicOf(graphicId);
      if (owner.id !== project.id) {
        throw notFound(`Graphic "${graphicId}" belongs to renderer "${owner.id}", not "${project.id}".`);
      }
      if (target.kind === 'channel' && target.ref !== composition.id) {
        throw badRequest(
          `Render target "${target.channel}" shows “${target.name}” only. ` +
            'To show any graphic on one target, use an output: {"channel":"@main"}.',
        );
      }
      const params = isRecord(body['params']) ? body['params'] : {};
      const data = isRecord(params['data']) ? params['data'] : {};
      const channel = instanceChannel(project.id, target, composition.id);
      if (target.kind === 'output') rundowns.mountOnOutput(project.id, target.output, composition.id, data);
      if (Object.keys(data).length > 0) hub.dispatch(channel, { verb: 'update', data, source: 'ograf' });
      return { graphicInstanceId: instanceId(target, composition.id), statusCode: 200, statusMessage: 'Loaded' };
    }),
  );

  type InstanceBody = { renderTarget?: unknown; graphicInstanceId?: unknown; params?: unknown };
  const withInstance = (
    path: string,
    fn: (project: Project, instance: Instance, params: Record<string, unknown>, req: FastifyRequest<R & { Params: { customActionId?: string } }>) => Promise<unknown> | unknown,
  ) => {
    app.post<R & { Params: { customActionId?: string } }>(at(`/renderers/:rendererId/target/graphicInstance/${path}`), async (req, reply) =>
      answer(req, reply, async () => {
        await rendererOf(req.params.rendererId);
        const body = bodyOf(req) as InstanceBody;
        const { project, ...instance } = await facade.instance(req.params.rendererId, body.renderTarget, body.graphicInstanceId);
        return fn(project, instance, isRecord(body.params) ? body.params : {}, req);
      }),
    );
  };

  withInstance('updateAction', (_project, instance, params) => {
    if (!isRecord(params['data'])) throw badRequest('updateAction needs params.data, an object of field values.');
    const delivered = facade.update(instance, params['data']);
    return { graphicInstanceId: instance.id, statusCode: 200, v_delivered: delivered };
  });
  withInstance('playAction', (project, instance, params) => facade.play(project.id, instance, params));
  withInstance('stopAction', (project, instance, params) => facade.stop(project.id, instance, params));
  withInstance('customActions/:customActionId', (project, instance, params, req) =>
    facade.custom(
      project.id,
      instance,
      req.params.customActionId ?? '',
      isRecord(params['payload']) ? params['payload'] : {},
    ),
  );

  app.put<R>(at('/renderers/:rendererId/target/graphicInstance/clear'), async (req, reply) =>
    answer(req, reply, async () => {
      const project = await rendererOf(req.params.rendererId);
      const filters = Array.isArray(bodyOf(req)['filters']) ? (bodyOf(req)['filters'] as unknown[]) : [];
      const instances = await facade.instances(project);

      // Each filter is resolved once, so a bad target in one is a 400, not a silent no-match.
      const resolved = await Promise.all(
        filters.filter(isRecord).map(async (f) => ({
          target: f['renderTarget'] !== undefined ? JSON.stringify(targetId(await facade.resolveTarget(project.id, f['renderTarget']))) : undefined,
          graphicId: typeof f['graphicId'] === 'string' ? f['graphicId'] : undefined,
          instance: typeof f['graphicInstanceId'] === 'string' ? f['graphicInstanceId'] : undefined,
        })),
      );
      const matches = (i: Instance): boolean =>
        resolved.length === 0 ||
        resolved.some(
          (f) =>
            (f.target === undefined || f.target === JSON.stringify(targetId(i.target))) &&
            (f.graphicId === undefined || f.graphicId === ografGraphicId(project.id, i.composition.id)) &&
            (f.instance === undefined || f.instance === i.id),
        );

      const cleared: Array<{ renderTarget: { channel: string }; graphicInstanceId: string }> = [];
      for (const i of instances.filter(matches)) {
        if (i.target.kind === 'channel') hub.dispatch(i.channel, { verb: 'clear', source: 'ograf' });
        else rundowns.outputVerb(project.id, i.target.output, 'clear', i.composition.id);
        cleared.push({ renderTarget: targetId(i.target), graphicInstanceId: i.id });
      }
      return { graphicInstances: cleared };
    }),
  );

  /* ------------------------------------------------ D2: the package */

  /** The pointer package, zipped: one folder named for the graphic. `?server=` overrides the address it calls. */
  app.get<{ Params: { id: string; compId: string }; Querystring: { server?: string } }>(
    '/api/projects/:id/compositions/:compId/ograf',
    async (req, reply) => {
      const project = await readProject(req.params.id);
      const composition = project.compositions.find((c) => c.id === req.params.compId);
      if (!composition) throw new NotFoundError(`composition "${req.params.compId}"`);
      let server = requestOrigin(req);
      if (req.query.server !== undefined) {
        const asked = serverOrigin(req.query.server);
        if (!asked) {
          reply.code(400);
          return { error: 'server must be an http:// or https:// address, such as http://10.0.0.5:7331' };
        }
        server = asked;
      }
      const id = ografGraphicId(project.id, composition.id);
      const files: Record<string, Uint8Array> = {};
      for (const [name, text] of Object.entries(packageFiles(project, composition, server))) {
        files[`${id}/${name}`] = new TextEncoder().encode(text);
      }
      reply.type('application/zip');
      reply.header('cache-control', 'no-store');
      reply.header('content-disposition', `attachment; filename="${id}.ograf.zip"`);
      return writeArchive(files);
    },
  );

  /** The same files unzipped, for a renderer or the DevTool loading straight from this server. */
  app.get<{ Params: { graphicId: string; file: string } }>(`${OGRAF_PACKAGE_BASE}/:graphicId/:file`, async (req, reply) =>
    answer(req, reply, async () => {
      const { project, composition } = await graphicOf(req.params.graphicId);
      const files = packageFiles(project, composition, requestOrigin(req));
      const body = files[req.params.file];
      if (body === undefined) throw notFound(`Graphic "${req.params.graphicId}" has no file "${req.params.file}".`);
      reply.type(req.params.file.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'application/json; charset=utf-8');
      reply.header('cache-control', 'no-store');
      return body;
    }),
  );

  return facade;
}
