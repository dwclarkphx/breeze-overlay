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

export {};

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
  if (count) count.textContent = total ? `${n} of ${total} selected` : '';
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
  say(`<p class="hint">Reading ${escape(file.name)}…</p>`);

  const res = await fetch('/api/restore/inspect', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: file,
  });
  const body = await res.json().catch(() => ({ error: 'unreadable response' }));

  if (!res.ok) {
    say(`<p class="err">${escape((body as { error?: string }).error ?? 'could not read that bundle')}</p>`);
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
        <td>${p.collides ? '<span class="warn">already exists</span>' : 'new'}</td></tr>`;
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
    ? `<p class="warn">${colliding.length} project${colliding.length > 1 ? 's' : ''} already
         exist${colliding.length > 1 ? '' : 's'} on this server. Overwriting replaces what is
         there now — including anything currently on air.</p>
       <div class="bar">
         <button id="go-rename" class="primary">Restore alongside (new ids)</button>
         <button id="go-overwrite">Overwrite existing</button>
       </div>`
    : `<div class="bar"><button id="go-rename" class="primary">Restore</button></div>`;

  say(`<p>Written ${escape(data.manifest.createdAt.replace('T', ' ').replace(/\..*/, ''))}
        by Breeze ${escape(data.manifest.appVersion)}.</p>
      <table>
        <tr><th>Project</th><th>Id</th><th class="num">Assets</th><th>Status</th></tr>
        ${rows}
      </table>
      ${choice}`);

  el('go-rename')?.addEventListener('click', () => { void restore('rename'); });
  el('go-overwrite')?.addEventListener('click', () => { void restore('overwrite'); });
}

async function restore(mode: 'rename' | 'overwrite'): Promise<void> {
  if (!pending) return;
  say('<p class="hint">Restoring…</p>');

  const res = await fetch(`/api/restore?mode=${mode}`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: pending,
  });
  const body = await res.json().catch(() => ({ error: 'unreadable response' }));

  if (!res.ok) {
    say(`<p class="err">${escape((body as { error?: string }).error ?? 'restore failed')}</p>`);
    return;
  }

  const done = (body as { restored: Array<{ id: string; name: string; assets: number; overwrote: boolean }> }).restored;
  say(`<p>Restored ${done.length} project${done.length > 1 ? 's' : ''}.</p>
     <ul>${done
       .map(
         (r) =>
           `<li>${escape(r.name)} → <code>${escape(r.id)}</code>, ${r.assets} asset${
             r.assets === 1 ? '' : 's'
           }${r.overwrote ? ' <span class="warn">(overwrote)</span>' : ''}</li>`,
       )
       .join('')}</ul>
     <p class="hint">Data sources restored without their credentials — re-enter any keys or tokens
     in the editor before those graphics go live.</p>
     <div class="bar"><a class="pill" href="/">Back to the portal</a></div>`);
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
