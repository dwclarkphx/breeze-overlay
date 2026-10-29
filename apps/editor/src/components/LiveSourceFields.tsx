// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Text and poll sources in the data panel (Phase 9 Wave R, ROLLS.md §3,
 * CHARTS.md §5), and the format guide for a poll arriving as a feed.
 *
 * Both sources are their own definition, like a manual table: the rows are
 * worked out here as the designer types, with the parser and the tally the
 * server uses, so the preview under the box is what goes on air.
 */

import { useMemo, type JSX } from 'react';
import {
  POLL_FEED_COLUMNS,
  POLL_OPTIONS_MAX,
  POLL_OPTION_ID_PATTERN,
  TEXT_BODY_MAX_BYTES,
  TEXT_SPLITS,
  numericValue,
  parseTextBody,
  pollDataSet,
  textBodyProblem,
  utf8Bytes,
  type DataSet,
  type DataSourceDef,
  type PollOption,
} from '@breeze/schema';
import { useT } from '@breeze/i18n/react';

type TextDef = Extract<DataSourceDef, { type: 'text' }>;
type PollDef = Extract<DataSourceDef, { type: 'poll' }>;

const SPLIT_KEY: Record<(typeof TEXT_SPLITS)[number], string> = {
  lines: 'editor.data.textSplitLines',
  stanzas: 'editor.data.textSplitStanzas',
};

/**
 * A text source: kept in the project (typed, pasted or loaded from a .txt) or
 * fetched from a URL. In the project it can be made operator changeable — the
 * designer's switch (decided 2026-10-26).
 */
export function TextSourceFields({
  def,
  onChange,
  preview,
}: {
  def: TextDef;
  onChange: (def: DataSourceDef) => void;
  /** Draws a DataSet the way the rest of the panel previews one. */
  preview: (data: DataSet, total: number) => JSX.Element;
}): JSX.Element {
  const t = useT();
  const fetched = def.url !== undefined;
  const parsed = useMemo(() => {
    if (fetched) return null;
    try {
      return { data: parseTextBody(def.id, def.body ?? '', { ...(def.split ? { split: def.split } : {}), ...(def.markup !== undefined ? { markup: def.markup } : {}) }) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [fetched, def.id, def.body, def.split, def.markup]);
  const bytes = utf8Bytes(def.body ?? '');

  return (
    <>
      <label>
        <span>{t('editor.data.textWhere')}</span>
        <select
          value={fetched ? 'url' : 'here'}
          onChange={(e) => {
            const { url: _url, body: _body, operatorEditable: _edit, ...rest } = def;
            onChange(e.target.value === 'url' ? { ...rest, url: '' } : { ...rest, body: def.body ?? '' });
          }}
        >
          <option value="here">{t('editor.data.textHere')}</option>
          <option value="url">{t('editor.data.textUrl')}</option>
        </select>
      </label>

      {!fetched && (
        <>
          <label>
            <span>{t('editor.data.textBody')}</span>
            <textarea
              className="text-body"
              rows={14}
              value={def.body ?? ''}
              spellCheck
              onChange={(e) => onChange({ ...def, body: e.target.value })}
            />
          </label>
          <div className="text-body-meta">
            <label className="inline">
              <span>{t('editor.data.textLoad')}</span>
              <input
                type="file"
                accept=".txt,.md,text/plain"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  void file.text().then((body) => onChange({ ...def, body }));
                }}
              />
            </label>
            <span className={bytes > TEXT_BODY_MAX_BYTES ? 'source-error' : 'hint'}>
              {t('editor.data.textSize', { kb: Math.ceil(bytes / 1024), limit: TEXT_BODY_MAX_BYTES / 1024 })}
            </span>
          </div>
        </>
      )}

      <label>
        <span>{t('editor.data.textSplit')}</span>
        <select value={def.split ?? 'lines'} onChange={(e) => onChange({ ...def, split: e.target.value as TextDef['split'] })}>
          {TEXT_SPLITS.map((s) => <option key={s} value={s}>{t(SPLIT_KEY[s])}</option>)}
        </select>
      </label>
      <label className="inline">
        <input type="checkbox" checked={def.markup !== false} onChange={(e) => onChange({ ...def, markup: e.target.checked ? undefined : false })} />
        <span>{t('editor.data.textMarkup')}</span>
      </label>
      <p className="hint">{t('editor.data.textMarkupHint')}</p>

      {!fetched && (
        <label className="inline">
          <input
            type="checkbox"
            checked={def.operatorEditable === true}
            onChange={(e) => onChange({ ...def, operatorEditable: e.target.checked || undefined })}
          />
          <span>{t('editor.data.operatorEditable')}</span>
        </label>
      )}
      {!fetched && <p className="hint">{t('editor.data.textOperatorHint')}</p>}

      {parsed && 'error' in parsed && <div className="source-error">{parsed.error}</div>}
      {parsed && 'data' in parsed && parsed.data && textBodyProblem(def.body ?? '') === null && preview(parsed.data, parsed.data.rows.length)}
    </>
  );
}

/** A fresh option id that is not taken. */
function freshOptionId(options: readonly PollOption[]): string {
  let n = options.length + 1;
  // i18n-ignore-next-line — an option id, frozen data
  while (options.some((o) => o.id === `option-${n}`)) n += 1;
  // i18n-ignore-next-line — an option id, frozen data
  return `option-${n}`;
}

/**
 * A poll: the question, its options and the tally (CHARTS.md §5.1). The
 * operator counts from the control panel; here the designer sets the poll up,
 * and may correct a count.
 */
export function PollSourceFields({
  def,
  onChange,
  preview,
}: {
  def: PollDef;
  onChange: (def: DataSourceDef) => void;
  preview: (data: DataSet, total: number) => JSX.Element;
}): JSX.Element {
  const t = useT();
  const setOption = (i: number, next: PollOption | null) => {
    const options = next ? def.options.map((o, j) => (j === i ? next : o)) : def.options.filter((_, j) => j !== i);
    const kept = new Set(options.map((o) => o.id));
    const votes = Object.fromEntries(Object.entries(def.votes ?? {}).filter(([id]) => kept.has(id)));
    onChange({ ...def, options, votes });
  };
  const data = useMemo(() => pollDataSet(def), [def]);

  return (
    <>
      <label>
        <span>{t('editor.data.pollQuestion')}</span>
        <input value={def.question} onChange={(e) => onChange({ ...def, question: e.target.value })} />
      </label>
      <div className="poll-options-edit">
        <div className="hint">{t('editor.data.pollOptionsHint')}</div>
        {def.options.map((o, i) => {
          const badId = !POLL_OPTION_ID_PATTERN.test(o.id) || def.options.some((p, j) => j !== i && p.id === o.id);
          return (
            <div key={i} className="poll-option-edit">
              <input
                className={badId ? 'invalid' : ''}
                value={o.id}
                title={t('editor.data.pollOptionId')}
                onChange={(e) => {
                  // Renaming an id moves its votes with it.
                  const id = e.target.value.trim();
                  const votes = { ...(def.votes ?? {}) };
                  if (votes[o.id] !== undefined) {
                    votes[id] = votes[o.id]!;
                    delete votes[o.id];
                  }
                  onChange({ ...def, options: def.options.map((p, j) => (j === i ? { ...p, id } : p)), votes });
                }}
              />
              <input value={o.label} placeholder={t('editor.data.pollOptionLabel')} onChange={(e) => setOption(i, { ...o, label: e.target.value })} />
              <input
                type="color"
                value={o.color ?? '#888888'}
                title={t('editor.data.pollOptionColor')}
                onChange={(e) => setOption(i, { ...o, color: e.target.value })}
              />
              <input
                value={o.image ?? ''}
                placeholder={t('editor.data.pollOptionImage')}
                onChange={(e) => {
                  const next = { ...o };
                  if (e.target.value) next.image = e.target.value;
                  else delete next.image;
                  setOption(i, next);
                }}
              />
              <input
                type="number"
                min={0}
                value={def.votes?.[o.id] ?? 0}
                title={t('editor.data.pollVotes')}
                onChange={(e) => onChange({ ...def, votes: { ...(def.votes ?? {}), [o.id]: Math.max(0, Math.floor(Number(e.target.value) || 0)) } })}
              />
              <button className="transform-del" title={t('editor.data.pollOptionRemove')} disabled={def.options.length <= 1} onClick={() => setOption(i, null)}>×</button>
            </div>
          );
        })}
        <button
          className="linkish"
          disabled={def.options.length >= POLL_OPTIONS_MAX}
          onClick={() => onChange({ ...def, options: [...def.options, { id: freshOptionId(def.options), label: '' }] })}
        >
          {t('editor.data.pollOptionAdd')}
        </button>
      </div>
      <label>
        <span>{t('editor.data.pollStatus')}</span>
        <select value={def.status ?? 'open'} onChange={(e) => onChange({ ...def, status: e.target.value === 'closed' ? 'closed' : 'open' })}>
          <option value="open">{t('editor.data.pollOpen')}</option>
          <option value="closed">{t('editor.data.pollClosed')}</option>
        </select>
      </label>
      <label className="inline">
        <input
          type="checkbox"
          checked={def.operatorEditable === true}
          onChange={(e) => onChange({ ...def, operatorEditable: e.target.checked || undefined })}
        />
        <span>{t('editor.data.operatorEditable')}</span>
      </label>
      <p className="hint">{t('editor.data.pollOperatorHint')}</p>
      {preview(data, data.rows.length)}
    </>
  );
}

/**
 * The Poll format guide for a feed (CHARTS.md §5.2): the columns a sheet, CSV
 * or Forms export needs to drive a poll graphic, a starter file, and a check
 * of what the feed returned.
 */
export function PollFeedGuide({ data }: { data: DataSet | undefined }): JSX.Element {
  const t = useT();
  const problems: string[] = [];
  if (data) {
    const keys = new Set(data.columns.map((c) => c.key));
    for (const c of POLL_FEED_COLUMNS) {
      if (c.required && !keys.has(c.key)) problems.push(t('editor.data.pollGuideMissing', { column: c.key }));
    }
    if (keys.has('votes')) {
      const isBlank = (v: unknown): boolean => v === null || v === undefined || String(v).trim().length === 0;
      const bad = data.rows.filter((r) => !isBlank(r['votes']) && numericValue(r['votes']) === null).length;
      if (bad) problems.push(t('editor.data.pollGuideNotNumber', { count: bad }));
    }
  }
  const csv = [POLL_FEED_COLUMNS.map((c) => c.key).join(','), POLL_FEED_COLUMNS.map((c) => c.example).join(',')].join('\n');
  return (
    <details className="poll-guide">
      <summary>{t('editor.data.pollGuide')}</summary>
      <p className="hint">{t('editor.data.pollGuideHint')}</p>
      <table>
        <thead>
          <tr>
            <th>{t('editor.data.pollGuideColumn')}</th>
            <th>{t('editor.data.pollGuideType')}</th>
            <th>{t('editor.data.pollGuideRequired')}</th>
            <th>{t('editor.data.pollGuideExample')}</th>
          </tr>
        </thead>
        <tbody>
          {POLL_FEED_COLUMNS.map((c) => (
            <tr key={c.key}>
              <td><code>{c.key}</code></td>
              <td>{c.type}</td>
              <td>{c.required ? t('editor.data.pollGuideYes') : ''}</td>
              <td><code>{c.example}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
      <a download="poll.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`}>{t('editor.data.pollGuideStarter')}</a>
      {data && problems.length === 0 && <p className="hint">{t('editor.data.pollGuideOk')}</p>}
      {problems.map((p) => <p key={p} className="source-error">{p}</p>)}
    </details>
  );
}
