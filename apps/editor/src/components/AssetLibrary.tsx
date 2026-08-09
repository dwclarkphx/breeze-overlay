// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Asset library — the full-size browser, opened from the bin.
 *
 * The docked bin is a good picker and a bad library. It is one column of a
 * three-panel stack, it folds, and every pixel it takes comes off the layer
 * list — so search, facets, folders, bulk editing and a detail panel cannot all
 * live there without making the thing it sits next to unusable. Wave B puts the
 * compact list where it was and gives everything that needs room a modal.
 *
 * Modal rather than a route or a docked fourth panel for two reasons. The bin
 * is reached mid-build, so a route would lose the composition on screen; and
 * asset management is a *mode* — an operator filing forty files is not also
 * dragging keyframes, and pretending otherwise costs the screen space that
 * makes the filing bearable.
 *
 * The existing in-place delete confirmation stays in-place (styles.css says why
 * a modal is wrong for it). This modal is the container, not a new answer to
 * that question.
 */

import { useEffect, useMemo, useRef, useState, type DragEvent, type JSX } from 'react';
import {
  assetFolders,
  assetLabel,
  assetTags as assetTagFacets,
  filterAssets,
  isExpired,
  normalizeTag,
  type AssetFacet,
  type AssetRef,
  type AssetSort,
  type AssetUsage,
} from '@breeze/schema';

import { useEditor } from '../state/store.js';

const KIND_GLYPH: Record<AssetRef['kind'], string> = {
  image: '🖼',
  video: '▶',
  font: 'Ag',
  audio: '♪',
  other: '◆',
};

const KINDS: AssetRef['kind'][] = ['image', 'video', 'font', 'audio', 'other'];
const STATES: NonNullable<AssetRef['state']>[] = ['draft', 'approved', 'retired'];

const SORTS: Array<{ value: AssetSort; label: string }> = [
  { value: 'added', label: 'Date added' },
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Size' },
  { value: 'duration', label: 'Duration' },
];

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return '';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** ISO instant → the `yyyy-mm-dd` an `<input type="date">` requires. */
function dateValue(iso: string | undefined): string {
  return iso ? (iso.split('T')[0] ?? '') : '';
}

export function AssetLibrary({ onClose }: { onClose: () => void }): JSX.Element {
  const projectId = useEditor((s) => s.projectId);
  const assets = useEditor((s) => s.assets);
  const vocabulary = useEditor((s) => s.assetTags);
  const filter = useEditor((s) => s.assetFilter);
  const selection = useEditor((s) => s.assetSelection);
  const detailId = useEditor((s) => s.assetDetail);
  const uploads = useEditor((s) => s.uploads);
  const uploadError = useEditor((s) => s.uploadError);

  const uploadAssets = useEditor((s) => s.uploadAssets);
  const setAssetFilter = useEditor((s) => s.setAssetFilter);
  const clearAssetFilter = useEditor((s) => s.clearAssetFilter);
  const toggleAssetFacet = useEditor((s) => s.toggleAssetFacet);
  const selectAssets = useEditor((s) => s.selectAssets);
  const toggleAssetSelection = useEditor((s) => s.toggleAssetSelection);
  const clearAssetSelection = useEditor((s) => s.clearAssetSelection);
  const openAssetDetail = useEditor((s) => s.openAssetDetail);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const assetBase = projectId ? `/assets/${encodeURIComponent(projectId)}` : '';
  const inFlight = Object.entries(uploads);

  /*
   * Escape closes, and only when nothing inside has claimed it.
   *
   * Bound on the dialog rather than the window so a text field mid-edit gets it
   * first — an operator pressing Escape to abandon a half-typed tag should not
   * also lose the library and the filter that took four clicks to set up.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /*
   * Facet counts are computed over the assets *already narrowed by the other
   * facets*, so a count of zero cannot appear and no facet can be clicked into
   * an empty list. Each dimension therefore excludes itself from its own
   * narrowing — otherwise picking "image" would leave "video" reading 0 and
   * looking broken rather than additive.
   */
  const visible = useMemo(() => filterAssets(assets, filter), [assets, filter]);

  const countsFor = (exclude: 'kinds' | 'folders' | 'tags' | 'states'): AssetRef[] =>
    filterAssets(assets, { ...filter, [exclude]: undefined });

  const kindFacets = useMemo<AssetFacet[]>(() => {
    const pool = countsFor('kinds');
    return KINDS.map((kind) => ({
      value: kind,
      count: pool.filter((a) => a.kind === kind).length,
    })).filter((f) => f.count > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, filter]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const folderFacets = useMemo(() => assetFolders(countsFor('folders')), [assets, filter]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tagFacets = useMemo(() => assetTagFacets(countsFor('tags')), [assets, filter]);

  const stateFacets = useMemo<AssetFacet[]>(() => {
    const pool = countsFor('states');
    return STATES.map((state) => ({
      value: state,
      count: pool.filter((a) => (a.state ?? 'draft') === state).length,
    })).filter((f) => f.count > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, filter]);

  const detail = assets.find((a) => a.id === detailId) ?? null;
  const filtered = visible.length !== assets.length;

  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setDragOver(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) void uploadAssets(files);
  };

  /**
   * Click behavior on a card.
   *
   * Plain click opens the detail panel — the common case is "what is this
   * file". Ctrl/Cmd adds to the selection, Shift extends from the last one, in
   * the order currently on screen rather than the order they were uploaded,
   * because the row an operator means is the row they can see.
   */
  const onCardClick = (asset: AssetRef, e: React.MouseEvent): void => {
    if (e.metaKey || e.ctrlKey) {
      toggleAssetSelection(asset.id);
      return;
    }
    if (e.shiftKey && selection.length > 0) {
      const order = visible.map((a) => a.id);
      const from = order.indexOf(selection[selection.length - 1]!);
      const to = order.indexOf(asset.id);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        selectAssets([...new Set([...selection, ...order.slice(lo, hi + 1)])]);
        return;
      }
    }
    openAssetDetail(asset.id === detailId ? null : asset.id);
  };

  const facetRow = (
    label: string,
    facet: 'kinds' | 'folders' | 'tags' | 'states',
    values: AssetFacet[],
    display: (value: string) => string,
  ): JSX.Element | null => {
    if (values.length === 0) return null;
    const active = (filter[facet] as readonly string[] | undefined) ?? [];
    return (
      <div className="lib-facet">
        <h4>{label}</h4>
        <ul>
          {values.map(({ value, count }) => (
            <li key={value || '(none)'}>
              <button
                className={active.includes(value) ? 'active' : undefined}
                onClick={() => toggleAssetFacet(facet, value)}
              >
                <span className="lib-facet-name">{display(value)}</span>
                <span className="lib-facet-count">{count}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  return (
    <div
      className="lib-overlay"
      onMouseDown={(e) => {
        // Only a press that both starts and ends on the backdrop closes. A drag
        // that began inside — selecting text in a description — must not.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`lib-dialog${dragOver ? ' over' : ''}`}
        role="dialog"
        aria-label="Asset library"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOver(false);
        }}
        onDrop={onDrop}
      >
        <header className="lib-header">
          <strong>Assets</strong>
          <span className="lib-count">
            {filtered ? `${visible.length} of ${assets.length}` : `${assets.length}`}
          </span>

          <input
            className="lib-search"
            type="search"
            placeholder="Search name, tag, description…"
            value={filter.query ?? ''}
            onChange={(e) => setAssetFilter({ query: e.target.value })}
          />

          <select
            value={filter.sort ?? 'added'}
            onChange={(e) => setAssetFilter({ sort: e.target.value as AssetSort })}
            title="Sort by"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <button
            title={filter.descending ?? true ? 'Descending — click for ascending' : 'Ascending'}
            onClick={() => setAssetFilter({ descending: !(filter.descending ?? true) })}
          >
            {filter.descending ?? true ? '↓' : '↑'}
          </button>

          <span className="lib-header-gap" />
          <button onClick={() => inputRef.current?.click()} disabled={!projectId}>
            + Upload…
          </button>
          <button className="lib-close" onClick={onClose} title="Close (Esc)">✕</button>
        </header>

        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            if (files.length) void uploadAssets(files);
            // Cleared so re-picking the same file fires a change event; without
            // it a failed upload cannot be retried by choosing the same file,
            // which is the first thing anyone tries.
            e.target.value = '';
          }}
        />

        {uploadError && <p className="lib-error">{uploadError}</p>}

        {inFlight.length > 0 && (
          <ul className="lib-uploads">
            {inFlight.map(([name, fraction]) => (
              <li key={name}>
                <span className="lib-upload-name">{name}</span>
                <span className="asset-progress">
                  <span
                    className="asset-progress-fill"
                    style={{ width: `${Math.round(fraction * 100)}%` }}
                  />
                </span>
                <span className="lib-upload-pct">{Math.round(fraction * 100)}%</span>
              </li>
            ))}
          </ul>
        )}

        <div className="lib-body">
          <aside className="lib-facets">
            {facetRow('Kind', 'kinds', kindFacets, (v) => v)}
            {facetRow('Folder', 'folders', folderFacets, (v) => v || 'Unfiled')}
            {facetRow('Tag', 'tags', tagFacets, (v) => v || 'Untagged')}
            {facetRow('State', 'states', stateFacets, (v) => v)}
            {filtered && (
              <button className="lib-clear" onClick={clearAssetFilter}>
                Clear filters
              </button>
            )}
          </aside>

          <main className="lib-grid-wrap">
            {assets.length === 0 ? (
              <p className="hint lib-empty">
                No assets yet. Drop files anywhere in this window, or use Upload.
                Images, videos and fonts uploaded here are available to every
                composition in this project.
              </p>
            ) : visible.length === 0 ? (
              <p className="hint lib-empty">
                Nothing matches. <button className="linkish" onClick={clearAssetFilter}>Clear filters</button>
              </p>
            ) : (
              <ul className="lib-grid">
                {visible.map((asset) => {
                  const ticked = selection.includes(asset.id);
                  const expired = isExpired(asset);
                  return (
                    <li
                      key={asset.id}
                      className={[
                        'lib-card',
                        ticked ? 'ticked' : '',
                        asset.id === detailId ? 'current' : '',
                      ].filter(Boolean).join(' ')}
                      onClick={(e) => onCardClick(asset, e)}
                      title={`${assetLabel(asset)}\n${asset.path}`}
                    >
                      <label
                        className="lib-tick"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={ticked}
                          onChange={() => toggleAssetSelection(asset.id)}
                        />
                      </label>

                      <span className="lib-thumb">
                        {asset.kind === 'image' ? (
                          <img src={`${assetBase}/${asset.path.replace(/^assets\//, '')}`} alt="" />
                        ) : (
                          <span className="lib-glyph">{KIND_GLYPH[asset.kind]}</span>
                        )}
                        {asset.hasAlpha && <span className="lib-badge alpha" title="Carries an alpha channel">α</span>}
                        {expired && <span className="lib-badge expired" title={`Expired ${dateValue(asset.expiresAt)}`}>!</span>}
                      </span>

                      <span className="lib-name">{assetLabel(asset)}</span>
                      <span className="lib-sub">
                        {asset.width && asset.height ? `${asset.width}×${asset.height}` : asset.kind}
                        {asset.duration !== undefined && ` · ${formatDuration(asset.duration)}`}
                        {' · '}
                        {formatBytes(asset.bytes)}
                      </span>
                      {asset.folder && <span className="lib-folder">{asset.folder}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </main>

          {selection.length > 1 ? (
            <BulkPanel count={selection.length} vocabulary={vocabulary} onDone={clearAssetSelection} />
          ) : detail ? (
            <DetailPanel asset={detail} vocabulary={vocabulary} onClose={() => openAssetDetail(null)} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- detail */

function DetailPanel({
  asset,
  vocabulary,
  onClose,
}: {
  asset: AssetRef;
  vocabulary: string[];
  onClose: () => void;
}): JSX.Element {
  const updateAsset = useEditor((s) => s.updateAsset);
  const removeAsset = useEditor((s) => s.removeAsset);
  const fetchAssetUsage = useEditor((s) => s.fetchAssetUsage);

  const [usage, setUsage] = useState<AssetUsage[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [tagDraft, setTagDraft] = useState('');

  /*
   * Usage is fetched per asset, every time.
   *
   * Not cached: the two moments it is wanted are opening this panel and
   * confirming a delete, and a cached answer is one that predates whatever the
   * operator just changed. Being wrong here means deleting a file that is on
   * air, so it is worth a round trip.
   */
  useEffect(() => {
    let live = true;
    setUsage(null);
    setConfirming(false);
    void fetchAssetUsage(asset.id).then((u) => {
      if (live) setUsage(u);
    });
    return () => {
      live = false;
    };
  }, [asset.id, fetchAssetUsage]);

  const addTag = (raw: string): void => {
    const tag = normalizeTag(raw);
    if (!tag) return;
    if (!(asset.tags ?? []).includes(tag)) {
      void updateAsset(asset.id, { tags: [...(asset.tags ?? []), tag] });
    }
    setTagDraft('');
  };

  const suggestions = vocabulary.filter((t) => !(asset.tags ?? []).includes(t));

  return (
    <aside className="lib-detail" onClick={(e) => e.stopPropagation()}>
      <header>
        <strong>Details</strong>
        <button className="lib-close" onClick={onClose}>✕</button>
      </header>

      <div className="lib-detail-body">
        <label>
          Title
          <input
            value={asset.title ?? ''}
            placeholder={asset.originalName ?? ''}
            onChange={(e) => void updateAsset(asset.id, { title: e.target.value })}
          />
        </label>

        <label>
          Description
          <textarea
            rows={2}
            value={asset.description ?? ''}
            onChange={(e) => void updateAsset(asset.id, { description: e.target.value })}
          />
        </label>

        <label>
          Folder
          <input
            list="lib-folder-list"
            value={asset.folder ?? ''}
            placeholder="Unfiled"
            onChange={(e) => void updateAsset(asset.id, { folder: e.target.value })}
          />
        </label>

        <div className="lib-field">
          <span className="lib-field-label">Tags</span>
          <div className="lib-tags">
            {(asset.tags ?? []).map((tag) => (
              <button
                key={tag}
                className="lib-tag"
                title="Remove"
                onClick={() =>
                  void updateAsset(asset.id, { tags: (asset.tags ?? []).filter((t) => t !== tag) })
                }
              >
                {tag} ✕
              </button>
            ))}
          </div>
          <input
            list="lib-tag-list"
            value={tagDraft}
            placeholder="Add a tag…"
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag(tagDraft);
              }
            }}
            onBlur={() => addTag(tagDraft)}
          />
          <datalist id="lib-tag-list">
            {suggestions.map((t) => <option key={t} value={t} />)}
          </datalist>
        </div>

        <label>
          State
          <select
            value={asset.state ?? 'draft'}
            onChange={(e) => void updateAsset(asset.id, { state: e.target.value as AssetRef['state'] })}
          >
            {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>

        <label>
          Source
          <input
            value={asset.source ?? ''}
            placeholder="Who supplied it"
            onChange={(e) => void updateAsset(asset.id, { source: e.target.value })}
          />
        </label>

        <label>
          Usage rights
          <select
            value={asset.usage ?? 'unrestricted'}
            onChange={(e) => void updateAsset(asset.id, { usage: e.target.value as AssetRef['usage'] })}
          >
            <option value="unrestricted">unrestricted</option>
            <option value="licensed">licensed</option>
            <option value="single-use">single-use</option>
          </select>
        </label>

        <label>
          Expires
          <input
            type="date"
            value={dateValue(asset.expiresAt)}
            // An emptied date field clears the license rather than storing "".
            onChange={(e) => void updateAsset(asset.id, { expiresAt: e.target.value || null })}
          />
        </label>
        {isExpired(asset) && (
          <p className="lib-warn">
            This asset's license ran out on {dateValue(asset.expiresAt)} and it is still
            in the bin.
          </p>
        )}

        {/* Derived facts, shown but not editable — they describe the bytes. */}
        <dl className="lib-tech">
          <dt>File</dt><dd>{asset.originalName ?? asset.path}</dd>
          <dt>Kind</dt><dd>{asset.kind}</dd>
          {asset.width !== undefined && (<><dt>Size</dt><dd>{asset.width}×{asset.height}</dd></>)}
          {asset.duration !== undefined && (<><dt>Duration</dt><dd>{formatDuration(asset.duration)}</dd></>)}
          {asset.codec && (<><dt>Codec</dt><dd>{asset.codec}</dd></>)}
          {asset.hasAlpha !== undefined && (<><dt>Alpha</dt><dd>{asset.hasAlpha ? 'yes' : 'no'}</dd></>)}
          <dt>Bytes</dt><dd>{formatBytes(asset.bytes)}</dd>
          {asset.addedAt && (<><dt>Added</dt><dd>{dateValue(asset.addedAt)}</dd></>)}
          <dt>Path</dt>
          <dd>
            <button
              className="linkish"
              title="Copy path"
              onClick={() => void navigator.clipboard?.writeText(asset.path)}
            >
              {asset.path} ⧉
            </button>
          </dd>
        </dl>

        <div className="lib-usage">
          <h4>Used by</h4>
          {usage === null ? (
            <p className="hint">Checking…</p>
          ) : usage.length === 0 ? (
            <p className="hint">No composition in this project references it.</p>
          ) : (
            <ul>
              {usage.map((u) => (
                <li key={u.compositionId}>
                  <strong>{u.compositionName}</strong>
                  <span className="hint">
                    {' '}
                    — {u.references.map((r) => r.layerName ?? r.layerId).join(', ')}
                    {u.references.some((r) => r.via === 'mask') && ' (mask)'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/*
          Delete names what breaks, which is the whole point of the usage index.
          The bin's old confirmation could only speak for the composition that
          happened to be open, so it declined to claim more than that.
        */}
        {confirming ? (
          <div className="lib-confirm">
            <p>
              {usage && usage.length > 0
                ? `Delete anyway? ${usage.length} composition${usage.length === 1 ? '' : 's'} reference this file and will render nothing.`
                : 'Delete this file?'}
            </p>
            <button className="danger" onClick={() => { void removeAsset(asset.id); onClose(); }}>
              Delete
            </button>
            <button onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        ) : (
          <button className="lib-delete" onClick={() => setConfirming(true)}>
            Delete asset
          </button>
        )}
      </div>
    </aside>
  );
}

/* ----------------------------------------------------------------- bulk */

/**
 * Bulk edit, shown in place of the detail panel once more than one is ticked.
 *
 * Every control here is *additive or set*, never a toggle: with forty assets
 * selected there is no single current value to toggle away from, and a control
 * that shows one of them is a control that silently discards the other
 * thirty-nine. So "add tag" adds, and "set folder" sets.
 */
function BulkPanel({
  count,
  vocabulary,
  onDone,
}: {
  count: number;
  vocabulary: string[];
  onDone: () => void;
}): JSX.Element {
  const updateSelectedAssets = useEditor((s) => s.updateSelectedAssets);

  const [folder, setFolder] = useState('');
  const [tag, setTag] = useState('');

  /**
   * Merged server-side, not computed here.
   *
   * Each asset's resulting tag list depends on its own, so doing this in the
   * client would mean one request per asset — which is exactly what bulk exists
   * to avoid. `addTags` gives the server enough to merge per row inside a
   * single lock, read and write.
   */
  const addTagToAll = (raw: string): void => {
    const value = normalizeTag(raw);
    if (!value) return;
    void updateSelectedAssets({}, [value]);
    setTag('');
  };

  return (
    <aside className="lib-detail lib-bulk" onClick={(e) => e.stopPropagation()}>
      <header>
        <strong>{count} selected</strong>
        <button className="lib-close" onClick={onDone} title="Clear selection">✕</button>
      </header>

      <div className="lib-detail-body">
        <label>
          Move to folder
          <span className="lib-inline">
            <input
              list="lib-folder-list"
              value={folder}
              placeholder="Folder name"
              onChange={(e) => setFolder(e.target.value)}
            />
            <button
              disabled={!folder.trim()}
              onClick={() => { void updateSelectedAssets({ folder }); setFolder(''); }}
            >
              Set
            </button>
          </span>
        </label>

        <div className="lib-field">
          <span className="lib-field-label">Add tag to all</span>
          <span className="lib-inline">
            <input
              list="lib-tag-list-bulk"
              value={tag}
              placeholder="Tag"
              onChange={(e) => setTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTagToAll(tag); } }}
            />
            <button disabled={!tag.trim()} onClick={() => addTagToAll(tag)}>Add</button>
          </span>
          <datalist id="lib-tag-list-bulk">
            {vocabulary.map((t) => <option key={t} value={t} />)}
          </datalist>
        </div>

        <label>
          Set state
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) void updateSelectedAssets({ state: e.target.value as AssetRef['state'] });
              e.target.value = '';
            }}
          >
            <option value="">Choose…</option>
            {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>

        <label>
          Set usage rights
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) void updateSelectedAssets({ usage: e.target.value as AssetRef['usage'] });
              e.target.value = '';
            }}
          >
            <option value="">Choose…</option>
            <option value="unrestricted">unrestricted</option>
            <option value="licensed">licensed</option>
            <option value="single-use">single-use</option>
          </select>
        </label>

        <p className="hint">
          Bulk delete is deliberately absent. Deleting many files at once is the
          one action here that cannot be undone by re-uploading, because it is
          the one where nobody reads the list first.
        </p>
      </div>
    </aside>
  );
}

/** Folder suggestions, shared by the detail and bulk panels. */
export function AssetFolderList(): JSX.Element {
  const assets = useEditor((s) => s.assets);
  const folders = assetFolders(assets).filter((f) => f.value);
  return (
    <datalist id="lib-folder-list">
      {folders.map((f) => <option key={f.value} value={f.value} />)}
    </datalist>
  );
}
