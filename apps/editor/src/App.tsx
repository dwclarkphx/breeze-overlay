// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { useEffect, useState, type JSX } from 'react';

/**
 * Substituted by Vite's `define` at build time. The `typeof` guard is for the
 * test environment, which runs the sources through Vitest's own config where no
 * define is configured — without it every component test that mounts the app
 * shell would throw on an undeclared identifier.
 */
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

import { api, playUrl, type ProjectSummary } from './api/client.js';
import { useEditor } from './state/store.js';
import { useHubPresence } from './state/presence.js';
import { AssetBin } from './components/AssetBin.js';
import { DataPanel } from './components/DataPanel.js';
import {
  DeleteProjectDialog,
  DeleteSceneDialog,
  NewProjectDialog,
  NewSceneDialog,
} from './components/ProjectDialogs.js';
import { LayersPanel } from './components/LayersPanel.js';
import { PropertiesPanel } from './components/PropertiesPanel.js';
import { Splitter } from './components/Splitter.js';
import { StageViewport } from './components/StageViewport.js';
import { Timeline } from './components/Timeline.js';
import {
  DEFAULT_LAYOUT,
  clampLayout,
  clampPanel,
  loadLayout,
  saveLayout,
  type LayoutSizes,
  type PanelKey,
} from './state/layout.js';

/**
 * Sentinel values for the actions that ride at the bottom of the two dropdowns.
 *
 * Prefixed so they cannot collide with a project or composition id: ids are
 * generated from `makeKeyedId`, which produces no leading underscores.
 */
const NEW_PROJECT = '__breeze-new-project__';
const DELETE_PROJECT = '__breeze-delete-project__';
const NEW_SCENE = '__breeze-new-scene__';
const DELETE_SCENE = '__breeze-delete-scene__';

/** Which modal, if any, the app bar has open. */
type Dialog = 'new-project' | 'delete-project' | 'new-scene' | 'delete-scene' | null;

export function App(): JSX.Element {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const projectId = useEditor((s) => s.projectId);
  const project = useEditor((s) => s.project);
  const composition = useEditor((s) => s.composition);
  const dirty = useEditor((s) => s.dirty);
  const saving = useEditor((s) => s.saving);
  const issues = useEditor((s) => s.issues);
  const loadError = useEditor((s) => s.loadError);
  const loadProject = useEditor((s) => s.loadProject);
  const selectComposition = useEditor((s) => s.selectComposition);
  const save = useEditor((s) => s.save);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const undoDepth = useEditor((s) => s.history.past.length);
  const redoDepth = useEditor((s) => s.history.future.length);
  const pendingUndo = useEditor((s) => s.history.past[s.history.past.length - 1]?.label ?? null);
  const undoTitle = pendingUndo ? `Undo ${pendingUndo} (Ctrl+Z)` : 'Ctrl+Z';
  /*
   * The last few undo labels, for diagnosis. A drag that produces twenty
   * entries instead of one has two very different explanations — the coalescing
   * window is being missed, or some other command is landing between them and
   * breaking adjacency — and a depth alone cannot tell them apart.
   */
  const recentUndo = useEditor((s) =>
    s.history.past.slice(-6).map((e) => e.label).join(' | '),
  );

  /*
   * Panel sizes.
   *
   * Read from storage once, in the initializer rather than an effect, so the
   * editor never paints the default layout and then jump to the saved one.
   */
  const [layout, setLayout] = useState<LayoutSizes>(() => loadLayout());

  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

  const resize = (key: PanelKey, next: number) =>
    setLayout((current) => ({
      ...current,
      [key]: clampPanel(
        key,
        next,
        key === 'timeline' ? window.innerHeight : window.innerWidth,
      ),
    }));

  const resetPanel = (key: PanelKey) =>
    setLayout((current) => ({ ...current, [key]: DEFAULT_LAYOUT[key] }));

  /*
   * Re-clamp when the window changes. A layout saved on a wide monitor and
   * reopened on a laptop would otherwise leave the two side panels occupying
   * most of the width, with the stage squeezed to a sliver.
   */
  useEffect(() => {
    const onResize = () =>
      setLayout((current) =>
        clampLayout(current, { width: window.innerWidth, height: window.innerHeight }),
      );
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    void api.listProjects().then((list) => {
      setProjects(list);
      const first = list[0];
      if (first) void loadProject(first.id);
    });
  }, [loadProject]);

  /**
   * Re-read the project list and open one.
   *
   * Called after a create or a delete, both of which change what the dropdown
   * should contain *and* which project is loaded. Doing it in one place keeps
   * those two from drifting — a deleted project that stays in the list until
   * the next reload is a menu entry that 404s.
   */
  const refreshProjects = async (open?: string): Promise<void> => {
    const list = await api.listProjects();
    setProjects(list);
    const target = open ?? list[0]?.id;
    if (target) await loadProject(target);
  };

  /*
   * The two dropdowns carry actions as well as items. A `<select>` is not a
   * menu, and this is a mild abuse of one — but it puts "new project" and
   * "delete project" on the control that already names the project, rather than
   * behind a second widget in an app bar that is full. Every action opens a
   * modal, so an arrow key landing on one is not destructive: nothing happens
   * until something is clicked or typed.
   */
  const onProjectSelect = (value: string): void => {
    if (value === NEW_PROJECT) { setDialog('new-project'); return; }
    if (value === DELETE_PROJECT) { setDialog('delete-project'); return; }
    void loadProject(value);
  };

  const onSceneSelect = (value: string): void => {
    if (value === NEW_SCENE) { setDialog('new-scene'); return; }
    if (value === DELETE_SCENE) { setDialog('delete-scene'); return; }
    selectComposition(value);
  };

  const projectName = projects.find((p) => p.id === projectId)?.name ?? project?.name ?? '';
  const sceneCount = project?.compositions.length ?? 0;

  /*
   * Register on the hub so the portal's status strip can count this window.
   * Send-only — see `useHubPresence`. Null until a project is loaded, because
   * there is no channel to claim before then.
   */
  useHubPresence(projectId && composition ? `${projectId}/${composition.id}` : null);

  /* Keyboard shortcuts. Deliberately ignored while typing in a field. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); return; }

      if (typing) return;

      const state = useEditor.getState();
      if (mod && e.key.toLowerCase() === 'c') { state.copySelectedKeyframes(); return; }
      if (mod && e.key.toLowerCase() === 'v') { state.pasteKeyframes(); return; }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (state.selectedKeyframes.length) state.deleteSelectedKeyframes();
        else state.deleteSelectedLayers();
        return;
      }
      if (e.key === ' ') { e.preventDefault(); state.setPlaying(!state.playing); return; }
      if (e.key === 'Home') { state.setPlayhead(0); return; }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, save]);

  // Losing unsaved work to a stray tab close is unacceptable in a tool people
  // use minutes before going on air.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  return (
    <div className="app">
      <header className="app-bar">
        {/*
          The version sits with the brand rather than in an About box. It is the
          first thing anyone is asked for when a graphic misbehaves, and the
          editor is the window that is already open.
        */}
        <strong className="brand">
          Breeze <span className="brand-version" title="Breeze Overlay version">{APP_VERSION}</span>
        </strong>

        {/*
          `value` stays bound to the loaded project, so choosing an action and
          cancelling the dialog snaps the label back on the next render — the
          select never sits there reading "Delete project…".
        */}
        <select
          value={projectId ?? ''}
          title="Project"
          onChange={(e) => onProjectSelect(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
          <option disabled>──────────</option>
          <option value={NEW_PROJECT}>+ New project…</option>
          {projectId && <option value={DELETE_PROJECT}>Delete project…</option>}
        </select>

        <select
          value={composition?.id ?? ''}
          title="Scene"
          onChange={(e) => onSceneSelect(e.target.value)}
        >
          {(project?.compositions ?? []).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
          {projectId && <option disabled>──────────</option>}
          {projectId && <option value={NEW_SCENE}>+ New scene…</option>}
          {/*
            Delete is only offered once the scene exists on the server. A
            brand-new project holds an unsaved composition from
            `createComposition()`, and a DELETE for an id the server has never
            seen is a 404 dressed up as a failed delete. New scene has no such
            constraint, which is why it sits outside this guard.
          */}
          {composition && project?.compositions.some((c) => c.id === composition.id) && (
            <option value={DELETE_SCENE}>Delete scene…</option>
          )}
        </select>

        {/*
          The URL keys, visible and copyable.

          These are what appear in every /play and /api/control address, so an
          operator writing a Stream Deck button needs them at a glance — and
          reading them off the browser's address bar means first navigating
          somewhere they did not want to go. Not editable: the key is the id,
          and the id is already inside every browser source pasted into OBS.
        */}
        {projectId && composition && (
          <code
            className="url-keys"
            title="URL keys for this project and composition — click to copy. Set when created; not renameable."
            onClick={() => void navigator.clipboard?.writeText(`${projectId}/${composition.id}`)}
          >
            {projectId}/{composition.id}
          </code>
        )}

        <button onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>

        {/*
          `data-undo-depth` exposes how many undo steps exist. "A drag is one
          undo step" is a statement about history structure, and asserting it
          through a side effect — does one click restore the old value — cannot
          distinguish "coalescing broke" from "undo restored the wrong
          snapshot". This makes the invariant directly observable.
        */}
        <button
          onClick={undo}
          title={undoTitle}
          data-undo-depth={undoDepth}
          data-undo-labels={recentUndo}
        >Undo</button>
        <button onClick={redo} title="Ctrl+Shift+Z" data-redo-depth={redoDepth}>Redo</button>

        {projectId && composition && (
          <a
            className="output-link"
            href={playUrl(projectId, composition.id)}
            target="_blank"
            rel="noreferrer"
            title="Paste this URL into a vMix Web Browser input or an OBS Browser Source"
          >
            Output URL ↗
          </a>
        )}

        <span className="spacer" />
        {dirty && <span className="dirty-dot" title="Unsaved changes">●</span>}
      </header>

      {loadError && <div className="banner error">Could not load project: {loadError}</div>}

      {issues.length > 0 && (
        <div className="banner error">
          <strong>Not saved — {issues.length} validation problem{issues.length > 1 ? 's' : ''}:</strong>
          <ul>
            {issues.slice(0, 6).map((issue, i) => (
              <li key={i}><code>{issue.path}</code> {issue.message}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="app-body">
        {/*
          Data sources sit under the layers, in the same column. They are the
          project's inputs and the layers are what consume them, so reading down
          the column follows the data — and it needs no new layout key, which
          keeps saved panel sizes from older sessions valid.
        */}
        {/*
          Assets go below the data sources, for the same reason the data panel
          sits below the layers: this column reads as "what this project is made
          of", inputs after the things that consume them. Also no new layout
          key, so panel sizes saved by older sessions stay valid.
        */}
        <aside className="left" style={{ width: layout.left }}>
          <LayersPanel />
          <DataPanel />
          <AssetBin />
        </aside>

        <Splitter
          axis="x"
          value={layout.left}
          onChange={(v) => resize('left', v)}
          onReset={() => resetPanel('left')}
          label="Resize layers panel"
        />

        <main className="center"><StageViewport /></main>

        {/* The properties panel grows as the pointer moves left, hence invert. */}
        <Splitter
          axis="x"
          invert
          value={layout.right}
          onChange={(v) => resize('right', v)}
          onReset={() => resetPanel('right')}
          label="Resize properties panel"
        />

        <aside className="right" style={{ width: layout.right }}><PropertiesPanel /></aside>
      </div>

      <Splitter
        axis="y"
        invert
        value={layout.timeline}
        onChange={(v) => resize('timeline', v)}
        onReset={() => resetPanel('timeline')}
        label="Resize timeline"
      />

      {dialog === 'new-project' && (
        <NewProjectDialog
          onCreated={(id) => { setDialog(null); void refreshProjects(id); }}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === 'new-scene' && projectId && (
        <NewSceneDialog
          projectId={projectId}
          // Reload rather than select locally: the server has just written the
          // project document, and the scene picker must be listing what is on
          // disk before it can select anything from it.
          onCreated={(compId) => {
            setDialog(null);
            void loadProject(projectId, compId);
          }}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === 'delete-project' && projectId && (
        <DeleteProjectDialog
          projectId={projectId}
          projectName={projectName}
          sceneCount={sceneCount}
          // No project to open: `refreshProjects` falls through to the first
          // one left, or to none at all if that was the last.
          onDeleted={() => { setDialog(null); void refreshProjects(); }}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === 'delete-scene' && projectId && composition && (
        <DeleteSceneDialog
          projectId={projectId}
          sceneId={composition.id}
          sceneName={composition.name}
          isLastScene={sceneCount <= 1}
          // Reload the project rather than splicing the scene out of local
          // state: the server returns the surviving document and re-reading it
          // is what guarantees the editor is looking at what is on disk.
          onDeleted={() => { setDialog(null); void refreshProjects(projectId); }}
          onClose={() => setDialog(null)}
        />
      )}

      <footer className="app-timeline" style={{ height: layout.timeline }}>
        {/*
          Fit asks for the height it needs; `resize` clamps it against the panel
          limits and the window-share cap, so a composition with more rows than
          the timeline is ever allowed to show grows as far as it can and keeps
          its scrollbar rather than squeezing out the stage.
        */}
        <Timeline onGrow={(extra) => resize('timeline', layout.timeline + extra)} />
      </footer>
    </div>
  );
}
