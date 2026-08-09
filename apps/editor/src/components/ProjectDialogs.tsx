// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The three dialogs behind the app bar's project and scene menus.
 *
 * Grouped in one file because they share a shape — small modal, one question,
 * two buttons — and because two of the three are destructive and benefit from
 * being read next to each other when either is changed.
 *
 * All three reuse `.lib-overlay` and `.conflict-dialog` from the asset library
 * rather than introducing a third dimming layer. Two backdrops that differ
 * slightly is the kind of inconsistency people notice without being able to say
 * why.
 */

import { useEffect, useRef, useState, type JSX } from 'react';

import { api, ApiError, type CompositionReferrer } from '../api/client.js';

/**
 * Shared modal frame.
 *
 * Escape closes and focus moves inside on open — the second is what makes the
 * type-to-confirm field usable without reaching for the mouse, and the first is
 * what stops a dialog opened by a mis-keyed arrow in a `<select>` from being a
 * trap.
 */
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    // The first field, not the dialog: an operator who opened this to type a
    // name should be able to type it.
    ref.current?.querySelector('input')?.focus();
  }, []);

  return (
    <>
      <div className="lib-overlay" onClick={onClose} />
      <div className="conflict-dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header><strong>{title}</strong></header>
        {children}
      </div>
    </>
  );
}

/* ------------------------------------------------- new project / new scene */

/**
 * Name plus URL key — the form behind both New project and New scene.
 *
 * One component because the two are the same question about two things: the
 * name is free text, the key is the part that goes into every address and
 * cannot be changed afterwards, and both endpoints reject a bad key the same
 * way. Two copies of this drifted apart the moment one of them gained a hint
 * the other did not.
 */
function NameKeyDialog({
  title,
  namePlaceholder,
  keyPlaceholder,
  keyNote,
  submitLabel,
  busyLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  namePlaceholder: string;
  keyPlaceholder: string;
  /** What this key becomes and where it shows up. */
  keyNote: (key: string) => React.ReactNode;
  submitLabel: string;
  busyLabel: string;
  /** Throws ApiError; a 400 with `field: 'key'` lands under the key input. */
  onSubmit: (name: string, key: string | undefined) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  /*
   * Once the key has been typed in, the name stops driving it. Re-deriving on
   * every keystroke would overwrite a deliberate `rahb` the moment someone went
   * back to fix a typo in "Riverside Hawks Basketball".
   */
  const [keyTouched, setKeyTouched] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (keyTouched) return;
    if (name.trim() === '') { setKey(''); return; }

    let cancelled = false;
    void api
      .suggestKey(name)
      .then((r) => { if (!cancelled) setKey(r.key); })
      // A failed suggestion is not worth a banner: the field stays as it was
      // and the user can type a key themselves, which is all the suggestion
      // was going to save them.
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [name, keyTouched]);

  const submit = async (): Promise<void> => {
    if (busy || name.trim() === '') return;
    setBusy(true);
    setError(null);
    setKeyError(null);
    try {
      await onSubmit(name.trim(), key.trim() || undefined);
    } catch (err) {
      /*
       * A rejected key is user input in a form field, not a server fault, and
       * the server says so with `field: 'key'`. It belongs under the input that
       * caused it — a banner at the top of the dialog for "must be lowercase"
       * makes the reader hunt for which of two fields is wrong.
       */
      if (err instanceof ApiError && err.body.field === 'key') setKeyError(err.message);
      else setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <label className="dialog-field">
        <span>Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          placeholder={namePlaceholder}
        />
      </label>

      <label className="dialog-field">
        <span>URL key</span>
        <input
          value={key}
          onChange={(e) => { setKeyTouched(true); setKey(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          placeholder={keyPlaceholder}
          aria-invalid={keyError !== null}
        />
        {keyError
          ? <small className="dialog-error">{keyError}</small>
          : <small className="dialog-hint">{keyNote(key.trim())}</small>}
      </label>

      {error && <p className="dialog-error">{error}</p>}

      <div className="dialog-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={() => void submit()} disabled={busy || name.trim() === ''}>
          {busy ? busyLabel : submitLabel}
        </button>
      </div>
    </Modal>
  );
}

/**
 * New project.
 *
 * The URL key is the part that cannot be changed later — it is the project id,
 * and it is inside every browser-source URL already pasted into OBS — so it is
 * shown, editable, and explained rather than generated silently.
 */
export function NewProjectDialog({
  onCreated,
  onClose,
}: {
  onCreated: (projectId: string) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <NameKeyDialog
      title="New project"
      namePlaceholder="Riverside Hawks Basketball"
      keyPlaceholder="rahb"
      submitLabel="Create project"
      busyLabel="Creating…"
      keyNote={(key) => (
        <>
          Lowercase letters, digits and hyphens. The server appends a short suffix, so this
          becomes something like <code>{(key || 'project')}-1k3f9</code>. It goes in every
          control and browser-source URL and <strong>cannot be changed later</strong>.
        </>
      )}
      onSubmit={async (name, key) => {
        const project = await api.createProject(name, key);
        onCreated(project.id);
      }}
      onClose={onClose}
    />
  );
}

/**
 * New scene.
 *
 * The same form as a new project, one level down. The new scene inherits the
 * project's stage size rather than the schema default — the server does that,
 * because a 1280×720 project gaining a 1920×1080 scene is a surprise nobody
 * would go looking for until the graphic was the wrong size on air.
 */
export function NewSceneDialog({
  projectId,
  onCreated,
  onClose,
}: {
  projectId: string;
  onCreated: (compositionId: string) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <NameKeyDialog
      title="New scene"
      namePlaceholder="Lower Third — Name"
      keyPlaceholder="l3rd"
      submitLabel="Create scene"
      busyLabel="Creating…"
      keyNote={(key) => (
        <>
          Lowercase letters, digits and hyphens. The server appends a short suffix, so this
          becomes something like <code>{(key || 'comp')}-4b2c</code>, and it must not clash
          with a scene or a scene element this project already answers to. It goes in every
          control and browser-source URL and <strong>cannot be changed later</strong>.
        </>
      )}
      onSubmit={async (name, key) => {
        const comp = await api.createComposition(projectId, name, key);
        onCreated(comp.id);
      }}
      onClose={onClose}
    />
  );
}

/* --------------------------------------------------------- delete project */

/**
 * Delete project.
 *
 * Typing the name, not a checkbox and not a second Yes. The server does a
 * recursive remove of the project directory — compositions, uploaded assets,
 * data-source definitions — and there is no trash to restore from. The bar for
 * an action with no undo should be an action that cannot be performed by
 * reflex, and clicking two buttons in a row is exactly that.
 */
export function DeleteProjectDialog({
  projectId,
  projectName,
  sceneCount,
  onDeleted,
  onClose,
}: {
  projectId: string;
  projectName: string;
  sceneCount: number;
  onDeleted: () => void;
  onClose: () => void;
}): JSX.Element {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Trimmed and case-insensitive. The point is deliberate intent, not a typing
  // test, and a trailing space pasted from the dropdown should not block it.
  const confirmed = typed.trim().toLowerCase() === projectName.trim().toLowerCase();

  const submit = async (): Promise<void> => {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteProject(projectId);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Delete project" onClose={onClose}>
      <p className="dialog-warn">
        This deletes <strong>{projectName}</strong> — {sceneCount} scene{sceneCount === 1 ? '' : 's'},
        every uploaded asset and every data source in it — from disk. It cannot be undone, and any
        browser source or Stream Deck button pointing at <code>{projectId}</code> will stop working.
      </p>

      <label className="dialog-field">
        <span>Type <strong>{projectName}</strong> to confirm</span>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          placeholder={projectName}
          autoComplete="off"
        />
      </label>

      {error && <p className="dialog-error">{error}</p>}

      <div className="dialog-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="danger" onClick={() => void submit()} disabled={!confirmed || busy}>
          {busy ? 'Deleting…' : 'Delete project'}
        </button>
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------- delete scene */

/**
 * Delete scene.
 *
 * Two outcomes, decided by the server before the dialog can offer a button: if
 * anything mounts this composition as a layer, the delete is refused and the
 * dialog becomes a list of what to unlink. Deleting anyway would leave those
 * parents loading and playing with a layer pointing at nothing — a graphic
 * quietly missing an element, discovered on air.
 */
export function DeleteSceneDialog({
  projectId,
  sceneId,
  sceneName,
  isLastScene,
  onDeleted,
  onClose,
}: {
  projectId: string;
  sceneId: string;
  sceneName: string;
  isLastScene: boolean;
  onDeleted: () => void;
  onClose: () => void;
}): JSX.Element {
  const [referrers, setReferrers] = useState<CompositionReferrer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .compositionReferrers(projectId, sceneId)
      .then((list) => { if (!cancelled) setReferrers(list); })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Unknown reference state, so no delete is offered. The server would
        // refuse a dangerous one anyway, but a dialog that cannot say whether
        // this is safe should not have a button that says it is.
        setError(err instanceof Error ? err.message : String(err));
        setReferrers([]);
      });
    return () => { cancelled = true; };
  }, [projectId, sceneId]);

  const blocked = referrers !== null && referrers.length > 0;

  const submit = async (): Promise<void> => {
    if (busy || blocked || referrers === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteComposition(projectId, sceneId);
      onDeleted();
    } catch (err) {
      // The server checks again on the DELETE, so a layer added from another
      // editor window since this dialog opened still lands here rather than
      // going through.
      if (err instanceof ApiError && err.status === 409) setReferrers(err.referrers);
      else setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Delete scene" onClose={onClose}>
      {referrers === null && <p className="dialog-hint">Checking what uses this scene…</p>}

      {blocked && (
        <>
          <p className="dialog-warn">
            <strong>{sceneName}</strong> cannot be deleted — it is mounted as a layer by
            {referrers.length === 1 ? ' another scene' : ` ${referrers.length} other scenes`}.
            Remove {referrers.length === 1 ? 'that layer' : 'those layers'} first.
          </p>
          <ul className="dialog-list">
            {referrers.map((r, i) => (
              <li key={`${r.id}-${r.layer}-${i}`}>
                <strong>{r.name}</strong> → layer <code>{r.layer}</code>
                {r.independent && <span className="dialog-tag">scene element</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {referrers !== null && !blocked && (
        <p className="dialog-warn">
          This deletes the scene <strong>{sceneName}</strong> and everything in it. It cannot be
          undone, and any browser source or Stream Deck button pointing at{' '}
          <code>{projectId}/{sceneId}</code> will stop working.
          {isLastScene && ' This is the only scene in the project.'}
        </p>
      )}

      {error && <p className="dialog-error">{error}</p>}

      <div className="dialog-actions">
        <button onClick={onClose}>{blocked ? 'Close' : 'Cancel'}</button>
        {!blocked && (
          <button className="danger" onClick={() => void submit()} disabled={referrers === null || busy}>
            {busy ? 'Deleting…' : 'Delete scene'}
          </button>
        )}
      </div>
    </Modal>
  );
}
