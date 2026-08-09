// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The user guide, served from the installation.
 *
 * Rendered from `docs/USER-GUIDE.md` at request time rather than prebuilt into
 * the bundle. The guide is documentation for the machine it is running on: a
 * station that annotates it with its own house rules — which vMix input, which
 * naming convention — should see those edits on reload, not after a rebuild
 * they have no reason to know is required.
 *
 * Cached in memory and revalidated against the file's mtime, so the common case
 * is one string lookup and the edit case still costs one `stat`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { marked } from 'marked';
import type { FastifyInstance } from 'fastify';

import { REPO_ROOT } from '../config.js';
import { docsPage } from '../pages.js';

const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const GUIDE_FILE = path.join(DOCS_DIR, 'USER-GUIDE.md');

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const NOT_FOUND = `<h1>User guide not found</h1>
<p>Expected <code>docs/USER-GUIDE.md</code> in the installation directory. If this is a
packaged build, the <code>docs/</code> folder was not copied alongside it.</p>`;

interface Cached {
  html: string;
  mtimeMs: number;
}

let cache: Cached | null = null;

/**
 * GitHub's heading-anchor slug, reproduced.
 *
 * Lowercase, drop everything that is not a letter, digit, space or hyphen,
 * then spaces to hyphens. `## 4. The app bar — projects, saving, undo` becomes
 * `4-the-app-bar--projects-saving-undo` — the doubled hyphen is the em dash
 * vanishing from between two spaces, and reproducing that exactly is the whole
 * point.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]+/gu, '')
    .trim()
    // One hyphen per space, not one per run of them. The doubled hyphen in
    // `4-the-app-bar--projects` is exactly the gap a removed em dash leaves
    // behind, and collapsing it here breaks every contents link that has a dash
    // in its title — five of the sixteen.
    .replace(/ /g, '-');
}

/**
 * Give every heading an `id`.
 *
 * `marked` stopped emitting heading ids in v5, and the guide opens with a
 * sixteen-entry table of contents written as `#4-the-app-bar…` links because
 * that is what GitHub generates. Without this the contents renders as sixteen
 * links that all do nothing — and it is the first thing on the page.
 *
 * Done on the rendered HTML rather than through a renderer override so it does
 * not have to be revisited every time marked reshapes its renderer API.
 * Duplicate slugs get a numeric suffix, as GitHub does, so two sections that
 * happen to share a title still address separately.
 */
function addHeadingIds(html: string): string {
  const used = new Map<string, number>();

  return html.replace(/<h([1-6])>(.*?)<\/h\1>/gs, (match, level: string, inner: string) => {
    // Strip tags before slugifying: a heading containing `<code>` would
    // otherwise put the tag name into the anchor.
    const base = slugify(inner.replace(/<[^>]+>/g, ''));
    if (!base) return match;

    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const id = seen === 0 ? base : `${base}-${seen}`;

    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
}

/**
 * Markdown → HTML, cached against mtime.
 *
 * Returns null when the guide is missing, which is a real deployment state
 * rather than a fault: someone can copy `dist/` to a graphics box and leave the
 * docs behind. It gets a page saying so, not a 500.
 */
async function renderGuide(): Promise<string | null> {
  let stat;
  try {
    stat = await fs.stat(GUIDE_FILE);
  } catch {
    cache = null;
    return null;
  }

  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.html;

  const source = await fs.readFile(GUIDE_FILE, 'utf8');
  /*
   * Image paths in the guide are repo-relative (`images/foo.png`) because it is
   * also read on GitHub, where that is what works. Rewritten to `/docs/images/`
   * so the same file renders correctly from a page served at `/docs`.
   */
  const rendered = (await marked.parse(source, { async: true })).replace(
    /(<img[^>]+src=")(?!https?:|\/)images\//g,
    '$1/docs/images/',
  );
  const html = addHeadingIds(rendered);

  cache = { html, mtimeMs: stat.mtimeMs };
  return html;
}

export async function registerDocsRoutes(app: FastifyInstance): Promise<void> {
  const serve = async (reply: import('fastify').FastifyReply) => {
    reply.type('text/html; charset=utf-8');
    const body = await renderGuide();
    if (body === null) reply.code(404);
    return docsPage(body ?? NOT_FOUND);
  };

  app.get('/docs', async (_req, reply) => serve(reply));
  app.get('/docs/', async (_req, reply) => serve(reply));

  /*
   * Images only, and only from `docs/images`. This route exists to serve
   * screenshots; letting it hand back anything under `docs/` would make it a
   * general file server rooted one level above the repo's own documentation,
   * and the extension allowlist is what stops a stray `.md` or `.json` from
   * riding along.
   */
  app.get<{ Params: { '*': string } }>('/docs/images/*', async (req, reply) => {
    const imagesDir = path.join(DOCS_DIR, 'images');
    const resolved = path.resolve(imagesDir, req.params['*']);
    if (!resolved.startsWith(imagesDir + path.sep)) {
      reply.code(403);
      return { error: 'forbidden' };
    }

    const type = IMAGE_MIME[path.extname(resolved).toLowerCase()];
    if (!type) {
      reply.code(404);
      return { error: 'not an image' };
    }

    try {
      const data = await fs.readFile(resolved);
      reply.type(type);
      // Screenshots change only when the guide is rewritten, and the page that
      // references them is uncached — so a short revalidate window is enough to
      // keep a scroll through 800 lines from re-fetching eleven PNGs.
      reply.header('cache-control', 'public, max-age=300');
      return data;
    } catch {
      reply.code(404);
      return { error: 'not found' };
    }
  });
}
