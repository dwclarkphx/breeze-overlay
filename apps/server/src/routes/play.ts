// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import fs from 'node:fs/promises';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { config, projectAssetsDir } from '../config.js';
import type { DataRegistry } from '../data/registry.js';
import { playPage } from '../pages.js';
import { assertSafeId, getComposition, getDependencies, readProject } from '../store.js';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.json': 'application/json',
};

export async function registerPlayRoutes(
  app: FastifyInstance,
  data?: DataRegistry,
): Promise<void> {
  /**
   * The URL an operator pastes into a vMix Web Browser input or an OBS
   * Browser Source. Transparent background, 1:1 pixels, autoplay by default.
   */
  app.get<{ Params: { id: string; compId: string } }>('/play/:id/:compId', async (req, reply) => {
    const composition = await getComposition(req.params.id, req.params.compId);
    const project = await readProject(req.params.id);
    const dependencies = await getDependencies(req.params.id, req.params.compId);

    reply.type('text/html; charset=utf-8');
    // Browser sources cache aggressively; never let a stale graphic go to air.
    reply.header('cache-control', 'no-store, must-revalidate');
    return playPage({
      projectId: req.params.id,
      composition,
      dependencies,
      assetBase: `/assets/${encodeURIComponent(req.params.id)}`,
      cacheBust: project.updatedAt,
      datasets: data?.datasets(req.params.id) ?? {},
    });
  });

  /** Convenience: first composition in the project. */
  app.get<{ Params: { id: string } }>('/play/:id', async (req, reply) => {
    const project = await readProject(req.params.id);
    const first = project.compositions[0];
    if (!first) {
      reply.code(404);
      return { error: 'project has no compositions' };
    }
    // Must return the reply: redirect() already sent, and returning anything
    // else makes Fastify log FST_ERR_REP_ALREADY_SENT on every hit.
    return reply.redirect(
      `/play/${encodeURIComponent(project.id)}/${encodeURIComponent(first.id)}`,
      302,
    );
  });

  /** Per-project asset serving, path-traversal guarded. */
  app.get<{ Params: { id: string; '*': string } }>('/assets/:id/*', async (req, reply) => {
    assertSafeId(req.params.id);
    const base = projectAssetsDir(req.params.id);
    const resolved = path.resolve(base, req.params['*']);
    if (!resolved.startsWith(base + path.sep)) {
      reply.code(403);
      return { error: 'forbidden' };
    }

    try {
      const data = await fs.readFile(resolved);
      reply.type(MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream');
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      return data;
    } catch {
      reply.code(404);
      return { error: 'asset not found' };
    }
  });

  /** Serve the esbuild client bundle. */
  app.get<{ Params: { '*': string } }>('/public/*', async (req, reply) => {
    const resolved = path.resolve(config.publicDir, req.params['*']);
    if (!resolved.startsWith(config.publicDir + path.sep)) {
      reply.code(403);
      return { error: 'forbidden' };
    }
    try {
      const data = await fs.readFile(resolved);
      const ext = path.extname(resolved).toLowerCase();
      reply.type(ext === '.js' ? 'text/javascript' : ext === '.map' ? 'application/json' : 'application/octet-stream');
      return data;
    } catch {
      reply.code(404);
      return { error: 'not found' };
    }
  });
}
