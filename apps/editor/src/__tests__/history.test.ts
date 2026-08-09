// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { createComposition, createShapeLayer } from '@breeze/schema';

import { findLayer } from '../state/commands.js';
import {
  COALESCE_WINDOW_MS,
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  commandLog,
  emptyHistory,
  pushCommand,
  redo,
  undo,
  undoLabel,
} from '../state/history.js';

const base = () => createComposition({ id: 'c', layers: [createShapeLayer({ id: 'bar' })] });

const opacityOf = (comp: ReturnType<typeof base>) => findLayer(comp.layers, 'bar')!.opacity;

describe('push', () => {
  it('applies the command and records an entry', () => {
    const r = pushCommand(base(), emptyHistory, {
      kind: 'patchLayer', layerId: 'bar', patch: { opacity: 0.5 },
    });
    expect(opacityOf(r.composition)).toBe(0.5);
    expect(r.history.past).toHaveLength(1);
  });

  it('ignores a command aimed at a layer that does not exist', () => {
    const comp = base();
    const r = pushCommand(comp, emptyHistory, {
      kind: 'patchLayer', layerId: 'nope', patch: { opacity: 0.5 },
    });
    expect(r.history.past).toHaveLength(0);
    expect(r.composition).toBe(comp);
  });

  it('ignores a patch that sets values already in place', () => {
    // Clicking into a field and tabbing out without editing must not consume
    // the undo the user was saving.
    const comp = base();
    const r = pushCommand(comp, emptyHistory, {
      kind: 'patchLayer', layerId: 'bar', patch: { opacity: comp.layers[0]!.opacity },
    });
    expect(r.history.past).toHaveLength(0);
    expect(r.composition).toBe(comp);
  });

  it('ignores a patch of an identical nested object', () => {
    const comp = base();
    const r = pushCommand(comp, emptyHistory, {
      kind: 'patchLayer',
      layerId: 'bar',
      patch: { transform: { ...(comp.layers[0]!.transform ?? {}) } },
    });
    expect(r.history.past).toHaveLength(0);
  });

  it('ignores a keyframe move that lands on its own time', () => {
    const seeded = pushCommand(base(), emptyHistory, {
      kind: 'setKeyframe', layerId: 'bar', prop: 'x', time: 0.5, value: 10,
    });
    const noop = pushCommand(seeded.composition, seeded.history, {
      kind: 'moveKeyframe', layerId: 'bar', prop: 'x', from: 0.5, to: 0.5,
    });
    expect(noop.history.past).toHaveLength(1);
  });

  it('caps retained history', () => {
    let comp = base();
    let history = emptyHistory;
    for (let i = 0; i < HISTORY_LIMIT + 25; i++) {
      // Distinct timestamps and values so nothing coalesces.
      const r = pushCommand(comp, history, {
        kind: 'patchLayer', layerId: 'bar', patch: { opacity: i / 1000 },
      }, i * (COALESCE_WINDOW_MS + 10));
      comp = r.composition;
      history = r.history;
    }
    expect(history.past).toHaveLength(HISTORY_LIMIT);
  });
});

describe('undo and redo', () => {
  it('restores the previous document', () => {
    const start = base();
    const r = pushCommand(start, emptyHistory, {
      kind: 'patchLayer', layerId: 'bar', patch: { opacity: 0.2 },
    });
    const back = undo(r.composition, r.history);

    expect(back.composition).toBe(start);
    expect(canUndo(back.history)).toBe(false);
    expect(canRedo(back.history)).toBe(true);
  });

  it('round-trips through redo', () => {
    const r = pushCommand(base(), emptyHistory, {
      kind: 'patchLayer', layerId: 'bar', patch: { opacity: 0.2 },
    });
    const back = undo(r.composition, r.history);
    const forward = redo(back.composition, back.history);

    expect(opacityOf(forward.composition)).toBe(0.2);
    expect(canRedo(forward.history)).toBe(false);
  });

  it('survives many undo/redo cycles without drift', () => {
    let { composition, history } = pushCommand(base(), emptyHistory, {
      kind: 'patchLayer', layerId: 'bar', patch: { opacity: 0.7 },
    });
    for (let i = 0; i < 20; i++) {
      ({ composition, history } = undo(composition, history));
      ({ composition, history } = redo(composition, history));
    }
    expect(opacityOf(composition)).toBe(0.7);
  });

  it('discards the redo branch once a new edit lands', () => {
    const first = pushCommand(base(), emptyHistory, {
      kind: 'patchLayer', layerId: 'bar', patch: { opacity: 0.2 },
    });
    const back = undo(first.composition, first.history);
    const diverged = pushCommand(back.composition, back.history, {
      kind: 'renameLayer', layerId: 'bar', name: 'Renamed',
    });

    expect(canRedo(diverged.history)).toBe(false);
  });

  it('is a no-op at the ends of the stack', () => {
    const comp = base();
    expect(undo(comp, emptyHistory).composition).toBe(comp);
    expect(redo(comp, emptyHistory).composition).toBe(comp);
  });
});

describe('coalescing', () => {
  it('merges a rapid drag into one undo step', () => {
    let comp = base();
    let history = emptyHistory;
    const start = comp;

    for (let i = 1; i <= 40; i++) {
      const r = pushCommand(comp, history, {
        kind: 'patchLayer', layerId: 'bar', patch: { transform: { x: i } },
      }, 1000 + i * 5);
      comp = r.composition;
      history = r.history;
    }

    expect(history.past).toHaveLength(1);
    // One undo must return the whole gesture, not the last frame of it.
    expect(undo(comp, history).composition).toBe(start);
  });

  it('starts a new step after a pause', () => {
    const first = pushCommand(base(), emptyHistory, {
      kind: 'patchLayer', layerId: 'bar', patch: { transform: { x: 1 } },
    }, 1000);
    const later = pushCommand(first.composition, first.history, {
      kind: 'patchLayer', layerId: 'bar', patch: { transform: { x: 2 } },
    }, 1000 + COALESCE_WINDOW_MS + 1);

    expect(later.history.past).toHaveLength(2);
  });

  it('does not merge edits to different properties', () => {
    const first = pushCommand(base(), emptyHistory, {
      kind: 'patchLayer', layerId: 'bar', patch: { transform: { x: 1 } },
    }, 1000);
    const other = pushCommand(first.composition, first.history, {
      kind: 'patchLayer', layerId: 'bar', patch: { opacity: 0.5 },
    }, 1010);

    expect(other.history.past).toHaveLength(2);
  });

  it('does not merge edits to different layers', () => {
    const comp = createComposition({
      layers: [createShapeLayer({ id: 'a' }), createShapeLayer({ id: 'b' })],
    });
    const first = pushCommand(comp, emptyHistory, {
      kind: 'patchLayer', layerId: 'a', patch: { transform: { x: 1 } },
    }, 1000);
    const second = pushCommand(first.composition, first.history, {
      kind: 'patchLayer', layerId: 'b', patch: { transform: { x: 1 } },
    }, 1010);

    expect(second.history.past).toHaveLength(2);
  });

  it('merges a whole drag gesture into one undo step', () => {
    /*
     * A drag writes x and y together. As two separate commands their coalescing
     * keys alternate, and since coalescing only looks at the immediately
     * previous entry, nothing merged — a drag produced two undo entries per
     * frame. `setValues` carries both properties so the key is stable.
     */
    let comp = base();
    let history = emptyHistory;
    const start = comp;

    for (let i = 1; i <= 40; i++) {
      const r = pushCommand(comp, history, {
        kind: 'setValues', layerId: 'bar', values: { x: i, y: i * 2 }, time: 0,
      }, 1000 + i * 5);
      comp = r.composition;
      history = r.history;
    }

    expect(history.past).toHaveLength(1);
    expect(undo(comp, history).composition).toBe(start);
  });

  it('merges a drag on an animated property too', () => {
    const seeded = pushCommand(base(), emptyHistory, {
      kind: 'setKeyframe', layerId: 'bar', prop: 'x', time: 0.5, value: 0,
    }, 500);

    let { composition, history } = seeded;
    for (let i = 1; i <= 30; i++) {
      const r = pushCommand(composition, history, {
        kind: 'setValues', layerId: 'bar', values: { x: i }, time: 0.5,
      }, 1000 + i * 5);
      composition = r.composition;
      history = r.history;
    }

    // One entry for seeding the keyframe, one for the whole drag.
    expect(history.past).toHaveLength(2);
  });

  it('separates drags at different playhead positions', () => {
    // Only meaningful for an animated property: on a static one the playhead
    // is irrelevant, so both writes land on the same baseline.
    const seeded = pushCommand(base(), emptyHistory, {
      kind: 'setKeyframe', layerId: 'bar', prop: 'x', time: 0, value: 0,
    }, 500);

    const first = pushCommand(seeded.composition, seeded.history, {
      kind: 'setValues', layerId: 'bar', values: { x: 10 }, time: 0.5,
    }, 1000);
    const second = pushCommand(first.composition, first.history, {
      kind: 'setValues', layerId: 'bar', values: { x: 20 }, time: 1.5,
    }, 1010);

    // Seed, then one entry per keyframe — moving a layer at 0.5s and again at
    // 1.5s is two separate pieces of work, however quickly they follow.
    expect(second.history.past).toHaveLength(3);
  });

  it('does not record a static write that changes nothing', () => {
    // Nudging a layer back to where it started should not cost an undo slot.
    const first = pushCommand(base(), emptyHistory, {
      kind: 'setValues', layerId: 'bar', values: { x: 1 }, time: 0.5,
    }, 1000);
    const repeat = pushCommand(first.composition, first.history, {
      kind: 'setValues', layerId: 'bar', values: { x: 1 }, time: 1.5,
    }, 5000);

    expect(repeat.history.past).toHaveLength(1);
  });

  it('merges a resize gesture into one undo step', () => {
    /*
     * Regression: resize dispatched a `patchLayer` for the size and a
     * `setValues` for the position. Their coalescing keys alternate, and
     * coalescing only inspects the immediately previous entry — so a gesture
     * produced two entries per pointer event. The browser reported 22 entries
     * for one drag, labeled "Move layer | Change layer | Move layer | …".
     */
    let comp = base();
    let history = emptyHistory;
    const start = comp;

    for (let i = 1; i <= 30; i++) {
      const r = pushCommand(comp, history, {
        kind: 'resizeLayer',
        layerId: 'bar',
        size: { width: 100 + i, height: 50 + i },
        values: { x: i, y: i },
        time: 0,
      }, 1000 + i * 5);
      comp = r.composition;
      history = r.history;
    }

    expect(history.past).toHaveLength(1);
    expect(undo(comp, history).composition).toBe(start);
  });

  it('never coalesces structural commands', () => {
    const first = pushCommand(base(), emptyHistory, {
      kind: 'addLayer', layer: createShapeLayer({ id: 'x' }),
    }, 1000);
    const second = pushCommand(first.composition, first.history, {
      kind: 'addLayer', layer: createShapeLayer({ id: 'y' }),
    }, 1005);

    expect(second.history.past).toHaveLength(2);
  });
});

describe('labels and log', () => {
  it('describes the pending undo', () => {
    const r = pushCommand(base(), emptyHistory, {
      kind: 'addLayer', layer: createShapeLayer({ id: 'x' }),
    });
    expect(undoLabel(r.history)).toBe('Add shape layer');
  });

  it('exposes a serializable command log', () => {
    let { composition, history } = pushCommand(base(), emptyHistory, {
      kind: 'renameLayer', layerId: 'bar', name: 'Bar',
    }, 1000);
    ({ composition, history } = pushCommand(composition, history, {
      kind: 'addMarker', marker: { type: 'stop', time: 1 },
    }, 5000));

    const log = commandLog(history);
    expect(log.map((c) => c.kind)).toEqual(['renameLayer', 'addMarker']);
    // Round-trips through JSON, which is what makes scripting possible later.
    expect(JSON.parse(JSON.stringify(log))).toEqual(log);
  });
});
