// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The OGraf pointer package (Phase 9 Wave D, D2): a manifest and a small
 * `graphic.mjs`, for an OGraf renderer to host.
 *
 * **It carries no runtime.** The module frames this server's own output page
 * for the composition (`/play/<project>/<composition>?hub=data&ograf=1`) and
 * forwards each OGraf action to it by `postMessage`; the page answers with the
 * real runtime (`OgrafAdapter`). So Phase 7.5's rule — a bundle carries data,
 * never the runtime — holds, the LICENSING draft's objection to a
 * self-contained export does not arise, and GSAP is still loaded from this
 * server's vendor copy, never shipped in the zip.
 *
 * A frame rather than an `import()` of the runtime into the renderer's own
 * document, which is what PHASE9.md first sketched, for four reasons found
 * when building it: the runtime injects its styles and fonts into the
 * document head, and the renderer's page is not ours to restyle; GSAP is a
 * global (`window.gsap`), and a second copy in a renderer already hosting
 * another graphic's GSAP is a collision waiting to happen; the module would
 * need CORS on every script and asset; and the output page as it is — 1:1
 * stage, `?scale=contain`, asset paths, late-arriving data — is exactly what
 * design rule 1 says every renderer must run. What a renderer gets is the
 * graphic, isolated, the same page vMix and OBS load.
 *
 * The cost is stated in the manifest and below: the graphic plays only while
 * this server can be reached from the renderer.
 */

import { ografGraphicId } from '@breeze/schema';

/** The module file in the package, and `main` in its manifest. */
export const OGRAF_MAIN = 'graphic.mjs';

/** The manifest's file name: the composition id, so a folder of them reads. */
export function ografManifestFile(compositionId: string): string {
  return `${compositionId}.ograf.json`;
}

/**
 * A server origin from `?server=`, or null when it is not one: an absolute
 * http(s) URL, of which only the origin is kept — a path would only be
 * appended to and broken.
 */
export function serverOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * `graphic.mjs` for one composition.
 *
 * Plain ES2020 with no imports, so any OGraf renderer can load it. Constants
 * are written in with `JSON.stringify`, which makes any id or name a safe
 * string literal; the name is used only as the frame's `title`.
 */
export function pointerModule(opts: { server: string; projectId: string; compositionId: string; name: string }): string {
  const S = JSON.stringify;
  return `/*! Breeze Overlay — OGraf pointer graphic (Phase 9 Wave D)
 *  Mozilla Public License 2.0 — https://github.com/dwclarkphx/breeze-overlay
 *
 *  This file carries no renderer. It frames the live graphic from the Breeze
 *  server below and forwards each OGraf action to it, so the graphic plays
 *  only while that server can be reached from wherever this one renders.
 *  To point it at another address, pass v_breezeServer to load().
 */

const SERVER = ${S(opts.server)};
const PROJECT = ${S(opts.projectId)};
const COMPOSITION = ${S(opts.compositionId)};
const GRAPHIC_ID = ${S(ografGraphicId(opts.projectId, opts.compositionId))};
const NAME = ${S(opts.name)};
const READY_TIMEOUT_MS = 15000;

/** A structured-clone-safe copy: vendor fields may carry anything. */
function plain(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? {}));
  } catch {
    return {};
  }
}

export default class BreezePointerGraphic extends HTMLElement {
  constructor() {
    super();
    this._frame = null;
    this._origin = null;
    this._ready = false;
    this._waiting = [];
    this._calls = new Map();
    this._seq = 0;
    this._onMessage = (event) => this._message(event);
  }

  connectedCallback() {
    // Fill the box the renderer gives the graphic; the page scales itself into it.
    const s = this.style;
    s.display = 'block';
    if (!s.position) s.position = 'absolute';
    s.left = '0';
    s.top = '0';
    s.width = '100%';
    s.height = '100%';
  }

  async load(params = {}) {
    if (params.renderType && params.renderType !== 'realtime') {
      return { statusCode: 400, statusMessage: 'This Breeze graphic renders in real time only.' };
    }
    const asked = typeof params.v_breezeServer === 'string' ? params.v_breezeServer.trim() : '';
    const server = (/^https?:\\/\\//.test(asked) ? asked : SERVER).replace(/\\/+$/, '');
    let origin;
    try {
      origin = new URL(server).origin;
    } catch {
      return { statusCode: 400, statusMessage: 'Not a server address: ' + server };
    }

    this._teardown();
    this._origin = origin;
    const frame = document.createElement('iframe');
    frame.title = NAME;
    frame.setAttribute('allow', 'autoplay');
    // color-scheme matches the page's, or Chrome paints an opaque backdrop behind it.
    frame.style.cssText =
      'position:absolute;left:0;top:0;width:100%;height:100%;border:0;margin:0;padding:0;' +
      'background:transparent;color-scheme:normal;pointer-events:none';
    frame.src =
      origin + '/play/' + encodeURIComponent(PROJECT) + '/' + encodeURIComponent(COMPOSITION) +
      '?hub=data&ograf=1&scale=contain';
    window.addEventListener('message', this._onMessage);
    this._frame = frame;
    this.appendChild(frame);

    const ready = await new Promise((resolve) => {
      this._waiting.push(resolve);
      setTimeout(() => resolve(false), READY_TIMEOUT_MS);
    });
    if (!ready) {
      this._teardown();
      return {
        statusCode: 504,
        statusMessage:
          'The Breeze server at ' + origin + ' did not answer within ' + READY_TIMEOUT_MS / 1000 + ' s. ' +
          'This graphic plays only while that server can be reached.',
      };
    }
    const data = params.data;
    if (data && typeof data === 'object' && Object.keys(data).length > 0) {
      const result = await this._call('updateAction', { data });
      if (!result || result.statusCode >= 300) return result;
    }
    return { statusCode: 200 };
  }

  async dispose() {
    this._teardown();
    return { statusCode: 200 };
  }

  playAction(params = {}) {
    return this._call('playAction', params);
  }

  stopAction(params = {}) {
    return this._call('stopAction', params);
  }

  updateAction(params = {}) {
    return this._call('updateAction', params);
  }

  customAction(params = {}) {
    return this._call('customAction', params);
  }

  _call(method, params) {
    if (!this._frame || !this._ready || !this._frame.contentWindow) {
      return Promise.resolve({ statusCode: 409, statusMessage: 'load() has not finished.' });
    }
    const id = ++this._seq;
    const frame = this._frame;
    return new Promise((resolve) => {
      this._calls.set(id, resolve);
      frame.contentWindow.postMessage({ breezeOgraf: 1, id, method, params: plain(params) }, this._origin);
    });
  }

  _message(event) {
    const frame = this._frame;
    if (!frame || event.source !== frame.contentWindow || event.origin !== this._origin) return;
    const message = event.data;
    if (!message || message.breezeOgraf !== 1) return;
    if (message.ready === true) {
      // Again after the page reloads: it comes back off air, and ready.
      this._ready = true;
      for (const resolve of this._waiting.splice(0)) resolve(true);
      return;
    }
    const resolve = this._calls.get(message.id);
    if (!resolve) return;
    this._calls.delete(message.id);
    resolve(message.result || { statusCode: 200 });
  }

  _teardown() {
    window.removeEventListener('message', this._onMessage);
    if (this._frame) this._frame.remove();
    this._frame = null;
    this._ready = false;
    for (const resolve of this._waiting.splice(0)) resolve(false);
    for (const resolve of this._calls.values()) resolve({ statusCode: 410, statusMessage: 'The graphic was unloaded.' });
    this._calls.clear();
  }
}

// For a person reading a renderer's console: which graphic this is.
BreezePointerGraphic.graphicId = GRAPHIC_ID;
`;
}
