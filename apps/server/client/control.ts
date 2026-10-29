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

import {
  SCROLLS_UPDATE_KEY,
  TIMERS_UPDATE_KEY,
  clampNumber,
  parseScrollSeek,
  resolveScroll,
  scrollAtEnd,
  scrollPosition,
  type PollOption,
  type ScrollRef,
  type ScrollReport,
  type ScrollsPayload,
  fieldColor,
  formatTimer,
  parseTimerInput,
  stepNumber,
  toBoolean,
  SIDES,
  sportRuleset,
  sportTableColumns,
  sportTemplate,
  type FieldSpec,
  type TimerRef,
  type TimerState,
  type TimersPayload,
} from '@breeze/schema';

import { bootI18n } from './i18n.js';
import {
  SYNC_AUTO,
  SYNC_CUED,
  SYNC_OFF,
  compareKeyPair,
  compareReports,
  joinTarget,
  keyPairs,
  onAirSources,
  reportAgeSeconds,
  reportOf,
  type ChannelStateLike,
  type RuntimeLike,
  type SourceLike,
  type CheckKind,
  type SyncSide,
} from './join.js';

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
  /** Typed-field declaration (Phase 9 Wave B). */
  field?: FieldSpec;
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
      /** Operator timers this graphic shows (Phase 9 Wave B). */
      timers?: TimerRef[];
      /** The bin, for an asset field's picker (Phase 9 Wave B). */
      assets?: Array<{ path: string; name: string; kind: string }>;
      /** Sport game tables this graphic reads (Phase 9 Wave B). */
      games?: Array<{ id: string; name: string; sport: string; ruleset: string; teams?: string }>;
      /** Roll transports (Wave R). */
      scrolls?: ScrollRef[];
      /** Polls this graphic reads (Wave R). */
      polls?: Array<{ id: string; name: string; question: string; options: PollOption[]; editable: boolean }>;
      /** Operator-changeable texts this graphic reads (Wave R). */
      texts?: Array<{ id: string; name: string; body: string }>;
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
  /** The operator has changed it since the panel opened. See `currentData`. */
  readonly touched: boolean;
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
  /**
   * The rows the table actually shows when it reads a source — a manual table
   * in the project's data. Used when the layer carries no rows of its own,
   * which a table fed by a source normally does not: starting the grid empty
   * showed the operator a blank table that was not blank on air.
   */
  seed?: DatasetValue,
): DatasetGrid {
  const authored = (binding.defaultValue ?? { columns: [], rows: [] }) as DatasetValue;
  const initial = (authored.rows?.length ?? 0) === 0 && seed?.columns?.length ? seed : authored;
  let touched = false;
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
          touched = true;
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
          touched = true;
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
        touched = true;
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
    touched = true;
    const blank: Record<string, unknown> = {};
    for (const col of columns) blank[col.key] = col.type === 'number' ? 0 : '';
    rows.push(blank);
    draw();
  });

  draw();

  return {
    el: wrap,
    value: () => ({ columns, rows: rows.map((r) => ({ ...r })) }),
    get touched() {
      return touched;
    },
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
  if (verb === 'update' || verb === 'play' || verb === 'take') return (command['data'] as Record<string, unknown>) ?? {};
  const body: Record<string, unknown> = {};
  if (typeof command['table'] === 'string') body['table'] = command['table'];
  if (verb === 'page') {
    if (typeof command['key'] === 'string') body['name'] = command['key'];
    else if (typeof command['page'] === 'number') body['n'] = command['page'];
  }
  if (verb === 'cycle') body['state'] = command['cycle'];
  if (verb === 'scroll' && command['scroll'] && typeof command['scroll'] === 'object') {
    const spec = command['scroll'] as { action: string; id?: string; value?: number; percent?: boolean };
    body['action'] = spec.action;
    if (spec.id) body['id'] = spec.id;
    if (typeof spec.value === 'number') body['value'] = spec.percent ? `${spec.value}%` : String(spec.value);
  }
  if (verb === 'timer' && command['timer'] && typeof command['timer'] === 'object') {
    const spec = command['timer'] as { action: string; id?: string; value?: number };
    body['action'] = spec.action;
    if (spec.id) body['id'] = spec.id;
    // The REST route reads seconds, as an operator types them.
    if (typeof spec.value === 'number') body['value'] = String(spec.value / 1000);
  }
  return body;
}

/** Kinds `makeTypedField` draws a control for. */
const TYPED_KINDS = new Set(['number', 'boolean', 'enum', 'color', 'asset']);

/**
 * The control for a typed field (Phase 9 Wave B): a number with −/+ and the
 * author's one-tap buttons, a toggle, a select, a colour, an asset picker.
 *
 * A button or a toggle *commits* — in live mode that is an update on air, the
 * reason a score has buttons at all; in cue mode it changes the buffer. Typing
 * a number commits on Enter or when the box loses focus, as a name does.
 */
function makeTypedField(
  binding: Binding,
  commit: () => void,
  assets: ReadonlyArray<{ path: string; name: string; kind: string }>,
): { el: HTMLElement; value(): unknown } {
  const spec = binding.field;
  const label = document.createElement('label');
  const caption = document.createElement('span');
  caption.textContent = binding.label || binding.name;
  label.appendChild(caption);
  const row = document.createElement('div');
  row.className = 'typed';
  label.appendChild(row);

  const small = (text: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'typed-btn';
    b.textContent = text;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      fn();
    });
    return b;
  };

  if (binding.kind === 'number') {
    const numberSpec = spec?.kind === 'number' ? spec : { kind: 'number' as const };
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'decimal';
    if (numberSpec.min !== undefined) input.min = String(numberSpec.min);
    if (numberSpec.max !== undefined) input.max = String(numberSpec.max);
    if (numberSpec.step !== undefined) input.step = String(numberSpec.step);
    input.value = String(clampNumber(numberSpec, binding.defaultValue));
    const bump = (delta: number) => {
      input.value = String(stepNumber(numberSpec, input.value, delta));
      commit();
    };
    const step = numberSpec.step ?? 1;
    row.append(small('−', () => bump(-step)), input, small('+', () => bump(step)));
    for (const delta of numberSpec.buttons ?? []) {
      row.appendChild(small(delta > 0 ? `+${delta}` : String(delta), () => bump(delta)));
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
    });
    input.addEventListener('change', commit);
    return { el: label, value: () => clampNumber(numberSpec, input.value) };
  }

  if (binding.kind === 'boolean') {
    let on = toBoolean(binding.defaultValue);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'typed-toggle';
    const paint = () => {
      toggle.setAttribute('aria-pressed', String(on));
      toggle.textContent = t(on ? 'control.fieldOn' : 'control.fieldOff');
    };
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      on = !on;
      paint();
      commit();
    });
    paint();
    row.appendChild(toggle);
    return { el: label, value: () => on };
  }

  if (binding.kind === 'enum' || binding.kind === 'asset') {
    const select = document.createElement('select');
    const add = (value: string, text: string) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    };
    if (binding.kind === 'enum') {
      for (const o of spec?.kind === 'enum' ? spec.options : []) add(o.value, o.label ?? o.value);
    } else {
      const wanted = spec?.kind === 'asset' ? (spec.assetKind ?? 'image') : 'image';
      const none = t('control.assetNone');
      add('', none);
      for (const a of assets) if (a.kind === wanted) add(a.path, a.name);
      const current = String(binding.defaultValue ?? '');
      if (current && ![...select.options].some((o) => o.value === current)) add(current, current);
    }
    select.value = String(binding.defaultValue ?? '');
    select.addEventListener('change', commit);
    row.appendChild(select);
    return { el: label, value: () => select.value };
  }

  // colour
  const input = document.createElement('input');
  input.type = 'color';
  // An <input type="color"> only takes #rrggbb.
  const start = fieldColor(binding.defaultValue) ?? '#ffffff';
  input.value = /^#[0-9a-f]{6}$/i.test(start) ? start : '#ffffff';
  input.addEventListener('change', commit);
  row.appendChild(input);
  return { el: label, value: () => input.value };
}

/**
 * The Game block (Phase 9 Wave B): score buttons for a sport template's game
 * table, laid out by the sport — +1/+2/+3, TD/FG/PAT, try and conversion, a
 * point to either side for the racket sports, the cricket keypad — with the
 * period, possession and the sport's own counters beneath.
 *
 * Every tap is a game action on the server (`…/datasources/:id/game`), which
 * writes the one row every graphic of the project reads. The readout follows
 * the hub's pushes of that table, and the action's own answer, whichever is
 * first.
 */
type GameRow = Record<string, unknown>;

function makeGameBlock(
  boot: NonNullable<Window['__BREEZE_CONTROL__']>,
  key: string,
): { render(data: Record<string, unknown> | undefined): void } {
  const games = boot.games ?? [];
  const section = document.getElementById('games');
  const list = document.getElementById('game-list');
  if (!section || !list || games.length === 0) return { render: () => undefined };
  section.hidden = false;

  const auth = key ? `?key=${encodeURIComponent(key)}` : '';
  const painters: Array<(push: Record<string, unknown>) => void> = [];

  for (const game of games) {
    const sport = sportTemplate(game.sport);
    if (!sport) continue;
    const ruleset = sportRuleset(sport, game.ruleset);
    const columns = sportTableColumns(sport, ruleset, 'game');
    const seeded = boot.datasets?.[game.id]?.rows?.[0];
    let row: GameRow = seeded ?? {};
    let teams: GameRow[] = (game.teams ? boot.datasets?.[game.teams]?.rows : undefined) ?? [];

    // i18n-ignore-next-line — an API path, frozen per I18N.md §2
    const url = `/api/projects/${encodeURIComponent(boot.projectId)}/datasources/${encodeURIComponent(game.id)}/game${auth}`;
    const act = (action: Record<string, unknown>): void => {
      void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })
        .then(async (res) => {
          if (!res.ok) return;
          const body = (await res.json()) as { row?: Record<string, unknown> };
          if (body.row) {
            row = body.row;
            paint();
          }
        })
        .catch(() => {
          /* The next push shows what actually happened. */
        });
    };

    const box = document.createElement('div');
    box.className = 'game';
    const head = document.createElement('div');
    head.className = 'game-head';
    const title = document.createElement('strong');
    title.textContent = game.name;
    const ruleName = document.createElement('span');
    ruleName.className = 'sub';
    ruleName.textContent = t(ruleset.labelKey);
    head.append(title, ruleName);
    box.appendChild(head);

    const button = (label: string, fn: () => void, cls = ''): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      return b;
    };

    /* -- the score, one panel per side */
    const sides = document.createElement('div');
    sides.className = 'game-sides';
    const readouts: Record<string, { name: HTMLElement; score: HTMLElement; detail: HTMLElement }> = {};
    for (const side of SIDES) {
      const panel = document.createElement('div');
      panel.className = 'game-side';
      const name = document.createElement('div');
      name.className = 'game-name';
      const score = document.createElement('div');
      score.className = 'game-score';
      const detail = document.createElement('div');
      detail.className = 'game-detail';
      panel.append(name, score, detail);
      const buttons = document.createElement('div');
      buttons.className = 'game-buttons';
      if (sport.scoring === 'points') {
        for (const action of sport.actions) {
          buttons.appendChild(button(action.label, () => act({ type: 'score', side, action: action.id }), 'go'));
        }
        const smallest = sport.actions[0];
        if (smallest) buttons.appendChild(button('−', () => act({ type: 'unscore', side, action: smallest.id })));
      } else if (sport.scoring !== 'cricket') {
        buttons.appendChild(button(t('control.gamePoint'), () => act({ type: 'point', side }), 'go'));
      }
      panel.appendChild(buttons);
      sides.appendChild(panel);
      readouts[side] = { name, score, detail };
    }
    box.appendChild(sides);

    /* -- cricket's keypad: one, for the batting side */
    if (sport.scoring === 'cricket') {
      const pad = document.createElement('div');
      pad.className = 'game-buttons game-pad';
      for (const action of sport.actions) pad.appendChild(button(action.label, () => act({ type: 'score', side: 'home', action: action.id }), action.id === 'wicket' ? 'stop' : 'go'));
      box.appendChild(pad);
    }

    /* -- period */
    const period = document.createElement('div');
    period.className = 'game-period';
    const periodText = document.createElement('span');
    periodText.className = 'game-period-label';
    period.append(
      button('◀', () => act({ type: 'period', delta: -1 })),
      periodText,
      button('▶', () => act({ type: 'period', delta: 1 })),
    );
    box.appendChild(period);

    /* -- everything else on the row */
    const SKIP = /^(period|periodLabel|homeScore|awayScore|(home|away)(\d+|OT|X|Display|Overs|PointText|Score))$|^(runRate|requiredRate|call)$/;
    const extras = document.createElement('div');
    extras.className = 'game-extras';
    const updaters: Array<() => void> = [];
    for (const column of columns) {
      if (SKIP.test(column.key)) continue;
      const cell = document.createElement('div');
      cell.className = 'game-cell';
      const caption = document.createElement('span');
      caption.textContent = column.label ?? column.key;
      cell.appendChild(caption);
      if (column.values) {
        const group = document.createElement('div');
        group.className = 'seg';
        const buttons = column.values.map((value) => {
          const b = button(value || t('control.gameNone'), () => act({ type: 'set', column: column.key, value }));
          group.appendChild(b);
          return { b, value };
        });
        updaters.push(() => {
          for (const { b, value } of buttons) b.setAttribute('aria-pressed', String((row[column.key] ?? '') === value));
        });
        cell.appendChild(group);
      } else if (column.type === 'number') {
        const value = document.createElement('span');
        value.className = 'game-num';
        cell.append(button('−', () => act({ type: 'adjust', column: column.key, delta: -1 })), value, button('+', () => act({ type: 'adjust', column: column.key, delta: 1 })));
        updaters.push(() => {
          value.textContent = String(row[column.key] ?? 0);
        });
      } else if (column.type === 'boolean') {
        const toggle = button('', () => act({ type: 'set', column: column.key, value: row[column.key] !== true }), 'typed-toggle');
        cell.appendChild(toggle);
        updaters.push(() => {
          const on = row[column.key] === true;
          toggle.setAttribute('aria-pressed', String(on));
          toggle.textContent = t(on ? 'control.fieldOn' : 'control.fieldOff');
        });
      } else {
        const input = document.createElement('input');
        const commit = () => act({ type: 'set', column: column.key, value: input.value });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') commit();
        });
        input.addEventListener('change', commit);
        cell.appendChild(input);
        updaters.push(() => {
          if (document.activeElement !== input) input.value = String(row[column.key] ?? '');
        });
      }
      extras.appendChild(cell);
    }
    box.appendChild(extras);

    /* -- reset, on a second tap */
    let armed: ReturnType<typeof setTimeout> | null = null;
    const reset = button(t('control.gameReset'), () => {
      if (armed) {
        clearTimeout(armed);
        armed = null;
        reset.textContent = t('control.gameReset');
        act({ type: 'reset' });
        return;
      }
      reset.textContent = t('control.gameResetConfirm');
      armed = setTimeout(() => {
        armed = null;
        reset.textContent = t('control.gameReset');
      }, 3000);
    }, 'game-reset');
    box.appendChild(reset);
    list.appendChild(box);

    const teamName = (side: string): string => {
      const team = teams.find((r) => r['side'] === side);
      const label = team?.['abbr'] || team?.['shortName'] || team?.['name'];
      return label ? String(label) : t(side === 'home' ? 'control.gameHome' : 'control.gameAway');
    };

    const paint = (): void => {
      for (const side of SIDES) {
        const r = readouts[side]!;
        r.name.textContent = teamName(side);
        if (sport.scoring === 'tennis') {
          r.score.textContent = String(row[`${side}PointText`] ?? '0');
          r.detail.textContent = t('control.gameSetsGames', { sets: String(row[`${side}Sets`] ?? 0), games: String(row[`${side}Games`] ?? 0) });
        } else if (sport.scoring === 'rally' || sport.scoring === 'sideout') {
          r.score.textContent = String(row[`${side}Points`] ?? 0);
          r.detail.textContent = t('control.gameGames', { games: String(row[`${side}Games`] ?? 0) });
        } else if (sport.scoring === 'cricket') {
          r.score.textContent = `${row[`${side}Runs`] ?? 0}/${row[`${side}Wickets`] ?? 0}`;
          r.detail.textContent = t('control.gameOvers', { overs: String(row[`${side}Overs`] ?? '0.0') });
        } else {
          r.score.textContent = String(row[`${side}Score`] ?? 0);
          r.detail.textContent = row[`${side}Display`] !== undefined ? String(row[`${side}Display`]) : '';
        }
      }
      periodText.textContent = String(row['periodLabel'] ?? row['period'] ?? '');
      for (const update of updaters) update();
    };
    paint();

    painters.push((push) => {
      const set = push[game.id] as { rows?: Array<Record<string, unknown>> } | undefined;
      if (set?.rows?.[0]) row = set.rows[0];
      const teamSet = game.teams ? (push[game.teams] as { rows?: Array<Record<string, unknown>> } | undefined) : undefined;
      if (teamSet?.rows) teams = teamSet.rows;
      if (set || teamSet) paint();
    });
  }

  return {
    render(data) {
      const push = data?.[boot.dataKey];
      if (!push || typeof push !== 'object') return;
      for (const painter of painters) painter(push as Record<string, unknown>);
    },
  };
}

/**
 * The Timers block (Phase 9 Wave B): one row per timer this graphic shows,
 * with a readout worked out here from the hub's anchor — the same arithmetic
 * the outputs run, so the panel and air agree without a frame per second.
 */
function makeTimerBlock(
  timers: readonly TimerRef[],
  send: (command: Record<string, unknown>) => void,
): { render(data: Record<string, unknown> | undefined): void } {
  const section = document.getElementById('timers');
  const list = document.getElementById('timer-list');
  if (!section || !list || timers.length === 0) return { render: () => undefined };
  section.hidden = false;

  let states: Record<string, TimerState> = {};
  let offset = 0;
  const rows = new Map<string, { value: HTMLElement; toggle: HTMLButtonElement; ref: TimerRef }>();
  const command = (id: string, action: string, value?: number) =>
    send({ verb: 'timer', timer: { action, id, ...(value !== undefined ? { value } : {}) } });

  for (const ref of timers) {
    const row = document.createElement('div');
    row.className = 'timer-row';
    const head = document.createElement('div');
    head.className = 'timer-head';
    const name = document.createElement('span');
    name.className = 'timer-name';
    name.textContent = t('control.timerLabel', { name: ref.layerName, id: ref.id });
    head.appendChild(name);
    const value = document.createElement('div');
    value.className = 'timer-value';
    value.setAttribute('aria-live', 'off');

    const verbs = document.createElement('div');
    verbs.className = 'verbs';
    const button = (label: string, fn: () => void, cls = ''): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      verbs.appendChild(b);
      return b;
    };
    const toggle = button(t('control.timerStart'), () => command(ref.id, 'toggle'), 'go');
    // A until-timer counts to a time of day: start, pause and set mean nothing to it.
    const fixed = ref.timer.until !== undefined;
    toggle.hidden = fixed;
    button('−10', () => command(ref.id, 'add', -10_000));
    button('−1', () => command(ref.id, 'add', -1_000));
    button('+1', () => command(ref.id, 'add', 1_000));
    button('+10', () => command(ref.id, 'add', 10_000));
    button(t('control.timerReset'), () => command(ref.id, 'reset'));

    const set = document.createElement('div');
    set.className = 'timer-set';
    const input = document.createElement('input');
    input.placeholder = t('control.timerSetPlaceholder');
    input.inputMode = 'decimal';
    const setButton = document.createElement('button');
    setButton.type = 'button';
    setButton.textContent = t('control.timerSet');
    const doSet = (): void => {
      const ms = parseTimerInput(input.value);
      if (ms === null) {
        input.setCustomValidity(t('control.timerBadValue'));
        input.reportValidity();
        return;
      }
      input.setCustomValidity('');
      command(ref.id, 'set', ms);
      input.value = '';
    };
    setButton.addEventListener('click', doSet);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSet();
    });
    set.append(input, setButton);
    set.hidden = fixed;

    row.append(head, value, verbs, set);
    list.appendChild(row);
    rows.set(ref.id, { value, toggle, ref });
  }

  const paint = (): void => {
    const now = Date.now() + offset;
    for (const [id, row] of rows) {
      const state = states[id];
      row.value.textContent = formatTimer(row.ref.timer, state, now);
      const running = state?.running === true;
      row.value.dataset['running'] = String(running || row.ref.timer.until !== undefined);
      row.toggle.textContent = t(running ? 'control.timerPause' : 'control.timerStart');
      row.toggle.className = running ? 'stop' : 'go';
    }
  };
  paint();
  setInterval(paint, 100);

  return {
    render(data) {
      const payload = data?.[TIMERS_UPDATE_KEY] as TimersPayload | undefined;
      if (!payload || typeof payload !== 'object') return;
      if (typeof payload.clock === 'number') offset = payload.clock - Date.now();
      states = { ...(payload.timers ?? {}) };
      paint();
    },
  };
}

/**
 * The Scroll block (Wave R, ROLLS.md §5.3): the transport for each roll this
 * graphic shows. The position is worked out here from the hub's anchor — the
 * arithmetic the outputs run — and the length from what an output reported,
 * so the bar moves smoothly without a frame per second from anyone.
 */
function makeScrollBlock(
  scrolls: readonly ScrollRef[],
  send: (command: Record<string, unknown>) => void,
): { render(data: Record<string, unknown> | undefined, playback?: unknown): void } {
  const section = document.getElementById('scrolls');
  const list = document.getElementById('scroll-list');
  if (!section || !list || scrolls.length === 0) return { render: () => undefined };
  section.hidden = false;

  let payload: ScrollsPayload | undefined;
  let offset = 0;
  let reports: ScrollReport[] = [];
  const command = (id: string, action: string, value?: number, percent?: boolean) =>
    send({ verb: 'scroll', scroll: { action, id, ...(value !== undefined ? { value } : {}), ...(percent ? { percent: true } : {}) } });

  interface Row {
    ref: ScrollRef;
    state: HTMLElement;
    speed: HTMLElement;
    toggle: HTMLButtonElement;
    forward: HTMLButtonElement;
    backward: HTMLButtonElement;
    bar: HTMLInputElement;
    position: HTMLElement;
    dragging: boolean;
  }
  const rows: Row[] = [];
  const mmss = (seconds: number): string => {
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  for (const ref of scrolls) {
    const box = document.createElement('div');
    box.className = 'scroll-row';
    const head = document.createElement('div');
    head.className = 'scroll-head';
    const name = document.createElement('span');
    name.className = 'scroll-name';
    name.textContent = t('control.scrollLabel', { name: ref.layerName, id: ref.id });
    const speed = document.createElement('span');
    speed.className = 'scroll-speed';
    const state = document.createElement('span');
    state.className = 'scroll-state';
    head.append(name, speed, state);

    const verbsFor = (): HTMLElement => {
      const v = document.createElement('div');
      v.className = 'verbs';
      return v;
    };
    const transport = verbsFor();
    const tuning = verbsFor();
    const button = (parent: HTMLElement, label: string, fn: () => void, cls = ''): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      parent.appendChild(b);
      return b;
    };
    button(transport, t('control.scrollRestart'), () => command(ref.id, 'restart'));
    const backward = button(transport, t('control.scrollBackward'), () => command(ref.id, 'backward'));
    const toggle = button(transport, t('control.scrollPlay'), () => command(ref.id, 'toggle'), 'go');
    const forward = button(transport, t('control.scrollForward'), () => command(ref.id, 'forward'));
    button(transport, t('control.scrollEnd'), () => command(ref.id, 'end'));
    button(tuning, t('control.scrollSlower'), () => command(ref.id, 'slower'));
    button(tuning, t('control.scrollNormal'), () => command(ref.id, 'speed', 1));
    button(tuning, t('control.scrollFaster'), () => command(ref.id, 'faster'));
    button(tuning, t('control.scrollJogBack'), () => command(ref.id, 'jog', -3));
    button(tuning, t('control.scrollJogAhead'), () => command(ref.id, 'jog', 3));

    const bar = document.createElement('input');
    bar.type = 'range';
    bar.className = 'scroll-bar';
    bar.min = '0';
    bar.max = '1000';
    bar.value = '0';
    bar.setAttribute('aria-label', t('control.scrollBar'));
    const position = document.createElement('div');
    position.className = 'hint';

    const seek = document.createElement('div');
    seek.className = 'scroll-seek';
    const input = document.createElement('input');
    input.placeholder = t('control.scrollSeekPlaceholder');
    const go = document.createElement('button');
    go.type = 'button';
    go.textContent = t('control.scrollSeek');
    const doSeek = (): void => {
      const parsed = parseScrollSeek(input.value);
      if (!parsed || parsed.value === undefined) {
        input.setCustomValidity(t('control.scrollBadSeek'));
        input.reportValidity();
        return;
      }
      input.setCustomValidity('');
      command(ref.id, 'seek', parsed.value, parsed.percent === true);
      input.value = '';
    };
    go.addEventListener('click', doSeek);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSeek();
    });
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = t('control.scrollReset');
    reset.addEventListener('click', () => command(ref.id, 'reset'));
    seek.append(input, go, reset);

    const row: Row = { ref, state, speed, toggle, forward, backward, bar, position, dragging: false };
    bar.addEventListener('pointerdown', () => {
      row.dragging = true;
    });
    bar.addEventListener('change', () => {
      row.dragging = false;
      command(ref.id, 'seek', Number(bar.value) / 10, true);
    });

    box.append(head, transport, tuning, bar, position, seek);
    list.appendChild(box);
    rows.push(row);
  }

  const paint = (): void => {
    const now = Date.now() + offset;
    for (const row of rows) {
      const info = reports.find((r) => r.id === row.ref.id);
      const s = resolveScroll(payload, row.ref.id, info?.start ?? row.ref.start);
      const travel = scrollPosition(s, now, info);
      const extent = info?.extent;
      const atEnd = s.running && scrollAtEnd(s, now, info);
      row.speed.textContent = t('control.scrollSpeed', { speed: String(Math.round(Math.abs(s.rate) * 100) / 100) });
      row.state.textContent = t(atEnd ? 'control.scrollAtEnd' : s.running ? (s.rate < 0 ? 'control.scrollRollingBack' : 'control.scrollRolling') : 'control.scrollPaused');
      row.state.dataset['running'] = String(s.running && !atEnd);
      row.toggle.textContent = t(s.running ? 'control.scrollPause' : 'control.scrollPlay');
      row.toggle.className = s.running ? 'stop' : 'go';
      row.forward.setAttribute('aria-pressed', String(s.running && s.rate > 0));
      row.backward.setAttribute('aria-pressed', String(s.running && s.rate < 0));
      if (extent !== undefined && extent > 0) {
        if (!row.dragging) row.bar.value = String(Math.round((travel / extent) * 1000));
        row.bar.disabled = false;
        row.position.textContent = t('control.scrollPosition', { at: mmss(travel / Math.abs(s.rate || 1)), total: mmss(extent / Math.abs(s.rate || 1)) });
      } else {
        row.bar.disabled = true;
        row.position.textContent = t('control.scrollNoOutput');
      }
    }
  };
  paint();
  setInterval(paint, 250);

  return {
    render(data, playback) {
      const p = data?.[SCROLLS_UPDATE_KEY] as ScrollsPayload | undefined;
      if (p && typeof p === 'object') {
        if (typeof p.clock === 'number') offset = p.clock - Date.now();
        payload = { clock: p.clock, scrolls: { ...(p.scrolls ?? {}) }, ...(typeof p.playAt === 'number' ? { playAt: p.playAt } : {}) };
      }
      const reported = (playback as { scrolls?: ScrollReport[] } | null | undefined)?.scrolls;
      if (Array.isArray(reported)) reports = reported;
      paint();
    },
  };
}

/** Two taps to confirm a destructive button — the Game block's reset, shared. */
function confirmButton(label: string, confirm: string, fn: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  let armed: ReturnType<typeof setTimeout> | null = null;
  b.addEventListener('click', () => {
    if (armed) {
      clearTimeout(armed);
      armed = null;
      b.textContent = label;
      fn();
      return;
    }
    b.textContent = confirm;
    armed = setTimeout(() => {
      armed = null;
      b.textContent = label;
    }, 3000);
  });
  return b;
}

/** The message a refused request carries, for the operator. */
async function refusal(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? String(res.status);
  } catch {
    return String(res.status);
  }
}

/**
 * The Poll block (Wave R, CHARTS.md §5.1): tally buttons for each poll this
 * graphic reads. Every tap is a poll action on the server, which writes the
 * tally every graphic of the project reads; the readout follows the hub's
 * pushes of the poll's rows and each action's own answer.
 */
function makePollBlock(
  boot: NonNullable<Window['__BREEZE_CONTROL__']>,
  key: string,
): { render(data: Record<string, unknown> | undefined): void } {
  const polls = boot.polls ?? [];
  const section = document.getElementById('polls');
  const list = document.getElementById('poll-list');
  if (!section || !list || polls.length === 0) return { render: () => undefined };
  section.hidden = false;
  const auth = key ? `?key=${encodeURIComponent(key)}` : '';
  const painters: Array<(push: Record<string, unknown>) => void> = [];

  for (const poll of polls) {
    // i18n-ignore-next-line — an API path, frozen per I18N.md §2
    const url = `/api/projects/${encodeURIComponent(boot.projectId)}/datasources/${encodeURIComponent(poll.id)}/poll${auth}`;
    let rows: Array<Record<string, unknown>> = boot.datasets?.[poll.id]?.rows ?? [];
    let options = poll.options;

    const box = document.createElement('div');
    box.className = 'poll';
    const head = document.createElement('div');
    head.className = 'poll-head';
    const title = document.createElement('strong');
    title.textContent = poll.name;
    const status = document.createElement('span');
    status.className = 'poll-status';
    head.append(title, status);
    const question = document.createElement('div');
    question.className = 'poll-question';
    const optionList = document.createElement('div');
    const total = document.createElement('div');
    total.className = 'poll-total';
    const message = document.createElement('div');
    message.className = 'hint';

    const act = (action: Record<string, unknown>): void => {
      void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })
        .then(async (res) => {
          if (!res.ok) {
            message.textContent = t('control.pollFailed', { reason: await refusal(res) });
            return;
          }
          message.textContent = '';
          const body = (await res.json()) as { rows?: Array<Record<string, unknown>> };
          if (body.rows) {
            rows = body.rows;
            paint();
          }
        })
        .catch(() => {
          /* The next push shows what actually happened. */
        });
    };

    const counts = new Map<string, { count: HTMLElement; pct: HTMLElement; input: HTMLInputElement }>();
    const build = (): void => {
      optionList.textContent = '';
      counts.clear();
      for (const option of options) {
        const line = document.createElement('div');
        line.className = 'poll-option';
        const label = document.createElement('span');
        label.className = 'poll-label';
        if (option.color) {
          const swatch = document.createElement('span');
          swatch.className = 'poll-swatch';
          swatch.style.background = option.color;
          label.appendChild(swatch);
        }
        const text = document.createElement('span');
        text.textContent = option.label || option.id;
        label.appendChild(text);
        const count = document.createElement('span');
        count.className = 'poll-count';
        const pct = document.createElement('span');
        pct.className = 'poll-pct';
        const minus = document.createElement('button');
        minus.type = 'button';
        minus.textContent = '−1';
        minus.addEventListener('click', () => act({ type: 'vote', option: option.id, delta: -1 }));
        const plus = document.createElement('button');
        plus.type = 'button';
        plus.className = 'go';
        plus.textContent = '+1';
        plus.addEventListener('click', () => act({ type: 'vote', option: option.id }));
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = '1';
        input.title = t('control.pollSetTitle');
        input.addEventListener('change', () => {
          const value = Number(input.value);
          if (Number.isFinite(value) && value >= 0) act({ type: 'set', option: option.id, value: Math.floor(value) });
        });
        line.append(label, count, pct, minus, plus, input);
        optionList.appendChild(line);
        counts.set(option.id, { count, pct, input });
      }
    };
    build();

    const actions = document.createElement('div');
    actions.className = 'poll-actions';
    const openClose = document.createElement('button');
    openClose.type = 'button';
    openClose.addEventListener('click', () => act({ type: rows[0]?.['status'] === 'closed' ? 'open' : 'close' }));
    actions.append(openClose, confirmButton(t('control.pollReset'), t('control.pollResetConfirm'), () => act({ type: 'reset' })));

    box.append(head, question, optionList, total, actions, message);

    if (poll.editable) {
      // Operator changeable (decided 2026-10-26): the question and options, one option per line.
      const details = document.createElement('details');
      details.className = 'poll-edit';
      const summary = document.createElement('summary');
      summary.textContent = t('control.pollEdit');
      const qLabel = document.createElement('label');
      qLabel.textContent = t('control.pollQuestion');
      const qInput = document.createElement('input');
      qInput.value = poll.question;
      qLabel.appendChild(qInput);
      const oLabel = document.createElement('label');
      oLabel.textContent = t('control.pollOptionsLabel');
      const oInput = document.createElement('textarea');
      // i18n-ignore-next-line — the option list's own line format, not prose
      oInput.value = options.map((o) => (o.color ? `${o.label} | ${o.color}` : o.label)).join('\n');
      oLabel.appendChild(oInput);
      const save = document.createElement('button');
      save.type = 'button';
      save.textContent = t('control.pollSave');
      save.addEventListener('click', () => {
        const lines = oInput.value.split('\n').map((l) => l.trim()).filter(Boolean);
        // Ids stay with their position, so a corrected spelling keeps its votes.
        const used = new Set<string>();
        const next = lines.map((line, i) => {
          const [labelPart, colorPart] = line.split('|').map((p) => p.trim());
          // i18n-ignore-next-line — an option id, frozen data
          let id = options[i]?.id ?? `option-${i + 1}`;
          // i18n-ignore-next-line — an option id, frozen data
          while (used.has(id)) id = `${id}-${i + 1}`;
          used.add(id);
          return { id, label: labelPart ?? '', ...(colorPart ? { color: colorPart } : {}) };
        });
        void fetch(url, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: qInput.value, options: next }),
        }).then(async (res) => {
          if (!res.ok) {
            message.textContent = t('control.pollFailed', { reason: await refusal(res) });
            return;
          }
          const body = (await res.json()) as { rows?: Array<Record<string, unknown>> };
          options = next;
          if (body.rows) rows = body.rows;
          message.textContent = t('control.pollSaved');
          build();
          paint();
        });
      });
      details.append(summary, qLabel, oLabel, save);
      box.appendChild(details);
    }
    list.appendChild(box);

    const paint = (): void => {
      const first = rows[0];
      question.textContent = String(first?.['question'] ?? poll.question);
      const closed = first?.['status'] === 'closed';
      status.textContent = t(closed ? 'control.pollStatusClosed' : 'control.pollStatusOpen');
      status.dataset['status'] = closed ? 'closed' : 'open';
      openClose.textContent = t(closed ? 'control.pollOpen' : 'control.pollClose');
      total.textContent = t('control.pollTotal', { total: String(first?.['total'] ?? 0) });
      for (const [id, cells] of counts) {
        const row = rows.find((r) => r['option'] === id);
        cells.count.textContent = String(row?.['votes'] ?? 0);
        cells.pct.textContent = `${String(row?.['percent'] ?? 0)}%`;
        if (document.activeElement !== cells.input) cells.input.value = String(row?.['votes'] ?? 0);
      }
    };
    paint();

    painters.push((push) => {
      const set = push[poll.id] as { rows?: Array<Record<string, unknown>> } | undefined;
      if (set?.rows) {
        rows = set.rows;
        paint();
      }
    });
  }

  return {
    render(data) {
      const push = data?.[boot.dataKey];
      if (!push || typeof push !== 'object') return;
      for (const painter of painters) painter(push as Record<string, unknown>);
    },
  };
}

/**
 * The Text block (Wave R, ROLLS.md §3): the words of each text source this
 * graphic reads whose designer ticked **Operator changeable**. Sent when the
 * operator says so, never as they type — a lyric half-corrected on air would be
 * worse than the typo.
 */
function makeTextBlock(boot: NonNullable<Window['__BREEZE_CONTROL__']>, key: string): void {
  const texts = boot.texts ?? [];
  const section = document.getElementById('texts');
  const list = document.getElementById('text-list');
  if (!section || !list || texts.length === 0) return;
  section.hidden = false;
  const auth = key ? `?key=${encodeURIComponent(key)}` : '';

  for (const text of texts) {
    // i18n-ignore-next-line — an API path, frozen per I18N.md §2
    const url = `/api/projects/${encodeURIComponent(boot.projectId)}/datasources/${encodeURIComponent(text.id)}/text${auth}`;
    let saved = text.body;
    const box = document.createElement('div');
    box.className = 'text-row';
    const title = document.createElement('strong');
    title.textContent = text.name;
    const area = document.createElement('textarea');
    area.value = saved;
    area.setAttribute('aria-label', text.name);
    const actions = document.createElement('div');
    actions.className = 'text-actions';
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'go';
    send.textContent = t('control.textSave');
    const revert = document.createElement('button');
    revert.type = 'button';
    revert.textContent = t('control.textRevert');
    const message = document.createElement('span');
    message.className = 'hint';
    const dirty = (): void => {
      if (area.value === saved) message.textContent = '';
      else message.textContent = t('control.textUnsaved');
    };
    area.addEventListener('input', dirty);
    revert.addEventListener('click', () => {
      area.value = saved;
      dirty();
    });
    send.addEventListener('click', () => {
      const body = area.value;
      void fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) })
        .then(async (res) => {
          if (!res.ok) {
            message.textContent = t('control.textFailed', { reason: await refusal(res) });
            return;
          }
          const answer = (await res.json()) as { rows?: number };
          saved = body;
          message.textContent = t('control.textSaved', { rows: String(answer.rows ?? 0) });
        })
        .catch(() => {
          message.textContent = t('control.textFailed', { reason: t('control.textOffline') });
        });
    });
    actions.append(send, revert, message);
    box.append(title, area, actions);
    list.appendChild(box);
  }
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
): { render(tables: TableReport[] | undefined, ageSeconds?: number): void } {
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
    /**
     * `ageSeconds` is how old the report is: its time left is as of then, not
     * as of now, so a report the hub has been holding for six seconds has six
     * fewer seconds on the clock than it says.
     */
    render(tables, ageSeconds = 0) {
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
          const left = Math.max(0, report.secondsLeft - ageSeconds);
          row.deadline = Date.now() + left * 1000;
          // The page's full time is only known when it arrives; a report in
          // the middle of a page must not shrink the bar's scale.
          if (turned || left > row.total) row.total = left;
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
  const previewSync = document.getElementById('preview-sync') as HTMLSelectElement;
  let previewDebugOn = false;
  /** `?sync=` for the frame: newest output, one output's page id, or off (0.74.1). */
  let syncChoice = SYNC_AUTO;

  /* --------------------------------------------------------- cue → take */

  /*
   * Cue → take (Phase 9 Wave A), opted into per panel. Live edit stays the
   * default — 0.21's "edit the name live on air" must not change under anyone.
   *
   * In cue mode the fields are a buffer: typing, Enter and a table edit change
   * nothing on air. The preview can show the buffer ("Show cued") — the real
   * graphic with the real Fit Width result, through a page with no socket —
   * and TAKE sends values and PLAY as one command, so the output never shows
   * the new name on the old pose.
   */
  const cueBox = document.getElementById('cue-mode') as HTMLInputElement | null;
  const takeButton = document.getElementById('take') as HTMLButtonElement | null;
  const sendButton = document.getElementById('send') as HTMLButtonElement | null;
  const cueKey = `breeze.cue.${boot.projectId}/${boot.compositionId}`;
  let cueMode = false;
  try {
    cueMode = localStorage.getItem(cueKey) === '1';
  } catch {
    // Storage blocked: the panel opens in live mode, the default.
  }

  const previewUrl = (): string => {
    const params = new URLSearchParams({ scale: 'contain', preview: '1' });
    // Debug is read at load by the output page, so toggling it reloads the
    // frame — the honest way to drive a flag the page only reads once.
    if (previewDebugOn) params.set('debug', '1');
    // So is the sync choice: it decides what the page takes up from when it
    // connects, and a page only connects once.
    if (syncChoice === SYNC_CUED) params.set('hub', 'off');
    else if (syncChoice !== SYNC_AUTO) params.set('sync', syncChoice);
    if (key) params.set('key', key);
    return `/play/${boot.projectId}/${boot.compositionId}?${params.toString()}`;
  };

  const renderPreview = (): void => {
    previewFrame.textContent = '';
    const frame = document.createElement('iframe');
    frame.src = previewUrl();
    frame.title = t('control.previewTitle');
    if (syncChoice === SYNC_CUED) {
      frame.addEventListener('load', () => {
        // The page builds its runtime after its scripts load; retry briefly.
        let tries = 0;
        const attempt = (): void => {
          if (!showCued() && tries++ < 40) setTimeout(attempt, 50);
        };
        attempt();
      });
    }
    previewFrame.appendChild(frame);
  };

  /** Put the buffer into the cued preview and cut it to its first hold. */
  const showCued = (): boolean => {
    if (syncChoice !== SYNC_CUED) return true;
    const runtime = previewRuntime() as (RuntimeLike & {
      update(d: Record<string, unknown>): void;
      joinAt(r: unknown, o?: { force?: boolean }): boolean;
      play(): void;
    }) | null;
    if (!runtime) return false;
    runtime.update(currentData());
    if (!runtime.joinAt({ state: 'holding', time: 0, step: 1 }, { force: true })) runtime.play();
    return true;
  };

  let cuedTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleCued = (): void => {
    if (cuedTimer) clearTimeout(cuedTimer);
    cuedTimer = setTimeout(() => void showCued(), 150);
  };

  const applyCueMode = (): void => {
    if (cueBox) cueBox.checked = cueMode;
    if (takeButton) takeButton.hidden = !cueMode;
    if (sendButton) sendButton.hidden = cueMode;
    // Leaving cue mode takes the preview back to following air.
    if (!cueMode && syncChoice === SYNC_CUED) {
      syncChoice = SYNC_AUTO;
      if (previewOn) renderPreview();
    }
    syncSignature = '';
    renderSyncMenu(lastSources);
  };

  cueBox?.addEventListener('change', () => {
    cueMode = cueBox.checked;
    try {
      localStorage.setItem(cueKey, cueMode ? '1' : '0');
    } catch {
      // Not remembered; still applied.
    }
    applyCueMode();
  });

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
    runCheck(on);
  };

  previewToggle.addEventListener('click', () => showPreview(!previewOn));
  previewDebug.addEventListener('click', () => {
    previewDebugOn = !previewDebugOn;
    previewDebug.setAttribute('aria-pressed', String(previewDebugOn));
    renderPreview();
  });

  /**
   * **Sync to** — which output the preview takes up from when it opens with
   * the graphic already on air (0.74.1).
   *
   * Newest output, any one connected output, or off. The menu is rebuilt only
   * when the set of outputs changes: state arrives on every page turn, and
   * rebuilding an open menu under the operator's pointer would close it.
   * An output that disconnects while chosen falls back to Newest without
   * reloading the frame — the preview is already running and following
   * commands; the choice only matters at the moment it connects.
   */
  let syncSignature = '';
  let lastSources: SourceLike[] | undefined;
  const renderSyncMenu = (sources: SourceLike[] | undefined): void => {
    lastSources = sources;
    const list = sources ?? [];
    const onAir = (s: SourceLike) => s.playback?.state === 'holding' || s.playback?.state === 'playing-in';
    const signature = list.map((s) => `${s.page ?? s.id}|${s.label}|${s.ip}|${s.signal ?? ''}|${onAir(s)}`).join('\n');
    if (signature === syncSignature && previewSync.options.length) return;
    syncSignature = signature;

    if (
      syncChoice !== SYNC_AUTO &&
      syncChoice !== SYNC_OFF &&
      !(syncChoice === SYNC_CUED && cueMode) &&
      !list.some((s) => (s.page ?? s.id) === syncChoice)
    ) {
      syncChoice = SYNC_AUTO;
    }
    previewSync.textContent = '';
    const add = (value: string, label: string): void => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      previewSync.appendChild(option);
    };
    add(SYNC_AUTO, t('control.syncNewest'));
    list.forEach((s, i) => {
      const vars = { n: i + 1, label: s.label, ip: s.ip };
      // A matte page (Phase 9 Wave C) runs the same timeline as its fill, so it
      // can be followed like any output; the label only says which it is.
      const matte = s.signal === 'matte';
      add(
        s.page ?? s.id,
        onAir(s)
          ? (matte ? t('control.syncOutputMatte', vars) : t('control.syncOutput', vars))
          : (matte ? t('control.syncOutputMatteOffAir', vars) : t('control.syncOutputOffAir', vars)),
      );
    });
    add(SYNC_OFF, t('control.syncOff'));
    if (cueMode) add(SYNC_CUED, t('control.syncCued'));
    previewSync.value = syncChoice;
  };
  renderSyncMenu(undefined);

  previewSync.addEventListener('change', () => {
    syncChoice = previewSync.value || SYNC_AUTO;
    if (previewOn) renderPreview();
  });

  /* --------------------------------------------------------- sync check */

  /**
   * Is the preview showing what the output shows? (0.75.0)
   *
   * Every couple of seconds while the preview is open: read the output's
   * latest report from `/state` (lean — no data), read the preview's own state
   * straight out of its frame (same origin, so `breeze.runtime` is right there),
   * age the report to the moment of reading, and compare playback, each paged
   * table and each ticker (`compareReports`). The result is shown under the
   * preview, row by row, with **Resync** when anything is out.
   *
   * The output compared against is the one the preview follows: the chosen
   * one, else the newest on air — also for **Off**, where showing that the
   * preview is *not* in step is exactly the point.
   *
   * Only the graphic's own channel. On a scene, independently triggered
   * elements are their own graphics with their own panels.
   */
  const syncBadge = document.getElementById('sync-badge')!;
  const syncAge = document.getElementById('sync-age')!;
  const syncRows = document.getElementById('sync-rows') as HTMLTableElement;
  const syncResync = document.getElementById('sync-resync') as HTMLButtonElement;
  syncResync.title = t('control.syncCheckResyncTitle');
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let lastState: (ChannelStateLike & { sources?: SourceLike[] }) | null = null;
  let lastFetchedAt = 0;

  const previewRuntime = (): (RuntimeLike & { joinAt(r: unknown, o?: { force?: boolean }): boolean }) | null => {
    const frame = previewFrame.querySelector('iframe');
    try {
      const win = frame?.contentWindow as (Window & { breeze?: { runtime?: unknown } }) | null | undefined;
      return (win?.breeze?.runtime as ReturnType<typeof previewRuntime>) ?? null;
    } catch {
      return null;
    }
  };

  /** The output the check compares against — see above. */
  const comparedSource = (state: { sources?: SourceLike[] }): { source: SourceLike; n: number } | null => {
    const all = state.sources ?? [];
    const on = onAirSources(state);
    let source: SourceLike | undefined;
    if (syncChoice !== SYNC_AUTO && syncChoice !== SYNC_OFF) {
      source = all.find((s) => (s.page ?? s.id) === syncChoice);
    }
    source ??= on.reduce<SourceLike | undefined>((a, b) => (!a || (b.reportedAt ?? 0) > (a.reportedAt ?? 0) ? b : a), undefined);
    return source ? { source, n: all.indexOf(source) + 1 } : null;
  };

  const sideText = (check: { kind: CheckKind }, side: SyncSide | null): string => {
    if (!side) return t('control.syncCheckMissing');
    if (check.kind === 'playback') return t('control.syncCheckState', { state: side.state ?? '', step: side.step ?? 0 });
    if (check.kind === 'table') {
      const page = (side.page ?? 0) + 1;
      const vars = { key: side.key ?? t('control.syncCheckPageNumber', { n: page }), page, count: side.pageCount ?? '?' };
      return typeof side.secondsLeft === 'number'
        ? t('control.syncCheckPageLeft', { ...vars, seconds: side.secondsLeft.toFixed(1) })
        : t('control.syncCheckPage', vars);
    }
    const text = (side.text ?? '').replace(/\s+/g, ' ').trim();
    // The ellipsis is the truncation mark, not a word.
    // i18n-ignore-next-line
    return text.length > 48 ? `${text.slice(0, 47)}…` : text;
  };

  /** The first column of a check row: what is being compared. */
  const whatText = (check: { kind: CheckKind; name: string }): string =>
    check.kind === 'playback' ? t('control.syncCheckPlayback')
    : check.kind === 'table' ? t('control.syncCheckTable', { name: check.name })
    : t('control.syncCheckCrawl', { name: check.name.split('/').pop() ?? check.name });

  /**
   * Fill ↔ matte (Phase 9 Wave C).
   *
   * A switcher keying from a fill page and a `?matte=1` page needs both on the
   * same moment of the graphic: a matte that missed a PLAY cuts a hole where
   * nothing is. For every matte output on this graphic, compare it with its
   * fill — one on the same machine first (`keyPairs`) — by the same rules as
   * the preview check, the older report aged to the newer. Independent of the
   * preview: it reads two outputs, so it shows in cued mode too. Out-of-step
   * rows are listed; an in-step pair is one line.
   */
  const keyPairsBox = document.getElementById('key-pairs')!;
  const renderKeyPairs = (): void => {
    keyPairsBox.textContent = '';
    if (!lastState) return;
    const all = lastState.sources ?? [];
    const outputName = (source: SourceLike): string => t('control.syncCheckOutputName', { n: all.indexOf(source) + 1 });
    for (const pair of keyPairs(all)) {
      const box = document.createElement('div');
      box.className = 'key-pair';  // i18n-ignore — className
      const head = document.createElement('div');
      head.className = 'sync-head';  // i18n-ignore — className
      const badge = document.createElement('span');
      badge.className = 'sync-badge';  // i18n-ignore — className
      head.appendChild(badge);
      box.appendChild(head);
      keyPairsBox.appendChild(box);

      if (!pair.fill) {
        badge.textContent = t('control.keyPairNoFill', { matte: outputName(pair.matte) });
        badge.dataset['ok'] = 'false';
        continue;
      }
      const vars = { fill: outputName(pair.fill), matte: outputName(pair.matte) };
      const result = compareKeyPair(pair.fill, pair.matte);
      if (!result) {
        badge.textContent = t('control.keyPairWaiting', vars);
        continue;
      }
      badge.textContent = result.ok ? t('control.keyPairInStep', vars) : t('control.keyPairOutOfStep', vars);
      badge.dataset['ok'] = String(result.ok);
      const apart = document.createElement('span');
      apart.className = 'sub';  // i18n-ignore — className
      apart.textContent = t('control.keyPairApart', { apart: (result.apartMs / 1000).toFixed(1) });
      head.appendChild(apart);
      if (result.ok) continue;

      const table = document.createElement('table');
      table.className = 'sync-rows';  // i18n-ignore — className
      const th = table.createTHead().insertRow();
      for (const key of ['', 'control.syncCheckColWhat', 'control.syncCheckColFill', 'control.syncCheckColMatte']) {
        const cell = document.createElement('th');
        cell.textContent = key ? t(key) : '';
        th.appendChild(cell);
      }
      const body = table.createTBody();
      for (const check of result.checks) {
        if (check.ok) continue;
        const row = body.insertRow();
        row.dataset['ok'] = 'false';
        const matteText =
          check.kind === 'crawl' && typeof check.driftMs === 'number'
            ? t('control.syncCheckDrift', { drift: `${check.driftMs >= 0 ? '+' : ''}${(check.driftMs / 1000).toFixed(2)}` })
            : sideText(check, check.matte);
        for (const [i, text] of ['\u2717', whatText(check), sideText(check, check.fill), matteText].entries()) {
          const cell = row.insertCell();
          if (i === 0) cell.className = 'mark';  // i18n-ignore — className
          cell.textContent = text;
        }
      }
      box.appendChild(table);
    }
  };

  const renderCheck = (): void => {
    renderKeyPairs();
    const runtime = previewRuntime();
    const compared = lastState ? comparedSource(lastState) : null;
    syncRows.textContent = '';
    syncResync.hidden = true;
    syncAge.textContent = '';
    // A cued preview shows values that are not on air, so it is not compared.
    if (syncChoice === SYNC_CUED) {
      syncBadge.textContent = t('control.syncCheckCued');
      syncBadge.removeAttribute('data-ok');
      return;
    }
    if (!runtime || !lastState) {
      syncBadge.textContent = t('control.syncCheckWaiting');
      syncBadge.removeAttribute('data-ok');
      return;
    }
    if (!compared?.source.playback || compared.source.reportedAt === null) {
      syncBadge.textContent = t('control.syncCheckNoOutput');
      syncBadge.removeAttribute('data-ok');
      return;
    }
    const { source, n } = compared;
    const ageMs = Math.max(0, (lastState.now ?? lastFetchedAt) - source.reportedAt!) + (Date.now() - lastFetchedAt);
    const checks = compareReports(source.playback!, ageMs, reportOf(runtime));
    const ok = checks.every((c) => c.ok);
    const output = t('control.syncCheckOutputName', { n });
    syncBadge.textContent = t(ok ? 'control.syncCheckInStep' : 'control.syncCheckOutOfStep', { output });
    syncBadge.dataset['ok'] = String(ok);
    syncAge.textContent = t('control.syncCheckAge', { age: (ageMs / 1000).toFixed(1) });
    syncResync.hidden = ok;

    const head = syncRows.createTHead().insertRow();
    for (const key of ['', 'control.syncCheckColWhat', 'control.syncCheckColOutput', 'control.syncCheckColPreview']) {
      const th = document.createElement('th');
      th.textContent = key ? t(key) : '';
      head.appendChild(th);
    }
    const body = syncRows.createTBody();
    for (const check of checks) {
      const row = body.insertRow();
      row.dataset['ok'] = String(check.ok);
      const what = whatText(check);
      const preview =
        check.kind === 'crawl' && typeof check.driftMs === 'number'
          ? t('control.syncCheckDrift', { drift: `${check.driftMs >= 0 ? '+' : ''}${(check.driftMs / 1000).toFixed(2)}` })
          : sideText(check, check.preview);
      for (const [i, text] of [check.ok ? '\u2713' : '\u2717', what, sideText(check, check.output), preview].entries()) {
        const cell = row.insertCell();
        if (i === 0) cell.className = 'mark';  // i18n-ignore — className
        cell.textContent = text;
      }
    }
  };

  const pollCheck = async (): Promise<void> => {
    try {
      const url = `/api/control/${encodeURIComponent(boot.projectId)}/${encodeURIComponent(boot.compositionId)}/state?data=0`;
      const body = (await (await fetch(url)).json()) as { state?: ChannelStateLike & { sources?: SourceLike[] } };
      if (body.state) {
        lastState = body.state;
        lastFetchedAt = Date.now();
      }
    } catch {
      // A missed poll leaves the last reading up; the age shown says how old it is.
    }
    renderCheck();
  };

  const runCheck = (on: boolean): void => {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
    lastState = null;
    if (!on) return;
    renderCheck();
    void pollCheck();
    syncTimer = setInterval(() => void pollCheck(), 2_000);
  };

  syncResync.addEventListener('click', () => {
    const runtime = previewRuntime();
    if (!runtime || !lastState) return;
    const compared = comparedSource(lastState);
    const choice = compared?.source.page ?? compared?.source.id ?? SYNC_AUTO;
    // Aged by the time since the fetch as well, like the check itself.
    const target = joinTarget({ ...lastState, now: (lastState.now ?? lastFetchedAt) + (Date.now() - lastFetchedAt) }, choice);
    if (target) runtime.joinAt(target, { force: true });
    renderCheck();
  });

  /* ------------------------------------------------------------- fields */

  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  /** Dataset bindings are edited as a grid, not a text field. */
  const grids = new Map<string, DatasetGrid>();
  /** Fed bindings are displayed, never edited. Keyed by source id. */
  const fed = new Map<string, FedField>();
  /** Typed fields (Phase 9 Wave B) — each knows its own value. */
  const typed = new Map<string, { value(): unknown }>();

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

    if (TYPED_KINDS.has(binding.kind)) {
      const commitTyped = (): void => (cueMode ? scheduleCued() : sendUpdate());
      const field = makeTypedField(binding, commitTyped, boot.assets ?? []);
      fields.appendChild(field.el);
      typed.set(binding.name, field);
      continue;
    }

    if (binding.kind === 'dataset') {
      const seed = binding.source ? boot.datasets?.[binding.source] : undefined;
      // In cue mode a table edit is part of the buffer, not an update on air.
      const commit = (): void => (cueMode ? scheduleCued() : sendUpdate());
      const grid = makeDatasetGrid(binding, commit, seed as DatasetValue | undefined);
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
        if ((e as KeyboardEvent).key !== 'Enter') return;
        if (cueMode) scheduleCued();
        else sendUpdate();
      });
    }
    input.addEventListener('input', () => {
      if (cueMode) scheduleCued();
    });

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
    /*
     * Only a grid the operator has changed. PLAY sends this, and a table is
     * the one field where "what the panel happens to hold" can be badly wrong:
     * a table fed by a source, with no rows of its own, sent its empty grid
     * with every PLAY and replaced the live rows with nothing — the tiles of a
     * weather rotation came up blank while NEXT, which sends no data, worked.
     * An untouched grid has nothing to say that the graphic does not already
     * show; an edited one was already sent when it was committed, and is sent
     * again here so PLAY after an edit still carries it.
     */
    for (const [name, grid] of grids) if (grid.touched) data[name] = grid.value();
    for (const [name, field] of typed) data[name] = field.value();
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
        state?: {
          renderers: number;
          playback?: unknown;
          reportedAt?: number | null;
          now?: number;
          data?: Record<string, unknown>;
          sources?: SourceLike[];
        };
      };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === 'welcome' || message.type === 'state') {
        render(message.state);
        renderFed(message.state?.data);
        timerBlock.render(message.state?.data);
        gameBlock.render(message.state?.data);
        scrollBlock.render(message.state?.data, message.state?.playback);
        pollBlock.render(message.state?.data);
        if (message.state) renderSyncMenu(message.state.sources);
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

  function render(state?: { renderers: number; playback?: unknown; reportedAt?: number | null; now?: number }): void {
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
    pages.render(state.renderers > 0 ? playback?.tables : undefined, reportAgeSeconds(state));
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

  /* ------------------------------------------------------------- timers */

  const timerBlock = makeTimerBlock(boot.timers ?? [], send);
  const gameBlock = makeGameBlock(boot, key);
  // Wave R: rolls, polls and texts.
  const scrollBlock = makeScrollBlock(boot.scrolls ?? [], send);
  const pollBlock = makePollBlock(boot, key);
  makeTextBlock(boot, key);

  /* ------------------------------------------------------------ actions */

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-verb]')) {
    button.addEventListener('click', () => {
      const verb = button.dataset['verb']!;
      // PLAY carries the current field values, so an operator can type a name
      // and hit PLAY without a separate update step — except in cue mode,
      // where the fields are a buffer that only TAKE sends.
      send(verb === 'play' && !cueMode ? { verb, data: currentData() } : { verb });
    });
  }

  document.getElementById('send')?.addEventListener('click', sendUpdate);
  takeButton?.addEventListener('click', () => send({ verb: 'take', data: currentData() }));
  applyCueMode();

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
