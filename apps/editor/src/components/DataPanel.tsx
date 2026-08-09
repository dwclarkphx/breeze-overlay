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
 * dead feed should be diagnosed here and not by staring at a frozen graphic
 * (DATA-SOURCES §6).
 */

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import {
  DEFAULT_POLL_INTERVAL,
  DEFAULT_WEATHER_POLL_INTERVAL,
  MIN_POLL_INTERVAL,
  WEATHER_PROVIDERS,
  WEATHER_PROVIDER_INFO,
  applyTransforms,
  pollFloor,
  type DataColumn,
  type DataRow,
  type DataSet,
  type DataSourceDef,
  type WeatherProvider,
} from '@breeze/schema';

import { api, type DataSourceSummary } from '../api/client.js';
import {
  carriedColumns,
  firstRound,
  isBracketTable,
  isFedCell,
  previewAdvance,
} from '../state/bracket.js';
import { useEditor } from '../state/store.js';

const TYPE_LABEL: Record<DataSourceDef['type'], string> = {
  manual: 'Manual table',
  'http-json': 'HTTP JSON',
  'http-csv': 'HTTP CSV / Sheet',
  rss: 'RSS / Atom',
  xml: 'XML',
  sheets: 'Google Sheet (private)',
  weather: 'Weather',
  ftp: 'FTP / SFTP drop',
};

const NEW_NAME: Record<DataSourceDef['type'], string> = {
  manual: 'New table',
  'http-json': 'New feed',
  'http-csv': 'New sheet',
  rss: 'New headline feed',
  xml: 'New XML feed',
  sheets: 'New private sheet',
  weather: 'New weather',
  ftp: 'New file drop',
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
      pollInterval: DEFAULT_WEATHER_POLL_INTERVAL,
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
    def.type === 'xml'
  );
}

/** "4s ago", "2m ago" — relative because absolute timestamps need arithmetic. */
function ago(iso: string | undefined): string {
  if (!iso) return 'never';
  const delta = Math.max(0, Date.now() - Date.parse(iso));
  const s = Math.round(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function DataPanel(): JSX.Element {
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
      await api.saveDataSource(projectId, def);
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
          {collapsed ? '▸' : '▾'} Data sources
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
            <option value="">+ Add…</option>
            <option value="manual">Manual table</option>
            <option value="http-csv">HTTP CSV / Google Sheet</option>
            <option value="http-json">HTTP JSON</option>
            <option value="rss">RSS / Atom feed</option>
            <option value="xml">XML</option>
            <option value="sheets">Google Sheet — private (API v4)</option>
            <option value="weather">Weather</option>
            <option value="ftp">FTP / SFTP file drop</option>
          </select>
        </span>
      </div>

      {error && <div className="panel-error">{error}</div>}

      {!collapsed && (
        <div className="source-list">
          {sources.length === 0 && (
            <p className="hint">
              No data sources. A published Google Sheet works as an <em>HTTP CSV</em> source — use
              its <code>Publish to web → CSV</code> URL, no API key needed.
            </p>
          )}

          {sources.map(({ def, status, interval, rowCount }) => {
            const failing = (status.failures ?? 0) > 0;
            return (
              <div key={def.id} className={`source-row${failing ? ' failing' : ''}`}>
                <div className="source-head">
                  <span className="source-name">{def.name}</span>
                  <code className="source-id">{def.id}</code>
                  <span className="source-type">{TYPE_LABEL[def.type]}</span>
                </div>
                <div className="source-meta">
                  <span>{rowCount} rows</span>
                  {def.type !== 'manual' && <span>every {interval}s</span>}
                  <span title={status.lastFetch}>fetched {ago(status.lastFetch)}</span>
                  <span title={status.lastChange}>changed {ago(status.lastChange)}</span>
                  <span>rev {status.revision}</span>
                </div>
                {status.lastError && <div className="source-error">{status.lastError}</div>}
                <div className="source-actions">
                  <button onClick={() => setEditing(def)}>Edit</button>
                  {def.type !== 'manual' && (
                    <button onClick={() => void api.refreshDataSource(projectId, def.id).then(reload)}>
                      Refresh
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (!confirm(`Delete data source "${def.name}"?`)) return;
                      void api.deleteDataSource(projectId, def.id).then(reload);
                    }}
                  >
                    Delete
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
};

/* ------------------------------------------------------------------ editor */

interface SourceEditorProps {
  projectId: string;
  def: DataSourceDef;
  onChange: (def: DataSourceDef) => void;
  onCancel: () => void;
  onSave: () => void;
}

function SourceEditor({ projectId, def, onChange, onCancel, onSave }: SourceEditorProps): JSX.Element {
  const [preview, setPreview] = useState<{ ok: boolean; error?: string; data?: DataSet; rowCount?: number } | null>(
    null,
  );
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
    : def.type === 'ftp' ? Boolean(def.host && def.pattern)
    : hasUrl(def) && !!def.url;

  // Weather is rate-floored by its provider's license rather than by this
  // server's scheduler, so the number the field enforces has to follow suit.
  const minInterval = def.type === 'manual' ? MIN_POLL_INTERVAL : pollFloor(def);

  return (
    <div className="source-editor">
      <label>
        <span>Name</span>
        <input value={def.name} onChange={(e) => onChange({ ...def, name: e.target.value })} />
      </label>

      {def.type === 'manual' ? (
        <ManualTableEditor def={def} onChange={onChange} />
      ) : (
        <>
          {def.type === 'weather' ? (
            <WeatherFields def={def} onChange={onChange} />
          ) : def.type === 'ftp' ? (
            <FtpFields def={def} onChange={onChange} />
          ) : def.type === 'sheets' ? (
            <SheetsFields def={def} onChange={onChange} />
          ) : (
            <label>
              <span>URL</span>
              <input
                value={def.url}
                placeholder={URL_PLACEHOLDER[def.type]}
                onChange={(e) => onChange({ ...def, url: e.target.value })}
              />
            </label>
          )}

          {def.type === 'rss' && (
            <p className="hint">
              RSS 2.0, RSS 1.0/RDF and Atom all normalize to the same columns —{' '}
              <code>title</code>, <code>link</code>, <code>date</code>, <code>description</code>,{' '}
              <code>author</code>, <code>category</code>, <code>image</code>, <code>guid</code> — so
              a graphic keeps working if the feed changes software. Bind a crawl layer's items to{' '}
              <code>title</code> for a headline ticker.
            </p>
          )}

          {def.type === 'xml' && (
            <XmlRowPathField projectId={projectId} def={def} onChange={onChange} busy={busy} />
          )}

          {def.type === 'http-json' && (
            <label>
              <span>
                Row path{' '}
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
                  find it
                </button>
              </span>
              <input
                value={def.rowPath ?? ''}
                placeholder="data.standings[0].teams — blank for the root array"
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
              <span>First row is a header</span>
            </label>
          )}

          <label>
            <span>Poll interval (seconds, minimum {minInterval})</span>
            <input
              type="number"
              min={minInterval}
              value={def.pollInterval ?? (def.type === 'weather' ? DEFAULT_WEATHER_POLL_INTERVAL : DEFAULT_POLL_INTERVAL)}
              onChange={(e) => onChange({ ...def, pollInterval: Number(e.target.value) })}
            />
          </label>

          {/* Weather carries no operator credential — the providers wired here
              are keyless, and the field would be a box with nothing to put in it. */}
          {def.type !== 'weather' && (
            <label>
              <span>
                {def.type === 'sheets'
                  ? 'Credential id (required — API key or service-account JSON, held server-side)'
                  : def.type === 'ftp'
                    ? 'Credential id (optional — password or SSH key, held server-side)'
                    : 'Credential id (optional — the value lives in server config)'}
              </span>
              <input
                value={def.secretId ?? ''}
                placeholder={
                  def.type === 'sheets' ? 'e.g. league-sheets'
                  : def.type === 'ftp' ? 'e.g. results-drop'
                  : 'e.g. league-api'
                }
                onChange={(e) => onChange({ ...def, secretId: e.target.value })}
              />
            </label>
          )}

          <div className="source-actions">
            <button onClick={() => void runPreview()} disabled={!canPreview || busy}>
              {busy ? 'Fetching…' : 'Preview'}
            </button>
          </div>

          {preview && !preview.ok && <div className="source-error">{preview.error}</div>}
          {preview?.ok && preview.data && (
            <DataPreview data={preview.data} total={preview.rowCount ?? preview.data.rows.length} />
          )}
        </>
      )}

      <div className="source-actions">
        <button className="primary" onClick={onSave}>Save source</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function DataPreview({ data, total }: { data: DataSet; total: number }): JSX.Element {
  return (
    <div className="data-preview">
      <div className="hint">{total} rows · {data.columns.length} columns</div>
      <table>
        <thead>
          <tr>
            {data.columns.map((c) => (
              <th key={c.key} title={`${c.key} (${c.type})`}>{c.label ?? c.key}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.slice(0, 8).map((row, i) => (
            <tr key={i}>
              {data.columns.map((c) => (
                <td key={c.key}>{row[c.key] === null ? '' : String(row[c.key] ?? '')}</td>
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
  const [found, setFound] = useState<{
    candidates: Array<{ path: string; count: number }>;
    feed?: 'rss' | 'rdf' | 'atom' | null;
    error?: string;
  } | null>(null);

  const inspect = async () => {
    const result = await api.inspectXmlFeed(projectId, def.url);
    if (!result.ok) {
      setFound({ candidates: [], error: result.error ?? 'could not read that URL' });
      return;
    }
    setFound({ candidates: result.candidates ?? [], feed: result.feed ?? null });
    if (result.rowPath) onChange({ ...def, rowPath: result.rowPath });
  };

  return (
    <>
      <label>
        <span>
          Row element{' '}
          <button className="linkish" disabled={!def.url || busy} onClick={() => void inspect()}>
            find it
          </button>
        </span>
        <input
          value={def.rowPath ?? ''}
          placeholder="results/game — blank to guess the repeating element"
          onChange={(e) => onChange({ ...def, rowPath: e.target.value })}
        />
      </label>

      {found?.error && <div className="source-error">{found.error}</div>}

      {found?.feed && (
        <p className="hint">
          This is {found.feed === 'atom' ? 'an Atom' : 'an RSS'} feed. The{' '}
          <strong>RSS / Atom</strong> source type will normalize it to stable columns — worth using
          instead unless you specifically want the raw element names.
        </p>
      )}

      {found && found.candidates.length > 0 && (
        <div className="xml-candidates">
          {found.candidates.map((c) => (
            <button
              key={c.path}
              className={`chip${c.path === def.rowPath ? ' selected' : ''}`}
              onClick={() => onChange({ ...def, rowPath: c.path })}
              title={`${c.count} occurrences`}
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
  onChange,
}: {
  def: Extract<DataSourceDef, { type: 'weather' }>;
  onChange: (def: DataSourceDef) => void;
}): JSX.Element {
  const info = WEATHER_PROVIDER_INFO[def.provider];
  const nonCommercial = info?.commercialUse === 'non-commercial-only';

  return (
    <>
      <label>
        <span>Provider</span>
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
            });
          }}
        >
          {WEATHER_PROVIDERS.map((id) => (
            <option key={id} value={id}>
              {WEATHER_PROVIDER_INFO[id].label}
            </option>
          ))}
        </select>
      </label>

      {info && <p className="hint">Coverage: {info.coverage}. Polls no faster than every {info.pollFloor}s.</p>}

      {nonCommercial && (
        <div className="source-error">
          <strong>Non-commercial use only.</strong> Open-Meteo&rsquo;s hosted API may not be used on
          a channel or site carrying advertising or subscriptions. For commercial output, run your
          own Open-Meteo instance and pick <em>Open-Meteo — self-hosted</em>, or subscribe to their
          paid API.{' '}
          <a href={info.licenseUrl} target="_blank" rel="noreferrer">
            Read the license
          </a>
          .
        </div>
      )}

      {info?.attribution && (
        <p className="hint">
          <strong>Attribution required.</strong> Show &ldquo;{info.attribution}&rdquo; wherever this
          data appears — bind a text layer to the <code>attribution</code> column and it travels with
          the graphic.{' '}
          <a href={info.licenseUrl} target="_blank" rel="noreferrer">
            License
          </a>
        </p>
      )}

      {info?.needsBaseUrl && (
        <label>
          <span>Instance URL</span>
          <input
            value={def.baseUrl ?? ''}
            placeholder="http://localhost:8282"
            onChange={(e) => onChange({ ...def, baseUrl: e.target.value })}
          />
        </label>
      )}

      {info?.needsBaseUrl && (
        <p className="hint">
          A private or loopback address is refused by the fetch guard until it is allowlisted — set{' '}
          <code>BREEZE_DATA_ALLOW_HOSTS=localhost</code> in the server environment.
        </p>
      )}

      {info?.supportsModelSelection && (
        <div className="field-row">
          <label>
            <span>Model (blank = best match)</span>
            <input
              value={def.models ?? ''}
              placeholder="ncep_gfs_seamless"
              onChange={(e) => onChange({ ...def, models: e.target.value })}
            />
          </label>
          <label>
            <span>Time zone</span>
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
          Not sure of the model id?{' '}
          <a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">
            Open-Meteo&rsquo;s API docs
          </a>{' '}
          let you pick a model and read the id straight off the generated URL — it is the same{' '}
          <code>&amp;models=</code> value this field takes. Only the model and time zone are worth
          copying across; the rest of the URL is built for you.
        </p>
      )}

      {info?.needsBaseUrl && (
        <p className="hint">
          Your instance only holds the models you have synced. If it answers on{' '}
          <code>?models=…</code> but not without, name that model here — leaving it blank asks for{' '}
          <code>best_match</code>, which may want a model the box does not have.
        </p>
      )}

      <label>
        <span>Contact for User-Agent (optional — overrides the server default)</span>
        <input
          value={def.contact ?? ''}
          placeholder="mystation.com, ops@mystation.com"
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
      {info?.needsContact ? (
        <p className="hint">
          {info.label.split(' — ')[0]} requires this and will contact you before blocking if a
          problem is traced to your requests. Left blank, Breeze sends a generic string shared by
          every install — so your traffic is judged alongside everyone else&rsquo;s and nobody can
          reach you. Set it once for the whole server with <code>BREEZE_CONTACT</code> instead of
          per source.
        </p>
      ) : (
        <p className="hint">
          Not required here, but it identifies your station in the origin&rsquo;s logs. Set it once
          for the whole server with <code>BREEZE_CONTACT</code> rather than per source.
        </p>
      )}

      <label>
        <span>Place name (shown on the graphic, never sent to the provider)</span>
        <input
          value={def.place ?? ''}
          placeholder="Phoenix, AZ"
          onChange={(e) => onChange({ ...def, place: e.target.value })}
        />
      </label>

      <div className="field-row">
        <label>
          <span>Latitude</span>
          <input
            type="number"
            step="0.0001"
            value={def.latitude}
            onChange={(e) => onChange({ ...def, latitude: Number(e.target.value) })}
          />
        </label>
        <label>
          <span>Longitude</span>
          <input
            type="number"
            step="0.0001"
            value={def.longitude}
            onChange={(e) => onChange({ ...def, longitude: Number(e.target.value) })}
          />
        </label>
      </div>

      <div className="field-row">
        <label>
          <span>Units</span>
          <select
            value={def.units ?? 'metric'}
            onChange={(e) => onChange({ ...def, units: e.target.value as 'metric' | 'imperial' })}
          >
            <option value="imperial">°F / mph / in</option>
            <option value="metric">°C / km/h / mm</option>
          </select>
        </label>
        <label>
          <span>Report</span>
          <select
            value={def.mode ?? 'current'}
            onChange={(e) =>
              onChange({ ...def, mode: e.target.value as 'current' | 'hourly' | 'daily' })
            }
          >
            <option value="current">Current conditions (1 row)</option>
            <option value="hourly">Hourly forecast</option>
            <option value="daily">Daily forecast</option>
          </select>
        </label>
      </div>

      {def.mode !== 'current' && (
        <label>
          <span>Rows</span>
          <input
            type="number"
            min={1}
            max={240}
            value={def.count ?? 5}
            onChange={(e) => onChange({ ...def, count: Number(e.target.value) })}
          />
        </label>
      )}

      <p className="hint">
        Every provider returns the same columns — <code>temp</code>, <code>tempMin</code>,{' '}
        <code>tempMax</code>, <code>condition</code>, <code>icon</code>, <code>windSpeed</code>,{' '}
        <code>windDir</code>, <code>precipProb</code> and the rest — so switching provider does not
        mean rebuilding the graphic. <code>icon</code> is a fixed keyword such as{' '}
        <code>partly-cloudy</code>, to map onto your own artwork.
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
  return (
    <>
      <div className="field-row">
        <label>
          <span>Protocol</span>
          <select
            value={def.protocol}
            onChange={(e) =>
              onChange({ ...def, protocol: e.target.value as 'ftp' | 'ftps' | 'sftp' })
            }
          >
            <option value="sftp">SFTP (SSH)</option>
            <option value="ftps">FTPS (explicit TLS)</option>
            <option value="ftp">FTP (plain — no encryption)</option>
          </select>
        </label>
        <label>
          <span>Host</span>
          <input
            value={def.host}
            placeholder="drop.league.example"
            onChange={(e) => onChange({ ...def, host: e.target.value })}
          />
        </label>
        <label>
          <span>Port</span>
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
        <p className="hint">
          Plain FTP sends the password and the file in the clear. Fine for an anonymous public drop;
          use SFTP or FTPS for anything with a login.
        </p>
      )}

      <div className="field-row">
        <label>
          <span>Directory</span>
          <input
            value={def.path ?? ''}
            placeholder="/results"
            onChange={(e) => onChange({ ...def, path: e.target.value })}
          />
        </label>
        <label>
          <span>Filename pattern (newest match wins)</span>
          <input
            value={def.pattern}
            placeholder="results-*.csv"
            onChange={(e) => onChange({ ...def, pattern: e.target.value })}
          />
        </label>
      </div>

      <div className="field-row">
        <label>
          <span>Format</span>
          <select
            value={def.format}
            onChange={(e) =>
              onChange({ ...def, format: e.target.value as 'csv' | 'json' | 'xml' | 'rss' })
            }
          >
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
            <option value="xml">XML</option>
            <option value="rss">RSS / Atom</option>
          </select>
        </label>
        <label>
          <span>Username (blank for anonymous)</span>
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
          <span>First row is a header</span>
        </label>
      )}

      {(def.format === 'json' || def.format === 'xml') && (
        <label>
          <span>Row path</span>
          <input
            value={def.rowPath ?? ''}
            placeholder={def.format === 'json' ? 'data.teams — blank for the root array' : 'results/game'}
            onChange={(e) => onChange({ ...def, rowPath: e.target.value })}
          />
        </label>
      )}

      <p className="hint">
        A drop box on the venue LAN is refused until its host is allowlisted — add it to{' '}
        <code>BREEZE_DATA_ALLOW_HOSTS</code> in the server environment. The file is parsed by the
        same readers the HTTP sources use, so the same CSV over SFTP and over HTTPS gives the same
        table.
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
  return (
    <>
      <p className="hint">
        For a sheet you can publish, <strong>HTTP CSV</strong> is simpler and needs no credential.
        Use this type when the sheet must stay private — then share it with the service account's{' '}
        <code>client_email</code>, or use an API key if it is link-shared.
      </p>

      <label>
        <span>Spreadsheet</span>
        <input
          value={def.spreadsheet}
          placeholder="paste the sheet URL, or just its id"
          onChange={(e) => onChange({ ...def, spreadsheet: e.target.value })}
        />
      </label>

      <label>
        <span>Range (A1 notation)</span>
        <input
          value={def.range ?? ''}
          placeholder="Standings!A1:F30 — blank for A1:Z1000 of the first sheet"
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
    const t = previewAdvance(def.columns);
    if (!t) return null;
    const data: DataSet = { id: def.id, columns: def.columns, rows: def.rows };
    return {
      resolved: applyTransforms(data, [t]),
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
        key: h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `col${i + 1}`,
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
      <div className="hint">
        Paste a block from a spreadsheet into the first cell to replace the whole table, headers
        included.
      </div>

      {isBracket && (
        <div className="bracket-bar">
          <label>
            <input
              type="checkbox"
              checked={resolve}
              onChange={(e) => setResolve(e.target.checked)}
            />{' '}
            Resolve bracket
          </label>
          {bracket && (
            <span className="hint">
              Type a winner or a score and the rounds after it fill themselves. Filled slots are
              locked — the table layer&apos;s own <code>advance</code> owns them.
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
                  <option value="string">text</option>
                  <option value="number">number</option>
                  <option value="boolean">yes/no</option>
                  <option value="date">date</option>
                </select>
                <code>{col.key}</code>
              </th>
            ))}
            <th>
              <button
                onClick={() => {
                  const key = `col${def.columns.length + 1}`;
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
                      title={fed ? 'Filled by the bracket — edit the round before it' : undefined}
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
                  title="Remove row"
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
          + Row
        </button>
      </div>
    </div>
  );
}
