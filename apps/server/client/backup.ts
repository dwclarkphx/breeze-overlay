// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Backup page behaviour.
 *
 * Two jobs: turn a set of checkboxes into a download URL, and walk a dropped
 * bundle through inspect → confirm → restore.
 *
 * **The inspect step is not decoration.** A restore that discovers a project id
 * collision *after* writing has already overwritten a graphic that may be on
 * air. Asking first is the same argument that put asset Replace's collision
 * detection in the client: a question answered after the write is a question
 * asked too late.
 *
 * Per the portal's rule, everything this file adds is an enhancement. The
 * per-project Download links are ordinary anchors and work with this script
 * absent; only restore needs it, and the markup says so.
 */

import { bootI18n } from './i18n.js';

declare global {
  interface Window { __BREEZE_BACKUP__?: { locale?: string; messages?: Record<string, string> }; }
}

const { t } = bootI18n(window.__BREEZE_BACKUP__);

/*
 * Catalogue text goes into `innerHTML` unescaped, exactly like the literal
 * markup around it, and only *data* is escaped — `escape(r.name)`, the same
 * rule this file already followed. Escaping the message instead would mean
 * escaping the `<code>` a message is handed as a parameter, which is the one
 * thing here that has to stay markup.
 *
 * The catalogue is ours and `i18n:check` parses every entry, so this is the
 * same trust boundary as the surrounding template literal — not a new one.
 */

interface InspectResult {
  manifest: { createdAt: string; appVersion: string; projects: Array<{ id: string; name: string }> };
  projects: Array<{ id: string; collides: boolean; assets: number }>;
}

const el = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

const picks = (): HTMLInputElement[] =>
  [...document.querySelectorAll<HTMLInputElement>('input.pick')];

const selected = (): string[] => picks().filter((p) => p.checked).map((p) => p.value);

function refreshCount(): void {
  const n = selected().length;
  const total = picks().length;
  const count = el('count');
  if (count) count.textContent = total ? t('backup.selectedCount', { count: n, total }) : '';
  const download = el<HTMLButtonElement>('download');
  if (download) download.disabled = n === 0;
}

/* ------------------------------------------------------------------ backup */

el('all')?.addEventListener('click', () => {
  picks().forEach((p) => { p.checked = true; });
  refreshCount();
});

el('none')?.addEventListener('click', () => {
  picks().forEach((p) => { p.checked = false; });
  refreshCount();
});

document.addEventListener('change', (e) => {
  if ((e.target as HTMLElement)?.classList?.contains('pick')) refreshCount();
});

el('download')?.addEventListener('click', () => {
  const ids = selected();
  if (!ids.length) return;
  /*
   * Navigation rather than fetch-then-blob.
   *
   * A whole-station backup can be gigabytes, and fetching it into memory to
   * hand the browser a blob URL means holding all of it in the tab — the exact
   * reason ASSETS.md put the zip on the server in the first place. A plain
   * navigation streams to disk and gets the browser's own download UI,
   * including resume and a progress readout this page would otherwise have to
   * reimplement.
   */
  window.location.href = `/api/backup?projects=${encodeURIComponent(ids.join(','))}`;
});

refreshCount();

/* ----------------------------------------------------------------- restore */

const drop = el('drop');
const report = el('report');
let pending: File | null = null;

function say(html: string): void {
  if (report) report.innerHTML = html;
}

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

async function inspect(file: File): Promise<void> {
  pending = file;
  say(`<p class="hint">${t('backup.reading', { file: escape(file.name) })}</p>`);

  const res = await fetch('/api/restore/inspect', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: file,
  });
  const body = await res.json().catch(() => ({ error: t('backup.unreadableResponse') }));

  if (!res.ok) {
    say(`<p class="err">${escape((body as { error?: string }).error ?? t('backup.inspectFailed'))}</p>`);
    pending = null;
    return;
  }

  const data = body as InspectResult;
  const colliding = data.projects.filter((p) => p.collides);

  const rows = data.projects
    .map((p) => {
      const named = data.manifest.projects.find((m) => m.id === p.id);
      return `<tr><td>${escape(named?.name ?? p.id)}</td><td><code>${escape(p.id)}</code></td>
        <td class="num">${p.assets}</td>
        <td>${p.collides ? `<span class="warn">${t('backup.statusExists')}</span>` : t('backup.statusNew')}</td></tr>`;
    })
    .join('');

  /*
   * The choice is only offered when something actually collides.
   *
   * Asking "overwrite or rename?" about a bundle that collides with nothing is
   * asking an operator to answer a question with no consequence, which teaches
   * them to click through the one that does.
   */
  const choice = colliding.length
    ? `<p class="warn">${t('backup.collision', { count: colliding.length })}</p>
       <div class="bar">
         <button id="go-rename" class="primary">${t('backup.restoreAlongside')}</button>
         <button id="go-overwrite">${t('backup.overwriteExisting')}</button>
       </div>`
    : `<div class="bar"><button id="go-rename" class="primary">${t('backup.restore')}</button></div>`;

  say(`<p>${t('backup.written', {
        date: escape(data.manifest.createdAt.replace('T', ' ').replace(/\..*/, '')),
        version: escape(data.manifest.appVersion),
      })}</p>
      <table>
        <tr><th>${t('backup.colProject')}</th><th>${t('backup.colId')}</th>
          <th class="num">${t('backup.colAssets')}</th><th>${t('backup.colStatus')}</th></tr>
        ${rows}
      </table>
      ${choice}`);

  el('go-rename')?.addEventListener('click', () => { void restore('rename'); });
  el('go-overwrite')?.addEventListener('click', () => { void restore('overwrite'); });
}

async function restore(mode: 'rename' | 'overwrite'): Promise<void> {
  if (!pending) return;
  say(`<p class="hint">${t('backup.restoring')}</p>`);

  const res = await fetch(`/api/restore?mode=${mode}`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: pending,
  });
  const body = await res.json().catch(() => ({ error: t('backup.unreadableResponse') }));

  if (!res.ok) {
    say(`<p class="err">${escape((body as { error?: string }).error ?? t('backup.restoreFailed'))}</p>`);
    return;
  }

  const done = (body as { restored: Array<{ id: string; name: string; assets: number; overwrote: boolean }> }).restored;
  say(`<p>${t('backup.restored', { count: done.length })}</p>
     <ul>${done
       .map(
         (r) =>
           `<li>${t('backup.restoredItem', {
             name: escape(r.name),
             id: `<code>${escape(r.id)}</code>`,
             count: r.assets,
           })}${r.overwrote ? ` <span class="warn">${t('backup.overwrote')}</span>` : ''}</li>`,
       )
       .join('')}</ul>
     <p class="hint">${t('backup.credentialsHint')}</p>
     <div class="bar"><a class="pill" href="/">${t('backup.backToPortal')}</a></div>`);
  pending = null;
}

drop?.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop?.addEventListener('dragleave', () => drop.classList.remove('over'));
drop?.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const file = (e as DragEvent).dataTransfer?.files?.[0];
  if (file) void inspect(file);
});

el<HTMLInputElement>('file')?.addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void inspect(file);
});
