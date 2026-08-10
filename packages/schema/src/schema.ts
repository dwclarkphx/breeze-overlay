// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * JSON Schema (draft 2020-12) for the Breeze composition format v1.
 * Mirrors `types.ts`. Consumed by Ajv in `validate.ts` and emitted to
 * `composition.schema.json` by `scripts/emit-schema.ts` for external tools.
 */

import {
  COLUMN_TYPES,
  DATA_SOURCE_TYPES,
  FILTER_OPS,
  FTP_FORMATS,
  FTP_PROTOCOLS,
  WEATHER_MODES,
  WEATHER_PROVIDERS,
  WEATHER_UNITS,
} from './data.js';
import { LEGACY_KEY_PATTERN } from './keys.js';
import {
  ANIMATABLE_PROPS,
  FORMAT_VERSION,
  ROW_ANIM_PRESET_IDS,
  TEXT_ANIM_PRESET_IDS,
} from './types.js';

/**
 * `LEGACY_KEY_PATTERN` as a JSON Schema `pattern` string.
 *
 * Ajv wants the source without delimiters, and the anchors have to survive:
 * an unanchored pattern would accept `../../etc` because it matches somewhere
 * in the middle, which is precisely the traversal the pattern exists to stop.
 */
const LEGACY_KEY_SOURCE = LEGACY_KEY_PATTERN.source;

/* -------------------------------------------------------------- data model */

const dataColumnSchema = {
  type: 'object',
  required: ['key', 'type'],
  properties: {
    key: { type: 'string', minLength: 1 },
    label: { type: 'string' },
    type: { enum: [...COLUMN_TYPES] },
  },
  additionalProperties: false,
} as const;

const dataValueSchema = {
  anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
} as const;

const dataRowSchema = {
  type: 'object',
  additionalProperties: { $ref: '#/$defs/dataValue' },
} as const;

/**
 * The canonical DataSet, exported for tooling and for the data API's own
 * response validation. Not referenced by the composition schema: a composition
 * embeds a `{columns, rows}` snapshot, never the fetch metadata that goes with
 * a live source.
 */
export const dataSetSchema = {
  type: 'object',
  required: ['columns', 'rows'],
  properties: {
    id: { type: 'string' },
    columns: { type: 'array', items: { $ref: '#/$defs/dataColumn' } },
    rows: { type: 'array', items: { $ref: '#/$defs/dataRow' } },
    fetchedAt: { type: 'string' },
    revision: { type: 'number' },
  },
  additionalProperties: false,
} as const;

const dataTransformSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['op', 'key'],
      properties: {
        op: { const: 'sort' },
        key: { type: 'string', minLength: 1 },
        dir: { enum: ['asc', 'desc'] },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['op', 'key', 'cmp'],
      properties: {
        op: { const: 'filter' },
        key: { type: 'string', minLength: 1 },
        cmp: { enum: [...FILTER_OPS] },
        value: { $ref: '#/$defs/dataValue' },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['op', 'n'],
      properties: { op: { const: 'limit' }, n: { type: 'number', minimum: 0 } },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['op', 'n'],
      properties: { op: { const: 'offset' }, n: { type: 'number', minimum: 0 } },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['op'],
      properties: { op: { const: 'rank' }, as: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    {
      // Every column name is optional and defaulted: an ordinary
      // single-elimination bracket laid out in round order needs `{ op:
      // 'advance' }` and nothing else.
      type: 'object',
      required: ['op'],
      properties: {
        op: { const: 'advance' },
        slot: { type: 'string', minLength: 1 },
        round: { type: 'string', minLength: 1 },
        feeds: { type: 'string', minLength: 1 },
        feedsLoser: { type: 'string', minLength: 1 },
        winner: { type: 'string', minLength: 1 },
        scores: {
          type: 'object',
          required: ['home', 'away'],
          properties: {
            home: { type: 'string', minLength: 1 },
            away: { type: 'string', minLength: 1 },
            shootout: {
              type: 'object',
              required: ['home', 'away'],
              properties: {
                home: { type: 'string', minLength: 1 },
                away: { type: 'string', minLength: 1 },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        fields: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', minLength: 1 },
        },
      },
      additionalProperties: false,
    },
  ],
} as const;

const easeSchema = {
  anyOf: [
    { type: 'string', minLength: 1 },
    {
      type: 'object',
      required: ['type', 'points'],
      properties: {
        type: { const: 'cubicBezier' },
        points: {
          type: 'array',
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
        },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['type', 'steps'],
      properties: {
        type: { const: 'stepped' },
        steps: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  ],
} as const;

const keyframeSchema = {
  type: 'object',
  required: ['t', 'v'],
  properties: {
    t: { type: 'number', minimum: 0 },
    v: { type: 'number' },
    ease: { $ref: '#/$defs/ease' },
  },
  additionalProperties: false,
} as const;

const keyframeTracksSchema = {
  type: 'object',
  properties: Object.fromEntries(
    ANIMATABLE_PROPS.map((p) => [p, { type: 'array', items: { $ref: '#/$defs/keyframe' } }]),
  ),
  additionalProperties: false,
} as const;

const fillSchema = {
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      required: ['type', 'stops'],
      properties: {
        type: { enum: ['linear', 'radial'] },
        angle: { type: 'number' },
        stops: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            required: ['pos', 'color'],
            properties: {
              pos: { type: 'number', minimum: 0, maximum: 1 },
              color: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  ],
} as const;

const strokeSchema = {
  type: 'object',
  required: ['color', 'width'],
  properties: {
    color: { type: 'string' },
    width: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
} as const;

const shadowSchema = {
  type: 'object',
  required: ['color', 'offsetX', 'offsetY', 'blur'],
  properties: {
    color: { type: 'string' },
    offsetX: { type: 'number' },
    offsetY: { type: 'number' },
    blur: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
} as const;

const textStyleSchema = {
  type: 'object',
  required: ['fontFamily', 'fontSize'],
  properties: {
    fontFamily: { type: 'string' },
    fontSize: { type: 'number', exclusiveMinimum: 0 },
    fontWeight: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    fontStyle: { enum: ['normal', 'italic'] },
    fill: { $ref: '#/$defs/fill' },
    stroke: { $ref: '#/$defs/stroke' },
    shadow: { $ref: '#/$defs/shadow' },
    letterSpacing: { type: 'number' },
    lineHeight: { type: 'number' },
    textTransform: { enum: ['none', 'uppercase', 'lowercase', 'capitalize'] },
    align: { enum: ['left', 'center', 'right'] },
    verticalAlign: { enum: ['top', 'middle', 'bottom'] },
    background: { $ref: '#/$defs/fill' },
    padding: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
} as const;

/** Properties shared by every layer type. Spread into each concrete layer. */
const layerBaseProps = {
  id: { type: 'string', minLength: 1 },
  name: { type: 'string' },
  visible: { type: 'boolean' },
  locked: { type: 'boolean' },
  opacity: { type: 'number', minimum: 0, maximum: 1 },
  transform: {
    type: 'object',
    properties: {
      x: { type: 'number' },
      y: { type: 'number' },
      scaleX: { type: 'number' },
      scaleY: { type: 'number' },
      rotation: { type: 'number' },
      skewX: { type: 'number' },
      skewY: { type: 'number' },
      anchorX: { type: 'number' },
      anchorY: { type: 'number' },
    },
    additionalProperties: false,
  },
  size: {
    type: 'object',
    required: ['width', 'height'],
    properties: {
      width: { type: 'number', minimum: 0 },
      height: { type: 'number', minimum: 0 },
    },
    additionalProperties: false,
  },
  keyframes: { $ref: '#/$defs/keyframeTracks' },
  in: { type: 'number', minimum: 0 },
  out: { type: 'number', minimum: 0 },
  blendMode: { type: 'string' },
  effects: {
    type: 'object',
    properties: {
      blur: { type: 'number', minimum: 0 },
      brightness: { type: 'number', minimum: 0 },
      contrast: { type: 'number', minimum: 0 },
      saturate: { type: 'number', minimum: 0 },
      hueRotate: { type: 'number' },
      grayscale: { type: 'number', minimum: 0, maximum: 1 },
      sepia: { type: 'number', minimum: 0, maximum: 1 },
      dropShadow: { $ref: '#/$defs/shadow' },
    },
    additionalProperties: false,
  },
  mask: {
    type: 'object',
    required: ['type', 'x', 'y', 'width', 'height'],
    properties: {
      type: { enum: ['rect', 'ellipse', 'image'] },
      x: { type: 'number' },
      y: { type: 'number' },
      width: { type: 'number', minimum: 0 },
      height: { type: 'number', minimum: 0 },
      feather: { type: 'number', minimum: 0 },
      invert: { type: 'boolean' },
      src: { type: 'string' },
    },
    additionalProperties: false,
  },
  cell: { type: 'string', minLength: 1 },
} as const;

const layerSchema = {
  type: 'object',
  required: ['id', 'type'],
  oneOf: [
    {
      properties: {
        ...layerBaseProps,
        type: { const: 'shape' },
        shape: { enum: ['rect', 'ellipse'] },
        fill: { $ref: '#/$defs/fill' },
        stroke: { $ref: '#/$defs/stroke' },
        cornerRadius: { type: 'number', minimum: 0 },
      },
      required: ['shape'],
      additionalProperties: false,
    },
    {
      properties: {
        ...layerBaseProps,
        type: { const: 'text' },
        text: { type: 'string' },
        binding: { type: 'string' },
        style: { $ref: '#/$defs/textStyle' },
        fit: {
          type: 'object',
          required: ['mode'],
          properties: {
            mode: { enum: ['none', 'width'] },
            maxWidth: { type: 'number', exclusiveMinimum: 0 },
            minScale: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
          },
          additionalProperties: false,
        },
        textAnimPreset: {
          type: 'object',
          required: ['id'],
          properties: {
            /*
             * Enumerated, not a free string. An unknown preset id cannot animate,
             * and the failure is silent on air — the strap simply appears. Better
             * to reject it on save, in the editor, where the author can see it.
             */
            id: { enum: [...TEXT_ANIM_PRESET_IDS] },
            stagger: { type: 'number', minimum: 0 },
            duration: { type: 'number', exclusiveMinimum: 0 },
            ease: { $ref: '#/$defs/ease' },
          },
          additionalProperties: false,
        },
        clock: {
          type: 'object',
          required: ['format'],
          properties: {
            format: { type: 'string', minLength: 1 },
            /*
             * Not enumerated. The IANA zone list is long, versioned and grows;
             * an enum here would reject a valid zone until the schema caught up.
             * The runtime validates it for real by asking Intl, which is the
             * only authority that matters.
             */
            timezone: { type: 'string' },
            tickSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 3600 },
          },
          additionalProperties: false,
        },
      },
      required: ['text', 'style'],
      additionalProperties: false,
    },
    {
      properties: {
        ...layerBaseProps,
        type: { const: 'image' },
        src: { type: 'string' },
        binding: { type: 'string' },
        fit: { enum: ['contain', 'cover', 'fill'] },
      },
      required: ['src'],
      additionalProperties: false,
    },
    {
      properties: {
        ...layerBaseProps,
        type: { const: 'video' },
        src: { type: 'string' },
        binding: { type: 'string' },
        loop: { type: 'boolean' },
        muted: { type: 'boolean' },
        startAt: { type: 'number', minimum: 0 },
        fit: { enum: ['contain', 'cover', 'fill'] },
        // `hold` freezes the last frame, `clear` hides the layer. Ignored when
        // looping, which never ends.
        onEnd: { enum: ['hold', 'clear'] },
      },
      required: ['src'],
      additionalProperties: false,
    },
    {
      properties: {
        ...layerBaseProps,
        type: { const: 'sprite' },
        src: { type: 'string' },
        binding: { type: 'string' },
        // A zero-column grid is a division by zero in the frame solver and a
        // blank graphic on air, so the floor is 1 here rather than a guard at
        // playout.
        cols: { type: 'integer', minimum: 1 },
        rows: { type: 'integer', minimum: 1 },
        // Not bounded against `cols * rows` here — JSON Schema cannot express a
        // relation between two siblings. `validate.ts` carries that rule.
        frameCount: { type: 'integer', minimum: 1 },
        fps: { type: 'number', exclusiveMinimum: 0 },
        startAt: { type: 'number', minimum: 0 },
        loop: { type: 'boolean' },
        onEnd: { enum: ['hold', 'clear'] },
      },
      required: ['src', 'cols', 'rows', 'fps'],
      additionalProperties: false,
    },
    {
      properties: {
        ...layerBaseProps,
        type: { const: 'crawl' },
        speed: { type: 'number' },
        direction: { enum: ['left', 'right'] },
        items: { type: 'array', items: { type: 'string' } },
        binding: { type: 'string' },
        separator: { type: 'string' },
        style: { $ref: '#/$defs/textStyle' },
        // Wave 2: a ticker can read one column of a data source instead of a
        // hand-written list. `items` stays required — it is the fallback when
        // the feed has not answered yet.
        source: { type: 'string' },
        column: { type: 'string' },
        transforms: { type: 'array', items: { $ref: '#/$defs/dataTransform' } },
      },
      required: ['speed', 'direction', 'items', 'style'],
      additionalProperties: false,
    },
    {
      properties: {
        ...layerBaseProps,
        type: { const: 'table' },
        source: { type: 'string' },
        binding: { type: 'string' },
        data: {
          type: 'object',
          required: ['columns', 'rows'],
          properties: {
            columns: { type: 'array', items: { $ref: '#/$defs/dataColumn' } },
            rows: { type: 'array', items: { $ref: '#/$defs/dataRow' } },
          },
          additionalProperties: false,
        },
        transforms: { type: 'array', items: { $ref: '#/$defs/dataTransform' } },
        row: {
          type: 'object',
          required: ['height', 'cells'],
          properties: {
            height: { type: 'number', exclusiveMinimum: 0 },
            gap: { type: 'number', minimum: 0 },
            cells: { type: 'array', items: { $ref: '#/$defs/layer' } },
          },
          additionalProperties: false,
        },
        rowsPerPage: { type: 'integer', minimum: 0 },
        layout: { enum: ['rows'] },
        rowAnim: {
          type: 'object',
          required: ['id'],
          properties: {
            // Enumerated for the same reason the text presets are: an unknown
            // id cannot animate, and the failure is silent on air.
            id: { enum: [...ROW_ANIM_PRESET_IDS] },
            stagger: { type: 'number', minimum: 0 },
            duration: { type: 'number', exclusiveMinimum: 0 },
            ease: { $ref: '#/$defs/ease' },
          },
          additionalProperties: false,
        },
        flip: {
          type: 'object',
          properties: {
            duration: { type: 'number', minimum: 0 },
            ease: { $ref: '#/$defs/ease' },
          },
          additionalProperties: false,
        },
      },
      required: ['row'],
      additionalProperties: false,
    },
    {
      properties: {
        ...layerBaseProps,
        type: { const: 'composition' },
        ref: { type: 'string', minLength: 1 },
        overrides: { type: 'object' },
        independent: { type: 'boolean' },
        // Shape only. "channel requires independent", "no duplicate channels in
        // one scene" and the strict key rules are semantic checks in
        // validate.ts — JSON Schema can express none of them in a form whose
        // error message means anything to the author who caused it.
        channel: { type: 'string', minLength: 1, maxLength: 64 },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    {
      properties: {
        ...layerBaseProps,
        type: { const: 'group' },
        children: { type: 'array', items: { $ref: '#/$defs/layer' } },
      },
      required: ['children'],
      additionalProperties: false,
    },
  ],
} as const;

export const compositionSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://breeze-overlay.local/schemas/composition-v1.json',
  title: 'Breeze Composition v1',
  type: 'object',
  required: ['formatVersion', 'id', 'name', 'stage', 'layers'],
  properties: {
    formatVersion: { const: FORMAT_VERSION },
    /*
     * The *legacy* key pattern, not the creation rule (SCENES.md §6).
     *
     * This document is validated on every read, so the pattern here has to keep
     * accepting every id ever written to disk — including the pre-2026-08
     * unhyphenated `comp1a2b` form and anything a hand-edited project file
     * carries. The strict lowercase 12-character rule belongs at creation time,
     * in the factory and the routes, where rejecting is a save the author can
     * fix rather than a project they can no longer open.
     */
    id: { type: 'string', minLength: 1, pattern: LEGACY_KEY_SOURCE },
    name: { type: 'string' },
    duration: { type: 'number', minimum: 0 },
    stage: {
      type: 'object',
      required: ['width', 'height', 'fps', 'background'],
      properties: {
        width: { type: 'integer', exclusiveMinimum: 0 },
        height: { type: 'integer', exclusiveMinimum: 0 },
        fps: { type: 'number', exclusiveMinimum: 0 },
        background: { type: 'string' },
      },
      additionalProperties: false,
    },
    markers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'time'],
        properties: {
          type: { enum: ['stop', 'cue'] },
          time: { type: 'number', minimum: 0 },
          id: { type: 'string' },
          name: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    layers: { type: 'array', items: { $ref: '#/$defs/layer' } },
    meta: { type: 'object' },
  },
  additionalProperties: false,
  $defs: {
    ease: easeSchema,
    keyframe: keyframeSchema,
    keyframeTracks: keyframeTracksSchema,
    fill: fillSchema,
    stroke: strokeSchema,
    shadow: shadowSchema,
    textStyle: textStyleSchema,
    dataColumn: dataColumnSchema,
    dataValue: dataValueSchema,
    dataRow: dataRowSchema,
    dataTransform: dataTransformSchema,
    layer: layerSchema,
  },
} as const;

/**
 * Data-source definitions — `projects/<id>/datasources.json`.
 *
 * A separate document from the composition on purpose. Source defs are project
 * infrastructure, not part of the graphic: they carry URLs and secret *ids*, so
 * they must not travel inside a composition that gets exported, embedded in a
 * single-file HTML template, or handed to a playout server.
 */
export const dataSourcesSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://breeze-overlay.local/schemas/datasources-v1.json',
  title: 'Breeze Data Sources v1',
  type: 'object',
  required: ['formatVersion', 'sources'],
  properties: {
    formatVersion: { const: FORMAT_VERSION },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'type'],
        oneOf: [
          {
            properties: {
              id: { type: 'string', minLength: 1 },
              name: { type: 'string' },
              type: { const: 'manual' },
              pollInterval: { type: 'number', minimum: 0 },
              enabled: { type: 'boolean' },
              columns: { type: 'array', items: { $ref: '#/$defs/dataColumn' } },
              rows: { type: 'array', items: { $ref: '#/$defs/dataRow' } },
            },
            required: ['columns', 'rows'],
            additionalProperties: false,
          },
          {
            properties: {
              id: { type: 'string', minLength: 1 },
              name: { type: 'string' },
              type: { const: 'http-json' },
              pollInterval: { type: 'number', minimum: 0 },
              enabled: { type: 'boolean' },
              url: { type: 'string', minLength: 1 },
              // `secretId` only — a literal credential in a shareable file is
              // the failure mode this whole split exists to prevent.
              secretId: { type: 'string' },
              headers: { type: 'object', additionalProperties: { type: 'string' } },
              rowPath: { type: 'string' },
              columns: { type: 'array', items: { $ref: '#/$defs/dataColumn' } },
            },
            required: ['url'],
            additionalProperties: false,
          },
          {
            properties: {
              id: { type: 'string', minLength: 1 },
              name: { type: 'string' },
              type: { const: 'http-csv' },
              pollInterval: { type: 'number', minimum: 0 },
              enabled: { type: 'boolean' },
              url: { type: 'string', minLength: 1 },
              secretId: { type: 'string' },
              headers: { type: 'object', additionalProperties: { type: 'string' } },
              delimiter: { type: 'string' },
              header: { type: 'boolean' },
              columns: { type: 'array', items: { $ref: '#/$defs/dataColumn' } },
            },
            required: ['url'],
            additionalProperties: false,
          },
          {
            properties: {
              id: { type: 'string', minLength: 1 },
              name: { type: 'string' },
              type: { const: 'rss' },
              pollInterval: { type: 'number', minimum: 0 },
              enabled: { type: 'boolean' },
              url: { type: 'string', minLength: 1 },
              secretId: { type: 'string' },
              headers: { type: 'object', additionalProperties: { type: 'string' } },
              // No `rowPath`: the adapter knows where entries live in RSS 2.0,
              // RDF and Atom, and that normalization is the point of the type.
              columns: { type: 'array', items: { $ref: '#/$defs/dataColumn' } },
            },
            required: ['url'],
            additionalProperties: false,
          },
          {
            properties: {
              id: { type: 'string', minLength: 1 },
              name: { type: 'string' },
              type: { const: 'xml' },
              pollInterval: { type: 'number', minimum: 0 },
              enabled: { type: 'boolean' },
              url: { type: 'string', minLength: 1 },
              secretId: { type: 'string' },
              headers: { type: 'object', additionalProperties: { type: 'string' } },
              /** Slash path to the repeating element, e.g. `results/game`. */
              rowPath: { type: 'string' },
              columns: { type: 'array', items: { $ref: '#/$defs/dataColumn' } },
            },
            required: ['url'],
            additionalProperties: false,
          },
          {
            properties: {
              id: { type: 'string', minLength: 1 },
              name: { type: 'string' },
              type: { const: 'sheets' },
              pollInterval: { type: 'number', minimum: 0 },
              enabled: { type: 'boolean' },
              // A spreadsheet id, not a URL: this source does not address an
              // arbitrary origin, and accepting a URL would let a def point a
              // server-held credential at something that is not Sheets.
              spreadsheet: { type: 'string', minLength: 1 },
              range: { type: 'string' },
              secretId: { type: 'string' },
              header: { type: 'boolean' },
              columns: { type: 'array', items: { $ref: '#/$defs/dataColumn' } },
            },
            required: ['spreadsheet'],
            additionalProperties: false,
          },
          /* ------------------------------------------------------- Wave 3 */
          {
            properties: {
              id: { type: 'string', minLength: 1 },
              name: { type: 'string' },
              type: { const: 'weather' },
              pollInterval: { type: 'number', minimum: 0 },
              enabled: { type: 'boolean' },
              provider: { enum: [...WEATHER_PROVIDERS] },
              // Only meaningful for `open-meteo-self`; the semantic check in
              // validateDataSources is what enforces that, because JSON Schema
              // cannot express "required iff another property equals X" without
              // an if/then block that reports errors nobody can read.
              baseUrl: { type: 'string', minLength: 1 },
              latitude: { type: 'number', minimum: -90, maximum: 90 },
              longitude: { type: 'number', minimum: -180, maximum: 180 },
              place: { type: 'string' },
              units: { enum: [...WEATHER_UNITS] },
              mode: { enum: [...WEATHER_MODES] },
              count: { type: 'number', minimum: 1, maximum: 240 },
              // Constrained by shape, not by an enum of model ids: the list
              // grows, and an enum would reject a valid new model until the
              // schema caught up. The pattern's job is to catch a pasted URL or
              // a stray space, not to validate the id.
              models: { type: 'string', pattern: '^[a-z0-9_]+(,[a-z0-9_]+)*$' },
              timezone: { type: 'string', pattern: '^[A-Za-z0-9_/+-]+$' },
              // Free text: it goes into a header, and every origin that asks
              // for one documents a different shape. Length-capped only, since
              // a header value is the one thing here that a typo can make
              // enormous. Newlines are what would make it dangerous, and are
              // refused rather than stripped.
              contact: { type: 'string', maxLength: 200, pattern: '^[^\\r\\n]*$' },
            },
            required: ['provider', 'latitude', 'longitude'],
            additionalProperties: false,
          },
          {
            properties: {
              id: { type: 'string', minLength: 1 },
              name: { type: 'string' },
              type: { const: 'ftp' },
              pollInterval: { type: 'number', minimum: 0 },
              enabled: { type: 'boolean' },
              protocol: { enum: [...FTP_PROTOCOLS] },
              host: { type: 'string', minLength: 1 },
              port: { type: 'number', minimum: 1, maximum: 65535 },
              path: { type: 'string' },
              pattern: { type: 'string', minLength: 1 },
              format: { enum: [...FTP_FORMATS] },
              username: { type: 'string' },
              // Same rule as every other adapter: a name, never a credential.
              secretId: { type: 'string' },
              delimiter: { type: 'string' },
              header: { type: 'boolean' },
              rowPath: { type: 'string' },
              columns: { type: 'array', items: { $ref: '#/$defs/dataColumn' } },
            },
            required: ['protocol', 'host', 'pattern', 'format'],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  additionalProperties: false,
  $defs: {
    dataColumn: dataColumnSchema,
    dataValue: dataValueSchema,
    dataRow: dataRowSchema,
  },
} as const;

/** Adapter type ids, re-exported so tooling can enumerate them from the schema. */
export const DATA_SOURCE_TYPE_IDS = DATA_SOURCE_TYPES;

/**
 * One asset bin entry.
 *
 * Shared by `projectSchema.assets` (legacy, still readable) and `assetsSchema`
 * (current), so a row cannot validate in one document and fail in the other
 * during the migration window.
 *
 * `additionalProperties: false` for the reason recorded on the data-source
 * schema: a misspelled field would otherwise be silently ignored by whatever
 * was supposed to read it, and an asset whose `expiresAt` never fires is
 * discovered by a sponsor rather than by the validator.
 */
const assetRefSchema = {
  type: 'object',
  required: ['id', 'path', 'kind'],
  properties: {
    id: { type: 'string' },
    path: { type: 'string' },
    kind: { enum: ['image', 'video', 'font', 'audio', 'other'] },

    /* technical */
    originalName: { type: 'string' },
    bytes: { type: 'number' },
    addedAt: { type: 'string' },
    width: { type: 'number' },
    height: { type: 'number' },
    duration: { type: 'number' },
    hasAlpha: { type: 'boolean' },
    codec: { type: 'string' },

    /* descriptive */
    title: { type: 'string' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    folder: { type: 'string' },

    /* administrative */
    state: { enum: ['draft', 'approved', 'retired'] },
    notes: { type: 'string' },

    /* rights */
    source: { type: 'string' },
    usage: { enum: ['unrestricted', 'licensed', 'single-use'] },
    expiresAt: { type: 'string' },

    /* provenance */
    origin: {
      type: 'object',
      required: ['store', 'slug', 'hash'],
      properties: {
        store: { const: 'shared' },
        slug: { type: 'string' },
        hash: { type: 'string' },
      },
      additionalProperties: false,
    },
    supersedes: { type: 'string' },

    fontFamily: { type: 'string' },
  },
  additionalProperties: false,
} as const;

export const projectSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://breeze-overlay.local/schemas/project-v1.json',
  title: 'Breeze Project v1',
  type: 'object',
  required: ['formatVersion', 'id', 'name', 'compositions'],
  properties: {
    formatVersion: { const: FORMAT_VERSION },
    /** Legacy pattern, for the reason given on the composition id above. */
    id: { type: 'string', minLength: 1, pattern: LEGACY_KEY_SOURCE },
    name: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    compositions: { type: 'array', items: { $ref: 'composition-v1.json' } },
    /**
     * Legacy index, kept readable so a project written before Phase 7.5 still
     * validates. Nothing writes it any more — see `assetsSchema` below.
     */
    assets: { type: 'array', items: assetRefSchema },
  },
  additionalProperties: false,
} as const;

/**
 * The asset index — `projects/<id>/assets.json`.
 *
 * Split out of `project.json` in Phase 7.5 (ASSETS.md §6). `registerAsset` did
 * a full `readProject` → mutate → `writeProject` on every upload, so adding a
 * logo rewrote every composition in the project: the document grew with asset
 * count, composition saves got slower as the bin filled, and the
 * read-modify-write had two callers racing for one file. A sibling document has
 * one writer path, which is also what makes a write lock cheap.
 *
 * Same shape and same reasoning as `datasources.json`: project infrastructure
 * that changes on a different clock from the graphics.
 *
 * `tags` is the project's controlled vocabulary — the terms offered as
 * suggestions in the bin. Kept at the document level rather than derived from
 * the assets so a term survives the deletion of the last asset using it, which
 * is what stops a vocabulary quietly re-fragmenting (ASSETS.md §4).
 */
export const assetsSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://breeze-overlay.local/schemas/assets-v1.json',
  title: 'Breeze Asset Index v1',
  type: 'object',
  required: ['formatVersion', 'assets'],
  properties: {
    formatVersion: { const: FORMAT_VERSION },
    assets: { type: 'array', items: assetRefSchema },
    tags: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const;
