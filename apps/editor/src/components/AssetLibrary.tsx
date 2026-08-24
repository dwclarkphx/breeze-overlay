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

import { useI18n, useT } from '@breeze/i18n/react';
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

import { formatBytes } from '../state/format.js';
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
const USAGES: NonNullable<AssetRef['usage']>[] = ['unrestricted', 'licensed', 'single-use'];

const SORTS: Array<{ value: AssetSort; labelKey: string }> = [
  { value: 'added', labelKey: 'editor.assets.sortAdded' },
  { value: 'name', labelKey: 'editor.assets.sortName' },
  { value: 'size', labelKey: 'editor.assets.sortSize' },
  { value: 'duration', labelKey: 'editor.assets.sortDuration' },
];

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
  const t = useT();
  const { locale } = useI18n();
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
    labelKey: string,
    facet: 'kinds' | 'folders' | 'tags' | 'states',
    values: AssetFacet[],
    display: (value: string) => string,
  ): JSX.Element | null => {
    if (values.length === 0) return null;
    const active = (filter[facet] as readonly string[] | undefined) ?? [];
    return (
      <div className="lib-facet">
        <h4>{t(labelKey)}</h4>
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
        aria-label={t('editor.assets.dialogLabel')}
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
          <strong>{t('editor.assets.title')}</strong>
          <span className="lib-count">
            {filtered
              ? t('editor.assets.countFiltered', { shown: visible.length, total: assets.length })
              : assets.length}
          </span>

          <input
            className="lib-search"
            type="search"
            placeholder={t('editor.assets.searchPlaceholder')}
            value={filter.query ?? ''}
            onChange={(e) => setAssetFilter({ query: e.target.value })}
          />

          <select
            value={filter.sort ?? 'added'}
            onChange={(e) => setAssetFilter({ sort: e.target.value as AssetSort })}
            title={t('editor.assets.sortBy')}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>{t(s.labelKey)}</option>
            ))}
          </select>
          <button
            title={t(
              filter.descending ?? true
                ? 'editor.assets.sortDescending'
                : 'editor.assets.sortAscending',
            )}
            onClick={() => setAssetFilter({ descending: !(filter.descending ?? true) })}
          >
            {filter.descending ?? true ? '↓' : '↑'}
          </button>

          <span className="lib-header-gap" />
          <button onClick={() => inputRef.current?.click()} disabled={!projectId}>
            {t('editor.assets.upload')}
          </button>
          <button className="lib-close" onClick={onClose} title={t('editor.assets.close')}>✕</button>
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

        {uploadError && <p className="lib-error">{t(uploadError)}</p>}

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
            {facetRow('editor.assets.facetKind', 'kinds', kindFacets,
              (v) => t('editor.assets.kindName', { kind: v }))}
            {facetRow('editor.assets.facetFolder', 'folders', folderFacets,
              (v) => v || t('editor.assets.unfiled'))}
            {facetRow('editor.assets.facetTag', 'tags', tagFacets,
              (v) => v || t('editor.assets.untagged'))}
            {facetRow('editor.assets.facetState', 'states', stateFacets,
              (v) => t('editor.assets.stateName', { state: v }))}
            {filtered && (
              <button className="lib-clear" onClick={clearAssetFilter}>
                {t('editor.assets.clearFilters')}
              </button>
            )}
          </aside>

          <main className="lib-grid-wrap">
            {assets.length === 0 ? (
              <p className="hint lib-empty">{t('editor.assets.emptyNone')}</p>
            ) : visible.length === 0 ? (
              <p className="hint lib-empty">
                {t('editor.assets.emptyFiltered')}{' '}
                <button className="linkish" onClick={clearAssetFilter}>
                  {t('editor.assets.clearFilters')}
                </button>
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
                        {asset.hasAlpha && (
                          <span className="lib-badge alpha" title={t('editor.assets.alphaBadge')}>α</span>
                        )}
                        {expired && (
                          <span
                            className="lib-badge expired"
                            title={t('editor.assets.expiredBadge', { date: dateValue(asset.expiresAt) })}
                          >!</span>
                        )}
                      </span>

                      <span className="lib-name">{assetLabel(asset)}</span>
                      {/*
                        Joined rather than interleaved. Interleaving put the
                        separator inside the duration's own template, so a file
                        with no duration and unknown bytes rendered a bare " · "
                        with nothing on either side of it.
                      */}
                      <span className="lib-sub">
                        {[
                          asset.width && asset.height
                            ? t('editor.assets.dimensions', { width: asset.width, height: asset.height })
                            : t('editor.assets.kindName', { kind: asset.kind }),
                          asset.duration === undefined ? '' : formatDuration(asset.duration),
                          formatBytes(asset.bytes, t, locale),
                        ].filter(Boolean).join(' · ')}
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
  const t = useT();
  const { locale } = useI18n();
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

  const suggestions = vocabulary.filter((tag) => !(asset.tags ?? []).includes(tag));

  return (
    <aside className="lib-detail" onClick={(e) => e.stopPropagation()}>
      <header>
        <strong>{t('editor.assets.details')}</strong>
        <button className="lib-close" onClick={onClose}>✕</button>
      </header>

      <div className="lib-detail-body">
        <label>
          {t('editor.assets.fieldTitle')}
          <input
            value={asset.title ?? ''}
            placeholder={asset.originalName ?? ''}
            onChange={(e) => void updateAsset(asset.id, { title: e.target.value })}
          />
        </label>

        <label>
          {t('editor.assets.fieldDescription')}
          <textarea
            rows={2}
            value={asset.description ?? ''}
            onChange={(e) => void updateAsset(asset.id, { description: e.target.value })}
          />
        </label>

        <label>
          {t('editor.assets.fieldFolder')}
          <input
            list="lib-folder-list"
            value={asset.folder ?? ''}
            placeholder={t('editor.assets.unfiled')}
            onChange={(e) => void updateAsset(asset.id, { folder: e.target.value })}
          />
        </label>

        <div className="lib-field">
          <span className="lib-field-label">{t('editor.assets.fieldTags')}</span>
          <div className="lib-tags">
            {(asset.tags ?? []).map((tag) => (
              <button
                key={tag}
                className="lib-tag"
                title={t('editor.assets.removeTag')}
                onClick={() =>
                  void updateAsset(asset.id, {
                    tags: (asset.tags ?? []).filter((existing) => existing !== tag),
                  })
                }
              >
                {tag} ✕
              </button>
            ))}
          </div>
          <input
            list="lib-tag-list"
            value={tagDraft}
            placeholder={t('editor.assets.addTag')}
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
            {suggestions.map((tag) => <option key={tag} value={tag} />)}
          </datalist>
        </div>

        <label>
          {t('editor.assets.fieldState')}
          <select
            value={asset.state ?? 'draft'}
            onChange={(e) => void updateAsset(asset.id, { state: e.target.value as AssetRef['state'] })}
          >
            {STATES.map((s) => (
              <option key={s} value={s}>{t('editor.assets.stateName', { state: s })}</option>
            ))}
          </select>
        </label>

        <label>
          {t('editor.assets.fieldSource')}
          <input
            value={asset.source ?? ''}
            placeholder={t('editor.assets.sourcePlaceholder')}
            onChange={(e) => void updateAsset(asset.id, { source: e.target.value })}
          />
        </label>

        <label>
          {t('editor.assets.fieldUsage')}
          <select
            value={asset.usage ?? 'unrestricted'}
            onChange={(e) => void updateAsset(asset.id, { usage: e.target.value as AssetRef['usage'] })}
          >
            {USAGES.map((u) => (
              <option key={u} value={u}>{t('editor.assets.usageName', { usage: u })}</option>
            ))}
          </select>
        </label>

        <label>
          {t('editor.assets.fieldExpires')}
          <input
            type="date"
            value={dateValue(asset.expiresAt)}
            // An emptied date field clears the license rather than storing "".
            onChange={(e) => void updateAsset(asset.id, { expiresAt: e.target.value || null })}
          />
        </label>
        {isExpired(asset) && (
          <p className="lib-warn">
            {t('editor.assets.expiredWarning', { date: dateValue(asset.expiresAt) })}
          </p>
        )}

        {/* Derived facts, shown but not editable — they describe the bytes. */}
        <dl className="lib-tech">
          <dt>{t('editor.assets.techFile')}</dt><dd>{asset.originalName ?? asset.path}</dd>
          <dt>{t('editor.assets.techKind')}</dt>
          <dd>{t('editor.assets.kindName', { kind: asset.kind })}</dd>
          {asset.width !== undefined && (
            <><dt>{t('editor.assets.techSize')}</dt>
              <dd>{t('editor.assets.dimensions', { width: asset.width, height: asset.height ?? '' })}</dd></>
          )}
          {asset.duration !== undefined && (
            <><dt>{t('editor.assets.techDuration')}</dt><dd>{formatDuration(asset.duration)}</dd></>
          )}
          {asset.codec && (<><dt>{t('editor.assets.techCodec')}</dt><dd>{asset.codec}</dd></>)}
          {asset.hasAlpha !== undefined && (
            <><dt>{t('editor.assets.techAlpha')}</dt>
              <dd>{t(asset.hasAlpha ? 'editor.assets.yes' : 'editor.assets.no')}</dd></>
          )}
          <dt>{t('editor.assets.techBytes')}</dt><dd>{formatBytes(asset.bytes, t, locale)}</dd>
          {asset.addedAt && (<><dt>{t('editor.assets.techAdded')}</dt><dd>{dateValue(asset.addedAt)}</dd></>)}
          <dt>{t('editor.assets.techPath')}</dt>
          <dd>
            <button
              className="linkish"
              title={t('editor.assets.copyPath')}
              onClick={() => void navigator.clipboard?.writeText(asset.path)}
            >
              {asset.path} ⧉
            </button>
          </dd>
        </dl>

        <div className="lib-usage">
          <h4>{t('editor.assets.usedBy')}</h4>
          {usage === null ? (
            <p className="hint">{t('editor.assets.checking')}</p>
          ) : usage.length === 0 ? (
            <p className="hint">{t('editor.assets.noUsage')}</p>
          ) : (
            <ul>
              {usage.map((u) => (
                <li key={u.compositionId}>
                  <strong>{u.compositionName}</strong>
                  <span className="hint">
                    {' '}
                    {t('editor.assets.usageLayers', {
                      layers: u.references.map((r) => r.layerName ?? r.layerId).join(', '),
                      mask: u.references.some((r) => r.via === 'mask') ? 'yes' : 'no',
                    })}
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
                ? t('editor.assets.deleteConfirmUsed', { count: usage.length })
                : t('editor.assets.deleteConfirm')}
            </p>
            <button className="danger" onClick={() => { void removeAsset(asset.id); onClose(); }}>
              {t('editor.bin.delete')}
            </button>
            <button onClick={() => setConfirming(false)}>{t('editor.upload.cancel')}</button>
          </div>
        ) : (
          <button className="lib-delete" onClick={() => setConfirming(true)}>
            {t('editor.assets.deleteAsset')}
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
  const t = useT();
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
        <strong>{t('editor.assets.bulkSelected', { count })}</strong>
        <button className="lib-close" onClick={onDone} title={t('editor.assets.clearSelection')}>✕</button>
      </header>

      <div className="lib-detail-body">
        <label>
          {t('editor.assets.moveToFolder')}
          <span className="lib-inline">
            <input
              list="lib-folder-list"
              value={folder}
              placeholder={t('editor.assets.folderName')}
              onChange={(e) => setFolder(e.target.value)}
            />
            <button
              disabled={!folder.trim()}
              onClick={() => { void updateSelectedAssets({ folder }); setFolder(''); }}
            >
              {t('editor.assets.set')}
            </button>
          </span>
        </label>

        <div className="lib-field">
          <span className="lib-field-label">{t('editor.assets.addTagToAll')}</span>
          <span className="lib-inline">
            <input
              list="lib-tag-list-bulk"
              value={tag}
              placeholder={t('editor.assets.tagPlaceholder')}
              onChange={(e) => setTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTagToAll(tag); } }}
            />
            <button disabled={!tag.trim()} onClick={() => addTagToAll(tag)}>
              {t('editor.assets.add')}
            </button>
          </span>
          <datalist id="lib-tag-list-bulk">
            {vocabulary.map((value) => <option key={value} value={value} />)}
          </datalist>
        </div>

        <label>
          {t('editor.assets.setState')}
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) void updateSelectedAssets({ state: e.target.value as AssetRef['state'] });
              e.target.value = '';
            }}
          >
            <option value="">{t('editor.assets.choose')}</option>
            {STATES.map((s) => (
              <option key={s} value={s}>{t('editor.assets.stateName', { state: s })}</option>
            ))}
          </select>
        </label>

        <label>
          {t('editor.assets.setUsage')}
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) void updateSelectedAssets({ usage: e.target.value as AssetRef['usage'] });
              e.target.value = '';
            }}
          >
            <option value="">{t('editor.assets.choose')}</option>
            {USAGES.map((u) => (
              <option key={u} value={u}>{t('editor.assets.usageName', { usage: u })}</option>
            ))}
          </select>
        </label>

        <p className="hint">{t('editor.assets.bulkDeleteNote')}</p>
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
