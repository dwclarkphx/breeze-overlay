// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Operator panel client.
 *
 * Deliberately dependency-free and tiny: this runs on whatever tablet is at the
 * desk, and it must come up fast and stay up. The page is already rendered by
 * the server, so this only wires behavior.
 */

// Makes this file a module, which `declare global` below requires. esbuild
// still emits it as a plain IIFE for the page.
export {};

import { bootI18n } from './i18n.js';

interface Binding {
  name: string;
  kind: string;
  label: string;
  defaultValue: unknown;
  source?: string;
  column?: string;
  readOnly?: boolean;
  sourceName?: string;
  sourceType?: string;
}

declare global {
  interface Window {
    __BREEZE_CONTROL__?: {
      projectId: string;
      compositionId: string;
      bindings: Binding[];
      schema: Record<string, unknown>;
      stepCount: number;
      /** Reserved update key carrying `{ [sourceId]: DataSet }`. */
      dataKey: string;
      /** Server-side snapshot, so fed fields have values on first paint. */
      datasets: Record<string, DatasetValue & { fetchedAt?: string }>;
      /** Independently triggered elements, when this composition is a scene. */
      elements?: Array<{ layerId: string; name: string; ref: string; channel: string }>;
      /** Fetched sources this graphic reads, with their backups (Wave 5). */
      sources?: Array<{ id: string; name: string; backup?: string; backupName?: string; media?: boolean; fed?: boolean }>;
      /** The project's mode, and the modes its rules name (Wave 6). */
      mode?: string;
      modes?: string[];
      /** The installation's locale, and this panel's slice of the catalogue. */
      locale?: string;
      messages?: Record<string, string>;
    };
  }
}

const { t, locale } = bootI18n(window.__BREEZE_CONTROL__);

interface DatasetValue {
  columns: Array<{ key: string; label?: string; type: string }>;
  rows: Array<Record<string, unknown>>;
}

interface DatasetGrid {
  el: HTMLElement;
  value(): DatasetValue;
}

/**
 * Grid editor for a `dataset` binding — a manual table an operator can edit on
 * air.
 *
 * Editable cells rather than a JSON textarea, because the people using this are
 * driving a show from a tablet in a gallery and "fix the JSON" is not a thing
 * anyone can do at 19:59. Paste is handled too: a block copied from a
 * spreadsheet arrives as TSV, which is the fastest way to get a standings table
 * in and the workflow every scorer already has.
 */
function makeDatasetGrid(
  binding: Binding,
  onCommit: () => void,
): DatasetGrid {
  const initial = (binding.defaultValue ?? { columns: [], rows: [] }) as DatasetValue;
  const columns = initial.columns ?? [];
  let rows: Array<Record<string, unknown>> = (initial.rows ?? []).map((r) => ({ ...r }));

  const wrap = document.createElement('div');
  wrap.className = 'grid-wrap';

  const caption = document.createElement('span');
  caption.className = 'grid-caption';
  caption.textContent = binding.label || binding.name;
  wrap.appendChild(caption);

  const table = document.createElement('table');
  table.className = 'grid';
  wrap.appendChild(table);

  const actions = document.createElement('div');
  actions.className = 'grid-actions';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = t('control.addRow');
  actions.appendChild(addBtn);
  wrap.appendChild(actions);

  function draw(): void {
    table.textContent = '';

    const head = document.createElement('tr');
    for (const col of columns) {
      const th = document.createElement('th');
      th.textContent = col.label || col.key;
      head.appendChild(th);
    }
    head.appendChild(document.createElement('th'));
    table.appendChild(head);

    rows.forEach((row, index) => {
      const tr = document.createElement('tr');
      for (const col of columns) {
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.value = row[col.key] === null || row[col.key] === undefined ? '' : String(row[col.key]);
        input.inputMode = col.type === 'number' ? 'decimal' : 'text';
        input.addEventListener('input', () => {
          // Typed at the edge, so a numeric column keeps sorting numerically
          // however the operator typed it.
          const raw = input.value;
          row[col.key] =
            col.type === 'number' && raw.trim() !== '' && Number.isFinite(Number(raw))
              ? Number(raw)
              : raw;
        });
        input.addEventListener('keydown', (e) => {
          if ((e as KeyboardEvent).key === 'Enter') onCommit();
        });
        input.addEventListener('paste', (e) => {
          const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
          if (!/[\t\n]/.test(text)) return; // a plain value: let the browser handle it
          e.preventDefault();
          pasteBlock(text, index, columns.findIndex((c) => c.key === col.key));
          draw();
          onCommit();
        });
        td.appendChild(input);
        tr.appendChild(td);
      }

      const del = document.createElement('td');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'grid-del';
      btn.textContent = '×';
      btn.title = t('control.removeRow');
      btn.addEventListener('click', () => {
        rows.splice(index, 1);
        draw();
        onCommit();
      });
      del.appendChild(btn);
      tr.appendChild(del);

      table.appendChild(tr);
    });
  }

  /** Spill a pasted TSV block across the grid from the focused cell. */
  function pasteBlock(text: string, atRow: number, atCol: number): void {
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    lines.forEach((line, r) => {
      const cells = line.split('\t');
      const target = atRow + r;
      while (rows.length <= target) rows.push({});
      const row = rows[target]!;
      cells.forEach((cell, c) => {
        const col = columns[atCol + c];
        if (!col) return;
        row[col.key] =
          col.type === 'number' && cell.trim() !== '' && Number.isFinite(Number(cell))
            ? Number(cell)
            : cell;
      });
    });
  }

  addBtn.addEventListener('click', () => {
    const blank: Record<string, unknown> = {};
    for (const col of columns) blank[col.key] = col.type === 'number' ? 0 : '';
    rows.push(blank);
    draw();
  });

  draw();

  return {
    el: wrap,
    value: () => ({ columns, rows: rows.map((r) => ({ ...r })) }),
  };
}

/* ------------------------------------------------------------- fed fields */

interface FedField {
  el: HTMLElement;
  /** Repaint from a DataSet. Called on first paint and on every push. */
  render(data: DatasetValue & { fetchedAt?: string } | undefined): void;
}

/** `2026-08-03T01:42:07.000Z` → `01:42:07`, in the operator's own zone. */
function shortTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  // The installation's locale, not the browser's. Everything else on this page
  // follows BREEZE_LOCALE, and a clock that alone followed the tablet it was
  // opened on would be the one readout that disagreed with the rest.
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString(locale, { hour12: false });
}

/**
 * Read-only view of a field fed by a data source.
 *
 * Three shapes, because three kinds of layer read a source and an operator
 * checking a graphic before air wants to see what that layer will actually
 * show, not a generic JSON dump:
 *   - a one-row DataSet renders as its key/value pairs — the weather bug,
 *     where "is the temperature sane?" is the entire question;
 *   - a multi-row DataSet renders as a table, like the standings;
 *   - a crawl renders as the list of items it will scroll, in order.
 */
function makeFedField(binding: Binding): FedField {
  const wrap = document.createElement('div');
  wrap.className = 'fed';

  const caption = document.createElement('span');
  caption.className = 'grid-caption';

  const title = document.createElement('strong');
  title.textContent = binding.label || binding.name;
  const tag = document.createElement('span');
  tag.className = 'fed-tag';
  // The tag shows the source *type*, a frozen enum value. The fallback shares
  // the slot with it, so translating only the fallback would make one badge
  // switch language by code path. No marker: both are lowercase single words,
  // which the detector already declines to treat as prose — and if either ever
  // became `Fed` or `Idle`, the ratchet noticing is the right outcome.
  tag.textContent = binding.sourceType ?? 'fed';
  tag.title = binding.sourceName
    ? t('control.fedByNamed', { name: binding.sourceName, id: binding.source })
    : t('control.fedBy', { id: binding.source });
  const when = document.createElement('span');
  when.className = 'fed-when';

  caption.append(title, tag, when);
  wrap.appendChild(caption);

  const body = document.createElement('div');
  wrap.appendChild(body);

  function empty(message: string): void {
    body.textContent = '';
    const p = document.createElement('div');
    p.className = 'fed-empty';
    p.textContent = message;
    body.appendChild(p);
  }

  function render(data: (DatasetValue & { fetchedAt?: string }) | undefined): void {
    when.textContent = shortTime(data?.fetchedAt);

    const rows = data?.rows ?? [];
    const columns = data?.columns ?? [];
    if (!rows.length) {
      // Distinguished deliberately from "no rows": a source that has not
      // answered yet and a source that answered with nothing are different
      // problems, and the operator is the one who has to tell them apart.
      empty(t(data ? 'control.noRows' : 'control.awaitingFirstPoll'));
      return;
    }

    body.textContent = '';

    if (binding.kind === 'stringList') {
      const key = binding.column ?? columns[0]?.key;
      const list = document.createElement('ul');
      list.className = 'fed-list';
      for (const row of rows) {
        const li = document.createElement('li');
        li.textContent = key ? String(row[key] ?? '') : '';
        list.appendChild(li);
      }
      body.appendChild(list);
      return;
    }

    // One row reads better as a label/value stack than as a one-line table:
    // a weather DataSet is 17 columns wide and the operator would be scrolling
    // sideways to find the temperature.
    if (rows.length === 1 && columns.length > 3) {
      const row = rows[0]!;
      const table = document.createElement('table');
      for (const col of columns) {
        const value = row[col.key];
        if (value === null || value === undefined || value === '') continue;
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.textContent = col.label || col.key;
        const td = document.createElement('td');
        td.textContent = String(value);
        tr.append(th, td);
        table.appendChild(tr);
      }
      body.appendChild(table);
      return;
    }

    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const col of columns) {
      const th = document.createElement('th');
      th.textContent = col.label || col.key;
      head.appendChild(th);
    }
    table.appendChild(head);
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const col of columns) {
        const td = document.createElement('td');
        const value = row[col.key];
        td.textContent = value === null || value === undefined ? '' : String(value);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    body.appendChild(table);
  }

  return { el: wrap, render };
}

/**
 * Wire the per-element blocks on a scene's panel.
 *
 * Verbs go out over REST, not over this page's websocket. That socket is
 * subscribed to the scene's own channel, and making it carry element commands
 * would mean one socket serving several channels — the complication the
 * renderer deliberately avoids too. The REST triggers already exist, sit behind
 * the same auth hook, and are the very URLs an operator puts on a Stream Deck,
 * so the panel presses exactly the buttons the hardware does.
 *
 * A second socket per element carries the status readout only. It subscribes as
 * a controller, so it never receives commands and cannot put anything on air.
 */
function wireSceneElements(boot: NonNullable<Window['__BREEZE_CONTROL__']>, key: string): void {
  const elements = boot.elements ?? [];
  if (elements.length === 0) return;

  const auth = key ? `?key=${encodeURIComponent(key)}` : '';

  const trigger = (channel: string, verb: string): void => {
    void fetch(`/api/control/${encodeURIComponent(boot.projectId)}/${encodeURIComponent(channel)}/${verb}${auth}`, {
      method: 'POST',
    }).catch(() => {
      /* A failed trigger must not throw into the console and take the panel
         down; the status readout going stale is the visible symptom. */
    });
  };

  for (const element of elements) {
    const block = document.querySelector<HTMLElement>(`.element[data-channel="${CSS.escape(element.channel)}"]`);
    if (!block) continue;

    const stateEl = block.querySelector<HTMLElement>('[data-role="state"]');

    block.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-el-verb]');
      if (!button) return;
      trigger(element.channel, button.dataset['elVerb']!);
    });

    // Status only. Subscribed as a controller, which never receives commands.
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    let retry = 0;

    const connect = (): void => {
      const socket = new WebSocket(`${scheme}://${location.host}/ws/control`);

      socket.addEventListener('open', () => {
        retry = 0;
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            channel: `${boot.projectId}/${element.channel}`,
            role: 'controller',
            // Readout only — one of these per element, so they must not each
            // count as a panel connecting. See `ControllerKind`.
            client: 'monitor',
          }),
        );
      });

      socket.addEventListener('message', (event) => {
        let message: {
          type: string;
          state?: { renderers: number; playback?: { state: string; step: number; stepCount: number } | null };
        };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!message.state || !stateEl) return;

        const playback = message.state.playback;
        if (message.state.renderers === 0) {
          stateEl.textContent = t('control.noOutput');
          return;
        }
        // `playback.state` is a frozen enum and so is the `idle` it falls back
        // to — see the fed tag above for why the pair stays together.
        stateEl.textContent = playback
          ? t('control.playbackStep', {
              state: playback.state,
              step: playback.step,
              stepCount: playback.stepCount,
            })
          : 'idle';
      });

      socket.addEventListener('close', () => {
        retry = Math.min(retry + 1, 6);
        setTimeout(connect, Math.min(500 * 2 ** retry, 10_000));
      });
      socket.addEventListener('error', () => socket.close());
    };

    connect();
  }

  document.getElementById('clear-all')?.addEventListener('click', () => {
    void fetch(
      `/api/control/${encodeURIComponent(boot.projectId)}/${encodeURIComponent(boot.compositionId)}/clear-all${auth}`,
      { method: 'POST' },
    ).catch(() => {});
  });
}

/** One paged table, as the output page reports it (hub `TableReport`). */
interface TableReport {
  table: string;
  page: number;
  pageCount: number;
  key: string | null;
  hasCycle: boolean;
  cycling: boolean;
  held: boolean;
  secondsLeft: number | null;
  group?: string;
  follows?: string;
}

/**
 * The POST body the REST fallback sends for a command.
 *
 * `update` and `play` carry field values; the table verbs carry their own
 * parameters under the names the REST routes read — `name`, not `key`, for a
 * page key, because `key` on a control URL is the API key.
 */
function restBody(command: Record<string, unknown>): Record<string, unknown> {
  const verb = command['verb'];
  if (verb === 'update' || verb === 'play') return (command['data'] as Record<string, unknown>) ?? {};
  const body: Record<string, unknown> = {};
  if (typeof command['table'] === 'string') body['table'] = command['table'];
  if (verb === 'page') {
    if (typeof command['key'] === 'string') body['name'] = command['key'];
    else if (typeof command['page'] === 'number') body['n'] = command['page'];
  }
  if (verb === 'cycle') body['state'] = command['cycle'];
  return body;
}

/**
 * The paged-tables block: which page each table is on, when it will turn, and
 * the buttons to turn it.
 *
 * Built from what the output page *reports*, never from the composition: a
 * table's page count depends on the data it holds, which only the output knows.
 * The countdown ticks locally between reports — a report arrives when a page
 * turns, not every second, and the panel should not have to ask.
 */
function makePageList(
  section: HTMLElement | null,
  list: HTMLElement | null,
  send: (command: Record<string, unknown>) => void,
): { render(tables: TableReport[] | undefined): void } {
  if (!section || !list) return { render: () => {} };

  interface RowState {
    el: HTMLElement;
    at: HTMLElement;
    when: HTMLElement;
    follows: HTMLElement;
    bar: HTMLElement;
    hold: HTMLButtonElement | null;
    report: TableReport;
    /** When the next turn is due, locally — null when not cycling. */
    deadline: number | null;
    /** Seconds the current page was given, for the bar. */
    total: number;
  }

  const rows = new Map<string, RowState>();

  const button = (label: string, command: Record<string, unknown>): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => send(command));
    return b;
  };

  const build = (report: TableReport): RowState => {
    const el = document.createElement('div');
    el.className = 'page-row';
    const head = document.createElement('div');
    head.className = 'page-head';
    const at = document.createElement('span');
    at.className = 'page-at';
    const name = document.createElement('code');
    name.className = 'page-name';
    name.textContent = report.table;
    // A follower turns with its leader; saying so explains a page the
    // operator did not ask for.
    const follows = document.createElement('span');
    follows.className = 'page-follows';
    const when = document.createElement('span');
    when.className = 'page-when';
    head.append(at, name, follows, when);

    const barWrap = document.createElement('div');
    barWrap.className = 'page-bar';
    const bar = document.createElement('i');
    barWrap.appendChild(bar);

    const verbs = document.createElement('div');
    verbs.className = 'verbs';
    verbs.append(
      button(t('control.pagePrev'), { verb: 'prev', table: report.table }),
      button(t('control.pageNext'), { verb: 'next', table: report.table }),
    );
    let hold: HTMLButtonElement | null = null;
    if (report.hasCycle) {
      hold = document.createElement('button');
      hold.type = 'button';
      const target = hold;
      hold.addEventListener('click', () => {
        const held = target.getAttribute('aria-pressed') === 'true';
        send({ verb: 'cycle', cycle: held ? 'resume' : 'hold', table: report.table });
      });
      verbs.appendChild(hold);
    }

    el.append(head, barWrap, verbs);
    return { el, at, when, follows, bar, hold, report, deadline: null, total: 0 };
  };

  const paint = (row: RowState): void => {
    const r = row.report;
    row.at.textContent = r.key
      ? t('control.pageAt', { key: r.key, page: r.page + 1, pageCount: r.pageCount })
      : t('control.pageAtNoKey', { page: r.page + 1, pageCount: r.pageCount });
    row.follows.textContent = r.follows ? t('control.pageFollows', { table: r.follows }) : '';
    if (row.hold) {
      row.hold.setAttribute('aria-pressed', String(r.held));
      row.hold.textContent = t(r.held ? 'control.cycleResume' : 'control.cycleHold');
    }
    if (r.held) {
      row.when.textContent = t('control.pageHeld');
      row.bar.style.width = '0';
      return;
    }
    if (row.deadline === null) {
      row.when.textContent = '';
      row.bar.style.width = '0';
      return;
    }
    const left = Math.max(0, (row.deadline - Date.now()) / 1000);
    row.when.textContent = t('control.pageNextIn', { seconds: Math.ceil(left) });
    const done = row.total > 0 ? 1 - left / row.total : 0;
    row.bar.style.width = `${Math.round(Math.min(1, Math.max(0, done)) * 100)}%`;
  };

  // One ticker for every row, running only while something is counting down.
  let ticker: ReturnType<typeof setInterval> | null = null;
  const tick = (): void => {
    let counting = false;
    for (const row of rows.values()) {
      paint(row);
      if (row.deadline !== null && !row.report.held) counting = true;
    }
    if (!counting && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };

  return {
    render(tables) {
      if (!tables || tables.length === 0) {
        section.hidden = true;
        list.textContent = '';
        rows.clear();
        return;
      }
      section.hidden = false;

      const seen = new Set<string>();
      for (const report of tables) {
        seen.add(report.table);
        let row = rows.get(report.table);
        if (!row || row.report.hasCycle !== report.hasCycle) {
          row?.el.remove();
          row = build(report);
          rows.set(report.table, row);
        }
        const turned = row.report.page !== report.page || row.deadline === null;
        row.report = report;
        if (report.cycling && report.secondsLeft !== null) {
          row.deadline = Date.now() + report.secondsLeft * 1000;
          // The page's full time is only known when it arrives; a report in
          // the middle of a page must not shrink the bar's scale.
          if (turned || report.secondsLeft > row.total) row.total = report.secondsLeft;
        } else {
          row.deadline = null;
        }
        list.appendChild(row.el);
      }
      for (const [name, row] of rows) {
        if (seen.has(name)) continue;
        row.el.remove();
        rows.delete(name);
      }

      tick();
      if (!ticker && [...rows.values()].some((r) => r.deadline !== null)) {
        ticker = setInterval(tick, 250);
      }
    },
  };
}

/** A source's health, as `/api/projects/:id/datasources` reports it. */
interface SourceHealth {
  media?: { ok: number; failed: number; frozen: number; unchecked: number };
  failures?: number;
  lastSuccess?: string;
  lastError?: string;
  expired?: boolean;
  stuck?: boolean;
  serving?: string;
  use?: 'primary' | 'backup';
}

/**
 * The Data block (CYCLE.md, Wave 5): what each feed this graphic reads is
 * doing, and — where it has a backup — the switch to put the backup on air.
 *
 * Polled, not pushed: source health lives in the data registry, which has no
 * socket to panels, and a feed's state changes on the scale of its poll
 * interval, not of a button press. The switch answers with the new status, so
 * a press shows at once. Stopped while the tab is hidden, like the fed fields.
 */
function wireSources(boot: NonNullable<Window['__BREEZE_CONTROL__']>, key: string): void {
  const sources = boot.sources ?? [];
  const section = document.getElementById('sources');
  const list = document.getElementById('source-list');
  if (!section || !list || sources.length === 0) return;
  section.hidden = false;

  const auth = key ? `?key=${encodeURIComponent(key)}` : '';
  // i18n-ignore-next-line — an API path, frozen per I18N.md §2
  const base = `/api/projects/${encodeURIComponent(boot.projectId)}/datasources`;

  const rows = new Map<string, { state: HTMLElement; media: HTMLElement | null; buttons: Map<string, HTMLButtonElement> }>();
  const render = (id: string, status: SourceHealth): void => {
    const row = rows.get(id);
    const source = sources.find((s) => s.id === id);
    if (!row || !source) return;
    let text: string;
    let tone = '';
    if (status.serving !== undefined) {
      text = t('control.sourceBackup', { name: source.backupName ?? status.serving });
      tone = 'warn';
    } else if (status.expired) {
      text = t('control.sourceExpired');
      tone = 'bad';
    } else if (status.stuck) {
      text = t('control.sourceStuck');
      tone = 'bad';
    } else if ((status.failures ?? 0) > 0) {
      text = t('control.sourceFailing');
      tone = 'warn';
    } else if (!status.lastSuccess) {
      text = t('control.sourceWaiting');
    } else {
      text = t('control.sourceLive');
    }
    if (status.use) text = t('control.sourceOverride', { state: text });
    /*
     * A camera list (Wave 8): how many cameras are up. For a typed list that
     * is the whole story — it has no fetch of its own to report on.
     */
    if (row.media) {
      const m = status.media;
      const down = m ? m.failed + m.frozen : 0;
      row.media.textContent = m ? t('control.sourceMedia', { ok: m.ok + m.unchecked, down }) : '';
      row.media.classList.toggle('bad', down > 0);
      if (source.fed === false) {
        text = '';
        tone = '';
      }
    }
    row.state.textContent = text;
    row.state.classList.toggle('warn', tone === 'warn');
    row.state.classList.toggle('bad', tone === 'bad');
    row.state.title = status.lastError ?? '';
    const mode = status.use ?? 'auto';
    for (const [value, button] of row.buttons) button.setAttribute('aria-pressed', String(value === mode));
  };

  const MODES: Array<[string, string]> = [
    ['auto', 'control.useAuto'],
    ['primary', 'control.usePrimary'],
    ['backup', 'control.useBackup'],
  ];

  for (const source of sources) {
    const el = document.createElement('div');
    el.className = 'src-row';
    const head = document.createElement('div');
    head.className = 'src-head';
    const name = document.createElement('span');
    name.className = 'src-name';
    name.textContent = source.name;
    const state = document.createElement('span');
    state.className = 'src-state';
    head.append(name, state);
    let media: HTMLElement | null = null;
    if (source.media) {
      media = document.createElement('span');
      media.className = 'src-state src-media';
      head.appendChild(media);
    }
    el.appendChild(head);

    const buttons = new Map<string, HTMLButtonElement>();
    if (source.backup !== undefined) {
      const verbs = document.createElement('div');
      verbs.className = 'verbs';
      for (const [mode, labelKey] of MODES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = t(labelKey);
        b.addEventListener('click', () => {
          void fetch(`${base}/${encodeURIComponent(source.id)}/use${auth}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode }),
          })
            .then(async (res) => {
              if (!res.ok) return;
              const body = (await res.json()) as { status?: SourceHealth };
              if (body.status) render(source.id, body.status);
            })
            .catch(() => {
              /* The next poll shows whatever actually happened. */
            });
        });
        buttons.set(mode, b);
        verbs.appendChild(b);
      }
      el.appendChild(verbs);
    }
    if (source.media) {
      // Check every camera now — after one has been fixed, or before air.
      const verbs = document.createElement('div');
      verbs.className = 'verbs';
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t('control.mediaCheck');
      b.addEventListener('click', () => {
        b.disabled = true;
        void fetch(`${base}/${encodeURIComponent(source.id)}/media/check${auth}`, { method: 'POST' })
          .then(() => poll())
          .catch(() => undefined)
          .finally(() => {
            b.disabled = false;
          });
      });
      verbs.appendChild(b);
      el.appendChild(verbs);
    }
    list.appendChild(el);
    rows.set(source.id, { state, media, buttons });
  }

  async function poll(): Promise<void> {
    try {
      // An open read: no key in the URL of a request made every ten seconds.
      const res = await fetch(base);
      if (!res.ok) return;
      const body = (await res.json()) as { sources?: Array<{ def: { id: string }; status: SourceHealth }> };
      for (const entry of body.sources ?? []) render(entry.def.id, entry.status);
    } catch {
      // Offline: leave the last state up rather than blanking it.
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  const startPolling = (): void => {
    if (timer) return;
    void poll();
    timer = setInterval(() => void poll(), 10_000);
  };
  const stopPolling = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else startPolling();
  });
  startPolling();
}

/**
 * The Mode block (CYCLE.md, Wave 6): a button per mode the project's rules
 * name, and one to clear it. The mode is project-wide — every graphic with a
 * rule for it follows — so the block says so rather than pretending it
 * belongs to this panel's graphic. Polled like the Data block, and answered
 * at once when pressed.
 */
function wireMode(boot: NonNullable<Window['__BREEZE_CONTROL__']>, key: string): void {
  const modes = boot.modes ?? [];
  const section = document.getElementById('mode');
  const list = document.getElementById('mode-list');
  if (!section || !list || modes.length === 0) return;
  section.hidden = false;

  const auth = key ? `?key=${encodeURIComponent(key)}` : '';
  // i18n-ignore-next-line — an API path, frozen per I18N.md §2
  const base = `/api/projects/${encodeURIComponent(boot.projectId)}/mode`;
  const buttons = new Map<string, HTMLButtonElement>();

  const paint = (mode: string): void => {
    for (const [value, button] of buttons) button.setAttribute('aria-pressed', String(value === mode));
  };

  for (const mode of ['', ...modes]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset['mode'] = mode;
    const none = t('control.modeNone');
    b.textContent = mode || none;
    b.addEventListener('click', () => {
      void fetch(`${base}/set${auth}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: mode }),
      })
        .then(async (res) => {
          if (!res.ok) return;
          const body = (await res.json()) as { mode?: string };
          paint(body.mode ?? '');
        })
        .catch(() => {
          /* The next poll shows whatever actually happened. */
        });
    });
    buttons.set(mode, b);
    list.appendChild(b);
  }
  paint(boot.mode ?? '');

  async function poll(): Promise<void> {
    try {
      const res = await fetch(base);
      if (res.ok) paint(((await res.json()) as { mode?: string }).mode ?? '');
    } catch {
      // Offline: leave the last state lit.
    }
  }

  let timer: ReturnType<typeof setInterval> | null = setInterval(() => void poll(), 10_000);
  document.addEventListener('visibilitychange', () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (document.hidden) return;
    void poll();
    timer = setInterval(() => void poll(), 10_000);
  });
}

const boot = window.__BREEZE_CONTROL__;
if (boot) start(boot);

function start(boot: NonNullable<Window['__BREEZE_CONTROL__']>): void {
  const channel = `${boot.projectId}/${boot.compositionId}`;
  const key = new URLSearchParams(location.search).get('key') ?? '';

  wireSceneElements(boot, key);
  wireSources(boot, key);
  wireMode(boot, key);

  const dot = document.getElementById('dot')!;
  const status = document.getElementById('status')!;
  const stepEl = document.getElementById('step')!;
  const playbackEl = document.getElementById('playback')!;
  const fields = document.getElementById('fields')!;

  /* ------------------------------------------------------------ preview */

  /**
   * The output page, embedded, so the person driving a graphic can see it.
   *
   * A real renderer rather than a mock — the same `/play` URL vMix opens — which
   * is the only way a preview can be trusted: anything re-implemented here would
   * drift from what goes to air and be believed anyway. It subscribes as a
   * `preview`, so it receives every command and is counted as no output at all;
   * the status light above must mean vMix and OBS, never this frame.
   *
   * The iframe is created on show and destroyed on hide rather than kept
   * hidden. A hidden browser source is still a live socket, a GSAP timeline and
   * a video decoder, and a panel left open all evening on a gallery machine
   * should not be paying for a preview nobody is looking at.
   */
  const previewSection = document.getElementById('preview')!;
  const previewFrame = document.getElementById('preview-frame')!;
  const previewToggle = document.getElementById('preview-toggle') as HTMLButtonElement;
  const previewDebug = document.getElementById('preview-debug') as HTMLButtonElement;
  let previewDebugOn = false;

  const previewUrl = (): string => {
    const params = new URLSearchParams({ scale: 'contain', preview: '1' });
    // Debug is read at load by the output page, so toggling it reloads the
    // frame — the honest way to drive a flag the page only reads once.
    if (previewDebugOn) params.set('debug', '1');
    if (key) params.set('key', key);
    return `/play/${boot.projectId}/${boot.compositionId}?${params.toString()}`;
  };

  const renderPreview = (): void => {
    previewFrame.textContent = '';
    const frame = document.createElement('iframe');
    frame.src = previewUrl();
    frame.title = t('control.previewTitle');
    previewFrame.appendChild(frame);
  };

  /*
   * Held here rather than read back off `previewSection.hidden`, which is typed
   * `boolean | string` — the attribute grew a third state (`until-found`) and
   * the DOM lib followed. Reading it back to invert it means widening a
   * tri-state into a boolean on every click; owning the flag says what is meant
   * and cannot drift from the attribute it sets.
   */
  let previewOn = false;

  const showPreview = (on: boolean): void => {
    previewOn = on;
    previewSection.hidden = !on;
    previewToggle.setAttribute('aria-pressed', String(on));
    previewToggle.textContent = t(on ? 'control.previewHide' : 'control.previewShow');
    if (on) renderPreview();
    else previewFrame.textContent = '';
  };

  previewToggle.addEventListener('click', () => showPreview(!previewOn));
  previewDebug.addEventListener('click', () => {
    previewDebugOn = !previewDebugOn;
    previewDebug.setAttribute('aria-pressed', String(previewDebugOn));
    renderPreview();
  });

  /* ------------------------------------------------------------- fields */

  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  /** Dataset bindings are edited as a grid, not a text field. */
  const grids = new Map<string, DatasetGrid>();
  /** Fed bindings are displayed, never edited. Keyed by source id. */
  const fed = new Map<string, FedField>();

  for (const binding of boot.bindings) {
    /*
     * A fed field is built first and returns early, so it never reaches the
     * `inputs`/`grids` maps — which is what keeps it out of `currentData()`
     * and therefore out of the PLAY and UPDATE payloads. Excluding it at
     * render time rather than filtering at send time means there is exactly
     * one place to get this right.
     */
    if (binding.readOnly && binding.source) {
      const field = makeFedField(binding);
      fields.appendChild(field.el);
      fed.set(binding.source, field);
      field.render(boot.datasets?.[binding.source]);
      continue;
    }

    if (binding.kind === 'dataset') {
      const grid = makeDatasetGrid(binding, sendUpdate);
      fields.appendChild(grid.el);
      grids.set(binding.name, grid);
      continue;
    }

    const label = document.createElement('label');
    const caption = document.createElement('span');
    caption.textContent = binding.label || binding.name;

    const multiline = binding.kind === 'stringList';
    const input = document.createElement(multiline ? 'textarea' : 'input') as
      | HTMLInputElement
      | HTMLTextAreaElement;

    input.value = Array.isArray(binding.defaultValue)
      ? binding.defaultValue.join('\n')
      : String(binding.defaultValue ?? '');
    if (multiline) (input as HTMLTextAreaElement).rows = 4;
    input.dataset['binding'] = binding.name;

    // Enter sends immediately on single-line fields — the common case is
    // typing a name and getting it on air without reaching for the mouse.
    if (!multiline) {
      input.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') sendUpdate();
      });
    }

    label.append(caption, input);
    fields.appendChild(label);
    inputs.set(binding.name, input);
  }

  function currentData(): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const [name, input] of inputs) {
      const binding = boot.bindings.find((b) => b.name === name);
      data[name] =
        binding?.kind === 'stringList'
          ? input.value.split('\n').map((s) => s.trim()).filter(Boolean)
          : input.value;
    }
    for (const [name, grid] of grids) data[name] = grid.value();
    return data;
  }

  /* ---------------------------------------------------------- transport */

  let socket: WebSocket | null = null;
  let retry = 0;
  let queued: Array<Record<string, unknown>> = [];

  function setStatus(text: string, cls: '' | 'live' | 'off') {
    status.textContent = text;
    dot.className = `dot ${cls}`;  // i18n-ignore — className
  }

  function connect(): void {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    // The key, when the panel was opened with one, so commands over the socket
    // are allowed; a signed-in browser needs nothing — its session goes along.
    const auth = key ? `?key=${encodeURIComponent(key)}` : '';
    socket = new WebSocket(`${scheme}://${location.host}/ws/control${auth}`);

    socket.addEventListener('open', () => {
      retry = 0;
      socket!.send(
        JSON.stringify({ type: 'subscribe', channel, role: 'controller', client: 'panel' }),
      );
      // Anything typed while disconnected still goes out, so a blip during a
      // rundown does not silently swallow an operator's edit.
      for (const data of queued) send({ verb: 'update', data });
      queued = [];
    });

    socket.addEventListener('message', (event) => {
      let message: {
        type: string;
        code?: string;
        state?: { renderers: number; playback?: unknown; data?: Record<string, unknown> };
      };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === 'welcome' || message.type === 'state') {
        render(message.state);
        renderFed(message.state?.data);
      }
      // A command refused for want of the key: say how to fix it, where the
      // operator is looking, rather than a button that silently does nothing.
      if (message.type === 'error' && message.code === 'error.apiKeyRequired') {
        setStatus(t('control.signInNeeded'), 'off');
      }
    });

    socket.addEventListener('close', () => {
      setStatus('reconnecting…', 'off');
      // Backoff, capped: a control panel left open overnight must not hammer
      // the server, but must recover quickly when it comes back.
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, Math.min(500 * 2 ** retry, 10_000));
    });

    socket.addEventListener('error', () => socket?.close());
  }

  function render(state?: { renderers: number; playback?: unknown }): void {
    if (!state) return;
    const playback = state.playback as
      | { state: string; step: number; stepCount: number; tables?: TableReport[] }
      | null
      | undefined;

    if (state.renderers > 0) {
      setStatus(t('control.outputsConnected', { count: state.renderers }), 'live');
    } else {
      setStatus(t('control.noOutputConnected'), 'off');
    }

    playbackEl.textContent = playback?.state ?? 'idle';
    stepEl.textContent = playback ? `${playback.step}/${playback.stepCount}` : '–';
    // With no output there is no page to show; an old report would be a lie.
    pages.render(state.renderers > 0 ? playback?.tables : undefined);
  }

  /**
   * Repaint fed fields from the hub's retained channel data.
   *
   * No new protocol: the hub already broadcasts `state` to controllers on every
   * dispatch, and its `data` carries the same `$data` map the renderers get —
   * whole DataSets, per source. The panel was simply throwing it away. Which
   * also means the panel is only as fresh as the last push, and a source that
   * has not ticked since the page opened shows the inlined snapshot instead of
   * nothing.
   */
  function renderFed(data: Record<string, unknown> | undefined): void {
    if (!fed.size || !data) return;
    const push = data[boot.dataKey];
    if (!push || typeof push !== 'object') return;
    for (const [sourceId, field] of fed) {
      const set = (push as Record<string, unknown>)[sourceId];
      if (set && typeof set === 'object') {
        field.render(set as DatasetValue & { fetchedAt?: string });
      }
    }
  }

  function send(command: Record<string, unknown>): void {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'command', command }));
      return;
    }
    // Fall back to REST so a button press is never lost to a dead socket.
    const url = `/api/control/${encodeURIComponent(boot.projectId)}/${encodeURIComponent(
      boot.compositionId,
    )}/${command['verb']}${key ? `?key=${encodeURIComponent(key)}` : ''}`;
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(restBody(command)),
    }).catch(() => {
      if (command['verb'] === 'update') queued.push(command['data'] as Record<string, unknown>);
    });
  }

  function sendUpdate(): void {
    send({ verb: 'update', data: currentData() });
  }

  /* -------------------------------------------------------------- pages */

  const pages = makePageList(document.getElementById('pages'), document.getElementById('page-list'), send);

  /* ------------------------------------------------------------ actions */

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-verb]')) {
    button.addEventListener('click', () => {
      const verb = button.dataset['verb']!;
      // PLAY carries the current field values, so an operator can type a name
      // and hit PLAY without a separate update step.
      send(verb === 'play' ? { verb, data: currentData() } : { verb });
    });
  }

  document.getElementById('send')?.addEventListener('click', sendUpdate);

  /*
   * Fed fields also refresh over REST.
   *
   * The websocket only speaks when something is dispatched, and a channel with
   * no renderer attached gets no data pushes at all — which is precisely the
   * state a panel is in while an operator checks a graphic before air. Polling
   * the source status endpoint covers that gap. Stopped when the tab is hidden:
   * a panel left open on a spare monitor overnight should cost nothing.
   */
  if (fed.size) {
    let poll: ReturnType<typeof setInterval> | null = null;

    async function pollSources(): Promise<void> {
      for (const [sourceId, field] of fed) {
        try {
          // Row cap: the panel shows a feed, not the whole of one. A 5000-row
          // sheet would otherwise be fetched and laid out every 15 seconds on
          // a tablet.
          // i18n-ignore-next-line — an API path, frozen per I18N.md §2
          const url = `/api/projects/${encodeURIComponent(boot.projectId)}/datasources/${encodeURIComponent(sourceId)}?rows=50${key ? `&key=${encodeURIComponent(key)}` : ''}`;
          const res = await fetch(url);
          if (!res.ok) continue;
          const body = (await res.json()) as { data?: DatasetValue & { fetchedAt?: string } };
          if (body.data) field.render(body.data);
        } catch {
          // Offline, or the endpoint is gone. Leave the last good values on
          // screen — a blanked field would read as a dead source.
        }
      }
    }

    function startPolling(): void {
      if (poll) return;
      void pollSources();
      poll = setInterval(() => void pollSources(), 15_000);
    }

    function stopPolling(): void {
      if (poll) clearInterval(poll);
      poll = null;
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopPolling();
      else startPolling();
    });
    startPolling();
  }

  connect();
}
