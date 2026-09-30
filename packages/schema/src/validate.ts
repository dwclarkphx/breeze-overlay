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
  AIR_QUALITY_PROVIDER_INFO,
  BRACKET_SIDES,
  DEFAULT_RANK_KEY,
  UNPIVOT_DEFAULTS,
  WEATHER_PROVIDER_INFO,
  type DataSourceDef,
  type DataTransform,
  type PlaceRef,
} from './data.js';
import { parseTemplate } from './compose.js';
import { MEDIA_COLUMNS } from './media.js';
import { MODE_PATTERN } from './rules.js';
import { compositionDuration, walkLayers } from './duration.js';
import { KEY_MAX_LENGTH, isValidKey } from './keys.js';
import { assetsSchema, compositionSchema, dataSourcesSchema, projectSchema } from './schema.js';
import { CLOCK_TOKENS, type AssetRef, type Composition, type Layer, type MediaLayer, type Project } from './types.js';

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
  /**
   * Absent means `'error'`. A `'warning'` is legal and will save — it names
   * something that reads exactly like a fault on air but is a sizing or
   * timing choice the author may have meant, e.g. a mask `width`/`height` of
   * 0 at the start of an animated reveal (MASKS.md §2.4). Every rule that
   * predates this field is an error, unchanged.
   */
  severity?: 'error' | 'warning';
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
}

/** Ids and bindings of every table layer in a composition — what `follow.table` can name. */
const tableNameCache = new WeakMap<Composition, Set<string>>();
function tableNames(comp: Composition): Set<string> {
  let names = tableNameCache.get(comp);
  if (!names) {
    names = new Set<string>();
    walkLayers(comp.layers, (layer) => {
      if (layer.type !== 'table') return;
      names!.add(layer.id);
      if (layer.binding) names!.add(layer.binding);
    });
    tableNameCache.set(comp, names);
  }
  return names;
}

/**
 * Layer rules (CYCLE.md, Wave 6). The JSON schema checks shape; this checks
 * sense — one subject per condition, a row to read, and an effect the layer
 * can actually show.
 */
/**
 * A media layer (Wave 8). The settings that only mean something in a table
 * cell, or for one kind, are warnings rather than errors — they are harmless,
 * just ignored, and the author may be about to move the layer into a table.
 */
function checkMedia(layer: MediaLayer, path: string, inCell: boolean, cycling = false): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (layer.refresh !== undefined && layer.refresh > 0 && layer.refresh < 1) {
    issues.push({ path: `${path}/refresh`, message: 'a snapshot is re-fetched at most once a second' });
  }
  if (layer.refresh && layer.kind !== undefined && layer.kind !== 'image') {
    issues.push({
      path: `${path}/refresh`,
      message: `refresh re-fetches a snapshot — a ${layer.kind} source plays continuously`,
      severity: 'warning',
    });
  }
  if (layer.kindColumn !== undefined && !(inCell && layer.cell)) {
    issues.push({
      path: `${path}/kindColumn`,
      message: 'a kind column is read from a table row — this layer is not a cell reading a column',
      severity: 'warning',
    });
  }
  if (layer.onError === 'skip' && !(inCell && cycling)) {
    issues.push({
      path: `${path}/onError`,
      message: 'skip turns a cycling table to its next page — here it hides the layer instead',
      severity: 'warning',
    });
  }
  return issues;
}

/** A `date` step's zone must be one this engine knows; a window only means something for `days`. */
function checkDateTransforms(transforms: readonly DataTransform[] | undefined, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [i, t] of (transforms ?? []).entries()) {
    if (t.op === 'compose') {
      if (t.timezone && !isValidTimeZone(t.timezone)) {
        issues.push({ path: `${path}/transforms/${i}/timezone`, message: `unknown time zone "${t.timezone}"` });
      }
      for (const problem of parseTemplate(t.template).problems) {
        issues.push({ path: `${path}/transforms/${i}/template`, message: problem });
      }
      continue;
    }
    if (t.op !== 'date') continue;
    if (t.timezone && !isValidTimeZone(t.timezone)) {
      issues.push({ path: `${path}/transforms/${i}/timezone`, message: `unknown time zone "${t.timezone}"` });
    }
    if (t.keep !== 'days' && (t.from !== undefined || t.days !== undefined)) {
      issues.push({
        path: `${path}/transforms/${i}`,
        message: `from and days choose calendar days — they do nothing with keep "${t.keep}"`,
        severity: 'warning',
      });
    }
  }
  return issues;
}

function checkRules(layer: Layer, path: string, inCell: boolean): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [r, rule] of (layer.rules ?? []).entries()) {
    const at = `${path}/rules/${r}`;
    for (const [c, cond] of rule.when.entries()) {
      const where = `${at}/when/${c}`;
      const subjects = [cond.mode ? 'mode' : null, cond.binding !== undefined ? 'binding' : null, cond.source !== undefined || cond.column !== undefined ? 'data' : null]
        .filter(Boolean);
      if (subjects.length !== 1) {
        issues.push({ path: where, message: 'a condition tests one thing: a column, a source, a field (binding) or the mode' });
        continue;
      }
      if (cond.column !== undefined && cond.source === undefined && !inCell) {
        issues.push({
          path: `${where}/column`,
          message: `a column on its own reads a table cell's row, and "${layer.id}" is not in a table — name the source it comes from`,
        });
      }
      if (cond.where !== undefined && (cond.source === undefined || cond.column === undefined)) {
        issues.push({ path: `${where}/where`, message: '`where` picks a row of a source, so it needs both `source` and `column`' });
      }
      if (cond.mode && (cond.cmp === 'eq' || cond.cmp === 'in')) {
        const names = Array.isArray(cond.value) ? cond.value : cond.cmp === 'in' ? String(cond.value ?? '').split(',') : [cond.value];
        const bad = names.map((n) => String(n ?? '').trim()).find((n) => n !== '' && !MODE_PATTERN.test(n));
        if (bad !== undefined) {
          issues.push({
            path: `${where}/value`,
            message: `"${bad}" cannot be a mode — letters, digits, spaces, dot, dash and underscore, up to 48`,
          });
        }
      }
      if (cond.cmp !== 'empty' && cond.cmp !== 'notEmpty' && cond.value === undefined) {
        issues.push({ path: `${where}/value`, message: `"${cond.cmp}" compares with a value, and none is given`, severity: 'warning' });
      }
    }
    if (rule.show === undefined && rule.color === undefined && rule.src === undefined) {
      issues.push({ path: at, message: 'this rule changes nothing — give it show, color or src', severity: 'warning' });
    }
    if (rule.color !== undefined && layer.type !== 'text' && layer.type !== 'shape') {
      issues.push({ path: `${at}/color`, message: `color recolours text and shapes — a ${layer.type} layer has none to change` });
    }
    if (rule.src !== undefined && layer.type !== 'image') {
      issues.push({ path: `${at}/src`, message: `src changes an image — a ${layer.type} layer has no image to change` });
    }
  }
  return issues;
}

/** A warning never blocks a save; only the absence of `severity` or `'error'` does. */
function isBlocking(issue: ValidationIssue): boolean {
  return issue.severity !== 'warning';
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

export interface SemanticContext {
  /**
   * The project's asset index, for the one rule that needs it — a mask
   * `src` resolving to a real file. Assets live in a sibling `assets.json`
   * (ASSETS.md §6), not in the `Project` document this module otherwise
   * validates, so a caller with no asset list simply gets that one rule
   * skipped rather than a required argument it may not have.
   */
  assets?: readonly AssetRef[];
}

/**
 * Whether a `d` string can draw anything, checked at the one level that is
 * both cheap and worth having.
 *
 * Not a path parser. The rule is the SVG spec's own: path data must begin with
 * a moveto, and a path that does not is in error and renders *nothing* — the
 * silent failure this phase keeps finding, and the exact result of a
 * hand-edited `d` that lost its leading `M`. Everything past that first
 * command is left to the renderer, which is the only thing that can really
 * judge it and which degrades gracefully when it cannot.
 */
function pathDataIssues(
  data: string | undefined,
  at: string,
  what: 'mask' | 'shape',
): ValidationIssue[] {
  const subject = what === 'mask' ? 'a path mask' : 'a path shape';

  if (!data || !data.trim()) {
    return [{
      path: at,
      message: `${subject} needs \`path\` data — without it it renders as nothing at all, silently`,
    }];
  }

  if (!/^[Mm]/.test(data.trim())) {
    return [{
      path: at,
      message:
        `${subject}'s \`path\` must start with a moveto (\`M\` or \`m\`) — SVG draws nothing at ` +
        'all from data that does not, however valid the rest of it looks',
    }];
  }

  return [];
}

/**
 * Rules the JSON Schema cannot express: unique ids, monotonic keyframe times,
 * markers inside the composition, sane in/out windows.
 */
export function validateCompositionSemantics(
  comp: Composition,
  context: SemanticContext = {},
): ValidationIssue[] {
  const { assets } = context;
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

    issues.push(...checkRules(layer, path, false));

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

        /*
         * `overrides` is the third field in this family, found while Wave C was
         * building its editor (MASKS.md §4).
         *
         * It reaches a nested composition through `expandComposition`, which
         * stops at an independent layer and never walks the child — and the
         * player mounts independent elements from `sceneElements`, whose
         * `SceneElement` carries `layerId`, `name`, `ref` and `channel` and no
         * values at all. So an override here is authored, saved, and read by
         * nothing, which is precisely why `channel`-without-`independent` above
         * is refused rather than ignored. An element's values come from its own
         * control channel; bake them into the referenced composition instead.
         */
        if (layer.overrides && Object.keys(layer.overrides).length > 0) {
          issues.push({
            path: `${path}/overrides`,
            message:
              'an independent composition layer cannot carry `overrides` — nothing reads them; ' +
              'push values to its own control channel, or author them in the referenced composition',
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

    if (layer.type === 'shape' && layer.shape === 'path') {
      for (const issue of pathDataIssues(layer.path, `${path}/path`, 'shape')) {
        issues.push(issue);
      }
    }

    if (layer.type === 'sprite') {
      /*
       * `frameCount` above the grid is rejected rather than clamped. Clamping
       * would play the sheet and stop early with no explanation, which reads as
       * a corrupt asset; the number is almost always a typo or a sheet that was
       * re-exported at a different grid, and both are worth naming while the
       * operator still has the export open.
       */
      const capacity = layer.cols * layer.rows;
      if (layer.frameCount !== undefined && layer.frameCount > capacity) {
        issues.push({
          path: `${path}/frameCount`,
          message: `frameCount ${layer.frameCount} exceeds the ${layer.cols}×${layer.rows} grid's ${capacity} cells`,
        });
      }

      /*
       * A binding on a sprite replaces `src` — the whole sheet — and the grid
       * describing it stays behind. Swapping a 6×5 burst for an 8×4 one through
       * a control-panel field would step through the new sheet on the old
       * geometry and render sliced quarters of two frames at once. Refused for
       * the same reason fed fields are read-only on the panel: the failure is
       * invisible in the editor and only appears once live data arrives.
       */
      if (layer.binding !== undefined && capacity > 1) {
        issues.push({
          path: `${path}/binding`,
          message:
            'a sprite layer with a multi-frame grid cannot be bound — the incoming sheet would be stepped through the outgoing sheet\'s grid',
        });
      }
    }

    if (layer.type === 'media') issues.push(...checkMedia(layer, path, false));

    // Tables and crawls share the pipeline, and its checks that need no columns.
    if (layer.type === 'table' || layer.type === 'crawl') {
      issues.push(...checkDateTransforms(layer.transforms, path));
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
        issues.push(...checkRules(cell, cellPath, true));
        if (cell.type === 'media') {
          issues.push(...checkMedia(cell, cellPath, true, (layer.cycle?.dwell ?? 0) > 0));
          // One failed tile would turn a whole grid of cameras (Wave 8).
          if (cell.onError === 'skip' && layer.rowsPerPage !== 1) {
            issues.push({
              path: `${cellPath}/onError`,
              message: 'skip turns the whole page — with more than one row a page, one failed camera takes the others with it',
              severity: 'warning',
            });
          }
        }
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
      /**
       * Set by a transform whose columns cannot be known from this document —
       * a union with another source, a lookup bringing "everything". Cells are
       * then not checked against the snapshot at all, rather than refused for
       * reading a column only the live source will have.
       */
      let openColumns = false;
      for (const [i, t] of (layer.transforms ?? []).entries()) {
        if (t.op === 'rank') declared.add(t.as ?? DEFAULT_RANK_KEY);
        if (t.op === 'compose') declared.add(t.as);
        if (t.op === 'lookup') {
          if (t.columns) for (const c of t.columns) declared.add(c);
          else openColumns = true;
        }
        if (t.op === 'union') openColumns = true;
        if (t.op === 'unpivot') {
          const keyName = t.key ?? UNPIVOT_DEFAULTS.key;
          const valueName = t.value ?? UNPIVOT_DEFAULTS.value;
          if (keyName === valueName) {
            issues.push({
              path: `${path}/transforms/${i}/value`,
              message: `unpivot's name and value columns are both "${keyName}" — the value would overwrite the name`,
            });
          }
          /*
           * The same columns `unpivot()` leaves: what was kept, minus what was
           * folded away. A cell still reading `mon` after `mon` became a row
           * renders empty on air, so it is an unknown column from here on.
           */
          const keep = t.keep ? new Set(t.keep) : null;
          for (const key of [...declared]) {
            const folded = t.columns ? t.columns.includes(key) : !keep?.has(key);
            if (folded || (keep !== null && !keep.has(key)) || key === keyName || key === valueName) declared.delete(key);
          }
          declared.add(keyName);
          declared.add(valueName);
        }
        if (t.op === 'advance') {
          const fields = t.fields?.length ? t.fields : [...ADVANCE_DEFAULTS.fields];
          for (const side of BRACKET_SIDES) for (const f of fields) declared.add(`${side}${f}`);

          /*
           * Only the columns the author *named* are checked, never the
           * defaults. A bracket running on the implied topology has no `feeds`
           * column at all and is completely correct; complaining that the
           * default is missing would make the zero-config case the noisy one.
           */
          // After a union or an open lookup a named column may come from the other source.
          if (layer.data?.columns?.length && !openColumns) {
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

      /*
       * Following (CYCLE.md, Wave 4). Following itself is an error — it would
       * filter on its own page key and empty itself. A leader this composition
       * does not contain is only a warning: it may be in the composition this
       * one is mounted into, which a single-composition check cannot see.
       */
      if (layer.follow) {
        const leader = layer.follow.table;
        if (leader === layer.id || (layer.binding !== undefined && leader === layer.binding)) {
          issues.push({ path: `${path}/follow/table`, message: 'a table cannot follow itself' });
        } else if (!tableNames(comp).has(leader)) {
          issues.push({
            path: `${path}/follow/table`,
            message: `no table "${leader}" in this composition — fine if it is in the one this is mounted into, unless that mount is an independent element`,
            severity: 'warning',
          });
        }
      }

      // Only checked against an authored snapshot: a table fed by a live source
      // legitimately references columns this file has never seen. Tested on
      // the snapshot itself, not on `declared` — a transform adding columns
      // (rank, unpivot) to a table with no snapshot must not turn every other
      // cell into an unknown column.
      if (layer.data?.columns?.length && !openColumns) {
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

    if (layer.mask) {
      /*
       * MASKS.md §2.4 — there were no rules for `mask` before Wave A; the
       * JSON schema checks shape (required x/y/width/height) and stops.
       */
      const m = layer.mask;

      if (m.type === 'image' && !m.src) {
        issues.push({
          path: `${path}/mask/src`,
          message: 'an image mask needs `src` — without it the mask renders as nothing at all, silently',
        });
      }

      if (m.type === 'path') {
        for (const issue of pathDataIssues(m.path, `${path}/mask/path`, 'mask')) {
          issues.push(issue);
        }
      }

      if (m.type === 'image' && m.src && assets && !assets.some((a) => a.path === m.src)) {
        issues.push({
          path: `${path}/mask/src`,
          message: `mask references unknown asset "${m.src}"`,
        });
      }

      /*
       * The two size warnings below are scoped to the mask types that actually
       * read `width`/`height`.
       *
       * A path mask's geometry is all in `d` — the fields are inert there by
       * design (§5), and a path mask authored the obvious way carries zeros in
       * them. Left ungated, every correct path mask would report that it "masks
       * everything away", which is how a warning that is usually wrong teaches
       * an author to ignore the ones that are right.
       */
      const readsSize = m.type !== 'path';

      // Legal — a typo'd unit, almost always, and the shape blurs away to
      // nothing rather than failing loudly, so a warning is what fits.
      if (readsSize && m.feather !== undefined && m.feather > Math.min(m.width, m.height)) {
        issues.push({
          path: `${path}/mask/feather`,
          severity: 'warning',
          message:
            `feather ${m.feather} is larger than the mask's smaller dimension ` +
            `(${Math.min(m.width, m.height)}) — the shape blurs away to nothing`,
        });
      }

      // Also legal, on the same grounds the JSON schema's own `minimum: 0`
      // allows it: the natural start value of a mask being animated open.
      if (readsSize && (m.width === 0 || m.height === 0)) {
        issues.push({
          path: `${path}/mask/${m.width === 0 ? 'width' : 'height'}`,
          severity: 'warning',
          message:
            'mask has zero width or height — legal as the start of an animated reveal, ' +
            'but it masks everything away until it grows',
        });
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

export function validateComposition(doc: unknown, assets?: readonly AssetRef[]): ValidationResult {
  const ok = validateCompositionSchema(doc);
  const errors = toIssues(validateCompositionSchema.errors);
  if (!ok) return { valid: false, errors };

  const semantic = validateCompositionSemantics(doc as Composition, { assets });
  return { valid: semantic.filter(isBlocking).length === 0, errors: semantic };
}

export function validateProject(doc: unknown, assets?: readonly AssetRef[]): ValidationResult {
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
    for (const issue of validateCompositionSemantics(comp, { assets })) {
      semantic.push({ path: `/compositions/${i}${issue.path}`, message: issue.message, ...(issue.severity ? { severity: issue.severity } : {}) });
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

  return { valid: semantic.filter(isBlocking).length === 0, errors: semantic };
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
      const mode = source.mode ?? 'current';
      if (info && !info.modes.includes(mode)) {
        semantic.push({
          path: `/sources/${i}/mode`,
          message: `provider "${source.provider}" has no ${mode} mode — it offers ${info.modes.join(', ')}`,
        });
      }
      semantic.push(...checkWhere(source, i, 'coordinates'));
      // A station is one place's; with a list, each place names its own.
      if (source.station !== undefined && (source.places || source.placesFrom)) {
        semantic.push({
          path: `/sources/${i}/station`,
          message: 'a station belongs to one place — with a list or table, give each place its own station',
        });
      }
    }

    /*
     * Zones are checked against Intl, which is what reads them: a misspelt
     * `America/Phonix` would otherwise pass the pattern and quietly fall back
     * to the server's zone, moving "today" and every alert window with it.
     * Open-Meteo's own `auto` is a keyword, not a zone.
     */
    if (source.type === 'weather' || source.type === 'air-quality' || source.type === 'cap') {
      const zone = source.timezone?.trim();
      if (zone && zone !== 'auto' && !isValidTimeZone(zone)) {
        semantic.push({ path: `/sources/${i}/timezone`, message: `unknown time zone "${zone}"` });
      }
    }
    if (source.type === 'cap' && source.times === 'local-day' && !source.timezone?.trim()) {
      semantic.push({
        path: `/sources/${i}/timezone`,
        message: 'whole local days need the zone they are local to — e.g. America/Chicago',
      });
    }

    if (source.type === 'air-quality') {
      const info = AIR_QUALITY_PROVIDER_INFO[source.provider];
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
      if (info && source.scale && !info.scales.includes(source.scale)) {
        semantic.push({
          path: `/sources/${i}/scale`,
          message: `provider "${source.provider}" publishes ${info.scales.map((s) => s.toUpperCase()).join(' and ')} AQI only`,
        });
      }
      if (info) semantic.push(...checkWhere(source, i, info.placeKind));
    }
  });

  /*
   * A table of places must be another source in the same file. Checked after
   * the loop so a table defined further down still counts.
   */
  /*
   * …and a table, not another place-fed source: weather reading its places
   * from air quality reading its places from that weather is a loop, and
   * neither holds a list of places anyone typed.
   */
  const typeOf = new Map(sources.map((s) => [s.id, s.type] as const));
  sources.forEach((source, i) => {
    if (source.type !== 'weather' && source.type !== 'air-quality') return;
    const from = source.placesFrom?.source;
    if (from === undefined) return;
    const type = typeOf.get(from);
    if (from === source.id) {
      semantic.push({ path: `/sources/${i}/placesFrom/source`, message: 'a source cannot read its places from itself' });
    } else if (!seen.has(from)) {
      semantic.push({ path: `/sources/${i}/placesFrom/source`, message: `no data source "${from}" to read places from` });
    } else if (type === 'weather' || type === 'air-quality' || type === 'cap') {
      semantic.push({
        path: `/sources/${i}/placesFrom/source`,
        message: `places come from a table — "${from}" is a ${type} source`,
      });
    }
  });

  /*
   * Backups (CYCLE.md, Wave 5). Another source in this file, not itself, and
   * no loop: A backed by B backed by A would each serve the other's rows the
   * moment both failed, and neither holds anything anyone could show.
   */
  const fallbackOf = new Map<string, string>();
  for (const source of sources) if (source.fallback !== undefined) fallbackOf.set(source.id, source.fallback);
  sources.forEach((source, i) => {
    /*
     * Media checks (Wave 8) read a column. Only a source that declares its
     * columns can be checked here — a feed's arrive with its rows — and the
     * four the check adds must not collide with the source's own.
     */
    if (source.media) {
      const declared = 'columns' in source && Array.isArray(source.columns) && source.columns.length
        ? new Set(source.columns.map((c) => c.key))
        : null;
      for (const prop of ['column', 'kindColumn'] as const) {
        const key = source.media[prop];
        if (key !== undefined && declared && !declared.has(key)) {
          semantic.push({ path: `/sources/${i}/media/${prop}`, message: `no column "${key}" in this source` });
        }
      }
      for (const added of Object.values(MEDIA_COLUMNS)) {
        if (declared?.has(added)) {
          semantic.push({
            path: `/sources/${i}/media`,
            message: `the media check adds a "${added}" column, and this source already has one`,
          });
        }
      }
    }
    if (source.guard?.ranges) {
      for (const [r, range] of source.guard.ranges.entries()) {
        if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
          semantic.push({
            path: `/sources/${i}/guard/ranges/${r}`,
            message: `"${range.column}" has a minimum of ${range.min} above its maximum of ${range.max} — every row would fail`,
          });
        }
      }
    }
    if (source.fallbackOn !== undefined && source.fallback === undefined) {
      semantic.push({ path: `/sources/${i}/fallbackOn`, message: 'fallbackOn says when a backup takes over, and there is no backup' });
    }
    const backup = source.fallback;
    if (backup === undefined) return;
    if (backup === source.id) {
      semantic.push({ path: `/sources/${i}/fallback`, message: 'a source cannot be its own backup' });
      return;
    }
    if (!seen.has(backup)) {
      semantic.push({ path: `/sources/${i}/fallback`, message: `no data source "${backup}" to fall back to` });
      return;
    }
    const chain = new Set([source.id]);
    for (let at: string | undefined = backup; at !== undefined; at = fallbackOf.get(at)) {
      if (chain.has(at)) {
        semantic.push({
          path: `/sources/${i}/fallback`,
          message: `backups loop back to "${at}" — ${[...chain, at].join(' → ')}`,
        });
        break;
      }
      chain.add(at);
    }
  });

  return { valid: semantic.length === 0, errors: semantic };
}

/**
 * A weather or air-quality source says where: one place, a list, or a table.
 *
 * Exactly one, because two would leave the adapter choosing between them and
 * an operator wondering why Flagstaff never appears. Each listed place must
 * carry what its provider reads — coordinates, or an AirNow area id — and the
 * one-place form likewise.
 */
function checkWhere(
  source: Extract<DataSourceDef, { type: 'weather' | 'air-quality' }>,
  i: number,
  kind: 'coordinates' | 'area',
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const hasCoords = source.latitude !== undefined || source.longitude !== undefined;
  const hasArea = source.type === 'air-quality' && source.area !== undefined;
  const single = kind === 'area' ? hasArea : hasCoords;
  const forms = [single, source.places !== undefined, source.placesFrom !== undefined].filter(Boolean).length;

  if (forms === 0) {
    issues.push({
      path: `/sources/${i}`,
      message:
        kind === 'area'
          ? 'say where: an AirNow area id, a list of places, or a table of places'
          : 'say where: latitude and longitude, a list of places, or a table of places',
    });
    return issues;
  }
  if (forms > 1) {
    issues.push({ path: `/sources/${i}`, message: 'give one place, a list of places or a table of places — not more than one' });
    return issues;
  }

  if (single && kind === 'coordinates' && (source.latitude === undefined || source.longitude === undefined)) {
    issues.push({ path: `/sources/${i}`, message: 'latitude and longitude go together' });
  }

  const needs = (place: PlaceRef): boolean =>
    kind === 'area' ? place.area !== undefined : place.latitude !== undefined && place.longitude !== undefined;
  source.places?.forEach((place, p) => {
    if (!needs(place)) {
      issues.push({
        path: `/sources/${i}/places/${p}`,
        message:
          kind === 'area'
            ? `"${place.name}" needs an AirNow area id`
            : `"${place.name}" needs a latitude and longitude`,
      });
    }
  });
  return issues;
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
export function assertValidComposition(doc: unknown, assets?: readonly AssetRef[]): asserts doc is Composition {
  const result = validateComposition(doc, assets);
  if (!result.valid) {
    throw new CompositionValidationError('Invalid composition', result.errors);
  }
}

export function assertValidProject(doc: unknown, assets?: readonly AssetRef[]): asserts doc is Project {
  const result = validateProject(doc, assets);
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
