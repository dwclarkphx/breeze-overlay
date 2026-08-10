// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Editor store.
 *
 * Zustand over Redux, deliberately: a document editor needs
 * one mutable-feeling document plus a command layer, not a global action bus.
 * Every document mutation goes through `run()` so nothing can bypass history.
 */

import { create } from 'zustand';
import {
  createComposition,
  createLayer,
  findNameCollisions,
  rewriteAssetReferences,
  type AnimatableProp,
  type AssetEdit,
  type AssetFilter,
  type AssetNameCollision,
  type AssetRef,
  type AssetUsage,
  type Composition,
  type DataColumn,
  type DataSet,
  type Layer,
  type LayerType,
  type Project,
} from '@breeze/schema';

import {
  api,
  ApiError,
  type DataSourceSummary,
  type MediaCapabilities,
  type TranscodeJob,
  type ValidationIssue,
} from '../api/client.js';
import { applyCommand, findCellOwner, findLayer, type Command } from './commands.js';
import {
  canRedo,
  canUndo,
  emptyHistory,
  pushCommand,
  redo as redoHistory,
  redoLabel,
  undo as undoHistory,
  undoLabel,
  type HistoryState,
} from './history.js';

/**
 * Rows pulled into the editor per source for the stage preview.
 *
 * Generous, because the preview should show what will actually go to air, and
 * bounded, because a source can grow without limit and this arrives on every
 * project load. A table paging 10 rows at a time and a ticker crawling 5
 * headlines are the realistic consumers; 500 is well past both.
 */
const PREVIEW_ROW_LIMIT = 500;

/**
 * Have the rows changed?
 *
 * Compares the server's `revision` where both sides have one — it is already a
 * content hash, computed once, and is exactly the "did this actually change"
 * signal. Falls back to a structural compare only for sources that have never
 * been ingested (a brand-new manual table has no revision yet).
 */
function sameDatasets(a: Record<string, DataSet>, b: Record<string, DataSet>): boolean {
  const ids = Object.keys(b);
  if (ids.length !== Object.keys(a).length) return false;

  return ids.every((id) => {
    const before = a[id];
    const after = b[id];
    if (!before) return false;
    if (before.revision !== undefined && after?.revision !== undefined) {
      return before.revision === after.revision;
    }
    return JSON.stringify(before.rows) === JSON.stringify(after?.rows);
  });
}

export interface KeyframeRef {
  layerId: string;
  prop: AnimatableProp;
  time: number;
}

/** A drop waiting on a replace-or-keep-both decision. */
export interface PendingUpload {
  /** Every file in the drop, colliding or not. */
  files: File[];
  collisions: AssetNameCollision[];
}

/** What one Replace did, in terms an operator can check. */
export interface ReplaceSummary {
  name: string;
  /** How many `src` references were repointed across the project. */
  rewritten: number;
  /** The compositions those references were in, by name. */
  compositions: string[];
}

export interface EditorState {
  /* document */
  projectId: string | null;
  project: Project | null;
  composition: Composition | null;
  history: HistoryState;
  dirty: boolean;
  saving: boolean;
  issues: ValidationIssue[];
  loadError: string | null;

  /* view */
  playhead: number;
  playing: boolean;
  /**
   * Whether the preview transport pauses at STOP markers.
   *
   * Off by default: while building an animation the holds are an interruption,
   * and you want to watch the whole thing. On, the preview steps exactly as it
   * will on air.
   */
  honourHolds: boolean;
  selectedLayerIds: string[];
  selectedKeyframes: KeyframeRef[];
  clipboard: { prop: AnimatableProp; keyframes: Array<{ t: number; v: number }> } | null;

  /**
   * Measurements only the runtime can make, published by the stage after each
   * rebuild.
   *
   * Both answer questions the document cannot. How many pieces a reveal animates
   * depends on where the lines fall, which depends on the real font in the real
   * box; whether a strap overflows depends on the same measurement. The panel
   * needs them to warn an author at build time instead of leaving it to air.
   */
  textPieces: Record<string, number>;
  overflowingText: string[];
  /**
   * Table measurements, published by the stage alongside the text ones and for
   * the same reason: how many rows fit and which page is showing are facts about
   * the rendered box, not about the document.
   */
  overflowingTables: string[];
  tablePages: Record<string, { page: number; pageCount: number; rows: number }>;

  /**
   * The project's data sources, so the table properties panel can offer real
   * source ids and real column keys instead of a free-text field. Loaded with
   * the project and refreshed when the data panel saves one.
   */
  dataSources: Array<{ id: string; name: string; columns: DataColumn[] }>;

  /**
   * The rows behind those sources, keyed by source id — what the stage preview
   * feeds the runtime under `$data`.
   *
   * Separate from `dataSources` above because the two are consumed differently
   * and change on different clocks: the panels want a stable list of ids and
   * column keys to build pickers from, while the preview wants rows that move
   * whenever a poll finds something new. Keeping the rows in the same objects
   * would re-render every picker on every tick of a five-second feed.
   *
   * This is why a source-fed layer used to render its fallback while
   * authoring: the store held column *names* and nothing ever held the rows, so
   * the preview runtime was constructed with no data at all and a ticker bound
   * to a feed showed its placeholder until it went to air.
   */
  datasets: Record<string, DataSet>;
  /** Bumped whenever `datasets` changes, so the preview can re-push cheaply. */
  datasetRevision: number;

  /**
   * The project's uploaded assets, and any upload in flight.
   *
   * Held here rather than in the bin component because two other places need
   * them: the image and video property fields offer them as a picker instead of
   * a free-text path, and the layer thumbnails resolve against them. A panel
   * that owned this state would leave those reading a path the author typed and
   * hoping it exists.
   */
  assets: AssetRef[];
  /** Filename → 0..1, present only while uploading. */
  uploads: Record<string, number>;
  /** Last upload failure, shown by the bin until the next attempt. */
  uploadError: string | null;
  /**
   * A drop held at the door because some of its filenames are already in the
   * bin, waiting on the operator to say replace or keep both.
   *
   * The whole drop is parked, not just the colliding files. Uploading the
   * clean ones first would put a progress bar behind a modal and finish some
   * of a batch the operator has not agreed to yet — and if they cancel, half
   * the drop has already landed.
   */
  uploadConflicts: PendingUpload | null;
  /**
   * What the last Replace changed, for the notice the bin shows afterwards.
   *
   * Worth saying out loud: a replace can quietly rewrite layers in
   * compositions that are not on screen, and an operator who is not told that
   * has no reason to go and look at them.
   */
  lastReplace: ReplaceSummary | null;

  /**
   * The project's tag vocabulary.
   *
   * Separate from the tags currently on assets, and deliberately: a term stays
   * offered as a suggestion after the last asset using it is deleted, which is
   * what stops a bin re-fragmenting one typo at a time.
   */
  assetTags: string[];
  /**
   * How the bin is currently narrowed.
   *
   * In the store rather than the panel so it survives the panel being folded —
   * an operator who filters to `sponsors`, collapses the bin to get at the layer
   * list, and comes back should not have to filter again.
   */
  assetFilter: AssetFilter;
  /** Asset ids ticked for a bulk edit. */
  assetSelection: string[];
  /** Asset whose detail panel is open, or null. */
  assetDetail: string | null;

  /**
   * Whether this server can transcode, probed once per session.
   *
   * `null` until the answer arrives. The bin renders the Transcode control
   * differently for "we do not know yet" and "we know it cannot" — a button
   * that appears enabled and then is not is worse than one that arrives
   * disabled with a reason attached.
   */
  mediaCaps: MediaCapabilities | null;
  /** Transcode jobs for this project, polled while any is in flight. */
  transcodes: TranscodeJob[];

  /* actions */
  loadProject: (projectId: string, compositionId?: string) => Promise<void>;
  selectComposition: (compositionId: string) => void;
  run: (command: Command) => void;
  undo: () => void;
  redo: () => void;
  save: () => Promise<void>;

  setPlayhead: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  setHonourHolds: (honour: boolean) => void;
  selectLayers: (ids: string[]) => void;
  toggleLayerSelection: (id: string) => void;
  selectKeyframes: (refs: KeyframeRef[]) => void;
  addLayer: (type: LayerType) => void;
  /**
   * Add a cell to a table's row template.
   *
   * Separate from `addLayer` because the two disagree about every default. A
   * stage layer is centered on the stage and given an `in` point at the
   * playhead; a cell is positioned inside a row box a few tens of pixels tall,
   * and its time zero is its row's arrival, not the composition's — so a
   * playhead-derived `in` would silently push it past the end of a row that
   * only exists for a fraction of a second.
   */
  addCell: (tableId: string, type: LayerType, column?: string) => void;
  copySelectedKeyframes: () => void;
  pasteKeyframes: () => void;
  deleteSelectedKeyframes: () => void;
  deleteSelectedLayers: () => void;
  /**
   * Reload sources and their rows. Returns the summaries so the data panel can
   * render health from the same response rather than issuing its own — the two
   * used to poll independently every five seconds, which was one request too
   * many and gave the panel and the preview slightly different snapshots.
   */
  refreshDataSources: () => Promise<DataSourceSummary[]>;

  refreshAssets: () => Promise<void>;
  /**
   * Upload files, one request each.
   *
   * Sequential rather than parallel. Four concurrent uploads of a few hundred
   * megabytes each saturate a venue LAN and finish no sooner in total, while
   * making every individual progress bar useless — and this runs on the same
   * network the show is going out on.
   */
  uploadAssets: (files: File[]) => Promise<void>;
  /**
   * Answer the collision prompt and let the held drop go.
   *
   * `decisions` maps a lowercased filename to the asset id it should supersede,
   * or `null` for "upload as new". Names absent from the map were not colliding
   * and upload normally.
   */
  resolveUploadConflicts: (decisions: Record<string, string | null>) => Promise<void>;
  /** Abandon a held drop entirely. Nothing has been uploaded at this point. */
  cancelUploadConflicts: () => void;
  dismissLastReplace: () => void;
  removeAsset: (assetId: string) => Promise<void>;

  /** Edit one asset's descriptive, administrative or rights fields. */
  updateAsset: (assetId: string, edit: AssetEdit) => Promise<void>;
  /**
   * Apply one edit to every selected asset, in a single request.
   *
   * `addTags` merges into each asset's existing tags rather than replacing
   * them — "tag these forty as sponsors" has no single value to set.
   */
  updateSelectedAssets: (edit: AssetEdit, addTags?: string[]) => Promise<void>;

  setAssetFilter: (patch: Partial<AssetFilter>) => void;
  clearAssetFilter: () => void;
  /** Add or remove one value from a multi-valued facet. */
  toggleAssetFacet: (facet: 'kinds' | 'folders' | 'tags' | 'states', value: string) => void;

  selectAssets: (ids: string[]) => void;
  toggleAssetSelection: (id: string) => void;
  clearAssetSelection: () => void;
  openAssetDetail: (id: string | null) => void;

  /**
   * Where an asset is used, across every composition.
   *
   * Fetched on demand rather than held in state: it is only wanted at two
   * moments — opening a detail panel and confirming a delete — and caching it
   * would mean showing an operator a usage list that predates the edit they
   * just made.
   */
  fetchAssetUsage: (assetId: string) => Promise<AssetUsage[]>;

  /** Ask the server what it can do. Idempotent; the answer cannot change. */
  loadMediaCapabilities: () => Promise<void>;
  startTranscode: (assetId: string) => Promise<void>;
  cancelTranscode: (jobId: string) => Promise<void>;
  /**
   * Re-read the job list.
   *
   * Returns whether anything is still in flight, so the caller's poll can stop
   * itself rather than running a request every second for the life of the
   * session on a project nobody is transcoding.
   */
  refreshTranscodes: () => Promise<boolean>;

  /* derived */
  canUndo: () => boolean;
  canRedo: () => boolean;
  undoLabel: () => string | null;
  redoLabel: () => string | null;
  activeLayer: () => Layer | null;
  /**
   * The table owning the current selection, when a cell is selected.
   *
   * Panels branch on this rather than on `layer.cell`, which is only set once a
   * column has been chosen — a freshly added cell has no `cell` key yet and
   * would otherwise be mistaken for an ordinary layer the moment it mattered
   * most, while it is being set up.
   */
  activeCellOwner: () => Layer | null;
}

/**
 * Apply an `AssetEdit` to an asset the way the server does.
 *
 * `null` clears the key; `undefined` leaves it alone. Kept next to the store
 * rather than in the schema package because it exists purely for the optimistic
 * copy — the server computes the real answer from the same rule.
 */
function applyEdit(asset: AssetRef, edit: AssetEdit): AssetRef {
  const next: Record<string, unknown> = { ...asset };
  for (const [key, value] of Object.entries(edit)) {
    if (value === undefined) continue;
    if (value === null || value === '') delete next[key];
    else next[key] = value;
  }
  return next as unknown as AssetRef;
}

/**
 * Send a drop, one request per file, applying whatever the operator decided.
 *
 * Extracted from `uploadAssets` because two entry points reach it — a clean
 * drop that goes straight through, and a held drop released by the dialog —
 * and duplicating the loop is how the second one comes to lack the progress
 * reporting or the error handling that took a while to get right.
 */
async function runUploads(
  get: () => EditorState,
  set: (patch: Partial<EditorState>) => void,
  files: File[],
  decisions: Record<string, string | null>,
): Promise<void> {
  const { projectId } = get();
  if (!projectId) return;

  set({ uploadError: null, lastReplace: null });

  for (const file of files) {
    const replaces = decisions[file.name.trim().toLowerCase()] ?? undefined;

    set({ uploads: { ...get().uploads, [file.name]: 0 } });
    try {
      const result = await api.uploadAsset(
        projectId,
        file,
        (fraction) => {
          set({ uploads: { ...get().uploads, [file.name]: fraction } });
        },
        replaces,
      );

      if (result.replaced) {
        applyReplaceLocally(get, set, result.replaced.path, result.asset.path);
        set({
          lastReplace: {
            name: file.name,
            rewritten: result.rewritten,
            compositions: result.compositions.map((c) => c.name),
          },
        });
      }
    } catch (error) {
      // Reported and then carried on with the rest. Stopping the queue on
      // one rejected file would leave the operator re-picking the four that
      // were fine, in a hurry, before a show.
      set({
        uploadError: `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      const { [file.name]: _done, ...rest } = get().uploads;
      set({ uploads: rest });
    }
  }

  await get().refreshAssets();
}

/**
 * Repoint the copy of the document the editor is holding.
 *
 * The server has already rewritten `project.json`, so this is not what makes
 * the replacement stick — it is what stops the editor undoing it. There is no
 * autosave: the open composition may carry unsaved work, and `save()` PUTs the
 * whole composition. Left alone, the next save would write back the pre-replace
 * `src` and put the old logo on air, with nothing on screen to suggest why.
 *
 * Refetching instead would be the other way to stay in step, and it would throw
 * away whatever the operator had not saved — which is the work they are least
 * willing to lose and most likely to be in the middle of.
 *
 * `dirty` is deliberately not set. The document on disk already says this, so
 * the editor is not ahead of the server, and flagging unsaved changes for a
 * write that has happened would train an operator to save reflexively at the
 * one moment their in-memory copy is worth the least.
 */
function applyReplaceLocally(
  get: () => EditorState,
  set: (patch: Partial<EditorState>) => void,
  from: string,
  to: string,
): void {
  const { project, composition } = get();
  const patch: Partial<EditorState> = {};

  if (project) {
    let changed = false;
    const compositions = project.compositions.map((comp) => {
      const result = rewriteAssetReferences(comp.layers, from, to);
      if (result.count === 0) return comp;
      changed = true;
      return { ...comp, layers: result.layers };
    });
    if (changed) patch.project = { ...project, compositions };
  }

  if (composition) {
    const result = rewriteAssetReferences(composition.layers, from, to);
    if (result.count > 0) patch.composition = { ...composition, layers: result.layers };
  }

  if (Object.keys(patch).length > 0) set(patch);
}

export const useEditor = create<EditorState>((set, get) => ({
  projectId: null,
  project: null,
  composition: null,
  history: emptyHistory,
  dirty: false,
  saving: false,
  issues: [],
  loadError: null,

  playhead: 0,
  playing: false,
  honourHolds: false,
  selectedLayerIds: [],
  selectedKeyframes: [],
  clipboard: null,
  textPieces: {},
  overflowingText: [],
  overflowingTables: [],
  tablePages: {},
  dataSources: [],
  datasets: {},
  datasetRevision: 0,
  assets: [],
  uploads: {},
  uploadError: null,
  uploadConflicts: null,
  lastReplace: null,
  assetTags: [],
  assetFilter: {},
  assetSelection: [],
  assetDetail: null,
  mediaCaps: null,
  transcodes: [],

  async refreshAssets() {
    const { projectId } = get();
    if (!projectId) return;
    try {
      const [assets, tags] = await Promise.all([
        api.listAssets(projectId),
        // The vocabulary is a separate document from the assets and outlives
        // them, so it is a separate read. Failure is an empty suggestion list,
        // never a failed asset load.
        api.listAssetTags(projectId).catch(() => [] as string[]),
      ]);

      /*
       * Selection is pruned against what actually came back.
       *
       * A bulk edit, a delete from another tab or a refresh can retire an id
       * that is still ticked, and a selection holding ids the bin cannot show
       * turns the next bulk edit into a 404 for reasons invisible on screen.
       */
      const live = new Set(assets.map((a) => a.id));
      set({
        assets,
        assetTags: tags,
        assetSelection: get().assetSelection.filter((id) => live.has(id)),
        assetDetail: get().assetDetail && live.has(get().assetDetail!) ? get().assetDetail : null,
      });
    } catch {
      // A project saved before the asset bin existed has no assets array. An
      // empty bin, not an error banner.
      set({ assets: [] });
    }
  },

  async uploadAssets(files) {
    const { projectId, assets } = get();
    if (!projectId || files.length === 0) return;

    /*
     * Collisions are checked across the whole drop before anything is sent.
     *
     * Up front rather than per file, because the answer is almost always the
     * same for all of them — an operator re-exporting a set of corrected
     * sponsor logos means "replace" for every one — and a modal per file is
     * how a feature gets worked around. Asking first also means nothing has
     * landed if they cancel.
     */
    const collisions = findNameCollisions(assets, files.map((f) => f.name));
    if (collisions.length > 0) {
      set({ uploadConflicts: { files, collisions }, uploadError: null });
      return;
    }

    await runUploads(get, set, files, {});
  },

  async resolveUploadConflicts(decisions) {
    const pending = get().uploadConflicts;
    if (!pending) return;
    set({ uploadConflicts: null });
    await runUploads(get, set, pending.files, decisions);
  },

  cancelUploadConflicts() {
    set({ uploadConflicts: null });
  },

  dismissLastReplace() {
    set({ lastReplace: null });
  },

  async removeAsset(assetId) {
    const { projectId } = get();
    if (!projectId) return;
    try {
      await api.deleteAsset(projectId, assetId);
    } catch (error) {
      set({ uploadError: error instanceof Error ? error.message : String(error) });
    }
    await get().refreshAssets();
  },

  /*
   * `applyEdit` mirrors the server's own rule so the optimistic copy and the
   * saved one agree on what an edit *means*: `null` clears the key, `undefined`
   * leaves it alone. Spreading the edit directly would leave a literal `null`
   * sitting in an `AssetRef` field typed as optional-string, which reads as
   * "cleared" nowhere and renders as "null" in at least one place.
   */
  async updateAsset(assetId, edit) {
    const { projectId } = get();
    if (!projectId) return;

    /*
     * Applied locally first, then reconciled from the response.
     *
     * These edits are typed into a field, and a title that snaps back for the
     * duration of a round trip reads as dropped input — the operator types it
     * again. The server's copy still wins: it normalizes tags and folders, so
     * `Sponsors ` comes back as `sponsors` and the optimistic value has to be
     * replaced rather than merely confirmed.
     */
    set({
      assets: get().assets.map((a) => (a.id === assetId ? applyEdit(a, edit) : a)),
    });

    try {
      const saved = await api.updateAsset(projectId, assetId, edit);
      set({
        assets: get().assets.map((a) => (a.id === assetId ? saved : a)),
        assetTags: [...new Set([...get().assetTags, ...(saved.tags ?? [])])].sort(),
      });
    } catch (error) {
      set({ uploadError: error instanceof Error ? error.message : String(error) });
      // Re-read rather than trying to invert the optimistic edit: the server is
      // the only thing that knows what actually landed.
      await get().refreshAssets();
    }
  },

  async updateSelectedAssets(edit, addTags = []) {
    const { projectId, assetSelection } = get();
    if (!projectId || assetSelection.length === 0) return;

    try {
      const saved = await api.updateAssets(projectId, assetSelection, edit, addTags);
      const byId = new Map(saved.map((a) => [a.id, a]));
      set({
        assets: get().assets.map((a) => byId.get(a.id) ?? a),
        assetTags: [
          ...new Set([...get().assetTags, ...saved.flatMap((a) => a.tags ?? [])]),
        ].sort(),
      });
    } catch (error) {
      set({ uploadError: error instanceof Error ? error.message : String(error) });
      await get().refreshAssets();
    }
  },

  setAssetFilter(patch) {
    set({ assetFilter: { ...get().assetFilter, ...patch } });
  },

  clearAssetFilter() {
    // Sort survives a filter clear. It is a display preference, not a narrowing,
    // and resetting it would reshuffle the list the operator is looking at.
    const { sort, descending } = get().assetFilter;
    set({ assetFilter: { ...(sort ? { sort } : {}), ...(descending !== undefined ? { descending } : {}) } });
  },

  toggleAssetFacet(facet, value) {
    const current = (get().assetFilter[facet] as readonly string[] | undefined) ?? [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    set({
      assetFilter: {
        ...get().assetFilter,
        // Dropped entirely when empty, so `filterAssets` sees "no opinion"
        // rather than "match none".
        ...{ [facet]: next.length > 0 ? next : undefined },
      },
    });
  },

  selectAssets(ids) {
    set({ assetSelection: ids });
  },

  toggleAssetSelection(id) {
    const current = get().assetSelection;
    set({
      assetSelection: current.includes(id)
        ? current.filter((x) => x !== id)
        : [...current, id],
    });
  },

  clearAssetSelection() {
    set({ assetSelection: [] });
  },

  openAssetDetail(id) {
    set({ assetDetail: id });
  },

  async fetchAssetUsage(assetId) {
    const { projectId } = get();
    if (!projectId) return [];
    try {
      return await api.assetUsage(projectId, assetId);
    } catch {
      // An older server with no usage route. An empty list reads as "nothing
      // known", and the delete confirmation says as much rather than claiming
      // the asset is unused.
      return [];
    }
  },

  async loadMediaCapabilities() {
    try {
      set({ mediaCaps: await api.mediaCapabilities() });
    } catch {
      // An older server with no media routes. Treated as "cannot transcode",
      // which is true, rather than as an error worth a banner.
      set({
        mediaCaps: {
          available: false,
          version: null,
          vp9Alpha: false,
          reason: 'This server does not support transcoding.',
        },
      });
    }
  },

  async startTranscode(assetId) {
    const { projectId } = get();
    if (!projectId) return;
    try {
      await api.transcodeAsset(projectId, assetId);
      await get().refreshTranscodes();
    } catch (error) {
      set({ uploadError: error instanceof Error ? error.message : String(error) });
    }
  },

  async cancelTranscode(jobId) {
    const { projectId } = get();
    if (!projectId) return;
    try {
      await api.cancelTranscode(projectId, jobId);
    } catch {
      /* Already finished between the click and the request. The refresh below
         shows the real state, which is the answer either way. */
    }
    await get().refreshTranscodes();
  },

  async refreshTranscodes() {
    const { projectId } = get();
    if (!projectId) return false;
    try {
      const jobs = await api.listTranscodes(projectId);
      const active = jobs.some((j) => j.state === 'queued' || j.state === 'running');

      // A job that has just finished has produced a new asset, so the bin has
      // to catch up. Only on the transition, not on every poll — refreshing
      // assets every second while an encode runs is a request per second for a
      // list that cannot have changed.
      const wasActive = get().transcodes.some(
        (j) => j.state === 'queued' || j.state === 'running',
      );
      set({ transcodes: jobs });
      if (wasActive && !active) await get().refreshAssets();

      return active;
    } catch {
      return false;
    }
  },

  async refreshDataSources() {
    const { projectId } = get();
    if (!projectId) return [];
    try {
      const result = await api.listDataSources(projectId, PREVIEW_ROW_LIMIT);

      const datasets: Record<string, DataSet> = {};
      for (const source of result.sources) {
        if (source.data) datasets[source.def.id] = source.data;
      }

      /*
       * The revision only advances when the rows actually differ.
       *
       * This runs on the data panel's five-second poll, and the preview
       * rebinds on the revision — so bumping it unconditionally would rebuild
       * every table and re-queue every ticker every five seconds, on a feed
       * that had not changed. The server already suppresses no-op pushes for
       * exactly this reason; the editor has to do its own version of it because
       * it is polling rather than being pushed to.
       */
      const changed = !sameDatasets(get().datasets, datasets);

      set({
        dataSources: result.sources.map((s) => ({
          id: s.def.id,
          name: s.def.name,
          columns: s.columns,
        })),
        ...(changed
          ? { datasets, datasetRevision: get().datasetRevision + 1 }
          : {}),
      });

      return result.sources;
    } catch {
      // A project with no datasources.json is the normal case for everything
      // built before this phase — an empty list, not an error banner.
      set({ dataSources: [] });
      return [];
    }
  },

  async loadProject(projectId, compositionId) {
    try {
      const project = await api.getProject(projectId);
      const composition =
        project.compositions.find((c) => c.id === compositionId) ??
        project.compositions[0] ??
        createComposition();

      set({
        projectId,
        project,
        composition,
        history: emptyHistory,
        dirty: false,
        issues: [],
        loadError: null,
        playhead: 0,
        selectedLayerIds: [],
        selectedKeyframes: [],
      });
      await get().refreshDataSources();
      await get().refreshAssets();
      await get().loadMediaCapabilities();
      await get().refreshTranscodes();
    } catch (error) {
      set({ loadError: error instanceof Error ? error.message : String(error) });
    }
  },

  selectComposition(compositionId) {
    const { project } = get();
    const composition = project?.compositions.find((c) => c.id === compositionId);
    if (!composition) return;
    set({
      composition,
      history: emptyHistory,
      playhead: 0,
      selectedLayerIds: [],
      selectedKeyframes: [],
    });
  },

  run(command) {
    const { composition, history } = get();
    if (!composition) return;

    const result = pushCommand(composition, history, command);
    if (result.composition === composition) return;

    set({ composition: result.composition, history: result.history, dirty: true });
  },

  undo() {
    const { composition, history } = get();
    if (!composition) return;
    const result = undoHistory(composition, history);
    set({ composition: result.composition, history: result.history, dirty: true });
  },

  redo() {
    const { composition, history } = get();
    if (!composition) return;
    const result = redoHistory(composition, history);
    set({ composition: result.composition, history: result.history, dirty: true });
  },

  async save() {
    const { projectId, composition } = get();
    if (!projectId || !composition) return;

    set({ saving: true });
    try {
      const project = await api.saveComposition(projectId, composition);
      set({ project, dirty: false, issues: [], saving: false });
    } catch (error) {
      if (error instanceof ApiError && error.isValidation) {
        // Keep `dirty` true: the work is still unsaved, and clearing the flag
        // here would let the user close the tab believing it landed.
        set({ issues: error.issues, saving: false });
        return;
      }
      set({
        issues: [{ path: '/', message: error instanceof Error ? error.message : String(error) }],
        saving: false,
      });
    }
  },

  setPlayhead(time) {
    set({ playhead: Math.max(0, time) });
  },

  setPlaying(playing) {
    set({ playing });
  },

  setHonourHolds(honour) {
    set({ honourHolds: honour });
  },

  selectLayers(ids) {
    set({ selectedLayerIds: ids, selectedKeyframes: [] });
  },

  toggleLayerSelection(id) {
    const { selectedLayerIds } = get();
    set({
      selectedLayerIds: selectedLayerIds.includes(id)
        ? selectedLayerIds.filter((x) => x !== id)
        : [...selectedLayerIds, id],
    });
  },

  selectKeyframes(refs) {
    set({ selectedKeyframes: refs });
  },

  addLayer(type) {
    const { composition, playhead } = get();
    if (!composition) return;

    const layer = createLayer(type);
    // Drop new layers in the middle of the stage rather than at 0,0, where
    // they hide under the top-left corner and look like nothing happened.
    const centred: Layer = {
      ...layer,
      transform: {
        ...(layer.transform ?? {}),
        x: Math.round(composition.stage.width / 2 - (layer.size?.width ?? 0) / 2),
        y: Math.round(composition.stage.height / 2 - (layer.size?.height ?? 0) / 2),
      },
      ...(playhead > 0 ? { in: playhead } : {}),
    };

    get().run({ kind: 'addLayer', layer: centred });
    set({ selectedLayerIds: [centred.id] });
  },

  addCell(tableId, type, column) {
    const { composition } = get();
    if (!composition) return;

    const table = findLayer(composition.layers, tableId);
    if (!table || table.type !== 'table') return;

    const layer = createLayer(type);
    const cell: Layer = {
      ...layer,
      // Left edge, vertically centered in the row box. A cell inherits the
      // row's coordinate space, so the stage-centring `addLayer` applies would
      // put it hundreds of pixels below a row that is 40px tall — off its own
      // row and on top of the one several places down the table.
      transform: { ...(layer.transform ?? {}), x: 0, y: 0 },
      size: { width: 200, height: table.row.height },
      ...(column !== undefined ? { cell: column } : {}),
    };

    get().run({ kind: 'addLayer', layer: cell, parentId: tableId });
    set({ selectedLayerIds: [cell.id] });
  },

  copySelectedKeyframes() {
    const { composition, selectedKeyframes } = get();
    if (!composition || selectedKeyframes.length === 0) return;

    // One track at a time: pasting a multi-track selection into a single lane
    // has no obvious meaning, so the copy is scoped to the first property hit.
    const prop = selectedKeyframes[0]!.prop;
    const keyframes = selectedKeyframes
      .filter((ref) => ref.prop === prop)
      .map((ref) => {
        const layer = findLayer(composition.layers, ref.layerId);
        const kf = layer?.keyframes?.[ref.prop]?.find((k) => Math.abs(k.t - ref.time) < 1e-6);
        return kf ? { t: kf.t, v: kf.v, ...(kf.ease !== undefined ? { ease: kf.ease } : {}) } : null;
      })
      .filter((kf): kf is { t: number; v: number } => kf !== null)
      .sort((a, b) => a.t - b.t);

    if (keyframes.length) set({ clipboard: { prop, keyframes } });
  },

  pasteKeyframes() {
    const { clipboard, selectedLayerIds, playhead } = get();
    const layerId = selectedLayerIds[0];
    if (!clipboard || !layerId) return;

    get().run({
      kind: 'pasteKeyframes',
      layerId,
      prop: clipboard.prop,
      keyframes: clipboard.keyframes,
      atTime: playhead,
    });
  },

  deleteSelectedKeyframes() {
    const { selectedKeyframes } = get();
    if (selectedKeyframes.length === 0) return;
    get().run({ kind: 'deleteKeyframes', targets: selectedKeyframes });
    set({ selectedKeyframes: [] });
  },

  deleteSelectedLayers() {
    const { selectedLayerIds } = get();
    if (selectedLayerIds.length === 0) return;
    get().run({ kind: 'deleteLayers', layerIds: selectedLayerIds });
    set({ selectedLayerIds: [] });
  },

  canUndo: () => canUndo(get().history),
  canRedo: () => canRedo(get().history),
  undoLabel: () => undoLabel(get().history),
  redoLabel: () => redoLabel(get().history),

  activeLayer() {
    const { composition, selectedLayerIds } = get();
    const id = selectedLayerIds[0];
    if (!composition || !id) return null;
    return findLayer(composition.layers, id) ?? null;
  },

  activeCellOwner() {
    const { composition, selectedLayerIds } = get();
    const id = selectedLayerIds[0];
    if (!composition || !id) return null;
    return findCellOwner(composition.layers, id) ?? null;
  },
}));

/** Convenience for components that only need the current composition. */
export function useComposition(): Composition | null {
  return useEditor((s) => s.composition);
}

export { applyCommand };
