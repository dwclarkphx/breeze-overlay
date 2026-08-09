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
    };
  }
}

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
  addBtn.textContent = '+ Row';
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
      btn.title = 'Remove row';
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
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString(undefined, { hour12: false });
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
  tag.textContent = binding.sourceType ?? 'fed';
  tag.title = binding.sourceName
    ? `Fed by "${binding.sourceName}" (${binding.source})`
    : `Fed by ${binding.source}`;
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
      empty(data ? 'Source returned no rows.' : 'Waiting for the first poll…');
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
          stateEl.textContent = 'no output';
          return;
        }
        stateEl.textContent = playback
          ? `${playback.state} · step ${playback.step}/${playback.stepCount}`
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

const boot = window.__BREEZE_CONTROL__;
if (boot) start(boot);

function start(boot: NonNullable<Window['__BREEZE_CONTROL__']>): void {
  const channel = `${boot.projectId}/${boot.compositionId}`;
  const key = new URLSearchParams(location.search).get('key') ?? '';

  wireSceneElements(boot, key);

  const dot = document.getElementById('dot')!;
  const status = document.getElementById('status')!;
  const stepEl = document.getElementById('step')!;
  const playbackEl = document.getElementById('playback')!;
  const fields = document.getElementById('fields')!;

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
    dot.className = `dot ${cls}`;
  }

  function connect(): void {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}/ws/control`);

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
      | { state: string; step: number; stepCount: number }
      | null
      | undefined;

    if (state.renderers > 0) {
      setStatus(`${state.renderers} output${state.renderers > 1 ? 's' : ''} connected`, 'live');
    } else {
      setStatus('no output connected', 'off');
    }

    playbackEl.textContent = playback?.state ?? 'idle';
    stepEl.textContent = playback ? `${playback.step}/${playback.stepCount}` : '–';
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
      body: JSON.stringify(command['data'] ?? {}),
    }).catch(() => {
      if (command['verb'] === 'update') queued.push(command['data'] as Record<string, unknown>);
    });
  }

  function sendUpdate(): void {
    send({ verb: 'update', data: currentData() });
  }

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
