// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Rundown panel client (Phase 9 Wave A).
 *
 * Prepare a list of items before the service — a composition, its field
 * values, where it goes — then walk it: the armed item shows in the preview
 * exactly as it will air, and TAKE (space) puts it up and arms the next.
 *
 * The list is `rundowns.json` on the server, saved whole on every change. What
 * is armed and what is on air is server state, broadcast on the project's
 * rundown channel, so two panels agree and a refreshed panel comes back on the
 * same item.
 */

export {};

import {
  DEFAULT_OUTPUT,
  OUTPUT_NAME_PATTERN,
  RUNDOWNS_REVISION_KEY,
  RUNDOWN_UPDATE_KEY,
  emptyRundowns,
  itemTarget,
  itemTitle,
  newRundownId,
  rundownChannel,
  scrollAtEnd,
  scrollPosition,
  toBoolean,
  toNumber,
  type ScrollInfo,
  type ScrollState,
  type Rundown,
  type RundownItem,
  type RundownLive,
  type RundownsFile,
} from '@breeze/schema';

import { bootI18n } from './i18n.js';

interface Binding {
  name: string;
  kind: string;
  label: string;
  defaultValue: unknown;
}

interface CompositionInfo {
  id: string;
  name: string;
  bindings: Binding[];
}

declare global {
  interface Window {
    __BREEZE_RUNDOWN__?: {
      projectId: string;
      compositions: CompositionInfo[];
      locale?: string;
      messages?: Record<string, string>;
    };
  }
}

interface TargetState {
  target: string;
  item: string | null;
  state: string;
  renderers: number;
  /** Rolls on the target (Wave R): each scroll's state and what its outputs reported. */
  scrolls?: Array<{ id: string; state: ScrollState; info?: ScrollInfo }>;
  /** The hub's clock when this was read. */
  clock?: number;
}

const boot = window.__BREEZE_RUNDOWN__;
const { t } = bootI18n(boot);

/** Tiny element builder: tag, attributes/properties, children. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const child of children) if (child !== null && child !== undefined) el.append(child);
  return el;
}

function store(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // Private window or blocked storage: the panel still works, it just forgets.
  }
  return null;
}

if (boot) start(boot);

function start(cfg: NonNullable<Window['__BREEZE_RUNDOWN__']>): void {
  const pid = cfg.projectId;
  const key = new URLSearchParams(location.search).get('key') ?? '';
  const comps = new Map(cfg.compositions.map((c) => [c.id, c]));
  const compName = (id: string) => comps.get(id)?.name || id;

  let doc: RundownsFile = emptyRundowns();
  let currentId: string | null = store(`breeze.rundown.${pid}`);
  let live: Record<string, RundownLive> = {};
  let revision: unknown = undefined;
  let targets: TargetState[] = [];
  let advance = store('breeze.rundown.advance') !== '0';

  const current = (): Rundown | undefined => doc.rundowns.find((r) => r.id === currentId) ?? doc.rundowns[0];
  const liveOf = (): RundownLive => {
    const rundown = current();
    return (rundown ? live[rundown.id] : undefined) ?? { armed: null, onAir: {} };
  };

  /* ------------------------------------------------------------ transport */

  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...(key ? { 'x-breeze-key': key } : {}),
  });

  const errorBox = h('div', { className: 'err', role: 'alert' });
  const showError = (text: string): void => {
    errorBox.textContent = text;
  };

  async function loadDoc(): Promise<void> {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(pid)}/rundowns`);
      if (res.ok) doc = (await res.json()) as RundownsFile;
    } catch {
      showError(t('rundown.loadFailed'));
    }
    render();
  }

  async function save(next: RundownsFile): Promise<boolean> {
    const before = doc;
    doc = next;
    render();
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(pid)}/rundowns`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          issues?: Array<{ path: string; message: string }>;
        };
        const reason = body.issues?.map((i) => `${i.path} ${i.message}`).join('; ') ?? body.error ?? String(res.status); // i18n-ignore — a path list
        showError(res.status === 401 ? t('control.signInNeeded') : t('rundown.saveFailed', { reason }));
        doc = before;
        render();
        return false;
      }
      showError('');
      return true;
    } catch {
      showError(t('rundown.saveFailed', { reason: t('rundown.offline') }));
      doc = before;
      render();
      return false;
    }
  }

  type Verb = 'cue' | 'take' | 'rundownNext' | 'rundownPrev' | 'out';

  /** A rundown verb: over the socket when it is open, REST when not. */
  function command(verb: Verb, extra: Record<string, unknown> = {}): void {
    const rundown = current();
    if (!rundown) return;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'command', command: { verb, rundown: rundown.id, ...extra } }));
      return;
    }
    const path = verb === 'rundownNext' ? 'next' : verb === 'rundownPrev' ? 'prev' : verb;
    // i18n-ignore-next-line — an API path, frozen per I18N.md §2
    const url = `/api/rundown/${encodeURIComponent(pid)}/${encodeURIComponent(rundown.id)}/${path}`;
    void fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(extra) })
      .then(async (res) => {
        if (!res.ok) showError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
      })
      .catch(() => showError(t('rundown.offline')));
  }

  const cue = (item: string | null) => command('cue', { item });
  const take = () => command('take', { advance });
  const next = () => command('rundownNext');
  const prev = () => command('rundownPrev');
  const out = () => command('out');

  /* -------------------------------------------------------------- socket */

  const dot = document.getElementById('dot')!;
  const status = document.getElementById('status')!;
  let socket: WebSocket | null = null;
  let retry = 0;

  function connect(): void {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const auth = key ? `?key=${encodeURIComponent(key)}` : '';
    socket = new WebSocket(`${scheme}://${location.host}/ws/control${auth}`);
    socket.addEventListener('open', () => {
      retry = 0;
      dot.className = 'dot live'; // i18n-ignore — className
      status.textContent = t('rundown.connected');
      socket!.send(
        JSON.stringify({ type: 'subscribe', channel: rundownChannel(pid), role: 'controller', client: 'panel' }),
      );
    });
    socket.addEventListener('message', (event) => {
      let message: { type: string; code?: string; message?: string; state?: { data?: Record<string, unknown> } };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === 'welcome' || message.type === 'state') {
        const data = message.state?.data ?? {};
        const next = data[RUNDOWN_UPDATE_KEY];
        if (next && typeof next === 'object') live = next as Record<string, RundownLive>;
        const rev = data[RUNDOWNS_REVISION_KEY];
        // Another panel saved the list: read it again.
        if (rev !== undefined && rev !== revision) {
          const first = revision === undefined;
          revision = rev;
          if (!first) void loadDoc();
        }
        render();
      }
      if (message.type === 'error') {
        showError(message.code === 'error.apiKeyRequired' ? t('control.signInNeeded') : (message.message ?? ''));
      }
    });
    socket.addEventListener('close', () => {
      dot.className = 'dot off'; // i18n-ignore — className
      status.textContent = t('rundown.reconnecting');
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, Math.min(500 * 2 ** retry, 10_000));
    });
    socket.addEventListener('error', () => socket?.close());
  }

  /* ------------------------------------------------------------ skeleton */

  const app = document.getElementById('app')!;
  const picker = h('select', { 'aria-label': t('rundown.pick') });
  const nameInput = h('input', { 'aria-label': t('rundown.name'), placeholder: t('rundown.name') });
  const deleteBtn = h('button', { type: 'button', className: 'stop' }, t('rundown.delete'));
  let deleteArmed = false;

  const list = h('ul', { className: 'items' });
  const addBtn = h('button', { type: 'button' }, t('rundown.addItem'));
  const editor = h('fieldset', { className: 'editor', hidden: true });

  const frameBox = h('div', { className: 'preview-frame' });
  const cuedTitle = h('strong', {}, t('rundown.nothingArmed'));
  const previewMode = h(
    'select',
    { 'aria-label': t('rundown.previewMode') },
    h('option', { value: 'cued' }, t('rundown.previewCued')),
    h('option', { value: 'off' }, t('rundown.previewOff')),
  );
  previewMode.value = store('breeze.rundown.preview') === 'off' ? 'off' : 'cued';

  const takeBtn = h('button', { type: 'button', className: 'go big take', onclick: () => take() }, t('rundown.take')); // i18n-ignore — className
  const prevBtn = h('button', { type: 'button', className: 'big', onclick: () => prev() }, t('rundown.prev'));
  const nextBtn = h('button', { type: 'button', className: 'big', onclick: () => next() }, t('rundown.next'));
  const outBtn = h('button', { type: 'button', className: 'stop', onclick: () => out() }, t('rundown.out'));
  const advanceBox = h('input', { type: 'checkbox', checked: advance });
  advanceBox.addEventListener('change', () => {
    advance = advanceBox.checked;
    store('breeze.rundown.advance', advance ? '1' : '0');
  });
  const targetTable = h('table', { className: 'targets' });

  app.append(
    h(
      'div',
      { className: 'row', style: 'margin-bottom:12px' },
      picker,
      nameInput,
      h('button', { type: 'button', onclick: () => void newRundown() }, t('rundown.new')),
      deleteBtn,
    ),
    errorBox,
    h(
      'div',
      { className: 'grid' },
      h(
        'div',
        { className: 'list' },
        h(
          'fieldset',
          {},
          h('legend', {}, t('rundown.items')),
          list,
          h('div', { className: 'row' }, addBtn),
          h('div', { className: 'hint' }, t('rundown.listHint')),
        ),
        editor,
      ),
      h(
        'div',
        { className: 'side' },
        h(
          'fieldset',
          {},
          h('legend', {}, t('rundown.cued')),
          h('div', { className: 'preview-head' }, cuedTitle, h('span', { className: 'sub' }, previewMode)),
          frameBox,
          h('div', { className: 'transport' }, takeBtn, prevBtn, nextBtn),
          h(
            'div',
            { className: 'row' },
            outBtn,
            h('label', { className: 'inline' }, advanceBox, h('span', {}, t('rundown.advance'))),
          ),
          h('div', { className: 'hint' }, t('rundown.keysHint')),
        ),
        h(
          'fieldset',
          {},
          h('legend', {}, t('rundown.targets')),
          targetTable,
          h('div', { className: 'hint' }, t('rundown.targetsHint')),
        ),
      ),
    ),
  );

  picker.addEventListener('change', () => {
    currentId = picker.value;
    store(`breeze.rundown.${pid}`, currentId);
    render();
    void pollState();
  });
  nameInput.addEventListener('change', () => {
    const rundown = current();
    if (!rundown) return;
    const name = nameInput.value.trim() || rundown.name;
    void save({ ...doc, rundowns: doc.rundowns.map((r) => (r.id === rundown.id ? { ...r, name } : r)) });
  });
  deleteBtn.addEventListener('click', () => {
    const rundown = current();
    if (!rundown) return;
    // Two presses: there is no undo for a list somebody spent the afternoon typing.
    if (!deleteArmed) {
      deleteArmed = true;
      deleteBtn.textContent = t('rundown.deleteConfirm');
      setTimeout(() => {
        deleteArmed = false;
        deleteBtn.textContent = t('rundown.delete');
      }, 4000);
      return;
    }
    deleteArmed = false;
    deleteBtn.textContent = t('rundown.delete');
    void save({ ...doc, rundowns: doc.rundowns.filter((r) => r.id !== rundown.id) });
  });
  addBtn.addEventListener('click', () => openEditor(null));
  previewMode.addEventListener('change', () => {
    store('breeze.rundown.preview', previewMode.value);
    framed = null;
    renderPreview();
  });

  async function newRundown(): Promise<void> {
    const ids = new Set(doc.rundowns.map((r) => r.id));
    const id = newRundownId('rd', ids);
    const name = t('rundown.defaultName', { n: doc.rundowns.length + 1 });
    if (await save({ ...doc, rundowns: [...doc.rundowns, { id, name, items: [] }] })) {
      currentId = id;
      store(`breeze.rundown.${pid}`, id);
      render();
    }
  }

  const replaceItems = (items: RundownItem[]): Promise<boolean> => {
    const rundown = current();
    if (!rundown) return Promise.resolve(false);
    return save({ ...doc, rundowns: doc.rundowns.map((r) => (r.id === rundown.id ? { ...r, items } : r)) });
  };

  /* -------------------------------------------------------------- editor */

  /** Every output name in use, plus the default one. */
  const outputsInUse = (): string[] => {
    const names = new Set<string>([DEFAULT_OUTPUT]);
    for (const r of doc.rundowns) for (const i of r.items) if (i.output) names.add(i.output);
    return [...names].sort();
  };

  function openEditor(existing: RundownItem | null): void {
    const rundown = current();
    if (!rundown) return;
    editor.hidden = false;
    editor.textContent = '';
    editor.append(h('legend', {}, existing ? t('rundown.editItem') : t('rundown.addItem')));

    const compSelect = h('select', {});
    for (const c of cfg.compositions) compSelect.append(h('option', { value: c.id }, c.name || c.id));
    compSelect.value = existing?.composition ?? cfg.compositions[0]?.id ?? '';

    const label = h('input', { value: existing?.label ?? '', placeholder: t('rundown.labelPlaceholder') }); // i18n-ignore — attribute names

    const outputSelect = h('select', {}, h('option', { value: '' }, t('rundown.ownChannel')));
    for (const name of outputsInUse()) outputSelect.append(h('option', { value: name }, `@${name}`));
    outputSelect.append(h('option', { value: '*' }, t('rundown.newOutput')));
    const outputName = h('input', { placeholder: t('rundown.outputPlaceholder'), hidden: true });
    const layer = h('input', { type: 'number', step: '1', value: String(existing?.layer ?? 0) });
    const layerLabel = h('label', {}, h('span', {}, t('rundown.layer')), layer);
    outputSelect.value = existing?.output ?? '';
    const syncOutput = () => {
      outputName.hidden = outputSelect.value !== '*';
      layerLabel.hidden = outputSelect.value === '';
    };
    outputSelect.addEventListener('change', syncOutput);
    syncOutput();

    const fieldsBox = h('div', {});
    const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
    const renderFields = () => {
      fieldsBox.textContent = '';
      inputs.clear();
      const comp = comps.get(compSelect.value);
      const values = existing && existing.composition === compSelect.value ? (existing.data ?? {}) : {};
      for (const b of comp?.bindings ?? []) {
        if (b.kind === 'dataset') {
          fieldsBox.append(h('div', { className: 'hint' }, t('rundown.tableField', { name: b.label || b.name })));
          continue;
        }
        const multiline = b.kind === 'stringList';
        const input = multiline ? h('textarea', { rows: 3 }) : h('input', {});
        const raw = b.name in values ? values[b.name] : b.defaultValue;
        input.value = Array.isArray(raw) ? raw.join('\n') : String(raw ?? '');
        inputs.set(b.name, input);
        fieldsBox.append(h('label', {}, h('span', {}, b.label || b.name), input));
      }
      if (!comp?.bindings.length) fieldsBox.append(h('div', { className: 'hint' }, t('rundown.noFields')));
    };
    compSelect.addEventListener('change', renderFields);
    renderFields();

    const problem = h('div', { className: 'err' });
    const saveBtn = h('button', { type: 'button', className: 'go' }, t('rundown.saveItem'));
    const cancelBtn = h(
      'button',
      {
        type: 'button',
        onclick: () => {
          editor.hidden = true;
        },
      },
      t('rundown.cancel'),
    );

    saveBtn.addEventListener('click', () => {
      const output = outputSelect.value === '*' ? outputName.value.trim().toLowerCase() : outputSelect.value;
      if (output && !OUTPUT_NAME_PATTERN.test(output)) {
        problem.textContent = t('rundown.outputInvalid');
        return;
      }
      const comp = comps.get(compSelect.value);
      const data: Record<string, unknown> = {};
      for (const [name, input] of inputs) {
        const binding = comp?.bindings.find((b) => b.name === name);
        // Typed fields (Phase 9 Wave B) keep their type, so a score is sent as a number.
        data[name] =
          binding?.kind === 'stringList'
            ? input.value
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean)
            : binding?.kind === 'number'
              ? (toNumber(input.value) ?? input.value)
              : binding?.kind === 'boolean'
                ? toBoolean(input.value)
                : input.value;
      }
      const ids = new Set(rundown.items.map((i) => i.id));
      const layerValue = Math.trunc(Number(layer.value) || 0);
      const item: RundownItem = {
        id: existing?.id ?? newRundownId('it', ids),
        composition: compSelect.value,
        ...(label.value.trim() ? { label: label.value.trim() } : {}),
        data,
        ...(output ? { output } : {}),
        ...(output && layerValue ? { layer: layerValue } : {}),
      };
      const items = existing ? rundown.items.map((i) => (i.id === existing.id ? item : i)) : [...rundown.items, item];
      void replaceItems(items).then((ok) => {
        if (ok) editor.hidden = true;
      });
    });

    editor.append(
      h('label', {}, h('span', {}, t('rundown.composition')), compSelect),
      h('label', {}, h('span', {}, t('rundown.label')), label),
      h('label', {}, h('span', {}, t('rundown.output')), outputSelect, outputName),
      layerLabel,
      fieldsBox,
      problem,
      h('div', { className: 'row' }, saveBtn, cancelBtn),
    );
    compSelect.focus();
  }

  /* -------------------------------------------------------------- render */

  function toolButton(label: string, glyph: string, fn: () => void, disabled = false): HTMLButtonElement {
    return h(
      'button',
      {
        type: 'button',
        title: label,
        'aria-label': label,
        disabled,
        onclick: (e: Event) => {
          e.stopPropagation();
          fn();
        },
      },
      glyph,
    );
  }

  function render(): void {
    const rundown = current();
    if (rundown && rundown.id !== currentId) currentId = rundown.id;

    picker.textContent = '';
    for (const r of doc.rundowns) picker.append(h('option', { value: r.id }, r.name || r.id));
    if (rundown) picker.value = rundown.id;
    picker.hidden = doc.rundowns.length === 0;
    nameInput.hidden = !rundown;
    deleteBtn.hidden = !rundown;
    if (rundown && document.activeElement !== nameInput) nameInput.value = rundown.name;
    addBtn.disabled = !rundown || cfg.compositions.length === 0;

    const state = liveOf();
    const onAir = new Set(Object.values(state.onAir));
    list.textContent = '';
    if (!rundown) list.append(h('li', {}, t('rundown.none')));
    else if (rundown.items.length === 0) list.append(h('li', {}, t('rundown.empty')));
    rundown?.items.forEach((item, index) => {
      const armed = state.armed === item.id;
      const target = itemTarget(item);
      const tools = h(
        'span',
        { className: 'tools' },
        toolButton(t('rundown.edit'), '✎', () => openEditor(item)),
        toolButton(t('rundown.moveUp'), '↑', () => void move(index, -1), index === 0),
        toolButton(t('rundown.moveDown'), '↓', () => void move(index, 1), index === rundown.items.length - 1),
        toolButton(t('rundown.remove'), '✕', () => void replaceItems(rundown.items.filter((i) => i.id !== item.id))),
      );
      const where = target.startsWith('@') ? target : t('rundown.ownShort');
      list.append(
        h(
          'li',
          {
            dataset: { armed: String(armed), onair: String(onAir.has(item.id)) },
            title: t('rundown.clickToArm'),
            onclick: () => cue(armed ? null : item.id),
          },
          h('span', { className: 'n' }, String(index + 1)),
          h('span', { className: 'title' }, itemTitle(item, compName(item.composition))),
          h('span', { className: 'meta' }, t('rundown.where', { composition: compName(item.composition), target: where })),
          armed ? h('span', { className: 'chip armed' }, t('rundown.armed')) : null, // i18n-ignore — className
          onAir.has(item.id) ? h('span', { className: 'chip onair' }, t('rundown.onAir')) : null, // i18n-ignore — className
          tools,
        ),
      );
    });

    const armedItem = rundown?.items.find((i) => i.id === state.armed);
    cuedTitle.textContent = armedItem ? itemTitle(armedItem, compName(armedItem.composition)) : t('rundown.nothingArmed');
    takeBtn.disabled = !armedItem;
    outBtn.disabled = !armedItem;
    renderPreview();
    renderTargets();
  }

  async function move(index: number, delta: -1 | 1): Promise<void> {
    const rundown = current();
    if (!rundown) return;
    const items = [...rundown.items];
    const [moved] = items.splice(index, 1);
    items.splice(index + delta, 0, moved!);
    await replaceItems(items);
  }

  /* ------------------------------------------------------------- preview */

  /*
   * Show cued: the armed item's composition in a real output page that has no
   * socket (`?hub=off`), so nothing on air reaches it. The panel puts the
   * item's values in and cuts it to its hold — the real graphic, with the
   * real Fit Width result, before it airs.
   */
  let frame: HTMLIFrameElement | null = null;
  let framed: string | null = null;

  function cuedValues(item: RundownItem): Record<string, unknown> {
    const defaults: Record<string, unknown> = {};
    for (const b of comps.get(item.composition)?.bindings ?? []) {
      if (b.kind !== 'dataset') defaults[b.name] = b.defaultValue;
    }
    return { ...defaults, ...(item.data ?? {}) };
  }

  interface PreviewRuntime {
    update(d: Record<string, unknown>): void;
    joinAt(r: { state: string; time: number; step: number }, o: { force: boolean }): boolean;
    play(): void;
  }

  function applyCued(item: RundownItem): boolean {
    const win = frame?.contentWindow as (Window & { breeze?: { runtime: PreviewRuntime } }) | null | undefined;
    const runtime = win?.breeze?.runtime;
    if (!runtime) return false;
    runtime.update(cuedValues(item));
    // Cut to the first hold. A graphic with no hold just plays.
    if (!runtime.joinAt({ state: 'holding', time: 0, step: 1 }, { force: true })) runtime.play();
    return true;
  }

  function renderPreview(): void {
    const rundown = current();
    const armed = rundown?.items.find((i) => i.id === liveOf().armed);
    if (previewMode.value === 'off' || !armed) {
      frameBox.textContent = '';
      frame = null;
      framed = null;
      return;
    }
    if (framed === armed.composition && frame) {
      applyCued(armed);
      return;
    }
    framed = armed.composition;
    frameBox.textContent = '';
    const params = new URLSearchParams({ scale: 'contain', preview: '1', hub: 'off' });
    frame = h('iframe', {
      title: t('rundown.previewTitle'),
      src: `/play/${encodeURIComponent(pid)}/${encodeURIComponent(armed.composition)}?${params.toString()}`,
    });
    frame.addEventListener('load', () => {
      // The page builds its runtime after its own scripts load; retry briefly.
      let tries = 0;
      const attempt = () => {
        const now = current()?.items.find((i) => i.id === liveOf().armed);
        if (!now || now.composition !== framed) return;
        if (!applyCued(now) && tries++ < 40) setTimeout(attempt, 50);
      };
      attempt();
    });
    frameBox.append(frame);
  }

  /* ------------------------------------------------------------- targets */

  function renderTargets(): void {
    targetTable.textContent = '';
    const rundown = current();
    if (!rundown || targets.length === 0) {
      targetTable.append(h('tr', {}, h('td', {}, t('rundown.noTargets'))));
      return;
    }
    for (const target of targets) {
      const item = target.item ? rundown.items.find((i) => i.id === target.item) : undefined;
      const isOutput = target.target.startsWith('@');
      const output = target.target.slice(1);
      const url = isOutput
        ? `/out/${encodeURIComponent(pid)}/${encodeURIComponent(output)}`
        : `/play/${encodeURIComponent(pid)}/${encodeURIComponent(target.target)}`;
      const copy = h('button', { type: 'button', title: t('rundown.copyUrl') }, t('rundown.copy'));
      copy.addEventListener('click', () => {
        void navigator.clipboard?.writeText(`${location.origin}${url}`);
      });
      const clear = isOutput
        ? h(
            'button',
            {
              type: 'button',
              title: t('rundown.clearOutputTitle'),
              onclick: () => {
                // i18n-ignore-next-line — an API path, frozen per I18N.md §2
                const api = `/api/out/${encodeURIComponent(pid)}/${encodeURIComponent(output)}/clear`;
                void fetch(api, { method: 'POST', headers: headers(), body: '{}' }).then(() => pollState());
              },
            },
            t('rundown.clearOutput'),
          )
        : null;
      targetTable.append(
        h(
          'tr',
          {},
          h('td', {}, h('code', {}, isOutput ? target.target : compName(target.target))),
          h('td', {}, item ? itemTitle(item, compName(item.composition)) : '—'),
          // A frozen playback state, like the control panel's readout.
          h('td', { className: 'sub' }, target.state),
          h('td', { className: 'sub' }, t('rundown.outputs', { count: target.renderers })),
          h('td', {}, copy, clear),
        ),
      );
      for (const scroll of target.scrolls ?? []) targetTable.append(scrollRow(target, scroll, isOutput, output));
    }
  }

  /**
   * One roll's transport under its target (Wave R): the output's own when the
   * target is an output, the graphic's when it is a graphic. REST, like CLEAR
   * beside it; the readout follows the next poll of the state.
   */
  function scrollRow(target: TargetState, scroll: NonNullable<TargetState['scrolls']>[number], isOutput: boolean, output: string): HTMLElement {
    // i18n-ignore-next-line — an API path, frozen per I18N.md §2
    const api = isOutput
      ? `/api/out/${encodeURIComponent(pid)}/${encodeURIComponent(output)}/scroll`
      : `/api/control/${encodeURIComponent(pid)}/${encodeURIComponent(target.target)}/scroll`;
    const act = (action: string): void => {
      void fetch(api, { method: 'POST', headers: headers(), body: JSON.stringify({ action, id: scroll.id }) }).then(() => pollState());
    };
    const s = scroll.state;
    const now = target.clock ?? Date.now();
    const travel = scrollPosition(s, now, scroll.info);
    const atEnd = s.running && scrollAtEnd(s, now, scroll.info);
    const extent = scroll.info?.extent;
    const where = extent ? t('rundown.scrollThrough', { percent: String(Math.round((travel / extent) * 100)) }) : '';
    const btn = (label: string, action: string, title: string): HTMLButtonElement =>
      h('button', { type: 'button', title, onclick: () => act(action) }, label) as HTMLButtonElement;
    return h(
      'tr',
      { className: 'scroll' },
      h('td', {}, h('code', {}, scroll.id)),
      h(
        'td',
        { colSpan: 3, className: 'sub' },
        t(atEnd ? 'control.scrollAtEnd' : s.running ? (s.rate < 0 ? 'control.scrollRollingBack' : 'control.scrollRolling') : 'control.scrollPaused') +
          t('rundown.scrollSpeed', { speed: String(Math.round(Math.abs(s.rate) * 100) / 100) }) +
          where,
      ),
      h(
        'td',
        {},
        btn('⏮', 'restart', t('control.scrollRestart')),
        btn('◀', 'backward', t('control.scrollBackward')),
        btn(s.running ? '❚❚' : '▶', 'toggle', t(s.running ? 'control.scrollPause' : 'control.scrollPlay')),
        btn('▶▶', 'forward', t('control.scrollForward')),
        btn('−', 'slower', t('control.scrollSlower')),
        btn('+', 'faster', t('control.scrollFaster')),
      ),
    );
  }

  async function pollState(): Promise<void> {
    const rundown = current();
    if (!rundown) {
      targets = [];
      renderTargets();
      return;
    }
    try {
      // i18n-ignore-next-line — an API path, frozen per I18N.md §2
      const res = await fetch(`/api/rundown/${encodeURIComponent(pid)}/${encodeURIComponent(rundown.id)}/state`);
      if (res.ok) targets = ((await res.json()) as { targets: TargetState[] }).targets;
    } catch {
      // Keep the last readout.
    }
    renderTargets();
  }

  let poll: ReturnType<typeof setInterval> | null = null;
  const startPolling = () => {
    if (poll) return;
    void pollState();
    poll = setInterval(() => void pollState(), 2000);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (poll) clearInterval(poll);
      poll = null;
    } else startPolling();
  });

  /* ------------------------------------------------------------ keyboard */

  // Space takes; the arrows arm. Not while typing, and not with the editor open.
  document.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
    if (!editor.hidden) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (!takeBtn.disabled) take();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      prev();
    }
  });

  void loadDoc().then(() => startPolling());
  connect();
}
