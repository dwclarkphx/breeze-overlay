// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * A modal that can be moved by its title bar and resized from its corner
 * (0.79.1, first used for the data-source editor).
 *
 * It opens sized to what it holds, never more than 90% of the window either
 * way, and centred. Until someone drags its corner it keeps fitting its content
 * as that changes (a preview arriving, a source type with more fields), still
 * capped at 90%. After that the size is theirs. The native CSS `resize` handle
 * does the resizing, so it works with a mouse, a pen or a touch screen without
 * code of ours.
 *
 * Size and position are written to the element directly, not through React
 * state: the browser writes the size itself while the corner is dragged, and a
 * re-render holding an older size would snap it back.
 *
 * Neither Escape nor a click on the backdrop closes it. What it holds is a
 * half-filled form, and losing one to a stray key is worse than one more click
 * on the close button or Cancel.
 */

import { useCallback, useLayoutEffect, useRef, type JSX, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';

/** How much of the window the opening size may take. */
const OPEN_FRACTION = 0.9;
/** How much of the title bar must stay on screen when it is dragged. */
const KEEP_VISIBLE = 80;
/** The corner, in px, that counts as the resize handle. */
const CORNER = 20;

export interface FloatingDialogProps {
  title: ReactNode;
  /** Read by screen readers; the title when it is plain text. */
  label: string;
  /** The × button's tooltip and accessible name. */
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

export function FloatingDialog({ title, label, closeLabel, onClose, children, className }: FloatingDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const sizedByUser = useRef(false);
  const movedByUser = useRef(false);

  /*
   * Where the window sits is a screen coordinate, measured from the top-left
   * like the pointer's clientX/Y. It does not mirror under dir="rtl"; a dragged
   * window stays where it was dropped.
   */
  const place = useCallback((x: number, y: number): void => {
    const el = dialogRef.current!;
    const cx = Math.min(Math.max(x, KEEP_VISIBLE - el.offsetWidth), window.innerWidth - KEEP_VISIBLE);
    const cy = Math.min(Math.max(y, 0), window.innerHeight - 32);
    el.style.left = `${cx}px`; // dir-ok — a screen coordinate, set with clientX
    el.style.top = `${cy}px`;
  }, []);

  /** Size to the content, capped at 90% of the window, and centre unless it has been moved. */
  const fit = useCallback((): void => {
    const el = dialogRef.current;
    if (!el || sizedByUser.current) return;
    el.style.width = 'max-content';
    el.style.height = 'auto';
    const w = Math.min(el.offsetWidth, Math.floor(window.innerWidth * OPEN_FRACTION));
    el.style.width = `${w}px`;
    const h = Math.min(el.offsetHeight, Math.floor(window.innerHeight * OPEN_FRACTION));
    el.style.height = `${h}px`;
    if (!movedByUser.current) place((window.innerWidth - w) / 2, (window.innerHeight - h) / 2);
    else place(el.offsetLeft, el.offsetTop); // dir-ok — screen coordinate
  }, [place]);

  useLayoutEffect(() => {
    fit();
    const content = contentRef.current;
    let frame = 0;
    let last = '';
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = content?.getBoundingClientRect();
        const now = box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '';
        if (now === last) return;
        last = now;
        fit();
      });
    });
    if (content) observer.observe(content);
    const onWindow = (): void => {
      const el = dialogRef.current;
      if (el) place(el.offsetLeft, el.offsetTop); // dir-ok — screen coordinate
    };
    window.addEventListener('resize', onWindow);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', onWindow);
    };
  }, [fit, place]);

  /* A press in the bottom-right corner is the native resize handle: from then on the size is the user's. */
  const onDialogPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const box = e.currentTarget.getBoundingClientRect();
    if (e.clientX > box.right - CORNER && e.clientY > box.bottom - CORNER) sizedByUser.current = true;
  };

  /*
   * Move by the title bar. The pointer is captured on the first move, not on
   * press, so a click on the bar (or a double-click) still behaves as one —
   * the editor's rule for every drag (pointer-capture-rules).
   */
  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const header = e.currentTarget;
    const el = dialogRef.current!;
    const startX = e.clientX;
    const startY = e.clientY;
    const startX0 = el.offsetLeft; // dir-ok — screen coordinate
    const startY0 = el.offsetTop;
    const id = e.pointerId;
    let captured = false;
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== id) return;
      if (!captured) {
        header.setPointerCapture(id);
        captured = true;
      }
      movedByUser.current = true;
      place(startX0 + ev.clientX - startX, startY0 + ev.clientY - startY);
    };
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId !== id) return;
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', up);
      header.removeEventListener('pointercancel', up);
      if (captured && header.hasPointerCapture(id)) header.releasePointerCapture(id);
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', up);
    header.addEventListener('pointercancel', up);
  };

  return createPortal(
    <div className="float-overlay">
      <div
        ref={dialogRef}
        className={['float-dialog', className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onPointerDown={onDialogPointerDown}
      >
        <header className="float-header" onPointerDown={onHeaderPointerDown}>
          <strong className="float-title">{title}</strong>
          <button className="float-close" onClick={onClose} title={closeLabel} aria-label={closeLabel}>
            ×
          </button>
        </header>
        <div className="float-body">
          <div ref={contentRef} className="float-content">
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
