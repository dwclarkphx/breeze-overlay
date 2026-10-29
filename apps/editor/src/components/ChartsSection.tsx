// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Rolls and data-driven graphics in the properties panel (Phase 9 Wave R,
 * ROLLS.md, CHARTS.md).
 *
 * Kept out of `PropertiesPanel.tsx` for the reason `RulesSection` is: that
 * file is long enough, and drives — like rules — are a section every layer
 * gets. Everything here previews as it is typed: the stage runtime draws the
 * bars, arcs, lines and rolls against the project's live data.
 */

import { useId, type JSX } from 'react';
import {
  ARC_CAPS,
  DEFAULT_CRAWL_SEPARATOR,
  DEFAULT_SCROLL_ID,
  DEFAULT_TIMER_ID,
  DRIVE_GROWS,
  DRIVE_PROPS,
  NAMED_EASES,
  PLOT_CURVES,
  ROLL_DIRECTIONS,
  ROLL_ENDS,
  ROLL_FROMS,
  ROLL_STARTS,
  ROLL_TOS,
  SCROLL_ID_PATTERN,
  defaultDriveRange,
  parseTextBody,
  type AnimatableProp,
  type DataColumn,
  type DomainEnd,
  type DriveProp,
  type DriveSubject,
  type Layer,
  type LayerDrive,
  type PlotDomainEnd,
  type RollLayer,
  type ShapeLayer,
  type TextLayer,
} from '@breeze/schema';
import { useT } from '@breeze/i18n/react';

type SourceChoice = { id: string; name: string; columns: DataColumn[] };

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="prop-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="prop-field">
      <span className="prop-label">{label}</span>
      <span className="prop-input">{children}</span>
    </label>
  );
}

const num = (text: string, fallback = 0): number => {
  const n = Number(text);
  return Number.isFinite(n) ? n : fallback;
};

/* ------------------------------------------------------------------ drives */

const DRIVE_PROP_KEY: Record<DriveProp, string> = {
  width: 'editor.properties.width',
  height: 'editor.properties.height',
  x: 'editor.charts.propX',
  y: 'editor.charts.propY',
  scaleX: 'editor.charts.propScaleX',
  scaleY: 'editor.charts.propScaleY',
  rotation: 'editor.charts.propRotation',
  opacity: 'editor.charts.propOpacity',
  sweep: 'editor.charts.propSweep',
  trim: 'editor.charts.propTrim',
};

type SubjectKind = 'column' | 'value' | 'field' | 'timer';

const SUBJECT_KEY: Record<SubjectKind, string> = {
  column: 'editor.charts.subjectColumn',
  value: 'editor.charts.subjectValue',
  field: 'editor.charts.subjectField',
  timer: 'editor.charts.subjectTimer',
};

const GROW_KEY: Record<(typeof DRIVE_GROWS)[number], string> = {
  start: 'editor.charts.growStart',
  center: 'editor.charts.growCenter',
  end: 'editor.charts.growEnd',
};

const CAP_KEY: Record<(typeof ARC_CAPS)[number], string> = {
  butt: 'editor.charts.capButt',
  round: 'editor.charts.capRound',
};

const CURVE_KEY: Record<(typeof PLOT_CURVES)[number], string> = {
  linear: 'editor.charts.curveLinear',
  monotone: 'editor.charts.curveMonotone',
};

// Pairs rather than an object literal: these are travel directions, not CSS sides.
const DIRECTION_KEY = Object.fromEntries([
  ['up', 'editor.charts.directionUp'],
  ['down', 'editor.charts.directionDown'],
  ['left', 'editor.charts.directionLeft'],
  ['right', 'editor.charts.directionRight'],
]) as Record<(typeof ROLL_DIRECTIONS)[number], string>;

/** A new plot on the first source, reading its first numeric column. */
function freshPlot(sources: SourceChoice[]): NonNullable<ShapeLayer['plot']> {
  const first = sources[0];
  const y = first?.columns.find((c) => c.type === 'number')?.key;
  return {
    source: first?.id ?? '',
    y: y ?? '',
    curve: 'monotone',
  };
}

const START_KEY: Record<(typeof ROLL_STARTS)[number], string> = {
  play: 'editor.charts.startPlay',
  operator: 'editor.charts.startOperator',
};

const FROM_KEY: Record<(typeof ROLL_FROMS)[number], string> = {
  enter: 'editor.charts.fromEnter',
  top: 'editor.charts.fromTop',
};

const END_KEY: Record<(typeof ROLL_ENDS)[number], string> = {
  hold: 'editor.charts.endHold',
  loop: 'editor.charts.endLoop',
  continue: 'editor.charts.endContinue',
};

const TO_KEY: Record<(typeof ROLL_TOS)[number], string> = {
  exit: 'editor.charts.toExit',
  bottom: 'editor.charts.toBottom',
};

function subjectKind(from: DriveSubject): SubjectKind {
  if (from.timer !== undefined) return 'timer';
  if (from.binding !== undefined) return 'field';
  if (from.source !== undefined) return 'value';
  return 'column';
}

type DomainKind = 'number' | 'min' | 'max' | 'total' | 'column' | 'field';

function domainKind(end: DomainEnd | undefined, fallback: DomainKind): DomainKind {
  if (end === undefined) return fallback;
  if (typeof end === 'number') return 'number';
  if (typeof end === 'string') return end;
  return 'column' in end ? 'column' : 'field';
}

/** The properties a drive can move on this layer. */
export function drivablePropsOf(layer: Layer): DriveProp[] {
  return DRIVE_PROPS.filter((p) => {
    if (p === 'sweep') return layer.type === 'shape' && layer.shape === 'ellipse' && layer.arc !== undefined;
    if (p === 'trim') return layer.type === 'shape' && (layer.shape === 'path' || (layer.shape === 'ellipse' && layer.arc !== undefined));
    return true;
  });
}

function DomainEndInput({
  value,
  fallback,
  onChange,
  columns,
}: {
  value: DomainEnd | undefined;
  fallback: DomainKind;
  onChange: (next: DomainEnd | undefined) => void;
  columns: string;
}): JSX.Element {
  const t = useT();
  const kind = domainKind(value, fallback);
  return (
    <span className="drive-domain">
      <select
        value={kind}
        onChange={(e) => {
          const k = e.target.value as DomainKind;
          if (k === fallback) onChange(undefined);
          else if (k === 'number') onChange(0);
          else if (k === 'column') onChange({ column: '' });
          else if (k === 'field') onChange({ binding: '' });
          else onChange(k);
        }}
      >
        <option value="number">{t('editor.charts.domainNumber')}</option>
        <option value="min">{t('editor.charts.domainMin')}</option>
        <option value="max">{t('editor.charts.domainMax')}</option>
        <option value="total">{t('editor.charts.domainTotal')}</option>
        <option value="column">{t('editor.charts.domainColumn')}</option>
        <option value="field">{t('editor.charts.domainField')}</option>
      </select>
      {kind === 'number' && (
        <input type="number" value={typeof value === 'number' ? value : 0} onChange={(e) => onChange(num(e.target.value))} />
      )}
      {kind === 'column' && typeof value === 'object' && 'column' in value && (
        <input list={columns} value={value.column} placeholder={t('editor.charts.columnPlaceholder')} onChange={(e) => onChange({ column: e.target.value })} />
      )}
      {kind === 'field' && typeof value === 'object' && 'binding' in value && (
        <input value={value.binding} placeholder={t('editor.charts.fieldPlaceholder')} onChange={(e) => onChange({ binding: e.target.value })} />
      )}
    </span>
  );
}

/**
 * Drives (CHARTS.md §3): a number from data moving a property. A bar is a
 * `width` drive in a table cell; a meter, a `height` drive whose top end is a
 * goal; a gauge, a `sweep` drive on an arc.
 */
export function DrivesSection({
  layer,
  inCell,
  cellColumns,
  sources,
  onPatch,
}: {
  layer: Layer;
  inCell: boolean;
  cellColumns: string[];
  sources: SourceChoice[];
  onPatch: (patch: Partial<Layer>) => void;
}): JSX.Element {
  const t = useT();
  const listId = useId();
  const drives = layer.drives ?? [];
  const props = drivablePropsOf(layer);
  const setDrives = (next: LayerDrive[]) => onPatch({ drives: next.length ? next : undefined } as Partial<Layer>);
  const setDrive = (i: number, next: LayerDrive | null) =>
    setDrives(next ? drives.map((d, j) => (j === i ? next : d)) : drives.filter((_, j) => j !== i));
  const subjects: SubjectKind[] = inCell ? ['column', 'value', 'field', 'timer'] : ['value', 'field', 'timer'];
  const allColumns = [...new Set([...cellColumns, ...sources.flatMap((s) => s.columns.map((c) => c.key))])];

  const blank = (): LayerDrive => ({
    property: 'width',
    from: inCell ? { column: cellColumns[0] ?? '' } : { binding: '' },
    range: defaultDriveRange('width', layer.size),
    tween: { duration: 0.6, ease: 'power2.out' },
  });

  return (
    <Section title={t('editor.charts.sectionDrives')}>
      <datalist id={listId}>
        {allColumns.map((c) => <option key={c} value={c} />)}
      </datalist>
      {drives.length === 0 && <p className="hint">{t('editor.charts.drivesHint')}</p>}
      {drives.map((drive, i) => {
        const kind = subjectKind(drive.from);
        const setFrom = (from: DriveSubject) => setDrive(i, { ...drive, from });
        return (
          <div key={i} className="rule" data-drive={drive.property}>
            <div className="rule-head">
              <span>{t('editor.charts.driveTitle')}</span>
              <button className="transform-del" title={t('editor.charts.driveRemove')} onClick={() => setDrive(i, null)}>×</button>
            </div>
            <Field label={t('editor.charts.driveProperty')}>
              <select
                value={drive.property}
                onChange={(e) => {
                  const property = e.target.value as DriveProp;
                  const next: LayerDrive = { ...drive, property, range: defaultDriveRange(property, layer.size) };
                  if (property !== 'width' && property !== 'height') delete next.grow;
                  setDrive(i, next);
                }}
              >
                {props.map((p) => <option key={p} value={p}>{t(DRIVE_PROP_KEY[p])}</option>)}
              </select>
            </Field>
            <Field label={t('editor.charts.driveFrom')}>
              <select
                value={kind}
                onChange={(e) => {
                  const k = e.target.value as SubjectKind;
                  if (k === 'column') setFrom({ column: cellColumns[0] ?? '' });
                  else if (k === 'value') {
                    const source = sources[0]?.id ?? '';
                    setFrom({ source, column: '' });
                  }
                  else if (k === 'field') setFrom({ binding: '' });
                  else setFrom({ timer: 'main' });
                }}
              >
                {subjects.map((s) => <option key={s} value={s}>{t(SUBJECT_KEY[s])}</option>)}
              </select>
            </Field>
            {kind === 'value' && (
              <Field label={t('editor.charts.source')}>
                <select value={drive.from.source ?? ''} onChange={(e) => setFrom({ ...drive.from, source: e.target.value })}>
                  {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  {drive.from.source && !sources.some((s) => s.id === drive.from.source) && (
                    <option value={drive.from.source}>{drive.from.source}</option>
                  )}
                </select>
              </Field>
            )}
            {(kind === 'column' || kind === 'value') && (
              <Field label={t('editor.charts.column')}>
                <input list={listId} value={drive.from.column ?? ''} placeholder={t('editor.charts.columnPlaceholder')} onChange={(e) => setFrom({ ...drive.from, column: e.target.value })} />
              </Field>
            )}
            {kind === 'value' && (
              <Field label={t('editor.charts.where')}>
                <input
                  value={drive.from.where ? `${drive.from.where.column}=${String(drive.from.where.value ?? '')}` : ''}
                  placeholder={t('editor.charts.wherePlaceholder')}
                  onChange={(e) => {
                    const text = e.target.value;
                    const at = text.indexOf('=');
                    const next: DriveSubject = { ...drive.from };
                    if (at > 0) next.where = { column: text.slice(0, at).trim(), value: text.slice(at + 1).trim() };
                    else delete next.where;
                    setFrom(next);
                  }}
                />
              </Field>
            )}
            {kind === 'field' && (
              <Field label={t('editor.charts.field')}>
                <input value={drive.from.binding ?? ''} placeholder={t('editor.charts.fieldPlaceholder')} onChange={(e) => setFrom({ binding: e.target.value })} />
              </Field>
            )}
            {kind === 'timer' && (
              <Field label={t('editor.charts.timer')}>
                <input value={drive.from.timer ?? ''} placeholder={DEFAULT_TIMER_ID} onChange={(e) => setFrom({ timer: e.target.value })} />
              </Field>
            )}
            <Field label={t('editor.charts.domainFrom')}>
              <DomainEndInput
                value={drive.domain?.min}
                fallback="number"
                columns={listId}
                onChange={(min) => setDrive(i, { ...drive, domain: { ...drive.domain, ...(min === undefined ? { min: 0 } : { min }) } })}
              />
            </Field>
            <Field label={t('editor.charts.domainTo')}>
              <DomainEndInput
                value={drive.domain?.max}
                fallback="max"
                columns={listId}
                onChange={(max) => {
                  const domain = { ...drive.domain };
                  if (max === undefined) delete domain.max;
                  else domain.max = max;
                  setDrive(i, { ...drive, domain });
                }}
              />
            </Field>
            <Field label={t('editor.charts.range')}>
              <span className="drive-range">
                <input type="number" value={drive.range[0]} onChange={(e) => setDrive(i, { ...drive, range: [num(e.target.value), drive.range[1]] })} />
                <input type="number" value={drive.range[1]} onChange={(e) => setDrive(i, { ...drive, range: [drive.range[0], num(e.target.value)] })} />
              </span>
            </Field>
            {(drive.property === 'width' || drive.property === 'height') && (
              <Field label={t('editor.charts.grow')}>
                <select value={drive.grow ?? 'start'} onChange={(e) => setDrive(i, { ...drive, grow: e.target.value as LayerDrive['grow'] })}>
                  {DRIVE_GROWS.map((g) => <option key={g} value={g}>{t(GROW_KEY[g])}</option>)}
                </select>
              </Field>
            )}
            <Field label={t('editor.charts.tween')}>
              <input
                type="number"
                min={0}
                step={0.1}
                value={drive.tween?.duration ?? 0}
                title={t('editor.charts.tweenTitle')}
                onChange={(e) => {
                  const duration = Math.max(0, num(e.target.value));
                  const next = { ...drive };
                  if (duration > 0) next.tween = { ...(drive.tween ?? {}), duration };
                  else delete next.tween;
                  setDrive(i, next);
                }}
              />
            </Field>
            {drive.tween && (
              <Field label={t('editor.charts.ease')}>
                <select value={typeof drive.tween.ease === 'string' ? drive.tween.ease : 'power2.out'} onChange={(e) => setDrive(i, { ...drive, tween: { ...drive.tween!, ease: e.target.value } })}>
                  {NAMED_EASES.map((ease) => <option key={ease} value={ease}>{ease}</option>)}
                </select>
              </Field>
            )}
            <Field label={t('editor.charts.clamp')}>
              <input type="checkbox" checked={drive.clamp !== false} onChange={(e) => setDrive(i, { ...drive, ...(e.target.checked ? { clamp: undefined } : { clamp: false }) })} />
            </Field>
          </div>
        );
      })}
      <button className="linkish" onClick={() => setDrives([...drives, blank()])}>
        {t('editor.charts.driveAdd')}
      </button>
    </Section>
  );
}

/* ------------------------------------------------------- arcs, trim, plots */

/**
 * The chart controls a shape grows (CHARTS.md §4): an arc on an ellipse, a
 * draw-on for any outline, and a path plotted from rows. Sweep and trim are
 * keyframable, so they carry the panel's stopwatch.
 */
export function ShapeChartFields({
  layer,
  sources,
  stopwatch,
  onPatch,
}: {
  layer: ShapeLayer;
  sources: SourceChoice[];
  /** The panel's own keyframable number field. */
  stopwatch: (prop: AnimatableProp, label: string, step: number) => JSX.Element;
  onPatch: (patch: Partial<Layer>) => void;
}): JSX.Element {
  const t = useT();
  const arc = layer.arc;
  const plot = layer.plot;
  const bound = plot?.source ? sources.find((s) => s.id === plot.source) : undefined;
  const columns = bound?.columns ?? [];
  const domainValue = (end: PlotDomainEnd | undefined): string => (typeof end === 'number' ? String(end) : '');
  const setDomain = (which: 'min' | 'max', text: string) => {
    const domain = { ...(plot?.domain ?? {}) };
    if (text.trim() === '') delete domain[which];
    else domain[which] = num(text);
    onPatch({ plot: { ...plot!, domain } } as Partial<Layer>);
  };

  return (
    <>
      {layer.shape === 'ellipse' && (
        <Field label={t('editor.charts.arc')}>
          <input
            type="checkbox"
            checked={arc !== undefined}
            title={t('editor.charts.arcTitle')}
            onChange={(e) => onPatch({ arc: e.target.checked ? { start: 0, sweep: 270, thickness: 24, cap: 'round' } : undefined } as Partial<Layer>)}
          />
        </Field>
      )}
      {layer.shape === 'ellipse' && arc && (
        <>
          <Field label={t('editor.charts.arcStart')}>
            <input type="number" step={5} value={arc.start ?? 0} onChange={(e) => onPatch({ arc: { ...arc, start: num(e.target.value) } } as Partial<Layer>)} />
          </Field>
          {stopwatch('sweep', t('editor.charts.propSweep'), 5)}
          <Field label={t('editor.charts.arcThickness')}>
            <input
              type="number"
              min={0}
              value={arc.thickness ?? 0}
              title={t('editor.charts.arcThicknessTitle')}
              onChange={(e) => {
                const thickness = Math.max(0, num(e.target.value));
                const next = { ...arc };
                if (thickness > 0) next.thickness = thickness;
                else delete next.thickness;
                onPatch({ arc: next } as Partial<Layer>);
              }}
            />
          </Field>
          {arc.thickness !== undefined && (
            <Field label={t('editor.charts.arcCap')}>
              <select value={arc.cap ?? 'butt'} onChange={(e) => onPatch({ arc: { ...arc, cap: e.target.value as 'butt' | 'round' } } as Partial<Layer>)}>
                {ARC_CAPS.map((c) => <option key={c} value={c}>{t(CAP_KEY[c])}</option>)}
              </select>
            </Field>
          )}
        </>
      )}
      {(layer.shape === 'path' || (layer.shape === 'ellipse' && arc)) && stopwatch('trim', t('editor.charts.propTrim'), 0.05)}
      {layer.shape === 'path' && (
        <Field label={t('editor.charts.plot')}>
          <input
            type="checkbox"
            checked={plot !== undefined}
            title={t('editor.charts.plotTitle')}
            onChange={(e) =>
              onPatch({
                plot: e.target.checked ? freshPlot(sources) : undefined,
              } as Partial<Layer>)
            }
          />
        </Field>
      )}
      {layer.shape === 'path' && plot && (
        <>
          <Field label={t('editor.charts.source')}>
            <select value={plot.source ?? ''} onChange={(e) => onPatch({ plot: { ...plot, source: e.target.value } } as Partial<Layer>)}>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              {plot.source && !bound && <option value={plot.source}>{plot.source}</option>}
            </select>
          </Field>
          <Field label={t('editor.charts.plotY')}>
            <select value={plot.y} onChange={(e) => onPatch({ plot: { ...plot, y: e.target.value } } as Partial<Layer>)}>
              <option value="">{t('editor.charts.pickColumn')}</option>
              {columns.map((c) => <option key={c.key} value={c.key}>{c.label ?? c.key}</option>)}
              {plot.y && !columns.some((c) => c.key === plot.y) && <option value={plot.y}>{plot.y}</option>}
            </select>
          </Field>
          <Field label={t('editor.charts.plotX')}>
            <select
              value={plot.x ?? ''}
              onChange={(e) => {
                const next = { ...plot };
                if (e.target.value) next.x = e.target.value;
                else delete next.x;
                onPatch({ plot: next } as Partial<Layer>);
              }}
            >
              <option value="">{t('editor.charts.plotEven')}</option>
              {columns.map((c) => <option key={c.key} value={c.key}>{c.label ?? c.key}</option>)}
            </select>
          </Field>
          <Field label={t('editor.charts.curve')}>
            <select value={plot.curve ?? 'linear'} onChange={(e) => onPatch({ plot: { ...plot, curve: e.target.value as 'linear' | 'monotone' } } as Partial<Layer>)}>
              {PLOT_CURVES.map((c) => <option key={c} value={c}>{t(CURVE_KEY[c])}</option>)}
            </select>
          </Field>
          <Field label={t('editor.charts.area')}>
            <input type="checkbox" checked={plot.area === true} onChange={(e) => onPatch({ plot: { ...plot, area: e.target.checked || undefined } } as Partial<Layer>)} />
          </Field>
          <Field label={t('editor.charts.plotMin')}>
            <input type="number" value={domainValue(plot.domain?.min)} placeholder={t('editor.charts.plotAuto')} onChange={(e) => setDomain('min', e.target.value)} />
          </Field>
          <Field label={t('editor.charts.plotMax')}>
            <input type="number" value={domainValue(plot.domain?.max)} placeholder={t('editor.charts.plotAuto')} onChange={(e) => setDomain('max', e.target.value)} />
          </Field>
          <Field label={t('editor.charts.tween')}>
            <input
              type="number"
              min={0}
              step={0.1}
              value={plot.tween?.duration ?? 0}
              onChange={(e) => {
                const duration = Math.max(0, num(e.target.value));
                const next = { ...plot };
                if (duration > 0) next.tween = { duration, ease: 'power2.inOut' };
                else delete next.tween;
                onPatch({ plot: next } as Partial<Layer>);
              }}
            />
          </Field>
          <p className="hint">{t('editor.charts.plotHint')}</p>
        </>
      )}
    </>
  );
}

/* --------------------------------------------------------------- counts */

/** Counting to a new number (CHARTS.md §4.5). */
export function CountSection({ layer, onPatch }: { layer: TextLayer; onPatch: (patch: Partial<Layer>) => void }): JSX.Element {
  const t = useT();
  const count = layer.count;
  const set = (next: Partial<NonNullable<TextLayer['count']>>) => onPatch({ count: { ...count!, ...next } } as Partial<Layer>);
  return (
    <Section title={t('editor.charts.sectionCount')}>
      <Field label={t('editor.charts.countOn')}>
        <input
          type="checkbox"
          checked={count !== undefined}
          title={t('editor.charts.countTitle')}
          onChange={(e) => onPatch({ count: e.target.checked ? { duration: 0.6, ease: 'power2.out' } : undefined } as Partial<Layer>)}
        />
      </Field>
      {count && (
        <>
          <Field label={t('editor.charts.countDuration')}>
            <input type="number" min={0} step={0.1} value={count.duration} onChange={(e) => set({ duration: Math.max(0, num(e.target.value)) })} />
          </Field>
          <Field label={t('editor.charts.countDecimals')}>
            <input
              type="number"
              min={0}
              max={6}
              value={count.decimals ?? ''}
              placeholder={t('editor.charts.plotAuto')}
              onChange={(e) => {
                const next = { ...count };
                if (e.target.value === '') delete next.decimals;
                else next.decimals = Math.max(0, Math.min(6, Math.round(num(e.target.value))));
                onPatch({ count: next } as Partial<Layer>);
              }}
            />
          </Field>
          <Field label={t('editor.charts.prefix')}>
            <input value={count.prefix ?? ''} onChange={(e) => set({ prefix: e.target.value || undefined })} />
          </Field>
          <Field label={t('editor.charts.suffix')}>
            <input value={count.suffix ?? ''} onChange={(e) => set({ suffix: e.target.value || undefined })} />
          </Field>
        </>
      )}
    </Section>
  );
}

/* ---------------------------------------------------------------- rolls */

/** The authored placeholder of a roll as text, for its text box. */
function placeholderText(layer: RollLayer): string {
  const rows = layer.data?.rows ?? [];
  const lines: string[] = [];
  for (const row of rows) {
    const kind = String(row['kind'] ?? 'line');
    if (kind === 'gap') lines.push('');
    else if (kind === 'heading') lines.push(`# ${String(row['text'] ?? '')}`);
    else if (kind === 'pair') lines.push(`${String(row['left'] ?? '')} | ${String(row['right'] ?? '')}`);
    else lines.push(String(row['text'] ?? ''));
  }
  return lines.join('\n');
}

/**
 * A roll (ROLLS.md §4): where its text comes from, which way and how fast it
 * runs, where it starts and ends, and what PLAY does to it. Its type styles
 * are the panel's ordinary Type sections, beneath.
 */
export function RollSection({
  layer,
  sources,
  onPatch,
}: {
  layer: RollLayer;
  sources: SourceChoice[];
  onPatch: (patch: Partial<Layer>) => void;
}): JSX.Element {
  const t = useT();
  const set = (p: Partial<RollLayer>) => onPatch(p as Partial<Layer>);
  const bound = layer.source ? sources.find((s) => s.id === layer.source) : undefined;
  const vertical = layer.direction === 'up' || layer.direction === 'down';
  const badId = layer.scrollId !== undefined && !SCROLL_ID_PATTERN.test(layer.scrollId);

  return (
    <>
      <Section title={t('editor.charts.sectionRoll')}>
        <Field label={t('editor.charts.source')}>
          <select value={layer.source ?? ''} onChange={(e) => set({ source: e.target.value || undefined })}>
            <option value="">{t('editor.charts.rollTyped')}</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {layer.source && !bound && <option value={layer.source}>{layer.source}</option>}
          </select>
        </Field>
        {layer.source && bound && !bound.columns.some((c) => c.key === (layer.column ?? 'text')) && (
          <Field label={t('editor.charts.column')}>
            <select value={layer.column ?? ''} onChange={(e) => set({ column: e.target.value || undefined })}>
              <option value="">{t('editor.charts.pickColumn')}</option>
              {bound.columns.map((c) => <option key={c.key} value={c.key}>{c.label ?? c.key}</option>)}
            </select>
          </Field>
        )}
        <Field label={layer.source ? t('editor.charts.rollPlaceholder') : t('editor.charts.rollText')}>
          <textarea
            key={`${layer.id}\u0000${placeholderText(layer)}`}
            rows={6}
            defaultValue={placeholderText(layer)}
            title={t('editor.charts.rollTextTitle')}
            onBlur={(e) => {
              const set2 = parseTextBody(layer.id, e.target.value);
              set({ data: { columns: set2.columns, rows: set2.rows } });
            }}
          />
        </Field>
        <p className="hint">{t('editor.charts.rollMarkupHint')}</p>
        <Field label={t('editor.properties.direction')}>
          <select value={layer.direction} onChange={(e) => set({ direction: e.target.value as RollLayer['direction'] })}>
            {ROLL_DIRECTIONS.map((d) => <option key={d} value={d}>{t(DIRECTION_KEY[d])}</option>)}
          </select>
        </Field>
        <Field label={t('editor.properties.speed')}>
          <input type="number" min={1} step={5} value={layer.speed} title={t('editor.charts.rollSpeedTitle')} onChange={(e) => set({ speed: Math.max(1, num(e.target.value, 60)) })} />
        </Field>
        <Field label={t('editor.charts.rollStart')}>
          <select value={layer.start ?? 'play'} onChange={(e) => set({ start: e.target.value as RollLayer['start'] })}>
            {ROLL_STARTS.map((s) => <option key={s} value={s}>{t(START_KEY[s])}</option>)}
          </select>
        </Field>
        <Field label={t('editor.charts.rollFrom')}>
          <select value={layer.from ?? 'enter'} onChange={(e) => set({ from: e.target.value as RollLayer['from'] })}>
            {ROLL_FROMS.map((f) => <option key={f} value={f}>{t(FROM_KEY[f])}</option>)}
          </select>
        </Field>
        <Field label={t('editor.charts.rollEnd')}>
          <select value={layer.end ?? 'hold'} onChange={(e) => set({ end: e.target.value as RollLayer['end'], ...(e.target.value !== 'loop' ? { loopGap: undefined } : {}) })}>
            {ROLL_ENDS.map((x) => <option key={x} value={x}>{t(END_KEY[x])}</option>)}
          </select>
        </Field>
        {layer.end !== 'loop' && (
          <Field label={t('editor.charts.rollTo')}>
            <select value={layer.to ?? 'exit'} onChange={(e) => set({ to: e.target.value as RollLayer['to'] })}>
              {ROLL_TOS.map((x) => <option key={x} value={x}>{t(TO_KEY[x])}</option>)}
            </select>
          </Field>
        )}
        {layer.end === 'loop' && (
          <Field label={t('editor.charts.loopGap')}>
            <input type="number" min={0} value={layer.loopGap ?? ''} placeholder={t('editor.charts.plotAuto')} onChange={(e) => set({ loopGap: e.target.value === '' ? undefined : Math.max(0, num(e.target.value)) })} />
          </Field>
        )}
        <Field label={t('editor.charts.scrollId')}>
          <input value={layer.scrollId ?? ''} placeholder={DEFAULT_SCROLL_ID} title={t('editor.charts.scrollIdTitle')} onChange={(e) => set({ scrollId: e.target.value.trim() || undefined })} />
        </Field>
        {badId && <p className="hint warn">{t('editor.charts.scrollIdBad')}</p>}
      </Section>
      <Section title={t('editor.charts.sectionRollLayout')}>
        {vertical ? (
          <>
            <Field label={t('editor.charts.spacing')}>
              <input type="number" min={0} value={layer.spacing ?? 0} onChange={(e) => set({ spacing: Math.max(0, num(e.target.value)) || undefined })} />
            </Field>
            <Field label={t('editor.charts.gapSize')}>
              <input type="number" min={0} value={layer.gapSize ?? ''} placeholder={t('editor.charts.plotAuto')} onChange={(e) => set({ gapSize: e.target.value === '' ? undefined : Math.max(0, num(e.target.value)) })} />
            </Field>
            <Field label={t('editor.charts.pairSplit')}>
              <input
                type="number"
                min={10}
                max={90}
                step={5}
                value={Math.round((layer.pairStyle?.split ?? 0.5) * 100)}
                onChange={(e) => set({ pairStyle: { ...(layer.pairStyle ?? {}), split: Math.min(0.9, Math.max(0.1, num(e.target.value, 50) / 100)) } })}
              />
            </Field>
            <Field label={t('editor.charts.pairGutter')}>
              <input type="number" min={0} value={layer.pairStyle?.gutter ?? 24} onChange={(e) => set({ pairStyle: { ...(layer.pairStyle ?? {}), gutter: Math.max(0, num(e.target.value)) } })} />
            </Field>
          </>
        ) : (
          <Field label={t('editor.charts.separator')}>
            <input value={layer.separator ?? ''} placeholder={DEFAULT_CRAWL_SEPARATOR.trim()} onChange={(e) => set({ separator: e.target.value || undefined })} />
          </Field>
        )}
        <Field label={t('editor.charts.fadeStart')}>
          <input
            type="number"
            min={0}
            value={layer.fade?.start ?? 0}
            onChange={(e) => {
              const start = Math.max(0, num(e.target.value));
              const end = layer.fade?.end ?? 0;
              set({ fade: start || end ? { start, end } : undefined });
            }}
          />
        </Field>
        <Field label={t('editor.charts.fadeEnd')}>
          <input
            type="number"
            min={0}
            value={layer.fade?.end ?? 0}
            onChange={(e) => {
              const end = Math.max(0, num(e.target.value));
              const start = layer.fade?.start ?? 0;
              set({ fade: start || end ? { start, end } : undefined });
            }}
          />
        </Field>
        <Field label={t('editor.charts.ownHeading')}>
          <input
            type="checkbox"
            checked={layer.headingStyle !== undefined}
            title={t('editor.charts.ownHeadingTitle')}
            onChange={(e) =>
              set({
                headingStyle: e.target.checked
                  ? { ...layer.style, fontWeight: 700, fontSize: Math.round(layer.style.fontSize * 1.25) }
                  : undefined,
              })
            }
          />
        </Field>
        <p className="hint">{t('editor.charts.rollPreviewHint')}</p>
      </Section>
    </>
  );
}
