// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The fields an operator can set on a composition — what the rundown panel's
 * item editor offers (Phase 9 Wave A).
 *
 * The same rule as the control panel's form: editable bindings, minus any fed
 * by a fetched source (pushing a typed value over live rows is the 0.50.0 bug),
 * plus per-mount override addresses. Fed fields are left out entirely — a
 * rundown item stores values to send, and a fed field has none.
 */

import { collectBindings, collectOverrideBindings, type Composition, type Project } from '@breeze/schema';

import { readDataSources } from './data/sources.js';
import { isFedSource, type ControlPanelBinding } from './pages.js';

export async function panelBindingsFor(project: Project, composition: Composition): Promise<ControlPanelBinding[]> {
  let fed = new Set<string>();
  try {
    fed = new Set((await readDataSources(project.id)).filter((d) => isFedSource(d.type)).map((d) => d.id));
  } catch {
    // No sources file is no fed fields.
  }
  const byId = new Map(project.compositions.map((c) => [c.id, c]));
  const editable: ControlPanelBinding[] = collectBindings(composition)
    .filter((b) => !(b.source && fed.has(b.source)))
    .map((b) => ({ name: b.name, kind: b.kind, label: b.label, defaultValue: b.defaultValue, ...(b.field ? { field: b.field } : {}) }));
  const overrides: ControlPanelBinding[] = collectOverrideBindings(composition, (id) => byId.get(id)).map((b) => ({
    name: b.address,
    kind: b.kind,
    label: b.mountLabel,
    defaultValue: b.defaultValue,
    ...(b.field ? { field: b.field } : {}),
  }));
  return [...editable, ...overrides];
}
