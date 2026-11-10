// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The Data sources page's address, and how the bundle knows it is that page.
 *
 * The page is the editor's own bundle in another mode (0.80.0) rather than a
 * server-rendered page like Connections or Activity, for one reason: it has to
 * show the source form, and that form — eleven source types, their inspectors,
 * the preview — is React and lives here. A second copy on the server would be
 * a second form to keep in step for ever.
 *
 * A query on the editor's own URL rather than a path of its own, so it needs
 * no serving rule: the Vite dev server and the built editor both answer
 * `/editor/` already. The server's `/sources` redirects here, which is the
 * address the portal and the docs use.
 */

const VIEW_PARAM = 'view';
const SOURCES_VIEW = 'sources';

/** The address to link to. `/sources` on the server redirects to the same place. */
export function sourcesPageUrl(): string {
  return `/editor/?${VIEW_PARAM}=${SOURCES_VIEW}`;
}

/** Whether this page load is the Data sources page rather than the editor. */
export function isSourcesPage(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get(VIEW_PARAM) === SOURCES_VIEW;
}
