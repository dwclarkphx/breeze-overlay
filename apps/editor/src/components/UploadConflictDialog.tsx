// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The prompt that fronts Replace.
 *
 * Until now, dropping a corrected `logo.png` on a bin that already had one
 * produced a second row with the same label and left every graphic pointing at
 * the first — ASSETS.md §2 wall 5, "no replace, no versioning". Two rows called
 * `logo.png` is not an error anyone sees; it is a bin that slowly fills with
 * near-duplicates and an operator who cannot tell which one is on air.
 *
 * **It asks about names, because names are all the browser knows.** Identity is
 * the content hash, and computing it here means reading the whole file into
 * memory before the upload starts — for the 400 MB stinger this feature exists
 * to serve, that costs more than the click it saves. So a re-drop of genuinely
 * identical bytes does reach this dialog. Harmless in both directions: Replace
 * short-circuits server-side once the hashes match, and "upload as new" is the
 * dedup that has always been there.
 *
 * Which is why each row shows **both sizes**. It is the one cheap signal the
 * browser does have, and it usually settles the question on sight — same size
 * is probably the same file, a different size is definitely a changed one. It
 * is deliberately not used to *suppress* the prompt: two different exports can
 * land on the same byte count, and skipping the question there would silently
 * drop a replacement the operator meant.
 *
 * **One dialog for the drop.** An operator re-exporting eight corrected sponsor
 * logos means the same thing about all eight, and eight modals in a row before
 * a show is how a feature gets routed around — by renaming files, which is
 * exactly the mess this exists to prevent. So the batch choice is the headline
 * and the per-file override is there for the one that differs.
 *
 * Modal, unlike the bin's in-place delete confirmation, because this one blocks
 * an operation the operator has already started and has to be answered before
 * anything is sent. The delete confirmation interrupts nothing.
 */

import { useEffect, useMemo, useState, type JSX } from 'react';
import { assetLabel, type AssetRef } from '@breeze/schema';

import { useEditor } from '../state/store.js';

/** Bytes as something read at a glance — the same rounding the bin uses. */
function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** `2026-08-07T…` → `7 Aug 2026`, for the "added" line under an existing file. */
function formatAdded(iso: string | undefined): string {
  if (!iso) return 'date unknown';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'date unknown';
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function UploadConflictDialog(): JSX.Element | null {
  const pending = useEditor((s) => s.uploadConflicts);
  const projectId = useEditor((s) => s.projectId);
  const resolve = useEditor((s) => s.resolveUploadConflicts);
  const cancel = useEditor((s) => s.cancelUploadConflicts);

  /*
   * Per-file overrides, keyed by lowercased name — only the ones deliberately
   * set. Everything absent follows `mode`, so flipping the batch choice moves
   * every file the operator has not spoken about individually, and leaves the
   * ones they have.
   */
  const [mode, setMode] = useState<'replace' | 'new'>('replace');
  const [overrides, setOverrides] = useState<Record<string, 'replace' | 'new'>>({});

  // A second drop while the dialog is open replaces the first, so the choices
  // made about the previous set must not carry over to files they never named.
  useEffect(() => {
    setMode('replace');
    setOverrides({});
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, cancel]);

  const assetBase = projectId ? `/assets/${encodeURIComponent(projectId)}` : '';

  const choiceFor = (name: string): 'replace' | 'new' =>
    overrides[name.trim().toLowerCase()] ?? mode;

  const replacing = useMemo(
    () => (pending ? pending.collisions.filter((c) => choiceFor(c.name) === 'replace').length : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pending, mode, overrides],
  );

  if (!pending) return null;

  const { files, collisions } = pending;
  const clean = files.length - collisions.length;

  const submit = (): void => {
    const decisions: Record<string, string | null> = {};
    for (const collision of collisions) {
      const key = collision.name.trim().toLowerCase();
      decisions[key] = choiceFor(collision.name) === 'replace' ? collision.existing.id : null;
    }
    void resolve(decisions);
  };

  const thumb = (asset: AssetRef): JSX.Element =>
    asset.kind === 'image' ? (
      <img src={`${assetBase}/${asset.path.replace(/^assets\//, '')}`} alt="" />
    ) : (
      <span className="asset-glyph">◆</span>
    );

  return (
    <>
      <div className="lib-overlay" onClick={cancel} />
      <div className="conflict-dialog" role="dialog" aria-modal="true" aria-label="File already exists">
        <header>
          <strong>
            {collisions.length === 1
              ? 'A file with this name is already here'
              : `${collisions.length} files with these names are already here`}
          </strong>
        </header>

        {/*
          The batch choice, stated as what it does rather than as two nouns.

          "Replace" alone does not say that graphics will change, and the whole
          reason Replace is worth building is that it changes them — an
          operator who does not expect that has been surprised by the feature
          working correctly.
        */}
        <div className="conflict-modes">
          <label>
            <input
              type="radio"
              checked={mode === 'replace'}
              onChange={() => { setMode('replace'); setOverrides({}); }}
            />
            <span>
              <strong>Replace</strong>
              <span className="hint">
                Every layer using the old file switches to the new one, in every
                composition. The old file is retired, not deleted.
              </span>
            </span>
          </label>
          <label>
            <input
              type="radio"
              checked={mode === 'new'}
              onChange={() => { setMode('new'); setOverrides({}); }}
            />
            <span>
              <strong>Upload as new</strong>
              <span className="hint">
                Both files stay in the bin. Nothing on air changes — existing
                layers keep the file they already have.
              </span>
            </span>
          </label>
        </div>

        <ul className="conflict-list">
          {collisions.map((collision) => {
            const choice = choiceFor(collision.name);
            const key = collision.name.trim().toLowerCase();
            const incoming = files.find((f) => f.name === collision.name);
            /*
             * Same size is a hint, not a verdict. It is worth showing because
             * it settles the common "did that upload actually work?" re-drop
             * on sight, and worth *not* acting on because two different
             * exports can land on the same byte count.
             */
            const sameSize =
              incoming !== undefined && incoming.size === collision.existing.bytes;
            return (
              <li key={key} data-choice={choice}>
                <span className="conflict-thumb">{thumb(collision.existing)}</span>
                <span className="conflict-meta">
                  <span className="conflict-name">{collision.name}</span>
                  <span className="conflict-sub">
                    in the bin as <em>{assetLabel(collision.existing)}</em> ·{' '}
                    {formatBytes(collision.existing.bytes)} → {formatBytes(incoming?.size)}
                    {sameSize && <span className="conflict-same"> · same size</span>} · added{' '}
                    {formatAdded(collision.existing.addedAt)}
                  </span>
                </span>
                {/*
                  The override is a toggle rather than a second pair of radios:
                  there are only two states, and eight rows of radio pairs is a
                  wall of controls for a decision almost nobody changes.
                */}
                <button
                  className="conflict-override"
                  onClick={() =>
                    setOverrides((o) => ({ ...o, [key]: choice === 'replace' ? 'new' : 'replace' }))
                  }
                  title={
                    choice === 'replace'
                      ? 'Replacing — click to upload this one as a new asset instead'
                      : 'Uploading as new — click to replace the existing file instead'
                  }
                >
                  {choice === 'replace' ? 'Replace' : 'Keep both'}
                </button>
              </li>
            );
          })}
        </ul>

        {clean > 0 && (
          <p className="hint conflict-clean">
            {clean} other {clean === 1 ? 'file' : 'files'} in this drop{' '}
            {clean === 1 ? 'has' : 'have'} no conflict and will upload as normal.
          </p>
        )}

        <footer>
          <span className="hint">
            {replacing === 0
              ? 'Nothing will be replaced.'
              : `${replacing} of ${collisions.length} will be replaced.`}
          </span>
          <span className="conflict-actions">
            <button onClick={cancel}>Cancel</button>
            <button className="primary" onClick={submit}>
              Upload {files.length} {files.length === 1 ? 'file' : 'files'}
            </button>
          </span>
        </footer>
      </div>
    </>
  );
}
