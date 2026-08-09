// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Schema validation. Deliberately NOT re-exported from the package barrel —
 * import it as `@breeze/schema/validate`.
 *
 * Ajv is instantiated and the schemas compiled at module load below. That is a
 * top-level side effect, so no bundler can tree-shake it: while this lived in
 * the barrel, every consumer inherited it. The browser-source player bundle was
 * 38% Ajv despite never validating anything, paying parse and schema-compile
 * cost on every graphic that went to air. Validation is a server and tooling
 * concern; the browser gets types, factories and bindings.
 */

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import {
  ADVANCE_DEFAULTS,
  BRACKET_SIDES,
  DEFAULT_RANK_KEY,
  WEATHER_PROVIDER_INFO,
  type DataSourceDef,
} from './data.js';
import { compositionDuration, walkLayers } from './duration.js';
import { KEY_MAX_LENGTH, isValidKey } from './keys.js';
import { assetsSchema, compositionSchema, dataSourcesSchema, projectSchema } from './schema.js';
import { CLOCK_TOKENS, type AssetRef, type Composition, type Project } from './types.js';

export { compositionDuration, walkLayers };

/**
 * Ask Intl rather than carry a zone list. `DateTimeFormat` throws RangeError on
 * an unknown `timeZone`, and its list is the host's — which is the one the
 * runtime will actually format against.
 */
function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export interface ValidationIssue {
  /** JSON pointer into the document, e.g. `/layers/2/keyframes/x/0/t`. */
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
});

ajv.addSchema(compositionSchema, 'composition-v1');
ajv.addSchema(projectSchema, 'project-v1');
ajv.addSchema(dataSourcesSchema, 'datasources-v1');
ajv.addSchema(assetsSchema, 'assets-v1');

const validateCompositionSchema = ajv.getSchema('composition-v1') as ValidateFunction;
const validateProjectSchema = ajv.getSchema('project-v1') as ValidateFunction;
const validateDataSourcesSchema = ajv.getSchema('datasources-v1') as ValidateFunction;
const validateAssetsSchema = ajv.getSchema('assets-v1') as ValidateFunction;

function toIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  if (!errors) return [];
  return errors.map((e) => ({
    path: e.instancePath || '/',
    message: `${e.message ?? 'invalid'}${
      e.params && Object.keys(e.params).length ? ` (${JSON.stringify(e.params)})` : ''
    }`,
  }));
}

/* ------------------------------------------------- semantic (non-schema) */

/**
 * Rules the JSON Schema cannot express: unique ids, monotonic keyframe times,
 * markers inside the composition, sane in/out windows.
 */
export function validateCompositionSemantics(comp: Composition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenIds = new Set<string>();
  /** Resolved channel → the layer path that claimed it, for the duplicate check. */
  const claimedChannels = new Map<string, string>();

  walkLayers(comp.layers, (layer, path) => {
    if (seenIds.has(layer.id)) {
      issues.push({ path: `${path}/id`, message: `duplicate layer id "${layer.id}"` });
    }
    seenIds.add(layer.id);

    if (layer.in !== undefined && layer.out !== undefined && layer.out <= layer.in) {
      issues.push({ path: `${path}/out`, message: '`out` must be greater than `in`' });
    }

    if (layer.type === 'composition') {
      /*
       * `channel` without `independent` does nothing at all. Rejected rather
       * than ignored on the same principle as clock+binding below: a field that
       * silently has no effect is discovered when a trigger URL 404s during a
       * show, which is the worst possible time to learn it was never wired up.
       */
      if (layer.channel !== undefined && !layer.independent) {
        issues.push({
          path: `${path}/channel`,
          message: '`channel` requires `independent: true` — it does nothing on a flattened composition layer',
        });
      }

      if (layer.channel !== undefined && !isValidKey(layer.channel)) {
        issues.push({
          path: `${path}/channel`,
          message:
            `channel "${layer.channel}" is not a valid URL key — up to ${KEY_MAX_LENGTH} ` +
            'lowercase letters, digits and inner hyphens',
        });
      }

      if (layer.independent) {
        /*
         * An independent element contributes no timeline to its parent: its
         * motion is its own, driven by its own play/stop. Keyframes and a
         * lifetime window on the wrapper would be authored, saved, and then
         * silently do nothing — so they fail here, in the editor, where the
         * author is looking, rather than on air where the missing entrance
         * reads as a broken graphic.
         *
         * `transform` deliberately stays legal: it positions the element's
         * container, which is how a full-frame bug gets nudged without editing
         * the bug itself.
         */
        if (layer.keyframes && Object.keys(layer.keyframes).length > 0) {
          issues.push({
            path: `${path}/keyframes`,
            message:
              'an independent composition layer cannot carry keyframes — it plays its own ' +
              'timeline; animate it inside the referenced composition instead',
          });
        }

        if (layer.in !== undefined || layer.out !== undefined) {
          issues.push({
            path: `${path}/${layer.in !== undefined ? 'in' : 'out'}`,
            message:
              'an independent composition layer cannot carry `in`/`out` — its lifetime is ' +
              'decided by play/stop on its own channel',
          });
        }

        const channel = layer.channel ?? layer.ref;
        const claimedBy = claimedChannels.get(channel);
        if (claimedBy !== undefined) {
          issues.push({
            path: `${path}/${layer.channel !== undefined ? 'channel' : 'ref'}`,
            message:
              `channel "${channel}" is already used by ${claimedBy} — two elements on one ` +
              'channel answer every trigger together; give one an explicit `channel`',
          });
        } else {
          claimedChannels.set(channel, path);
        }
      }
    }

    if (layer.type === 'text' && layer.clock) {
      /*
       * A clock and a binding on one layer is a field the operator can type
       * into and watch be overwritten within the second. Rejected here rather
       * than resolved by precedence, because either precedence is surprising to
       * somebody and the panel would still offer an input that does nothing.
       */
      if (layer.binding) {
        issues.push({
          path: `${path}/binding`,
          message: 'a text layer cannot have both `clock` and `binding` — the clock always wins',
        });
      }

      /*
       * A format with no recognized token renders as its own literal text,
       * forever. It looks exactly like a clock that has not started, which is
       * the single most expensive way to discover a typo.
       */
      if (!CLOCK_TOKENS.some((token) => layer.clock!.format.includes(token))) {
        issues.push({
          path: `${path}/clock/format`,
          message: `clock format "${layer.clock.format}" contains no recognized token`,
        });
      }

      const zone = layer.clock.timezone;
      if (zone !== undefined && !isValidTimeZone(zone)) {
        issues.push({
          path: `${path}/clock/timezone`,
          message: `unknown IANA time zone "${zone}"`,
        });
      }
    }

    if (layer.type === 'table') {
      /*
       * Cells are leaf visuals. Groups, tables and nested compositions inside a
       * row template are rejected rather than ignored: the runtime clones cells
       * per row and does not expand them, so a nested comp in a cell would
       * validate, save, and then render nothing at all on air. Better to fail
       * in the editor with a reason than to ship a silently empty column.
       */
      const cellIds = new Set<string>();
      layer.row.cells.forEach((cell, i) => {
        const cellPath = `${path}/row/cells/${i}`;
        if (cell.type === 'group' || cell.type === 'table' || cell.type === 'composition') {
          issues.push({
            path: `${cellPath}/type`,
            message: `a table cell cannot be a ${cell.type} layer`,
          });
        }
        if (cellIds.has(cell.id)) {
          issues.push({ path: `${cellPath}/id`, message: `duplicate cell id "${cell.id}"` });
        }
        cellIds.add(cell.id);
      });

      if (layer.row.height <= 0) {
        issues.push({ path: `${path}/row/height`, message: 'row height must be greater than 0' });
      }

      const declared = new Set((layer.data?.columns ?? []).map((c) => c.key));
      /*
       * Columns the pipeline creates count as declared. `rank` adds one that is
       * in no snapshot by definition — it is computed at render time — so
       * without this the demo's own standings table fails its own validator.
       */
      for (const [i, t] of (layer.transforms ?? []).entries()) {
        if (t.op === 'rank') declared.add(t.as ?? DEFAULT_RANK_KEY);
        if (t.op === 'advance') {
          const fields = t.fields?.length ? t.fields : [...ADVANCE_DEFAULTS.fields];
          for (const side of BRACKET_SIDES) for (const f of fields) declared.add(`${side}${f}`);

          /*
           * Only the columns the author *named* are checked, never the
           * defaults. A bracket running on the implied topology has no `feeds`
           * column at all and is completely correct; complaining that the
           * default is missing would make the zero-config case the noisy one.
           */
          if (layer.data?.columns?.length) {
            const named: Array<[string, string | undefined]> = [
              ['slot', t.slot],
              ['round', t.round],
              ['feeds', t.feeds],
              ['feedsLoser', t.feedsLoser],
              ['winner', t.winner],
              ['scores/home', t.scores?.home],
              ['scores/away', t.scores?.away],
              ['scores/shootout/home', t.scores?.shootout?.home],
              ['scores/shootout/away', t.scores?.shootout?.away],
            ];
            for (const [prop, key] of named) {
              if (key && !declared.has(key)) {
                issues.push({
                  path: `${path}/transforms/${i}/${prop}`,
                  message: `advance references unknown column "${key}"`,
                });
              }
            }
          }

          /*
           * A repeated slot id makes the bracket ambiguous — two rows claim the
           * same position and the transform has to pick one. It picks the
           * first, which is a coin toss dressed as a rule, so say so here where
           * the author can fix it.
           */
          const slotKey = t.slot ?? ADVANCE_DEFAULTS.slot;
          const seenSlots = new Set<string>();
          for (const row of layer.data?.rows ?? []) {
            const id = row[slotKey];
            if (id === null || id === undefined || String(id).trim() === '') continue;
            const s = String(id);
            if (seenSlots.has(s)) {
              issues.push({
                path: `${path}/transforms/${i}/slot`,
                message: `duplicate slot id "${s}" — advance cannot resolve which row it means`,
              });
              break;
            }
            seenSlots.add(s);
          }
        }
      }

      // Only checked against an authored snapshot: a table fed by a live source
      // legitimately references columns this file has never seen.
      if (declared.size) {
        for (const [i, cell] of layer.row.cells.entries()) {
          if (cell.cell && !declared.has(cell.cell)) {
            issues.push({
              path: `${path}/row/cells/${i}/cell`,
              message: `cell references unknown column "${cell.cell}"`,
            });
          }
        }
      }
    }

    for (const [prop, track] of Object.entries(layer.keyframes ?? {})) {
      if (!track || track.length === 0) continue;
      for (let i = 1; i < track.length; i++) {
        const prev = track[i - 1]!;
        const cur = track[i]!;
        if (cur.t < prev.t) {
          issues.push({
            path: `${path}/keyframes/${prop}/${i}/t`,
            message: `keyframes must be sorted by time (${cur.t} follows ${prev.t})`,
          });
        } else if (cur.t === prev.t) {
          issues.push({
            path: `${path}/keyframes/${prop}/${i}/t`,
            message: `duplicate keyframe time ${cur.t}`,
          });
        }
      }
    }
  });

  const duration = comp.duration ?? compositionDuration(comp);
  (comp.markers ?? []).forEach((m, i) => {
    if (m.time > duration + 1e-6) {
      issues.push({
        path: `/markers/${i}/time`,
        message: `marker at ${m.time}s is past the composition duration (${duration}s)`,
      });
    }
  });

  return issues;
}

/* ----------------------------------------------------------- public API */

export function validateComposition(doc: unknown): ValidationResult {
  const ok = validateCompositionSchema(doc);
  const errors = toIssues(validateCompositionSchema.errors);
  if (!ok) return { valid: false, errors };

  const semantic = validateCompositionSemantics(doc as Composition);
  return { valid: semantic.length === 0, errors: semantic };
}

export function validateProject(doc: unknown): ValidationResult {
  const ok = validateProjectSchema(doc);
  const errors = toIssues(validateProjectSchema.errors);
  if (!ok) return { valid: false, errors };

  const project = doc as Project;
  const semantic: ValidationIssue[] = [];
  const seen = new Set<string>();

  project.compositions.forEach((comp, i) => {
    if (seen.has(comp.id)) {
      semantic.push({ path: `/compositions/${i}/id`, message: `duplicate composition id "${comp.id}"` });
    }
    seen.add(comp.id);
    for (const issue of validateCompositionSemantics(comp)) {
      semantic.push({ path: `/compositions/${i}${issue.path}`, message: issue.message });
    }
  });

  // Nested composition refs must resolve within the project.
  project.compositions.forEach((comp, i) => {
    walkLayers(comp.layers, (layer, path) => {
      if (layer.type === 'composition' && !seen.has(layer.ref)) {
        semantic.push({
          path: `/compositions/${i}${path}/ref`,
          message: `unknown composition ref "${layer.ref}"`,
        });
      }
      if (layer.type === 'composition' && layer.ref === comp.id) {
        semantic.push({
          path: `/compositions/${i}${path}/ref`,
          message: 'a composition cannot reference itself',
        });
      }
    });
  });

  return { valid: semantic.length === 0, errors: semantic };
}

/**
 * Validate a `datasources.json` document.
 *
 * The schema for these has existed since Wave 1 but nothing called it, so it
 * was never exercised — a source type could be declared wrongly and the only
 * symptom would be a graphic that quietly failed to fetch. Adding a Wave-2
 * source type to `dataSourcesSchema` and to `DataSourceDef` are two separate
 * edits, and nothing was checking that they agreed.
 *
 * The uniqueness rule is here rather than in the schema because JSON Schema's
 * `uniqueItems` compares whole objects, and two sources sharing an id while
 * differing in any other field would pass it.
 */
export function validateDataSources(doc: unknown): ValidationResult {
  const ok = validateDataSourcesSchema(doc);
  if (!ok) return { valid: false, errors: toIssues(validateDataSourcesSchema.errors) };

  const sources = (doc as { sources: DataSourceDef[] }).sources;
  const semantic: ValidationIssue[] = [];
  const seen = new Set<string>();
  sources.forEach((source, i) => {
    if (seen.has(source.id)) {
      semantic.push({ path: `/sources/${i}/id`, message: `duplicate data source id "${source.id}"` });
    }
    seen.add(source.id);

    /*
     * `baseUrl` is required by exactly one provider and meaningless to the rest.
     * JSON Schema can say that with an if/then, but the error it produces for a
     * failed `oneOf` branch names the branch index and nothing else — so a
     * hosted Open-Meteo def with a stray baseUrl would be rejected as "does not
     * match any schema", which tells the operator nothing. Checked here so the
     * message can say what is actually wrong.
     */
    if (source.type === 'weather') {
      const info = WEATHER_PROVIDER_INFO[source.provider];
      if (info?.needsBaseUrl && !source.baseUrl) {
        semantic.push({
          path: `/sources/${i}/baseUrl`,
          message: `provider "${source.provider}" is self-hosted and needs a baseUrl (e.g. http://localhost:8282)`,
        });
      }
      if (info && !info.needsBaseUrl && source.baseUrl) {
        semantic.push({
          path: `/sources/${i}/baseUrl`,
          message: `provider "${source.provider}" addresses a fixed origin; remove baseUrl or switch to a self-hosted provider`,
        });
      }
    }
  });

  return { valid: semantic.length === 0, errors: semantic };
}

/**
 * Validate an `assets.json` document.
 *
 * Same two-stage shape as the data sources above: schema first, then the rules
 * JSON Schema cannot express.
 *
 * Uniqueness is checked on `id` *and* on `path` because they can disagree in
 * only one way and it is worth catching: the id is a hash prefix and the path
 * carries the same prefix, so two rows sharing a path while differing in id
 * means the index was hand-edited or merged badly. Left unchecked, the bin
 * would list one file twice and deleting either row would unlink the file out
 * from under the other.
 */
export function validateAssets(doc: unknown): ValidationResult {
  const ok = validateAssetsSchema(doc);
  if (!ok) return { valid: false, errors: toIssues(validateAssetsSchema.errors) };

  const assets = (doc as { assets: AssetRef[] }).assets;
  const semantic: ValidationIssue[] = [];
  const byId = new Set<string>();
  const byPath = new Set<string>();

  assets.forEach((asset, i) => {
    if (byId.has(asset.id)) {
      semantic.push({ path: `/assets/${i}/id`, message: `duplicate asset id "${asset.id}"` });
    }
    byId.add(asset.id);

    if (byPath.has(asset.path)) {
      semantic.push({ path: `/assets/${i}/path`, message: `duplicate asset path "${asset.path}"` });
    }
    byPath.add(asset.path);

    /*
     * The path is what every layer's `src` holds, so it has to stay inside the
     * project's assets directory. `assetPath` on the server enforces this at
     * the filesystem boundary; saying it here too means a hand-edited or
     * imported index is rejected before it can be written rather than at the
     * first read that tries to resolve it.
     */
    if (!asset.path.startsWith('assets/') || asset.path.includes('..')) {
      semantic.push({
        path: `/assets/${i}/path`,
        message: `asset path must be inside the project's assets directory — got "${asset.path}"`,
      });
    }
  });

  return { valid: semantic.length === 0, errors: semantic };
}

/** Throwing variant for server routes. */
export function assertValidComposition(doc: unknown): asserts doc is Composition {
  const result = validateComposition(doc);
  if (!result.valid) {
    throw new CompositionValidationError('Invalid composition', result.errors);
  }
}

export function assertValidProject(doc: unknown): asserts doc is Project {
  const result = validateProject(doc);
  if (!result.valid) {
    throw new CompositionValidationError('Invalid project', result.errors);
  }
}

export class CompositionValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(message: string, issues: ValidationIssue[]) {
    super(`${message}: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
    this.name = 'CompositionValidationError';
    this.issues = issues;
  }
}
