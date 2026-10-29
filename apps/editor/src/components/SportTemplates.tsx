// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Sport templates in the data panel (Phase 9 Wave B, schema `sports.ts`).
 *
 *  - `SportTemplateCreator` — pick a sport and its rules, choose where the rows
 *    come from (typed in here, a Google Sheet, a published CSV, a JSON feed),
 *    and get the five tables made at once, shaped for the sport.
 *  - `SportGuide` — on a source made from a template: the table's format
 *    guide (every column, its type, whether a feed must have it, an example),
 *    a starter CSV or JSON to download, and a check of the rows the source
 *    actually returned against the template.
 */

import { useMemo, useState, type JSX } from 'react';
import {
  SPORT_GROUPS,
  SPORT_GROUP_LABEL_KEYS,
  SPORT_TABLES,
  SPORT_TABLE_LABEL_KEYS,
  SPORT_TEMPLATES,
  checkSportTable,
  sportCsv,
  sportDataColumns,
  sportJsonSample,
  sportRuleset,
  sportSeedRows,
  sportSourceId,
  sportTableColumns,
  sportTemplate,
  type DataSet,
  type DataSourceDef,
  type SportTable,
  type SportTemplateRef,
} from '@breeze/schema';
import { useT } from '@breeze/i18n/react';

import { api } from '../api/client.js';

/** Where a template's rows come from. */
export type SportFeed = 'manual' | 'sheets' | 'http-csv' | 'http-json';
const FEEDS: SportFeed[] = ['manual', 'sheets', 'http-csv', 'http-json'];
const FEED_LABEL_KEYS: Record<SportFeed, string> = {
  manual: 'editor.sports.feedManual',
  sheets: 'editor.sports.feedSheets',
  'http-csv': 'editor.sports.feedCsv',
  'http-json': 'editor.sports.feedJson',
};

const FEED_HINT_KEYS: Record<Exclude<SportFeed, 'manual'>, string> = {
  sheets: 'editor.sports.feedHint.sheets',
  'http-csv': 'editor.sports.feedHint.csv',
  'http-json': 'editor.sports.feedHint.json',
};

const PREFIX_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** `bball-teams.csv`. */
function fileFor(id: string, ext: 'csv' | 'json'): string {
  return [id, ext].join('.');
}

/** Hand the browser a file. */
function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Build one table's source definition. Exported for the tests. */
export function sportSourceDef(
  ref: SportTemplateRef,
  feed: SportFeed,
  id: string,
  name: string,
  where: string,
): DataSourceDef {
  const sport = sportTemplate(ref.sport)!;
  const ruleset = sportRuleset(sport, ref.ruleset);
  const columns = sportDataColumns(sport, ruleset, ref.table);
  const template = { ...ref };
  switch (feed) {
    case 'manual':
      return { id, name, type: 'manual', columns, rows: sportSeedRows(sport, ruleset, ref.table), template };
    case 'sheets':
      // One spreadsheet, a tab per table: `where` is the spreadsheet id, the range the tab.
      return { id, name, type: 'sheets', spreadsheet: where, range: ref.table, header: true, columns, template, pollInterval: 15, enabled: true };
    case 'http-csv':
      return { id, name, type: 'http-csv', url: where, header: true, columns, template, pollInterval: 15, enabled: true };
    case 'http-json':
      return { id, name, type: 'http-json', url: where, columns, template, pollInterval: 15, enabled: true };
  }
}

export function SportTemplateCreator({
  projectId,
  existingIds,
  onDone,
  onCancel,
}: {
  projectId: string;
  existingIds: ReadonlySet<string>;
  onDone: () => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useT();
  const [sportId, setSportId] = useState(SPORT_TEMPLATES[0]!.id);
  const sport = sportTemplate(sportId)!;
  const [rulesetId, setRulesetId] = useState(sport.rulesets[0]!.id);
  const ruleset = sportRuleset(sport, rulesetId);
  const [feed, setFeed] = useState<SportFeed>('manual');
  const [prefix, setPrefix] = useState(sport.prefix);
  const [tables, setTables] = useState<Set<SportTable>>(new Set(SPORT_TABLES));
  const [where, setWhere] = useState<Record<string, string>>({});
  const [spreadsheet, setSpreadsheet] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const chooseSport = (id: string): void => {
    const next = sportTemplate(id)!;
    setSportId(id);
    setRulesetId(next.rulesets[0]!.id);
    setPrefix(next.prefix);
  };

  const clashes = [...tables].map((table) => sportSourceId(prefix, table)).filter((id) => existingIds.has(id));
  const prefixOk = PREFIX_PATTERN.test(prefix);
  const sourceOf = (table: SportTable): string => (feed === 'sheets' ? spreadsheet.trim() : (where[table] ?? '').trim());
  // A fetched table with nowhere to fetch from is skipped, not saved blank.
  const creatable = [...tables].filter((table) => feed === 'manual' || sourceOf(table) !== '');

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      for (const table of SPORT_TABLES) {
        if (!creatable.includes(table)) continue;
        const name = t('editor.sports.sourceName', { sport: t(sport.labelKey), table: t(SPORT_TABLE_LABEL_KEYS[table]) });
        const def = sportSourceDef({ sport: sport.id, ruleset: ruleset.id, table }, feed, sportSourceId(prefix, table), name, sourceOf(table));
        await api.saveDataSource(projectId, def);
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="source-editor sport-creator">
      <h4>{t('editor.sports.title')}</h4>
      <label>
        <span>{t('editor.sports.sport')}</span>
        <select value={sportId} onChange={(e) => chooseSport(e.target.value)}>
          {SPORT_GROUPS.map((group) => (
            <optgroup key={group} label={t(SPORT_GROUP_LABEL_KEYS[group])}>
              {SPORT_TEMPLATES.filter((s) => s.group === group).map((s) => (
                <option key={s.id} value={s.id}>
                  {t(s.labelKey)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label>
        <span>{t('editor.sports.rules')}</span>
        <select value={ruleset.id} onChange={(e) => setRulesetId(e.target.value)}>
          {sport.rulesets.map((r) => (
            <option key={r.id} value={r.id}>
              {t(r.labelKey)}
            </option>
          ))}
        </select>
      </label>
      {ruleset.timers.length > 0 && (
        <p className="hint">
          {t('editor.sports.timers', { timers: ruleset.timers.map((timer) => t(timer.labelKey)).join(', ') })}
        </p>
      )}
      <label>
        <span>{t('editor.sports.feed')}</span>
        <select value={feed} onChange={(e) => setFeed(e.target.value as SportFeed)}>
          {FEEDS.map((f) => (
            <option key={f} value={f}>
              {t(FEED_LABEL_KEYS[f])}
            </option>
          ))}
        </select>
      </label>
      {feed === 'sheets' && (
        <label>
          <span>{t('editor.sports.spreadsheet')}</span>
          <input value={spreadsheet} placeholder="1AbC…" onChange={(e) => setSpreadsheet(e.target.value)} />
        </label>
      )}
      <label>
        <span>{t('editor.sports.prefix')}</span>
        <input value={prefix} onChange={(e) => setPrefix(e.target.value.trim().toLowerCase())} />
      </label>
      {!prefixOk && <div className="source-error">{t('editor.sports.prefixInvalid')}</div>}
      {clashes.length > 0 && <div className="source-error">{t('editor.sports.clash', { ids: clashes.join(', ') })}</div>}

      <table className="sport-tables">
        <tbody>
          {SPORT_TABLES.map((table) => {
            const columns = sportTableColumns(sport, ruleset, table);
            return (
              <tr key={table}>
                <td>
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={tables.has(table)}
                      onChange={(e) => {
                        const next = new Set(tables);
                        if (e.target.checked) next.add(table);
                        else next.delete(table);
                        setTables(next);
                      }}
                    />
                    <span>{t(SPORT_TABLE_LABEL_KEYS[table])}</span>
                  </label>
                </td>
                <td>
                  <code>{sportSourceId(prefix, table)}</code>
                </td>
                <td>{t('editor.sports.columnCount', { count: columns.length })}</td>
                <td>
                  {(feed === 'http-csv' || feed === 'http-json') && (
                    <input
                      value={where[table] ?? ''}
                      placeholder={t('editor.sports.urlPlaceholder')}
                      onChange={(e) => setWhere({ ...where, [table]: e.target.value })}
                    />
                  )}
                  {feed === 'sheets' && <span className="hint">{t('editor.sports.tab', { tab: table })}</span>}
                </td>
                <td>
                  <button
                    className="linkish"
                    onClick={() =>
                      feed === 'http-json'
                        ? download(fileFor(sportSourceId(prefix, table), 'json'), sportJsonSample(sport, ruleset, table), 'application/json')
                        : download(fileFor(sportSourceId(prefix, table), 'csv'), sportCsv(sport, ruleset, table), 'text/csv')
                    }
                  >
                    {t(feed === 'http-json' ? 'editor.sports.downloadJson' : 'editor.sports.downloadCsv')}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {feed !== 'manual' && <p className="hint">{t(FEED_HINT_KEYS[feed])}</p>}
      {error && <div className="source-error">{error}</div>}
      <div className="source-actions">
        <button
          className="primary"
          disabled={busy || !prefixOk || clashes.length > 0 || creatable.length === 0}
          onClick={() => void create()}
        >
          {t('editor.sports.create', { count: creatable.length })}
        </button>
        <button onClick={onCancel}>{t('editor.upload.cancel')}</button>
      </div>
    </div>
  );
}

/**
 * The format guide and the check, on a source made from a template.
 * `data` is what the source returned — its own rows for a manual table, the
 * preview's for a fetched one; absent until something has been fetched.
 */
export function SportGuide({ template, data }: { template: SportTemplateRef; data?: Pick<DataSet, 'columns' | 'rows'> }): JSX.Element | null {
  const t = useT();
  const [open, setOpen] = useState(false);
  const sport = sportTemplate(template.sport);
  const ruleset = sport ? sportRuleset(sport, template.ruleset) : undefined;
  const check = useMemo(
    () => (sport && ruleset && data ? checkSportTable(sport, ruleset, template.table, data) : null),
    [sport, ruleset, template.table, data],
  );
  if (!sport || !ruleset) return null;
  const columns = sportTableColumns(sport, ruleset, template.table);
  const file = `${sport.prefix}-${template.table}`;

  return (
    <div className="sport-guide" data-template={`${template.sport}/${template.ruleset}/${template.table}`}>
      <div className="sport-guide-head">
        <strong>
          {t('editor.sports.guideTitle', {
            sport: t(sport.labelKey),
            rules: t(ruleset.labelKey),
            table: t(SPORT_TABLE_LABEL_KEYS[template.table]),
          })}
        </strong>
        <button className="linkish" onClick={() => setOpen(!open)}>
          {t(open ? 'editor.sports.guideHide' : 'editor.sports.guideShow')}
        </button>
      </div>
      {check && (
        <div className={check.ok ? 'hint' : 'source-warning'} data-check={check.ok ? 'ok' : 'issues'}>
          {check.ok
            ? t('editor.sports.checkOk', { count: columns.filter((c) => c.required).length })
            : [
                check.missing.length ? t('editor.sports.checkMissing', { columns: check.missing.join(', ') }) : '',
                check.mistyped.length
                  ? t('editor.sports.checkMistyped', { cells: check.mistyped.map((m) => t('editor.sports.cell', { column: m.column, row: m.row, value: String(m.value) })).join(', ') })
                  : '',
                check.unexpected.length
                  ? t('editor.sports.checkUnexpected', { cells: check.unexpected.map((m) => t('editor.sports.cell', { column: m.column, row: m.row, value: String(m.value) })).join(', ') })
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
          {check.extra.length > 0 && <> {t('editor.sports.checkExtra', { columns: check.extra.join(', ') })}</>}
        </div>
      )}
      {open && (
        <>
          <p className="hint">{t('editor.sports.guideIntro')}</p>
          <table className="sport-guide-table">
            <thead>
              <tr>
                <th>{t('editor.sports.guideColumn')}</th>
                <th>{t('editor.sports.guideType')}</th>
                <th>{t('editor.sports.guideRequired')}</th>
                <th>{t('editor.sports.guideExample')}</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((c) => (
                <tr key={c.key}>
                  <td>
                    <code>{c.key}</code> {c.label}
                  </td>
                  <td>{c.type}</td>
                  <td>{c.required ? '✓' : ''}</td>
                  <td>{c.values ? c.values.filter(Boolean).join(' | ') : c.example !== undefined ? String(c.example) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="source-actions">
            <button onClick={() => download(fileFor(file, 'csv'), sportCsv(sport, ruleset, template.table), 'text/csv')}>
              {t('editor.sports.downloadCsv')}
            </button>
            <button onClick={() => download(fileFor(file, 'json'), sportJsonSample(sport, ruleset, template.table), 'application/json')}>
              {t('editor.sports.downloadJson')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
