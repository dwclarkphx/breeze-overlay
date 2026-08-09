// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * A draggable divider between two panels.
 *
 * Reports the new size of the panel it belongs to rather than a raw delta, so
 * the owner never has to remember what the size was when the gesture began —
 * that is held here, once, at pointer-down. Recomputing from the gesture start
 * on every move is also what keeps a long drag from accumulating rounding error.
 */

import { useRef, type JSX } from 'react';

export function Splitter({
  axis,
  value,
  onChange,
  onReset,
  invert = false,
  label,
  step = 16,
}: {
  /** 'x' for a vertical divider between columns, 'y' for a horizontal one. */
  axis: 'x' | 'y';
  /** Current size of the panel this divider resizes. */
  value: number;
  onChange: (next: number) => void;
  onReset: () => void;
  /** True when the panel grows as the pointer moves in the negative direction. */
  invert?: boolean;
  label: string;
  /** Keyboard nudge, px. */
  step?: number;
}): JSX.Element {
  const drag = useRef<{ origin: number; from: number } | null>(null);

  const position = (e: React.PointerEvent) => (axis === 'x' ? e.clientX : e.clientY);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    /*
     * Capture immediately, and capture *this* element.
     *
     * Deferring the capture to the first move is the right move for a wide drag
     * surface, but a 5px divider is narrower than the first pointer step: the
     * move lands on the panel next door, the handler never runs, and the drag
     * never starts at all.
     *
     * Capturing on pointer-down is safe here for the same reason it is on the
     * timeline markers — the capture goes on the element that was pressed, so
     * the following pointerup still targets it and the browser can still build
     * the double-click that resets the panel. It is capturing a *different*
     * element on pointer-down that silently kills a double-click.
     */
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { origin: position(e), from: value };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const gesture = drag.current;
    if (!gesture || e.buttons !== 1) return;

    const travelled = position(e) - gesture.origin;
    onChange(gesture.from + (invert ? -travelled : travelled));
  };

  const end = () => {
    drag.current = null;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const [less, more] = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const direction = e.key === more ? 1 : e.key === less ? -1 : 0;
    if (direction === 0) return;
    e.preventDefault();
    onChange(value + direction * step * (invert ? -1 : 1));
  };

  return (
    <div
      className={`splitter splitter-${axis}`}
      // A separator is the standard role for this, and it makes the divider
      // reachable and adjustable without a pointer at all.
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      title={`${label} — double-click to reset`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
