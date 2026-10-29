// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Control hub — routes commands from operators to graphics on air.
 *
 * Deliberately transport-agnostic: it knows about clients that can be sent
 * messages, not about WebSockets. That keeps the routing, the channel
 * bookkeeping and — most importantly — the resync-on-reconnect logic testable
 * in Node without opening a socket.
 *
 * Two kinds of client share a channel:
 *   - renderers   — output pages in vMix / OBS. They receive commands and
 *                   report back what they are doing.
 *   - controllers — operator panels and the editor. They send commands and
 *                   receive state.
 *
 * The hub retains each channel's last known dynamic data and playback state.
 * That is the whole point: a browser source that drops mid-show reconnects and
 * asks "what should I be showing?", and gets an answer. Without it the graphic
 * comes back blank and the operator has to re-enter the name live.
 */

import {
  DATA_UPDATE_KEY,
  DEFAULT_SCROLL_ID,
  SCROLLS_UPDATE_KEY,
  SCROLL_ACTIONS,
  SCROLL_ID_PATTERN,
  TIMERS_UPDATE_KEY,
  TIMER_ACTIONS,
  TIMER_ID_PATTERN,
  DEFAULT_TIMER_ID,
  applyScrollAction,
  applyTimerAction,
  channelKind,
  implicitScroll,
  type ScrollAction,
  type ScrollInfo,
  type ScrollReport,
  type ScrollState,
  type ScrollsPayload,
  type TimerAction,
  type TimerState,
  type TimersPayload,
} from '@breeze/schema';

/** Local alias — this file is otherwise dependency-free by design. */
const DATA_KEY = DATA_UPDATE_KEY;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `preview` is a renderer that does not count as one.
 *
 * The operator panel can embed the output page so the person driving a graphic
 * can see it, and that embed has to receive commands or it would not follow the
 * PLAY they just pressed. It must equally never be *counted*: the panel turns
 * its status light green on `renderers > 0` and says "outputs connected", and a
 * preview counted there would tell an operator their graphic was reaching air
 * when it was reaching nothing but their own browser. A green light that can be
 * wrong is worse than no light.
 */
export type ClientRole = 'renderer' | 'controller' | 'preview';

export type ControlVerb =
  | 'play'
  | 'stop'
  | 'next'
  | 'prev'
  | 'page'
  | 'cycle'
  | 'clear'
  | 'seek'
  | 'update'
  /**
   * Cue → take (Phase 9 Wave A): `data` and PLAY as one command, so an output
   * never shows new values on an old pose — on air, the runtime runs the
   * outro first. On a graphic channel `data` is retained like `update`'s.
   */
  | 'take'
  /*
   * Rundown verbs (Phase 9 Wave A). Only meaningful on a project's rundown
   * channel (`${project}/#rundowns`), where `routes/rundowns.ts` intercepts
   * them; nothing renders there, so nothing is dispatched.
   */
  | 'cue'
  | 'rundownNext'
  | 'rundownPrev'
  | 'out'
  /**
   * Operator timers (Phase 9 Wave B): `timer: { action, id?, value? }`. The
   * hub applies it to the timer's state and sends every renderer the result
   * as an `update` carrying `$timers` — renderers never see this verb.
   */
  | 'timer'
  /**
   * The roll transport (Wave R, ROLLS.md §5): `scroll: { action, id?, value?,
   * percent? }`. Handled exactly as `timer` is — the result reaches renderers
   * as an `update` carrying `$scrolls`.
   */
  | 'scroll'
  /**
   * Go to one hold (Phase 9 Wave D): `step` is 1-based, counted the way a
   * playback report's `step` is, and `cut` skips the animation. What OGraf's
   * `playAction({ goto })` becomes — NEXT would turn a table's page first.
   */
  | 'step';

export interface ControlCommand {
  verb: ControlVerb;
  /** For `update`: dynamic field values. */
  data?: Record<string, unknown>;
  /** For `seek`: composition time in seconds. */
  time?: number;
  /**
   * For `next`, `prev`, `page` and `cycle`: the table to aim at — its binding,
   * `<mount>.<binding>`, or its layer id. Absent means every table, which is
   * what `next` always did.
   */
  table?: string;
  /** For `page`: a 1-based page number. */
  page?: number;
  /** For `page`: a page key, the alternative to `page`. */
  key?: string;
  /** For `cycle`. */
  cycle?: 'hold' | 'resume';
  /**
   * On an output's routing channel (`${project}/@<output>`): the composition
   * the command is for. `take` mounts it if it is not mounted yet; `stop`,
   * `next`, `prev` and `clear` without one act on every mount.
   */
  mount?: string;
  /** Rundown verbs: the rundown, the item (`cue`, `take`), the target (`out`). */
  rundown?: string;
  item?: string;
  target?: string;
  /** `take` on a rundown: arm the next item afterwards. Absent is true. */
  advance?: boolean;
  /**
   * For `timer`. `value` is milliseconds: the new displayed value for `set`,
   * a signed change for `add`. `id` defaults to `main`.
   */
  timer?: { action: TimerAction; id?: string; value?: number };
  /**
   * For `scroll`. `value` is the multiple for `speed`, signed seconds of
   * travel for `jog`, seconds (or a percentage with `percent`) for `seek`.
   * `id` defaults to `main`.
   */
  scroll?: { action: ScrollAction; id?: string; value?: number; percent?: boolean };
  /** For `step`: the hold to go to, 1-based (Phase 9 Wave D). */
  step?: number;
  /**
   * For `step` and `stop`: without the animation (OGraf's `skipAnimation`). A
   * cut `stop` takes the graphic straight off, as `clear` does, but on an
   * output it leaves the composition mounted — `clear` there unmounts it.
   */
  cut?: boolean;
  /** Who issued it, for the activity log. */
  source?: string;
}

/**
 * One table's paging as the output page reported it (CYCLE.md).
 *
 * Carried through the hub untouched — the hub has no idea what a table is, and
 * does not need one to relay what a renderer said to the panels watching it.
 */
export interface TableReport {
  table: string;
  page: number;
  pageCount: number;
  key: string | null;
  /** The table has a cycle configured at all — whether to offer hold/resume. */
  hasCycle: boolean;
  cycling: boolean;
  held: boolean;
  secondsLeft: number | null;
  group?: string;
  /** The address of the table this one follows (Wave 4). Absent before 0.74's follow. */
  follows?: string;
}

export interface PlaybackReport {
  state: string;
  time: number;
  step: number;
  stepCount: number;
  /** Paged tables. Absent from renderers older than 0.74. */
  tables?: TableReport[];
  /**
   * Rotating tickers: the copy on screen and how far into its pass (0.75.0),
   * so a page joining late scrolls in step. Absent from older renderers.
   */
  crawls?: CrawlReport[];
  /**
   * Rolls (Wave R): each scroll's extent, end and start — what the hub clamps
   * the transport with — and where it is, for a panel's position bar.
   */
  scrolls?: ScrollReport[];
}

export interface CrawlReport {
  layer: string;
  text: string;
  staged: string | null;
  offsetMs: number;
  passMs: number;
}

/**
 * What a report says apart from the passage of time — state, step, pages and
 * the copy on each ticker, but not a page's seconds left or a ticker's offset,
 * which change on every heartbeat by construction. Two reports with the same
 * shape tell a panel nothing new.
 */
function reportShape(p: PlaybackReport | undefined): string {
  if (!p) return '';
  return JSON.stringify([
    p.state,
    p.step,
    p.stepCount,
    (p.tables ?? []).map((t) => [t.table, t.page, t.pageCount, t.key, t.held, t.cycling, t.hasCycle]),
    (p.crawls ?? []).map((c) => [c.layer, c.text, c.staged]),
    // Not `travel`: it moves on every heartbeat by construction.
    (p.scrolls ?? []).map((r) => [r.id, r.running, r.rate, r.extent === undefined ? null : Math.round(r.extent * 10)]),
  ]);
}

/** How far along an output's graphic is — the first thing a panel wants to know about it. */
const STATE_RANK: Record<string, number> = { holding: 3, 'playing-in': 2, 'playing-out': 1 };

/** A report older than this — three heartbeats — is from an output that has gone quiet. */
const STALE_REPORT_MS = 15_000;

/**
 * Whether output `a` should speak for the channel over output `b`.
 * Both have reported. See `state()` for why this order.
 */
function outranks(a: SourceReport, b: SourceReport, now: number): boolean {
  const rank = (s: SourceReport): number => STATE_RANK[s.playback?.state ?? ''] ?? 0;
  if (rank(a) !== rank(b)) return rank(a) > rank(b);
  const quiet = (s: SourceReport): boolean => now - s.reportedAt! > STALE_REPORT_MS;
  if (quiet(a) !== quiet(b)) return quiet(b);
  return a.connectedAt < b.connectedAt;
}

/**
 * One connected output and what it last said it was showing (0.74.1).
 *
 * What a page joining late picks from, and what the control panel's preview
 * offers under **Sync to**. Outputs only — a preview is somebody's own window,
 * and one preview following another would be following nothing on air.
 */
export interface SourceReport {
  /** The socket's hub id. */
  id: string;
  /**
   * The output page the socket belongs to. One page opens a socket per graphic
   * on it — a scene is several — and they all carry the same page id, which is
   * how a preview following one output follows it on every channel at once.
   * Absent from renderers older than 0.74.1.
   */
  page?: string;
  /** "OBS on Windows", from the User-Agent — for a person choosing between outputs. */
  label: string;
  ip: string;
  /**
   * `matte` for a page opened with `?matte=1` (Phase 9 Wave C): it renders the
   * key signal for a fill page beside it, and the panel's sync check pairs the
   * two. Absent for a fill — every page before Wave C, and any `?bg=` page.
   */
  signal?: OutputSignal;
  connectedAt: number;
  playback: PlaybackReport | null;
  /** Hub clock, epoch ms, when `playback` arrived; null before the first report. */
  reportedAt: number | null;
}

export interface ChannelState {
  /** Last dynamic-field values pushed to this channel. */
  data: Record<string, unknown>;
  /**
   * What the channel's outputs are showing — an output on air when there is
   * one (the latest such report), else the latest output's report, else what
   * a preview reported while no output was connected. See `state`.
   *
   * A preview never overwrites an output's report. It used to: a panel's
   * preview switched on mid-show reported `idle`, and every panel watching
   * then read IDLE while vMix was holding on air.
   */
  playback: PlaybackReport | null;
  /** Hub clock, epoch ms, when `playback` was reported. Null when never. */
  reportedAt: number | null;
  /**
   * The hub's clock when this state was put together, epoch ms. A reader
   * works out a report's age as `now - reportedAt` — both from this clock, so
   * the viewer's own clock being wrong does not matter.
   */
  now: number;
  /** Connected outputs, oldest first (0.74.1). */
  sources: SourceReport[];
  renderers: number;
  /**
   * Panels and editors — the things a person has open. Not previews (see
   * `ClientRole`) and not a scene panel's per-element `monitor` sockets, which
   * would make one open panel read as five.
   */
  controllers: number;
  updatedAt: string;
}

/**
 * What kind of controller this is.
 *
 * The hub treats them all alike — any controller may send commands — but the
 * activity log must not. An operator opening a control panel minutes before air
 * is worth a line; a designer opening the editor is noise in the same column;
 * and `monitor` is the readout-only socket a scene panel opens *per element*,
 * so logging those would write four lines for one panel and make the count of
 * "panels" wrong besides.
 *
 * Optional, and absent means `panel` — that was the only controller in
 * existence when this protocol was written, and an older client should keep
 * being recorded as what it is.
 *
 * `companion` is the Bitfocus Companion module. It is a machine, not a person
 * with a page open, and it holds one socket per channel its buttons watch, so
 * like a `monitor` it is shown on the peers page and left out of the panel
 * count and the activity log.
 *
 * `ograf` is a pointer package's page inside an OGraf renderer (Phase 9 Wave
 * D). It is a graphic, not a person: it subscribes for the project's data and
 * mode and is driven by its own controller, never by this channel's commands —
 * which is why it is a controller here and not a renderer. Not a panel either.
 */
export type ControllerKind = 'panel' | 'editor' | 'monitor' | 'companion' | 'ograf';

/**
 * What an output page renders, when it is not the ordinary fill (Phase 9
 * Wave C). One value today; a type rather than a boolean so a subscribe frame
 * reads as what it is.
 */
export type OutputSignal = 'matte';

export type ClientMessage =
  | {
      type: 'subscribe';
      channel: string;
      role: ClientRole;
      client?: ControllerKind;
      /**
       * `false` asks for state without the channel's retained field data.
       *
       * That data carries every data source's whole DataSet, and a control
       * surface that only colours buttons from playback would otherwise be sent
       * a weather channel's feeds on every poll, once per watched channel.
       * Absent means true — every existing client wants the data.
       */
      data?: boolean;
      /** Output pages: an id shared by every socket the one page opens. See `SourceReport.page`. */
      page?: string;
      /** Output pages: `matte` when the page renders a key signal. See `SourceReport.signal`. */
      signal?: OutputSignal;
    }
  | { type: 'command'; command: ControlCommand }
  | { type: 'state'; playback: PlaybackReport };

export type ServerMessage =
  | { type: 'welcome'; channel: string; role: ClientRole; state: ChannelState }
  | { type: 'command'; command: ControlCommand }
  | { type: 'state'; channel: string; state: ChannelState }
  | { type: 'error'; message: string; code?: string };

export interface HubClient {
  id: string;
  role: ClientRole;
  channel: string | null;
  send: (message: ServerMessage) => void;
  /** From the subscribe message. Absent until then, and for non-controllers. */
  kind?: ControllerKind;
  /** Subscribed with `data: false` — state is sent to it without field data. */
  omitData?: boolean;
  /** Where the socket came from — supplied by the transport, never inferred here. */
  origin?: PeerOrigin;
  /** Epoch ms. */
  connectedAt: number;
  /** Output pages: the page this socket belongs to, from its subscribe. */
  page?: string;
  /** Output pages: `matte` for a key-signal page, from its subscribe. */
  signal?: OutputSignal;
  /** Outputs and previews: what it last reported, and when (hub clock). */
  playback?: PlaybackReport;
  reportedAt?: number;
}

/**
 * The transport's view of who is on the other end.
 *
 * Handed in rather than read, because the hub knows nothing of requests — the
 * same reason auditing lives in `routes/control.ts`. Same shape as the audit
 * log's actor, so both lists name a machine the same way.
 */
export interface PeerOrigin {
  ip: string;
  agent: string;
  /**
   * A short readable name for the agent — "OBS on Windows". Worked out by the
   * transport (`describeAgent`), since the hub stays free of i18n. Absent
   * falls back to the raw agent.
   */
  label?: string;
}

/**
 * One connected socket, for the peers page and the console dashboard.
 *
 * `kind` is collapsed to the thing an operator would call it: a renderer is a
 * browser source, a preview is the panel's own embed, and a controller is
 * whichever of panel / editor / monitor it said it was.
 */
export interface PeerSnapshot {
  id: string;
  kind: 'source' | 'preview' | ControllerKind;
  channel: string;
  ip: string;
  agent: string;
  connectedAt: number;
}

export function channelKey(projectId: string, compositionId: string): string {
  return `${projectId}/${compositionId}`;
}

interface Channel {
  data: Record<string, unknown>;
  playback: PlaybackReport | null;
  reportedAt: number | null;
  updatedAt: string;
}

/** Longest page id kept. It is an opaque tag from the page, not something to store at any size. */
const MAX_PAGE_ID = 64;

/** See `ControlHub.intercept`. */
export type CommandInterceptor = (channel: string, command: ControlCommand, client: HubClient) => boolean;

export class ControlHub {
  private clients = new Map<string, HubClient>();
  private channels = new Map<string, Channel>();
  private interceptors: CommandInterceptor[] = [];
  /** Operator timers by home channel (`timerHome`). In memory, like everything here until Wave F. */
  private timers = new Map<string, Record<string, TimerState>>();
  /**
   * Scroll transports by home channel (Wave R) — homed like timers, so every
   * roll mounted on an output shares the output's. `playAt` is the last
   * fresh PLAY or TAKE: a roll nobody has touched since runs from it.
   */
  private scrolls = new Map<string, { scrolls: Record<string, ScrollState>; playAt?: number }>();

  addClient(
    id: string,
    send: (message: ServerMessage) => void,
    origin?: PeerOrigin,
  ): HubClient {
    const client: HubClient = {
      id,
      role: 'controller',
      channel: null,
      send,
      connectedAt: Date.now(),
      ...(origin ? { origin } : {}),
    };
    this.clients.set(id, client);
    return client;
  }

  removeClient(id: string): void {
    const client = this.clients.get(id);
    this.clients.delete(id);
    // Controllers watch renderer counts to show whether anything is on air.
    if (client?.channel) this.broadcastState(client.channel);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Handle one inbound message. Unknown shapes are reported, never thrown. */
  handle(clientId: string, message: ClientMessage): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    switch (message.type) {
      case 'subscribe': {
        client.channel = message.channel;
        client.role = message.role;
        // Absent means `panel`, as it does for the activity log — see
        // `ControllerKind`. Meaningless on a renderer, so not kept there.
        if (message.role === 'controller') client.kind = message.client ?? 'panel';
        else delete client.kind;
        /*
         * Only a controller may opt out of the data. A renderer that did would
         * reconnect mid-show to a blank graphic — the resync the retained data
         * exists for — so the flag is ignored rather than honoured there.
         */
        if (message.role === 'controller' && message.data === false) client.omitData = true;
        else delete client.omitData;
        if (message.role !== 'controller' && typeof message.page === 'string' && message.page !== '') {
          client.page = message.page.slice(0, MAX_PAGE_ID);
        } else {
          delete client.page;
        }
        // Only the one known value is kept: anything else is a fill, as every
        // page that predates the field is.
        if (message.role !== 'controller' && message.signal === 'matte') client.signal = 'matte';
        else delete client.signal;
        // A socket re-subscribing to another channel starts with no report there.
        delete client.playback;
        delete client.reportedAt;
        const state = this.state(message.channel);
        client.send({
          type: 'welcome',
          channel: message.channel,
          role: message.role,
          state: client.omitData ? { ...state, data: {} } : state,
        });
        this.broadcastState(message.channel);
        return;
      }

      case 'command': {
        if (!client.channel) {
          client.send({ type: 'error', message: 'subscribe before sending commands' });
          return;
        }
        // Commands this hub does not route itself — a rundown's cue and take
        // need the project on disk, which the hub knows nothing about.
        for (const intercept of this.interceptors) {
          if (intercept(client.channel, message.command, client)) return;
        }
        this.dispatch(client.channel, message.command);
        return;
      }

      case 'state': {
        // Only an output reports what it is showing. A controller claiming a
        // playback state would put a false one on every panel watching.
        if (!client.channel || (client.role !== 'renderer' && client.role !== 'preview')) return;
        const at = Date.now();
        const changed = reportShape(client.playback) !== reportShape(message.playback);
        client.playback = message.playback;
        client.reportedAt = at;
        /*
         * An output's report is the channel's. A preview's is only while no
         * output is connected — a panel used on its own, with the preview as
         * its only window, still wants its readout — and never over an output.
         */
        const channel = this.channel(client.channel);
        if (client.role === 'renderer' || !this.hasRenderer(client.channel)) {
          channel.playback = message.playback;
          channel.reportedAt = at;
        }
        channel.updatedAt = new Date(at).toISOString();
        /*
         * A heartbeat (0.75.0) that only aged — same state, pages and copy —
         * is kept and not relayed: every panel on the channel would otherwise
         * be sent the channel's whole state, data sources included, every few
         * seconds per output. Anything that reads the ageing parts (a joining
         * page's welcome, `/state`) reads them fresh from here.
         */
        if (changed) this.broadcastState(client.channel, { excludeRenderers: true });
        return;
      }

      default:
        client.send({ type: 'error', message: 'unrecognised message' });
    }
  }

  /**
   * Send a command to every renderer on a channel, and remember anything that
   * changes what should be on screen.
   */
  dispatch(channelName: string, command: ControlCommand): number {
    if (command.verb === 'timer') return this.dispatchTimer(channelName, command);
    if (command.verb === 'scroll') return this.dispatchScroll(channelName, command);
    /*
     * A fresh run starts its rolls from the top (Wave R). Before the command
     * goes out, so a page already holds the reset when its intro begins. A
     * PLAY that steps a graphic on from a hold is not a fresh run — credits
     * rolling under the hold must not jump back to the start as the outro
     * plays — so it is judged by what the channel's outputs report.
     */
    if (command.verb === 'take' || ((command.verb === 'play' || command.verb === 'step') && this.freshRun(channelName))) {
      this.resetScrolls(channelName, Date.now(), true);
    } else if (command.verb === 'clear') {
      this.resetScrolls(channelName, Date.now(), false);
    }
    const channel = this.channel(channelName);

    // A `take` on a graphic carries values exactly as `update` does. On an
    // output's routing channel (`mount` set) they belong to the mount's own
    // channel, which the caller retains there — see `retain`.
    if ((command.verb === 'update' || (command.verb === 'take' && command.mount === undefined)) && command.data) {
      // Merge rather than replace: an operator updating one field must not
      // blank the others.
      channel.data = { ...channel.data, ...command.data };

      /*
       * `$data` merges one level deeper.
       *
       * Data-source pushes are per source, and a shallow merge would let a tick
       * from the standings feed replace the whole `$data` object and drop the
       * ticker's rows with it. This retained map is also what a reconnecting
       * browser source resyncs from — the reason we push whole DataSets rather
       * than the revision-only tick originally sketched, since a page that
       * comes back holding a revision number and no rows is a blank graphic.
       */
      if (isRecord(command.data[DATA_KEY])) {
        channel.data[DATA_KEY] = {
          ...(isRecord(channel.data[DATA_KEY]) ? channel.data[DATA_KEY] : {}),
          ...command.data[DATA_KEY],
        };
      }
    }
    if (command.verb === 'clear') {
      channel.playback = null;
      channel.reportedAt = null;
      // Every output is about to report idle; until it does, its last report
      // is about a graphic that is no longer there.
      for (const client of this.clients.values()) {
        if (client.channel !== channelName) continue;
        delete client.playback;
        delete client.reportedAt;
      }
    }
    channel.updatedAt = new Date().toISOString();

    let delivered = 0;
    for (const client of this.clients.values()) {
      if (client.channel !== channelName) continue;
      if (client.role !== 'renderer' && client.role !== 'preview') continue;
      client.send({ type: 'command', command });
      // A preview is sent the command and left out of the count, which is what
      // `delivered` means to the caller: how many outputs took this to air.
      if (client.role === 'renderer') delivered += 1;
    }

    this.broadcastState(channelName);
    return delivered;
  }

  /**
   * Merge values into a channel's retained data without sending anyone a
   * command — what a page joining later is welcomed with — and tell the
   * channel's panels.
   *
   * For a composition mounted on an output (Phase 9 Wave A): the TAKE reaches
   * it through the output's routing channel, so its own channel would
   * otherwise never learn the values it is showing, and a reloaded output
   * would bring the graphic back with the authored placeholder.
   */
  retain(channelName: string, data: Record<string, unknown>): void {
    const channel = this.channel(channelName);
    const merged: Record<string, unknown> = { ...channel.data, ...data };
    if (isRecord(data[DATA_KEY])) {
      merged[DATA_KEY] = { ...(isRecord(channel.data[DATA_KEY]) ? channel.data[DATA_KEY] : {}), ...data[DATA_KEY] };
    }
    channel.data = merged;
    channel.updatedAt = new Date().toISOString();
    this.broadcastState(channelName, { excludeRenderers: true });
  }

  /**
   * Where a channel's timers live (Phase 9 Wave B). A graphic's own channel
   * keeps its own; every composition mounted on an output shares the output's
   * — the scorebug and the full-screen recap taken onto `@main` show one game
   * clock. Timers are per channel, as decided 2026-10-25; an output is one
   * channel to the operator, however many compositions it carries.
   */
  timerHome(channelName: string): string {
    if (channelKind(channelName) !== 'mount') return channelName;
    return channelName.slice(0, channelName.indexOf('~'));
  }

  /** A home's timers as a payload stamped with the hub clock now, or undefined when it has none. */
  timersPayload(channelName: string): TimersPayload | undefined {
    const timers = this.timers.get(this.timerHome(channelName));
    if (!timers || Object.keys(timers).length === 0) return undefined;
    return { clock: Date.now(), timers: { ...timers } };
  }

  /** One timer's state, for REST and the panel. */
  timerState(channelName: string, id: string): TimerState | undefined {
    return this.timers.get(this.timerHome(channelName))?.[id];
  }

  /**
   * Apply a timer action and tell every renderer that shows the home's timers.
   * An unknown action or a bad id is ignored — the panel and the REST route
   * check both and say why; a raw socket frame gets nothing.
   */
  private dispatchTimer(channelName: string, command: ControlCommand): number {
    const spec = command.timer;
    if (!spec || !(TIMER_ACTIONS as readonly string[]).includes(spec.action)) return 0;
    const id = spec.id ?? DEFAULT_TIMER_ID;
    if (!TIMER_ID_PATTERN.test(id)) return 0;
    const value = typeof spec.value === 'number' && Number.isFinite(spec.value) ? spec.value : undefined;
    const home = this.timerHome(channelName);
    const now = Date.now();
    const timers = { ...(this.timers.get(home) ?? {}) };
    timers[id] = applyTimerAction(timers[id], spec.action, now, value);
    this.timers.set(home, timers);

    const payload: TimersPayload = { clock: now, timers };
    const update: ControlCommand = { verb: 'update', data: { [TIMERS_UPDATE_KEY]: payload }, source: command.source ?? 'timer' };
    const reached = new Set<string>();
    let delivered = 0;
    for (const client of this.clients.values()) {
      if (!client.channel || this.timerHome(client.channel) !== home) continue;
      reached.add(client.channel);
      if (client.role !== 'renderer' && client.role !== 'preview') continue;
      client.send({ type: 'command', command: update });
      if (client.role === 'renderer') delivered += 1;
    }
    reached.add(channelName);
    for (const name of reached) this.broadcastState(name, { excludeRenderers: true });
    return delivered;
  }

  /**
   * Handle some commands before they are dispatched. An interceptor returning
   * true has dealt with the command; the hub then does nothing more with it.
   * Kept as a hook so the hub stays free of disk and project knowledge.
   */
  intercept(fn: CommandInterceptor): () => void {
    this.interceptors.push(fn);
    return () => {
      this.interceptors = this.interceptors.filter((f) => f !== fn);
    };
  }

  state(channelName: string): ChannelState {
    const channel = this.channel(channelName);
    let renderers = 0;
    let controllers = 0;
    const sources: SourceReport[] = [];
    for (const client of this.clients.values()) {
      if (client.channel !== channelName) continue;
      // A preview is deliberately in neither total — see `ClientRole`.
      if (client.role === 'preview') continue;
      if (client.role === 'renderer') {
        renderers += 1;
        sources.push({
          id: client.id,
          ...(client.page ? { page: client.page } : {}),
          label: client.origin?.label ?? client.origin?.agent ?? 'unknown',
          ip: client.origin?.ip ?? 'unknown',
          ...(client.signal ? { signal: client.signal } : {}),
          connectedAt: client.connectedAt,
          playback: client.playback ?? null,
          reportedAt: client.reportedAt ?? null,
        });
      }
      // A monitor is part of a panel already counted, not a panel of its own.
      // Counting it made the portal's "Panels open" disagree with /peers.
      // Companion is a machine with a socket per watched channel — see
      // `ControllerKind` — and would inflate the count the same way.
      else if (client.kind !== 'monitor' && client.kind !== 'companion' && client.kind !== 'ograf') controllers += 1;
    }
    sources.sort((a, b) => a.connectedAt - b.connectedAt);

    /*
     * The channel's playback is the report of the output most worth believing.
     *
     * "Whichever reported last" let one idle output hide another on air: a
     * browser source opened with `?sync=off`, or added to OBS mid-show, says
     * idle, and every panel then read IDLE while vMix held the graphic. So an
     * output on air wins over one that is not.
     *
     * On air is not one thing, though. An output that has reached its hold is
     * showing the graphic; one still `playing-in` may be mid-intro — or a
     * hidden tab whose animation clock has stopped, stuck there for good, and
     * reporting page one with no time left. Every command makes every output
     * report, so "latest" handed the panel that stalled page after each Hold,
     * until a healthy output next reported on a page turn. Ranked by how far
     * along: holding, then playing-in, then playing-out, then the rest.
     *
     * Within a rank, an output that is reporting on time beats one gone quiet
     * (heartbeats are every few seconds; a hidden tab's timers are throttled
     * to one a minute), and among the reliable, the oldest connection wins
     * rather than the latest report — a fixed answer, so two outputs a frame
     * apart do not swap places on the panel at every report. With no output
     * reporting at all, the retained report stands — a preview's, see `handle`,
     * or the last word from outputs that have since gone.
     */
    const now = Date.now();
    let chosen: SourceReport | null = null;
    for (const s of sources) {
      if (!s.playback || s.reportedAt === null) continue;
      if (!chosen || outranks(s, chosen, now)) chosen = s;
    }

    return {
      data: this.withTimers(channelName, channel.data),
      playback: chosen ? chosen.playback : channel.playback,
      reportedAt: chosen ? chosen.reportedAt : channel.reportedAt,
      now,
      sources,
      renderers,
      controllers,
      updatedAt: channel.updatedAt,
    };
  }

  /**
   * Retained data with the home's timers and scrolls stamped with the hub
   * clock now — a stale `clock` would be read as clock skew.
   */
  private withTimers(channelName: string, data: Record<string, unknown>): Record<string, unknown> {
    const payload = this.timersPayload(channelName);
    const scrolls = this.scrollsPayload(channelName);
    return {
      ...data,
      ...(payload ? { [TIMERS_UPDATE_KEY]: payload } : {}),
      ...(scrolls ? { [SCROLLS_UPDATE_KEY]: scrolls } : {}),
    };
  }

  /* ------------------------------------------------------------ scrolls */

  /** A home's scrolls as a payload stamped with the hub clock now, or undefined when it has none. */
  scrollsPayload(channelName: string): ScrollsPayload | undefined {
    const entry = this.scrolls.get(this.timerHome(channelName));
    if (!entry) return undefined;
    return { clock: Date.now(), scrolls: { ...entry.scrolls }, ...(entry.playAt !== undefined ? { playAt: entry.playAt } : {}) };
  }

  /**
   * What the home's outputs last said about one scroll — its extent, end and
   * start. An output's word over a preview's, the latest over older.
   */
  scrollInfo(channelName: string, id: string): ScrollInfo | undefined {
    const home = this.timerHome(channelName);
    let best: { info: ScrollInfo; rank: number; at: number } | undefined;
    for (const client of this.clients.values()) {
      if (!client.channel || this.timerHome(client.channel) !== home) continue;
      const found = client.playback?.scrolls?.find((r) => r.id === id);
      if (!found) continue;
      const rank = client.role === 'renderer' ? 2 : client.role === 'preview' ? 1 : 0;
      const at = client.reportedAt ?? 0;
      if (!best || rank > best.rank || (rank === best.rank && at > best.at)) {
        best = {
          info: {
            ...(found.extent !== undefined ? { extent: found.extent } : {}),
            ...(found.end ? { end: found.end } : {}),
            ...(found.start ? { start: found.start } : {}),
          },
          rank,
          at,
        };
      }
    }
    return best?.info;
  }

  /** One scroll's state as the hub holds it — explicit, or what PLAY left it in. */
  scrollState(channelName: string, id: string): ScrollState {
    const entry = this.scrolls.get(this.timerHome(channelName));
    return entry?.scrolls[id] ?? implicitScroll(this.scrollInfo(channelName, id)?.start, entry?.playAt);
  }

  /**
   * Every scroll a home has — reported by its outputs or touched by an
   * operator — with its state and what the outputs said about it. For panels
   * that poll rather than subscribe (the rundown panel).
   */
  scrollSummary(channelName: string): Array<{ id: string; state: ScrollState; info?: ScrollInfo }> {
    const home = this.timerHome(channelName);
    const ids = new Set<string>(Object.keys(this.scrolls.get(home)?.scrolls ?? {}));
    for (const client of this.clients.values()) {
      if (!client.channel || this.timerHome(client.channel) !== home) continue;
      for (const r of client.playback?.scrolls ?? []) ids.add(r.id);
    }
    return [...ids].sort().map((id) => {
      const info = this.scrollInfo(channelName, id);
      return { id, state: this.scrollState(channelName, id), ...(info ? { info } : {}) };
    });
  }

  /** Whether a PLAY on this channel starts a new run rather than stepping on from a hold. */
  private freshRun(channelName: string): boolean {
    const state = this.state(channelName).playback?.state;
    return state === undefined || state === 'idle' || state === 'finished' || state === 'playing-out';
  }

  /** Whether anything in the home has ever had a roll, so a reset is worth sending. */
  private hasRolls(home: string): boolean {
    if (this.scrolls.has(home)) return true;
    for (const client of this.clients.values()) {
      if (client.channel && this.timerHome(client.channel) === home && (client.playback?.scrolls?.length ?? 0) > 0) return true;
    }
    return false;
  }

  /**
   * Forget every touched scroll in the home. `play` stamps the PLAY, so a roll
   * that starts on PLAY runs from it; CLEAR leaves nothing playing.
   */
  private resetScrolls(channelName: string, now: number, play: boolean): void {
    const home = this.timerHome(channelName);
    if (!this.hasRolls(home)) return;
    this.scrolls.set(home, play ? { scrolls: {}, playAt: now } : { scrolls: {} });
    this.sendScrolls(home, channelName, undefined);
  }

  /**
   * Apply a scroll action and tell every renderer that shows the home's
   * rolls. An unknown action or a bad id is ignored — the panel and the REST
   * route check both and say why; a raw socket frame gets nothing.
   */
  private dispatchScroll(channelName: string, command: ControlCommand): number {
    const spec = command.scroll;
    if (!spec || !(SCROLL_ACTIONS as readonly string[]).includes(spec.action)) return 0;
    const id = spec.id ?? DEFAULT_SCROLL_ID;
    if (!SCROLL_ID_PATTERN.test(id)) return 0;
    const value = typeof spec.value === 'number' && Number.isFinite(spec.value) ? spec.value : undefined;
    const home = this.timerHome(channelName);
    const now = Date.now();
    const entry = this.scrolls.get(home) ?? { scrolls: {} };
    const info = this.scrollInfo(channelName, id);
    const previous = entry.scrolls[id] ?? implicitScroll(info?.start, entry.playAt);
    const next = applyScrollAction(previous, spec.action, now, { ...(value !== undefined ? { value } : {}), ...(spec.percent ? { percent: true } : {}) }, info);
    this.scrolls.set(home, { ...entry, scrolls: { ...entry.scrolls, [id]: next } });
    return this.sendScrolls(home, channelName, command.source);
  }

  /** Send a home's scrolls to its renderers and previews, and its state to every channel in it. */
  private sendScrolls(home: string, channelName: string, source: string | undefined): number {
    const payload = this.scrollsPayload(home)!;
    const update: ControlCommand = { verb: 'update', data: { [SCROLLS_UPDATE_KEY]: payload }, source: source ?? 'scroll' };
    const reached = new Set<string>();
    let delivered = 0;
    for (const client of this.clients.values()) {
      if (!client.channel || this.timerHome(client.channel) !== home) continue;
      reached.add(client.channel);
      if (client.role !== 'renderer' && client.role !== 'preview') continue;
      client.send({ type: 'command', command: update });
      if (client.role === 'renderer') delivered += 1;
    }
    reached.add(channelName);
    for (const name of reached) this.broadcastState(name, { excludeRenderers: true });
    return delivered;
  }

  private hasRenderer(channelName: string): boolean {
    for (const client of this.clients.values()) {
      if (client.channel === channelName && client.role === 'renderer') return true;
    }
    return false;
  }

  /**
   * Every subscribed socket, oldest first.
   *
   * A socket that has connected but not yet subscribed is left out: it has no
   * channel and no role yet, and it is a few milliseconds from having both.
   */
  peers(): PeerSnapshot[] {
    const out: PeerSnapshot[] = [];
    for (const client of this.clients.values()) {
      if (client.channel === null) continue;
      out.push({
        id: client.id,
        kind:
          client.role === 'renderer' ? 'source'
          : client.role === 'preview' ? 'preview'
          : (client.kind ?? 'panel'),
        channel: client.channel,
        ip: client.origin?.ip ?? 'unknown',
        agent: client.origin?.agent ?? 'unknown',
        connectedAt: client.connectedAt,
      });
    }
    return out.sort((a, b) => a.connectedAt - b.connectedAt);
  }

  /** Channels that have ever been used, for a status page. */
  get activeChannels(): string[] {
    return [...this.channels.keys()];
  }

  private channel(name: string): Channel {
    let channel = this.channels.get(name);
    if (!channel) {
      channel = { data: {}, playback: null, reportedAt: null, updatedAt: new Date().toISOString() };
      this.channels.set(name, channel);
    }
    return channel;
  }

  private broadcastState(channelName: string, opts: { excludeRenderers?: boolean } = {}): void {
    const state = this.state(channelName);
    let lean: ChannelState | null = null;
    for (const client of this.clients.values()) {
      if (client.channel !== channelName) continue;
      if (opts.excludeRenderers && client.role === 'renderer') continue;
      if (client.omitData) {
        lean ??= { ...state, data: {} };
        client.send({ type: 'state', channel: channelName, state: lean });
      } else {
        client.send({ type: 'state', channel: channelName, state });
      }
    }
  }
}

/** Parse an inbound frame. Bad JSON from a flaky device must not kill the socket. */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const message = parsed as ClientMessage;
    if (message.type === 'subscribe' && typeof message.channel === 'string') return message;
    if (message.type === 'command' && message.command) return message;
    if (message.type === 'state' && message.playback) return message;
    return null;
  } catch {
    return null;
  }
}
