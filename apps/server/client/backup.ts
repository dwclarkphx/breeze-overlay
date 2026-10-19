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

import {
  NAME_MAX_LENGTH,
  cleanPastedName,
  displayName,
  hasControl,
  isBlankName,
  nameProblem,
  normalizeName,
  replaceControls,
  suggestName,
  type NameProblem,
} from '@breeze/schema';

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

/** A name the restore will refuse until it is replaced — see `archive/bundle.ts`. */
interface NameIssue {
  project: string;
  composition?: string;
  name: string;
  problem: NameProblem;
}

interface InspectResult {
  manifest: { createdAt: string; appVersion: string; projects: Array<{ id: string; name: string }> };
  projects: Array<{ id: string; name?: string; collides: boolean; assets: number }>;
  /** Absent from servers older than 0.77.0, which did not check names. */
  nameIssues?: NameIssue[];
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
let issues: NameIssue[] = [];

function say(html: string): void {
  if (report) report.innerHTML = html;
}

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

async function inspect(file: File): Promise<void> {
  pending = file;
  issues = [];
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
  issues = data.nameIssues ?? [];

  const projectName = (id: string): string => {
    const fromDoc = data.projects.find((p) => p.id === id)?.name;
    const fromManifest = data.manifest.projects.find((m) => m.id === id)?.name;
    return displayName(fromDoc ?? fromManifest, id);
  };

  const rows = data.projects
    .map(
      (p) => `<tr><td dir="auto">${escape(projectName(p.id))}</td><td><code>${escape(p.id)}</code></td>
        <td class="num">${p.assets}</td>
        <td>${p.collides ? `<span class="warn">${t('backup.statusExists')}</span>` : t('backup.statusNew')}</td></tr>`,
    )
    .join('');

  /*
   * Names first, then the restore buttons, and the buttons stay disabled until
   * every name is usable.
   *
   * The server refuses the restore on its own if a name is still blank, so this
   * is not the enforcement — it is what makes the refusal a form to fill in
   * rather than an error after a multi-gigabyte upload. Each input is
   * pre-filled with `suggestName`: a line break flattened to a space, an
   * over-long name cut to the cap, an empty one left empty for a person to
   * decide.
   */
  const namesTable = issues.length
    ? `<p class="warn">${t('backup.namesNeeded', { count: issues.length, max: NAME_MAX_LENGTH })}</p>
       <table class="names">
         <tr><th>${t('backup.colProject')}</th><th>${t('backup.colComposition')}</th>
           <th>${t('backup.colCurrentName')}</th><th>${t('backup.colNewName')}</th></tr>
         ${issues
           .map(
             (issue, i) => `<tr>
               <td dir="auto">${escape(projectName(issue.project))}</td>
               <td>${issue.composition ? `<code>${escape(issue.composition)}</code>` : t('backup.projectNameRow')}</td>
               <td>${shownName(issue.name)}<br><small class="warn">${problemLabel(issue.problem)}</small></td>
               <td><input class="rename" data-i="${i}" dir="auto" value="${escape(suggestName(issue.name))}"
                 aria-label="${escape(t('backup.colNewName'))}"><small class="err rename-err" data-i="${i}"></small></td>
             </tr>`,
           )
           .join('')}
       </table>
       <p id="names-left" class="warn"></p>`
    : '';

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
         <button id="go-cancel">${t('backup.cancel')}</button>
       </div>`
    : `<div class="bar">
         <button id="go-rename" class="primary">${t('backup.restore')}</button>
         <button id="go-cancel">${t('backup.cancel')}</button>
       </div>`;

  say(`<p>${t('backup.written', {
        date: escape(data.manifest.createdAt.replace('T', ' ').replace(/\..*/, '')),
        version: escape(data.manifest.appVersion),
      })}</p>
      <table>
        <tr><th>${t('backup.colProject')}</th><th>${t('backup.colId')}</th>
          <th class="num">${t('backup.colAssets')}</th><th>${t('backup.colStatus')}</th></tr>
        ${rows}
      </table>
      ${namesTable}
      ${choice}`);

  renameInputs().forEach(guardNameInput);
  el('go-rename')?.addEventListener('click', () => { void restore('rename'); });
  el('go-overwrite')?.addEventListener('click', () => { void restore('overwrite'); });
  el('go-cancel')?.addEventListener('click', cancel);
  refreshNames();
}

/** A name as it stands in the bundle, with its invisible problems made visible. */
function shownName(name: string): string {
  if (isBlankName(name)) return `<em>${t('backup.nameIsEmpty')}</em>`;
  // A line break would otherwise just wrap the cell, which is exactly the
  // problem being reported looking like nothing at all.
  return `<span dir="auto">${escape(name.replace(/[\p{Cc}\u2028\u2029]/gu, '⏎'))}</span>`;
}

function problemLabel(problem: NameProblem): string {
  switch (problem) {
    case 'empty':
      return t('backup.problemEmpty');
    case 'control':
      return t('backup.problemControl');
    case 'tooLong':
      return t('backup.problemTooLong', { max: NAME_MAX_LENGTH });
  }
}

/** The same wording the editor and the server use for a refused name. */
function nameMessage(problem: NameProblem): string {
  switch (problem) {
    case 'empty':
      return t('error.nameEmpty');
    case 'control':
      return t('error.nameControl');
    case 'tooLong':
      return t('error.nameTooLong', { max: NAME_MAX_LENGTH });
  }
}

const renameInputs = (): HTMLInputElement[] =>
  report ? [...report.querySelectorAll<HTMLInputElement>('input.rename')] : [];

/**
 * Keep line breaks and tabs out of a replacement name, and say why.
 *
 * Same rule as the editor's name fields (NameField.tsx): a browser strips line
 * breaks from a pasted single-line value silently, so the paste is taken over
 * — breaks inside the text become spaces via `cleanPastedName` — and the red
 * notice under the box explains it until the next keystroke. `data-replaced`
 * carries that to `refreshNames`; `data-touched` lets an empty box stay quiet
 * until someone has typed in it.
 */
function guardNameInput(input: HTMLInputElement): void {
  const mark = (replaced: boolean): void => {
    input.dataset.touched = '1';
    if (replaced) input.dataset.replaced = '1';
    else delete input.dataset.replaced;
    refreshNames();
  };

  input.addEventListener('input', () => {
    const blocked = hasControl(input.value);
    if (blocked) input.value = replaceControls(input.value);
    mark(blocked);
  });

  input.addEventListener('paste', (e) => {
    const pasted = e.clipboardData?.getData('text/plain') ?? '';
    if (!hasControl(pasted)) return;
    e.preventDefault();
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const clean = cleanPastedName(pasted, before, after);
    input.value = before + clean.text + after;
    const caret = start + clean.text.length;
    input.setSelectionRange(caret, caret);
    mark(clean.replaced);
  });
}

/** Re-check every replacement and gate the restore buttons on the result. */
function refreshNames(): void {
  let remaining = 0;
  for (const input of renameInputs()) {
    const problem = nameProblem(input.value);
    if (problem) remaining += 1;
    input.setAttribute('aria-invalid', problem ? 'true' : 'false');
    const hint = report?.querySelector<HTMLElement>(`small.rename-err[data-i="${input.dataset.i}"]`);
    // An empty box nobody has typed in yet stays quiet — it is the next thing
    // to fill in, not a mistake. Everything else is said in red, under the box.
    if (hint) {
      hint.textContent = input.dataset.replaced
        ? t('backup.controlReplaced')
        : problem && (problem !== 'empty' || input.dataset.touched)
          ? nameMessage(problem)
          : '';
    }
  }
  const left = el('names-left');
  if (left) left.textContent = remaining ? t('backup.namesRemaining', { count: remaining }) : '';
  for (const id of ['go-rename', 'go-overwrite']) {
    const button = el<HTMLButtonElement>(id);
    if (button) button.disabled = remaining > 0;
  }
}

/** The replacements typed into the prompt, in the shape `x-breeze-names` takes. */
function collectNames(): Record<string, { name?: string; compositions?: Record<string, string> }> {
  const out: Record<string, { name?: string; compositions?: Record<string, string> }> = {};
  for (const input of renameInputs()) {
    const issue = issues[Number(input.dataset.i)];
    if (!issue) continue;
    const entry = (out[issue.project] ??= {});
    const name = normalizeName(input.value);
    if (issue.composition) (entry.compositions ??= {})[issue.composition] = name;
    else entry.name = name;
  }
  return out;
}

/**
 * Base64 of UTF-8 JSON — the encoding the server's `parseNameOverrides` reads.
 *
 * `fetch` throws on a header value outside Latin-1, so a name in Japanese or
 * Arabic cannot go in raw; `btoa` alone has the same limit, hence the bytes.
 */
function encodeNames(names: object): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(JSON.stringify(names))) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Abandon this bundle. Nothing has been written — inspect never writes. */
function cancel(): void {
  pending = null;
  issues = [];
  const input = el<HTMLInputElement>('file');
  if (input) input.value = '';
  say(`<p class="hint">${t('backup.cancelled')}</p>`);
}

async function restore(mode: 'rename' | 'overwrite'): Promise<void> {
  if (!pending) return;
  if (renameInputs().some((input) => nameProblem(input.value))) return;

  const headers: Record<string, string> = { 'content-type': 'application/zip' };
  if (issues.length) headers['x-breeze-names'] = encodeNames(collectNames());

  say(`<p class="hint">${t('backup.restoring')}</p>`);

  const res = await fetch(`/api/restore?mode=${mode}`, {
    method: 'POST',
    headers,
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
             name: `<span dir="auto">${escape(r.name)}</span>`,
             id: `<code>${escape(r.id)}</code>`,
             count: r.assets,
           })}${r.overwrote ? ` <span class="warn">${t('backup.overwrote')}</span>` : ''}</li>`,
       )
       .join('')}</ul>
     <p class="hint">${t('backup.credentialsHint')}</p>
     <div class="bar"><a class="pill" href="/">${t('backup.backToPortal')}</a></div>`);
  pending = null;
  issues = [];
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
