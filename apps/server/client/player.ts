// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Output page bootstrap — the script that runs inside a vMix Web Browser input
 * or an OBS Browser Source.
 *
 * Responsibilities are deliberately thin: fetch the composition, mount the
 * shared runtime, expose the control verbs on `window` for vMix Web Scripting
 * and OBS `executeJavaScript`, and honour query-string commands so an operator
 * can trigger a graphic with nothing but a URL. Everything else lives in
 * @breeze/runtime.
 *
 * A page may carry more than one graphic. A composition holding `composition`
 * layers marked `independent` is a *scene*: the scene's own layers are one
 * runtime, and each independent element is another, on its own control channel,
 * triggered separately (SCENES.md §3). Single-graphic pages take exactly the
 * path they always did.
 */

import { BreezeRuntime, installGlobals, OUTPUT_PAGE_CSS } from '@breeze/runtime';
import { DATA_UPDATE_KEY, type Composition, type DataSet, type SceneElement } from '@breeze/schema';

declare global {
  interface Window {
    __BREEZE__?: {
      projectId: string;
      compositionId: string;
      composition?: Composition;
      /** Compositions this graphic nests, inlined by the server. */
      dependencies?: Composition[];
      assetBase: string;
      /** Current DataSets by source id, inlined so tables paint with real rows. */
      datasets?: Record<string, DataSet>;
      /** Independently triggered elements, in paint order. Empty for a plain graphic. */
      elements?: SceneElement[];
      autoPlay?: boolean;
      debug?: boolean;
    };
  }
}

function injectPageCss(): void {
  const style = document.createElement('style');
  style.textContent = OUTPUT_PAGE_CSS;
  document.head.appendChild(style);
}

/**
 * Say so, in the console, when the window is smaller than the frame.
 *
 * The output page renders 1:1 by design — a browser source is a fixed 1920×1080
 * canvas and every pixel has to land where the author put it, so this page must
 * never scale itself to whatever window happens to be open. The consequence is
 * that in a desktop browser, which is always shorter than 1080 once tab and
 * bookmark bars are counted, the bottom of the frame is simply outside the
 * window and clipped by `overflow: hidden`.
 *
 * That is invisible in the worst way. A lower third at y=820–970 still shows, so
 * the page looks fine; a ticker at y=1000–1064 does not, so it reads as "the
 * ticker is broken" or "PLAY did nothing" when the graphic is playing correctly
 * a hundred pixels below the window. Diagnosing it means knowing both the stage
 * height and the layer's y — the two facts a console line can supply for free.
 *
 * Console only. This page goes to air: nothing here may draw, and nothing may
 * change layout.
 */
function warnIfWindowSmallerThanStage(composition: Composition, scaled: boolean): void {
  if (scaled) return;

  const { width, height } = composition.stage;
  const shortBy = height - window.innerHeight;
  const narrowBy = width - window.innerWidth;
  if (shortBy <= 0 && narrowBy <= 0) return;

  const cut = [
    shortBy > 0 ? `${shortBy}px off the bottom` : null,
    narrowBy > 0 ? `${narrowBy}px off the right` : null,
  ].filter(Boolean).join(' and ');

  console.warn(
    `[breeze] This window is ${window.innerWidth}×${window.innerHeight} but the stage is ` +
      `${width}×${height}, so ${cut} of the frame is outside the window and will not be ` +
      `visible here. Graphics low in the frame — a ticker at y=1000, say — can play correctly ` +
      `and still look like nothing happened. This page is deliberately 1:1 and unaffected in a ` +
      `${width}×${height} browser source; add ?scale=contain to preview it scaled to the window.`,
  );
}

/** Page-level parameters that are never binding values. */
const RESERVED_PARAMS = new Set(['autoplay', 'debug', 'scale']);

/**
 * Split the query string into per-channel field payloads.
 *
 * On a single graphic `?name=Jane` seeds the one runtime, exactly as before. On
 * a scene there is more than one graphic, so the channel is named with a dot:
 * `?bug.temp=72&lower-third.name=Jane`. A parameter with no dot goes to the
 * scene's own layers.
 *
 * Split on the *first* dot only — the remainder is the binding name, which
 * keeps "the bit before the first dot is the channel" true regardless of what
 * follows.
 *
 * A prefix matching no channel on this page is reported rather than dropped.
 * Silent discard is how an operator spends twenty minutes on a typo.
 */
export function splitQueryFields(
  search: string,
  channels: Set<string>,
): {
  scene: Record<string, string>;
  byChannel: Map<string, Record<string, string>>;
  unknown: string[];
} {
  const scene: Record<string, string> = {};
  const byChannel = new Map<string, Record<string, string>>();
  const unknown = new Set<string>();

  for (const [key, value] of new URLSearchParams(search)) {
    if (RESERVED_PARAMS.has(key)) continue;

    const dot = key.indexOf('.');
    // No dot, or nothing to address: the original single-graphic behavior.
    if (dot <= 0 || channels.size === 0) {
      scene[key] = value;
      continue;
    }

    const channel = key.slice(0, dot);
    const field = key.slice(dot + 1);

    if (!channels.has(channel)) {
      unknown.add(channel);
      continue;
    }
    if (field.length === 0) continue;

    const bucket = byChannel.get(channel) ?? {};
    bucket[field] = value;
    byChannel.set(channel, bucket);
  }

  return { scene, byChannel, unknown: [...unknown] };
}

/** A mounted graphic and everything the page needs to talk about it. */
interface Mounted {
  /** Channel name — second segment of the channel key. */
  channel: string;
  /** Human label for the debug overlay. */
  label: string;
  runtime: BreezeRuntime;
  /** Fields this graphic was opened with, protected from channel resync. */
  seed: Record<string, string>;
}

function makeDebugOverlay(mounted: Mounted[]): void {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;left:8px;top:8px;z-index:99999;font:12px/1.4 monospace;color:#0f0;' +
    'background:rgba(0,0,0,.6);padding:6px 8px;border-radius:4px;pointer-events:none;white-space:pre';
  document.body.appendChild(el);

  let frames = 0;
  let last = performance.now();
  let fps = 0;

  const tick = () => {
    frames += 1;
    const now = performance.now();
    if (now - last >= 1000) {
      fps = Math.round((frames * 1000) / (now - last));
      frames = 0;
      last = now;
    }

    /*
     * One overlay for the page, one line per graphic. Not one overlay each:
     * they would stack in the same corner and the page under test would be
     * unreadable, which is the opposite of what a debug view is for.
     *
     * `currentStep` counts holds reached, so it is already 1-based once the
     * graphic is holding and 0 before the first hold. Adding one here made the
     * single hold of a lower third read "step 2/2".
     */
    const lines = mounted.map(({ label, runtime }) =>
      `${label}  ${runtime.playbackState}  t=${runtime.currentTime.toFixed(3)}s / ` +
      `${runtime.duration.toFixed(3)}s  step ${runtime.currentStep}/${runtime.stepCount}`,
    );
    el.textContent = `${lines.join('\n')}\n${fps} fps`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * Join the control hub as a renderer.
 *
 * The reconnect path is the point of this, not the happy path. A browser source
 * loses its socket for all sorts of dull reasons mid-show — wifi, a switch, the
 * server restarting between rehearsal and transmission. On reconnect the hub
 * replays the channel's current dynamic data, so the graphic comes back showing
 * the right name instead of the authored placeholder.
 *
 * One socket per runtime, deliberately not multiplexed. `HubClient.channel` is
 * a single string and `{type:'state'}` frames carry no channel of their own, so
 * one socket serving several channels would mean teaching the hub a set of
 * channels per client and threading a channel through every state frame — real
 * complexity in the piece that must never get confused about what is on air, to
 * save two sockets from one browser source.
 */
function connectToHub(
  runtime: BreezeRuntime,
  projectId: string,
  channelName: string,
  /**
   * Fields supplied in this page's URL for *this* graphic. They outrank the
   * hub's retained channel data, which otherwise overwrites them the instant
   * the socket opens.
   *
   * Both behaviors are wanted and they collide: `?name=Jane` is an explicit
   * instruction for *this* output, while resync exists so a source that drops
   * mid-show returns showing whatever the operator last typed. Precedence by
   * specificity settles it — the URL wins for the fields it names, the channel
   * fills in the rest.
   *
   * Per graphic, not per page: `?bug.temp=72` must not stop the lower third
   * adopting the operator's last name entry.
   */
  pinned: Set<string>,
): void {
  const channel = `${projectId}/${channelName}`;
  let socket: WebSocket | null = null;
  let retry = 0;

  const report = () => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: 'state',
        playback: {
          state: runtime.playbackState,
          time: runtime.currentTime,
          step: runtime.currentStep,
          stepCount: runtime.stepCount,
        },
      }),
    );
  };

  const apply = (command: { verb: string; data?: Record<string, unknown>; time?: number }) => {
    switch (command.verb) {
      case 'play':
        if (command.data) runtime.update(command.data);
        runtime.play();
        break;
      case 'stop': runtime.stop(); break;
      case 'next': runtime.next(); break;
      case 'clear': runtime.clear(); break;
      case 'seek': runtime.seek(command.time ?? 0); break;
      case 'update': if (command.data) runtime.update(command.data); break;
      default: return;
    }
    report();
  };

  const connect = () => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}/ws/control`);

    socket.addEventListener('open', () => {
      retry = 0;
      socket!.send(JSON.stringify({ type: 'subscribe', channel, role: 'renderer' }));
    });

    socket.addEventListener('message', (event) => {
      let message: { type: string; command?: Parameters<typeof apply>[0]; state?: { data?: Record<string, unknown> } };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (message.type === 'command' && message.command) {
        apply(message.command);
        return;
      }
      // Resync: adopt the channel's current field values on (re)connect,
      // except any this page was opened with.
      if (message.type === 'welcome' && message.state?.data) {
        const adopt: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(message.state.data)) {
          if (!pinned.has(key)) adopt[key] = value;
        }
        if (Object.keys(adopt).length) runtime.update(adopt);
        report();
      }
    });

    socket.addEventListener('close', () => {
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, Math.min(500 * 2 ** retry, 10_000));
    });

    socket.addEventListener('error', () => socket?.close());
  };

  // Keep controllers' status readouts honest as the graphic moves through its
  // own lifecycle, not only when commanded.
  for (const event of ['play', 'hold', 'stop', 'finished'] as const) {
    runtime.on(event, () => report());
  }

  connect();
}

async function main(): Promise<void> {
  injectPageCss();

  const boot = window.__BREEZE__;
  if (!boot) {
    document.body.textContent = 'Breeze: missing bootstrap data';
    return;
  }

  const composition =
    boot.composition ??
    ((await (
      await fetch(`/api/projects/${boot.projectId}/compositions/${boot.compositionId}`)
    ).json()) as Composition);

  const elements = boot.elements ?? [];

  const params = new URLSearchParams(location.search);
  const scaleMode = params.get('scale') === 'contain' ? 'contain' : 'none';

  const stage = document.createElement('div');
  stage.id = 'breeze-stage';
  stage.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;';
  document.body.appendChild(stage);

  const byId = new Map((boot.dependencies ?? []).map((c) => [c.id, c]));
  byId.set(composition.id, composition);

  const { scene: sceneSeed, byChannel, unknown } = splitQueryFields(
    location.search,
    new Set(elements.map((e) => e.channel)),
  );

  if (unknown.length > 0) {
    console.warn(
      `[breeze] Query parameters addressed to unknown element(s): ${unknown.join(', ')}. ` +
        `This page carries: ${elements.map((e) => e.channel).join(', ') || '(none)'}. ` +
        'Nothing was applied for those names.',
    );
  }

  /*
   * Server-side rows are seeded at construction, not pushed after mount.
   *
   * A table built empty and filled a tick later flashes its authored snapshot —
   * or nothing — for one frame, and one frame is visible on air. Passing them in
   * `data` means the very first paint has the real rows.
   */
  const datasets = boot.datasets && Object.keys(boot.datasets).length ? boot.datasets : null;

  /*
   * Every runtime gets the same `scaleMode`, and that is what keeps a scene
   * coherent under `?scale=contain`.
   *
   * `fitToContainer` measures the runtime's *container*, and every container
   * here is the same size — a full-bleed child of the same stage div — so each
   * runtime independently computes the same scale factor. Scaling the wrapper
   * instead would double-apply for any runtime also asked to fit itself.
   */
  const build = (comp: Composition, container: HTMLElement, seed: Record<string, string>) =>
    new BreezeRuntime({
      container,
      composition: comp,
      resolveComposition: (id) => byId.get(id),
      resolveAsset: (src) =>
        /^(https?:)?\/\//.test(src) || src.startsWith('data:') ? src : `${boot.assetBase}/${src.replace(/^assets\//, '')}`,
      data: datasets ? { ...seed, [DATA_UPDATE_KEY]: datasets } : { ...seed },
      scaleMode,
      injectStyles: true,
    });

  const addContainer = (channel: string): HTMLElement => {
    const container = document.createElement('div');
    container.dataset['breezeChannel'] = channel;
    container.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;';
    stage.appendChild(container);
    return container;
  };

  const runtime = build(composition, addContainer(boot.compositionId), sceneSeed);

  const mounted: Mounted[] = [
    {
      channel: boot.compositionId,
      label: composition.name || boot.compositionId,
      runtime,
      seed: sceneSeed,
    },
  ];
  const elementRuntimes = new Map<string, BreezeRuntime>();

  /*
   * Elements mount in paint order — layer order in the scene — because that is
   * what decides whether the bug sits over or under the strap.
   *
   * Each mount is wrapped separately. One element failing to build must not
   * take the page black: a scene that loses its bug and keeps its lower third
   * is recoverable on air, and a blank browser source is not.
   */
  for (const element of elements) {
    const comp = byId.get(element.ref);
    if (!comp) {
      console.error(
        `[breeze] Element "${element.channel}" references composition "${element.ref}", ` +
          'which this page did not receive. Nothing is mounted on that channel.',
      );
      continue;
    }

    const seed = byChannel.get(element.channel) ?? {};
    try {
      const elementRuntime = build(comp, addContainer(element.channel), seed);
      elementRuntimes.set(element.channel, elementRuntime);
      mounted.push({ channel: element.channel, label: element.name, runtime: elementRuntime, seed });
    } catch (err) {
      console.error(
        `[breeze] Element "${element.channel}" failed to build; the rest of the page is unaffected.`,
        err,
      );
    }
  }

  installGlobals(runtime, globalThis as unknown as Record<string, unknown>, elementRuntimes);

  for (const item of mounted) {
    connectToHub(item.runtime, boot.projectId, item.channel, new Set(Object.keys(item.seed)));
  }

  if (boot.debug || params.get('debug') === '1') makeDebugOverlay(mounted);

  warnIfWindowSmallerThanStage(composition, scaleMode === 'contain');

  /*
   * Autoplay is opt-in.
   *
   * A graphic must not go to air merely because someone added a Browser Source
   * in OBS or opened the page to check it — putting things on air is the
   * control panel's job, or a REST trigger's. The page therefore loads showing
   * nothing and waits to be told.
   *
   * `?autoplay=1` restores the old behavior for the simple workflow where the
   * source appearing in the switcher *is* the cue. On a scene it rolls every
   * graphic on the page: partial autoplay would need a syntax nobody has asked
   * for, and the case this serves is rehearsal, where everything up at once is
   * exactly what you want to look at.
   */
  const requested = params.get('autoplay');
  const autoPlay =
    requested !== null ? requested === '1' || requested === 'true' : boot.autoPlay === true;

  if (autoPlay) for (const item of mounted) item.runtime.play();

  /*
   * Keyboard control while previewing the page in a normal browser.
   *
   * Drives every graphic on the page, for the same reason autoplay does: this
   * is a preview convenience, and a scene stepped one element at a time tells
   * you nothing about how the elements look together.
   */
  window.addEventListener('keydown', (e) => {
    const all = (fn: (r: BreezeRuntime) => void) => { for (const item of mounted) fn(item.runtime); };
    if (e.key === ' ') { e.preventDefault(); all((r) => r.play()); }
    else if (e.key === 'Escape') all((r) => r.stop());
    else if (e.key === 'ArrowRight') all((r) => r.next());
    else if (e.key === 'Backspace') all((r) => r.clear());
  });
}

void main();
