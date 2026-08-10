// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Layers panel — z-order, visibility, locking, rename, nesting.
 *
 * Rendered top-of-stack first, matching what the operator sees: the last layer
 * in the JSON paints on top, so it is listed first. Getting this backwards is
 * the classic layer-panel bug.
 */

import { useState, type JSX } from 'react';
import type { Layer, LayerType } from '@breeze/schema';

import { useEditor } from '../state/store.js';
import { LayerThumb } from './LayerThumb.js';

export function LayersPanel(): JSX.Element {
  const composition = useEditor((s) => s.composition);
  const selected = useEditor((s) => s.selectedLayerIds);
  const selectLayers = useEditor((s) => s.selectLayers);
  const toggleSelection = useEditor((s) => s.toggleLayerSelection);
  const run = useEditor((s) => s.run);
  const addLayer = useEditor((s) => s.addLayer);
  const deleteSelected = useEditor((s) => s.deleteSelectedLayers);

  const addCell = useEditor((s) => s.addCell);
  const activeLayer = useEditor((s) => s.activeLayer());
  const cellOwner = useEditor((s) => s.activeCellOwner());

  const projectId = useEditor((s) => s.projectId);
  const [renaming, setRenaming] = useState<string | null>(null);

  if (!composition) return <div className="panel-empty">—</div>;

  /*
   * The table a new cell would go into.
   *
   * Selecting a cell counts, not just selecting the table itself. Building a
   * row template means adding several cells in a row, and after each one the
   * selection is the cell just added — so requiring the table to be selected
   * would mean clicking back up to it between every single cell.
   */
  const targetTable =
    cellOwner?.type === 'table' ? cellOwner : activeLayer?.type === 'table' ? activeLayer : null;

  const assetBase = projectId ? `/assets/${encodeURIComponent(projectId)}` : undefined;

  // Paint order is bottom-up in the JSON, so reverse for display.
  const ordered = [...composition.layers].reverse();

  const move = (layerId: string, direction: -1 | 1, siblings?: Layer[]) => {
    const list = siblings ?? composition.layers;
    const index = list.findIndex((l) => l.id === layerId);
    if (index === -1) return;
    const toIndex = index + direction;
    if (toIndex < 0 || toIndex >= list.length) return;
    run({ kind: 'reorderLayer', layerId, toIndex });
  };

  const renderRow = (layer: Layer, depth: number, siblings?: Layer[]) => (
    <div key={layer.id}>
      <div
        className={`layer-row${selected.includes(layer.id) ? ' selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={(e) => (e.shiftKey || e.ctrlKey ? toggleSelection(layer.id) : selectLayers([layer.id]))}
        onDoubleClick={() => setRenaming(layer.id)}
      >
        <button
          className="layer-icon-btn"
          title={layer.visible === false ? 'Show' : 'Hide'}
          onClick={(e) => {
            e.stopPropagation();
            run({ kind: 'patchLayer', layerId: layer.id, patch: { visible: layer.visible === false } });
          }}
        >
          {layer.visible === false ? '○' : '◉'}
        </button>
        <button
          className="layer-icon-btn"
          title={layer.locked ? 'Unlock' : 'Lock'}
          onClick={(e) => {
            e.stopPropagation();
            run({ kind: 'patchLayer', layerId: layer.id, patch: { locked: !layer.locked } });
          }}
        >
          {layer.locked ? '🔒' : '　'}
        </button>

        <span className="layer-type" title={layer.type}>
          <LayerThumb layer={layer} assetBase={assetBase} />
        </span>

        {renaming === layer.id ? (
          <input
            className="layer-rename"
            autoFocus
            defaultValue={layer.name ?? layer.id}
            onBlur={(e) => {
              run({ kind: 'renameLayer', layerId: layer.id, name: e.target.value });
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(null);
            }}
          />
        ) : (
          <span className="layer-name">{layer.name ?? layer.id}</span>
        )}

        {/*
          The column a cell renders, shown next to its name.

          A row template is a handful of near-identical text layers, and the
          only thing distinguishing "Text" from "Text" is which column it reads.
          Without this the panel lists four indistinguishable rows and the only
          way to tell them apart is to click each one and read the properties
          panel.
        */}
        {layer.cell !== undefined && layer.cell !== '' && (
          <span className="layer-cell-key" title={`Column: ${layer.cell}`}>{layer.cell}</span>
        )}

        {(depth === 0 || siblings !== undefined) && (
          <span className="layer-order">
            <button onClick={(e) => { e.stopPropagation(); move(layer.id, 1, siblings); }} title="Bring forward">▲</button>
            <button onClick={(e) => { e.stopPropagation(); move(layer.id, -1, siblings); }} title="Send backward">▼</button>
          </span>
        )}
      </div>

      {layer.type === 'group' &&
        [...layer.children].reverse().map((child) => renderRow(child, depth + 1))}

      {/*
        A table's row template, listed as its children.

        The cells were reachable only by hand-editing project JSON before this:
        the runtime has played per-cell keyframe tracks since 0.53.0, but
        nothing in the editor could select a cell, so the feature was
        unauthorable. Cells are ordinary layers, so they render through the same
        row and reorder through the same command — reversed like everything
        else here, because `buildRow` sets `zIndex` from the array index and the
        last cell paints on top.
      */}
      {layer.type === 'table' && layer.row.cells.length > 0 && (
        <>
          <div className="layer-subhead" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
            Row template
          </div>
          {[...layer.row.cells]
            .reverse()
            .map((cell) => renderRow(cell, depth + 1, layer.row.cells))}
        </>
      )}
    </div>
  );

  return (
    <div className="panel layers-panel">
      <div className="panel-header">
        <span>Layers</span>
        <span className="panel-actions">
          <select
            className="add-layer"
            value=""
            onChange={(e) => {
              const value = e.target.value;
              e.target.value = '';
              if (!value) return;

              if (value.startsWith('cell:')) {
                if (targetTable) addCell(targetTable.id, value.slice(5) as LayerType);
                return;
              }
              addLayer(value as LayerType);
            }}
          >
            <option value="">+ Add…</option>
            <option value="text">Text</option>
            <option value="shape">Shape</option>
            <option value="image">Image</option>
            <option value="video">Video</option>
            <option value="sprite">Sprite sheet</option>
            <option value="crawl">Crawl</option>
            <option value="table">Table</option>
            <option value="group">Group</option>
            {/*
              Cell options appear only with a table in context. Offered
              unconditionally they would be the most common way to add a layer
              to nothing at all — the click succeeds, the panel does not change,
              and there is no error to explain why.
            */}
            {targetTable && (
              <optgroup label={`Cell in ${targetTable.name ?? targetTable.id}`}>
                <option value="cell:text">Text cell</option>
                <option value="cell:image">Image cell</option>
                <option value="cell:shape">Shape cell</option>
              </optgroup>
            )}
          </select>
          <button onClick={deleteSelected} disabled={selected.length === 0} title="Delete selected">🗑</button>
        </span>
      </div>
      <div className="layer-list">{ordered.map((layer) => renderRow(layer, 0))}</div>
    </div>
  );
}
