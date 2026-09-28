// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Data sources panel.
 *
 * Two jobs, and the second is the one that matters at 19:55: build a source, and
 * tell an operator why a table is not updating. Per-source health — last fetch,
 * last change, last error — is on the row rather than behind a click, because a
 * dead feed should be diagnosed here and not by staring at a frozen graphic.
 */

import { Fragment, useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import {
  AIR_QUALITY_PROVIDERS,
  AIR_QUALITY_PROVIDER_INFO,
  CAP_SEVERITIES,
  DEFAULT_AIR_QUALITY_EXPIRY,
  DEFAULT_AIR_QUALITY_POLL_INTERVAL,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_WEATHER_POLL_INTERVAL,
  MAX_PLACES,
  MIN_POLL_INTERVAL,
  WEATHER_PROVIDERS,
  WEATHER_PROVIDER_INFO,
  applyTransforms,
  type DataGuard,
  MEDIA_CHECK_DEFAULTS,
  type MediaCheck,
  type MediaRowStatus,
  type MediaSummary,
  type FallbackTrigger,
  type GuardRange,
  type SourceUse,
  pollFloor,
  type AirQualityMode,
  type AirQualityProvider,
  type AqiScale,
  type CapSeverity,
  type CapTimeMode,
  type DataColumn,
  type DataRow,
  type DataSet,
  type DataSourceDef,
  type PlaceRef,
  type PlacesFrom,
  type WeatherMode,
  type WeatherProvider,
} from '@breeze/schema';
import { useRichT, useT, type Translate } from '@breeze/i18n/react';

import { api, type DataSourceSummary } from '../api/client.js';
import {
  carriedColumns,
  firstRound,
  isBracketTable,
  isFedCell,
  previewAdvance,
} from '../state/bracket.js';
import { parsePlaceLine, placeLine, type PlaceKind } from '../state/places.js';
import { useEditor } from '../state/store.js';

const TYPE_LABEL_KEY: Record<DataSourceDef['type'], string> = {
  manual: 'editor.data.typeManual',
  'http-json': 'editor.data.typeHttpJson',
  'http-csv': 'editor.data.typeHttpCsv',
  rss: 'editor.data.typeRss',
  xml: 'editor.data.typeXml',
  sheets: 'editor.data.typeSheets',
  weather: 'editor.data.typeWeather',
  ftp: 'editor.data.typeFtp',
  cap: 'editor.data.typeCap',
  'air-quality': 'editor.data.typeAirQuality',
};

/**
 * The add menu says more than the badge does.
 *
 * "HTTP CSV / Google Sheet" is a choice being explained; "HTTP CSV / Sheet" is
 * a label on a row that already exists. Two tables rather than one because the
 * shorter wording is only right once the operator has already chosen.
 */
const MENU: Array<{ type: DataSourceDef['type']; labelKey: string }> = [
  { type: 'manual', labelKey: 'editor.data.menuManual' },
  { type: 'http-csv', labelKey: 'editor.data.menuHttpCsv' },
  { type: 'http-json', labelKey: 'editor.data.menuHttpJson' },
  { type: 'rss', labelKey: 'editor.data.menuRss' },
  { type: 'xml', labelKey: 'editor.data.menuXml' },
  { type: 'sheets', labelKey: 'editor.data.menuSheets' },
  { type: 'weather', labelKey: 'editor.data.menuWeather' },
  { type: 'air-quality', labelKey: 'editor.data.menuAirQuality' },
  { type: 'cap', labelKey: 'editor.data.menuCap' },
  { type: 'ftp', labelKey: 'editor.data.menuFtp' },
];

/*
 * Frozen English, and not an oversight.
 *
 * These are not labels — they are the *value* a new source is created with.
 * `name` is persisted into the project and `columns[].label` renders on air
 * through a table layer, so both are operator data under I18N.md §1.3, the same
 * call already made for `WEATHER_COLUMNS`. Translating them would mean a
 * project built in one locale and opened in another silently disagrees with
 * itself about what a column is called, and a graphic changing wording because
 * somebody changed BREEZE_LOCALE.
 */
const NEW_NAME: Record<DataSourceDef['type'], string> = {
  manual: 'New table',  // i18n-ignore
  'http-json': 'New feed',  // i18n-ignore
  'http-csv': 'New sheet',  // i18n-ignore
  rss: 'New headline feed',  // i18n-ignore
  xml: 'New XML feed',  // i18n-ignore
  sheets: 'New private sheet',  // i18n-ignore
  weather: 'New weather',  // i18n-ignore
  ftp: 'New file drop',  // i18n-ignore
  cap: 'New alerts',  // i18n-ignore
  'air-quality': 'New air quality',  // i18n-ignore
};

/** RSS feeds change on a slower clock than a scoreboard; don't poll them like one. */
const RSS_POLL_INTERVAL = 300;

function blankSource(type: DataSourceDef['type'], id: string): DataSourceDef {
  if (type === 'manual') {
    return {
      id,
      name: NEW_NAME.manual,
      type: 'manual',
      columns: [
        // Starter DataSet content, frozen with NEW_NAME above.
        { key: 'team', label: 'Team', type: 'string' },
        { key: 'w', label: 'W', type: 'number' },
        { key: 'l', label: 'L', type: 'number' },
      ],
      rows: [{ team: '', w: 0, l: 0 }],
    };
  }

  if (type === 'sheets') {
    return {
      id,
      name: NEW_NAME.sheets,
      type: 'sheets',
      spreadsheet: '',
      range: '',
      pollInterval: DEFAULT_POLL_INTERVAL,
      enabled: true,
    };
  }

  if (type === 'weather') {
    return {
      id,
      name: NEW_NAME.weather,
      type: 'weather',
      // NWS is the default because it is the only one of the three with no
      // license condition to accept and no base URL to configure — a new source
      // works before the operator has read anything.
      provider: 'nws',
      latitude: 0,
      longitude: 0,
      units: 'imperial',
      mode: 'current',
      count: 5,
      // New sources pair NWS day and night into one row per date, the way
      // every other provider's daily mode reads. Existing sources keep what
      // they were built on — see `pairDayNight` in the schema.
      pairDayNight: true,
      pollInterval: DEFAULT_WEATHER_POLL_INTERVAL,
      enabled: true,
    };
  }

  if (type === 'air-quality') {
    return {
      id,
      name: NEW_NAME['air-quality'],
      type: 'air-quality',
      // AirNow's feeds need no key and carry the reporting agency's own
      // numbers; CAMS is the choice outside the US.
      provider: 'airnow-feed',
      area: '',
      mode: 'current',
      count: 3,
      // Written into the def rather than left to the server default, so the
      // operator sees the limit they are working under.
      expireAfter: DEFAULT_AIR_QUALITY_EXPIRY,
      pollInterval: DEFAULT_AIR_QUALITY_POLL_INTERVAL,
      enabled: true,
    };
  }

  if (type === 'cap') {
    return {
      id,
      name: NEW_NAME.cap,
      type: 'cap',
      url: '',
      times: 'exact',
      pollInterval: 60,
      enabled: true,
    };
  }

  if (type === 'ftp') {
    return {
      id,
      name: NEW_NAME.ftp,
      type: 'ftp',
      protocol: 'sftp',
      host: '',
      path: '',
      pattern: '*.csv',
      format: 'csv',
      header: true,
      pollInterval: 60,
      enabled: true,
    };
  }

  return {
    id,
    name: NEW_NAME[type],
    type,
    url: '',
    pollInterval: type === 'rss' ? RSS_POLL_INTERVAL : DEFAULT_POLL_INTERVAL,
    enabled: true,
  } as DataSourceDef;
}

/** Types that address an origin by URL — mirrors the schema's `isUrlSource`. */
function hasUrl(def: DataSourceDef): def is Extract<DataSourceDef, { url: string }> {
  return (
    def.type === 'http-json' ||
    def.type === 'http-csv' ||
    def.type === 'rss' ||
    def.type === 'xml' ||
    def.type === 'cap'
  );
}

/**
 * The columns an RSS/Atom feed always normalizes to, and the ones every weather
 * provider does. Frozen identifiers — an operator binds a layer to them.
 */
const RSS_COLUMNS = [
  'title', 'link', 'date', 'description', 'author', 'category', 'image', 'guid',
] as const;
const WEATHER_COLUMN_NAMES = [
  'place', 'temp', 'tempMin', 'tempMax', 'condition', 'icon', 'windSpeed', 'windDir', 'precipProb',
] as const;
const CAP_COLUMN_NAMES = [
  'event', 'headline', 'severity', 'areaDesc', 'onset', 'expires', 'instruction', 'active',
] as const;
const AIR_QUALITY_COLUMN_NAMES = [
  'place', 'aqi', 'category', 'color', 'pollutant', 'preliminary', 'attribution',
] as const;

/**
 * A list of column names inside a sentence, as one parameter rather than nine.
 *
 * Both hints below name the fixed columns their adapter produces. Passing each
 * as its own rich parameter would put nine `{temp}`-shaped holes in one message
 * and invite exactly the reordering that breaks it — and the names are frozen
 * identifiers a translator must not touch anyway. One `{columns}` keeps the
 * sentence translatable and the list intact.
 */
function ColumnNames({ names }: { names: readonly string[] }): JSX.Element {
  return (
    <>
      {names.map((name, i) => (
        <Fragment key={name}>
          {i > 0 && ', '}
          <code>{name}</code>
        </Fragment>
      ))}
    </>
  );
}

/** A preview cell. `null` and `undefined` both render empty, never "null". */
function cellText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/** "4s ago", "2m ago" — relative because absolute timestamps need arithmetic. */
function ago(iso: string | undefined, t: Translate): string {
  if (!iso) return t('editor.data.agoNever');
  const delta = Math.max(0, Date.now() - Date.parse(iso));
  const s = Math.round(delta / 1000);
  if (s < 60) return t('editor.data.agoSeconds', { seconds: s });
  const m = Math.round(s / 60);
  if (m < 60) return t('editor.data.agoMinutes', { minutes: m });
  return t('editor.data.agoHours', { hours: Math.round(m / 60) });
}

export function DataPanel(): JSX.Element {
  const t = useT();
  const rt = useRichT();
  const projectId = useEditor((s) => s.projectId);
  const [sources, setSources] = useState<DataSourceSummary[]>([]);
  const [editing, setEditing] = useState<DataSourceDef | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const refreshStore = useEditor((s) => s.refreshDataSources);

  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      /*
       * One request, via the store.
       *
       * This panel and the store used to fetch the list separately every five
       * seconds — twice the traffic, and two snapshots that could disagree, so
       * the health row could say a source had changed while the stage was still
       * previewing the rows from the previous poll. The store owns the fetch
       * because it also feeds the preview; the summaries come back for the
       * health rows below.
       */
      setSources(await refreshStore());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId, refreshStore]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /*
   * Poll the health view while the panel is open.
   *
   * The rows show *when* things last happened, so a static render is wrong
   * within seconds — and "last fetch: 4s ago" frozen at 4s is worse than no
   * readout, because it looks like a live feed. Stops when collapsed; this is a
   * diagnostic surface, not something to spend requests on in the background.
   */
  useEffect(() => {
    if (collapsed || !projectId) return;
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [collapsed, projectId, reload]);

  if (!projectId) return <div className="panel-empty">—</div>;

  const add = (type: DataSourceDef['type']) => {
    const id = `src${Date.now().toString(36)}`;
    setEditing(blankSource(type, id));
  };

  const save = async (def: DataSourceDef) => {
    try {
      await api.saveDataSource(projectId, withoutBlankChecks(def));
      setEditing(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    /*
      `data-collapsed` drives the layout, not just the caret.

      The panel is the second child of a column flexbox and `.panel` sets
      `height: 100%`, which becomes its flex-basis — so collapsed or not it
      reserved the same 55% of the left column, and folding it away bought the
      layer list nothing. The attribute lets the stylesheet drop it to its
      header height and sit it on the bottom edge.

      It means "this panel is currently nothing but its header", which is not
      quite the same as `collapsed`: the source editor deliberately stays open
      across a collapse so an in-progress edit is not lost, and a form allowed to
      size to its own content in a column with no height cap would push the layer
      list out entirely. While one is open the panel keeps its bounded height.
    */
    <div
      className="panel data-panel"
      data-collapsed={collapsed && !editing ? '1' : undefined}
    >
      <div className="panel-header">
        <button className="panel-toggle" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? '▸' : '▾'} {t('editor.data.title')}
        </button>
        <span className="panel-actions">
          {/*
            `add-source`, not `add-layer`. Reusing the layers panel's class put
            two `select.add-layer` in the same column, which is one element too
            many for every selector — in the editor's own e2e suite it turned a
            dozen unrelated drag tests red at once.
          */}
          <select
            className="add-source"
            value=""
            onChange={(e) => {
              if (e.target.value) add(e.target.value as DataSourceDef['type']);
              e.target.value = '';
            }}
          >
            <option value="">{t('editor.layers.add')}</option>
            {MENU.map((m) => (
              <option key={m.type} value={m.type}>{t(m.labelKey)}</option>
            ))}
          </select>
        </span>
      </div>

      {error && <div className="panel-error">{error}</div>}

      {!collapsed && (
        <div className="source-list">
          {sources.length === 0 && (
            <p className="hint">
              {rt('editor.data.emptyHint', {
                httpCsv: <em>{t('editor.data.typeHttpCsvShort')}</em>,
                // Google Sheets' own menu path, quoted so it can be followed.
                // i18n-ignore-next-line
                publish: <code>Publish to web → CSV</code>,
              })}
            </p>
          )}

          {sources.map(({ def, status, interval, rowCount }) => {
            const failing = (status.failures ?? 0) > 0;
            const nameOf = (id: string) => sources.find((s) => s.def.id === id)?.def.name ?? id;
            return (
              <div key={def.id} className={`source-row${failing ? ' failing' : ''}`}>
                <div className="source-head">
                  <span className="source-name">{def.name}</span>
                  <code className="source-id">{def.id}</code>
                  <span className="source-type">{t(TYPE_LABEL_KEY[def.type])}</span>
                </div>
                <div className="source-meta">
                  <span>{t('editor.data.rowCount', { count: rowCount })}</span>
                  {def.type !== 'manual' && (
                    <span>{t('editor.data.everySeconds', { seconds: interval })}</span>
                  )}
                  <span title={status.lastFetch}>
                    {t('editor.data.fetchedAgo', { when: ago(status.lastFetch, t) })}
                  </span>
                  <span title={status.lastChange}>
                    {t('editor.data.changedAgo', { when: ago(status.lastChange, t) })}
                  </span>
                  <span>{t('editor.data.revision', { revision: status.revision })}</span>
                </div>
                {status.lastError && <div className="source-error">{status.lastError}</div>}
                {/* A partial success: working, with named places on last-good rows. */}
                {status.warning && <div className="source-warning">{status.warning}</div>}
                {status.expired && <div className="source-error">{t('editor.data.expired')}</div>}
                {status.stuck && <div className="source-error">{t('editor.data.guard.stuck')}</div>}
                {status.serving !== undefined && (
                  <div className="source-warning">
                    {t('editor.data.guard.serving', { name: nameOf(status.serving) })}
                  </div>
                )}
                {status.media && def.media && (
                  <MediaStatusLine
                    projectId={projectId}
                    sourceId={def.id}
                    summary={status.media}
                    onChecked={reload}
                  />
                )}
                <div className="source-actions">
                  {def.fallback !== undefined && (
                    <select
                      className="source-use"
                      value={status.use ?? 'auto'}
                      title={t('editor.data.guard.useTitle')}
                      onChange={(e) =>
                        void api
                          .setDataSourceUse(projectId, def.id, e.target.value as SourceUse)
                          .then(reload)
                          .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                      }
                    >
                      <option value="auto">{t('editor.data.guard.useAuto')}</option>
                      <option value="primary">{t('editor.data.guard.usePrimary')}</option>
                      <option value="backup">{t('editor.data.guard.useBackup')}</option>
                    </select>
                  )}
                  <button onClick={() => setEditing(def)}>{t('editor.data.edit')}</button>
                  {def.type !== 'manual' && (
                    <button onClick={() => void api.refreshDataSource(projectId, def.id).then(reload)}>
                      {t('editor.data.refresh')}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (!confirm(t('editor.data.deleteConfirm', { name: def.name }))) return;
                      void api.deleteDataSource(projectId, def.id).then(reload);
                    }}
                  >
                    {t('editor.bin.delete')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <SourceEditor
          projectId={projectId}
          others={sources.map((s) => s.def).filter((d) => d.id !== editing.id)}
          def={editing}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSave={() => void save(editing)}
        />
      )}
    </div>
  );
}

const URL_PLACEHOLDER: Record<string, string> = {
  'http-csv': 'https://docs.google.com/spreadsheets/d/…/pub?output=csv',
  'http-json': 'https://example.com/api/standings.json',
  rss: 'https://example.com/sport/rss',
  xml: 'https://example.com/exports/results.xml',
  cap: 'https://api.weather.gov/alerts/active?area=AZ',
};

/* ------------------------------------------------------------------ editor */

interface SourceEditorProps {
  projectId: string;
  /** The project's other sources — candidates for a table of places. */
  others: DataSourceDef[];
  def: DataSourceDef;
  onChange: (def: DataSourceDef) => void;
  onCancel: () => void;
  onSave: () => void;
}

function SourceEditor({ projectId, others, def, onChange, onCancel, onSave }: SourceEditorProps): JSX.Element {
  const t = useT();
  const rt = useRichT();
  const [preview, setPreview] = useState<
    {
      ok: boolean;
      error?: string;
      warning?: string;
      refused?: string;
      dropped?: number;
      data?: DataSet;
      rowCount?: number;
    } | null
  >(null);
  const [busy, setBusy] = useState(false);

  const runPreview = async () => {
    setBusy(true);
    try {
      setPreview(await api.previewDataSource(projectId, def));
    } finally {
      setBusy(false);
    }
  };

  /*
   * Preview readiness is per-type, not "has a URL".
   *
   * The original `!def.url` guard was already wrong for Sheets, which addresses
   * a spreadsheet id; weather and FTP make three. A weather source is checkable
   * as soon as it has a provider (0,0 is a valid point — it is in the Atlantic,
   * and Open-Meteo will happily forecast it), so the only real gate is the base
   * URL a self-hosted instance needs.
   */
  const canPreview =
    def.type === 'sheets' ? Boolean(def.spreadsheet)
    : def.type === 'weather' ? !WEATHER_PROVIDER_INFO[def.provider]?.needsBaseUrl || Boolean(def.baseUrl)
    : def.type === 'air-quality' ? !AIR_QUALITY_PROVIDER_INFO[def.provider]?.needsBaseUrl || Boolean(def.baseUrl)
    : def.type === 'ftp' ? Boolean(def.host && def.pattern)
    : hasUrl(def) && !!def.url;

  // Weather is rate-floored by its provider's license rather than by this
  // server's scheduler, so the number the field enforces has to follow suit.
  const minInterval = def.type === 'manual' ? MIN_POLL_INTERVAL : pollFloor(def);

  return (
    <div className="source-editor">
      <label>
        <span>{t('editor.data.fieldName')}</span>
        <input value={def.name} onChange={(e) => onChange({ ...def, name: e.target.value })} />
      </label>

      {def.type === 'manual' ? (
        <ManualTableEditor def={def} onChange={onChange} />
      ) : (
        <>
          {def.type === 'weather' ? (
            <WeatherFields def={def} others={others} onChange={onChange} />
          ) : def.type === 'air-quality' ? (
            <AirQualityFields def={def} others={others} onChange={onChange} />
          ) : def.type === 'ftp' ? (
            <FtpFields def={def} onChange={onChange} />
          ) : def.type === 'sheets' ? (
            <SheetsFields def={def} onChange={onChange} />
          ) : (
            <label>
              <span>{t('editor.data.fieldUrl')}</span>
              <input
                value={def.url}
                placeholder={URL_PLACEHOLDER[def.type]}
                onChange={(e) => onChange({ ...def, url: e.target.value })}
              />
            </label>
          )}

          {def.type === 'rss' && (
            <p className="hint">
              {rt('editor.data.rssColumnsHint', {
                columns: <ColumnNames names={RSS_COLUMNS} />,
                title: <code>title</code>,
              })}
            </p>
          )}

          {def.type === 'xml' && (
            <XmlRowPathField projectId={projectId} def={def} onChange={onChange} busy={busy} />
          )}

          {def.type === 'cap' && <CapFields def={def} onChange={onChange} />}

          {def.type === 'http-json' && (
            <label>
              <span>
                {t('editor.data.rowPath')}{' '}
                <button
                  className="linkish"
                  disabled={!def.url || busy}
                  onClick={async () => {
                    const result = await api.inspectJsonFeed(projectId, def.url);
                    if (result.ok && result.rowPath !== undefined) {
                      onChange({ ...def, rowPath: result.rowPath });
                    }
                  }}
                >
                  {t('editor.data.findIt')}
                </button>
              </span>
              <input
                value={def.rowPath ?? ''}
                placeholder={t('editor.data.rowPathJsonPlaceholder')}
                onChange={(e) => onChange({ ...def, rowPath: e.target.value })}
              />
            </label>
          )}

          {(def.type === 'http-csv' || def.type === 'sheets') && (
            <label className="inline">
              <input
                type="checkbox"
                checked={def.header !== false}
                onChange={(e) => onChange({ ...def, header: e.target.checked })}
              />
              <span>{t('editor.data.headerRow')}</span>
            </label>
          )}

          <label>
            <span>{t('editor.data.pollInterval', { min: minInterval })}</span>
            <input
              type="number"
              min={minInterval}
              value={
                def.pollInterval ??
                (def.type === 'weather' ? DEFAULT_WEATHER_POLL_INTERVAL
                  : def.type === 'air-quality' ? DEFAULT_AIR_QUALITY_POLL_INTERVAL
                  : DEFAULT_POLL_INTERVAL)
              }
              onChange={(e) => onChange({ ...def, pollInterval: Number(e.target.value) })}
            />
          </label>

          {/* Weather and air quality carry no operator credential — the
              providers wired here are keyless, and the field would be a box with
              nothing to put in it. */}
          {def.type !== 'weather' && def.type !== 'air-quality' && (
            <label>
              <span>
                {t(
                  def.type === 'sheets' ? 'editor.data.credentialSheets'
                  : def.type === 'ftp' ? 'editor.data.credentialFtp'
                  : 'editor.data.credentialOther',
                )}
              </span>
              <input
                value={def.secretId ?? ''}
                placeholder={t(
                  def.type === 'sheets' ? 'editor.data.credentialSheetsPlaceholder'
                  : def.type === 'ftp' ? 'editor.data.credentialFtpPlaceholder'
                  : 'editor.data.credentialOtherPlaceholder',
                )}
                onChange={(e) => onChange({ ...def, secretId: e.target.value })}
              />
            </label>
          )}

          <GuardFields key={def.id} def={def} others={others} onChange={onChange} />

          <div className="source-actions">
            <button onClick={() => void runPreview()} disabled={!canPreview || busy}>
              {t(busy ? 'editor.data.fetching' : 'editor.data.preview')}
            </button>
          </div>

          {preview && !preview.ok && <div className="source-error">{preview.error}</div>}
          {preview?.ok && preview.warning && <div className="source-warning">{preview.warning}</div>}
          {preview?.ok && preview.refused && (
            <div className="source-error">{t('editor.data.guard.previewRefused', { reason: preview.refused })}</div>
          )}
          {preview?.ok && preview.dropped !== undefined && preview.dropped > 0 && (
            <div className="source-warning">{t('editor.data.guard.previewDropped', { count: preview.dropped })}</div>
          )}
          {preview?.ok && preview.data && (
            <DataPreview data={preview.data} total={preview.rowCount ?? preview.data.rows.length} />
          )}
        </>
      )}

      {/* Any source can be a camera list — a manual table most of all. */}
      <MediaFields def={def} onChange={onChange} />

      <div className="source-actions">
        <button className="primary" onClick={onSave}>{t('editor.data.saveSource')}</button>
        <button onClick={onCancel}>{t('editor.upload.cancel')}</button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- media */

/**
 * A camera list's health in the source list (Wave 8): the counts, a button to
 * check every camera now, and — opened on demand — the ones that are not ok
 * and why.
 */
function MediaStatusLine({
  projectId,
  sourceId,
  summary,
  onChecked,
}: {
  projectId: string;
  sourceId: string;
  summary: MediaSummary;
  onChecked: () => void;
}): JSX.Element {
  const t = useT();
  const [rows, setRows] = useState<MediaRowStatus[] | null>(null);
  const [busy, setBusy] = useState(false);
  const bad = summary.failed + summary.frozen;
  const load = () => void api.dataSourceMedia(projectId, sourceId).then((r) => setRows(r.rows)).catch(() => setRows([]));
  const check = () => {
    setBusy(true);
    void api
      .checkDataSourceMedia(projectId, sourceId)
      .then((r) => {
        setRows(r.rows);
        onChecked();
        // A long round answers before it is done; read again once it should be.
        if (r.done === false) setTimeout(() => {
          load();
          onChecked();
        }, 5000);
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  const problems = (rows ?? []).filter((r) => r.state === 'failed' || r.state === 'frozen');
  // Opened once, kept current: a new round of checks reloads the detail under the counts.
  useEffect(() => {
    if (rows !== null) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.checkedAt]);
  return (
    <details className={`source-media${bad ? ' failing' : ''}`} onToggle={(e) => (e.currentTarget.open && rows === null ? load() : undefined)}>
      <summary>
        {t('editor.data.media.summary', {
          ok: summary.ok,
          failed: summary.failed,
          frozen: summary.frozen,
          unchecked: summary.unchecked,
        })}
      </summary>
      <div className="source-actions">
        <button onClick={check} disabled={busy}>
          {t(busy ? 'editor.data.media.checking' : 'editor.data.media.checkNow')}
        </button>
      </div>
      {rows !== null && problems.length === 0 && <p className="hint">{t('editor.data.media.allOk')}</p>}
      {problems.map((r) => (
        <div key={r.key} className="source-error" title={r.url}>
          <code>{r.url}</code> — {t(r.state === 'frozen' ? 'editor.data.media.stateFrozen' : 'editor.data.media.stateFailed')}
          {r.error ? `: ${r.error}` : ''}
        </div>
      ))}
    </details>
  );
}

/**
 * Media checks on a source (Wave 8): which column holds each camera's URL,
 * and how the server watches them. Folded away until switched on.
 */
function MediaFields({
  def,
  onChange,
}: {
  def: DataSourceDef;
  onChange: (def: DataSourceDef) => void;
}): JSX.Element {
  const t = useT();
  const media = def.media;
  const declared = 'columns' in def && Array.isArray(def.columns) ? def.columns.map((c) => c.key) : [];
  const setMedia = (patch: Partial<MediaCheck> | null) => {
    const next = { ...def };
    if (patch === null) delete next.media;
    else {
      const merged: Record<string, unknown> = { ...(media ?? { column: '' }), ...patch };
      for (const [k, v] of Object.entries(merged)) if (v === undefined || v === '') delete merged[k];
      next.media = merged as unknown as MediaCheck;
    }
    onChange(next);
  };
  const guessColumn = (): string =>
    declared.find((k) => /url|src|link|camera|stream/i.test(k)) ?? declared[0] ?? 'url';

  // A column is picked from the source's own list where it declares one, typed otherwise.
  const columnInput = (value: string | undefined, onPick: (v: string | undefined) => void, optional: boolean) =>
    declared.length ? (
      <select value={value ?? ''} onChange={(e) => onPick(e.target.value || undefined)}>
        {optional && <option value="">{t('editor.data.media.kindAuto')}</option>}
        {declared.map((k) => <option key={k} value={k}>{k}</option>)}
        {value && !declared.includes(value) && <option value={value}>{value}</option>}
      </select>
    ) : (
      <input
        defaultValue={value ?? ''}
        placeholder={optional ? t('editor.data.media.kindAuto') : 'url'}
        onBlur={(e) => onPick(e.target.value.trim() || undefined)}
      />
    );

  return (
    <details className="source-guard" open={Boolean(media)}>
      <summary>{t('editor.data.media.title')}</summary>
      <p className="hint">{t('editor.data.media.hint')}</p>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={Boolean(media)}
          onChange={(e) => setMedia(e.target.checked ? { column: guessColumn() } : null)}
        />
        <span>{t('editor.data.media.enable')}</span>
      </label>
      {media && (
        <>
          <div className="field-row">
            <label>
              <span>{t('editor.data.media.column')}</span>
              {columnInput(media.column, (v) => setMedia({ column: v ?? guessColumn() }), false)}
            </label>
            <label>
              <span>{t('editor.data.media.kindColumn')}</span>
              {columnInput(media.kindColumn, (v) => setMedia({ kindColumn: v }), true)}
            </label>
          </div>
          <div className="field-row">
            <label>
              <span>{t('editor.data.media.every')}</span>
              <input
                type="number"
                min={MEDIA_CHECK_DEFAULTS.minEvery}
                value={media.every ?? ''}
                placeholder={String(MEDIA_CHECK_DEFAULTS.every)}
                onChange={(e) => setMedia({ every: optionalNumber(e.target.value) })}
                // Raised to the floor once typed, not per keystroke — "30" starts as "3".
                onBlur={() => {
                  if (media.every !== undefined && media.every < MEDIA_CHECK_DEFAULTS.minEvery) {
                    setMedia({ every: MEDIA_CHECK_DEFAULTS.minEvery });
                  }
                }}
              />
            </label>
            <label>
              <span>{t('editor.data.media.frozenAfter')}</span>
              <input
                type="number"
                min={0}
                value={media.frozenAfter ?? ''}
                placeholder={String(MEDIA_CHECK_DEFAULTS.frozenAfter)}
                title={t('editor.data.media.frozenAfterTitle')}
                onChange={(e) => {
                  const n = optionalNumber(e.target.value);
                  setMedia({ frozenAfter: n === undefined ? undefined : Math.max(0, n) });
                }}
              />
            </label>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={media.proxy !== false}
              onChange={(e) => setMedia({ proxy: e.target.checked ? undefined : false })}
            />
            <span>{t('editor.data.media.proxy')}</span>
          </label>
          <p className="hint">{t('editor.data.media.columnsHint')}</p>
        </>
      )}
    </details>
  );
}

/* ----------------------------------------------------------------- guard */

/**
 * A value check added and never given a column is dropped on save rather than
 * refused by the server; an emptied guard goes altogether.
 */
function withoutBlankChecks(def: DataSourceDef): DataSourceDef {
  if (def.type === 'manual' || !def.guard) return def;
  const guard: DataGuard = { ...def.guard };
  if (guard.ranges) {
    const ranges = guard.ranges.filter((r) => r.column.trim() !== '').map((r) => ({ ...r, column: r.column.trim() }));
    if (ranges.length) guard.ranges = ranges;
    else delete guard.ranges;
  }
  const next = { ...def };
  if (Object.keys(guard).length) next.guard = guard;
  else delete next.guard;
  return next;
}

/** Parse a number field; blank or junk is absent. */
function optionalNumber(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * When the data is bad (CYCLE.md, Wave 5): the guard a fetch must pass, how
 * long last-good may stay up, and the backup that takes over.
 *
 * Folded away unless something is set — most sources need none of it, and the
 * ones that do need it once, on the day the feed first misbehaves.
 */
function GuardFields({
  def,
  others,
  onChange,
}: {
  def: Exclude<DataSourceDef, { type: 'manual' }>;
  others: DataSourceDef[];
  onChange: (def: DataSourceDef) => void;
}): JSX.Element {
  const t = useT();
  const guard: DataGuard = def.guard ?? {};
  const [required, setRequired] = useState((guard.required ?? []).join(', '));

  const setGuard = (patch: Partial<DataGuard>) => {
    const merged: Record<string, unknown> = { ...guard, ...patch };
    for (const [k, v] of Object.entries(merged)) {
      if (v === undefined || (Array.isArray(v) && v.length === 0)) delete merged[k];
    }
    const next = { ...def };
    if (Object.keys(merged).length) next.guard = merged as DataGuard;
    else delete next.guard;
    onChange(next);
  };
  const ranges = guard.ranges ?? [];
  const setRange = (i: number, range: GuardRange | null) => {
    const list = [...ranges];
    if (range === null) list.splice(i, 1);
    else list[i] = range;
    setGuard({ ranges: list });
  };
  const setBackup = (id: string) => {
    const next = { ...def };
    if (id) next.fallback = id;
    else {
      delete next.fallback;
      delete next.fallbackOn;
    }
    onChange(next);
  };

  const ownExpiry = def.type !== 'air-quality';
  const hours = def.expireAfter !== undefined ? def.expireAfter / 3600 : '';
  const open = Boolean(def.guard || def.fallback || (ownExpiry && def.expireAfter !== undefined));

  return (
    <details className="source-guard" open={open}>
      <summary>{t('editor.data.guard.title')}</summary>
      <p className="hint">{t('editor.data.guard.hint')}</p>

      <div className="field-row">
        <label>
          <span>{t('editor.data.guard.minRows')}</span>
          <input
            type="number"
            min={1}
            value={guard.minRows ?? ''}
            placeholder={t('editor.data.guard.off')}
            onChange={(e) => setGuard({ minRows: optionalNumber(e.target.value) })}
          />
        </label>
        <label>
          <span>{t('editor.data.guard.maxDrop')}</span>
          <input
            type="number"
            min={1}
            max={99}
            value={guard.maxDropPercent ?? ''}
            placeholder={t('editor.data.guard.off')}
            title={t('editor.data.guard.maxDropTitle')}
            onChange={(e) => setGuard({ maxDropPercent: optionalNumber(e.target.value) })}
          />
        </label>
      </div>

      <label>
        <span>{t('editor.data.guard.required')}</span>
        <input
          value={required}
          placeholder={t('editor.data.guard.requiredPlaceholder')}
          onChange={(e) => setRequired(e.target.value)}
          onBlur={() => setGuard({ required: required.split(',').map((c) => c.trim()).filter(Boolean) })}
        />
      </label>

      <div className="guard-ranges">
        <span className="guard-label">{t('editor.data.guard.ranges')}</span>
        {ranges.map((range, i) => (
          <div key={i} className="field-row">
            <label>
              <span>{t('editor.data.guard.rangeColumn')}</span>
              <input
                value={range.column}
                onChange={(e) => setRange(i, { ...range, column: e.target.value })}
                onBlur={() => setRange(i, { ...range, column: range.column.trim() })}
              />
            </label>
            <label>
              <span>{t('editor.data.guard.rangeMin')}</span>
              <input
                type="number"
                value={range.min ?? ''}
                onChange={(e) => {
                  const { min: _min, ...rest } = range;
                  const min = optionalNumber(e.target.value);
                  setRange(i, min === undefined ? rest : { ...rest, min });
                }}
              />
            </label>
            <label>
              <span>{t('editor.data.guard.rangeMax')}</span>
              <input
                type="number"
                value={range.max ?? ''}
                onChange={(e) => {
                  const { max: _max, ...rest } = range;
                  const max = optionalNumber(e.target.value);
                  setRange(i, max === undefined ? rest : { ...rest, max });
                }}
              />
            </label>
            <button className="guard-del" title={t('editor.data.guard.removeRange')} onClick={() => setRange(i, null)}>×</button>
          </div>
        ))}
        <button className="linkish" onClick={() => setGuard({ ranges: [...ranges, { column: '' }] })}>
          {t('editor.data.guard.addRange')}
        </button>
      </div>

      {(guard.required?.length || ranges.length) ? (
        <label>
          <span>{t('editor.data.guard.badRows')}</span>
          <select
            value={guard.badRows ?? 'refuse'}
            onChange={(e) => setGuard({ badRows: e.target.value === 'drop' ? 'drop' : undefined })}
          >
            <option value="refuse">{t('editor.data.guard.badRowsRefuse')}</option>
            <option value="drop">{t('editor.data.guard.badRowsDrop')}</option>
          </select>
        </label>
      ) : null}

      <label>
        <span>{t('editor.data.guard.maxUnchanged')}</span>
        <input
          type="number"
          min={1}
          value={guard.maxUnchanged !== undefined ? guard.maxUnchanged / 60 : ''}
          placeholder={t('editor.data.guard.off')}
          title={t('editor.data.guard.maxUnchangedTitle')}
          onChange={(e) => {
            const minutes = optionalNumber(e.target.value);
            setGuard({ maxUnchanged: minutes === undefined ? undefined : Math.max(60, Math.round(minutes * 60)) });
          }}
        />
      </label>

      {ownExpiry && (
        <>
          <label>
            <span>{t('editor.data.expireAfter')}</span>
            <input
              type="number"
              min={0.25}
              step={0.25}
              value={hours}
              onChange={(e) => {
                const next = { ...def };
                if (e.target.value === '') delete next.expireAfter;
                else next.expireAfter = Math.max(60, Math.round(Number(e.target.value) * 3600));
                onChange(next);
              }}
            />
          </label>
          <p className="hint">{t('editor.data.expireAfterHint')}</p>
        </>
      )}

      <div className="field-row">
        <label>
          <span>{t('editor.data.guard.backup')}</span>
          <select value={def.fallback ?? ''} onChange={(e) => setBackup(e.target.value)}>
            <option value="">{t('editor.data.guard.noBackup')}</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </label>
        {def.fallback !== undefined && (
          <label>
            <span>{t('editor.data.guard.fallbackOn')}</span>
            <select
              value={def.fallbackOn ?? 'expired'}
              onChange={(e) => {
                const next = { ...def };
                if (e.target.value === 'failing') next.fallbackOn = e.target.value as FallbackTrigger;
                else delete next.fallbackOn;
                onChange(next);
              }}
            >
              <option value="expired">{t('editor.data.guard.fallbackOnExpired')}</option>
              <option value="failing">{t('editor.data.guard.fallbackOnFailing')}</option>
            </select>
          </label>
        )}
      </div>
      {def.fallback !== undefined && <p className="hint">{t('editor.data.guard.backupHint')}</p>}
    </details>
  );
}

function DataPreview({ data, total }: { data: DataSet; total: number }): JSX.Element {
  const t = useT();
  return (
    <div className="data-preview">
      <div className="hint">
        {t('editor.data.previewSummary', { rows: total, columns: data.columns.length })}
      </div>
      <table>
        <thead>
          <tr>
            {data.columns.map((c) => (
              <th key={c.key} title={t('editor.data.columnTitle', { key: c.key, type: c.type })}>
                {c.label ?? c.key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.slice(0, 8).map((row, i) => (
            <tr key={i}>
              {data.columns.map((c) => (
                <td key={c.key}>{cellText(row[c.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------- XML picker */

/**
 * Row-element path, with the candidates the server found.
 *
 * The JSON picker gets away with one suggested path because a REST payload
 * usually has one obvious array. An XML export usually does not —
 * `results/game`, `results/game/team` and `results/game/team/player` all repeat,
 * and which is "a row" depends on the graphic being built. So this offers the
 * list, with counts, and still lets the field be typed into directly.
 */
function XmlRowPathField({
  projectId,
  def,
  onChange,
  busy,
}: {
  projectId: string;
  def: Extract<DataSourceDef, { type: 'xml' }>;
  onChange: (def: DataSourceDef) => void;
  busy: boolean;
}): JSX.Element {
  const t = useT();
  const rt = useRichT();
  const [found, setFound] = useState<{
    candidates: Array<{ path: string; count: number }>;
    feed?: 'rss' | 'rdf' | 'atom' | null;
    error?: string;
  } | null>(null);

  const inspect = async () => {
    const result = await api.inspectXmlFeed(projectId, def.url);
    if (!result.ok) {
      setFound({ candidates: [], error: result.error ?? t('editor.data.xmlReadFailed') });
      return;
    }
    setFound({ candidates: result.candidates ?? [], feed: result.feed ?? null });
    if (result.rowPath) onChange({ ...def, rowPath: result.rowPath });
  };

  return (
    <>
      <label>
        <span>
          {t('editor.data.rowElement')}{' '}
          <button className="linkish" disabled={!def.url || busy} onClick={() => void inspect()}>
            {t('editor.data.findIt')}
          </button>
        </span>
        <input
          value={def.rowPath ?? ''}
          placeholder={t('editor.data.rowPathXmlPlaceholder')}
          onChange={(e) => onChange({ ...def, rowPath: e.target.value })}
        />
      </label>

      {found?.error && <div className="source-error">{found.error}</div>}

      {found?.feed && (
        <p className="hint">
          {rt('editor.data.xmlFeedHint', {
            feed: found.feed,
            rssType: <strong>{t('editor.data.typeRss')}</strong>,
          })}
        </p>
      )}

      {found && found.candidates.length > 0 && (
        <div className="xml-candidates">
          {found.candidates.map((c) => (
            <button
              key={c.path}
              className={`chip${c.path === def.rowPath ? ' selected' : ''}`}
              onClick={() => onChange({ ...def, rowPath: c.path })}
              title={t('editor.data.xmlOccurrences', { count: c.count })}
            >
              {c.path} <span className="count">×{c.count}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------- weather */

/**
 * Provider, location, units.
 *
 * The license notice is not decoration. Open-Meteo's hosted API is free *for
 * non-commercial use only*, and a station running advertising is squarely on
 * the wrong side of that — a fact nobody discovers from a lat/lon field. It is
 * rendered as a blocking-looking warning rather than a hint for the same reason
 * the overflow flag is: the cost of missing it is paid on air, or in a letter.
 */
function WeatherFields({
  def,
  others,
  onChange,
}: {
  def: Extract<DataSourceDef, { type: 'weather' }>;
  others: DataSourceDef[];
  onChange: (def: DataSourceDef) => void;
}): JSX.Element {
  const t = useT();
  const rt = useRichT();
  const info = WEATHER_PROVIDER_INFO[def.provider];
  const nonCommercial = info?.commercialUse === 'non-commercial-only';
  const mode: WeatherMode = def.mode ?? 'current';
  const forecast = mode === 'hourly' || mode === 'daily';
  const single = !def.places && !def.placesFrom;

  return (
    <>
      <label>
        <span>{t('editor.data.weather.provider')}</span>
        <select
          value={def.provider}
          onChange={(e) => {
            const provider = e.target.value as WeatherProvider;
            const next = WEATHER_PROVIDER_INFO[provider];
            onChange({
              ...def,
              provider,
              // Switching away from the self-hosted provider must drop the base
              // URL, not keep it: the schema rejects a def that carries one for
              // a hosted provider, so leaving it would make the source
              // unsaveable with no visible field to explain why.
              ...(next?.needsBaseUrl ? {} : { baseUrl: undefined }),
              // The floor moves with the provider, and a 60s interval left over
              // from a self-hosted instance would be silently clamped to 900
              // against the hosted one. Better to show the number that will
              // actually be used.
              pollInterval: Math.max(
                next?.pollFloor ?? DEFAULT_WEATHER_POLL_INTERVAL,
                def.pollInterval ?? DEFAULT_WEATHER_POLL_INTERVAL,
              ),
              // Observed is NWS and Bright Sky only; the validator would
              // refuse it for the rest, so fall back rather than strand it.
              ...(next && !next.modes.includes(mode) ? { mode: 'current' as const } : {}),
            });
          }}
        >
          {WEATHER_PROVIDERS.map((id) => (
            <option key={id} value={id}>
              {t(WEATHER_PROVIDER_INFO[id].labelKey)}
            </option>
          ))}
        </select>
      </label>

      {info && (
        <p className="hint">
          {t('editor.data.weather.coverageHint', {
            coverage: t(info.coverageKey),
            seconds: info.pollFloor,
          })}
        </p>
      )}

      {nonCommercial && (
        <div className="source-error">
          {rt('editor.data.weather.nonCommercial', {
            lead: <strong>{t('editor.data.weather.nonCommercialLead')}</strong>,
            selfHosted: <em>{t('schema.weather.provider.open-meteo-self.label')}</em>,
            link: (
              <a href={info.licenseUrl} target="_blank" rel="noreferrer">
                {t('editor.data.weather.readLicense')}
              </a>
            ),
          })}
        </div>
      )}

      {info?.attribution && (
        <p className="hint">
          {rt('editor.data.weather.attribution', {
            lead: <strong>{t('editor.data.weather.attributionLead')}</strong>,
            credit: info.attribution,
            column: <code>attribution</code>,
            link: (
              <a href={info.licenseUrl} target="_blank" rel="noreferrer">
                {t('editor.data.weather.license')}
              </a>
            ),
          })}
        </p>
      )}

      {info?.needsBaseUrl && (
        <label>
          <span>{t('editor.data.weather.instanceUrl')}</span>
          <input
            value={def.baseUrl ?? ''}
            placeholder="http://localhost:8282"
            onChange={(e) => onChange({ ...def, baseUrl: e.target.value })}
          />
        </label>
      )}

      {info?.needsBaseUrl && (
        <p className="hint">
          {rt('editor.data.weather.allowHostsHint', {
            // i18n-ignore-next-line — an environment variable and its value
            env: <code>BREEZE_DATA_ALLOW_HOSTS=localhost</code>,
          })}
        </p>
      )}

      {info?.supportsModelSelection && (
        <div className="field-row">
          <label>
            <span>{t('editor.data.weather.model')}</span>
            <input
              value={def.models ?? ''}
              placeholder="ncep_gfs_seamless"
              onChange={(e) => onChange({ ...def, models: e.target.value })}
            />
          </label>
          <label>
            <span>{t('editor.data.weather.timezone')}</span>
            <input
              value={def.timezone ?? ''}
              placeholder="auto"
              onChange={(e) => onChange({ ...def, timezone: e.target.value })}
            />
          </label>
        </div>
      )}

      {/*
        Linking out rather than rebuilding their picker.
        Open-Meteo's own generator already answers "what is this model called",
        and it stays current as they add models — a dropdown here would go stale
        and still could not say which models a *self-hosted* box has synced,
        which is the question that actually bites. Deliberately not a geocoding
        or variable picker: the hosted geocoding service carries the same
        non-commercial restriction as the forecast API, and letting an operator
        choose variables would make the columns per-source and break the one
        property this adapter exists for — swap provider, keep the graphic.
      */}
      {info?.supportsModelSelection && (
        <p className="hint">
          {rt('editor.data.weather.modelDocsHint', {
            link: (
              <a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">
                {t('editor.data.weather.openMeteoDocs')}
              </a>
            ),
            param: <code>&amp;models=</code>,
          })}
        </p>
      )}

      {info?.needsBaseUrl && (
        <p className="hint">
          {rt('editor.data.weather.syncedModelsHint', {
            query: <code>?models=…</code>,
            fallback: <code>best_match</code>,
          })}
        </p>
      )}

      <label>
        <span>{t('editor.data.weather.contact')}</span>
        <input
          value={def.contact ?? ''}
          placeholder={t('editor.data.weather.contactPlaceholder')}
          onChange={(e) => onChange({ ...def, contact: e.target.value })}
        />
      </label>

      {/*
        Shown for the origins that *require* identification and block on it —
        NWS and MET Norway both say so in as many words. The risk is not that a
        blank field fails (Breeze always sends something) but that the something
        is shared by every install, so one careless deployment can get the
        string throttled for everyone on the default, with no way for the origin
        to warn any of them.

        Keyed on the provider's `needsContact` flag rather than on its id: a
        third origin with the same policy should not need this file edited.
      */}
      <p className="hint">
        {rt(
          info?.needsContact
            ? 'editor.data.weather.contactRequired'
            : 'editor.data.weather.contactOptional',
          { provider: info ? t(info.shortNameKey) : '', env: <code>BREEZE_CONTACT</code> },
        )}
      </p>

      <PlacesFields def={def} kind="coordinates" others={others} onChange={onChange} />

      <div className="field-row">
        <label>
          <span>{t('editor.data.weather.units')}</span>
          <select
            value={def.units ?? 'metric'}
            onChange={(e) => onChange({ ...def, units: e.target.value as 'metric' | 'imperial' })}
          >
            <option value="imperial">{t('editor.data.weather.unitsImperial')}</option>
            <option value="metric">{t('editor.data.weather.unitsMetric')}</option>
          </select>
        </label>
        <label>
          <span>{t('editor.data.weather.report')}</span>
          <select value={mode} onChange={(e) => onChange({ ...def, mode: e.target.value as WeatherMode })}>
            <option value="current">{t('editor.data.weather.modeCurrent')}</option>
            {info?.modes.includes('observed') && (
              <option value="observed">{t('editor.data.weather.modeObserved')}</option>
            )}
            <option value="hourly">{t('editor.data.weather.modeHourly')}</option>
            <option value="daily">{t('editor.data.weather.modeDaily')}</option>
          </select>
        </label>
      </div>

      {mode === 'observed' && (
        <p className="hint">
          {rt('editor.data.weather.observedHint', {
            age: <code>ageMinutes</code>,
            station: <code>station</code>,
          })}
        </p>
      )}

      {/* A pinned station, for one place; a list or table pins per place. */}
      {mode === 'observed' && def.provider === 'nws' && single && (
        <label>
          <span>{t('editor.data.weather.station')}</span>
          <input
            value={def.station ?? ''}
            placeholder="KPHX"
            onChange={(e) => {
              const station = e.target.value.trim().toUpperCase();
              const next = { ...def };
              if (station) next.station = station;
              else delete next.station;
              onChange(next);
            }}
          />
        </label>
      )}

      {forecast && (
        <label>
          <span>{t(single ? 'editor.data.weather.rows' : 'editor.data.weather.rowsPerPlace')}</span>
          <input
            type="number"
            min={1}
            max={240}
            value={def.count ?? 5}
            onChange={(e) => onChange({ ...def, count: Number(e.target.value) })}
          />
        </label>
      )}

      {mode === 'daily' && def.provider === 'nws' && (
        <label className="inline">
          <input
            type="checkbox"
            checked={def.pairDayNight === true}
            onChange={(e) => onChange({ ...def, pairDayNight: e.target.checked })}
          />
          <span>{t('editor.data.weather.pairDayNight')}</span>
        </label>
      )}

      {mode === 'daily' && (
        <label>
          <span>{t('editor.data.weather.startTomorrowAfter')}</span>
          <select
            value={def.startTomorrowAfter ?? ''}
            onChange={(e) => {
              const next = { ...def };
              if (e.target.value === '') delete next.startTomorrowAfter;
              else next.startTomorrowAfter = Number(e.target.value);
              onChange(next);
            }}
          >
            <option value="">{t('editor.data.weather.startTomorrowNever')}</option>
            {Array.from({ length: 23 }, (_, i) => i + 1).map((hour) => (
              <option key={hour} value={hour}>
                {t('editor.data.weather.startTomorrowHour', { hour: `${String(hour).padStart(2, '0')}:00` })}
              </option>
            ))}
          </select>
        </label>
      )}

      <p className="hint">
        {rt('editor.data.weather.columnsHint', {
          columns: <ColumnNames names={WEATHER_COLUMN_NAMES} />,
          icon: <code>icon</code>,
          example: <code>partly-cloudy</code>,
        })}
      </p>
    </>
  );
}

/* ---------------------------------------------------------------- places */

type Placed = Extract<DataSourceDef, { type: 'weather' | 'air-quality' }>;

/** Types whose rows can be a table of places — anything tabular that is not itself place-fed. */
const PLACE_TABLE_TYPES = new Set<DataSourceDef['type']>(['manual', 'sheets', 'http-csv', 'http-json', 'xml', 'ftp']);

/** Literal keys, so the catalogue check can find every one by reading the source. */
const PLACE_COLUMN_LABEL_KEY: Record<Exclude<keyof PlacesFrom, 'source'>, string> = {
  name: 'editor.data.places.columnName',
  key: 'editor.data.places.columnKey',
  latitude: 'editor.data.places.columnLatitude',
  longitude: 'editor.data.places.columnLongitude',
  area: 'editor.data.places.columnArea',
  station: 'editor.data.places.columnStation',
};

const SEVERITY_LABEL_KEY: Record<CapSeverity, string> = {
  Unknown: 'editor.data.cap.severityUnknown',
  Minor: 'editor.data.cap.severityMinor',
  Moderate: 'editor.data.cap.severityModerate',
  Severe: 'editor.data.cap.severitySevere',
  Extreme: 'editor.data.cap.severityExtreme',
};

/*
 * Example values for placeholders — data, not interface text: a place, a
 * station id, a zone name, the header aliases a table is read by. Frozen for
 * the same reason as NEW_NAME.
 */
const EXAMPLE = {
  placeLine: 'Phoenix, AZ, 33.4484, -112.0740, PHX, KPHX',  // i18n-ignore
  areaLine: 'Phoenix, AZ, 111, PHX',  // i18n-ignore
  capArea: 'Maricopa, Phoenix',  // i18n-ignore
  capCodes: '004013, AZZ537',  // i18n-ignore
  capEvents: 'Heat, Dust, Ozone',  // i18n-ignore
  zone: 'America/Phoenix',  // i18n-ignore
} as const;

const PLACE_COLUMN_ALIAS_TEXT: Record<Exclude<keyof PlacesFrom, 'source'>, string> = {
  name: 'name / place / city',  // i18n-ignore
  key: 'key / code / id',  // i18n-ignore
  latitude: 'latitude / lat',  // i18n-ignore
  longitude: 'longitude / lon / lng',  // i18n-ignore
  area: 'area / areaId',  // i18n-ignore
  station: 'station / icao',  // i18n-ignore
};

/**
 * Where a source reports on: one place, a typed list, or a table of places.
 *
 * The three are exclusive — the validator refuses a def carrying two — so
 * switching clears the others rather than leaving a hidden list behind the one
 * the operator can see.
 */
function PlacesFields({
  def,
  kind,
  others,
  onChange,
}: {
  def: Placed;
  kind: PlaceKind;
  others: DataSourceDef[];
  onChange: (def: DataSourceDef) => void;
}): JSX.Element {
  const t = useT();
  const rt = useRichT();
  const where = def.placesFrom ? 'table' : def.places ? 'list' : 'one';
  const tables = others.filter((o) => PLACE_TABLE_TYPES.has(o.type));
  const [text, setText] = useState(() => (def.places ?? []).map((p) => placeLine(p, kind)).join('\n'));

  const setWhere = (next: 'one' | 'list' | 'table') => {
    const base: Placed = { ...def };
    delete base.places;
    delete base.placesFrom;
    delete base.latitude;
    delete base.longitude;
    if (base.type === 'air-quality') delete base.area;
    if (next === 'one') {
      if (kind === 'area' && base.type === 'air-quality') base.area = '';
      else {
        base.latitude = 0;
        base.longitude = 0;
      }
    }
    if (next === 'list') {
      base.places = [];
      setText('');
    }
    if (next === 'table') base.placesFrom = { source: tables[0]?.id ?? '' };
    onChange(base);
  };

  const setFrom = (patch: Partial<PlacesFrom>) => {
    const merged: PlacesFrom = { ...(def.placesFrom ?? { source: '' }), ...patch };
    // Blank mapping fields fall back to the header aliases, so drop them
    // rather than save an empty string the schema would refuse.
    for (const key of Object.keys(merged) as Array<keyof PlacesFrom>) {
      if (key !== 'source' && !merged[key]) delete merged[key];
    }
    onChange({ ...def, placesFrom: merged });
  };

  const parsed = (def.places ?? []).length;
  const mappings: Array<Exclude<keyof PlacesFrom, 'source'>> = [
    'name',
    'key',
    ...(kind === 'area'
      ? (['area'] as const)
      : (['latitude', 'longitude', ...(def.type === 'weather' ? (['station'] as const) : [])] as const)),
  ];

  return (
    <>
      <label>
        <span>{t('editor.data.places.where')}</span>
        <select value={where} onChange={(e) => setWhere(e.target.value as 'one' | 'list' | 'table')}>
          <option value="one">{t('editor.data.places.one')}</option>
          <option value="list">{t('editor.data.places.list')}</option>
          <option value="table">{t('editor.data.places.table')}</option>
        </select>
      </label>

      {where === 'one' && (
        <>
          <label>
            <span>{t('editor.data.weather.place')}</span>
            <input
              value={def.place ?? ''}
              placeholder={t('editor.data.weather.placePlaceholder')}
              onChange={(e) => onChange({ ...def, place: e.target.value })}
            />
          </label>
          {kind === 'area' && def.type === 'air-quality' ? (
            <label>
              <span>{t('editor.data.airQuality.area')}</span>
              <input
                value={def.area ?? ''}
                placeholder="111"
                onChange={(e) => onChange({ ...def, area: e.target.value.trim() })}
              />
            </label>
          ) : (
            <div className="field-row">
              <label>
                <span>{t('editor.data.weather.latitude')}</span>
                <input
                  type="number"
                  step="0.0001"
                  value={def.latitude ?? 0}
                  onChange={(e) => onChange({ ...def, latitude: Number(e.target.value) })}
                />
              </label>
              <label>
                <span>{t('editor.data.weather.longitude')}</span>
                <input
                  type="number"
                  step="0.0001"
                  value={def.longitude ?? 0}
                  onChange={(e) => onChange({ ...def, longitude: Number(e.target.value) })}
                />
              </label>
            </div>
          )}
        </>
      )}

      {where === 'list' && (
        <>
          <label>
            <span>{t(kind === 'area' ? 'editor.data.places.listAreaLabel' : 'editor.data.places.listLabel')}</span>
            <textarea
              rows={5}
              value={text}
              placeholder={kind === 'area' ? EXAMPLE.areaLine : EXAMPLE.placeLine}
              onChange={(e) => {
                setText(e.target.value);
                const places = e.target.value
                  .split('\n')
                  .map((line) => parsePlaceLine(line, kind))
                  .filter((p): p is PlaceRef => p !== null)
                  .slice(0, MAX_PLACES);
                onChange({ ...def, places });
              }}
            />
          </label>
          <p className="hint">{t('editor.data.places.listRead', { count: parsed, max: MAX_PLACES })}</p>
        </>
      )}

      {where === 'table' && (
        <>
          <label>
            <span>{t('editor.data.places.tableSource')}</span>
            <select value={def.placesFrom?.source ?? ''} onChange={(e) => setFrom({ source: e.target.value })}>
              {tables.length === 0 && <option value="">{t('editor.data.places.noTables')}</option>}
              {tables.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <div className="field-row">
            {mappings.map((field) => (
              <label key={field}>
                <span>{t(PLACE_COLUMN_LABEL_KEY[field])}</span>
                <input
                  value={def.placesFrom?.[field] ?? ''}
                  placeholder={PLACE_COLUMN_ALIAS_TEXT[field]}
                  onChange={(e) => setFrom({ [field]: e.target.value.trim() } as Partial<PlacesFrom>)}
                />
              </label>
            ))}
          </div>
        </>
      )}

      {where !== 'one' && (
        <p className="hint">
          {rt('editor.data.places.hint', {
            place: <code>place</code>,
            placeKey: <code>placeKey</code>,
          })}
        </p>
      )}
    </>
  );
}

/* ------------------------------------------------------------------- CAP */

/**
 * Filters for a CAP feed.
 *
 * The safety rules (tests, cancellations, expired alerts) are not options and
 * are not shown: an alert strip should not be one checkbox away from putting a
 * test message on air.
 */
function CapFields({
  def,
  onChange,
}: {
  def: Extract<DataSourceDef, { type: 'cap' }>;
  onChange: (def: DataSourceDef) => void;
}): JSX.Element {
  const t = useT();
  const rt = useRichT();
  const set = (patch: Partial<typeof def>) => {
    const next = { ...def, ...patch };
    // Blank filters are absent filters, not empty strings to match against.
    for (const key of ['area', 'codes', 'events', 'timezone', 'contact'] as const) {
      if (next[key] !== undefined && !next[key]!.trim()) delete next[key];
    }
    onChange(next);
  };

  return (
    <>
      <p className="hint">
        {rt('editor.data.cap.sourcesHint', {
          // Real endpoints, quoted so they can be copied.
          // i18n-ignore-next-line
          nws: <code>https://api.weather.gov/alerts/active?area=AZ</code>,
          // i18n-ignore-next-line
          airnow: <code>https://feeds.enviroflash.info/cap/aggregate.xml</code>,
        })}
      </p>
      <label>
        <span>{t('editor.data.cap.area')}</span>
        <input value={def.area ?? ''} placeholder={EXAMPLE.capArea} onChange={(e) => set({ area: e.target.value })} />
      </label>
      <div className="field-row">
        <label>
          <span>{t('editor.data.cap.codes')}</span>
          <input value={def.codes ?? ''} placeholder={EXAMPLE.capCodes} onChange={(e) => set({ codes: e.target.value })} />
        </label>
        <label>
          <span>{t('editor.data.cap.events')}</span>
          <input value={def.events ?? ''} placeholder={EXAMPLE.capEvents} onChange={(e) => set({ events: e.target.value })} />
        </label>
      </div>
      <div className="field-row">
        <label>
          <span>{t('editor.data.cap.minSeverity')}</span>
          <select
            value={def.minSeverity ?? ''}
            onChange={(e) => {
              const next = { ...def };
              if (e.target.value) next.minSeverity = e.target.value as CapSeverity;
              else delete next.minSeverity;
              onChange(next);
            }}
          >
            <option value="">{t('editor.data.cap.anySeverity')}</option>
            {CAP_SEVERITIES.filter((s) => s !== 'Unknown').map((s) => (
              <option key={s} value={s}>{t(SEVERITY_LABEL_KEY[s])}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('editor.data.cap.times')}</span>
          <select value={def.times ?? 'exact'} onChange={(e) => set({ times: e.target.value as CapTimeMode })}>
            <option value="exact">{t('editor.data.cap.timesExact')}</option>
            <option value="local-day">{t('editor.data.cap.timesLocalDay')}</option>
          </select>
        </label>
      </div>
      {def.times === 'local-day' && (
        <>
          <label>
            <span>{t('editor.data.weather.timezone')}</span>
            <input value={def.timezone ?? ''} placeholder={EXAMPLE.zone} onChange={(e) => set({ timezone: e.target.value })} />
          </label>
          <p className="hint">{t('editor.data.cap.localDayHint')}</p>
        </>
      )}
      <label>
        <span>{t('editor.data.weather.contact')}</span>
        <input
          value={def.contact ?? ''}
          placeholder={t('editor.data.weather.contactPlaceholder')}
          onChange={(e) => set({ contact: e.target.value })}
        />
      </label>
      <p className="hint">
        {rt('editor.data.cap.columnsHint', { columns: <ColumnNames names={CAP_COLUMN_NAMES} /> })}
      </p>
    </>
  );
}

/* ----------------------------------------------------------- air quality */

/**
 * Provider, places, mode — and the terms.
 *
 * AirNow's data-use guidelines are shown in full rather than linked, for the
 * same reason as the Open-Meteo licence warning: the obligations are the
 * station's, and the one about notifying the agencies is the kind nobody
 * discovers from a field label.
 */
function AirQualityFields({
  def,
  others,
  onChange,
}: {
  def: Extract<DataSourceDef, { type: 'air-quality' }>;
  others: DataSourceDef[];
  onChange: (def: DataSourceDef) => void;
}): JSX.Element {
  const t = useT();
  const rt = useRichT();
  const info = AIR_QUALITY_PROVIDER_INFO[def.provider];
  const mode: AirQualityMode = def.mode ?? 'current';
  const hours = def.expireAfter !== undefined ? def.expireAfter / 3600 : '';

  return (
    <>
      <label>
        <span>{t('editor.data.weather.provider')}</span>
        <select
          value={def.provider}
          onChange={(e) => {
            const provider = e.target.value as AirQualityProvider;
            const next = AIR_QUALITY_PROVIDER_INFO[provider];
            const changed: typeof def = {
              ...def,
              provider,
              pollInterval: Math.max(next.pollFloor, def.pollInterval ?? DEFAULT_AIR_QUALITY_POLL_INTERVAL),
            };
            if (!next.needsBaseUrl) delete changed.baseUrl;
            if (!next.scales.includes(changed.scale ?? 'us')) delete changed.scale;
            // Areas and coordinates do not translate into each other; a list
            // or table stays (its columns may carry both), one place resets.
            if (next.placeKind !== info?.placeKind && !def.places && !def.placesFrom) {
              delete changed.area;
              delete changed.latitude;
              delete changed.longitude;
              if (next.placeKind === 'area') changed.area = '';
              else {
                changed.latitude = 0;
                changed.longitude = 0;
              }
            }
            onChange(changed);
          }}
        >
          {AIR_QUALITY_PROVIDERS.map((id) => (
            <option key={id} value={id}>{t(AIR_QUALITY_PROVIDER_INFO[id].labelKey)}</option>
          ))}
        </select>
      </label>

      {info && (
        <p className="hint">
          {t('editor.data.weather.coverageHint', { coverage: t(info.coverageKey), seconds: info.pollFloor })}
        </p>
      )}

      {info?.commercialUse === 'non-commercial-only' && (
        <div className="source-error">
          {rt('editor.data.weather.nonCommercial', {
            lead: <strong>{t('editor.data.weather.nonCommercialLead')}</strong>,
            selfHosted: <em>{t('schema.airQuality.provider.open-meteo-self.label')}</em>,
            link: (
              <a href={info.licenseUrl} target="_blank" rel="noreferrer">
                {t('editor.data.weather.readLicense')}
              </a>
            ),
          })}
        </div>
      )}

      {def.provider === 'airnow-feed' ? (
        <div className="source-warning">
          {rt('editor.data.airQuality.airnowTerms', {
            lead: <strong>{t('editor.data.airQuality.airnowTermsLead')}</strong>,
            attribution: <code>attribution</code>,
            preliminary: <code>preliminary</code>,
            link: (
              <a href={info.licenseUrl} target="_blank" rel="noreferrer">
                {t('editor.data.airQuality.guidelines')}
              </a>
            ),
          })}
        </div>
      ) : (
        info?.attribution && (
          <p className="hint">
            {rt('editor.data.weather.attribution', {
              lead: <strong>{t('editor.data.weather.attributionLead')}</strong>,
              credit: info.attribution,
              column: <code>attribution</code>,
              link: (
                <a href={info.licenseUrl} target="_blank" rel="noreferrer">
                  {t('editor.data.weather.license')}
                </a>
              ),
            })}
          </p>
        )
      )}

      {info?.needsBaseUrl && (
        <>
          <label>
            <span>{t('editor.data.weather.instanceUrl')}</span>
            <input
              value={def.baseUrl ?? ''}
              placeholder="http://localhost:8282"
              onChange={(e) => onChange({ ...def, baseUrl: e.target.value })}
            />
          </label>
          <p className="hint">
            {rt('editor.data.weather.allowHostsHint', {
              // i18n-ignore-next-line — an environment variable and its value
              env: <code>BREEZE_DATA_ALLOW_HOSTS=localhost</code>,
            })}
          </p>
        </>
      )}

      {info && <PlacesFields def={def} kind={info.placeKind} others={others} onChange={onChange} />}

      {def.provider === 'airnow-feed' && (
        <p className="hint">
          {rt('editor.data.airQuality.areaHint', {
            // i18n-ignore-next-line
            example: <code>https://feeds.enviroflash.info/rss/realtime/111.xml</code>,
            id: <code>111</code>,
          })}
        </p>
      )}

      <div className="field-row">
        <label>
          <span>{t('editor.data.weather.report')}</span>
          <select value={mode} onChange={(e) => onChange({ ...def, mode: e.target.value as AirQualityMode })}>
            <option value="current">{t('editor.data.airQuality.modeCurrent')}</option>
            <option value="pollutants">{t('editor.data.airQuality.modePollutants')}</option>
            <option value="forecast">{t('editor.data.airQuality.modeForecast')}</option>
          </select>
        </label>
        {info && info.scales.length > 1 && (
          <label>
            <span>{t('editor.data.airQuality.scale')}</span>
            <select value={def.scale ?? 'us'} onChange={(e) => onChange({ ...def, scale: e.target.value as AqiScale })}>
              <option value="us">{t('editor.data.airQuality.scaleUs')}</option>
              <option value="eu">{t('editor.data.airQuality.scaleEu')}</option>
            </select>
          </label>
        )}
        {mode === 'forecast' && (
          <label>
            <span>{t('editor.data.airQuality.days')}</span>
            <input
              type="number"
              min={1}
              max={7}
              value={def.count ?? 3}
              onChange={(e) => onChange({ ...def, count: Number(e.target.value) })}
            />
          </label>
        )}
      </div>

      <label>
        <span>{t('editor.data.expireAfter')}</span>
        <input
          type="number"
          min={0.25}
          step={0.25}
          value={hours}
          placeholder={def.provider === 'airnow-feed' ? String(DEFAULT_AIR_QUALITY_EXPIRY / 3600) : ''}
          onChange={(e) => {
            const next = { ...def };
            if (e.target.value === '') delete next.expireAfter;
            else next.expireAfter = Math.max(60, Math.round(Number(e.target.value) * 3600));
            onChange(next);
          }}
        />
      </label>
      <p className="hint">{t('editor.data.expireAfterHint')}</p>

      {info?.placeKind === 'coordinates' && (
        <label>
          <span>{t('editor.data.weather.timezone')}</span>
          <input
            value={def.timezone ?? ''}
            placeholder="auto"
            onChange={(e) => {
              const next = { ...def };
              if (e.target.value.trim()) next.timezone = e.target.value.trim();
              else delete next.timezone;
              onChange(next);
            }}
          />
        </label>
      )}

      <label>
        <span>{t('editor.data.weather.contact')}</span>
        <input
          value={def.contact ?? ''}
          placeholder={t('editor.data.weather.contactPlaceholder')}
          onChange={(e) => {
            const next = { ...def };
            if (e.target.value.trim()) next.contact = e.target.value;
            else delete next.contact;
            onChange(next);
          }}
        />
      </label>

      <p className="hint">
        {rt('editor.data.airQuality.columnsHint', { columns: <ColumnNames names={AIR_QUALITY_COLUMN_NAMES} /> })}
      </p>
    </>
  );
}

/* ------------------------------------------------------------ ftp / sftp */

/**
 * Connection, directory, pattern, format.
 *
 * Format is a separate field from pattern rather than being sniffed from the
 * extension. A results drop named `.txt` holding CSV is common enough, and
 * guessing wrong produces a one-column table that looks like a parser bug.
 */
function FtpFields({
  def,
  onChange,
}: {
  def: Extract<DataSourceDef, { type: 'ftp' }>;
  onChange: (def: DataSourceDef) => void;
}): JSX.Element {
  const t = useT();
  const rt = useRichT();
  return (
    <>
      <div className="field-row">
        <label>
          <span>{t('editor.data.ftp.protocol')}</span>
          <select
            value={def.protocol}
            onChange={(e) =>
              onChange({ ...def, protocol: e.target.value as 'ftp' | 'ftps' | 'sftp' })
            }
          >
            <option value="sftp">{t('editor.data.ftp.protocolSftp')}</option>
            <option value="ftps">{t('editor.data.ftp.protocolFtps')}</option>
            <option value="ftp">{t('editor.data.ftp.protocolFtp')}</option>
          </select>
        </label>
        <label>
          <span>{t('editor.data.ftp.host')}</span>
          <input
            value={def.host}
            placeholder="drop.league.example"
            onChange={(e) => onChange({ ...def, host: e.target.value })}
          />
        </label>
        <label>
          <span>{t('editor.data.ftp.port')}</span>
          <input
            type="number"
            placeholder={def.protocol === 'sftp' ? '22' : '21'}
            value={def.port ?? ''}
            onChange={(e) =>
              onChange({ ...def, port: e.target.value ? Number(e.target.value) : undefined })
            }
          />
        </label>
      </div>

      {def.protocol === 'ftp' && (
        <p className="hint">{t('editor.data.ftp.plainWarning')}</p>
      )}

      <div className="field-row">
        <label>
          <span>{t('editor.data.ftp.directory')}</span>
          <input
            value={def.path ?? ''}
            placeholder="/results"
            onChange={(e) => onChange({ ...def, path: e.target.value })}
          />
        </label>
        <label>
          <span>{t('editor.data.ftp.pattern')}</span>
          <input
            value={def.pattern}
            placeholder="results-*.csv"
            onChange={(e) => onChange({ ...def, pattern: e.target.value })}
          />
        </label>
      </div>

      <div className="field-row">
        <label>
          <span>{t('editor.data.ftp.format')}</span>
          <select
            value={def.format}
            onChange={(e) =>
              onChange({ ...def, format: e.target.value as 'csv' | 'json' | 'xml' | 'rss' })
            }
          >
            <option value="csv">{t('editor.data.ftp.formatCsv')}</option>
            <option value="json">{t('editor.data.ftp.formatJson')}</option>
            <option value="xml">{t('editor.data.ftp.formatXml')}</option>
            <option value="rss">{t('editor.data.ftp.formatRss')}</option>
          </select>
        </label>
        <label>
          <span>{t('editor.data.ftp.username')}</span>
          <input
            value={def.username ?? ''}
            placeholder="anonymous"
            onChange={(e) => onChange({ ...def, username: e.target.value })}
          />
        </label>
      </div>

      {def.format === 'csv' && (
        <label className="inline">
          <input
            type="checkbox"
            checked={def.header !== false}
            onChange={(e) => onChange({ ...def, header: e.target.checked })}
          />
          <span>{t('editor.data.headerRow')}</span>
        </label>
      )}

      {(def.format === 'json' || def.format === 'xml') && (
        <label>
          <span>{t('editor.data.rowPath')}</span>
          <input
            value={def.rowPath ?? ''}
            placeholder={
              def.format === 'json' ? t('editor.data.rowPathFtpJsonPlaceholder') : 'results/game'
            }
            onChange={(e) => onChange({ ...def, rowPath: e.target.value })}
          />
        </label>
      )}

      <p className="hint">
        {rt('editor.data.ftp.allowHostsHint', { env: <code>BREEZE_DATA_ALLOW_HOSTS</code> })}
      </p>
    </>
  );
}

/* ------------------------------------------------------------ sheets v4 */

/**
 * Spreadsheet id and range.
 *
 * The panel steers people to the published-CSV route first and keeps doing so
 * here, because it is genuinely the better option when it is available: no Cloud
 * project, no credential to rotate, no service account to remember to share the
 * sheet with. This form is for the case where the sheet cannot be public.
 */
function SheetsFields({
  def,
  onChange,
}: {
  def: Extract<DataSourceDef, { type: 'sheets' }>;
  onChange: (def: DataSourceDef) => void;
}): JSX.Element {
  const t = useT();
  const rt = useRichT();
  return (
    <>
      <p className="hint">
        {rt('editor.data.sheets.preferCsvHint', {
          httpCsv: <strong>{t('editor.data.typeHttpCsvShort')}</strong>,
          email: <code>client_email</code>,
        })}
      </p>

      <label>
        <span>{t('editor.data.sheets.spreadsheet')}</span>
        <input
          value={def.spreadsheet}
          placeholder={t('editor.data.sheets.spreadsheetPlaceholder')}
          onChange={(e) => onChange({ ...def, spreadsheet: e.target.value })}
        />
      </label>

      <label>
        <span>{t('editor.data.sheets.range')}</span>
        <input
          value={def.range ?? ''}
          placeholder={t('editor.data.sheets.rangePlaceholder')}
          onChange={(e) => onChange({ ...def, range: e.target.value })}
        />
      </label>
    </>
  );
}

/* ----------------------------------------------------------- manual table */

/**
 * The manual-table adapter's whole implementation is this grid.
 *
 * Paste is the feature, not the cell editing: everyone who keeps standings keeps
 * them in a spreadsheet, and a block copied from one arrives on the clipboard as
 * TSV. Handling that in one paste — headers included — is the difference between
 * a usable table and one nobody fills in.
 */
/** The bracket the grid would resolve to, or null when this is not a bracket. */
function useBracketPreview(
  def: Extract<DataSourceDef, { type: 'manual' }>,
  on: boolean,
): { resolved: DataSet; seedRound: string; carried: Set<string> } | null {
  return useMemo(() => {
    if (!on) return null;
    const advance = previewAdvance(def.columns);
    if (!advance) return null;
    const data: DataSet = { id: def.id, columns: def.columns, rows: def.rows };
    return {
      resolved: applyTransforms(data, [advance]),
      seedRound: firstRound(def.rows),
      carried: carriedColumns(),
    };
  }, [def, on]);
}

function ManualTableEditor({
  def,
  onChange,
}: {
  def: Extract<DataSourceDef, { type: 'manual' }>;
  onChange: (def: DataSourceDef) => void;
}): JSX.Element {
  const t = useT();
  const rt = useRichT();
  const setColumns = (columns: DataColumn[]) => onChange({ ...def, columns });
  const setRows = (rows: DataRow[]) => onChange({ ...def, rows });

  const [resolve, setResolve] = useState(false);
  const bracket = useBracketPreview(def, resolve);
  const isBracket = isBracketTable(def.columns);

  const fedCell = (row: DataRow, key: string): boolean =>
    bracket !== null && isFedCell(row, key, bracket.seedRound, bracket.carried);

  const pasteInto = (text: string, atRow: number, atCol: number, withHeaders: boolean) => {
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
    if (!lines.length) return;

    let columns = def.columns;
    let body = lines;

    if (withHeaders) {
      const headers = lines[0]!.split('\t');
      columns = headers.map((h, i) => ({
        // A column's key is a frozen identifier a graphic binds to, and the
        // label it falls back to is DataSet content that renders on air. Both
        // stay English for the same reason NEW_NAME does.
        key: h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `col${i + 1}`,  // i18n-ignore
        // i18n-ignore-next-line
        label: h.trim() || `Column ${i + 1}`,
        // Typed from the first data row: a column that is text here sorts as
        // text on air, and finding that out during a show is too late.
        type: /^-?[\d.,]+$/.test((lines[1]?.split('\t')[i] ?? '').trim()) ? 'number' : 'string',
      }));
      body = lines.slice(1);
      setColumns(columns);
    }

    const rows = withHeaders ? [] : [...def.rows];
    body.forEach((line, r) => {
      const cells = line.split('\t');
      const target = withHeaders ? r : atRow + r;
      while (rows.length <= target) rows.push({});
      const row = { ...rows[target]! };
      cells.forEach((cell, c) => {
        const col = columns[withHeaders ? c : atCol + c];
        if (!col) return;
        row[col.key] =
          col.type === 'number' && cell.trim() !== '' && Number.isFinite(Number(cell))
            ? Number(cell)
            : cell;
      });
      rows[target] = row;
    });
    setRows(rows);
  };

  return (
    <div className="manual-table">
      <div className="hint">{t('editor.data.manual.pasteHint')}</div>

      {isBracket && (
        <div className="bracket-bar">
          <label>
            <input
              type="checkbox"
              checked={resolve}
              onChange={(e) => setResolve(e.target.checked)}
            />{' '}
            {t('editor.data.manual.resolveBracket')}
          </label>
          {bracket && (
            <span className="hint">
              {rt('editor.data.manual.bracketHint', { advance: <code>advance</code> })}
            </span>
          )}
        </div>
      )}

      <table>
        <thead>
          <tr>
            {def.columns.map((col, i) => (
              <th key={col.key}>
                <input
                  className="col-label"
                  value={col.label ?? col.key}
                  onChange={(e) => {
                    const columns = [...def.columns];
                    columns[i] = { ...col, label: e.target.value };
                    setColumns(columns);
                  }}
                />
                <select
                  value={col.type}
                  onChange={(e) => {
                    const columns = [...def.columns];
                    columns[i] = { ...col, type: e.target.value as DataColumn['type'] };
                    setColumns(columns);
                  }}
                >
                  <option value="string">{t('editor.data.manual.colTypeText')}</option>
                  <option value="number">{t('editor.data.manual.colTypeNumber')}</option>
                  <option value="boolean">{t('editor.data.manual.colTypeBoolean')}</option>
                  <option value="date">{t('editor.data.manual.colTypeDate')}</option>
                </select>
                <code>{col.key}</code>
              </th>
            ))}
            <th>
              <button
                onClick={() => {
                  const key = `col${def.columns.length + 1}`;  // i18n-ignore — identifier
                  setColumns([...def.columns, { key, label: key, type: 'string' }]);
                }}
              >
                +
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {def.rows.map((row, r) => (
            <tr key={r}>
              {def.columns.map((col, c) => {
                const fed = fedCell(row, col.key);
                // Show what advance produced, not what the grid stores: a fed
                // slot's stored value is stale by definition.
                const shown = fed
                  ? bracket!.resolved.rows[r]?.[col.key]
                  : row[col.key];
                return (
                  <td key={col.key} className={fed ? 'fed' : undefined}>
                    <input
                      value={shown === null || shown === undefined ? '' : String(shown)}
                      readOnly={fed}
                      title={fed ? t('editor.data.manual.fedCell') : undefined}
                      onChange={(e) => {
                        if (fed) return;
                        const rows = [...def.rows];
                        const raw = e.target.value;
                        rows[r] = {
                          ...row,
                          [col.key]:
                            col.type === 'number' && raw.trim() !== '' && Number.isFinite(Number(raw))
                              ? Number(raw)
                              : raw,
                        };
                        setRows(rows);
                      }}
                      onPaste={(e) => {
                        const text = e.clipboardData.getData('text/plain');
                        if (!/[\t\n]/.test(text)) return;
                        e.preventDefault();
                        pasteInto(text, r, c, r === 0 && c === 0);
                      }}
                    />
                  </td>
                );
              })}
              <td>
                <button
                  onClick={() => setRows(def.rows.filter((_, i) => i !== r))}
                  title={t('editor.data.manual.removeRow')}
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="source-actions">
        <button
          onClick={() => {
            const blank: DataRow = {};
            for (const col of def.columns) blank[col.key] = col.type === 'number' ? 0 : '';
            setRows([...def.rows, blank]);
          }}
        >
          {t('editor.data.manual.addRow')}
        </button>
      </div>
    </div>
  );
}
