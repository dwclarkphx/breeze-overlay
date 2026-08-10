// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * What may not land in a served directory.
 *
 * Lifted out of `routes/assets.ts` when the archive reader arrived, because the
 * rule is a property of the assets directory rather than of the upload route:
 * anything that unpacks files into it — a sequence zip today, a project restore
 * next — has to apply exactly the same list. Two copies would drift, and the
 * copy that drifts is the one that lets an `.html` through.
 */

/**
 * Extensions refused outright.
 *
 * Not a virus check and not pretending to be one. The assets directory is
 * served as static files, so the only thing that matters here is that nothing
 * lands in it which a browser would execute in the server's origin — an
 * uploaded `.html` runs with the editor's cookies and the operator's session.
 */
export const REFUSED = new Set([
  '.html', '.htm', '.xhtml', '.svgz', '.js', '.mjs', '.cjs', '.wasm',
  '.php', '.jsp', '.asp', '.aspx', '.exe', '.dll', '.so', '.sh', '.bat', '.cmd',
]);

/** The offending extension, or null when the name is acceptable. */
export function refusedExtension(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = name.slice(dot).toLowerCase();
  return REFUSED.has(ext) ? ext : null;
}
