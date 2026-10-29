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

import { BreezeRuntime, OgrafAdapter, installGlobals, OUTPUT_PAGE_CSS } from '@breeze/runtime';
import {
  DATA_UPDATE_KEY,
  KEYING_PARAMS,
  MODE_UPDATE_KEY,
  MOUNTS_UPDATE_KEY,
  orderMounts,
  outputKeying,
  type Composition,
  type DataSet,
  type OutputMount,
  type SceneElement,
} from '@breeze/schema';
import { SYNC_AUTO, joinTarget, reportOf, type ChannelStateLike } from './join.js';

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
      /** The project's mode (Wave 6), inlined so layer rules paint in it. */
      mode?: string;
      /** Independently triggered elements, in paint order. Empty for a plain graphic. */
      elements?: SceneElement[];
      /**
       * Set on an output page (`/out/<project>/<output>`, Phase 9 Wave A): the
       * output's name. The page then has no composition of its own and mounts
       * whatever the rundown takes onto it, from `compositions`.
       */
      output?: string;
      /** Output pages: every composition in the project, so any of them can be mounted. */
      compositions?: Composition[];
      /** Where hls.js is, for a media layer playing HLS (Wave 8). */
      hlsScript?: string;
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

/**
 * Page-level parameters that are never binding values.
 *
 * `bg` and `matte` (Phase 9 Wave C) shape the page for a hardware switcher; a
 * field that happens to be called `bg` can still be set from the panel, just
 * not from this page's URL.
 */
const RESERVED_PARAMS = new Set<string>(['autoplay', 'debug', 'scale', 'preview', 'sync', 'hub', 'ograf', ...KEYING_PARAMS]);

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
  /**
   * Late join (0.74.1): this page's id, shared by every socket it opens, and
   * which output to take up from when it connects to a graphic already on air
   * — `?sync=`, see `client/join.ts`.
   */
  join: PageJoin,
): { close: () => void } {
  const channel = `${projectId}/${channelName}`;
  let socket: WebSocket | null = null;
  let retry = 0;
  /** Unmounted from an output page: stop reconnecting. */
  let closed = false;

  const report = () => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    // One builder for the report (`client/join.ts`), shared with the panel's
    // sync check, so what an output says and what a preview is compared on
    // cannot drift apart.
    socket.send(JSON.stringify({ type: 'state', playback: reportOf(runtime) }));
  };

  const apply = (command: {
    verb: string;
    data?: Record<string, unknown>;
    time?: number;
    table?: string;
    page?: number;
    key?: string;
    cycle?: string;
    step?: number;
    cut?: boolean;
  }) => {
    const table = typeof command.table === 'string' && command.table !== '' ? command.table : undefined;
    switch (command.verb) {
      case 'play':
        if (command.data) runtime.update(command.data);
        runtime.play();
        break;
      // A cut stop (OGraf's skipAnimation, Phase 9 Wave D) is off at once.
      case 'stop': if (command.cut) runtime.clear(); else runtime.stop(); break;
      case 'step': if (typeof command.step === 'number') runtime.goToStep(command.step, { cut: command.cut === true }); break;
      case 'next': runtime.next(table); break;
      case 'prev': runtime.prev(table); break;
      case 'page':
        if (typeof command.key === 'string') runtime.goToPage({ key: command.key }, table);
        else if (typeof command.page === 'number') runtime.goToPage({ n: command.page }, table);
        break;
      case 'cycle':
        if (command.cycle === 'hold' || command.cycle === 'resume') runtime.setCycle(command.cycle, table);
        break;
      case 'clear': runtime.clear(); break;
      case 'seek': runtime.seek(command.time ?? 0); break;
      case 'update': if (command.data) runtime.update(command.data); break;
      // Cue → take (Phase 9 Wave A): on air, the outro runs before the values change.
      case 'take': runtime.take(command.data ?? {}); break;
      default: return;
    }
    report();
  };

  const connect = () => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}/ws/control`);

    socket.addEventListener('open', () => {
      retry = 0;
      /*
       * `?preview=1` subscribes as a preview: it receives every command, so the
       * embed in an operator panel follows the PLAY that operator just pressed,
       * and it is counted as no output at all. The panel's "outputs connected"
       * has to mean vMix and OBS, never the operator's own window.
       */
      const role = new URLSearchParams(location.search).get('preview') === '1'
        ? 'preview'
        : 'renderer';
      socket!.send(JSON.stringify({
        type: 'subscribe',
        channel,
        role,
        page: join.page,
        // A matte page says so, so the panel can pair it with its fill.
        ...(join.signal ? { signal: join.signal } : {}),
      }));
    });

    socket.addEventListener('message', (event) => {
      let message: {
        type: string;
        command?: Parameters<typeof apply>[0];
        state?: ChannelStateLike & { data?: Record<string, unknown> };
      };
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
        /*
         * Late join: a graphic already on air when this page arrived is taken
         * up from another output's report — a browser source reloaded mid-show
         * comes back showing the hold, not blank until the next PLAY.
         *
         * `joinAt` only acts on an idle runtime, so a socket that merely
         * dropped and reconnected — its graphic still running — is untouched.
         */
        const target = joinTarget(message.state, join.choice, join.page);
        if (target) runtime.joinAt(target);
        report();
      }
    });

    socket.addEventListener('close', () => {
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, Math.min(500 * 2 ** retry, 10_000));
    });

    socket.addEventListener('error', () => socket?.close());
  };

  // Keep controllers' status readouts honest as the graphic moves through its
  // own lifecycle, not only when commanded.
  // `page` too: a cycle turns pages with nobody pressing anything, and the
  // panel's page readout is only as current as the last report.
  // `crawl` too (0.75.0): a ticker's copy changing is what a page joining late
  // has to match, and it happens with nobody pressing anything.
  // `scroll` too (Wave R): a roll's extent is what the hub clamps the transport with.
  for (const event of ['play', 'hold', 'stop', 'finished', 'page', 'crawl', 'scroll'] as const) {
    runtime.on(event, () => report());
  }

  /*
   * A heartbeat while on air (0.75.0).
   *
   * Reports are otherwise sent on events, so between them the hub's picture of
   * a ticker's position and a page's time left only ages. Every few seconds
   * keeps a joining page's starting point fresh and gives the panel's sync
   * check something current to compare against. The hub relays a heartbeat
   * only when something other than the passage of time changed, so this costs
   * one small frame to the server and nothing to the panels.
   */
  const heartbeat = setInterval(() => {
    const state = runtime.playbackState;
    if (state === 'holding' || state === 'playing-in') report();
  }, HEARTBEAT_MS);

  connect();
  return {
    close: () => {
      closed = true;
      clearInterval(heartbeat);
      socket?.close();
    },
  };
}

/**
 * Follow a channel's project-wide state without taking its commands
 * (`?hub=data`, Phase 9 Wave D).
 *
 * For a pointer package's page inside an OGraf renderer. That graphic is its
 * own instance, driven by its OGraf controller, so the channel's PLAYs and
 * typed fields are not its business — an operator taking the Breeze copy of
 * the lower third to air must not roll it in SPX too. What *is* its business
 * is what is project-wide: the data sources' rows and the project mode. So it
 * subscribes as a controller (`client: 'ograf'`, which the hub counts as no
 * panel), receives the channel's state, and adopts those two keys and nothing
 * else. Never reports: it is not one of this channel's outputs.
 */
function followData(runtime: BreezeRuntime, projectId: string, channelName: string): void {
  const channel = `${projectId}/${channelName}`;
  let retry = 0;
  /** JSON of what was last adopted per key, so an unchanged DataSet is not rebound. */
  const last = new Map<string, string>();

  const adopt = (data: Record<string, unknown> | undefined): void => {
    if (!data) return;
    const out: Record<string, unknown> = {};
    for (const key of [DATA_UPDATE_KEY, MODE_UPDATE_KEY]) {
      if (!(key in data)) continue;
      const json = JSON.stringify(data[key]);
      if (last.get(key) === json) continue;
      last.set(key, json);
      out[key] = data[key];
    }
    if (Object.keys(out).length) runtime.update(out);
  };

  const connect = (): void => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws/control`);
    socket.addEventListener('open', () => {
      retry = 0;
      socket.send(JSON.stringify({ type: 'subscribe', channel, role: 'controller', client: 'ograf' }));
    });
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type: string; state?: { data?: Record<string, unknown> } };
        if (message.type === 'welcome' || message.type === 'state') adopt(message.state?.data);
      } catch {
        // A frame that is not JSON is not ours to act on.
      }
    });
    socket.addEventListener('close', () => {
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, Math.min(500 * 2 ** retry, 10_000));
    });
    socket.addEventListener('error', () => socket.close());
  };
  connect();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Answer OGraf actions from the frame's parent (`?ograf=1`, Phase 9 Wave D).
 *
 * The parent is a pointer package's `graphic.mjs`, in an OGraf renderer on
 * another origin, so the two talk by `postMessage`: `{ breezeOgraf: 1, id,
 * method, params }` in, `{ breezeOgraf: 1, id, result }` back, and one
 * `{ breezeOgraf: 1, ready: true }` once the runtime is built. Only the
 * parent is listened to — anything else that can post to this window is not
 * driving the graphic. There is nothing to gate beyond that: this page is the
 * parent's own instance, on no channel of ours (`?hub=data`), and what it can
 * be told to do is no more than `window.play()` already offers its embedder.
 */
function ografBridge(runtime: BreezeRuntime): void {
  if (window.parent === window) return;
  const adapter = new OgrafAdapter(runtime);
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const message: unknown = event.data;
    if (!isPlainObject(message) || message['breezeOgraf'] !== 1) return;
    const id = message['id'];
    const method = message['method'];
    if (typeof id !== 'number' || typeof method !== 'string') return;
    const params = isPlainObject(message['params']) ? message['params'] : {};
    const run = (): Promise<unknown> => {
      switch (method) {
        case 'playAction': return adapter.playAction(params);
        case 'stopAction': return adapter.stopAction(params);
        case 'updateAction': return adapter.updateAction(params);
        case 'customAction': return adapter.customAction(params);
        default: return Promise.resolve({ statusCode: 400, statusMessage: `unknown method "${method}"` });
      }
    };
    void run()
      .catch((err: unknown) => ({ statusCode: 500, statusMessage: err instanceof Error ? err.message : String(err) }))
      .then((result) => {
        // Back to whoever asked; an opaque origin can only be answered with '*'.
        window.parent.postMessage({ breezeOgraf: 1, id, result }, event.origin && event.origin !== 'null' ? event.origin : '*');
      });
  });
  // Nothing private in it, and the parent's origin is not known until it speaks.
  window.parent.postMessage({ breezeOgraf: 1, ready: true, stepCount: adapter.stepCount }, '*');
}

/**
 * What every socket on one page shares: the page's id, which output it takes
 * up from (`?sync=`), and whether it renders the key signal (`?matte=1`).
 */
interface PageJoin {
  page: string;
  choice: string;
  signal?: 'matte';
}

/**
 * `?bg=` and `?matte=1` (Phase 9 Wave C).
 *
 * The server has already written the CSS into the head, so the first frame is
 * right; the page reads the same parse only to tell the hub it is a matte and
 * to say, in the console, what it ignored. Console only — this page is on air.
 */
function pageSignal(params: URLSearchParams): Pick<PageJoin, 'signal'> {
  const keying = outputKeying(params);
  for (const problem of keying.problems) console.warn(`[breeze] ${problem}`);
  return keying.matte ? { signal: 'matte' } : {};
}

/** How often an output on air re-reports where it is. See `connectToHub`. */
const HEARTBEAT_MS = 5_000;

/** A random id for this page load. Not a secret — only a tag other pages can name it by. */
function newPageId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

async function main(): Promise<void> {
  injectPageCss();

  const boot = window.__BREEZE__;
  if (!boot) {
    document.body.textContent = 'Breeze: missing bootstrap data';
    return;
  }
  if (boot.output) {
    runOutput(boot as OutputBoot);
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
      data: {
        ...seed,
        ...(datasets ? { [DATA_UPDATE_KEY]: datasets } : {}),
        ...(boot.mode ? { [MODE_UPDATE_KEY]: boot.mode } : {}),
      },
      ...(boot.hlsScript ? { hlsScript: boot.hlsScript } : {}),
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

  /*
   * One id for the page, however many graphics it carries: an output is a
   * browser source, not a socket, and a preview told to follow one follows it
   * on every channel the page has (0.74.1).
   */
  const join: PageJoin = { page: newPageId(), choice: params.get('sync')?.trim() || SYNC_AUTO, ...pageSignal(params) };
  /*
   * `?hub=off` — no socket at all (Phase 9 Wave A). The rundown panel's
   * "show cued" preview drives this page itself, through `window.breeze`, with
   * values that are not on air; following the channel would put the on-air
   * values back over them.
   */
  const hubMode = params.get('hub');
  if (hubMode === 'data') {
    // An OGraf pointer graphic (Phase 9 Wave D): the project's data, not the channel's commands.
    for (const item of mounted) followData(item.runtime, boot.projectId, item.channel);
  } else if (hubMode !== 'off') {
    for (const item of mounted) {
      connectToHub(item.runtime, boot.projectId, item.channel, new Set(Object.keys(item.seed)), join);
    }
  }
  if (params.get('ograf') === '1') ografBridge(runtime);

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
    else if (e.key === 'ArrowLeft') all((r) => r.prev());
    else if (e.key === 'Backspace') all((r) => r.clear());
  });
}

type OutputBoot = NonNullable<Window['__BREEZE__']> & { output: string };

/**
 * An output page — `/out/<project>/<output>` (Phase 9 Wave A).
 *
 * A channel with no composition of its own. It listens on the routing channel
 * `${project}/@<output>` and mounts whichever compositions the rundown takes
 * onto it, each into its own container and runtime, exactly as a scene mounts
 * its elements — and each on its own channel, `@<output>~<composition>`, so
 * late join, playback reports and retained values work per graphic.
 *
 * Commands on the routing channel carry `mount` to say which graphic they are
 * for: `take` mounts it if it is not there yet, then takes; `stop`, `next`,
 * `prev` and `clear` without one act on everything mounted, and `clear`
 * unmounts. `update` with `$mounts` is the list itself, in stacking order — the
 * hub retains it, so a reloaded page rebuilds the same stack.
 */
function runOutput(boot: OutputBoot): void {
  const params = new URLSearchParams(location.search);
  const scaleMode = params.get('scale') === 'contain' ? 'contain' : 'none';
  const role = params.get('preview') === '1' ? 'preview' : 'renderer';

  const stage = document.createElement('div');
  stage.id = 'breeze-stage';
  stage.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;';
  document.body.appendChild(stage);

  const byId = new Map((boot.compositions ?? []).map((c) => [c.id, c]));
  let datasets: Record<string, DataSet> = boot.datasets ?? {};
  let mode = boot.mode ?? '';

  interface Mount {
    composition: string;
    container: HTMLElement;
    runtime: BreezeRuntime;
    hub: { close: () => void };
  }
  const mounts = new Map<string, Mount>();
  const debugList: Mounted[] = [];
  const join: PageJoin = { page: newPageId(), choice: params.get('sync')?.trim() || SYNC_AUTO, ...pageSignal(params) };

  const refresh = async (): Promise<void> => {
    // A composition added after this page loaded: fetch the project again.
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(boot.projectId)}`);
      if (!res.ok) return;
      const project = (await res.json()) as { compositions?: Composition[] };
      for (const c of project.compositions ?? []) byId.set(c.id, c);
    } catch {
      // Offline: the mount is skipped and logged below.
    }
  };

  const mount = async (compositionId: string): Promise<Mount | null> => {
    const existing = mounts.get(compositionId);
    if (existing) return existing;
    if (!byId.has(compositionId)) await refresh();
    const comp = byId.get(compositionId);
    if (!comp) {
      console.error(`[breeze] Output "${boot.output}" was asked to show "${compositionId}", which this project does not have.`);
      return null;
    }
    // Mounted while awaiting: the same id may have been asked for twice.
    const raced = mounts.get(compositionId);
    if (raced) return raced;
    const container = document.createElement('div');
    container.dataset['breezeChannel'] = `@${boot.output}~${compositionId}`;
    container.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;';
    stage.appendChild(container);
    try {
      const runtime = new BreezeRuntime({
        container,
        composition: comp,
        resolveComposition: (id) => byId.get(id),
        resolveAsset: (src) =>
          /^(https?:)?\/\//.test(src) || src.startsWith('data:') ? src : `${boot.assetBase}/${src.replace(/^assets\//, '')}`,
        data: {
          ...(Object.keys(datasets).length ? { [DATA_UPDATE_KEY]: datasets } : {}),
          ...(mode ? { [MODE_UPDATE_KEY]: mode } : {}),
        },
        ...(boot.hlsScript ? { hlsScript: boot.hlsScript } : {}),
        scaleMode,
        injectStyles: true,
      });
      // Keep the page's copy of the rows current, for graphics mounted later.
      runtime.on('update', ({ data }) => {
        const pushed = (data as Record<string, unknown>)[DATA_UPDATE_KEY];
        if (pushed && typeof pushed === 'object') datasets = { ...datasets, ...(pushed as Record<string, DataSet>) };
        const m = (data as Record<string, unknown>)[MODE_UPDATE_KEY];
        if (typeof m === 'string') mode = m;
      });
      const hub = connectToHub(runtime, boot.projectId, `@${boot.output}~${compositionId}`, new Set(), join);
      const entry: Mount = { composition: compositionId, container, runtime, hub };
      mounts.set(compositionId, entry);
      debugList.push({ channel: compositionId, label: comp.name || compositionId, runtime, seed: {} });
      return entry;
    } catch (err) {
      console.error(`[breeze] "${compositionId}" failed to build on output "${boot.output}"; the rest of the page is unaffected.`, err);
      container.remove();
      return null;
    }
  };

  const unmount = (compositionId: string): void => {
    const entry = mounts.get(compositionId);
    if (!entry) return;
    entry.hub.close();
    entry.runtime.destroy();
    entry.container.remove();
    mounts.delete(compositionId);
    const at = debugList.findIndex((d) => d.channel === compositionId);
    if (at !== -1) debugList.splice(at, 1);
  };

  /** Bring the page to the hub's list: mount what is missing, drop what left, stack in order. */
  const sync = async (list: OutputMount[], additive = false): Promise<void> => {
    const ordered = orderMounts(list);
    const wanted = new Set(ordered.map((m) => m.composition));
    if (!additive) for (const id of [...mounts.keys()]) if (!wanted.has(id)) unmount(id);
    for (const m of ordered) await mount(m.composition);
    for (const m of ordered) {
      const entry = mounts.get(m.composition);
      if (entry) stage.appendChild(entry.container);
    }
  };

  const each = (target: string | undefined, fn: (r: BreezeRuntime) => void): void => {
    if (target) {
      const entry = mounts.get(target);
      if (entry) fn(entry.runtime);
      return;
    }
    for (const entry of mounts.values()) fn(entry.runtime);
  };

  // Commands are applied in arrival order, even when one has to mount first.
  let queue: Promise<void> = Promise.resolve();
  const apply = (
    command: {
      verb: string;
      mount?: string;
      data?: Record<string, unknown>;
      step?: number;
      cut?: boolean;
      table?: string;
      page?: number;
      key?: string;
      cycle?: string;
    },
    additive = false,
  ): void => {
    queue = queue.then(async () => {
      const table = typeof command.table === 'string' && command.table !== '' ? command.table : undefined;
      switch (command.verb) {
        case 'update': {
          const list = command.data?.[MOUNTS_UPDATE_KEY];
          if (Array.isArray(list)) await sync(list as OutputMount[], additive);
          return;
        }
        case 'take': {
          if (!command.mount) return;
          const entry = await mount(command.mount);
          entry?.runtime.take(command.data ?? {});
          return;
        }
        /*
         * OGraf on an output (Phase 9 Wave D): PLAY and a step go through this
         * routing channel, not the mount's own, because a composition loaded a
         * moment ago may not be mounted — or subscribed there — yet. Queued
         * here, the mount comes first and the command lands on it.
         */
        case 'play':
        case 'step': {
          if (!command.mount) return;
          const entry = await mount(command.mount);
          if (!entry) return;
          if (command.verb === 'play') entry.runtime.play();
          else if (typeof command.step === 'number') entry.runtime.goToStep(command.step, { cut: command.cut === true });
          return;
        }
        case 'page':
          each(command.mount, (r) => {
            if (typeof command.key === 'string') r.goToPage({ key: command.key }, table);
            else if (typeof command.page === 'number') r.goToPage({ n: command.page }, table);
          });
          return;
        case 'cycle':
          if (command.cycle === 'hold' || command.cycle === 'resume') {
            const state = command.cycle;
            each(command.mount, (r) => r.setCycle(state, table));
          }
          return;
        // A cut stop takes the graphic off at once and leaves it mounted; CLEAR unmounts.
        case 'stop': each(command.mount, (r) => (command.cut ? r.clear() : r.stop())); return;
        case 'next': each(command.mount, (r) => r.next(table)); return;
        case 'prev': each(command.mount, (r) => r.prev(table)); return;
        case 'clear':
          if (command.mount) unmount(command.mount);
          else for (const id of [...mounts.keys()]) unmount(id);
          return;
        default:
      }
    }).catch((err: unknown) => console.error('[breeze] output command failed', err));
  };

  const routing = `${boot.projectId}/@${boot.output}`;
  let socket: WebSocket | null = null;
  let retry = 0;
  let welcomed = false;
  const connect = (): void => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}/ws/control`);
    socket.addEventListener('open', () => {
      retry = 0;
      socket!.send(JSON.stringify({
        type: 'subscribe',
        channel: routing,
        role,
        page: join.page,
        ...(join.signal ? { signal: join.signal } : {}),
      }));
    });
    socket.addEventListener('message', (event) => {
      let message: { type: string; command?: Parameters<typeof apply>[0]; state?: { data?: Record<string, unknown> } };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === 'command' && message.command) apply(message.command);
      // On (re)connect, the retained list: a reloaded output rebuilds the stack,
      // and each graphic then late-joins on its own channel.
      /*
       * Only the first welcome may take graphics down. A reconnect after the
       * server restarted is welcomed with an empty list — the hub forgot — and
       * obeying it would clear the output mid-show. Later welcomes only add.
       */
      if (message.type === 'welcome') {
        const list = message.state?.data?.[MOUNTS_UPDATE_KEY];
        apply({ verb: 'update', data: { [MOUNTS_UPDATE_KEY]: Array.isArray(list) ? list : [] } }, welcomed);
        welcomed = true;
      }
    });
    socket.addEventListener('close', () => {
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, Math.min(500 * 2 ** retry, 10_000));
    });
    socket.addEventListener('error', () => socket?.close());
  };
  connect();

  (globalThis as unknown as Record<string, unknown>)['breezeOutput'] = {
    output: boot.output,
    get: (composition: string) => mounts.get(composition)?.runtime,
    mounted: () => [...mounts.keys()],
  };

  if (boot.debug || params.get('debug') === '1') makeDebugOverlay(debugList);
}

void main();
