// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Serves the Vite-built React editor at /editor.
 *
 * Kept separate from the player routes because the editor is a single-page app
 * with hashed asset filenames: its assets are immutable and cacheable forever,
 * while `index.html` must never be cached or a rebuild leaves the browser
 * running the previous bundle against a new API.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { FastifyInstance, FastifyReply } from 'fastify';

import { config } from '../config.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const NOT_BUILT = `<!doctype html>
<html><head><meta charset="utf-8"><title>Breeze editor</title>
<style>body{font:14px/1.6 system-ui,sans-serif;background:#0d1117;color:#c9d1d9;padding:40px}
code{background:#161b22;padding:2px 6px;border-radius:4px;color:#e3b341}</style></head>
<body>
<h1>Editor not built</h1>
<p>Run <code>pnpm --filter @breeze/editor build</code>, or <code>pnpm -r build</code>, then reload.</p>
<p>For development with hot reload, run <code>pnpm --filter @breeze/editor dev</code>
and open <a href="http://localhost:7332/">http://localhost:7332/</a> — it proxies the API here.</p>
</body></html>`;

async function sendFile(reply: FastifyReply, filePath: string): Promise<Buffer | null> {
  try {
    const data = await fs.readFile(filePath);
    reply.type(MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream');
    return data;
  } catch {
    return null;
  }
}

export async function registerEditorRoutes(app: FastifyInstance): Promise<void> {
  const indexPath = path.join(config.editorDir, 'index.html');

  const serveIndex = async (reply: FastifyReply) => {
    const html = await sendFile(reply, indexPath);
    if (!html) {
      reply.type('text/html; charset=utf-8').code(503);
      return NOT_BUILT;
    }
    reply.header('cache-control', 'no-store');
    return html;
  };

  app.get('/editor', async (_req, reply) => serveIndex(reply));
  app.get('/editor/', async (_req, reply) => serveIndex(reply));

  app.get<{ Params: { '*': string } }>('/editor/*', async (req, reply) => {
    const requested = req.params['*'];
    const resolved = path.resolve(config.editorDir, requested);

    if (!resolved.startsWith(config.editorDir + path.sep)) {
      reply.code(403);
      return { error: 'forbidden' };
    }

    const data = await sendFile(reply, resolved);
    if (data) {
      // Vite fingerprints everything under assets/, so those are immutable.
      if (requested.startsWith('assets/')) {
        reply.header('cache-control', 'public, max-age=31536000, immutable');
      }
      return data;
    }

    // Unknown path inside the SPA: hand back index.html so client-side routing
    // works, rather than 404ing on a deep link.
    return serveIndex(reply);
  });
}
