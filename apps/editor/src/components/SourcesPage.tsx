// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The Data sources page (0.80.0) — every source on the server, in one place.
 *
 * Opened from the portal, beside Connections and Activity, and laid out like
 * them. What it adds to the editor's data panel is the view across projects:
 * the server-level sources with the projects linked to each, then every
 * project's own, each with how long ago it last synced and a Refresh.
 *
 * Server-level sources are made and edited here, in the same form the editor
 * uses (`SourceEditor`), pointed at the server scope. A project picks one up
 * later from its own data panel — **Add → Link a server source…** — so a
 * source can be set up, checked and left polling before any project uses it.
 *
 * Adding is two steps in one window, on purpose. The first shows what kinds of
 * source there are with a line on each: someone arriving from the portal has
 * not been reading a menu of abbreviations in the editor all afternoon, and
 * "HTTP CSV / Google Sheet" alone does not say which one their feed is.
 */

import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  SERVER_SCOPE,
  isPolledSource,
  type DataSourceDef,
  type DataSourceStatus,
  type SourceUse,
} from '@breeze/schema';
import { useRichT, useT, type Translate } from '@breeze/i18n/react';

import { api, type AllSources, type ServerSourceSummary } from '../api/client.js';
import { MENU, SourceEditor, TYPE_LABEL_KEY, ago, blankSource, withoutBlankChecks } from './DataPanel.js';
import { FloatingDialog } from './FloatingDialog.js';

/**
 * What can be added here: the fetched kinds. A manual table, a poll and a text
 * typed into a project hold one show's state and stay in that project (decided
 * 2026-11-09) — the server refuses them too; leaving them off the list is so
 * nobody fills in a form to find that out.
 */
const SERVER_TYPES: ReadonlyArray<{ type: DataSourceDef['type']; aboutKey: string }> = [
  { type: 'http-csv', aboutKey: 'editor.sources.aboutHttpCsv' },
  { type: 'http-json', aboutKey: 'editor.sources.aboutHttpJson' },
  { type: 'rss', aboutKey: 'editor.sources.aboutRss' },
  { type: 'xml', aboutKey: 'editor.sources.aboutXml' },
  { type: 'sheets', aboutKey: 'editor.sources.aboutSheets' },
  { type: 'weather', aboutKey: 'editor.sources.aboutWeather' },
  { type: 'air-quality', aboutKey: 'editor.sources.aboutAirQuality' },
  { type: 'cap', aboutKey: 'editor.sources.aboutCap' },
  { type: 'ftp', aboutKey: 'editor.sources.aboutFtp' },
];

const MENU_LABEL = new Map(MENU.map((m) => [m.type, m.labelKey]));

/** How often the list is re-read. The rows say *when*, so a still page is wrong within seconds. */
const POLL_MS = 5000;

type Health = 'live' | 'failing' | 'expired' | 'stuck' | 'backup' | 'off' | 'waiting';

/** One word for how a source is doing — the worst thing true of it, in the order an operator cares. */
function healthOf(def: DataSourceDef, status: DataSourceStatus): Health {
  // Rows typed into a project are never waiting on anything.
  if (!isPolledSource(def)) return 'live';
  if (def.enabled === false) return 'off';
  if (status.expired) return 'expired';
  if (status.stuck) return 'stuck';
  if ((status.failures ?? 0) > 0) return 'failing';
  if (status.serving !== undefined) return 'backup';
  if (!status.lastSuccess) return 'waiting';
  return 'live';
}

const HEALTH_KEY: Record<Health, string> = {
  live: 'editor.sources.healthLive',
  failing: 'editor.sources.healthFailing',
  expired: 'editor.sources.healthExpired',
  stuck: 'editor.sources.healthStuck',
  backup: 'editor.sources.healthBackup',
  off: 'editor.sources.healthOff',
  waiting: 'editor.sources.healthWaiting',
};

/** A wait as a clock once it is over a minute — `4:39` — and as seconds under it. */
function wait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`; // i18n-ignore — a unit suffix inside a translated sentence
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; // i18n-ignore — a clock
}

/** "Every 30 s", in the unit that reads best at its size. */
function every(seconds: number, t: Translate): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return t('editor.sources.everyHours', { count: seconds / 3600 });
  if (seconds >= 60 && seconds % 60 === 0) return t('editor.sources.everyMinutes', { count: seconds / 60 });
  return t('editor.sources.everySeconds', { count: seconds });
}

export function SourcesPage(): JSX.Element {
  const t = useT();
  const rt = useRichT();
  const [all, setAll] = useState<AllSources | null>(null);
  /** When `all` arrived, so each row's "refresh in" counts down between reads. */
  const [readAt, setReadAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The add window is on its first step: choosing a kind. */
  const [picking, setPicking] = useState(false);
  /** The server-level source in the form, new or existing. */
  const [editing, setEditing] = useState<DataSourceDef | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const fail = (err: unknown): void => setError(err instanceof Error ? err.message : String(err));

  const reload = useCallback(async () => {
    try {
      setAll(await api.listAllSources());
      setReadAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  // The countdown on a held Refresh, and the "ago" readings, move between reads.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    document.title = t('editor.sources.documentTitle');
  }, [t]);

  const server = all?.server ?? [];
  const isNew = editing !== null && !server.some((s) => s.def.id === editing.id);

  const save = async (def: DataSourceDef): Promise<void> => {
    try {
      await api.saveDataSource(SERVER_SCOPE, withoutBlankChecks(def));
      setEditing(null);
      setNotice(null);
      await reload();
    } catch (err) {
      fail(err);
    }
  };

  /** Seconds until Refresh will fetch for this row, counted down from the last read. */
  const heldFor = (row: ServerSourceSummary): number =>
    Math.max(0, row.refreshIn - Math.floor((now - readAt) / 1000));

  const refresh = async (scope: string, row: ServerSourceSummary): Promise<void> => {
    setBusy(`${scope}/${row.def.id}`);
    try {
      const result = await api.refreshDataSource(scope, row.def.id);
      setNotice(
        result.throttled
          ? t('editor.data.refreshThrottled', { name: row.def.name, seconds: result.throttled.retryIn })
          : null,
      );
      await reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (row: ServerSourceSummary): Promise<void> => {
    if (!confirm(t('editor.data.deleteConfirm', { name: row.def.name }))) return;
    try {
      await api.deleteDataSource(SERVER_SCOPE, row.def.id);
      await reload();
    } catch (err) {
      // The server refuses while a project links to it, and says which.
      fail(err);
    }
  };

  const move = async (projectId: string, row: ServerSourceSummary): Promise<void> => {
    if (!confirm(t('editor.data.moveToServerConfirm', { name: row.def.name }))) return;
    try {
      await api.moveSourceToServer(projectId, row.def.id);
      setNotice(t('editor.data.movedToServer', { name: row.def.name }));
      await reload();
    } catch (err) {
      fail(err);
    }
  };

  /** The cells every row shares: the source, its kind, its last sync, its rows. */
  const source = (row: ServerSourceSummary): JSX.Element => {
    const { def, status } = row;
    const health = healthOf(def, status);
    return (
      <td className="sp-source">
        <div className="sp-name">
          <span
            className={`sp-dot ${health}`} // i18n-ignore — className
            title={t(HEALTH_KEY[health])}
          />
          <strong>{def.name}</strong> <code>{def.id}</code>
        </div>
        {status.lastError && <div className="source-error">{status.lastError}</div>}
        {status.warning && <div className="source-warning">{status.warning}</div>}
        {status.expired && <div className="source-error">{t('editor.data.expired')}</div>}
        {status.stuck && <div className="source-error">{t('editor.data.guard.stuck')}</div>}
        {status.serving !== undefined && (
          <div className="source-warning">{t('editor.data.guard.serving', { name: status.serving })}</div>
        )}
      </td>
    );
  };

  const kind = (row: ServerSourceSummary): JSX.Element => (
    <td>
      {t(TYPE_LABEL_KEY[row.def.type])}
      {row.interval > 0 && <div className="sp-sub">{every(row.interval, t)}</div>}
    </td>
  );

  const synced = (row: ServerSourceSummary): JSX.Element => {
    const { def, status } = row;
    const health = healthOf(def, status);
    return (
      <td className="sp-sync">
        <span
          className={`sp-health ${health}`} // i18n-ignore — className
        >
          {t(HEALTH_KEY[health])}
        </span>
        {/* The last fetch that worked: a failed try an instant ago is not a sync. */}
        <div title={status.lastSuccess}>
          {status.lastSuccess
            ? t('editor.sources.syncedAgo', { when: ago(status.lastSuccess, t) })
            : t('editor.sources.neverSynced')}
        </div>
        {(status.failures ?? 0) > 0 && (
          <div className="sp-sub" title={status.lastFetch}>
            {t('editor.sources.triedAgo', { when: ago(status.lastFetch, t), count: status.failures ?? 0 })}
          </div>
        )}
      </td>
    );
  };

  const refreshButton = (scope: string, row: ServerSourceSummary): JSX.Element => {
    const held = heldFor(row);
    const working = busy === `${scope}/${row.def.id}`;
    return (
      <button
        disabled={held > 0 || working}
        title={held > 0 ? t('editor.sources.refreshHeldTitle', { seconds: held }) : t('editor.sources.refreshTitle')}
        onClick={() => void refresh(scope, row)}
      >
        {working
          ? t('editor.data.fetching')
          : held > 0
            ? t('editor.sources.refreshIn', { when: wait(held) })
            : t('editor.data.refresh')}
      </button>
    );
  };

  return (
    <div className="sources-page">
      <header>
        <a className="pill" href="/">{t('editor.sources.portalLink')}</a>
        <h1>{t('editor.sources.title')}</h1>
        <button className="pill primary" onClick={() => setPicking(true)}>
          {t('editor.sources.add')}
        </button>
      </header>

      <p className="hint sp-intro">
        {rt('editor.sources.intro', {
          menu: <em>{t('editor.sources.introMenu')}</em>,
        })}
      </p>

      {error && <div className="sp-banner error">{error}</div>}
      {notice && <div className="sp-banner">{notice}</div>}

      <section>
        <h2>
          {t('editor.sources.serverHeading')} <span className="count">{server.length}</span>
        </h2>
        {all !== null && server.length === 0 ? (
          <p className="hint">{t('editor.sources.serverEmpty')}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="c-source">{t('editor.sources.colSource')}</th>
                <th className="c-kind">{t('editor.sources.colKind')}</th>
                <th className="c-linked">{t('editor.sources.colLinked')}</th>
                <th className="c-sync">{t('editor.sources.colSync')}</th>
                <th className="c-rows num">{t('editor.sources.colRows')}</th>
                <th className="c-actions" />
              </tr>
            </thead>
            <tbody>
              {server.map((row) => (
                <tr key={row.def.id} className={healthOf(row.def, row.status)}>
                  {source(row)}
                  {kind(row)}
                  <td className="sp-links">
                    {(row.links ?? []).length === 0 ? (
                      <span className="hint">{t('editor.sources.notLinked')}</span>
                    ) : (
                      (row.links ?? []).map((l) => (
                        <span key={`${l.project}/${l.id}`} className="sp-chip" title={l.project}>
                          {l.projectName}
                        </span>
                      ))
                    )}
                  </td>
                  {synced(row)}
                  <td className="num">{row.rowCount}</td>
                  <td className="sp-actions">
                    {row.def.fallback !== undefined && (
                      <select
                        value={row.status.use ?? 'auto'}
                        title={t('editor.data.guard.useTitle')}
                        onChange={(e) =>
                          void api
                            .setDataSourceUse(SERVER_SCOPE, row.def.id, e.target.value as SourceUse)
                            .then(reload)
                            .catch(fail)
                        }
                      >
                        <option value="auto">{t('editor.data.guard.useAuto')}</option>
                        <option value="primary">{t('editor.data.guard.usePrimary')}</option>
                        <option value="backup">{t('editor.data.guard.useBackup')}</option>
                      </select>
                    )}
                    <button onClick={() => setEditing(row.def)}>{t('editor.data.edit')}</button>
                    {refreshButton(SERVER_SCOPE, row)}
                    <button
                      disabled={(row.links ?? []).length > 0}
                      title={(row.links ?? []).length > 0 ? t('editor.sources.deleteLinkedTitle') : undefined}
                      onClick={() => void remove(row)}
                    >
                      {t('editor.bin.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>{t('editor.sources.projectsHeading')}</h2>
        <p className="hint">{t('editor.sources.projectsHint')}</p>
        {all !== null && all.projects.length === 0 && <p className="hint">{t('editor.sources.projectsEmpty')}</p>}
        {(all?.projects ?? []).map((project) => (
          <div key={project.id} className="sp-project">
            <h3>
              {project.name} <code>{project.id}</code>
            </h3>
            <table>
              <thead>
                <tr>
                  <th className="c-source">{t('editor.sources.colSource')}</th>
                  <th className="c-kind">{t('editor.sources.colKind')}</th>
                  <th className="c-sync wide">{t('editor.sources.colSync')}</th>
                  <th className="c-rows num">{t('editor.sources.colRows')}</th>
                  <th className="c-actions" />
                </tr>
              </thead>
              <tbody>
                {project.sources.map((row) => (
                  <tr key={row.def.id} className={healthOf(row.def, row.status)}>
                    {source(row)}
                    {kind(row)}
                    {isPolledSource(row.def) ? synced(row) : <td className="hint">{t('editor.sources.typedIn')}</td>}
                    <td className="num">{row.rowCount}</td>
                    <td className="sp-actions">
                      {isPolledSource(row.def) && refreshButton(project.id, row)}
                      {isPolledSource(row.def) && (
                        <button title={t('editor.data.moveToServerTitle')} onClick={() => void move(project.id, row)}>
                          {t('editor.data.moveToServer')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <footer>
        <p>{t('editor.sources.footerLimits', { seconds: all?.minPollInterval ?? 5 })}</p>
        <p>{t('editor.sources.footerDelete')}</p>
      </footer>

      {picking && (
        <FloatingDialog
          title={t('editor.sources.pickTitle')}
          label={t('editor.sources.pickTitle')}
          closeLabel={t('editor.data.dialogClose')}
          onClose={() => setPicking(false)}
        >
          <div className="source-editor sp-kinds">
            <p className="hint">{t('editor.sources.pickHint')}</p>
            {SERVER_TYPES.map(({ type, aboutKey }) => (
              <button
                key={type}
                className="sp-kind"
                onClick={() => {
                  setPicking(false);
                  setEditing(blankSource(type, `src${Date.now().toString(36)}`));
                }}
              >
                <strong>{t(MENU_LABEL.get(type) ?? TYPE_LABEL_KEY[type])}</strong>
                <span>{t(aboutKey)}</span>
              </button>
            ))}
            <div className="source-actions">
              <button onClick={() => setPicking(false)}>{t('editor.upload.cancel')}</button>
            </div>
          </div>
        </FloatingDialog>
      )}

      {editing &&
        (() => {
          const title = isNew ? t('editor.data.dialogNew') : t('editor.data.dialogEdit', { name: editing.name });
          return (
            <FloatingDialog
              title={title}
              label={title}
              closeLabel={t('editor.data.dialogClose')}
              onClose={() => setEditing(null)}
            >
              <SourceEditor
                projectId={SERVER_SCOPE}
                others={server.map((s) => s.def).filter((d) => d.id !== editing.id)}
                def={editing}
                onChange={setEditing}
                onCancel={() => setEditing(null)}
                onSave={() => void save(editing)}
              />
            </FloatingDialog>
          );
        })()}
    </div>
  );
}
