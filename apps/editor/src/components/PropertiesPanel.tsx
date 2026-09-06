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
import { Fragment, useEffect, useMemo, useState, type JSX } from 'react';
import {
  ADVANCE_DEFAULTS,
  ANIMATABLE_PROPS,
  CRAWL_SEPARATOR_PRESETS,
  DEFAULT_CRAWL_SEPARATOR,
  FILTER_OPS,
  NAMED_EASES,
  collectBindings,
  normalizeKey,
  type AdvanceTransform,
  type AnimatableProp,
  type AssetRef,
  type BindingDescriptor,
  type Composition,
  type CompositionLayer,
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
import { useI18n, useRichT, useT } from '@breeze/i18n/react';
import {
  ROW_ANIM_PRESETS,
  TEXT_ANIM_PRESETS,
  formatClock,
  resolveRowAnim,
  resolveTextAnim,
  rowAnimDuration,
  textAnimDuration,
  type ExpandWarning,
} from '@breeze/runtime';

import { LayerThumb } from './LayerThumb.js';
import { useEditor } from '../state/store.js';
import {
  addPoint,
  movePoint,
  parsePath,
  removePoint,
  serializePath,
  setClosed,
  smoothPoint,
  straightenPoint,
  type EditablePath,
} from '../state/path-geometry.js';
import { baselineOf, displayValue, isAnimated as propIsAnimated } from '../state/layer-values.js';

const TRANSFORM_FIELDS: Array<{ prop: AnimatableProp; labelKey: string; step: number }> = [
  { prop: 'x', labelKey: 'editor.properties.x', step: 1 },
  { prop: 'y', labelKey: 'editor.properties.y', step: 1 },
  { prop: 'scaleX', labelKey: 'editor.properties.scaleX', step: 0.01 },
  { prop: 'scaleY', labelKey: 'editor.properties.scaleY', step: 0.01 },
  { prop: 'rotation', labelKey: 'editor.properties.rotation', step: 1 },
  { prop: 'opacity', labelKey: 'editor.properties.opacity', step: 0.01 },
  { prop: 'skewX', labelKey: 'editor.properties.skewX', step: 1 },
  { prop: 'skewY', labelKey: 'editor.properties.skewY', step: 1 },
];

export function PropertiesPanel(): JSX.Element {
  const t = useT();
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
  const project = useEditor((s) => s.project);
  const expandWarnings = useEditor((s) => s.expandWarnings);

  if (!composition) return <div className="panel-empty">—</div>;
  if (!layer) {
    return (
      <div className="panel properties-panel">
        <div className="panel-header"><span>{t('editor.properties.composition')}</span></div>
        <div className="panel-body">
          <Field label={t('editor.properties.name')}>
            <input
              value={composition.name}
              onChange={(e) => run({ kind: 'renameComposition', name: e.target.value })}
            />
          </Field>
          <Field label={t('editor.properties.width')}>
            <input
              type="number"
              value={composition.stage.width}
              onChange={(e) => run({ kind: 'setStage', patch: { width: Number(e.target.value) } })}
            />
          </Field>
          <Field label={t('editor.properties.height')}>
            <input
              type="number"
              value={composition.stage.height}
              onChange={(e) => run({ kind: 'setStage', patch: { height: Number(e.target.value) } })}
            />
          </Field>
          <Field label={t('editor.properties.fps')}>
            <input
              type="number"
              value={composition.stage.fps}
              onChange={(e) => run({ kind: 'setStage', patch: { fps: Number(e.target.value) } })}
            />
          </Field>
          <Field label={t('editor.properties.duration')}>
            <input
              type="number"
              step={0.1}
              value={composition.duration ?? 0}
              onChange={(e) => run({ kind: 'setDuration', duration: Number(e.target.value) })}
            />
          </Field>
          <p className="hint">{t('editor.properties.selectALayer')}</p>
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
   * Assets offered by the mask's own image picker.
   *
   * Independent of `assetsOfKind` above: a mask can sit on any layer type,
   * not just image/video/sprite, and it always wants an `image`-kind asset
   * regardless of what the layer itself renders — a mask on a text layer
   * still masks with a picture, not with text.
   */
  const maskAssetsOfKind = assets.filter(
    (a) => (a.state !== 'retired' || a.path === layer.mask?.src) && a.kind === 'image',
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

  /**
   * The wipe reveal — MASKS.md §2.2. Six numeric fields plus two keyframes is
   * the entire content of the most common mask in broadcast, and nobody
   * builds it by typing: seed a `rect` mask the size of the layer with a
   * feather, and a two-keyframe `maskOffset` track that slides it across.
   * Ordinary fields, written once — nothing downstream knows a preset was
   * used, and the operator can hand-tune every value afterward.
   */
  const applyWipePreset = () => {
    const width = layer.size?.width ?? composition.stage.width;
    const height = layer.size?.height ?? 120;
    const feather = Math.round(Math.min(width, height) * 0.15) || 20;
    const duration = 0.6;

    patch({
      mask: { type: 'rect', x: 0, y: 0, width, height, feather },
      keyframes: {
        ...(layer.keyframes ?? {}),
        maskOffset: [
          { t: playhead, v: -width },
          { t: playhead + duration, v: 0, ease: 'power2.out' },
        ],
      },
    } as Partial<Layer>);
  };

  return (
    <div className="panel properties-panel">
      <div className="panel-header">
        <span>{layer.name ?? layer.id}</span>
        <span className="panel-sub">{layer.type}</span>
      </div>

      <div className="panel-body">
        <Section title={t('editor.properties.sectionTransform')}>
          {TRANSFORM_FIELDS.map(({ prop, labelKey, step }) => (
            <Field key={prop} label={t(labelKey)}>
              <button
                className={`stopwatch${isAnimated(prop) ? ' on' : ''}`}
                title={t(
                  isAnimated(prop)
                    ? 'editor.properties.removeKeyframes'
                    : 'editor.properties.animateProperty',
                )}
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
                  title={t(
                    hasKeyframeAtPlayhead(prop)
                      ? 'editor.properties.keyframeHere'
                      : 'editor.properties.addKeyframeHere',
                  )}
                  onClick={() => addKeyframe(prop)}
                >
                  ◆
                </button>
              )}
            </Field>
          ))}
        </Section>

        {layer.size && (
          <Section title={t('editor.properties.sectionSize')}>
            <Field label={t('editor.properties.width')}>
              <input
                type="number"
                value={layer.size.width}
                onChange={(e) => patch({ size: { ...layer.size!, width: Number(e.target.value) } })}
              />
            </Field>
            <Field label={t('editor.properties.height')}>
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
          <Section title={t('editor.properties.sectionCell')}>
            <Field label={t('editor.properties.column')}>
              <select
                value={layer.cell ?? ''}
                onChange={(e) =>
                  patch({ cell: e.target.value === '' ? undefined : e.target.value } as Partial<Layer>)
                }
              >
                <option value="">{t('editor.properties.noColumn')}</option>
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
                  <option value={layer.cell}>
                    {t('editor.properties.columnNotInSource', { key: layer.cell })}
                  </option>
                )}
              </select>
            </Field>
            <p className="hint">{t('editor.properties.cellClockHint')}</p>
          </Section>
        )}

        {/*
          Timing is a stage-layer concept. A cell has no lifetime window — the
          runtime builds its motion from `layerMotion(cell)`, which reads
          keyframes and nothing else — so offering In and Out here would write
          two numbers that are never read back.
        */}
        {!cellOwner && (
          <Section title={t('editor.properties.sectionTiming')}>
            <Field label={t('editor.properties.in')}>
              <input
                type="number"
                step={0.05}
                value={layer.in ?? 0}
                onChange={(e) => patch({ in: Number(e.target.value) })}
              />
            </Field>
            <Field label={t('editor.properties.out')}>
              <input
                type="number"
                step={0.05}
                value={layer.out ?? ''}
                placeholder={t('editor.properties.outPlaceholder')}
                onChange={(e) =>
                  patch({ out: e.target.value === '' ? undefined : Number(e.target.value) })
                }
              />
            </Field>
          </Section>
        )}

        {layer.type === 'shape' && (
          <Section title={t('editor.properties.sectionShape')}>
            <Field label={t('editor.properties.kind')}>
              <select
                value={layer.shape}
                onChange={(e) => {
                  const shape = e.target.value as 'rect' | 'ellipse' | 'path';
                  /*
                   * Switching to a path seeds geometry if there is none, for
                   * the reason the factory does: a path shape with no `path`
                   * is refused by the validator, and offering a control that
                   * makes the composition unsavable the moment it is touched
                   * is the fault this phase keeps refusing to ship.
                   */
                  patch({
                    shape,
                    ...(shape === 'path' && !layer.path
                      ? { path: seedPathIn(layer.size ?? { width: 400, height: 100 }) }
                      : {}),
                  } as Partial<Layer>);
                }}
              >
                <option value="rect">{t('editor.properties.shapeRect')}</option>
                <option value="ellipse">{t('editor.properties.shapeEllipse')}</option>
                <option value="path">{t('editor.properties.shapePath')}</option>
              </select>
            </Field>
            <Field label={t('editor.properties.fill')}>
              <input
                type="color"
                value={typeof layer.fill === 'string' ? layer.fill : '#1f6feb'}
                onChange={(e) => patch({ fill: e.target.value } as Partial<Layer>)}
              />
            </Field>
            {/*
              A path takes its outline from `stroke`, and unlike a rect it can
              legitimately have no fill at all — so the one control a drawn line
              cannot do without is offered here rather than left to JSON.
            */}
            {layer.shape === 'path' && (
              <>
                <Field label={t('editor.properties.strokeColor')}>
                  <input
                    type="color"
                    value={layer.stroke?.color ?? '#ffffff'}
                    onChange={(e) =>
                      patch({
                        stroke: { width: layer.stroke?.width ?? 2, color: e.target.value },
                      } as Partial<Layer>)
                    }
                  />
                </Field>
                <Field label={t('editor.properties.strokeWidth')}>
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={layer.stroke?.width ?? 0}
                    onChange={(e) => {
                      const width = Math.max(0, Number(e.target.value));
                      patch({
                        stroke: width
                          ? { color: layer.stroke?.color ?? '#ffffff', width }
                          : undefined,
                      } as Partial<Layer>);
                    }}
                  />
                </Field>
                <Field label={t('editor.properties.unfilled')}>
                  <input
                    type="checkbox"
                    checked={layer.fill === undefined}
                    title={t('editor.properties.unfilledTitle')}
                    onChange={(e) =>
                      patch({ fill: e.target.checked ? undefined : '#1f6feb' } as Partial<Layer>)
                    }
                  />
                </Field>
              </>
            )}
            {/* Ignored by the renderer for an ellipse and a path, so not shown. */}
            {layer.shape === 'rect' && (
              <Field label={t('editor.properties.radius')}>
                <input
                  type="number"
                  value={layer.cornerRadius ?? 0}
                  onChange={(e) => patch({ cornerRadius: Number(e.target.value) } as Partial<Layer>)}
                />
              </Field>
            )}
            {layer.shape === 'path' && (
              <PathEditor
                data={layer.path}
                onChange={(path) => patch({ path } as Partial<Layer>)}
              />
            )}
          </Section>
        )}

        {layer.type === 'text' && (
          <>
            <Section title={t('editor.properties.sectionText')}>
              <Field label={t('editor.properties.content')}>
                <textarea
                  rows={2}
                  value={layer.text}
                  onChange={(e) => patch({ text: e.target.value } as Partial<Layer>)}
                />
              </Field>
              <Field label={t('editor.properties.binding')}>
                <input
                  value={layer.binding ?? ''}
                  placeholder={t('editor.properties.bindingTextPlaceholder')}
                  title={t('editor.properties.bindingTextTitle')}
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
            <Section title={t('editor.properties.sectionFitWidth')}>
              <Field label={t('editor.properties.mode')}>
                <select
                  value={layer.fit?.mode ?? 'none'}
                  onChange={(e) =>
                    patch({
                      fit: { ...(layer.fit ?? {}), mode: e.target.value as 'none' | 'width' },
                    } as Partial<Layer>)
                  }
                >
                  <option value="none">{t('editor.properties.fitNone')}</option>
                  <option value="width">{t('editor.properties.fitWidth')}</option>
                </select>
              </Field>
              <Field label={t('editor.properties.maxWidth')}>
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
              <Field label={t('editor.properties.minScale')}>
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
                  {t('editor.properties.fitOverflow')}
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
            <Section title={t('editor.properties.sectionCrawl')}>
              <Field label={t('editor.properties.speed')}>
                <input
                  type="number"
                  step={10}
                  min={1}
                  value={layer.speed}
                  title={t('editor.properties.speedTitle')}
                  onChange={(e) =>
                    patch({ speed: Math.max(1, Number(e.target.value)) } as Partial<Layer>)
                  }
                />
              </Field>
              <Field label={t('editor.properties.direction')}>
                <select
                  value={layer.direction}
                  onChange={(e) =>
                    patch({ direction: e.target.value as 'left' | 'right' } as Partial<Layer>)
                  }
                >
                  <option value="left">{t('editor.properties.directionRtl')}</option>
                  <option value="right">{t('editor.properties.directionLtr')}</option>
                </select>
              </Field>
              <CrawlSeparatorField
                value={layer.separator}
                onChange={(separator) => patch({ separator } as Partial<Layer>)}
              />
              <Field label={t('editor.properties.binding')}>
                <input
                  value={layer.binding ?? ''}
                  placeholder={t('editor.properties.bindingCrawlPlaceholder')}
                  title={t('editor.properties.bindingCrawlTitle')}
                  onChange={(e) =>
                    patch({ binding: e.target.value || undefined } as Partial<Layer>)
                  }
                />
              </Field>
              <Field label={t('editor.properties.items')}>
                <textarea
                  rows={4}
                  value={layer.items.join('\n')}
                  title={t('editor.properties.itemsTitle')}
                  onChange={(e) =>
                    patch({
                      // Blank lines dropped: an empty item renders as two
                      // separators with nothing between them.
                      items: e.target.value.split('\n').filter((line) => line.trim() !== ''),
                    } as Partial<Layer>)
                  }
                />
              </Field>
              <p className="hint">{t('editor.properties.itemsHint')}</p>
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
          <NestedCompositionSection
            layer={layer}
            selfId={composition.id}
            compositions={project?.compositions ?? []}
            assets={assets}
            warnings={expandWarnings}
            onPatch={(p) => patch(p as Partial<Layer>)}
          />
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
          <Section title={t('editor.properties.sectionSource')}>
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
            <Field label={t('editor.properties.asset')}>
              <select
                value={assetsOfKind.some((a) => a.path === layer.src) ? layer.src : ''}
                onChange={(e) => {
                  if (e.target.value) patch({ src: e.target.value } as Partial<Layer>);
                }}
              >
                <option value="">
                  {assetsOfKind.length
                    ? t('editor.properties.pickAnAsset')
                    // A sprite draws from the image assets, so "no sprite
                    // assets uploaded" would send the operator looking for a
                    // kind of file the bin does not have.
                    : t('editor.properties.noAssetsOfKind', {
                        kind: layer.type === 'sprite' ? 'image' : layer.type,
                      })}
                </option>
                {assetsOfKind.map((a) => (
                  <option key={a.id} value={a.path}>{a.originalName ?? a.path}</option>
                ))}
              </select>
            </Field>
            <Field label={t('editor.properties.path')}>
              <input
                value={layer.src}
                placeholder={t('editor.properties.pathPlaceholder')}
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
              <p className="hint">{t('editor.properties.notInBin')}</p>
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
              <Field label={t('editor.properties.binding')}>
                <input
                  value={layer.binding ?? ''}
                  onChange={(e) => patch({ binding: e.target.value || undefined } as Partial<Layer>)}
                />
              </Field>
            )}
            {layer.type === 'sprite' && layer.cols * layer.rows > 1 && (
              <p className="hint">{t('editor.properties.spriteNoBinding')}</p>
            )}

            {layer.type === 'sprite' && (
              <>
                <Field label={t('editor.properties.columns')}>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={layer.cols}
                    onChange={(e) => patch({ cols: Math.max(1, Math.round(Number(e.target.value))) } as Partial<Layer>)}
                  />
                </Field>
                <Field label={t('editor.properties.rows')}>
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
                <Field label={t('editor.properties.frames')}>
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
                    {t('editor.properties.framesOverGrid', {
                      cells: layer.cols * layer.rows,
                      cols: layer.cols,
                      rows: layer.rows,
                    })}
                  </p>
                )}
                <Field label={t('editor.properties.fps')}>
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
                  {t('editor.properties.spriteTiming', {
                    frames: layer.frameCount ?? layer.cols * layer.rows,
                    fps: layer.fps,
                    seconds: ((layer.frameCount ?? layer.cols * layer.rows) / layer.fps).toFixed(2),
                  })}
                </p>
              </>
            )}

            {(layer.type === 'video' || layer.type === 'sprite') && (
              <>
                <Field label={t('editor.properties.startAt')}>
                  <input
                    type="number"
                    step={0.1}
                    value={layer.startAt ?? 0}
                    onChange={(e) => patch({ startAt: Number(e.target.value) } as Partial<Layer>)}
                  />
                </Field>
                <Field label={t('editor.properties.loop')}>
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
                  <Field label={t('editor.properties.atEnd')}>
                    <select
                      value={layer.onEnd ?? 'hold'}
                      onChange={(e) => patch({ onEnd: e.target.value as 'hold' | 'clear' } as Partial<Layer>)}
                    >
                      <option value="hold">{t('editor.properties.onEndHold')}</option>
                      <option value="clear">{t('editor.properties.onEndClear')}</option>
                    </select>
                  </Field>
                )}
                {!layer.loop && layer.onEnd !== 'clear' && (
                  <p className="hint">{t('editor.properties.stingerHint')}</p>
                )}
                {/*
                  A layer pointing at a format that cannot carry transparency.

                  Silent otherwise, and it is the defect this whole phase
                  exists to prevent: the graphic looks right in the editor,
                  over the editor's own background, and goes to air as a black
                  box over live pictures.
                */}
                {layer.src && /\.(mov|mp4|m4v)$/i.test(layer.src) && (
                  <p className="hint">{t('editor.properties.noAlphaHint')}</p>
                )}
              </>
            )}
          </Section>
        )}

        <Section title={t('editor.properties.sectionEffects')}>
          <Field label={t('editor.properties.blur')}>
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
          <Field label={t('editor.properties.brightness')}>
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
          {(
            [
              { prop: 'contrast', labelKey: 'editor.properties.contrast', step: 0.05 },
              { prop: 'saturate', labelKey: 'editor.properties.saturate', step: 0.05 },
              { prop: 'hueRotate', labelKey: 'editor.properties.hueRotate', step: 1 },
              { prop: 'grayscale', labelKey: 'editor.properties.grayscale', step: 0.05 },
              { prop: 'sepia', labelKey: 'editor.properties.sepia', step: 0.05 },
            ] as const
          ).map(({ prop, labelKey, step }) => (
            <Field key={prop} label={t(labelKey)}>
              <button
                className={`stopwatch${isAnimated(prop) ? ' on' : ''}`}
                onClick={() => toggleKeyframe(prop)}
              >⏱</button>
              <input
                type="number"
                step={step}
                value={round(displayValue(layer, prop, playhead))}
                onChange={(e) => setValue(prop, Number(e.target.value))}
              />
            </Field>
          ))}
          <Field label={t('editor.properties.blend')}>
            <select
              value={layer.blendMode ?? 'normal'}
              onChange={(e) => patch({ blendMode: e.target.value === 'normal' ? undefined : e.target.value })}
            >
              {['normal', 'multiply', 'screen', 'overlay', 'lighten', 'darken', 'difference'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Field>
          {/*
            Drop shadow stays a static baseline, deliberately (MASKS.md §3.2):
            a keyframe track is scalars, a shadow is a 4-tuple, and four rows
            in the timeline for one visual property is not worth it for an
            effect whose broadcast use is a static lift off a busy plate.
          */}
          <Field label={t('editor.properties.dropShadowColor')}>
            <input
              type="color"
              value={layer.effects?.dropShadow?.color ?? '#000000'}
              onChange={(e) =>
                patch({
                  effects: {
                    ...(layer.effects ?? {}),
                    dropShadow: {
                      offsetX: layer.effects?.dropShadow?.offsetX ?? 4,
                      offsetY: layer.effects?.dropShadow?.offsetY ?? 4,
                      blur: layer.effects?.dropShadow?.blur ?? 6,
                      ...layer.effects?.dropShadow,
                      color: e.target.value,
                    },
                  },
                })
              }
            />
            {layer.effects?.dropShadow && (
              <button
                className="linkish"
                onClick={() =>
                  patch({ effects: { ...(layer.effects ?? {}), dropShadow: undefined } })
                }
              >
                {t('editor.properties.dropShadowRemove')}
              </button>
            )}
          </Field>
          {layer.effects?.dropShadow && (
            <>
              <Field label={t('editor.properties.dropShadowOffsetX')}>
                <input
                  type="number"
                  value={layer.effects.dropShadow.offsetX}
                  onChange={(e) =>
                    patch({
                      effects: {
                        ...layer.effects,
                        dropShadow: { ...layer.effects!.dropShadow!, offsetX: Number(e.target.value) },
                      },
                    })
                  }
                />
              </Field>
              <Field label={t('editor.properties.dropShadowOffsetY')}>
                <input
                  type="number"
                  value={layer.effects.dropShadow.offsetY}
                  onChange={(e) =>
                    patch({
                      effects: {
                        ...layer.effects,
                        dropShadow: { ...layer.effects!.dropShadow!, offsetY: Number(e.target.value) },
                      },
                    })
                  }
                />
              </Field>
              <Field label={t('editor.properties.dropShadowBlur')}>
                <input
                  type="number"
                  min={0}
                  value={layer.effects.dropShadow.blur}
                  onChange={(e) =>
                    patch({
                      effects: {
                        ...layer.effects,
                        dropShadow: { ...layer.effects!.dropShadow!, blur: Math.max(0, Number(e.target.value)) },
                      },
                    })
                  }
                />
              </Field>
            </>
          )}
        </Section>

        <MaskSection
          layer={layer}
          playhead={playhead}
          maskAssets={maskAssetsOfKind}
          allAssets={assets}
          isAnimated={isAnimated}
          toggleKeyframe={toggleKeyframe}
          setValue={setValue}
          onPatch={patch}
          onWipePreset={applyWipePreset}
        />

        <details className="raw-json">
          <summary>{t('editor.properties.animatedProperties')}</summary>
          <ul>
            {ANIMATABLE_PROPS.filter((p) => isAnimated(p)).map((p) => (
              <li key={p}>
                {t('editor.properties.keyframeCount', {
                  prop: p,
                  count: layer.keyframes?.[p]?.length ?? 0,
                })}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}

/**
 * Seed geometry for a path that does not have any yet — a triangle inscribed
 * in the layer's box.
 *
 * Duplicated from the factory's `defaultPathIn` rather than exported from
 * `@breeze/schema`, and that is the wrong trade at three lines: this one exists
 * so the *panel* never writes an invalid document, and the factory's exists so
 * a *created layer* is valid. If a third caller appears, move it.
 */
function seedPathIn(size: { width: number; height: number }): string {
  return `M 0 ${size.height} L ${size.width / 2} 0 L ${size.width} ${size.height} Z`; // i18n-ignore — SVG path data
}

/**
 * Path authoring — the numeric half of the pen tool (MASKS.md §5).
 *
 * Serves a path `ShapeLayer` and a `LayerMask` of type `path` from one
 * component, because both carry the same `d` in the same coordinate space.
 *
 * **The raw `d` field is always present, and the point list is the assist on
 * top of it.** Same shape as the asset picker with its path field beneath:
 * the structured control is what anyone should use, and the text field is what
 * makes a path from Illustrator, a hand-tuned curve or anything else outside
 * the editable subset still authorable here rather than only in JSON.
 *
 * When `parsePath` returns `null` the point list is withheld and says why. It
 * must never "fix" what it cannot read: a path this editor rewrote into an
 * approximation of itself would lose work silently, which is worse than a
 * text box.
 */
function PathEditor({
  data,
  onChange,
}: {
  data: string | undefined;
  onChange: (d: string) => void;
}): JSX.Element {
  const t = useT();

  /*
   * Held as text while it is being typed, so a half-finished command is not
   * parsed, re-serialised and handed back mid-keystroke — the same reason the
   * crawl separator keeps its own draft state.
   */
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [data]);

  const parsed = useMemo(() => parsePath(data), [data]);
  const write = (path: EditablePath) => onChange(serializePath(path));

  return (
    <>
      <Field label={t('editor.properties.pathData')}>
        <textarea
          rows={2}
          className="path-data"
          value={draft ?? data ?? ''}
          placeholder={t('editor.properties.pathDataPlaceholder')}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== null && draft !== data) onChange(draft);
            setDraft(null);
          }}
        />
      </Field>

      {!parsed ? (
        <p className="hint">{t('editor.properties.pathNotEditable')}</p>
      ) : (
        <>
          <Field label={t('editor.properties.pathClosed')}>
            <input
              type="checkbox"
              checked={parsed.closed}
              title={t('editor.properties.pathClosedTitle')}
              onChange={(e) => write(setClosed(parsed, e.target.checked))}
            />
          </Field>

          <h4 className="prop-subhead">
            {t('editor.properties.pathPoints', { count: parsed.points.length })}
          </h4>

          {parsed.points.map((point, i) => (
            <Field key={i} label={t('editor.properties.pathPoint', { index: i + 1 })}>
              <input
                type="number"
                className="path-coord"
                value={round(point.x)}
                onChange={(e) => write(movePoint(parsed, i, { x: Number(e.target.value), y: point.y }))}
              />
              <input
                type="number"
                className="path-coord"
                value={round(point.y)}
                onChange={(e) => write(movePoint(parsed, i, { x: point.x, y: Number(e.target.value) }))}
              />
              {/*
                Curve/corner is a toggle rather than four handle fields. The
                handles are worth dragging and not worth typing: nobody knows
                what control point (317.4, 88.2) does until they see it, which
                is exactly the argument for the on-stage surface and against
                putting the same numbers in a panel.
              */}
              <button
                className={`path-btn${point.in || point.out ? ' on' : ''}`}
                title={t(
                  point.in || point.out
                    ? 'editor.properties.pathCornerTitle'
                    : 'editor.properties.pathSmoothTitle',
                )}
                onClick={() =>
                  write(point.in || point.out ? straightenPoint(parsed, i) : smoothPoint(parsed, i))
                }
              >
                {point.in || point.out ? '⌒' : '⌐'}
              </button>
              <button
                className="path-btn"
                title={t('editor.properties.pathRemovePoint')}
                // Below three points there is no path left to remove one from,
                // and a disabled button says so better than a no-op.
                disabled={parsed.points.length <= 2}
                onClick={() => write(removePoint(parsed, i))}
              >
                ✕
              </button>
            </Field>
          ))}

          <button
            className="mask-preset-btn"
            title={t('editor.properties.pathAddPointTitle')}
            onClick={() => {
              /*
               * Appended at the last point rather than at the origin, so a new
               * anchor lands somewhere visible and near what the author was
               * just working on instead of at the layer's corner.
               */
              const last = parsed.points[parsed.points.length - 1];
              write(addPoint(parsed, { x: (last?.x ?? 0) + 40, y: (last?.y ?? 0) + 40 }));
            }}
          >
            {t('editor.properties.pathAddPoint')}
          </button>
        </>
      )}
    </>
  );
}

/**
 * The nested-composition panel — MASKS.md Wave C.
 *
 * Nesting itself was finished in Phase 6.5: `expand.ts` flattens, guards cycles
 * and caps depth, and thumbnails, bundles and the usage index all understand a
 * `composition` layer. One field was never authorable — `overrides` — and it is
 * the field the whole phase's accept criterion turns on. A reusable badge comp
 * is only reusable if two mounts of it can show different badges.
 */
function NestedCompositionSection({
  layer,
  selfId,
  compositions,
  assets,
  warnings,
  onPatch,
}: {
  layer: CompositionLayer;
  /** The composition being edited, so it cannot be offered as its own child. */
  selfId: string;
  compositions: Composition[];
  assets: AssetRef[];
  warnings: ExpandWarning[];
  onPatch: (patch: Partial<CompositionLayer>) => void;
}): JSX.Element {
  const t = useT();

  const child = compositions.find((c) => c.id === layer.ref);

  /*
   * `collectBindings` already answers "what can an operator type into this
   * composition", which is exactly the list of things a mount of it can pin.
   * Deriving the panel from it rather than from a second walk is what keeps
   * the override editor and the operator's own control panel offering the
   * same fields.
   */
  const allBindings = useMemo(() => (child ? collectBindings(child) : []), [child]);

  /*
   * Table data is excluded, deliberately, and the exclusion is written down in
   * MASKS.md rather than left to be rediscovered.
   *
   * A `dataset` binding's value is a whole `{ columns, rows }` document. Ticking
   * an override for one would pin it — meaningful in principle — but this panel
   * has nowhere to *show* what it pinned, and a control that writes a value the
   * author cannot see or edit is the exact shape of the fields this phase exists
   * to stop shipping. Tables are driven by a data source or by the operator
   * panel's grid, both of which already exist and both of which show the rows.
   */
  const bindings = allBindings.filter((b) => b.kind !== 'dataset');
  const datasetBindings = allBindings.filter((b) => b.kind === 'dataset');

  /*
   * Warnings are keyed by *instance* id, so a comp inside a group reads
   * `group/badge` and one two levels down reads `outer/inner` — matched on the
   * trailing segment rather than by equality, or a grouped layer would never
   * match its own warning.
   *
   * Not exact, and knowingly so: a nested comp that happens to share an id with
   * this one would match too. The cost is showing a real warning about the same
   * graphic beside the wrong layer; the alternative is walking `plan.instances`
   * to prove which side of a composition boundary each id came from, which is a
   * lot of machinery for an amber hint.
   */
  const own = warnings.filter(
    (w) => w.layerId === layer.id || w.layerId.endsWith(`/${layer.id}`),
  );

  const overrides = layer.overrides ?? {};
  const isOverridden = (name: string): boolean => name in overrides;

  const setOverride = (name: string, value: unknown): void => {
    onPatch({ overrides: { ...overrides, [name]: value } });
  };

  const clearOverride = (name: string): void => {
    const next = { ...overrides };
    delete next[name];
    /*
     * An empty map is written as an absent field, the same rule the mask panel
     * follows: one representation of "nothing set", not two for every reader
     * downstream to handle.
     */
    onPatch({ overrides: Object.keys(next).length ? next : undefined });
  };

  return (
    <Section title={t('editor.properties.composition')}>
      {/*
        The picker, with the free-text id kept below it — the same shape the
        asset section uses, for the same reason: the picker is what anyone
        should use, and the text field is the escape hatch for a composition
        that is not in this project yet.
      */}
      <Field label={t('editor.properties.reference')}>
        <select
          value={compositions.some((c) => c.id === layer.ref) ? layer.ref : ''}
          onChange={(e) => {
            if (e.target.value) onPatch({ ref: e.target.value });
          }}
        >
          <option value="">
            {compositions.length > 1
              ? t('editor.properties.pickAComposition')
              : t('editor.properties.noOtherCompositions')}
          </option>
          {compositions
            // A composition cannot mount itself; the validator refuses it, so
            // it is not offered.
            .filter((c) => c.id !== selfId)
            .map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
        </select>
      </Field>
      <Field label={t('editor.properties.referenceId')}>
        <input
          value={layer.ref}
          placeholder={t('editor.properties.referencePlaceholder')}
          onChange={(e) => onPatch({ ref: e.target.value })}
        />
      </Field>


      {/*
        The expander's own complaints about this layer — an unresolved ref, a
        cycle, a depth cut-off. `TimelinePlan.warnings` has carried these since
        Phase 6.5 under a comment saying the editor surfaced them; until Wave C
        the only place they went was the browser console. Every one of them
        renders on air as a graphic that is simply missing, with nothing
        anywhere saying why.
      */}
      {own.map((w, i) => (
        <p className="prop-warning" key={i}>{w.message}</p>
      ))}

      {child && (
        <div className="comp-ref-preview">
          {/*
            The same still the layers panel draws, at panel size — including
            its hover preview. Built in 0.68.4 and, until now, visible in
            exactly one place.
          */}
          <LayerThumb layer={layer} size={64} />
          <span className="comp-ref-name">{child.name}</span>
        </div>
      )}

      {/*
        Independent turns a nested composition into its own graphic on its own
        control channel, instead of inlining it into this timeline. A
        composition holding independent children is what the guide calls a
        scene — there is no separate scene type to create.
      */}
      <Field label={t('editor.properties.independent')}>
        <input
          type="checkbox"
          checked={layer.independent ?? false}
          title={t('editor.properties.independentTitle')}
          onChange={(e) => {
            const independent = e.target.checked;
            /*
             * Clearing keyframes, the lifetime window and now `overrides` is
             * not tidiness — the validator rejects all three on an independent
             * layer, so leaving them behind would make the composition
             * unsavable the moment the box is ticked, with the error pointing
             * at fields the author did not just touch.
             */
            onPatch(
              independent
                ? {
                    independent: true,
                    keyframes: undefined,
                    in: undefined,
                    out: undefined,
                    overrides: undefined,
                  }
                : { independent: undefined, channel: undefined },
            );
          }}
        />
      </Field>
      {layer.independent && (
        <Field label={t('editor.properties.channel')}>
          <input
            value={layer.channel ?? ''}
            placeholder={layer.ref}
            title={t('editor.properties.channelTitle')}
            onChange={(e) => {
              // Normalized as typed rather than validated on save: the rules
              // are the URL's, not this field's, and an operator typing "Bug"
              // should get a working channel, not a refusal.
              const next = normalizeKey(e.target.value);
              onPatch({ channel: next || undefined });
            }}
          />
        </Field>
      )}

      {/* ------------------------------------------------------ overrides */}

      {layer.independent ? (
        /*
         * Withheld rather than shown and refused on save, the same call the
         * sprite binding field gets: expansion stops at an independent layer
         * and `sceneElements` carries no values, so an override here would be
         * read by nothing at all. A field that can only ever produce an
         * invalid document should not be offered.
         */
        <p className="hint">{t('editor.properties.overridesIndependent')}</p>
      ) : !child ? null : bindings.length === 0 ? (
        <p className="hint">
          {datasetBindings.length
            ? t('editor.properties.overrideDataset')
            : t('editor.properties.overridesNone', { name: child.name })}
        </p>
      ) : (
        <>
          <h4 className="prop-subhead">{t('editor.properties.overrides')}</h4>
          {/*
            The distinction this whole editor exists to preserve: an absent
            override means "whatever the child was authored with", and an
            override set to `''` is a deliberate blank on air. Storing both as
            an empty string would make the badge with no subtitle
            indistinguishable from the badge nobody has configured yet — so
            the checkbox owns the key's existence and the field owns its value,
            including the empty one.
          */}
          {/*
            The address is shown, not hidden, because it is the half of this
            feature an author has to hand to somebody else: an overridden field
            is reachable live at `<mount>.<binding>`, and an operator building a
            Companion button needs to be told what to type.
          */}
          {bindings.map((b) => (
            <Fragment key={b.name}>
              <Field
                label={b.label}
                {...(isOverridden(b.name)
                  ? { hint: `${layer.id}.${b.name}` }
                  : {})}
              >
                <input
                  type="checkbox"
                  className="override-toggle"
                  checked={isOverridden(b.name)}
                  title={t(
                    isOverridden(b.name)
                      ? 'editor.properties.overrideInheritTitle'
                      : 'editor.properties.overrideSetTitle',
                  )}
                  onChange={(e) =>
                    e.target.checked
                      // Seeded from the child's own authored value, so ticking
                      // the box pins what is already on screen rather than
                      // blanking it. Pinning alone is meaningful: a pinned
                      // field stops answering the parent's `update()`.
                      ? setOverride(b.name, b.defaultValue)
                      : clearOverride(b.name)
                  }
                />
                <OverrideValue
                  binding={b}
                  value={overrides[b.name]}
                  enabled={isOverridden(b.name)}
                  assets={assets}
                  onChange={(v) => setOverride(b.name, v)}
                />
              </Field>
            </Fragment>
          ))}
          {datasetBindings.length > 0 && (
            <p className="hint">{t('editor.properties.overrideDataset')}</p>
          )}
        </>
      )}
    </Section>
  );
}

/**
 * One override's value field, by binding kind.
 *
 * Disabled until the field is actually overridden, showing the child's
 * authored value as its placeholder — so "inherit" reads as the value that
 * will be used rather than as an empty box.
 */
function OverrideValue({
  binding,
  value,
  enabled,
  assets,
  onChange,
}: {
  binding: BindingDescriptor;
  value: unknown;
  enabled: boolean;
  assets: AssetRef[];
  onChange: (value: unknown) => void;
}): JSX.Element {
  const t = useT();
  const placeholder = enabled ? '' : describeDefault(binding.defaultValue);

  if (binding.kind === 'dataset') {
    /*
     * Unreachable while the section filters dataset bindings out of the rows,
     * and kept anyway as the guard for that filter: if the exclusion is ever
     * lifted, this says so rather than rendering `[object Object]` into a text
     * box and writing it back on the next keystroke.
     */
    return <span className="hint">{t('editor.properties.overrideDataset')}</span>;
  }

  if (binding.kind === 'stringList') {
    const lines = Array.isArray(value) ? value.map((v) => String(v)).join('\n') : '';
    return (
      <textarea
        rows={2}
        disabled={!enabled}
        value={enabled ? lines : ''}
        placeholder={placeholder}
        title={t('editor.properties.itemsTitle')}
        // Split on write, so an empty line in the middle survives editing and
        // the value stays the `string[]` the crawl expects.
        onChange={(e) => onChange(e.target.value.split('\n'))}
      />
    );
  }

  if (binding.kind === 'image' || binding.kind === 'video') {
    const kind = binding.kind === 'image' ? 'image' : 'video';
    const usable = assets.filter((a) => a.kind === kind || a.kind === 'other');
    const current = typeof value === 'string' ? value : '';
    return (
      <select
        disabled={!enabled}
        value={usable.some((a) => a.path === current) ? current : ''}
        onChange={(e) => { if (e.target.value) onChange(e.target.value); }}
      >
        <option value="">
          {usable.length
            ? t('editor.properties.pickAnAsset')
            : t('editor.properties.noAssetsOfKind', { kind })}
        </option>
        {usable.map((a) => (
          <option key={a.id} value={a.path}>{a.originalName ?? a.path}</option>
        ))}
      </select>
    );
  }

  return (
    <input
      disabled={!enabled}
      value={enabled ? String(value ?? '') : ''}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** The child's authored value, shortened for a placeholder. */
function describeDefault(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(' · ').slice(0, 60);
  if (typeof value === 'object') return '';
  return String(value).slice(0, 60);
}

/**
 * Mask authoring — MASKS.md Wave A.
 *
 * `packages/runtime/src/mask.ts` has rendered `rect`/`ellipse`/`image` masks,
 * feathered and invertible, since Phase 1; this is the first panel that can
 * write `layer.mask` at all. Shown for every layer type — masks are a
 * `LayerBase` field and there is no type they are wrong for.
 */
function MaskSection({
  layer,
  playhead,
  maskAssets,
  allAssets,
  isAnimated,
  toggleKeyframe,
  setValue,
  onPatch,
  onWipePreset,
}: {
  layer: Layer;
  playhead: number;
  maskAssets: AssetRef[];
  allAssets: AssetRef[];
  isAnimated: (prop: AnimatableProp) => boolean;
  toggleKeyframe: (prop: AnimatableProp) => void;
  setValue: (prop: AnimatableProp, value: number) => void;
  onPatch: (patch: Partial<Layer>) => void;
  onWipePreset: () => void;
}): JSX.Element {
  const t = useT();
  const mask = layer.mask;

  const setMask = (patch: Partial<NonNullable<Layer['mask']>>) => {
    if (!mask) return;
    onPatch({ mask: { ...mask, ...patch } });
  };

  return (
    <Section title={t('editor.properties.sectionMask')}>
      <Field label={t('editor.properties.maskType')}>
        <select
          value={mask?.type ?? 'none'}
          onChange={(e) => {
            const type = e.target.value as 'none' | 'rect' | 'ellipse' | 'image' | 'path';
            if (type === 'none') {
              // The schema's own representation of "no mask" is the field
              // being absent — writing a `{ type: 'none' }` sentinel would
              // give every reader two ways to say the same thing.
              onPatch({ mask: undefined });
              return;
            }
            const size = { width: layer.size?.width ?? 200, height: layer.size?.height ?? 200 };
            onPatch({
              mask: {
                type,
                x: mask?.x ?? 0,
                y: mask?.y ?? 0,
                width: mask?.width ?? size.width,
                height: mask?.height ?? size.height,
                ...(mask?.feather !== undefined ? { feather: mask.feather } : {}),
                ...(mask?.invert !== undefined ? { invert: mask.invert } : {}),
                ...(type === 'image' && mask?.src !== undefined ? { src: mask.src } : {}),
                // Seeded for the same reason the shape picker seeds one: a path
                // mask with no data is refused by the validator, and the box it
                // starts from should at least be the layer.
                ...(type === 'path' ? { path: mask?.path ?? seedPathIn(size) } : {}),
              },
            });
          }}
        >
          <option value="none">{t('editor.properties.maskNone')}</option>
          <option value="rect">{t('editor.properties.maskRect')}</option>
          <option value="ellipse">{t('editor.properties.maskEllipse')}</option>
          <option value="image">{t('editor.properties.maskImage')}</option>
          <option value="path">{t('editor.properties.maskPath')}</option>
        </select>
      </Field>

      {mask && (
        <>
          <Field label={t('editor.properties.x')}>
            <input
              type="number"
              value={mask.x}
              onChange={(e) => setMask({ x: Number(e.target.value) })}
            />
          </Field>
          <Field label={t('editor.properties.y')}>
            <input
              type="number"
              value={mask.y}
              onChange={(e) => setMask({ y: Number(e.target.value) })}
            />
          </Field>
          {/*
            Withheld for a path, where the renderer reads neither: the geometry
            is all in `d` and `x`/`y` above merely translate it. Leaving two
            live number fields that move nothing would be the same "field that
            does nothing" this phase has now found three times.
          */}
          {mask.type !== 'path' && (
            <>
              <Field label={t('editor.properties.width')}>
                <input
                  type="number"
                  min={0}
                  value={mask.width}
                  onChange={(e) => setMask({ width: Math.max(0, Number(e.target.value)) })}
                />
              </Field>
              <Field label={t('editor.properties.height')}>
                <input
                  type="number"
                  min={0}
                  value={mask.height}
                  onChange={(e) => setMask({ height: Math.max(0, Number(e.target.value)) })}
                />
              </Field>
            </>
          )}
          <Field label={t('editor.properties.maskFeather')}>
            <input
              type="number"
              min={0}
              value={mask.feather ?? 0}
              onChange={(e) => {
                const v = Number(e.target.value);
                setMask({ feather: v > 0 ? v : undefined });
              }}
            />
          </Field>
          <Field label={t('editor.properties.maskInvert')}>
            <input
              type="checkbox"
              checked={mask.invert ?? false}
              onChange={(e) => setMask({ invert: e.target.checked || undefined })}
            />
          </Field>

          {mask.type === 'image' && (
            <>
              <Field label={t('editor.properties.asset')}>
                <select
                  value={maskAssets.some((a) => a.path === mask.src) ? mask.src : ''}
                  onChange={(e) => {
                    if (e.target.value) setMask({ src: e.target.value });
                  }}
                >
                  <option value="">
                    {maskAssets.length
                      ? t('editor.properties.pickAnAsset')
                      : t('editor.properties.noAssetsOfKind', { kind: 'image' })}
                  </option>
                  {maskAssets.map((a) => (
                    <option key={a.id} value={a.path}>{a.originalName ?? a.path}</option>
                  ))}
                </select>
              </Field>
              {!mask.src && (
                <p className="hint">{t('editor.properties.maskImageRequiresSrc')}</p>
              )}
              {mask.src && !allAssets.some((a) => a.path === mask.src) && (
                <p className="hint">{t('editor.properties.notInBin')}</p>
              )}
            </>
          )}

          <Field label={t('editor.properties.maskOffset')}>
            <button
              className={`stopwatch${isAnimated('maskOffset') ? ' on' : ''}`}
              onClick={() => toggleKeyframe('maskOffset')}
            >⏱</button>
            <input
              type="number"
              step={1}
              value={round(displayValue(layer, 'maskOffset', playhead))}
              onChange={(e) => setValue('maskOffset', Number(e.target.value))}
            />
          </Field>

          {/*
            The same editor the path *shape* gets, on the same `d` in the same
            coordinate space — which is the entire reason `LayerMask.type:
            'path'` reuses the shape's string rather than inventing a mask
            geometry of its own (MASKS.md §5).
          */}
          {mask.type === 'path' && (
            <PathEditor data={mask.path} onChange={(path) => setMask({ path })} />
          )}
        </>
      )}

      {/*
        Always available, mask or no mask — MASKS.md §2.2. It writes the mask
        outright (a `rect` sized to the layer) rather than requiring one to
        already exist, since the whole point is to skip typing six fields by
        hand.
      */}
      <button className="mask-preset-btn" onClick={onWipePreset}>
        {t('editor.properties.maskWipePreset')}
      </button>
    </Section>
  );
}

function TextStyleSection({
  style,
  onChange,
}: {
  style: TextStyle;
  onChange: (style: TextStyle) => void;
}): JSX.Element {
  const t = useT();
  const set = (patch: Partial<TextStyle>) => onChange({ ...style, ...patch });

  return (
    <Section title={t('editor.properties.sectionType')}>
      <Field label={t('editor.properties.font')}>
        <input value={style.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })} />
      </Field>
      <Field label={t('editor.properties.size')}>
        <input type="number" value={style.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
      </Field>
      <Field label={t('editor.properties.weight')}>
        <select value={String(style.fontWeight ?? 400)} onChange={(e) => set({ fontWeight: Number(e.target.value) })}>
          {[300, 400, 500, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      </Field>
      <Field label={t('editor.properties.color')}>
        <input
          type="color"
          value={typeof style.fill === 'string' ? style.fill : '#ffffff'}
          onChange={(e) => set({ fill: e.target.value })}
        />
      </Field>
      <Field label={t('editor.properties.tracking')}>
        <input
          type="number"
          step={0.1}
          value={style.letterSpacing ?? 0}
          onChange={(e) => set({ letterSpacing: Number(e.target.value) })}
        />
      </Field>
      <Field label={t('editor.properties.align')}>
        <select value={style.align ?? 'left'} onChange={(e) => set({ align: e.target.value as TextStyle['align'] })}>
          <option value="left">{t('editor.properties.alignLeft')}</option>
          <option value="center">{t('editor.properties.alignCenter')}</option>
          <option value="right">{t('editor.properties.alignRight')}</option>
        </select>
      </Field>
      <Field label={t('editor.properties.case')}>
        <select
          value={style.textTransform ?? 'none'}
          onChange={(e) => set({ textTransform: e.target.value as TextStyle['textTransform'] })}
        >
          <option value="none">{t('editor.properties.caseNone')}</option>
          <option value="uppercase">{t('editor.properties.caseUpper')}</option>
          <option value="lowercase">{t('editor.properties.caseLower')}</option>
          <option value="capitalize">{t('editor.properties.caseCapitalize')}</option>
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
 *
 * Format strings only. Each option is labelled by running the real formatter
 * over the real current time in this clock's own language and zone, so the
 * picker cannot promise something the output does not deliver — which is
 * exactly what a hardcoded `Mon 3 Aug` started doing the moment the language
 * became selectable.
 */
// i18n-ignore-start — token strings, identical in every locale; see CLOCK_TOKENS
const CLOCK_FORMATS = [
  'h:mm A',
  'h:mm:ss A',
  'HH:mm',
  'HH:mm:ss',
  'ddd D MMM',
  'dddd, MMMM D',
  'DD/MM/YY',
];
// i18n-ignore-end

/**
 * Languages offered for a clock's month and weekday names.
 *
 * The UI locale set from I18N.md §8, reused because it is the same judgement —
 * these are the languages Breeze considers relevant — but the two are not the
 * same setting and must not be wired together. A station whose crew work in
 * English still broadcasts in its own language, and two graphics on one server
 * can differ.
 *
 * Names come from `Intl.DisplayNames` rather than a hand-written table: 28
 * language names would otherwise be 28 catalogue entries that a translator has
 * to get right, when the platform already knows them in every locale.
 */
const CLOCK_LOCALES = [
  'en', 'en-GB', 'es', 'fr', 'de', 'pt-BR', 'pt-PT', 'it', 'nl', 'pl', 'sv', 'nb', 'da',
  'fi', 'cs', 'hu', 'ro', 'tr', 'id', 'vi', 'ru', 'uk', 'zh-Hans', 'zh-Hant', 'ja', 'ko',
  'hi', 'ar', 'he', 'fa',
];

/** The tag's own language name, in the editor's locale. Falls back to the tag. */
function languageName(tag: string, uiLocale: string): string {
  try {
    return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(tag) ?? tag;
  } catch {
    // A runtime without DisplayNames, or a tag it does not know. The tag is
    // still a correct answer, just a less friendly one.
    return tag;
  }
}

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
  const t = useT();
  const rt = useRichT();
  const { locale: uiLocale } = useI18n();
  const clock = layer.clock;
  const [now, setNow] = useState(() => new Date());

  // Only while a clock layer is selected, and only once a second — this is a
  // preview in a panel, not the thing on air.
  useEffect(() => {
    if (!clock) return undefined;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [clock]);

  /** One option's label: this format, run for real. Falls back to the tokens. */
  const sample = (at: Date, base: TextClock, format: string): string => {
    try {
      return formatClock(at, { ...base, format });
    } catch {
      // A bad timezone throws for every format, and the field below already
      // says so. Showing the token string beats showing an empty list.
      return format;
    }
  };

  let preview = '';
  let error = '';
  if (clock) {
    try {
      preview = formatClock(now, clock);
    } catch {
      error = t('editor.properties.timezoneUnknown');
    }
  }

  return (
    <Section title={t('editor.properties.sectionClock')}>
      <Field label={t('editor.properties.liveClock')}>
        <input
          type="checkbox"
          checked={Boolean(clock)}
          title={t('editor.properties.liveClockTitle')}
          // i18n-ignore-next-line — a format token string, the same in every locale
          onChange={(e) => onChange(e.target.checked ? { format: 'h:mm A' } : undefined)}
        />
      </Field>

      {clock && (
        <>
          <Field label={t('editor.properties.preset')}>
            <select
              value={CLOCK_FORMATS.includes(clock.format) ? clock.format : ''}
              onChange={(e) => e.target.value && onChange({ ...clock, format: e.target.value })}
            >
              <option value="">{t('editor.properties.presetCustom')}</option>
              {CLOCK_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {sample(now, clock, format)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('editor.properties.format')}>
            <input
              value={clock.format}
              // i18n-ignore-next-line — a token string, the same in every locale
              placeholder="h:mm A"
              title={t('editor.properties.formatTitle')}
              onChange={(e) => onChange({ ...clock, format: e.target.value })}
            />
          </Field>
          <Field label={t('editor.properties.clockLanguage')}>
            <select
              value={clock.locale ?? ''}
              onChange={(e) => {
                const { locale: _drop, ...rest } = clock;
                onChange(e.target.value ? { ...rest, locale: e.target.value } : rest);
              }}
            >
              <option value="">{t('editor.properties.clockLanguageDefault')}</option>
              {CLOCK_LOCALES.map((tag) => (
                <option key={tag} value={tag}>{languageName(tag, uiLocale)}</option>
              ))}
              {/*
                A tag set by hand keeps its own option, the same way a cell's
                column does above. Dropping it would silently rewrite the
                document back to the default the moment the panel opened.
              */}
              {clock.locale && !CLOCK_LOCALES.includes(clock.locale) && (
                <option value={clock.locale}>{languageName(clock.locale, uiLocale)}</option>
              )}
            </select>
          </Field>

          <Field label={t('editor.properties.timezone')}>
            <input
              value={clock.timezone ?? ''}
              placeholder={t('editor.properties.timezonePlaceholder')}
              title={t('editor.properties.timezoneTitle')}
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
              {rt('editor.properties.clockNow', { preview: <strong>{preview}</strong> })}
            </p>
          )}

          {/*
            The layer's own text is only ever a placeholder once a clock is on:
            the runtime overwrites it before the first paint. Said here because
            an author who edits Content and sees nothing change on the output
            has no other way to find that out.
          */}
          <p className="prop-note">{t('editor.properties.clockLanguageHint')}</p>
          <p className="prop-note">{t('editor.properties.clockPlaceholderNote')}</p>
          {layer.binding && (
            <p className="prop-warning" data-warning="clock-binding">
              {t('editor.properties.clockBindingClash')}
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
  const t = useT();
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
    <Section title={t('editor.properties.sectionReveal')}>
      <Field label={t('editor.properties.preset')}>
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
          <option value="">{t('editor.properties.revealNone')}</option>
          {TEXT_ANIM_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{t(p.labelKey)}</option>
          ))}
        </select>
      </Field>

      {resolved && (
        <>
          <Field label={t('editor.properties.stagger')}>
            <input
              type="number"
              step={0.005}
              min={0}
              placeholder={String(resolved.defaults.stagger)}
              value={preset?.stagger ?? ''}
              title={t('editor.properties.staggerTitle')}
              onChange={(e) =>
                update({ stagger: e.target.value === '' ? undefined : Number(e.target.value) })
              }
            />
          </Field>
          <Field label={t('editor.properties.pieceDuration')}>
            <input
              type="number"
              step={0.05}
              min={0.05}
              placeholder={String(resolved.defaults.duration)}
              value={preset?.duration ?? ''}
              title={t('editor.properties.pieceDurationTitle')}
              onChange={(e) =>
                update({ duration: e.target.value === '' ? undefined : Number(e.target.value) })
              }
            />
          </Field>
          <Field label={t('editor.properties.ease')}>
            <select
              value={typeof preset?.ease === 'string' ? preset.ease : ''}
              onChange={(e) => update({ ease: e.target.value || undefined })}
            >
              <option value="">
                {t('editor.properties.easeFromPreset', { ease: String(resolved.defaults.ease) })}
              </option>
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
              ? t('editor.properties.revealReadout', {
                  count: pieces,
                  unit: resolved.unit,
                  seconds: round(total),
                })
              : t('editor.properties.revealWaiting', { unit: resolved.unit })}
          </p>

          {overruns && (
            <p className="prop-warning" data-warning="reveal-overrun">
              {t('editor.properties.revealOverrun', {
                total: round(total),
                budget: round(budget),
                limit: hold === undefined ? 'end' : 'hold',
              })}
            </p>
          )}
        </>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ table */

const FILTER_LABEL_KEY: Record<FilterOp, string> = {
  eq: 'editor.properties.filterEq', ne: 'editor.properties.filterNe',
  gt: 'editor.properties.filterGt', gte: 'editor.properties.filterGte',
  lt: 'editor.properties.filterLt', lte: 'editor.properties.filterLte',
  contains: 'editor.properties.filterContains',
  startsWith: 'editor.properties.filterStartsWith',
  endsWith: 'editor.properties.filterEndsWith',
  empty: 'editor.properties.filterEmpty', notEmpty: 'editor.properties.filterNotEmpty',
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
  const t = useT();
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
      <Field label={t('editor.properties.separator')}>
        <select
          value={custom ? '__custom__' : current}
          title={t('editor.properties.separatorTitle')}
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
            <option key={p.labelKey} value={p.value}>{t(p.labelKey)}</option>
          ))}
          <option value="__custom__">{t('editor.properties.separatorCustomOption')}</option>
        </select>
      </Field>

      {custom && (
        <Field label={t('editor.properties.separatorCustom')}>
          <input
            value={current}
            placeholder={DEFAULT_CRAWL_SEPARATOR}
            title={t('editor.properties.separatorCustomPlaceholder2')}
            onChange={(e) => onChange(e.target.value || undefined)}
          />
        </Field>
      )}

      <p className="hint">
        {custom
          ? t('editor.properties.separatorCustomHint')
          : t('editor.properties.separatorPreviewHint', { sep: current })}
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
  const t = useT();
  const rt = useRichT();
  const bound = sources.find((s) => s.id === layer.source);
  const columns = bound?.columns ?? [];

  return (
    <Section title={t('editor.properties.sectionCrawlData')}>
      <Field label={t('editor.properties.sectionSource')}>
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
          <option value="">{t('editor.properties.typedItems')}</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </Field>

      {layer.source && (
        <Field label={t('editor.properties.column')}>
          <select
            value={layer.column ?? ''}
            onChange={(e) => onPatch({ column: e.target.value || undefined })}
          >
            <option value="">{t('editor.properties.pickAColumn')}</option>
            {columns.map((c) => (
              <option key={c.key} value={c.key}>{c.label ?? c.key}</option>
            ))}
          </select>
        </Field>
      )}

      {layer.source && !bound && (
        <p className="hint warn">
          {rt('editor.properties.crawlNoSource', { id: <code>{layer.source}</code> })}
        </p>
      )}
      {layer.source && bound && !layer.column && (
        <p className="hint warn">{t('editor.properties.crawlNoColumn')}</p>
      )}
      {layer.source && layer.column && (
        <p className="hint">
          {rt('editor.properties.crawlColumnHint', { column: <code>{layer.column}</code> })}
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
  const t = useT();
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{t('editor.properties.columnDefault', { name: fallback })}</option>
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
  advance,
  columns,
  onChange,
}: {
  advance: AdvanceTransform;
  columns: DataColumn[];
  onChange: (next: AdvanceTransform) => void;
}): JSX.Element {
  const t = useT();
  const fields = advance.fields?.length ? advance.fields : [...ADVANCE_DEFAULTS.fields];
  const scoring = Boolean(advance.scores);

  return (
    <div className="transform-advance">
      <label>
        <span>{t('editor.properties.advanceSlot')}</span>
        <ColumnPick
          value={advance.slot}
          fallback={ADVANCE_DEFAULTS.slot}
          columns={columns}
          onChange={(slot) => onChange({ ...advance, slot })}
        />
      </label>
      <label>
        <span>{t('editor.properties.advanceRound')}</span>
        <ColumnPick
          value={advance.round}
          fallback={ADVANCE_DEFAULTS.round}
          columns={columns}
          onChange={(round) => onChange({ ...advance, round })}
        />
      </label>
      <label>
        <span>{t('editor.properties.advanceWinner')}</span>
        <ColumnPick
          value={advance.winner}
          fallback={ADVANCE_DEFAULTS.winner}
          columns={columns}
          onChange={(winner) => onChange({ ...advance, winner })}
        />
      </label>
      <label title={t('editor.properties.advanceRoutesTitle')}>
        <span>{t('editor.properties.advanceRoutes')}</span>
        <ColumnPick
          value={advance.feeds}
          fallback={ADVANCE_DEFAULTS.feeds}
          columns={columns}
          onChange={(feeds) => onChange({ ...advance, feeds })}
        />
      </label>
      <label title={t('editor.properties.advanceLoserRoutesTitle')}>
        <span>{t('editor.properties.advanceLoserRoutes')}</span>
        <ColumnPick
          value={advance.feedsLoser}
          fallback={ADVANCE_DEFAULTS.feedsLoser}
          columns={columns}
          onChange={(feedsLoser) => onChange({ ...advance, feedsLoser })}
        />
      </label>
      <label title={t('editor.properties.advanceCarryTitle')}>
        <span>{t('editor.properties.advanceCarry')}</span>
        <input
          value={fields.join(', ')}
          // i18n-ignore-next-line — a data column name, matching ADVANCE_DEFAULTS.fields
          placeholder="Team"
          onChange={(e) => {
            const next = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
            // An empty list would mean "carry nothing", which advances a team
            // into a slot and writes none of it. Fall back to the default.
            onChange({ ...advance, fields: next.length ? next : undefined });
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
                ? { ...advance, scores: { home: 'homeScore', away: 'awayScore' } }
                : { ...advance, scores: undefined },
            )
          }
        />
        <span>{t('editor.properties.advanceScores')}</span>
      </label>

      {advance.scores && (
        <>
          <label>
            <span>{t('editor.properties.advanceHomeScore')}</span>
            <ColumnPick
              value={advance.scores.home}
              fallback="homeScore"
              columns={columns}
              onChange={(home) => onChange({ ...advance, scores: { ...advance.scores!, home: home ?? 'homeScore' } })}
            />
          </label>
          <label>
            <span>{t('editor.properties.advanceAwayScore')}</span>
            <ColumnPick
              value={advance.scores.away}
              fallback="awayScore"
              columns={columns}
              onChange={(away) => onChange({ ...advance, scores: { ...advance.scores!, away: away ?? 'awayScore' } })}
            />
          </label>
          <label className="transform-advance-toggle">
            <input
              type="checkbox"
              checked={Boolean(advance.scores.shootout)}
              onChange={(e) =>
                onChange({
                  ...advance,
                  scores: {
                    ...advance.scores!,
                    shootout: e.target.checked ? { home: 'homePens', away: 'awayPens' } : undefined,
                  },
                })
              }
            />
            <span>{t('editor.properties.advanceShootout')}</span>
          </label>
          {advance.scores.shootout && (
            <>
              <label>
                <span>{t('editor.properties.advanceHomePens')}</span>
                <ColumnPick
                  value={advance.scores.shootout.home}
                  fallback="homePens"
                  columns={columns}
                  onChange={(home) =>
                    onChange({
                      ...advance,
                      scores: {
                        ...advance.scores!,
                        shootout: { ...advance.scores!.shootout!, home: home ?? 'homePens' },
                      },
                    })
                  }
                />
              </label>
              <label>
                <span>{t('editor.properties.advanceAwayPens')}</span>
                <ColumnPick
                  value={advance.scores.shootout.away}
                  fallback="awayPens"
                  columns={columns}
                  onChange={(away) =>
                    onChange({
                      ...advance,
                      scores: {
                        ...advance.scores!,
                        shootout: { ...advance.scores!.shootout!, away: away ?? 'awayPens' },
                      },
                    })
                  }
                />
              </label>
            </>
          )}
        </>
      )}

      <p className="hint">{t('editor.properties.advanceHint')}</p>
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
  const t = useT();
  const rt = useRichT();
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
      <Section title={t('editor.properties.sectionTableData')}>
        <Field label={t('editor.properties.sectionSource')}>
          <select
            value={layer.source ?? ''}
            onChange={(e) => onPatch({ source: e.target.value || undefined })}
          >
            <option value="">{t('editor.properties.authoredRows')}</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <Field label={t('editor.properties.binding')}>
          <input
            value={layer.binding ?? ''}
            placeholder={t('editor.properties.bindingTablePlaceholder')}
            title={t('editor.properties.bindingTableTitle')}
            onChange={(e) => onPatch({ binding: e.target.value || undefined })}
          />
        </Field>
        {layer.source && !bound && (
          <p className="hint warn">
            {rt('editor.properties.tableNoSource', { id: <code>{layer.source}</code> })}
          </p>
        )}
        <p className="hint">
          {columns.length
            ? rt('editor.properties.tableColumns', {
                columns: (
                  <>
                    {columns.map((c, i) => (
                      <Fragment key={c.key}>
                        {i > 0 && ' '}
                        <code>{c.key}</code>
                      </Fragment>
                    ))}
                  </>
                ),
              })
            : t('editor.properties.tableNoColumns')}
        </p>
      </Section>

      <Section title={t('editor.properties.sectionTransforms')}>
        {transforms.length === 0 && (
          <p className="hint">{t('editor.properties.transformsSourceOrder')}</p>
        )}

        {/*
          Not a validator error — filtering before advancing is legal and
          occasionally deliberate. But it silently resolves nothing, which is
          the kind of failure that only shows up on air, so say it here.
        */}
        {transforms.some((tr, i) => tr.op === 'advance' && transforms.slice(0, i).some(
          (p) => p.op === 'filter' || p.op === 'limit' || p.op === 'offset',
        )) && (
          <p className="hint warn">
            {rt('editor.properties.advanceOrderWarning', { advance: <strong>advance</strong> })}
          </p>
        )}

        {transforms.map((transform, i) => (
          <div key={i} className="transform-row">
            <span className="transform-op">{transform.op}</span>

            {(transform.op === 'sort' || transform.op === 'filter') && (
              <select
                value={transform.key}
                onChange={(e) => setTransform(i, { ...transform, key: e.target.value })}
              >
                {columns.map((c) => <option key={c.key} value={c.key}>{c.key}</option>)}
                {!columns.some((c) => c.key === transform.key) && <option value={transform.key}>{transform.key}</option>}
              </select>
            )}

            {transform.op === 'sort' && (
              <select
                value={transform.dir ?? 'asc'}
                onChange={(e) => setTransform(i, { ...transform, dir: e.target.value as 'asc' | 'desc' })}
              >
                <option value="asc">{t('editor.properties.sortAsc')}</option>
                <option value="desc">{t('editor.properties.sortDesc')}</option>
              </select>
            )}

            {transform.op === 'filter' && (
              <>
                <select
                  value={transform.cmp}
                  onChange={(e) => setTransform(i, { ...transform, cmp: e.target.value as FilterOp })}
                >
                  {FILTER_OPS.map((op) => (
                    <option key={op} value={op}>{t(FILTER_LABEL_KEY[op])}</option>
                  ))}
                </select>
                {transform.cmp !== 'empty' && transform.cmp !== 'notEmpty' && (
                  <input
                    value={String(transform.value ?? '')}
                    onChange={(e) => setTransform(i, { ...transform, value: e.target.value })}
                  />
                )}
              </>
            )}

            {(transform.op === 'limit' || transform.op === 'offset') && (
              <input
                type="number"
                min={0}
                value={transform.n}
                onChange={(e) => setTransform(i, { ...transform, n: Math.max(0, Number(e.target.value)) })}
              />
            )}

            {transform.op === 'rank' && (
              <input
                value={transform.as ?? ''}
                placeholder="rank"
                title={t('editor.properties.rankTitle')}
                onChange={(e) => setTransform(i, { ...transform, as: e.target.value || undefined })}
              />
            )}

            {transform.op === 'advance' && (
              <AdvanceFields
                advance={transform}
                columns={columns}
                onChange={(next) => setTransform(i, next)}
              />
            )}

            <button
              className="transform-move"
              title={t('editor.properties.moveEarlier')}
              disabled={i === 0}
              onClick={() => {
                const list = [...transforms];
                [list[i - 1], list[i]] = [list[i]!, list[i - 1]!];
                onPatch({ transforms: list });
              }}
            >▲</button>
            <button
              className="transform-del"
              title={t('editor.properties.removeTransform')}
              onClick={() => setTransform(i, null)}
            >×</button>
          </div>
        ))}

        <Field label={t('editor.properties.addTransform')}>
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
            <option value="">{t('editor.properties.addTransformOption')}</option>
            <option value="sort">{t('editor.properties.opSort')}</option>
            <option value="filter">{t('editor.properties.opFilter')}</option>
            <option value="rank">{t('editor.properties.opRank')}</option>
            <option value="limit">{t('editor.properties.opLimit')}</option>
            <option value="offset">{t('editor.properties.opOffset')}</option>
            <option value="advance">{t('editor.properties.opAdvance')}</option>
          </select>
        </Field>
      </Section>

      <Section title={t('editor.properties.sectionRows')}>
        <Field label={t('editor.properties.rowHeight')}>
          <input
            type="number"
            min={1}
            value={layer.row.height}
            onChange={(e) =>
              onPatch({ row: { ...layer.row, height: Math.max(1, Number(e.target.value)) } })
            }
          />
        </Field>
        <Field label={t('editor.properties.gap')}>
          <input
            type="number"
            min={0}
            value={layer.row.gap ?? 0}
            onChange={(e) => onPatch({ row: { ...layer.row, gap: Math.max(0, Number(e.target.value)) } })}
          />
        </Field>
        <Field label={t('editor.properties.rowsPerPage')}>
          <input
            type="number"
            min={0}
            value={layer.rowsPerPage ?? 0}
            title={t('editor.properties.rowsPerPageTitle')}
            onChange={(e) => onPatch({ rowsPerPage: Math.max(0, Number(e.target.value)) || undefined })}
          />
        </Field>

        {pages && (
          <p className="hint">
            {t('editor.properties.pageReadout', {
              rows: pages.rows,
              page: pages.page + 1,
              pageCount: pages.pageCount,
            })}
          </p>
        )}
        {overflowing && (
          <p className="hint warn">{t('editor.properties.tableOverflow')}</p>
        )}
      </Section>

      <Section title={t('editor.properties.sectionRowReveal')}>
        <Field label={t('editor.properties.preset')}>
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
            <option value="none">{t('editor.properties.revealNone')}</option>
            {ROW_ANIM_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>{t(preset.labelKey)}</option>
            ))}
          </select>
        </Field>

        {anim && (
          <>
            <Field label={t('editor.properties.stagger')}>
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
            <Field label={t('editor.properties.pieceDuration')}>
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
            <p className="hint">
              {t('editor.properties.rowRevealReadout', { seconds: revealSeconds.toFixed(2) })}
            </p>
          </>
        )}

        <Field label={t('editor.properties.resort')}>
          <input
            type="number"
            step={0.05}
            min={0}
            value={layer.flip?.duration ?? 0.5}
            title={t('editor.properties.resortTitle')}
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

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  /** Shown under the label, monospaced — for an identifier, not for prose. */
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="prop-field">
      <span className="prop-label">
        {label}
        {hint && <em className="prop-hint">{hint}</em>}
      </span>
      <span className="prop-input">{children}</span>
    </label>
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export { NAMED_EASES };
