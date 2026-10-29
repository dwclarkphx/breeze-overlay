// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * OGraf interop (Phase 9 Wave D, PHASE9.md §3) — the pure half.
 *
 * Two things speak OGraf, and both need the same few answers:
 *
 *  - **D1, the Server API facade** (`apps/server/src/routes/ograf.ts`). An OGraf
 *    controller — SPX, coralPlay, and Sofie or SuperConductor when they ship —
 *    drives Breeze channels over the EBU's REST API.
 *  - **D2, the pointer package** — a manifest and a small `graphic.mjs` that an
 *    OGraf renderer hosts. The module carries no runtime: it frames the live
 *    graphic from the Breeze server, and the page there answers the OGraf
 *    actions (`client/player.ts`, `@breeze/runtime` `OgrafAdapter`).
 *
 * The answers: what a graphic is called, how many steps it has and where a
 * `playAction` lands, what the manifest says, and the data schema in the shape
 * an OGraf form generator (GDD) draws best. Kept here, DOM-free and
 * dependency-free, so the server, the output page and the tests all compute
 * them the same way.
 *
 * Spec: https://github.com/ebu/ograf — v1 Graphics specification and Server API
 * v1 (stable since 2026-08-13), re-read when Wave D opened on 2026-10-26.
 */

import type { Composition } from './types.js';

/** The manifest `$schema`, which doubles as the OGraf version. MUST be exactly this. */
export const OGRAF_MANIFEST_SCHEMA = 'https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json';

/**
 * Between project and composition in a graphic id: `demo-1iixd~l3rd-name-2a94g`.
 *
 * OGraf allows any character in an id except `/`, so the channel key's own
 * separator is out. `~` is outside both id alphabets (`keys.ts`, current and
 * legacy), so the split is never ambiguous — a `.` is in the legacy alphabet
 * and would be — and, unlike `:`, it is legal in a Windows file name, which
 * matters because the id names the pointer package's folder.
 *
 * A frozen identifier (I18N.md §2): it reaches controllers' rundowns.
 */
export const OGRAF_ID_SEPARATOR = '~';

export function ografGraphicId(projectId: string, compositionId: string): string {
  return `${projectId}${OGRAF_ID_SEPARATOR}${compositionId}`;
}

/** The two halves of a graphic id, or null when it is not one of ours. */
export function parseOgrafGraphicId(id: string): { project: string; composition: string } | null {
  const at = id.indexOf(OGRAF_ID_SEPARATOR);
  if (at <= 0 || at === id.length - 1) return null;
  const project = id.slice(0, at);
  const composition = id.slice(at + 1);
  if (composition.includes(OGRAF_ID_SEPARATOR) || project.includes('/') || composition.includes('/')) return null;
  return { project, composition };
}

/* ------------------------------------------------------------------ steps */

/**
 * OGraf's `stepCount`: the number of holds, which is the number of STOP markers.
 *
 * Not `stepCount()` from `bindings.ts`, which never says less than one. Breeze
 * calls a marker-less graphic one step because it has one PLAY; OGraf calls it
 * **zero** steps — "played once, animates out by itself" — which is exactly
 * what a marker-less Breeze graphic does. Saying 1 would tell a controller to
 * wait for a STOP the graphic never needs.
 */
export function ografStepCount(comp: Pick<Composition, 'markers'>): number {
  return (comp.markers ?? []).filter((m) => m.type === 'stop').length;
}

/**
 * Where a graphic is, in OGraf's terms: the 0-based index of the hold it is on
 * or heading to, or `undefined` in the "start" and "end" states.
 *
 * Breeze reports `step` as holds reached — 0 before the first STOP marker, 1 at
 * it — so holding at step `n` is OGraf step `n − 1`, and playing in towards a
 * hold with `n` already passed is OGraf step `n`.
 */
export function ografCurrentStep(
  playback: { state: string; step: number } | null | undefined,
  stepCount: number,
): number | undefined {
  if (!playback || stepCount <= 0) return undefined;
  const step = Number.isFinite(playback.step) ? Math.floor(playback.step) : 0;
  if (playback.state === 'holding') return step >= 1 && step <= stepCount ? step - 1 : undefined;
  if (playback.state === 'playing-in') return step < stepCount ? step : undefined;
  return undefined;
}

/**
 * The step a `playAction` lands on — the Graphics specification's rule,
 * verbatim: a `goto` of 0 or more wins; otherwise current + `delta` (default
 * 1), from −1 when the graphic is in its start state. `undefined` means
 * "transition to the end", which is what any target at or past `stepCount`
 * means. A negative target is clamped to the first step: OGraf leaves it
 * unspecified, and the first hold is the nearest thing a controller can mean.
 */
export function ografTargetStep(opts: {
  current: number | undefined;
  stepCount: number;
  goto?: unknown;
  delta?: unknown;
}): number | undefined {
  const { current, stepCount } = opts;
  const goto = typeof opts.goto === 'number' && Number.isInteger(opts.goto) && opts.goto >= 0 ? opts.goto : undefined;
  const delta = typeof opts.delta === 'number' && Number.isInteger(opts.delta) ? opts.delta : 1;
  const target = goto ?? (current ?? -1) + delta;
  if (target >= stepCount) return undefined;
  return Math.max(0, target);
}

/* ------------------------------------------------------------ data schema */

const HEX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** `#abc` → `#aabbcc`, any case → lower; null for anything that is not a hex colour. */
function normalHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = HEX.exec(value.trim());
  if (!m) return null;
  const digits = m[1]!.toLowerCase();
  return `#${digits.length === 3 ? digits.replace(/./g, (c) => c + c) : digits}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` is an instance of the JSON Schema `type`. */
function fitsType(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return isRecord(value);
    default: return true;
  }
}

/** Keywords whose values are data, not schemas — never walked. */
const DATA_KEYWORDS = new Set(['default', 'enum', 'const', 'examples', 'gddOptions', 'required']);

/**
 * Make a schema node one GDD accepts, recursively. GDD is stricter than JSON
 * Schema in three ways that the bindings schema trips over:
 *
 *  - every node needs a `type` — a bare `enum` gets the type its values share;
 *  - an `object` needs `properties`, even an open one — a dataset's row is any
 *    object, so it gets `properties: {}`, which still admits every row;
 *  - a `default` must be of the node's type — one that is not (a `null` from a
 *    layer with nothing in it) is dropped rather than shipped as an error.
 */
function gddNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(gddNode);
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'properties' && isRecord(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, gddNode(sub)]));
    } else {
      out[k] = DATA_KEYWORDS.has(k) ? v : gddNode(v);
    }
  }
  if (out['type'] === undefined && Array.isArray(out['enum']) && out['enum'].length > 0) {
    const kinds = new Set(out['enum'].map((v) => typeof v));
    if (kinds.size === 1) {
      const kind = [...kinds][0];
      if (kind === 'string' || kind === 'number' || kind === 'boolean') out['type'] = kind;
    }
  }
  if (out['type'] === 'object' && !isRecord(out['properties'])) out['properties'] = {};
  if ('default' in out && !fitsType(out['type'], out['default'])) delete out['default'];
  return out;
}

/**
 * The bindings JSON Schema (`bindingsJsonSchema`) in the dialect OGraf
 * controllers draw forms from — GDD, the Graphics Data Definition.
 *
 * GDD is plain JSON Schema plus hints, and it degrades: a controller that does
 * not know a hint draws the basic type. So this only *adds*:
 *
 *  - an `enum` field gains `gddType: "select"` and the labels GDD reads from
 *    `gddOptions.labels`, taken from the `oneOf` titles (which go — GDD does not
 *    read them and they would only be a second copy);
 *  - a colour whose default is a hex colour becomes `color-rrggbb` (or
 *    `color-rrggbbaa`), with the lower-case pattern GDD fixes for it and its
 *    default normalised to match — a default the pattern rejects is an error in
 *    every OGraf validator;
 *  - every property gets an `order`, so the form keeps Breeze's field order;
 *  - every node is made one GDD accepts (`gddNode`).
 *
 * `x-breeze-*` keywords stay. They are unknown keywords to everyone else, which
 * JSON Schema says to ignore.
 */
export function ografDataSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const out: Record<string, unknown> = {};
  let order = 0;
  for (const [key, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) continue;
    const prop = gddNode(raw) as Record<string, unknown>;

    if (Array.isArray(prop['enum']) && (prop['type'] === 'string' || prop['type'] === 'number' || prop['type'] === 'integer')) {
      const labels: Record<string, string> = {};
      const options = Array.isArray(prop['oneOf']) ? prop['oneOf'] : [];
      for (const value of prop['enum']) {
        const option = options.find((o) => isRecord(o) && o['const'] === value);
        labels[String(value)] = isRecord(option) && typeof option['title'] === 'string' ? option['title'] : String(value);
      }
      delete prop['oneOf'];
      prop['gddType'] = 'select';
      prop['gddOptions'] = { labels };
    }

    if (prop['type'] === 'string' && prop['format'] === 'color') {
      const hex = normalHex(prop['default']);
      if (hex && hex.length === 7) {
        prop['gddType'] = 'color-rrggbb';
        prop['pattern'] = '^#[0-9a-f]{6}$';
        prop['default'] = hex;
      } else if (hex && hex.length === 9) {
        prop['gddType'] = 'color-rrggbbaa';
        prop['pattern'] = '^#[0-9a-f]{8}$';
        prop['default'] = hex;
      }
    }

    prop['order'] = order;
    order += 1;
    out[key] = prop;
  }
  return {
    type: 'object',
    ...(typeof schema['title'] === 'string' ? { title: schema['title'] } : {}),
    properties: out,
  };
}

/* --------------------------------------------------------- custom actions */

/** An OGraf `Action`: what a controller lists, and the GDD schema of its payload. */
export interface OgrafAction {
  id: string;
  name: string;
  description?: string;
  schema: Record<string, unknown> | null;
}

const TABLE_PROPERTY = {
  type: 'string',
  title: 'Table',
  description: 'The table to aim at — its binding, <mount>.<binding>, or its layer id. Empty means every table.',
};

/**
 * Custom actions a graphic offers: page controls when it has a table that
 * pages, hold/resume when one cycles, and the operator timer verbs when it
 * shows a timer. Only what applies, so a controller's action list is a true
 * statement about the graphic rather than every verb Breeze has.
 *
 * The project mode is **not** here: it is project-wide in Breeze (CYCLE.md,
 * Wave 6), so on the Server API it is a renderer action, where "renderer" is
 * the project, and a pointer package follows the server's mode.
 */
export function ografCustomActions(opts: { tables: ReadonlyArray<{ cycle: boolean }>; timers: boolean; scrolls?: boolean }): OgrafAction[] {
  const out: OgrafAction[] = [];
  if (opts.tables.length > 0) {
    out.push(
      {
        id: 'next',
        name: 'Next page',
        description: 'Turn a paged table to its next page. With no table named, every table turns — and a table on its last page lets the graphic step on, as the Breeze control panel’s NEXT does.',
        schema: { type: 'object', properties: { table: TABLE_PROPERTY } },
      },
      {
        id: 'prev',
        name: 'Previous page',
        description: 'Turn a paged table back a page.',
        schema: { type: 'object', properties: { table: TABLE_PROPERTY } },
      },
      {
        id: 'page',
        name: 'Go to page',
        description: 'Show one page: a 1-based number, or a page key such as C.',
        schema: {
          type: 'object',
          properties: {
            page: { type: 'integer', title: 'Page', minimum: 1, order: 0 },
            key: { type: 'string', title: 'Page key', order: 1 },
            table: { ...TABLE_PROPERTY, order: 2 },
          },
        },
      },
    );
  }
  if (opts.tables.some((t) => t.cycle)) {
    out.push({
      id: 'cycle',
      name: 'Hold or resume paging',
      description: 'Freeze a self-paging table on its page, or set it going again.',
      schema: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            title: 'Paging',
            enum: ['hold', 'resume'],
            default: 'hold',
            gddType: 'select',
            gddOptions: { labels: { hold: 'Hold', resume: 'Resume' } },
            order: 0,
          },
          table: { ...TABLE_PROPERTY, order: 1 },
        },
        required: ['state'],
      },
    });
  }
  if (opts.timers) {
    out.push({
      id: 'timer',
      name: 'Timer',
      description: 'Start, pause, reset, set or nudge an operator timer. Value is milliseconds: the new reading for set, a signed change for add.',
      schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            title: 'Action',
            enum: ['start', 'pause', 'toggle', 'reset', 'set', 'add'],
            default: 'toggle',
            gddType: 'select',
            gddOptions: {
              labels: { start: 'Start', pause: 'Pause', toggle: 'Start / pause', reset: 'Reset', set: 'Set to', add: 'Add' },
            },
            order: 0,
          },
          id: { type: 'string', title: 'Timer id', default: 'main', order: 1 },
          value: { type: 'integer', title: 'Value', gddType: 'duration-ms', order: 2 },
        },
        required: ['action'],
      },
    });
  }
  if (opts.scrolls) {
    // Wave R: the roll transport, for a graphic with credits or lyrics in it.
    out.push({
      id: 'scroll',
      name: 'Scroll',
      description:
        'Play, pause, reverse or change the speed of a roll. Value: the speed multiple for speed, signed seconds for jog, seconds for seek (or a percentage with percent: true).',
      schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            title: 'Action',
            enum: ['play', 'pause', 'toggle', 'forward', 'backward', 'reverse', 'faster', 'slower', 'speed', 'jog', 'seek', 'restart', 'end', 'reset'],
            default: 'toggle',
            gddType: 'select',
            gddOptions: {
              labels: {
                play: 'Play',
                pause: 'Pause',
                toggle: 'Play / pause',
                forward: 'Forward',
                backward: 'Backward',
                reverse: 'Reverse',
                faster: 'Faster',
                slower: 'Slower',
                speed: 'Set speed',
                jog: 'Jog',
                seek: 'Seek',
                restart: 'To start',
                end: 'To end',
                reset: 'Reset',
              },
            },
            order: 0,
          },
          id: { type: 'string', title: 'Scroll id', default: 'main', order: 1 },
          value: { type: 'number', title: 'Value', order: 2 },
          percent: { type: 'boolean', title: 'Seek value is a percentage', default: false, order: 3 },
        },
        required: ['action'],
      },
    });
  }
  return out;
}

/* ----------------------------------------------------------- the manifest */

/** Seconds to whole milliseconds, never negative. */
const ms = (seconds: number): number => Math.max(0, Math.round(seconds * 1000));

/**
 * `actionDurations` — what a controller can predict about timing, from the
 * markers alone: the intro to each hold, and the outro when the composition
 * states its length. A composition that leaves its length to its keyframes
 * gets no outro figure rather than a guessed one; a wrong duration is worse to
 * a controller than an unknown one.
 */
export function ografActionDurations(comp: Pick<Composition, 'markers' | 'duration'>): Array<Record<string, unknown>> {
  const holds = (comp.markers ?? [])
    .filter((m) => m.type === 'stop')
    .map((m) => m.time)
    .sort((a, b) => a - b);
  const out: Array<Record<string, unknown>> = [];
  if (holds.length === 0) {
    if (typeof comp.duration === 'number') out.push({ type: 'playAction', duration: ms(comp.duration) });
  } else {
    out.push({
      type: 'playAction',
      duration: ms(holds[0]!),
      ...(holds.length > 1
        ? { steps: holds.map((h, i) => ({ step: i, duration: ms(i === 0 ? h : h - holds[i - 1]!) })) }
        : {}),
    });
    if (typeof comp.duration === 'number') out.push({ type: 'stopAction', duration: ms(comp.duration - holds.at(-1)!) });
  }
  out.push({ type: 'updateAction', duration: 0 });
  return out;
}

export interface OgrafManifestOptions {
  projectId: string;
  projectName: string;
  composition: Composition;
  /** The graphic's version — the project's `updatedAt`, which sorts. */
  version: string;
  /** Origin of the Breeze server the package points at, e.g. `http://10.0.0.5:7331`. */
  server: string;
  /** `bindingsJsonSchema(composition, resolve)`. */
  dataSchema: Record<string, unknown>;
  tables: ReadonlyArray<{ cycle: boolean }>;
  timers: boolean;
  /** The graphic has a roll (Wave R). */
  scrolls?: boolean;
  /** The module file name. */
  main: string;
}

/**
 * The `.ograf.json` for a composition — served by D1 and zipped into D2.
 *
 * `supportsNonRealTime` is false. The runtime can seek, but OGraf's
 * non-real-time contract is `goToTime` *and* `setActionsSchedule` — replaying a
 * schedule of plays and stops onto a timeline whose holds, crawls, cycles and
 * timers run on the wall clock — and the post-production renderers that would
 * call it are not a use case (decided 2026-10-25). Claiming it would invite the
 * one caller that would find out it is not true.
 */
export function ografManifest(opts: OgrafManifestOptions): Record<string, unknown> {
  const { composition: comp } = opts;
  const name = comp.name.trim() || comp.id;
  return {
    $schema: OGRAF_MANIFEST_SCHEMA,
    id: ografGraphicId(opts.projectId, comp.id),
    version: opts.version,
    name,
    description:
      `“${name}” from the Breeze Overlay project “${opts.projectName.trim() || opts.projectId}”. ` +
      `A pointer graphic: it shows the live graphic from the Breeze server at ${opts.server}, ` +
      'so it plays only while that server can be reached.',
    author: { name: 'Breeze Overlay', url: 'https://github.com/dwclarkphx/breeze-overlay' },
    main: opts.main,
    customActions: ografCustomActions({ tables: opts.tables, timers: opts.timers, scrolls: opts.scrolls === true }),
    actionDurations: ografActionDurations(comp),
    supportsRealTime: true,
    supportsNonRealTime: false,
    stepCount: ografStepCount(comp),
    schema: ografDataSchema(opts.dataSchema),
    renderRequirements: [
      {
        resolution: { width: { ideal: comp.stage.width }, height: { ideal: comp.stage.height } },
        frameRate: { ideal: comp.stage.fps },
        v_breezeServer: opts.server,
      },
    ],
    v_breeze: {
      kind: 'pointer',
      server: opts.server,
      project: opts.projectId,
      composition: comp.id,
    },
  };
}
