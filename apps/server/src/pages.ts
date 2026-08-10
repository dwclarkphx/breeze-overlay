// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Server-rendered HTML shells.
 *
 * The output page inlines the composition JSON rather than fetching it: one
 * fewer round trip before first paint, and a browser source that reconnects
 * after a network blip still has its graphic. It also means the page is a
 * near-relative of the Phase-8 single-file export.
 */

import {
  DATA_UPDATE_KEY,
  sceneElements,
  type Composition,
  type DataSet,
  type SceneElement,
} from '@breeze/schema';

import { GSAP_VENDOR_URL, GSAP_VERSION } from './vendor.js';

/**
 * The GSAP versions this build of the runtime is known to work against.
 *
 * The floor is 3.13 because that is the release where SplitText became free and
 * shipped inside the public `gsap` package; below it, `gsap/SplitText` resolves
 * to nothing and every text reveal is dead. The ceiling is the next major,
 * which GreenSock has not shipped and which would not be assumed compatible.
 *
 * This range is the price of making GSAP replaceable: the file on disk and the
 * types the runtime was compiled against are now two separate things, and the
 * range is what stops them drifting silently.
 */
const GSAP_MIN = [3, 13, 0] as const;
const GSAP_MAX_EXCLUSIVE = [4, 0, 0] as const;

/**
 * Script tags for the vendored GSAP, plus the guard that checks what arrived.
 *
 * Classic scripts, not modules, and not deferred: they must have executed
 * before `player.js` — itself a classic IIFE — reads `window.gsap`. SplitText
 * follows the core because it resolves the core through `window.gsap` at load.
 *
 * The guard is inline and runs *here* rather than inside the bundle because by
 * the time the bundle evaluates, the import that needs GSAP has already thrown
 * and taken the page with it. Running ahead of it is what buys a legible
 * message instead of a black output and an empty console.
 *
 * It writes to `document.title` and the console rather than rendering anything:
 * this page can be live on air, and a Breeze error card composited over a
 * programme feed would be a worse outcome than a missing graphic. The title is
 * visible in the OBS/vMix source list, which is where an operator looks.
 */
function gsapTags(): string {
  const v = encodeURIComponent(GSAP_VERSION);
  return `<script src="${GSAP_VENDOR_URL}/gsap.min.js?v=${v}"></script>
<script src="${GSAP_VENDOR_URL}/SplitText.min.js?v=${v}"></script>
<script>
(function () {
  var min = ${JSON.stringify(GSAP_MIN)}, max = ${JSON.stringify(GSAP_MAX_EXCLUSIVE)};
  var g = window.gsap;
  function fail(msg) {
    document.title = 'GSAP problem — Breeze';
    console.error('[breeze] ' + msg +
      '\\n[breeze] GSAP is loaded from ${GSAP_VENDOR_URL}/ and is not bundled. ' +
      'Staged version per the server: ${GSAP_VERSION}.');
  }
  if (!g) return fail('GSAP did not load — the graphic will not animate.');
  if (!window.SplitText) fail('GSAP loaded but SplitText did not — text reveals will fail.');
  var p = String(g.version || '').split('.').map(Number);
  function lt(a, b) {
    for (var i = 0; i < 3; i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
    }
    return false;
  }
  if (p.length < 2 || p.some(isNaN)) {
    fail('GSAP reports an unreadable version (' + g.version + ').');
  } else if (lt(p, min) || !lt(p, max)) {
    fail('GSAP ' + g.version + ' is outside the supported range ' +
      min.join('.') + ' <= v < ' + max.join('.') + '. Playback may misbehave.');
  }
})();
</script>`;
}

/** Source types whose rows come from a fetch rather than from an operator. */
const FETCHED_SOURCE_TYPES = new Set(['http-json', 'http-csv', 'rss', 'xml', 'sheets', 'weather', 'ftp']);

/**
 * Is this field driven by a feed?
 *
 * Keyed on the source *type*, not on the presence of a source. The standings
 * demo binds a `manual` source and must stay editable — editing it in the panel
 * is the whole point of a manual source — while the weather bug binds a
 * `weather` source and must not be editable at all.
 */
export function isFedSource(type: string | undefined): boolean {
  return type !== undefined && FETCHED_SOURCE_TYPES.has(type);
}

function escapeJson(value: unknown): string {
  // `</script>` inside string data would close the tag early.
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export interface PlayPageOptions {
  projectId: string;
  composition: Composition;
  /**
   * Compositions the graphic can nest, transitively. Inlined alongside the
   * root so a `composition` layer resolves without a second request — a
   * browser source that loses the server mid-show still has everything it
   * needs to keep rendering.
   */
  dependencies: Composition[];
  assetBase: string;
  cacheBust: string;
  /**
   * Current DataSets, keyed by source id, inlined for the same reason the
   * composition is: a browser source must come up showing real rows on first
   * paint, without waiting for the first WebSocket push. It is also what covers
   * the case that matters most — the server being unreachable when the source
   * opens — since the page then still has the last data the server held.
   */
  datasets?: Record<string, DataSet>;
}

export function playPage(opts: PlayPageOptions): string {
  const { projectId, composition, dependencies, assetBase, cacheBust } = opts;
  const datasets = opts.datasets ?? {};
  /*
   * Resolved server-side rather than derived in the browser so that the page
   * and the control routes cannot disagree about which channels exist. Both
   * call `sceneElements`; only one of them gets to be the source of truth for
   * what is actually mounted, and it is this list.
   */
  const elements = sceneElements(composition);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(composition.name)} — Breeze</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;background:transparent!important;overflow:hidden}
  *{box-sizing:border-box}
</style>
</head>
<body>
<script>
window.__BREEZE__ = {
  projectId: ${escapeJson(projectId)},
  compositionId: ${escapeJson(composition.id)},
  composition: ${escapeJson(composition)},
  dependencies: ${escapeJson(dependencies)},
  assetBase: ${escapeJson(assetBase)},
  dataKey: ${escapeJson(DATA_UPDATE_KEY)},
  datasets: ${escapeJson(datasets)},
  elements: ${escapeJson(elements)},
  autoPlay: false
};
</script>
${gsapTags()}
<script src="/public/player.js?v=${encodeURIComponent(cacheBust)}"></script>
</body>
</html>`;
}

export interface ControlPanelBinding {
  name: string;
  kind: string;
  label: string;
  defaultValue: unknown;
  /** Data-source id feeding this field, if any. */
  source?: string;
  /** For a crawl: the column of `source` its items come from. */
  column?: string;
  /**
   * True when `source` is a *fetched* source rather than a manual table.
   *
   * The panel then shows the polled rows instead of the authored snapshot and
   * takes the field out of the update payload entirely. Without that second
   * half the field is still sent on PLAY, which is the bug this exists to fix:
   * pressing PLAY pushed the placeholder `96°` over a live temperature and the
   * graphic showed it until the next poll.
   */
  readOnly?: boolean;
  /** Human name of the feeding source, for the caption. */
  sourceName?: string;
  /** Source type — shown so an operator knows why a field is not editable. */
  sourceType?: string;
}

export interface ControlPageOptions {
  projectId: string;
  composition: Composition;
  bindings: ControlPanelBinding[];
  schema: Record<string, unknown>;
  stepCount: number;
  /**
   * Current DataSets by source id, inlined for the same reason the play page
   * inlines its own: the panel is opened minutes before air on whatever link
   * the gallery has, and a read-only field that says nothing until the first
   * websocket frame looks like a source that is not working.
   */
  datasets?: Record<string, DataSet>;
}

/**
 * Markup for the elements block on a scene's panel.
 *
 * Verbs go out over REST rather than the panel's websocket, which is
 * subscribed to the scene's own channel and would have to grow a channel per
 * element to carry them. The REST triggers already exist, are already
 * authenticated by the same hook, and are the exact URLs an operator would put
 * on a Stream Deck — so the panel presses the same buttons the hardware does.
 *
 * A status socket per element is opened separately, for the readout only.
 */
function sceneElementsBlock(elements: SceneElement[]): string {
  if (elements.length === 0) return '';

  const rows = elements
    .map(
      (element) => `
    <div class="element" data-channel="${escapeHtml(element.channel)}">
      <div class="element-head">
        <strong>${escapeHtml(element.name)}</strong>
        <code class="element-key">${escapeHtml(element.channel)}</code>
        <span class="element-state playback" data-role="state">–</span>
      </div>
      <div class="verbs">
        <button class="go" data-el-verb="play">PLAY</button>
        <button data-el-verb="next">NEXT</button>
        <button class="stop" data-el-verb="stop">STOP</button>
        <button data-el-verb="clear">CLEAR</button>
      </div>
      <div class="hint"><a href="./${encodeURIComponent(element.ref)}">Fields for this element →</a></div>
    </div>`,
    )
    .join('');

  return `
<fieldset>
  <legend>Elements</legend>
  ${rows}
  <button id="clear-all" class="stop" style="width:100%;margin-top:6px">CLEAR ALL</button>
  <div class="hint">Each element rolls on its own. CLEAR ALL takes the whole page down at once —
    reloading the browser source does the same thing far more bluntly.</div>
</fieldset>`;
}

/**
 * Operator panel.
 *
 * Server-rendered with the field list inlined, for the same reason the output
 * page inlines its composition: this is used minutes before air, sometimes on a
 * tablet on a poor wifi link, and it must render fully on first paint rather
 * than after a round trip.
 *
 * Deliberately large touch targets and high contrast — it gets used in a dim
 * gallery, in a hurry, often one-handed.
 */
export function controlPage(opts: ControlPageOptions): string {
  const { projectId, composition, bindings, schema, stepCount } = opts;
  const datasets = opts.datasets ?? {};
  const elements = sceneElements(composition);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(composition.name)} — Breeze control</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<style>
  :root{--bg:#0d1117;--panel:#161b22;--panel2:#1c2129;--border:#30363d;--text:#c9d1d9;
        --muted:#8b949e;--accent:#58a6ff;--go:#238636;--stop:#a52834;--key:#e3b341;
        --fed:#3fb950}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
       font:16px/1.5 system-ui,"Segoe UI",sans-serif;padding:16px;
       padding-bottom:calc(16px + env(safe-area-inset-bottom))}
  header{display:flex;align-items:baseline;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  h1{font-size:19px;margin:0}
  .sub{color:var(--muted);font-size:13px}
  .status{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:13px}
  .dot{width:10px;height:10px;border-radius:50%;background:var(--muted)}
  .dot.live{background:#3fb950;box-shadow:0 0 8px #3fb950}
  .dot.off{background:var(--stop)}
  fieldset{border:1px solid var(--border);border-radius:8px;padding:12px;margin:0 0 14px;
           background:var(--panel)}
  legend{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.6px;padding:0 6px}
  label{display:block;margin-bottom:10px}
  label span{display:block;color:var(--muted);font-size:13px;margin-bottom:4px}
  input,textarea{width:100%;padding:11px;font:inherit;background:var(--panel2);
                 color:var(--text);border:1px solid var(--border);border-radius:6px}
  input:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:-1px}
  .verbs{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
  button{padding:16px 12px;font:600 16px/1 inherit;border-radius:8px;border:1px solid var(--border);
         background:var(--panel2);color:var(--text);cursor:pointer;min-height:56px}
  button:active{transform:translateY(1px)}
  button.go{background:var(--go);border-color:#2ea043;color:#fff}
  button.stop{background:var(--stop);border-color:#c9313f;color:#fff}
  .hint{color:var(--muted);font-size:12px;margin-top:10px}
  .playback{font-family:ui-monospace,Consolas,monospace;color:var(--key)}
  /* Dataset grid. Scrolls horizontally rather than wrapping: a squashed
     standings table is unreadable on a tablet, and columns must stay aligned. */
  .grid-wrap{margin-bottom:12px}
  .grid-caption{display:block;color:var(--muted);font-size:13px;margin-bottom:4px}
  .grid{width:100%;border-collapse:collapse;display:block;overflow-x:auto;white-space:nowrap}
  .grid th{color:var(--muted);font:600 12px/1 inherit;text-transform:uppercase;
           letter-spacing:.5px;text-align:left;padding:0 4px 6px}
  .grid td{padding:0 4px 4px}
  .grid input{padding:8px;min-width:88px}
  .grid-del{min-height:auto;padding:6px 10px;font-size:14px;color:var(--muted)}
  .grid-actions{margin-top:6px}
  .grid-actions button{min-height:auto;padding:8px 14px;font-size:14px}
  /* Fed fields. Read-only, and it must be obvious at a glance that they are —
     an operator who thinks a field is editable and finds it is not, thirty
     seconds before air, is the failure this styling exists to prevent. */
  .fed{border:1px solid var(--border);border-left:3px solid var(--fed);
       border-radius:6px;padding:10px 12px;margin-bottom:12px;background:var(--panel2)}
  .fed .grid-caption{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
  .fed-tag{color:var(--fed);border:1px solid var(--fed);border-radius:10px;
           padding:1px 7px;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
  .fed-when{color:var(--muted);font-size:11px;margin-left:auto;
            font-family:ui-monospace,Consolas,monospace}
  .fed-val{font:600 22px/1.3 ui-monospace,Consolas,monospace;color:var(--text);
           word-break:break-word}
  .fed-list{margin:0;padding-left:18px;color:var(--text);font-size:14px}
  .fed-list li{margin-bottom:3px}
  .fed table{width:100%;border-collapse:collapse;display:block;overflow-x:auto;white-space:nowrap}
  .fed th{color:var(--muted);font:600 11px/1 inherit;text-transform:uppercase;
          letter-spacing:.5px;text-align:left;padding:0 10px 6px 0}
  .fed td{padding:3px 10px 3px 0;font-family:ui-monospace,Consolas,monospace;font-size:13px}
  .fed-empty{color:var(--muted);font-style:italic;font-size:13px}
  /* Scene elements. Each is a separate graphic on its own channel, so each gets
     its own bordered block — an operator must never be in doubt about which
     graphic a PLAY they are about to press belongs to. */
  .element{border:1px solid var(--border);border-radius:6px;padding:10px 12px;
           margin-bottom:12px;background:var(--panel2)}
  .element-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:8px}
  .element-key{color:var(--muted);font:12px/1 ui-monospace,Consolas,monospace}
  .element-state{margin-left:auto;font-size:13px}
  .element .hint a{color:var(--accent)}
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(composition.name)}</h1>
  <span class="sub">${escapeHtml(projectId)}</span>
  <span class="status">
    <span class="dot" id="dot"></span>
    <span id="status">connecting…</span>
  </span>
</header>

${sceneElementsBlock(elements)}

<fieldset ${
    /*
     * A scene whose every layer is an independent element has no timeline of
     * its own, so its PLAY does nothing visible. Hiding the strip is better
     * than offering a button that appears broken — the elements block above is
     * what the operator wants. A scene that *does* carry its own layers — a
     * shared background band — keeps the strip.
     */
    elements.length > 0 && composition.layers.every((l) => l.type === 'composition' && l.independent)
      ? 'hidden'
      : ''
  }>
  <legend>${elements.length > 0 ? 'Scene layers' : 'Playback'}</legend>
  <div class="verbs">
    <button class="go" data-verb="play">PLAY</button>
    <button data-verb="next" ${stepCount > 1 ? '' : 'hidden'}>NEXT</button>
    <button class="stop" data-verb="stop">STOP</button>
    <button data-verb="clear">CLEAR</button>
  </div>
  <div class="hint">Step <span class="playback" id="step">–</span> · <span class="playback" id="playback">idle</span></div>
</fieldset>

<fieldset ${bindings.length ? '' : 'hidden'}>
  <legend>Dynamic fields</legend>
  <div id="fields"></div>
  ${
    /*
     * No editable field, no button. A panel whose every field is fed — the
     * screen bug is exactly that — would otherwise show an UPDATE ON AIR that
     * sends an empty payload, which reads as broken rather than as "nothing
     * here for you to send".
     */
    bindings.some((b) => !b.readOnly)
      ? `<button id="send" style="width:100%">UPDATE ON AIR</button>
  <div class="hint">Changes apply live — the graphic does not need re-playing.
    Fields marked <span class="fed-tag">fed</span> come from a data source and update on their own.</div>`
      : `<div class="hint">Every field here is fed by a data source and updates on its own.
    There is nothing to send.</div>`
  }
</fieldset>

<script>
window.__BREEZE_CONTROL__ = {
  projectId: ${escapeJson(projectId)},
  compositionId: ${escapeJson(composition.id)},
  bindings: ${escapeJson(bindings)},
  schema: ${escapeJson(schema)},
  stepCount: ${stepCount},
  dataKey: ${escapeJson(DATA_UPDATE_KEY)},
  datasets: ${escapeJson(datasets)},
  elements: ${escapeJson(elements)}
};
</script>
<script src="/public/control.js"></script>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/**
 * Shared chrome for the server-rendered standalone pages — the portal and the
 * user guide. One palette, one type scale, so opening the guide does not feel
 * like leaving the application.
 */
const SHELL_CSS = `
  :root{--bg:#0d1117;--panel:#161b22;--panel2:#1c2129;--border:#30363d;--text:#c9d1d9;
        --muted:#8b949e;--accent:#58a6ff;--live:#3fb950}
  *{box-sizing:border-box}
  body{font:14px/1.6 system-ui,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);
       margin:0;padding:32px}
  a{color:var(--accent)}
  code{background:var(--panel);padding:1px 5px;border-radius:4px;color:var(--muted);font-size:12px}
  h1{font-size:20px;margin:0}
  /* Alongside the title, not in a footer: it is the first thing anyone is asked
     for when a graphic misbehaves, and a footer is below the fold. */
  .version{font-size:12px;color:var(--muted);font-weight:400;vertical-align:middle;
           background:var(--panel);padding:2px 7px;border-radius:10px;margin-left:6px}
  .hint{color:var(--muted)}
  /* Pills. Big enough to hit on a tablet, and visibly a control rather than a
     line of prose with an underline. */
  .pill{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:999px;
        border:1px solid var(--border);background:var(--panel);color:var(--text);
        text-decoration:none;font-weight:600;white-space:nowrap}
  .pill:hover{border-color:var(--accent)}
  .pill.primary{background:#1f6feb;border-color:#388bfd;color:#fff}
  .pill.primary:hover{background:#2b7bf3}`;

/**
 * Portal — the front door for everything the server hosts.
 *
 * Each project is a tile. Closed, it says what the project is and how many
 * scenes it holds; open, it lists every scene with all three of its links
 * together — the operator panel to drive it, the browser-source URL to paste
 * into vMix or OBS, and the debug view for checking it in a normal tab.
 * Assembling those URLs by hand is exactly the kind of friction that gets a
 * graphic misconfigured minutes before air.
 *
 * Built on `<details>` rather than a click handler: it opens without
 * JavaScript, it is keyboard-operable and screen-reader-announced for free, and
 * the one script this page loads is then only ever responsible for the status
 * strip. If that script fails to load, every link on the page still works.
 */
export function portalPage(
  projects: Array<{ id: string; name: string; compositions: Array<{ id: string; name: string }> }>,
  /** Shown in the header; defaulted so callers in tests need not supply it. */
  version = '',
): string {
  const tiles = projects
    .map((p) => {
      const pid = encodeURIComponent(p.id);
      const count = p.compositions.length;
      const scenes = p.compositions
        .map((c) => {
          const cid = encodeURIComponent(c.id);
          return `<div class="scene" data-channel="${escapeHtml(`${p.id}/${c.id}`)}">
            <div class="scene-name">
              ${escapeHtml(c.name)}
              <code>${escapeHtml(c.id)}</code>
              <span class="viewers" data-role="viewers" hidden></span>
            </div>
            <div class="scene-links">
              <a class="btn primary" href="/control/${pid}/${cid}" target="_blank" rel="noreferrer"
                 title="Play, stop and edit fields on air">Control panel</a>
              <a class="btn" href="/play/${pid}/${cid}" target="_blank" rel="noreferrer"
                 title="Paste into a vMix Web Browser input or an OBS Browser Source — transparent, 1:1, no controls">Output URL</a>
              <a class="btn" href="/play/${pid}/${cid}?scale=contain&amp;debug=1" target="_blank" rel="noreferrer"
                 title="Scaled to the window, with an FPS and playback overlay — for checking a graphic in a normal tab">Debug URL</a>
            </div>
          </div>`;
        })
        .join('');

      return `<details class="tile" data-project="${escapeHtml(p.id)}">
        <summary>
          <span class="tile-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
          <code>${escapeHtml(p.id)}</code>
          <span class="tile-count">${count} scene${count === 1 ? '' : 's'}</span>
          <span class="viewers" data-role="project-viewers" hidden></span>
        </summary>
        <div class="tile-body">
          ${scenes || '<p class="hint">No scenes in this project yet. Open the editor to add one.</p>'}
        </div>
      </details>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Breeze Overlay</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<style>${SHELL_CSS}
  header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px}
  .actions{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 6px}
  /* Status strip. Server-rendered empty and filled by the poll — printing a
     placeholder number would be indistinguishable from a stale real one. */
  .status{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0 26px}
  .stat{border:1px solid var(--border);border-radius:8px;background:var(--panel);
        padding:9px 14px;min-width:132px}
  .stat-label{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;
              letter-spacing:.6px}
  .stat-value{font:600 19px/1.3 ui-monospace,Consolas,monospace;color:var(--text)}
  .stat-value.live{color:var(--live)}
  .stat-sub{color:var(--muted);font-size:11px}
  .status.stale{opacity:.5}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);
     font-weight:600;margin:0 0 12px}
  /* Tiles. A grid while closed, full width once open: a project with eight
     scenes in a third-width column wraps its buttons into an unreadable stack,
     and the open tile is the one being read. */
  .tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;
         align-items:start;max-width:1100px}
  .tile{border:1px solid var(--border);border-radius:10px;background:var(--panel);
        overflow:hidden}
  .tile[open]{grid-column:1/-1;border-color:#3d4650}
  /* Every tile header is exactly one row tall, whatever the project is called.
     Wrapping made the grid ragged — a long name pushed the scene count onto a
     second line and that tile alone grew — so the name truncates instead and
     the count keeps its place at the right edge. Tiles are meant to be
     scannable as a set; identical size is what makes them one. */
  summary{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;padding:0 16px;
          height:56px;cursor:pointer;list-style:none;user-select:none}
  summary::-webkit-details-marker{display:none}
  summary::before{content:"\\25B8";flex:0 0 auto;color:var(--muted);font-size:12px;
                  transition:transform .12s}
  .tile[open] summary::before{transform:rotate(90deg)}
  summary:hover{background:var(--panel2)}
  /* min-width:0 is what actually lets a flex child shrink below its content
     and ellipsis — without it the name pushes the count out of the tile. */
  .tile-name{font-weight:600;font-size:15px;min-width:0;flex:0 1 auto;
             overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* The key never truncates; the name does. Of the two, the key is the one
     being read for a reason — it is what appears in every /play URL — and a
     clipped "wc26-d..." is useless where a clipped "World Cup 2026 Bracket..."
     is still perfectly identifiable. */
  summary > code{flex:0 0 auto;white-space:nowrap}
  .tile-count{color:var(--muted);font-size:12px;margin-left:auto;flex:0 0 auto;
              white-space:nowrap}
  .tile-body{border-top:1px solid var(--border);padding:6px 16px 14px}
  .scene{display:flex;align-items:center;gap:12px;flex-wrap:wrap;
         padding:11px 0;border-bottom:1px solid #21262d}
  .scene:last-child{border-bottom:none}
  .scene-name{flex:1;min-width:200px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .scene-links{display:flex;gap:8px;flex-wrap:wrap}
  .btn{display:inline-block;padding:7px 13px;border:1px solid var(--border);border-radius:6px;
       background:var(--panel2);text-decoration:none;color:var(--text);white-space:nowrap;
       font-size:13px}
  .btn:hover{border-color:var(--accent)}
  .btn.primary{background:#1f6feb;border-color:#388bfd;color:#fff}
  /* On-air badge. Only rendered when something is actually connected, so its
     presence carries the meaning and its absence is not a claim. */
  .viewers{flex:0 0 auto;color:var(--live);border:1px solid var(--live);border-radius:10px;
           padding:1px 8px;font-size:11px;letter-spacing:.4px;white-space:nowrap}
  /* The badge appears mid-poll, so it must take its space from the name rather
     than from the count — a tile that reflows when a source connects draws the
     eye to the wrong thing. */
  .tile .viewers{margin-left:0}
  footer{margin-top:36px;color:var(--muted);font-size:12px;max-width:820px}
</style>
</head>
<body>
<header>
  <h1>Breeze Overlay ${version ? `<span class="version">${escapeHtml(version)}</span>` : ''}</h1>
</header>

<div class="actions">
  <a class="pill primary" href="/editor/" target="_blank" rel="noreferrer">Open the editor &#8599;</a>
  <a class="pill" href="/docs" target="_blank" rel="noreferrer">User guide &#8599;</a>
  <a class="pill" href="/activity">Activity</a>
</div>

<div class="status" id="status">
  <!-- No caption under this one. The number is the whole message: naming the
       kinds of client that might be behind it invited reading the label
       instead of the count. -->
  <div class="stat"><span class="stat-label">Browser sources</span>
    <span class="stat-value" id="stat-renderers">&ndash;</span></div>
  <div class="stat"><span class="stat-label">Panels open</span>
    <span class="stat-value" id="stat-controllers">&ndash;</span>
    <span class="stat-sub">control panels &amp; editors</span></div>
  <div class="stat"><span class="stat-label">Server CPU</span>
    <span class="stat-value" id="stat-cpu">&ndash;</span>
    <span class="stat-sub" id="stat-cpu-sub">this process</span></div>
  <div class="stat"><span class="stat-label">Memory</span>
    <span class="stat-value" id="stat-mem">&ndash;</span>
    <span class="stat-sub">resident</span></div>
  <div class="stat"><span class="stat-label">Uptime</span>
    <span class="stat-value" id="stat-uptime">&ndash;</span>
    <span class="stat-sub">since start</span></div>
</div>

<h2>Projects</h2>
<div class="tiles">
${tiles || '<p class="hint">No projects yet. Open the editor and choose <strong>+ New project&hellip;</strong> from the project menu.</p>'}
</div>

<footer>
  <p><strong>Control panel</strong> drives a graphic on air — play, stop and live field edits.
  <strong>Output URL</strong> is what you paste into a vMix Web Browser input or an OBS Browser Source:
  transparent, 1:1, no controls. <strong>Debug URL</strong> scales the stage to the window and shows an
  FPS and playback overlay.</p>
  <p><strong>Opening an Output URL in a desktop browser will clip the frame.</strong> It renders
  1:1 at the composition's full size — 1920&times;1080 for the demos — and a browser window is always
  shorter than that, so the bottom of the frame falls outside the window. A graphic low in the frame, like
  the news ticker at y=1000, plays correctly and is simply not on screen: it looks as though nothing
  happened when PLAY is pressed. Use the <strong>Debug URL</strong> to watch it in a window, and the
  Output URL only in a source sized to the composition. The console on that page says so too.</p>
  <p>Keys in a debug tab: <code>space</code> play · <code>→</code> next · <code>esc</code> stop · <code>backspace</code> clear.</p>
</footer>
<script src="/public/portal.js"></script>
</body>
</html>`;
}

/**
 * Activity — the audit log, read back.
 *
 * Server-rendered and unstyled by JavaScript, like the rest of the standalone
 * pages: this is the page someone opens *after* something went wrong, which is
 * exactly when the fewest moving parts is worth the most.
 *
 * The actor column shows a squinted User-Agent with the full string on hover.
 * A 140-character UA in a table cell makes the table unreadable, and the thing
 * being scanned for is almost always the address.
 */
export function activityPage(
  entries: Array<{
    at: string;
    action: string;
    actor: { ip: string; agent: string };
    project?: string;
    scene?: string;
    name?: string;
  }>,
  /** `describeAgent`, injected so the page stays a pure function of its input. */
  describe: (agent: string) => string,
  filter = '',
): string {
  const shown = filter === '' ? entries : entries.filter((e) => e.action.startsWith(filter));

  /* Grouped so the filter bar reads as the categories rather than six verbs. */
  const filters: Array<[string, string]> = [
    ['', 'Everything'],
    ['project', 'Projects'],
    ['scene', 'Scenes'],
    ['panel', 'Control panels'],
  ];

  const tabs = filters
    .map(
      ([value, label]) =>
        `<a class="tab${value === filter ? ' on' : ''}" href="/activity${
          value ? `?filter=${encodeURIComponent(value)}` : ''
        }">${escapeHtml(label)}</a>`,
    )
    .join('');

  const rows = shown
    .map((e) => {
      const [, verb = ''] = e.action.split('.');
      const target = e.name
        ? `${escapeHtml(e.name)} <code>${escapeHtml(e.scene ?? e.project ?? '')}</code>`
        : `<code>${escapeHtml([e.project, e.scene].filter(Boolean).join('/') || '—')}</code>`;

      return `<tr>
        <td class="when"><time datetime="${escapeHtml(e.at)}">${escapeHtml(
          e.at.replace('T', ' ').replace(/\.\d+Z$/, 'Z'),
        )}</time></td>
        <td><span class="verb ${escapeHtml(verb)}">${escapeHtml(e.action)}</span></td>
        <td>${target}</td>
        <td class="who"><code>${escapeHtml(e.actor.ip)}</code>
          <span title="${escapeHtml(e.actor.agent)}">${escapeHtml(describe(e.actor.agent))}</span></td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Activity — Breeze Overlay</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<style>${SHELL_CSS}
  header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
  .tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
  .tab{padding:6px 13px;border-radius:999px;border:1px solid var(--border);
       background:var(--panel);text-decoration:none;color:var(--muted);font-size:13px}
  .tab:hover{border-color:var(--accent)}
  .tab.on{background:#1f6feb;border-color:#388bfd;color:#fff}
  table{border-collapse:collapse;width:100%;max-width:1100px}
  th{text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;
     letter-spacing:.6px;font-weight:600;padding:0 12px 8px 0;border-bottom:1px solid var(--border)}
  td{padding:9px 12px 9px 0;border-bottom:1px solid #21262d;vertical-align:top;font-size:13px}
  .when{white-space:nowrap;color:var(--muted);font-family:ui-monospace,Consolas,monospace;
        font-size:12px}
  .who{white-space:nowrap}
  .who span{color:var(--muted);margin-left:6px;font-size:12px;cursor:help}
  /* Deletes are the reason this page exists; they should be findable by
     colour before the row is read. */
  .verb{font-family:ui-monospace,Consolas,monospace;font-size:12px;padding:2px 7px;
        border-radius:10px;border:1px solid var(--border);color:var(--muted);white-space:nowrap}
  .verb.delete{color:#f85149;border-color:rgba(248,81,73,.5);background:rgba(248,81,73,.08)}
  .verb.create{color:var(--live);border-color:rgba(63,185,80,.5);background:rgba(63,185,80,.08)}
  footer{margin-top:28px;color:var(--muted);font-size:12px;max-width:820px}
</style>
</head>
<body>
<header>
  <a class="pill" href="/">&larr; Portal</a>
  <h1>Activity</h1>
</header>

<div class="tabs">${tabs}</div>

${
  shown.length === 0
    ? '<p class="hint">Nothing recorded yet. Projects and scenes created or deleted, and control panels connecting, are logged here.</p>'
    : `<table>
  <tr><th>When (UTC)</th><th>What</th><th>Target</th><th>From</th></tr>
  ${rows}
</table>`
}

<footer>
  <p>Breeze has no accounts, so an action is attributed to the address it came from and the
  browser it came from — not to a person. On a LAN with assigned machines that is usually enough
  to identify who; behind a proxy or a VPN it is not, and this page does not pretend otherwise.</p>
  <p>Written to <code>data/audit-&lt;year&gt;-&lt;month&gt;.jsonl</code>, one JSON object per line,
  one file per month. Nothing deletes them for you. Browser sources are not recorded —
  the portal's status strip shows what is connected right now.</p>
</footer>
</body>
</html>`;
}

/**
 * The user guide, wrapped in the portal's chrome.
 *
 * `body` is already-rendered HTML from the Markdown source. Trusted input: it
 * is a file in the installation, not anything a request can supply.
 */
export function docsPage(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>User guide — Breeze Overlay</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<style>${SHELL_CSS}
  body{padding:0}
  .doc-bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;
           padding:12px 32px;background:rgba(13,17,23,.92);backdrop-filter:blur(6px);
           border-bottom:1px solid var(--border)}
  .doc{max-width:860px;margin:0 auto;padding:28px 32px 80px}
  /* Generous measure and spacing: this is 800 lines of prose, usually read on a
     laptop by someone part-way through getting a graphic working. */
  .doc h1{font-size:26px;margin:32px 0 10px}
  .doc h2{font-size:20px;margin:36px 0 10px;padding-top:10px;border-top:1px solid var(--border)}
  .doc h3{font-size:16px;margin:24px 0 8px}
  .doc p,.doc li{font-size:15px;line-height:1.75}
  .doc img{max-width:100%;border:1px solid var(--border);border-radius:8px;display:block;
           margin:16px 0}
  .doc table{border-collapse:collapse;width:100%;margin:16px 0;display:block;overflow-x:auto}
  .doc th,.doc td{border:1px solid var(--border);padding:7px 11px;text-align:left;font-size:14px}
  .doc th{background:var(--panel);color:var(--muted);font-size:12px;text-transform:uppercase;
          letter-spacing:.5px}
  .doc pre{background:var(--panel);border:1px solid var(--border);border-radius:8px;
           padding:12px 14px;overflow-x:auto}
  .doc pre code{background:none;padding:0;color:var(--text);font-size:13px}
  .doc blockquote{margin:16px 0;padding:2px 0 2px 14px;border-left:3px solid var(--border);
                  color:var(--muted)}
  .doc hr{border:none;border-top:1px solid var(--border);margin:32px 0}
</style>
</head>
<body>
<div class="doc-bar">
  <a class="pill" href="/">&larr; Portal</a>
  <a class="pill" href="/editor/" target="_blank" rel="noreferrer">Editor &#8599;</a>
</div>
<article class="doc">
${body}
</article>
</body>
</html>`;
}
