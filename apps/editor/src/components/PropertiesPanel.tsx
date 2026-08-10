// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Properties panel.
 *
 * Every numeric field carries a keyframe toggle: with the stopwatch on, editing
 * the value writes a keyframe at the playhead instead of the static baseline.
 * That is the After Effects convention, and it is what makes the panel and the
 * timeline the same tool rather than two.
 */

// React 19's types removed the global `JSX` namespace, so it has to be imported
// explicitly wherever `JSX.Element` is used as a return type.
import { useEffect, useState, type JSX } from 'react';
import {
  ADVANCE_DEFAULTS,
  ANIMATABLE_PROPS,
  CRAWL_SEPARATOR_PRESETS,
  DEFAULT_CRAWL_SEPARATOR,
  FILTER_OPS,
  NAMED_EASES,
  normalizeKey,
  type AdvanceTransform,
  type AnimatableProp,
  type Composition,
  type CrawlLayer,
  type DataColumn,
  type DataTransform,
  type FilterOp,
  type Layer,
  type RowAnimPresetId,
  type TableLayer,
  type TextAnimPresetId,
  type TextLayer,
  type TextClock,
  type TextStyle,
} from '@breeze/schema';
import {
  ROW_ANIM_PRESETS,
  TEXT_ANIM_PRESETS,
  formatClock,
  resolveRowAnim,
  resolveTextAnim,
  rowAnimDuration,
  textAnimDuration,
} from '@breeze/runtime';

import { useEditor } from '../state/store.js';
import { baselineOf, displayValue, isAnimated as propIsAnimated } from '../state/layer-values.js';

const TRANSFORM_FIELDS: Array<{ prop: AnimatableProp; label: string; step: number }> = [
  { prop: 'x', label: 'X', step: 1 },
  { prop: 'y', label: 'Y', step: 1 },
  { prop: 'scaleX', label: 'Scale X', step: 0.01 },
  { prop: 'scaleY', label: 'Scale Y', step: 0.01 },
  { prop: 'rotation', label: 'Rotation', step: 1 },
  { prop: 'opacity', label: 'Opacity', step: 0.01 },
  { prop: 'skewX', label: 'Skew X', step: 1 },
  { prop: 'skewY', label: 'Skew Y', step: 1 },
];

export function PropertiesPanel(): JSX.Element {
  const composition = useEditor((s) => s.composition);
  const layer = useEditor((s) => s.activeLayer());
  const cellOwner = useEditor((s) => s.activeCellOwner());
  const playhead = useEditor((s) => s.playhead);
  const run = useEditor((s) => s.run);
  const textPieces = useEditor((s) => s.textPieces);
  const overflowingText = useEditor((s) => s.overflowingText);
  const overflowingTables = useEditor((s) => s.overflowingTables);
  const tablePages = useEditor((s) => s.tablePages);
  const dataSources = useEditor((s) => s.dataSources);
  const assets = useEditor((s) => s.assets);

  if (!composition) return <div className="panel-empty">—</div>;
  if (!layer) {
    return (
      <div className="panel properties-panel">
        <div className="panel-header"><span>Composition</span></div>
        <div className="panel-body">
          <Field label="Name">
            <input
              value={composition.name}
              onChange={(e) => run({ kind: 'renameComposition', name: e.target.value })}
            />
          </Field>
          <Field label="Width">
            <input
              type="number"
              value={composition.stage.width}
              onChange={(e) => run({ kind: 'setStage', patch: { width: Number(e.target.value) } })}
            />
          </Field>
          <Field label="Height">
            <input
              type="number"
              value={composition.stage.height}
              onChange={(e) => run({ kind: 'setStage', patch: { height: Number(e.target.value) } })}
            />
          </Field>
          <Field label="FPS">
            <input
              type="number"
              value={composition.stage.fps}
              onChange={(e) => run({ kind: 'setStage', patch: { fps: Number(e.target.value) } })}
            />
          </Field>
          <Field label="Duration">
            <input
              type="number"
              step={0.1}
              value={composition.duration ?? 0}
              onChange={(e) => run({ kind: 'setDuration', duration: Number(e.target.value) })}
            />
          </Field>
          <p className="hint">Select a layer to edit its properties.</p>
        </div>
      </div>
    );
  }

  const patch = (p: Partial<Layer>) => run({ kind: 'patchLayer', layerId: layer.id, patch: p });

  /**
   * Assets a picker should offer for this layer.
   *
   * Filtered by kind — an image layer handed a .woff2 renders nothing, and
   * offering it is offering a mistake. `other` is included because the kind is
   * inferred from an extension and an unrecognised one is not evidence the file
   * is unusable, only that the server had nothing to say about it.
   *
   * Retired assets are withheld, with one exception: the file this layer is
   * already pointing at. Retiring became routine when Replace shipped in
   * 0.60.0 — every replacement leaves its predecessor behind — and offering
   * both would put two options with the same label in the list, one of them
   * the file the operator has just superseded. Keeping the current value is
   * what stops a layer already on a retired asset having its own path vanish
   * out of the picker and read as unset.
   */
  // Narrowed once: `src` lives on the image, video and sprite variants, not on `Layer`.
  const currentSrc =
    layer.type === 'image' || layer.type === 'video' || layer.type === 'sprite'
      ? layer.src
      : undefined;

  const assetsOfKind = assets.filter(
    (a) =>
      (a.state !== 'retired' || a.path === currentSrc) &&
      (a.kind === 'other' ||
        (layer.type === 'image' && a.kind === 'image') ||
        (layer.type === 'video' && a.kind === 'video') ||
        // A sheet is an ordinary still image as far as the bin is concerned —
        // nothing at ingest can tell a sprite sheet from a photograph, and a
        // separate asset kind would mean asking the operator to classify a file
        // the server cannot verify the answer for.
        (layer.type === 'sprite' && a.kind === 'image')),
  );

  /**
   * Column keys offered to a selected cell.
   *
   * Same precedence the table panel uses — live source columns where one is
   * attached, the authored snapshot otherwise — because the author needs the
   * keys that will actually arrive on air, not the placeholder ones.
   */
  const cellColumns: string[] =
    cellOwner?.type === 'table'
      ? (() => {
          const bound = dataSources.find((s) => s.id === cellOwner.source);
          const cols = bound?.columns.length ? bound.columns : cellOwner.data?.columns ?? [];
          return cols.map((c) => c.key);
        })()
      : [];

  // Measured by the runtime on its last build — see the store fields.
  const pieces = textPieces[layer.id] ?? 0;
  const overflowing = layer.type === 'text' && overflowingText.includes(layer.id);

  const isAnimated = (prop: AnimatableProp) => propIsAnimated(layer, prop);

  // Same command the stage dispatches when you drag, so typing a number and
  // dragging on canvas cannot behave differently.
  const setValue = (prop: AnimatableProp, value: number) => {
    run({ kind: 'setValues', layerId: layer.id, values: { [prop]: value }, time: playhead });
  };

  const toggleKeyframe = (prop: AnimatableProp) => {
    if (isAnimated(prop)) {
      const times = (layer.keyframes?.[prop] ?? []).map((kf) => kf.t);
      run({ kind: 'deleteKeyframes', targets: times.map((time) => ({ layerId: layer.id, prop, time })) });
      return;
    }
    // Turning the stopwatch on seeds a keyframe holding the current value, so
    // the animation starts from what is already on screen.
    run({
      kind: 'setKeyframe',
      layerId: layer.id,
      prop,
      time: playhead,
      value: baselineOf(layer, prop),
    });
  };

  /**
   * Drop a keyframe at the playhead holding whatever the property is worth
   * right now.
   *
   * The stopwatch toggles a whole track on or off, so without this there was no
   * way to add a single keyframe to an already-animated property — the only
   * workaround was nudging the value and nudging it back, which made refining
   * an existing animation (as opposed to creating one) needlessly awkward.
   */
  const addKeyframe = (prop: AnimatableProp) => {
    run({
      kind: 'setKeyframe',
      layerId: layer.id,
      prop,
      time: playhead,
      value: displayValue(layer, prop, playhead),
    });
  };

  const hasKeyframeAtPlayhead = (prop: AnimatableProp) =>
    (layer.keyframes?.[prop] ?? []).some((kf) => Math.abs(kf.t - playhead) < 1e-6);

  return (
    <div className="panel properties-panel">
      <div className="panel-header">
        <span>{layer.name ?? layer.id}</span>
        <span className="panel-sub">{layer.type}</span>
      </div>

      <div className="panel-body">
        <Section title="Transform">
          {TRANSFORM_FIELDS.map(({ prop, label, step }) => (
            <Field key={prop} label={label}>
              <button
                className={`stopwatch${isAnimated(prop) ? ' on' : ''}`}
                title={isAnimated(prop) ? 'Remove all keyframes' : 'Animate this property'}
                onClick={() => toggleKeyframe(prop)}
              >
                ⏱
              </button>
              <input
                type="number"
                step={step}
                value={round(displayValue(layer, prop, playhead))}
                onChange={(e) => setValue(prop, Number(e.target.value))}
              />
              {isAnimated(prop) && (
                <button
                  className={`add-key${hasKeyframeAtPlayhead(prop) ? ' on' : ''}`}
                  title={
                    hasKeyframeAtPlayhead(prop)
                      ? 'Keyframe at the playhead'
                      : 'Add a keyframe at the playhead'
                  }
                  onClick={() => addKeyframe(prop)}
                >
                  ◆
                </button>
              )}
            </Field>
          ))}
        </Section>

        {layer.size && (
          <Section title="Size">
            <Field label="Width">
              <input
                type="number"
                value={layer.size.width}
                onChange={(e) => patch({ size: { ...layer.size!, width: Number(e.target.value) } })}
              />
            </Field>
            <Field label="Height">
              <input
                type="number"
                value={layer.size.height}
                onChange={(e) => patch({ size: { ...layer.size!, height: Number(e.target.value) } })}
              />
            </Field>
          </Section>
        )}

        {/*
          Which column this cell renders, and the note explaining its clock.

          A free-text field would be wrong for the same reason it was wrong on
          the table panel: the column keys are known, and a typo produces a cell
          that renders empty with nothing to say why. The owning table's source
          supplies the list.
        */}
        {cellOwner && (
          <Section title="Cell">
            <Field label="Column">
              <select
                value={layer.cell ?? ''}
                onChange={(e) =>
                  patch({ cell: e.target.value === '' ? undefined : e.target.value } as Partial<Layer>)
                }
              >
                <option value="">— none —</option>
                {cellColumns.map((key) => (
                  <option key={key} value={key}>{key}</option>
                ))}
                {/*
                  A key already on the layer but absent from the source keeps
                  its own option. Dropping it would silently rewrite the
                  document to "none" the moment a feed went down or a source was
                  repointed — losing authoring work to a transient outage.
                */}
                {layer.cell && !cellColumns.includes(layer.cell) && (
                  <option value={layer.cell}>{layer.cell} (not in source)</option>
                )}
              </select>
            </Field>
            <p className="hint">
              Drawn once per data row. Keyframe times are measured from the row's
              arrival, not the composition's start, so a cell rides its row's
              reveal stagger.
            </p>
          </Section>
        )}

        {/*
          Timing is a stage-layer concept. A cell has no lifetime window — the
          runtime builds its motion from `layerMotion(cell)`, which reads
          keyframes and nothing else — so offering In and Out here would write
          two numbers that are never read back.
        */}
        {!cellOwner && (
          <Section title="Timing">
            <Field label="In">
              <input
                type="number"
                step={0.05}
                value={layer.in ?? 0}
                onChange={(e) => patch({ in: Number(e.target.value) })}
              />
            </Field>
            <Field label="Out">
              <input
                type="number"
                step={0.05}
                value={layer.out ?? ''}
                placeholder="end"
                onChange={(e) =>
                  patch({ out: e.target.value === '' ? undefined : Number(e.target.value) })
                }
              />
            </Field>
          </Section>
        )}

        {layer.type === 'shape' && (
          <Section title="Shape">
            <Field label="Kind">
              <select value={layer.shape} onChange={(e) => patch({ shape: e.target.value as 'rect' | 'ellipse' } as Partial<Layer>)}>
                <option value="rect">Rectangle</option>
                <option value="ellipse">Ellipse</option>
              </select>
            </Field>
            <Field label="Fill">
              <input
                type="color"
                value={typeof layer.fill === 'string' ? layer.fill : '#1f6feb'}
                onChange={(e) => patch({ fill: e.target.value } as Partial<Layer>)}
              />
            </Field>
            <Field label="Radius">
              <input
                type="number"
                value={layer.cornerRadius ?? 0}
                onChange={(e) => patch({ cornerRadius: Number(e.target.value) } as Partial<Layer>)}
              />
            </Field>
          </Section>
        )}

        {layer.type === 'text' && (
          <>
            <Section title="Text">
              <Field label="Content">
                <textarea
                  rows={2}
                  value={layer.text}
                  onChange={(e) => patch({ text: e.target.value } as Partial<Layer>)}
                />
              </Field>
              <Field label="Binding">
                <input
                  value={layer.binding ?? ''}
                  placeholder="e.g. name"
                  title="Operators can update this field live"
                  onChange={(e) =>
                    patch({ binding: e.target.value || undefined } as Partial<Layer>)
                  }
                />
              </Field>
            </Section>
            <TextStyleSection
              style={layer.style}
              onChange={(style) => patch({ style } as Partial<Layer>)}
            />
            <Section title="Fit width">
              <Field label="Mode">
                <select
                  value={layer.fit?.mode ?? 'none'}
                  onChange={(e) =>
                    patch({
                      fit: { ...(layer.fit ?? {}), mode: e.target.value as 'none' | 'width' },
                    } as Partial<Layer>)
                  }
                >
                  <option value="none">None</option>
                  <option value="width">Fit width</option>
                </select>
              </Field>
              <Field label="Max width">
                <input
                  type="number"
                  value={layer.fit?.maxWidth ?? layer.size?.width ?? 0}
                  onChange={(e) =>
                    patch({
                      fit: { mode: layer.fit?.mode ?? 'width', ...(layer.fit ?? {}), maxWidth: Number(e.target.value) },
                    } as Partial<Layer>)
                  }
                />
              </Field>
              <Field label="Min scale">
                <input
                  type="number"
                  step={0.05}
                  min={0.1}
                  max={1}
                  value={layer.fit?.minScale ?? 0.5}
                  onChange={(e) =>
                    patch({
                      fit: { mode: layer.fit?.mode ?? 'width', ...(layer.fit ?? {}), minScale: Number(e.target.value) },
                    } as Partial<Layer>)
                  }
                />
              </Field>
              {/*
                Fit Width's own report, not a guess from the document.
                `applyTextFit` stops at `minScale` rather than squashing text
                past legibility, so a name can still be wider than its strap
                after fitting. That is exactly the case an author must find now:
                on air it reads as text running off the end of the bar.
              */}
              {overflowing && (
                <p className="prop-warning" data-warning="fit-overflow">
                  Still wider than the box at min scale — the text will overrun
                  its strap. Widen the box, lower Min scale, or shorten the copy.
                </p>
              )}
            </Section>
            <TextRevealSection
              layer={layer}
              composition={composition}
              pieces={pieces}
              onChange={(preset) => patch({ textAnimPreset: preset } as Partial<Layer>)}
            />
            <ClockSection
              layer={layer}
              onChange={(clock) => patch({ clock } as Partial<Layer>)}
            />
          </>
        )}

        {/*
          Crawl authoring. The schema and the runtime have supported speed,
          direction, a bound item list and live append since Phase 1 — but the
          panel had no controls for any of it, so a crawl added in the editor was
          stuck on its factory defaults and could only be changed by editing the
          project JSON by hand. Found by auditing Phase 5 against the roadmap
          rather than by anyone reporting it, which is the argument for the audit.
        */}
        {layer.type === 'crawl' && (
          <>
            <Section title="Crawl">
              <Field label="Speed">
                <input
                  type="number"
                  step={10}
                  min={1}
                  value={layer.speed}
                  title="Pixels per second, independent of the composition's duration"
                  onChange={(e) =>
                    patch({ speed: Math.max(1, Number(e.target.value)) } as Partial<Layer>)
                  }
                />
              </Field>
              <Field label="Direction">
                <select
                  value={layer.direction}
                  onChange={(e) =>
                    patch({ direction: e.target.value as 'left' | 'right' } as Partial<Layer>)
                  }
                >
                  <option value="left">Right to left</option>
                  <option value="right">Left to right</option>
                </select>
              </Field>
              <CrawlSeparatorField
                value={layer.separator}
                onChange={(separator) => patch({ separator } as Partial<Layer>)}
              />
              <Field label="Binding">
                <input
                  value={layer.binding ?? ''}
                  placeholder="e.g. headlines"
                  title="Operators can replace the whole item list live; the new copy is swapped in at the loop seam"
                  onChange={(e) =>
                    patch({ binding: e.target.value || undefined } as Partial<Layer>)
                  }
                />
              </Field>
              <Field label="Items">
                <textarea
                  rows={4}
                  value={layer.items.join('\n')}
                  title="One headline per line"
                  onChange={(e) =>
                    patch({
                      // Blank lines dropped: an empty item renders as two
                      // separators with nothing between them.
                      items: e.target.value.split('\n').filter((line) => line.trim() !== ''),
                    } as Partial<Layer>)
                  }
                />
              </Field>
              <p className="hint">One per line. The loop is seamless — the list repeats end to end.</p>
            </Section>

            <CrawlSourceSection
              layer={layer}
              sources={dataSources}
              onPatch={(p) => patch(p as Partial<Layer>)}
            />
            <TextStyleSection
              style={layer.style}
              onChange={(style) => patch({ style } as Partial<Layer>)}
            />
          </>
        )}

        {layer.type === 'composition' && (
          <Section title="Composition">
            <Field label="Reference">
              <input
                value={layer.ref}
                placeholder="composition id"
                onChange={(e) => patch({ ref: e.target.value } as Partial<Layer>)}
              />
            </Field>
            {/*
              Independent turns a nested composition into its own graphic on its
              own control channel, instead of inlining it into this timeline.
              A composition holding independent children is what the guide calls
              a scene — there is no separate scene type to create.
            */}
            <Field label="Independent">
              <input
                type="checkbox"
                checked={layer.independent ?? false}
                title="Give this element its own timeline and its own PLAY, triggered separately from everything else on the page"
                onChange={(e) => {
                  const independent = e.target.checked;
                  /*
                   * Clearing keyframes and the lifetime window is not tidiness —
                   * the validator rejects them on an independent layer, so
                   * leaving them behind would make the composition unsavable the
                   * moment the box is ticked, with the error pointing at fields
                   * the author did not just touch.
                   */
                  patch(
                    (independent
                      ? { independent: true, keyframes: undefined, in: undefined, out: undefined }
                      : { independent: undefined, channel: undefined }) as Partial<Layer>,
                  );
                }}
              />
            </Field>
            {layer.independent && (
              <Field label="Channel">
                <input
                  value={layer.channel ?? ''}
                  placeholder={layer.ref}
                  title="The name an operator triggers: /api/control/<project>/<channel>/play. Defaults to the referenced composition's id."
                  onChange={(e) => {
                    // Normalized as typed rather than validated on save: the
                    // rules are the URL's, not this field's, and an operator
                    // typing "Bug" should get a working channel, not a refusal.
                    const next = normalizeKey(e.target.value);
                    patch({ channel: next || undefined } as Partial<Layer>);
                  }}
                />
              </Field>
            )}
          </Section>
        )}

        {layer.type === 'table' && (
          <TableSection
            layer={layer}
            sources={dataSources}
            overflowing={overflowingTables.includes(layer.id)}
            pages={tablePages[layer.id]}
            onPatch={(p) => patch(p as Partial<Layer>)}
          />
        )}

        {(layer.type === 'image' || layer.type === 'video' || layer.type === 'sprite') && (
          <Section title="Source">
            {/*
              A picker over the asset bin, with the free-text path kept below it.

              The picker is the path anyone should use — before the bin existed
              this was a text field and the only way to fill it correctly was to
              know what had been copied into the project directory, which an
              operator with no shell on the graphics box cannot. The text field
              stays because two cases still need it: an asset uploaded in
              another tab and not yet in this list, and a path that is
              deliberately not in the bin at all.
            */}
            <Field label="Asset">
              <select
                value={assetsOfKind.some((a) => a.path === layer.src) ? layer.src : ''}
                onChange={(e) => {
                  if (e.target.value) patch({ src: e.target.value } as Partial<Layer>);
                }}
              >
                <option value="">
                  {assetsOfKind.length
                    ? '— pick an asset —'
                    // A sprite draws from the image assets, so "no sprite
                    // assets uploaded" would send the operator looking for a
                    // kind of file the bin does not have.
                    : `no ${layer.type === 'sprite' ? 'image' : layer.type} assets uploaded`}
                </option>
                {assetsOfKind.map((a) => (
                  <option key={a.id} value={a.path}>{a.originalName ?? a.path}</option>
                ))}
              </select>
            </Field>
            <Field label="Path">
              <input
                value={layer.src}
                placeholder="assets/logo.png"
                onChange={(e) => patch({ src: e.target.value } as Partial<Layer>)}
              />
            </Field>
            {/*
              A path pointing at nothing in the bin is the failure this panel
              exists to prevent, and it is otherwise completely silent: the
              layer just renders empty. Not an error — the file may be there
              without having been uploaded through the bin — so it says what it
              actually knows.
            */}
            {layer.src && !assets.some((a) => a.path === layer.src) && (
              <p className="hint">Not in the asset bin — check the file exists in the project.</p>
            )}
            {/*
              Withheld from a multi-frame sprite rather than shown and rejected
              on save. `validate.ts` refuses the combination because a bound
              sheet arrives with its own geometry and would be stepped through
              the outgoing sheet's grid — sliced quarters of two frames at once.
              A field that can only ever produce an invalid document should not
              be offered.
            */}
            {!(layer.type === 'sprite' && layer.cols * layer.rows > 1) && (
              <Field label="Binding">
                <input
                  value={layer.binding ?? ''}
                  onChange={(e) => patch({ binding: e.target.value || undefined } as Partial<Layer>)}
                />
              </Field>
            )}
            {layer.type === 'sprite' && layer.cols * layer.rows > 1 && (
              <p className="hint">
                A multi-frame sheet cannot be bound — the incoming sheet would be
                stepped through this one&rsquo;s grid.
              </p>
            )}

            {layer.type === 'sprite' && (
              <>
                <Field label="Columns">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={layer.cols}
                    onChange={(e) => patch({ cols: Math.max(1, Math.round(Number(e.target.value))) } as Partial<Layer>)}
                  />
                </Field>
                <Field label="Rows">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={layer.rows}
                    onChange={(e) => patch({ rows: Math.max(1, Math.round(Number(e.target.value))) } as Partial<Layer>)}
                  />
                </Field>
                {/*
                  Blank means "the whole grid". Stated that way rather than
                  pre-filled with `cols * rows`, because a pre-filled number
                  stops tracking the grid the moment the operator changes a
                  dimension — and a frame count one export behind is six frames
                  of empty cells at the end of the animation.
                */}
                <Field label="Frames">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    placeholder={String(layer.cols * layer.rows)}
                    value={layer.frameCount ?? ''}
                    onChange={(e) =>
                      patch({
                        frameCount: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined,
                      } as Partial<Layer>)
                    }
                  />
                </Field>
                {layer.frameCount !== undefined && layer.frameCount > layer.cols * layer.rows && (
                  <p className="hint">
                    Only {layer.cols * layer.rows} cells in a {layer.cols}×{layer.rows} grid.
                  </p>
                )}
                <Field label="FPS">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={layer.fps}
                    onChange={(e) => patch({ fps: Math.max(1, Number(e.target.value)) } as Partial<Layer>)}
                  />
                </Field>
                {/*
                  The sheet's own rate, not the layer's. Worth saying out loud:
                  the obvious assumption is that a sprite fills its lifetime bar
                  the way a keyframed property does, and an author who believes
                  that will drag the bar to retime the animation and watch
                  nothing change.
                */}
                <p className="hint">
                  {(layer.frameCount ?? layer.cols * layer.rows)} frames at {layer.fps}fps
                  {' — '}
                  {((layer.frameCount ?? layer.cols * layer.rows) / layer.fps).toFixed(2)}s.
                  Independent of the layer&rsquo;s in/out points.
                </p>
              </>
            )}

            {(layer.type === 'video' || layer.type === 'sprite') && (
              <>
                <Field label="Start at">
                  <input
                    type="number"
                    step={0.1}
                    value={layer.startAt ?? 0}
                    onChange={(e) => patch({ startAt: Number(e.target.value) } as Partial<Layer>)}
                  />
                </Field>
                <Field label="Loop">
                  <input
                    type="checkbox"
                    checked={layer.loop ?? false}
                    onChange={(e) => patch({ loop: e.target.checked } as Partial<Layer>)}
                  />
                </Field>
                {/*
                  Hidden while looping, because a loop has no end and the
                  control would do nothing. Showing a dead field is how an
                  author concludes the setting is broken.
                */}
                {!layer.loop && (
                  <Field label="At end">
                    <select
                      value={layer.onEnd ?? 'hold'}
                      onChange={(e) => patch({ onEnd: e.target.value as 'hold' | 'clear' } as Partial<Layer>)}
                    >
                      <option value="hold">Hold last frame</option>
                      <option value="clear">Clear</option>
                    </select>
                  </Field>
                )}
                {!layer.loop && layer.onEnd !== 'clear' && (
                  <p className="hint">
                    A stinger usually wants Clear — a held final frame stays over
                    the program feed once the transition is done.
                  </p>
                )}
                {/*
                  A layer pointing at a format that cannot carry transparency.

                  Silent otherwise, and it is the defect this whole phase
                  exists to prevent: the graphic looks right in the editor,
                  over the editor's own background, and goes to air as a black
                  box over live pictures.
                */}
                {layer.src && /\.(mov|mp4|m4v)$/i.test(layer.src) && (
                  <p className="hint">
                    This format cannot carry an alpha channel in a browser
                    source. Transcode it in the asset bin if it needs
                    transparency.
                  </p>
                )}
              </>
            )}
          </Section>
        )}

        <Section title="Effects">
          <Field label="Blur">
            <button
              className={`stopwatch${isAnimated('blur') ? ' on' : ''}`}
              onClick={() => toggleKeyframe('blur')}
            >⏱</button>
            <input
              type="number"
              step={0.5}
              value={round(displayValue(layer, 'blur', playhead))}
              onChange={(e) => setValue('blur', Number(e.target.value))}
            />
          </Field>
          <Field label="Brightness">
            <button
              className={`stopwatch${isAnimated('brightness') ? ' on' : ''}`}
              onClick={() => toggleKeyframe('brightness')}
            >⏱</button>
            <input
              type="number"
              step={0.05}
              value={round(displayValue(layer, 'brightness', playhead))}
              onChange={(e) => setValue('brightness', Number(e.target.value))}
            />
          </Field>
          <Field label="Blend">
            <select
              value={layer.blendMode ?? 'normal'}
              onChange={(e) => patch({ blendMode: e.target.value === 'normal' ? undefined : e.target.value })}
            >
              {['normal', 'multiply', 'screen', 'overlay', 'lighten', 'darken', 'difference'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Field>
        </Section>

        <details className="raw-json">
          <summary>Animated properties</summary>
          <ul>
            {ANIMATABLE_PROPS.filter((p) => isAnimated(p)).map((p) => (
              <li key={p}>{p} — {layer.keyframes?.[p]?.length} keyframes</li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}

function TextStyleSection({
  style,
  onChange,
}: {
  style: TextStyle;
  onChange: (style: TextStyle) => void;
}): JSX.Element {
  const set = (patch: Partial<TextStyle>) => onChange({ ...style, ...patch });

  return (
    <Section title="Type">
      <Field label="Font">
        <input value={style.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })} />
      </Field>
      <Field label="Size">
        <input type="number" value={style.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
      </Field>
      <Field label="Weight">
        <select value={String(style.fontWeight ?? 400)} onChange={(e) => set({ fontWeight: Number(e.target.value) })}>
          {[300, 400, 500, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      </Field>
      <Field label="Color">
        <input
          type="color"
          value={typeof style.fill === 'string' ? style.fill : '#ffffff'}
          onChange={(e) => set({ fill: e.target.value })}
        />
      </Field>
      <Field label="Tracking">
        <input
          type="number"
          step={0.1}
          value={style.letterSpacing ?? 0}
          onChange={(e) => set({ letterSpacing: Number(e.target.value) })}
        />
      </Field>
      <Field label="Align">
        <select value={style.align ?? 'left'} onChange={(e) => set({ align: e.target.value as TextStyle['align'] })}>
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </Field>
      <Field label="Case">
        <select
          value={style.textTransform ?? 'none'}
          onChange={(e) => set({ textTransform: e.target.value as TextStyle['textTransform'] })}
        >
          <option value="none">As typed</option>
          <option value="uppercase">UPPERCASE</option>
          <option value="lowercase">lowercase</option>
          <option value="capitalize">Capitalize</option>
        </select>
      </Field>
    </Section>
  );
}

/**
 * Clock formats offered in the picker.
 *
 * A shortlist over a free-text box, because the token language is easy to get
 * subtly wrong — `mm` versus `MM` is minutes versus month, and the mistake
 * renders as a plausible-looking number rather than as an error. The field
 * underneath still accepts anything, so the list is a starting point rather
 * than a limit.
 */
const CLOCK_FORMAT_PRESETS: Array<{ label: string; value: string }> = [
  { label: '6:42 PM', value: 'h:mm A' },
  { label: '6:42:07 PM', value: 'h:mm:ss A' },
  { label: '18:42', value: 'HH:mm' },
  { label: '18:42:07', value: 'HH:mm:ss' },
  { label: 'Mon 3 Aug', value: 'ddd D MMM' },
  { label: 'Monday, August 3', value: 'dddd, MMMM D' },
  { label: '03/08/26', value: 'DD/MM/YY' },
];

/**
 * Live clock on a text layer.
 *
 * The preview is rendered from the *real* formatter rather than from a mocked
 * string, so an author sees exactly what will be on air — including the
 * timezone, which is the field most likely to be wrong and least likely to be
 * noticed until somebody in another market complains.
 */
function ClockSection({
  layer,
  onChange,
}: {
  layer: TextLayer;
  onChange: (clock: TextClock | undefined) => void;
}): JSX.Element {
  const clock = layer.clock;
  const [now, setNow] = useState(() => new Date());

  // Only while a clock layer is selected, and only once a second — this is a
  // preview in a panel, not the thing on air.
  useEffect(() => {
    if (!clock) return undefined;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [clock]);

  let preview = '';
  let error = '';
  if (clock) {
    try {
      preview = formatClock(now, clock);
    } catch {
      error = 'That time zone is not one this machine knows.';
    }
  }

  return (
    <Section title="Clock">
      <Field label="Live clock">
        <input
          type="checkbox"
          checked={Boolean(clock)}
          title="Render the host's wall-clock time into this layer"
          onChange={(e) => onChange(e.target.checked ? { format: 'h:mm A' } : undefined)}
        />
      </Field>

      {clock && (
        <>
          <Field label="Preset">
            <select
              value={
                CLOCK_FORMAT_PRESETS.some((p) => p.value === clock.format) ? clock.format : ''
              }
              onChange={(e) => e.target.value && onChange({ ...clock, format: e.target.value })}
            >
              <option value="">Custom…</option>
              {CLOCK_FORMAT_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Format">
            <input
              value={clock.format}
              placeholder="h:mm A"
              title="Tokens: HH H hh h mm m ss s A a · DD D MMMM MMM MM M · dddd ddd YYYY YY · [literal]"
              onChange={(e) => onChange({ ...clock, format: e.target.value })}
            />
          </Field>
          <Field label="Time zone">
            <input
              value={clock.timezone ?? ''}
              placeholder="host local"
              title="IANA zone, e.g. America/Phoenix. Blank uses the render machine's own zone."
              onChange={(e) => {
                const { timezone: _drop, ...rest } = clock;
                onChange(e.target.value ? { ...rest, timezone: e.target.value } : rest);
              }}
            />
          </Field>

          {error ? (
            <p className="prop-warning" data-warning="clock-timezone">
              {error}
            </p>
          ) : (
            <p className="prop-note" data-preview="clock">
              Now: <strong>{preview}</strong>
            </p>
          )}

          {/*
            The layer's own text is only ever a placeholder once a clock is on:
            the runtime overwrites it before the first paint. Said here because
            an author who edits Content and sees nothing change on the output
            has no other way to find that out.
          */}
          <p className="prop-note">
            Content above is a placeholder — the canvas and a still export use
            it, a renderer never does.
          </p>
          {layer.binding && (
            <p className="prop-warning" data-warning="clock-binding">
              This layer also has a binding. A clock always wins, so the
              operator field would do nothing — clear one or the other.
            </p>
          )}
        </>
      )}
    </Section>
  );
}

/**
 * Text reveal gallery — Phase 5.
 *
 * A preset picker plus the three controls that make one preset serve many
 * straps: stagger, per-piece duration, and ease. The numeric fields deliberately
 * show the preset's own default as their placeholder rather than pre-filling it,
 * so the document stays free of values the author never chose — and clearing a
 * field goes back to following the preset.
 */
function TextRevealSection({
  layer,
  composition,
  pieces,
  onChange,
}: {
  layer: TextLayer;
  composition: Composition;
  pieces: number;
  onChange: (preset: TextLayer['textAnimPreset']) => void;
}): JSX.Element {
  const preset = layer.textAnimPreset;
  const resolved = resolveTextAnim(preset);

  /**
   * How long the reveal actually takes, and how long it has.
   *
   * The budget is the time from the layer's in-point to the first STOP marker
   * after it — where the graphic parks on air — or to the end of the composition
   * if it never holds. A reveal that overruns that is the failure this readout
   * exists to catch: the strap is still assembling itself when the director cuts
   * away, and it looks like a dropped frame rather than a timing mistake.
   */
  const inPoint = layer.in ?? 0;
  const hold = (composition.markers ?? [])
    .filter((m) => m.type === 'stop' && m.time > inPoint)
    .map((m) => m.time)
    .sort((a, b) => a - b)[0];
  const budget = (hold ?? composition.duration ?? 0) - inPoint;
  const total = resolved ? textAnimDuration(resolved, pieces) : 0;
  const overruns = resolved && pieces > 0 && budget > 0 && total > budget;

  const update = (changes: Partial<NonNullable<TextLayer['textAnimPreset']>>) => {
    if (!preset) return;
    onChange({ ...preset, ...changes });
  };

  return (
    <Section title="Reveal">
      <Field label="Preset">
        <select
          className="reveal-preset"
          value={preset?.id ?? ''}
          onChange={(e) => {
            const id = e.target.value;
            // Only the id is written. Timings stay absent so the layer follows
            // the preset's defaults until someone deliberately overrides them.
            onChange(id ? { id: id as TextAnimPresetId } : undefined);
          }}
        >
          <option value="">None</option>
          {TEXT_ANIM_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </Field>

      {resolved && (
        <>
          <Field label="Stagger">
            <input
              type="number"
              step={0.005}
              min={0}
              placeholder={String(resolved.defaults.stagger)}
              value={preset?.stagger ?? ''}
              title="Seconds between consecutive pieces. 0 animates them together."
              onChange={(e) =>
                update({ stagger: e.target.value === '' ? undefined : Number(e.target.value) })
              }
            />
          </Field>
          <Field label="Duration">
            <input
              type="number"
              step={0.05}
              min={0.05}
              placeholder={String(resolved.defaults.duration)}
              value={preset?.duration ?? ''}
              title="Seconds each individual piece takes"
              onChange={(e) =>
                update({ duration: e.target.value === '' ? undefined : Number(e.target.value) })
              }
            />
          </Field>
          <Field label="Ease">
            <select
              value={typeof preset?.ease === 'string' ? preset.ease : ''}
              onChange={(e) => update({ ease: e.target.value || undefined })}
            >
              <option value="">{`Preset (${String(resolved.defaults.ease)})`}</option>
              {NAMED_EASES.map((ease) => (
                <option key={ease} value={ease}>{ease}</option>
              ))}
            </select>
          </Field>

          {/*
            Measured, not estimated. The piece count comes from the runtime's
            actual split — which for `lines` depends on the real font and the real
            box, so nothing here could be worked out from the document alone.
          */}
          <p className="hint reveal-readout" data-pieces={pieces} data-total={round(total)}>
            {pieces > 0
              ? `${pieces} ${resolved.unit} · ${round(total)}s total`
              : `Waiting on the preview to measure the ${resolved.unit}`}
          </p>

          {overruns && (
            <p className="prop-warning" data-warning="reveal-overrun">
              {`Reveal runs ${round(total)}s but only has ${round(budget)}s before ` +
                `${hold === undefined ? 'the end of the composition' : 'the hold'} — ` +
                'it will still be assembling on air. Shorten the stagger or the duration.'}
            </p>
          )}
        </>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ table */

const FILTER_LABEL: Record<FilterOp, string> = {
  eq: 'is', ne: 'is not',
  gt: '>', gte: '≥', lt: '<', lte: '≤',
  contains: 'contains', startsWith: 'starts with', endsWith: 'ends with',
  empty: 'is empty', notEmpty: 'is not empty',
};

/**
 * Table authoring: where the rows come from, how they are sliced, how they
 * arrive, and how many fit.
 *
 * The transform pipeline is edited as an ordered list rather than a set of
 * dropdowns because the order is the meaning — `sort → rank → sort` is an
 * alphabetical standings table that still shows league position, and no
 * fixed-slot UI can express that.
 */
/**
 * Separator picker — presets plus a Custom escape hatch.
 *
 * A free-text field was the wrong control for this. The separators that read
 * well on air are mostly characters a keyboard cannot produce (•, ◆, ▶, an em
 * dash), so in practice people either pasted one from somewhere or settled for
 * a hyphen. The other half of the problem is invisible: the padding either side
 * of the glyph *is* part of the value, and a field showing `   •   ` looks
 * identical to one showing `•`.
 *
 * Custom stays, because a house style might want something not listed, and it
 * keeps the field honest about what the value really is.
 */
function CrawlSeparatorField({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (separator: string | undefined) => void;
}): JSX.Element {
  const current = value ?? DEFAULT_CRAWL_SEPARATOR;
  const preset = CRAWL_SEPARATOR_PRESETS.find((p) => p.value === current);
  const [custom, setCustom] = useState(!preset);

  /*
   * A layer whose separator does not match any preset opens on Custom, but the
   * choice is sticky once made: selecting Custom and then typing a string that
   * happens to equal a preset must not yank the control back to the dropdown
   * mid-keystroke. Re-derived only when the layer's own value changes to
   * something the picker can represent.
   */
  useEffect(() => {
    if (preset) setCustom(false);
  }, [preset]);

  return (
    <>
      <Field label="Separator">
        <select
          value={custom ? '__custom__' : current}
          title="Printed between items, and again between the last and the first"
          onChange={(e) => {
            if (e.target.value === '__custom__') {
              setCustom(true);
              return;
            }
            setCustom(false);
            onChange(e.target.value);
          }}
        >
          {CRAWL_SEPARATOR_PRESETS.map((p) => (
            <option key={p.label} value={p.value}>{p.label}</option>
          ))}
          <option value="__custom__">Custom…</option>
        </select>
      </Field>

      {custom && (
        <Field label="Custom">
          <input
            value={current}
            placeholder={DEFAULT_CRAWL_SEPARATOR}
            title="Spaces count — include the padding you want either side of the glyph"
            onChange={(e) => onChange(e.target.value || undefined)}
          />
        </Field>
      )}

      <p className="hint">
        {custom
          ? 'Spaces are part of the value — pad either side of the glyph, or the items run together.'
          : `Renders as “A${current}B${current}”, wrapping round to the first item.`}
      </p>
    </>
  );
}

/**
 * Feed a ticker from a data source instead of a typed list.
 *
 * An RSS feed *is* a ticker, so this is the pairing Wave 2 exists to make work:
 * point a crawl at the feed's `title` column and the headlines look after
 * themselves. The typed items stay visible above and keep their job — they are
 * what shows before the first fetch lands and if the feed later dies.
 */
function CrawlSourceSection({
  layer,
  sources,
  onPatch,
}: {
  layer: CrawlLayer;
  sources: Array<{ id: string; name: string; columns: DataColumn[] }>;
  onPatch: (patch: Partial<CrawlLayer>) => void;
}): JSX.Element {
  const bound = sources.find((s) => s.id === layer.source);
  const columns = bound?.columns ?? [];

  return (
    <Section title="Crawl data">
      <Field label="Source">
        <select
          value={layer.source ?? ''}
          onChange={(e) => {
            const source = e.target.value || undefined;
            // Clearing the source clears the column with it. A column key left
            // pointing at a source that is gone is the sort of stale state that
            // silently does nothing and takes ten minutes to spot.
            const next = sources.find((s) => s.id === source);
            const keep = source && next?.columns.some((c) => c.key === layer.column);
            onPatch({
              source,
              column: keep
                ? layer.column
                : // `title` is the column an RSS feed always has and the one a
                  // ticker almost always wants.
                  (next?.columns.find((c) => c.key === 'title')?.key ?? next?.columns[0]?.key),
            });
          }}
        >
          <option value="">— typed items —</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </Field>

      {layer.source && (
        <Field label="Column">
          <select
            value={layer.column ?? ''}
            onChange={(e) => onPatch({ column: e.target.value || undefined })}
          >
            <option value="">— pick a column —</option>
            {columns.map((c) => (
              <option key={c.key} value={c.key}>{c.label ?? c.key}</option>
            ))}
          </select>
        </Field>
      )}

      {layer.source && !bound && (
        <p className="hint warn">
          No data source with id <code>{layer.source}</code> in this project. The ticker falls back
          to its typed items.
        </p>
      )}
      {layer.source && bound && !layer.column && (
        <p className="hint warn">
          Pick a column — until one is set the ticker keeps using its typed items.
        </p>
      )}
      {layer.source && layer.column && (
        <p className="hint">
          Items come from <code>{layer.column}</code>, refreshed whenever the source changes. Empty
          cells are skipped, and if the column comes back empty the typed items stay up.
        </p>
      )}
    </Section>
  );
}

/**
 * Column picker that can also mean "leave it defaulted".
 *
 * The empty option is not "none" — it is the default column name, which for a
 * bracket in the ordinary shape is the right answer for every field here. Naming
 * a column explicitly is the exception, so the exception is what costs a click.
 */
function ColumnPick({
  value,
  fallback,
  columns,
  onChange,
}: {
  value: string | undefined;
  fallback: string;
  columns: DataColumn[];
  onChange: (next: string | undefined) => void;
}): JSX.Element {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{fallback} (default)</option>
      {columns.map((c) => (
        <option key={c.key} value={c.key}>{c.key}</option>
      ))}
      {value && !columns.some((c) => c.key === value) && <option value={value}>{value}</option>}
    </select>
  );
}

/**
 * The `advance` editor.
 *
 * Laid out as a block rather than inline with the other transforms because it
 * has seven optional fields and a bracket is the one transform an operator
 * configures once and then never touches again — worth the vertical space on
 * the day it is set up, invisible afterwards.
 */
function AdvanceFields({
  t,
  columns,
  onChange,
}: {
  t: AdvanceTransform;
  columns: DataColumn[];
  onChange: (next: AdvanceTransform) => void;
}): JSX.Element {
  const fields = t.fields?.length ? t.fields : [...ADVANCE_DEFAULTS.fields];
  const scoring = Boolean(t.scores);

  return (
    <div className="transform-advance">
      <label>
        <span>Slot</span>
        <ColumnPick
          value={t.slot}
          fallback={ADVANCE_DEFAULTS.slot}
          columns={columns}
          onChange={(slot) => onChange({ ...t, slot })}
        />
      </label>
      <label>
        <span>Round</span>
        <ColumnPick
          value={t.round}
          fallback={ADVANCE_DEFAULTS.round}
          columns={columns}
          onChange={(round) => onChange({ ...t, round })}
        />
      </label>
      <label>
        <span>Winner</span>
        <ColumnPick
          value={t.winner}
          fallback={ADVANCE_DEFAULTS.winner}
          columns={columns}
          onChange={(winner) => onChange({ ...t, winner })}
        />
      </label>
      <label title="Optional per-row routing, e.g. QFL-1:home. Blank rows use the implied tree.">
        <span>Routes</span>
        <ColumnPick
          value={t.feeds}
          fallback={ADVANCE_DEFAULTS.feeds}
          columns={columns}
          onChange={(feeds) => onChange({ ...t, feeds })}
        />
      </label>
      <label title="Where a loser goes — this is how a third-place play-off gets filled.">
        <span>Loser routes</span>
        <ColumnPick
          value={t.feedsLoser}
          fallback={ADVANCE_DEFAULTS.feedsLoser}
          columns={columns}
          onChange={(feedsLoser) => onChange({ ...t, feedsLoser })}
        />
      </label>
      <label title="Side-prefixed suffixes carried forward together, e.g. Team, Code.">
        <span>Carry</span>
        <input
          value={fields.join(', ')}
          placeholder="Team"
          onChange={(e) => {
            const next = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
            // An empty list would mean "carry nothing", which advances a team
            // into a slot and writes none of it. Fall back to the default.
            onChange({ ...t, fields: next.length ? next : undefined });
          }}
        />
      </label>

      <label className="transform-advance-toggle">
        <input
          type="checkbox"
          checked={scoring}
          onChange={(e) =>
            onChange(
              e.target.checked
                ? { ...t, scores: { home: 'homeScore', away: 'awayScore' } }
                : { ...t, scores: undefined },
            )
          }
        />
        <span>Decide from scores when no winner is named</span>
      </label>

      {t.scores && (
        <>
          <label>
            <span>Home score</span>
            <ColumnPick
              value={t.scores.home}
              fallback="homeScore"
              columns={columns}
              onChange={(home) => onChange({ ...t, scores: { ...t.scores!, home: home ?? 'homeScore' } })}
            />
          </label>
          <label>
            <span>Away score</span>
            <ColumnPick
              value={t.scores.away}
              fallback="awayScore"
              columns={columns}
              onChange={(away) => onChange({ ...t, scores: { ...t.scores!, away: away ?? 'awayScore' } })}
            />
          </label>
          <label className="transform-advance-toggle">
            <input
              type="checkbox"
              checked={Boolean(t.scores.shootout)}
              onChange={(e) =>
                onChange({
                  ...t,
                  scores: {
                    ...t.scores!,
                    shootout: e.target.checked ? { home: 'homePens', away: 'awayPens' } : undefined,
                  },
                })
              }
            />
            <span>Shoot-out columns break a draw</span>
          </label>
          {t.scores.shootout && (
            <>
              <label>
                <span>Home pens</span>
                <ColumnPick
                  value={t.scores.shootout.home}
                  fallback="homePens"
                  columns={columns}
                  onChange={(home) =>
                    onChange({
                      ...t,
                      scores: {
                        ...t.scores!,
                        shootout: { ...t.scores!.shootout!, home: home ?? 'homePens' },
                      },
                    })
                  }
                />
              </label>
              <label>
                <span>Away pens</span>
                <ColumnPick
                  value={t.scores.shootout.away}
                  fallback="awayPens"
                  columns={columns}
                  onChange={(away) =>
                    onChange({
                      ...t,
                      scores: {
                        ...t.scores!,
                        shootout: { ...t.scores!.shootout!, away: away ?? 'awayPens' },
                      },
                    })
                  }
                />
              </label>
            </>
          )}
        </>
      )}

      <p className="hint">
        A match with no winner advances nobody — an unplayed slot stays blank rather than guessing.
      </p>
    </div>
  );
}

function TableSection({
  layer,
  sources,
  overflowing,
  pages,
  onPatch,
}: {
  layer: TableLayer;
  sources: Array<{ id: string; name: string; columns: DataColumn[] }>;
  overflowing: boolean;
  pages: { page: number; pageCount: number; rows: number } | undefined;
  onPatch: (patch: Partial<TableLayer>) => void;
}): JSX.Element {
  const bound = sources.find((s) => s.id === layer.source);
  // Live columns where a source is attached, the authored snapshot otherwise —
  // the author needs the keys that will actually arrive, not the placeholder.
  const columns = bound?.columns.length ? bound.columns : layer.data?.columns ?? [];
  const transforms = layer.transforms ?? [];

  const setTransform = (index: number, next: DataTransform | null) => {
    const list = [...transforms];
    if (next === null) list.splice(index, 1);
    else list[index] = next;
    onPatch({ transforms: list });
  };

  const anim = resolveRowAnim(layer.rowAnim);
  const revealSeconds = rowAnimDuration(anim, pages?.rows ?? layer.data?.rows.length ?? 0);

  return (
    <>
      <Section title="Table data">
        <Field label="Source">
          <select
            value={layer.source ?? ''}
            onChange={(e) => onPatch({ source: e.target.value || undefined })}
          >
            <option value="">— authored rows —</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Binding">
          <input
            value={layer.binding ?? ''}
            placeholder="e.g. standings"
            title="Operators can replace the whole table live from the control panel"
            onChange={(e) => onPatch({ binding: e.target.value || undefined })}
          />
        </Field>
        {layer.source && !bound && (
          <p className="hint warn">
            No data source with id <code>{layer.source}</code> in this project. The table falls back
            to its authored rows.
          </p>
        )}
        <p className="hint">
          {columns.length
            ? <>Columns: {columns.map((c) => <code key={c.key}>{c.key}</code>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ' ', el] : [el]), [])}</>
            : 'No columns yet — attach a source or paste rows into a manual table.'}
        </p>
      </Section>

      <Section title="Transforms">
        {transforms.length === 0 && <p className="hint">Rows are used in source order.</p>}

        {/*
          Not a validator error — filtering before advancing is legal and
          occasionally deliberate. But it silently resolves nothing, which is
          the kind of failure that only shows up on air, so say it here.
        */}
        {transforms.some((t, i) => t.op === 'advance' && transforms.slice(0, i).some(
          (p) => p.op === 'filter' || p.op === 'limit' || p.op === 'offset',
        )) && (
          <p className="hint warn">
            <strong>advance</strong> needs every round in the data. Anything that drops rows before
            it — filter, limit, offset — leaves it nothing to advance from. Move it to the top.
          </p>
        )}

        {transforms.map((t, i) => (
          <div key={i} className="transform-row">
            <span className="transform-op">{t.op}</span>

            {(t.op === 'sort' || t.op === 'filter') && (
              <select
                value={t.key}
                onChange={(e) => setTransform(i, { ...t, key: e.target.value })}
              >
                {columns.map((c) => <option key={c.key} value={c.key}>{c.key}</option>)}
                {!columns.some((c) => c.key === t.key) && <option value={t.key}>{t.key}</option>}
              </select>
            )}

            {t.op === 'sort' && (
              <select
                value={t.dir ?? 'asc'}
                onChange={(e) => setTransform(i, { ...t, dir: e.target.value as 'asc' | 'desc' })}
              >
                <option value="asc">ascending</option>
                <option value="desc">descending</option>
              </select>
            )}

            {t.op === 'filter' && (
              <>
                <select
                  value={t.cmp}
                  onChange={(e) => setTransform(i, { ...t, cmp: e.target.value as FilterOp })}
                >
                  {FILTER_OPS.map((op) => (
                    <option key={op} value={op}>{FILTER_LABEL[op]}</option>
                  ))}
                </select>
                {t.cmp !== 'empty' && t.cmp !== 'notEmpty' && (
                  <input
                    value={String(t.value ?? '')}
                    onChange={(e) => setTransform(i, { ...t, value: e.target.value })}
                  />
                )}
              </>
            )}

            {(t.op === 'limit' || t.op === 'offset') && (
              <input
                type="number"
                min={0}
                value={t.n}
                onChange={(e) => setTransform(i, { ...t, n: Math.max(0, Number(e.target.value)) })}
              />
            )}

            {t.op === 'rank' && (
              <input
                value={t.as ?? ''}
                placeholder="rank"
                title="Column the position is written to"
                onChange={(e) => setTransform(i, { ...t, as: e.target.value || undefined })}
              />
            )}

            {t.op === 'advance' && (
              <AdvanceFields
                t={t}
                columns={columns}
                onChange={(next) => setTransform(i, next)}
              />
            )}

            <button
              className="transform-move"
              title="Move earlier"
              disabled={i === 0}
              onClick={() => {
                const list = [...transforms];
                [list[i - 1], list[i]] = [list[i]!, list[i - 1]!];
                onPatch({ transforms: list });
              }}
            >▲</button>
            <button className="transform-del" title="Remove" onClick={() => setTransform(i, null)}>×</button>
          </div>
        ))}

        <Field label="Add">
          <select
            value=""
            onChange={(e) => {
              const op = e.target.value as DataTransform['op'];
              e.target.value = '';
              if (!op) return;
              const key = columns[0]?.key ?? '';
              const next: DataTransform =
                op === 'sort' ? { op: 'sort', key, dir: 'desc' }
                : op === 'filter' ? { op: 'filter', key, cmp: 'notEmpty' }
                : op === 'rank' ? { op: 'rank' }
                // Added bare on purpose. Every column name defaults, so an
                // ordinary bracket laid out in round order works with no
                // configuration and the fields below stay optional.
                : op === 'advance' ? { op: 'advance' }
                : { op, n: op === 'limit' ? 10 : 0 };
              // advance reads every round, so it can only ever be right at the
              // front. Appending it would put it after the filters most tables
              // already carry and resolve nothing.
              onPatch({
                transforms: op === 'advance' ? [next, ...transforms] : [...transforms, next],
              });
            }}
          >
            <option value="">+ transform…</option>
            <option value="sort">Sort</option>
            <option value="filter">Filter</option>
            <option value="rank">Rank</option>
            <option value="limit">Limit</option>
            <option value="offset">Offset</option>
            <option value="advance">Advance bracket</option>
          </select>
        </Field>
      </Section>

      <Section title="Rows">
        <Field label="Row height">
          <input
            type="number"
            min={1}
            value={layer.row.height}
            onChange={(e) =>
              onPatch({ row: { ...layer.row, height: Math.max(1, Number(e.target.value)) } })
            }
          />
        </Field>
        <Field label="Gap">
          <input
            type="number"
            min={0}
            value={layer.row.gap ?? 0}
            onChange={(e) => onPatch({ row: { ...layer.row, gap: Math.max(0, Number(e.target.value)) } })}
          />
        </Field>
        <Field label="Rows per page">
          <input
            type="number"
            min={0}
            value={layer.rowsPerPage ?? 0}
            title="0 shows every row that fits the layer box; NEXT steps through pages while the graphic holds"
            onChange={(e) => onPatch({ rowsPerPage: Math.max(0, Number(e.target.value)) || undefined })}
          />
        </Field>

        {pages && (
          <p className="hint">
            {pages.rows} rows · page {pages.page + 1} of {pages.pageCount}
          </p>
        )}
        {overflowing && (
          <p className="hint warn">
            More rows than fit. NEXT pages through them while the graphic holds — add a STOP marker
            so it has somewhere to hold, or raise the layer height.
          </p>
        )}
      </Section>

      <Section title="Row reveal">
        <Field label="Preset">
          <select
            className="reveal-preset"
            value={layer.rowAnim?.id ?? 'none'}
            onChange={(e) =>
              // Only the id is written, matching the text reveals: timings stay
              // absent so the layer follows the preset defaults until someone
              // deliberately overrides them.
              onPatch({ rowAnim: { id: e.target.value as RowAnimPresetId } })
            }
          >
            <option value="none">None</option>
            {ROW_ANIM_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.label}</option>
            ))}
          </select>
        </Field>

        {anim && (
          <>
            <Field label="Stagger">
              <input
                type="number"
                step={0.01}
                min={0}
                value={anim.stagger}
                onChange={(e) =>
                  onPatch({ rowAnim: { ...(layer.rowAnim ?? { id: anim.id }), stagger: Number(e.target.value) } })
                }
              />
            </Field>
            <Field label="Duration">
              <input
                type="number"
                step={0.05}
                min={0.01}
                value={anim.duration}
                onChange={(e) =>
                  onPatch({ rowAnim: { ...(layer.rowAnim ?? { id: anim.id }), duration: Number(e.target.value) } })
                }
              />
            </Field>
            <p className="hint">Reveal takes {revealSeconds.toFixed(2)}s at the current row count.</p>
          </>
        )}

        <Field label="Re-sort">
          <input
            type="number"
            step={0.05}
            min={0}
            value={layer.flip?.duration ?? 0.5}
            title="Seconds rows take to slide to a new order when the data re-sorts. 0 snaps."
            onChange={(e) => onPatch({ flip: { ...(layer.flip ?? {}), duration: Number(e.target.value) } })}
          />
        </Field>
      </Section>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="prop-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="prop-field">
      <span className="prop-label">{label}</span>
      <span className="prop-input">{children}</span>
    </label>
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export { NAMED_EASES };
