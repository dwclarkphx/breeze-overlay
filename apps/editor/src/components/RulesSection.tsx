// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Layer rules (CYCLE.md, Wave 6): when something in the data or the mode is
 * true, show or hide this layer, recolour it, or change its image.
 *
 * Kept out of `PropertiesPanel.tsx`, which is long enough, and because rules
 * are the one section every layer type gets. The runtime evaluates them in
 * the stage preview as they are typed, against the project's live data — the
 * mode is the one thing the preview cannot see, since it is the air's.
 */

import { useState, type JSX } from 'react';
import {
  RULE_OPS,
  type DataColumn,
  type Layer,
  type LayerRule,
  type RuleCondition,
  type RuleOp,
} from '@breeze/schema';
import { useT } from '@breeze/i18n/react';

import { useEditor } from '../state/store.js';

type Subject = 'mode' | 'field' | 'rows' | 'value' | 'column';

const SUBJECT_LABEL_KEY: Record<Subject, string> = {
  mode: 'editor.properties.ruleSubjectMode',
  field: 'editor.properties.ruleSubjectField',
  rows: 'editor.properties.ruleSubjectRows',
  value: 'editor.properties.ruleSubjectValue',
  column: 'editor.properties.ruleSubjectColumn',
};

const OP_LABEL_KEY: Record<RuleOp, string> = {
  eq: 'editor.properties.filterEq', ne: 'editor.properties.filterNe',
  gt: 'editor.properties.filterGt', gte: 'editor.properties.filterGte',
  lt: 'editor.properties.filterLt', lte: 'editor.properties.filterLte',
  contains: 'editor.properties.filterContains',
  startsWith: 'editor.properties.filterStartsWith',
  endsWith: 'editor.properties.filterEndsWith',
  empty: 'editor.properties.filterEmpty', notEmpty: 'editor.properties.filterNotEmpty',
  in: 'editor.properties.ruleOpIn',
};

function subjectOf(c: RuleCondition): Subject {
  if (c.mode) return 'mode';
  if (c.binding !== undefined) return 'field';
  if (c.source !== undefined) return c.column !== undefined ? 'value' : 'rows';
  return 'column';
}

/** A fresh condition for a subject, keeping the comparison and value. */
function withSubject(c: RuleCondition, subject: Subject, firstSource: string): RuleCondition {
  const base: RuleCondition = { cmp: c.cmp, ...(c.value !== undefined ? { value: c.value } : {}) };
  switch (subject) {
    case 'mode': return { ...base, mode: true };
    case 'field': return { ...base, binding: '' };
    case 'rows': return { ...base, source: firstSource };
    case 'value': return { ...base, source: firstSource, column: '' };
    default: return { ...base, column: '' };
  }
}

const NONE = '';

/**
 * The row picker, `column=value`. Typed into freely and committed on blur or
 * Enter: committing per keystroke dropped every character until an `=`
 * arrived, since a half-typed pair parses to nothing.
 */
function WhereInput({
  where,
  onCommit,
}: {
  where: RuleCondition['where'];
  onCommit: (where: RuleCondition['where']) => void;
}): JSX.Element {
  const t = useT();
  const [text, setText] = useState(where ? `${where.column}=${String(where.value ?? '')}` : NONE);
  const commit = () => {
    const at = text.indexOf('=');
    if (at > 0) onCommit({ column: text.slice(0, at).trim(), value: text.slice(at + 1).trim() });
    else onCommit(undefined);
  };
  return (
    <input
      className="rule-where"
      value={text}
      placeholder={t('editor.properties.ruleWherePlaceholder')}
      title={t('editor.properties.ruleWhereTitle')}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

/** The visibility select's value. One return a line: the i18n detector pairs quotes per line. */
function showChoice(rule: LayerRule): string {
  if (rule.show === undefined) return '';
  if (rule.show) return 'show';
  return 'hide';
}

/** A new rule: "show when" on the row, or on the mode. */
function blankRule(inCell: boolean, column: string, mode: string): LayerRule {
  const when: RuleCondition = inCell
    ? { column, cmp: 'notEmpty' }
    : { mode: true, cmp: 'eq', value: mode };
  return { when: [when], show: true };
}

function valueText(v: RuleCondition['value']): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(String).join(', ');
  return String(v);
}

export function RulesSection({
  layer,
  inCell,
  cellColumns,
  sources,
  modes,
  onPatch,
}: {
  layer: Layer;
  /** The layer is a table cell, so a condition can read its own row. */
  inCell: boolean;
  cellColumns: string[];
  sources: Array<{ id: string; name: string; columns: DataColumn[] }>;
  /** Modes other rules in the project already name, offered as suggestions. */
  modes: string[];
  onPatch: (patch: Partial<Layer>) => void;
}): JSX.Element {
  const t = useT();
  const previewMode = useEditor((s) => s.previewMode);
  const setPreviewMode = useEditor((s) => s.setPreviewMode);
  const rules = layer.rules ?? [];
  const firstSource = sources[0]?.id ?? '';
  const listId = `rule-cols-${layer.id}`;
  const modeListId = `rule-modes-${layer.id}`;
  const allColumns = [...new Set([...cellColumns, ...sources.flatMap((s) => s.columns.map((c) => c.key))])];

  const setRules = (next: LayerRule[]) => onPatch({ rules: next.length ? next : undefined } as Partial<Layer>);
  const setRule = (i: number, rule: LayerRule | null) => {
    const next = [...rules];
    if (rule === null) next.splice(i, 1);
    else next[i] = rule;
    setRules(next);
  };
  const setCondition = (i: number, j: number, cond: RuleCondition | null) => {
    const rule = rules[i]!;
    const when = [...rule.when];
    if (cond === null) when.splice(j, 1);
    else when[j] = cond;
    setRule(i, when.length ? { ...rule, when } : null);
  };

  const subjects: Subject[] = inCell ? ['column', 'value', 'rows', 'field', 'mode'] : ['mode', 'value', 'rows', 'field'];
  const canColor = layer.type === 'text' || layer.type === 'shape';
  const canSrc = layer.type === 'image';

  return (
    <section className="prop-section rules-section">
      <h3>{t('editor.properties.sectionRules')}</h3>
      <p className="hint">{t(inCell ? 'editor.properties.rulesCellHint' : 'editor.properties.rulesHint')}</p>
      {modes.length > 0 && (
        <label className="rule-preview">
          <span>{t('editor.properties.rulePreviewMode')}</span>
          <select
            value={previewMode}
            title={t('editor.properties.rulePreviewModeTitle')}
            onChange={(e) => setPreviewMode(e.target.value)}
          >
            <option value="">{t('editor.properties.rulePreviewNone')}</option>
            {modes.map((m) => <option key={m} value={m}>{m}</option>)}
            {previewMode && !modes.includes(previewMode) && <option value={previewMode}>{previewMode}</option>}
          </select>
        </label>
      )}
      <datalist id={listId}>
        {allColumns.map((c) => <option key={c} value={c} />)}
      </datalist>
      <datalist id={modeListId}>
        {modes.map((m) => <option key={m} value={m} />)}
      </datalist>

      {rules.map((rule, i) => (
        <div key={i} className="rule">
          <div className="rule-head">
            <span>{t('editor.properties.ruleWhen')}</span>
            <button className="transform-del" title={t('editor.properties.ruleRemove')} onClick={() => setRule(i, null)}>×</button>
          </div>

          {rule.when.map((cond, j) => {
            const subject = subjectOf(cond);
            const needsValue = cond.cmp !== 'empty' && cond.cmp !== 'notEmpty';
            return (
              <div key={j} className="rule-condition">
                <select
                  value={subject}
                  onChange={(e) => setCondition(i, j, withSubject(cond, e.target.value as Subject, firstSource))}
                >
                  {subjects.map((s) => <option key={s} value={s}>{t(SUBJECT_LABEL_KEY[s])}</option>)}
                </select>

                {(subject === 'rows' || subject === 'value') && (
                  <select value={cond.source ?? ''} onChange={(e) => setCondition(i, j, { ...cond, source: e.target.value })}>
                    {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    {cond.source && !sources.some((s) => s.id === cond.source) && <option value={cond.source}>{cond.source}</option>}
                  </select>
                )}
                {(subject === 'value' || subject === 'column') && (
                  <input
                    list={listId}
                    value={cond.column ?? ''}
                    placeholder={t('editor.properties.ruleColumnPlaceholder')}
                    onChange={(e) => setCondition(i, j, { ...cond, column: e.target.value })}
                  />
                )}
                {subject === 'field' && (
                  <input
                    value={cond.binding ?? ''}
                    placeholder={t('editor.properties.ruleFieldPlaceholder')}
                    onChange={(e) => setCondition(i, j, { ...cond, binding: e.target.value })}
                  />
                )}

                <select
                  value={cond.cmp}
                  onChange={(e) => setCondition(i, j, { ...cond, cmp: e.target.value as RuleOp })}
                >
                  {RULE_OPS.map((op) => <option key={op} value={op}>{t(OP_LABEL_KEY[op])}</option>)}
                </select>

                {needsValue && (
                  <input
                    list={subject === 'mode' ? modeListId : undefined}
                    value={valueText(cond.value)}
                    placeholder={t(subject === 'mode' ? 'editor.properties.ruleModePlaceholder' : 'editor.properties.ruleValuePlaceholder')}
                    onChange={(e) => setCondition(i, j, { ...cond, value: e.target.value })}
                  />
                )}

                {subject === 'value' && (
                  <WhereInput
                    key={`${layer.id}:${i}:${j}`}
                    where={cond.where}
                    onCommit={(where) => {
                      const next = { ...cond };
                      if (where) next.where = where;
                      else delete next.where;
                      setCondition(i, j, next);
                    }}
                  />
                )}

                <button className="transform-del" title={t('editor.properties.ruleRemoveCondition')} onClick={() => setCondition(i, j, null)}>×</button>
              </div>
            );
          })}

          <button
            className="linkish"
            onClick={() => setRule(i, { ...rule, when: [...rule.when, { mode: true, cmp: 'eq', value: '' }] })}
          >
            {t('editor.properties.ruleAnd')}
          </button>

          <div className="rule-then">
            <span>{t('editor.properties.ruleThen')}</span>
            <select
              value={showChoice(rule)}
              onChange={(e) => {
                const next = { ...rule };
                if (e.target.value === '') delete next.show;
                else next.show = e.target.value === 'show';
                setRule(i, next);
              }}
            >
              <option value="">{t('editor.properties.ruleShowUnchanged')}</option>
              <option value="show">{t('editor.properties.ruleShowShow')}</option>
              <option value="hide">{t('editor.properties.ruleShowHide')}</option>
            </select>
            {canColor && (
              <label className="inline">
                <input
                  type="checkbox"
                  checked={rule.color !== undefined}
                  onChange={(e) => {
                    const next = { ...rule };
                    if (e.target.checked) next.color = '#c8102e';
                    else delete next.color;
                    setRule(i, next);
                  }}
                />
                <span>{t('editor.properties.ruleColor')}</span>
                {rule.color !== undefined && (
                  <input type="color" value={rule.color} onChange={(e) => setRule(i, { ...rule, color: e.target.value })} />
                )}
              </label>
            )}
            {canSrc && (
              <input
                value={rule.src ?? ''}
                placeholder={t('editor.properties.ruleSrcPlaceholder')}
                title={t('editor.properties.ruleSrcTitle')}
                onChange={(e) => {
                  const next = { ...rule };
                  if (e.target.value) next.src = e.target.value;
                  else delete next.src;
                  setRule(i, next);
                }}
              />
            )}
          </div>
        </div>
      ))}

      <button
        className="linkish"
        onClick={() =>
          setRules([...rules, blankRule(inCell, cellColumns[0] ?? NONE, modes[0] ?? NONE)])
        }
      >
        {t('editor.properties.ruleAdd')}
      </button>
    </section>
  );
}
