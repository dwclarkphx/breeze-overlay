// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Asset bin — the project's uploaded images, videos and fonts.
 *
 * Accepted as part of Phase 2 and never built: until now every asset was a
 * path typed into a text field, with the file copied into the project directory
 * by hand. That works for one demo on one machine and fails everywhere else —
 * an operator has no shell on the graphics box, and a typo produces a layer
 * that renders nothing with no indication why.
 *
 * Drag-and-drop as well as a file picker, because the realistic gesture is
 * dragging a logo out of a folder, and because a picker alone means a dialog
 * between the operator and every single file.
 */

import { useEffect, useRef, useState, type DragEvent, type JSX } from 'react';
import { referencedAssets, type AssetRef } from '@breeze/schema';

import { useEditor } from '../state/store.js';
import { AssetFolderList, AssetLibrary } from './AssetLibrary.js';
import { UploadConflictDialog } from './UploadConflictDialog.js';

/** Bytes as something a person reads at a glance, not a precise figure. */
function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/*
 * `referencedAssets` moved to `@breeze/schema` in Phase 7.5. The server now asks
 * the same question across every composition in a project — for honest delete
 * confirmation, composition-scoped export and expiry warnings — and two walks
 * would have diverged on the next layer type that grows a `src`.
 */

const KIND_GLYPH: Record<AssetRef['kind'], string> = {
  image: '🖼',
  video: '▶',
  font: 'Ag',
  audio: '♪',
  other: '◆',
};

export function AssetBin(): JSX.Element {
  const projectId = useEditor((s) => s.projectId);
  const assets = useEditor((s) => s.assets);
  const uploads = useEditor((s) => s.uploads);
  const uploadError = useEditor((s) => s.uploadError);
  const uploadAssets = useEditor((s) => s.uploadAssets);
  const lastReplace = useEditor((s) => s.lastReplace);
  const dismissLastReplace = useEditor((s) => s.dismissLastReplace);
  const removeAsset = useEditor((s) => s.removeAsset);
  const composition = useEditor((s) => s.composition);
  const mediaCaps = useEditor((s) => s.mediaCaps);
  const transcodes = useEditor((s) => s.transcodes);
  const startTranscode = useEditor((s) => s.startTranscode);
  const cancelTranscode = useEditor((s) => s.cancelTranscode);
  const refreshTranscodes = useEditor((s) => s.refreshTranscodes);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  // Folded by default. An author reaches for assets a few times per session and
  // for the layer list constantly, so the column's default should favor the
  // list — and an empty bin folded still says how to fill it.
  const [collapsed, setCollapsed] = useState(true);

  const assetBase = projectId ? `/assets/${encodeURIComponent(projectId)}` : '';
  const inFlight = Object.entries(uploads);

  /*
   * Which asset paths the open composition mentions.
   *
   * Only this composition, and deliberately so — the project may hold others,
   * and one of them may be open in another tab with unsaved changes. So this is
   * framed as "in use here", not as "safe to delete": a claim the editor can
   * actually stand behind. Delete still asks.
   */
  const referenced = new Set(composition ? referencedAssets(composition.layers) : []);

  /*
   * Poll only while something is actually encoding.
   *
   * A transcode is minutes long and has no push channel, so the progress bar
   * has to ask. `refreshTranscodes` returns whether anything is still in
   * flight, which is what stops this becoming a request per second for the rest
   * of the session on a project nobody is transcoding.
   */
  const active = transcodes.some((j) => j.state === 'queued' || j.state === 'running');
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refreshTranscodes(), 1000);
    return () => clearInterval(timer);
  }, [active, refreshTranscodes]);

  /** The in-flight or failed job for a source asset, if any. */
  const jobFor = (assetId: string) =>
    transcodes.find(
      (j) =>
        j.sourceAssetId === assetId &&
        (j.state === 'queued' || j.state === 'running' || j.state === 'failed'),
    );

  /*
   * A video is worth transcoding unless it is already in a format a browser
   * source can decode with transparency.
   *
   * WebM is the output format, so offering to transcode one is offering a
   * no-op that costs minutes. MP4 is deliberately *not* excluded: it plays, but
   * it cannot carry an alpha channel, so a stinger delivered as MP4 still needs
   * converting and the operator may well not know that.
   */
  const worthTranscoding = (asset: AssetRef) =>
    asset.kind === 'video' && !asset.path.toLowerCase().endsWith('.webm');

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) void uploadAssets(files);
  };

  return (
    /*
      Collapsible, on the same mechanism as the data panel below which it sits.

      Not decoration: the left column now stacks three panels, and `.panel` sets
      `height: 100%`, which for a `flex: 0 0 auto` item in a column becomes its
      flex-basis. Two capped panels under the layer list can between them leave
      it almost nothing, so both lower panels have to be foldable or the column
      is worse for having gained the bin.

      Kept open while an upload is running, whatever the toggle says — the
      progress bars are the only feedback there is, and folding them away mid
      transfer is how an operator concludes it has hung.
    */
    <div
      className="panel asset-bin"
      data-collapsed={collapsed && inFlight.length === 0 ? '1' : undefined}
    >
      <div className="panel-header">
        <button className="panel-toggle" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? '▸' : '▾'} Assets
          {collapsed && assets.length > 0 && <span className="panel-sub"> ({assets.length})</span>}
        </button>
        <span className="panel-actions">
          {/*
            Two entry points, deliberately.

            An author who knows exactly which file they want should not have to
            open a modal to get at a file picker — that is the fast path and it
            stays one click. The library is for the other case: browsing,
            filing, tagging and finding, none of which fit in a column three
            panels deep without making the layer list unusable.
          */}
          <button onClick={() => inputRef.current?.click()} disabled={!projectId}>+ Upload…</button>
          <button
            className="asset-browse"
            onClick={() => setLibraryOpen(true)}
            disabled={!projectId}
            title="Open the asset library"
          >⤢ Library</button>
        </span>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length) void uploadAssets(files);
          // Cleared so re-picking the same file fires a change event. Without
          // this, a failed upload cannot be retried by choosing the same file
          // again, which is the first thing anyone tries.
          e.target.value = '';
        }}
      />

      {/*
        The drop target stays mounted while collapsed but the list does not.

        Dropping a file on the folded bar is a gesture worth honouring — it is
        how anyone would expect this to work — and it costs one always-rendered
        div. The list is what makes the panel tall, so that is what folds.
      */}
      <div
        className={`asset-drop${dragOver ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        hidden={collapsed && inFlight.length === 0}
      >
        {inFlight.length > 0 ? (
          <ul className="asset-uploads">
            {inFlight.map(([name, fraction]) => (
              <li key={name}>
                <span className="asset-upload-name">{name}</span>
                <span className="asset-progress">
                  <span className="asset-progress-fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
                </span>
                <span className="asset-upload-pct">{Math.round(fraction * 100)}%</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Drop files here, or use Upload.</p>
        )}
      </div>

      {/* An error outlives the collapse: folding the panel must not be a way to
          make a failed upload disappear without it having been read. */}
      {uploadError && <p className="asset-error">{uploadError}</p>}

      {/*
        What the last replace actually did, named.

        A replace can rewrite `src` in compositions that are not open, which is
        the point of it and also the part an operator has no way to observe. A
        count with the composition names attached is the difference between
        trusting the feature and opening all six to check. Dismissed by hand,
        not on a timer — the one worth reading is the one that mentions a
        composition the operator did not expect.
      */}
      {lastReplace && (
        <p className="asset-replaced">
          <span>
            Replaced <strong>{lastReplace.name}</strong>
            {lastReplace.rewritten === 0
              ? ' — no layers referenced it.'
              : ` — repointed ${lastReplace.rewritten} layer${lastReplace.rewritten === 1 ? '' : 's'} in ${lastReplace.compositions.join(', ')}.`}
          </span>
          <button onClick={dismissLastReplace} title="Dismiss">✕</button>
        </p>
      )}

      {!collapsed && (
      <ul className="asset-list">
        {assets.length === 0 && inFlight.length === 0 && (
          <li className="hint asset-empty">
            No assets yet. Images, videos and fonts uploaded here are available to
            every composition in this project.
          </li>
        )}

        {assets.map((asset) => {
          const inUse = referenced.has(asset.path);
          const job = jobFor(asset.id);
          return (
            <li key={asset.id} className="asset-row" title={`${asset.originalName ?? asset.path}\n${asset.path}`}>
              <span className="asset-thumb">
                {asset.kind === 'image'
                  ? <img src={`${assetBase}/${asset.path.replace(/^assets\//, '')}`} alt="" />
                  : <span className="asset-glyph">{KIND_GLYPH[asset.kind]}</span>}
              </span>

              <span className="asset-meta">
                <span className="asset-name">{asset.originalName ?? asset.path}</span>

                {/*
                  While a job is attached, its status *replaces* the size line
                  rather than adding to it. The rows are a fixed height, so a
                  third line would overflow — and the kind and byte count are
                  the least interesting facts about this file for as long as it
                  is encoding.
                */}
                {job?.state === 'running' ? (
                  <span className="asset-sub asset-job">
                    <span className="asset-progress">
                      <span
                        className="asset-progress-fill"
                        // A null progress means the duration could not be read.
                        // A dimmed full bar is honest about not knowing; one
                        // sitting at 0% for four minutes reads as a hang.
                        style={
                          job.progress === null
                            ? { width: '100%', opacity: 0.35 }
                            : { width: `${Math.round(job.progress * 100)}%` }
                        }
                      />
                    </span>
                    {job.progress === null ? 'encoding…' : `${Math.round(job.progress * 100)}%`}
                  </span>
                ) : job?.state === 'queued' ? (
                  <span className="asset-sub asset-job">queued…</span>
                ) : job?.state === 'failed' ? (
                  <span className="asset-sub asset-job failed" title={job.error}>
                    failed — {job.error}
                  </span>
                ) : (
                  <span className="asset-sub">
                    {asset.kind} · {formatBytes(asset.bytes)}
                    {inUse && <span className="asset-inuse"> · in use</span>}
                    {/*
                      Marked rather than hidden. Retiring became routine when
                      Replace shipped, and a superseded row that looks exactly
                      like a live one is the same confusion Replace exists to
                      end. Hiding it would be worse: the whole reason the file
                      is kept is that an operator may need to go and find it.
                    */}
                    {asset.state === 'retired' && (
                      <span className="asset-retired"> · retired</span>
                    )}
                  </span>
                )}
              </span>

              {/*
                Transcode, on video sources that are not already WebM.

                Disabled with the server's own reason as the tooltip when ffmpeg
                is missing, rather than hidden: a hidden control teaches nobody
                that transcoding exists, and the reason string is what turns a
                greyed-out button into an install.
              */}
              {worthTranscoding(asset) && (
                job?.state === 'running' || job?.state === 'queued' ? (
                  <button
                    className="asset-transcode"
                    title="Cancel this transcode"
                    onClick={() => void cancelTranscode(job.id)}
                  >✕</button>
                ) : (
                  <button
                    className="asset-transcode"
                    disabled={!mediaCaps?.available}
                    title={
                      mediaCaps === null
                        ? 'Checking whether this server can transcode…'
                        : mediaCaps.available
                          ? 'Transcode to WebM with alpha, for use as a stinger'
                          : (mediaCaps.reason ?? 'Transcoding is unavailable on this server')
                    }
                    onClick={() => void startTranscode(asset.id)}
                  >⇄</button>
                )
              )}

              {/*
                The path, copyable. Every layer still refers to an asset by its
                `src` string, so until the property fields become pickers this
                is the bridge — and it stays useful afterwards for the JSON and
                for a binding's default value.
              */}
              <button
                className="asset-copy"
                title={`Copy path — ${asset.path}`}
                onClick={() => void navigator.clipboard?.writeText(asset.path)}
              >⧉</button>

              {confirming === asset.id ? (
                <span className="asset-confirm">
                  <button
                    className="danger"
                    onClick={() => { void removeAsset(asset.id); setConfirming(null); }}
                  >Delete</button>
                  <button onClick={() => setConfirming(null)}>Cancel</button>
                </span>
              ) : (
                <button
                  className="asset-delete"
                  title={inUse ? 'Delete — this file is used by the open composition' : 'Delete'}
                  onClick={() => setConfirming(asset.id)}
                >🗑</button>
              )}
            </li>
          );
        })}
      </ul>
      )}

      {/*
        Rendered inside the panel but positioned `fixed`, so it escapes the
        column without needing a portal. A portal would also work and would cost
        a second React root to keep in step with this one's state — which is all
        in the store anyway, so there is nothing a portal would buy.
      */}
      {libraryOpen && (
        <>
          <AssetLibrary onClose={() => setLibraryOpen(false)} />
          <AssetFolderList />
        </>
      )}

      {/*
        Mounted here rather than beside the library, and unconditionally.

        A drop can arrive from either place — the docked bin or the library
        modal — and the state that drives it is in the store, so one instance
        serves both. Rendering it inside the library instead would mean a
        conflict raised from the docked bin had nowhere to appear.
      */}
      <UploadConflictDialog />
    </div>
  );
}
