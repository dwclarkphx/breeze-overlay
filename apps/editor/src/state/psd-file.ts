// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The impure half of PSD import — parse, rasterise, upload.
 *
 * `psd-import.ts` decides what a PSD becomes and is testable with plain
 * objects; this file does the parts that need a browser. Split for the same
 * reason `layer-thumb.ts` and `LayerThumb.tsx` are split: the decisions are
 * worth testing and the DOM calls are not.
 *
 * **ag-psd is loaded on demand.** It is a large dependency and the overwhelming
 * majority of editor sessions never open a PSD, so a static import would put it
 * in the main bundle for everyone to pay for once. A dynamic import puts it in
 * its own chunk that arrives when the operator picks a file — at which point
 * they are already waiting on a file read.
 */

import type { Layer } from '@breeze/schema';

import { api } from '../api/client.js';
import { planPsdImport, type PsdPlan } from './psd-import.js';

export interface PsdImportResult {
  layers: Layer[];
  rasterReasons: PsdPlan['rasterReasons'];
  skipped: PsdPlan['skipped'];
  /** Stage the PSD was authored at, for a "resize the stage?" prompt. */
  document: { width: number; height: number };
}

export interface PsdImportProgress {
  /** 0..1 across the whole import, upload included. */
  fraction: number;
  label: string;
}

/** A canvas to a PNG blob. */
function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('the browser could not encode that layer as a PNG'));
    }, 'image/png');
  });
}

/**
 * Read a `.psd` and import it into a project.
 *
 * Uploads happen one layer at a time rather than in parallel. The asset route
 * is one request per file by design (Wave 0), and forty concurrent uploads of
 * a print-resolution comp is how an operator discovers their venue LAN's
 * limits mid-import. Sequential also makes the progress readout honest.
 */
export async function importPsd(
  projectId: string,
  file: File,
  onProgress?: (p: PsdImportProgress) => void,
): Promise<PsdImportResult> {
  onProgress?.({ fraction: 0, label: 'Reading the file…' });
  const buffer = await file.arrayBuffer();

  onProgress?.({ fraction: 0.05, label: 'Parsing…' });
  const { readPsd } = await import('ag-psd');

  /*
   * `skipLinkedFilesData` and `skipThumbnail` are the two big ones.
   *
   * A PSD with placed Smart Objects embeds the *entire original file* for each
   * one — a 40 MB PSD can carry 300 MB of linked data that this import never
   * looks at. The composite thumbnail is likewise a full-resolution copy of a
   * flattened image we deliberately do not want.
   */
  const psd = readPsd(buffer, {
    skipLinkedFilesData: true,
    skipThumbnail: true,
    useImageData: false,
  });

  const hint = file.name.replace(/\.psd$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
  const plan = planPsdImport(psd as never, { nameHint: hint || 'psd' });

  if (plan.layers.length === 0) {
    throw new Error(
      'nothing importable in that PSD — every layer was empty, a clipping mask, or had no pixels.',
    );
  }

  /*
   * `src` is patched by id after upload rather than the layer being rebuilt.
   *
   * The plan already nests layers inside groups, so the layer that needs its
   * `src` filled is not necessarily at the top level. Walking to find it by id
   * keeps the planner free to nest as deeply as Photoshop did.
   */
  const byId = new Map<string, Layer>();
  const index = (layers: Layer[]): void => {
    for (const layer of layers) {
      byId.set(layer.id, layer);
      if (layer.type === 'group') index(layer.children);
    }
  };
  index(plan.layers);

  const total = plan.rasters.length;
  for (const [i, raster] of plan.rasters.entries()) {
    const base = 0.1 + (i / Math.max(1, total)) * 0.9;
    onProgress?.({ fraction: base, label: `Uploading ${i + 1} of ${total}…` });

    const blob = await toBlob(raster.canvas as HTMLCanvasElement);
    const asset = await api.uploadAsset(
      projectId,
      new File([blob], raster.name, { type: 'image/png' }),
      (p: number) =>
        onProgress?.({
          fraction: base + (p / Math.max(1, total)) * 0.9,
          label: `Uploading ${i + 1} of ${total}…`,
        }),
    );

    const target = byId.get(raster.layerId);
    if (target && 'src' in target) (target as { src: string }).src = asset.asset.path;
  }

  onProgress?.({ fraction: 1, label: 'Done' });

  return {
    layers: plan.layers,
    rasterReasons: plan.rasterReasons,
    skipped: plan.skipped,
    document: { width: psd.width, height: psd.height },
  };
}
