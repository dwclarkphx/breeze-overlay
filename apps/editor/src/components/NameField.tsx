// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Project and composition name inputs — the editor's side of the name rules in
 * `@breeze/schema` names.ts.
 *
 * The server refuses a bad name on save regardless; what the editor adds is
 * saying so under the field while it is being typed, instead of after a save
 * that fails for a reason three panels away.
 */

import { useEffect, useState, type InputHTMLAttributes, type JSX } from 'react';

import {
  NAME_MAX_LENGTH,
  cleanPastedName,
  hasControl,
  nameProblem,
  replaceControls,
  type NameProblem,
} from '@breeze/schema';
import type { Translate } from '@breeze/i18n';
import { useT } from '@breeze/i18n/react';

/**
 * The same three messages the server sends as `error.name*` codes, so a
 * refusal reads identically whether the editor caught it or the server did.
 */
export function nameMessage(t: Translate, problem: NameProblem): string {
  switch (problem) {
    case 'empty':
      return t('error.nameEmpty');
    case 'control':
      return t('error.nameControl');
    case 'tooLong':
      return t('error.nameTooLong', { max: NAME_MAX_LENGTH });
  }
}

type PassThrough = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onPaste' | 'dir'>;

/**
 * A name input with its notice underneath — every name field in the editor.
 *
 * **Blocked characters are kept out, and the field says why.** A line break or
 * tab can only arrive by paste, and a browser strips line breaks from a pasted
 * single-line value without a word, so "Lower⏎third" lands as "Lowerthird".
 * The paste is intercepted instead: breaks inside the text become spaces
 * (`cleanPastedName`) and a red notice under the field explains it, until the
 * next keystroke. Anything that still gets past — a tab some other way — is
 * replaced on change, with the same notice.
 *
 * Any other problem with the name (empty, too long) is shown in the same
 * place in the same red. `showEmpty` holds back "must contain at least one
 * character" for a field nobody has typed in yet; that is the next thing to
 * fill in, not a mistake.
 */
export function NameTextInput({
  value,
  onValueChange,
  showEmpty = true,
  ...rest
}: {
  value: string;
  onValueChange: (next: string) => void;
  showEmpty?: boolean;
} & PassThrough): JSX.Element {
  const t = useT();
  const [replaced, setReplaced] = useState(false);

  const problem = nameProblem(value);
  const shown = problem && (problem !== 'empty' || showEmpty) ? problem : null;

  return (
    <span className="name-field">
      <input
        {...rest}
        value={value}
        dir="auto"
        aria-invalid={shown !== null}
        onChange={(e) => {
          const raw = e.target.value;
          const blocked = hasControl(raw);
          setReplaced(blocked);
          onValueChange(blocked ? replaceControls(raw) : raw);
        }}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData('text/plain');
          if (!hasControl(pasted)) return;
          e.preventDefault();
          const input = e.currentTarget;
          const start = input.selectionStart ?? input.value.length;
          const end = input.selectionEnd ?? start;
          const before = input.value.slice(0, start);
          const after = input.value.slice(end);
          const clean = cleanPastedName(pasted, before, after);
          onValueChange(before + clean.text + after);
          setReplaced(clean.replaced);
          // React re-renders the value and would leave the caret at the end.
          const caret = start + clean.text.length;
          requestAnimationFrame(() => input.setSelectionRange(caret, caret));
        }}
      />
      {replaced ? (
        <small className="dialog-error" role="alert">{t('editor.nameField.controlReplaced')}</small>
      ) : (
        shown && <small className="dialog-error" role="alert">{nameMessage(t, shown)}</small>
      )}
    </span>
  );
}

/**
 * A name field bound to a document that must never hold a bad name.
 *
 * Every keystroke that leaves a legal name is committed, so typing still
 * updates the layers panel and the tab title live. A keystroke that leaves an
 * illegal one — the field cleared, a name past the cap — stays in the field as
 * a draft, with the reason under it, and the document keeps its last good
 * name. Leaving the field reverts the draft, so nothing is silently half-saved.
 *
 * The committed value is *not* trimmed here. Trimming on every keystroke would
 * eat the space someone just typed between two words; the server normalises on
 * save instead.
 */
export function NameInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (name: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);

  // Undo, redo and a project switch change the name from outside the field.
  useEffect(() => setDraft(value), [value]);

  return (
    <NameTextInput
      value={draft}
      onValueChange={(next) => {
        setDraft(next);
        if (!nameProblem(next)) onCommit(next);
      }}
      onBlur={() => {
        if (nameProblem(draft) && !nameProblem(value)) setDraft(value);
      }}
    />
  );
}
