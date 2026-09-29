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

import { DATA_UPDATE_KEY } from '@breeze/schema';

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
  | 'update';

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
  ]);
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
 */
export type ControllerKind = 'panel' | 'editor' | 'monitor' | 'companion';

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

export class ControlHub {
  private clients = new Map<string, HubClient>();
  private channels = new Map<string, Channel>();

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
    const channel = this.channel(channelName);

    if (command.verb === 'update' && command.data) {
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
          connectedAt: client.connectedAt,
          playback: client.playback ?? null,
          reportedAt: client.reportedAt ?? null,
        });
      }
      // A monitor is part of a panel already counted, not a panel of its own.
      // Counting it made the portal's "Panels open" disagree with /peers.
      // Companion is a machine with a socket per watched channel — see
      // `ControllerKind` — and would inflate the count the same way.
      else if (client.kind !== 'monitor' && client.kind !== 'companion') controllers += 1;
    }
    sources.sort((a, b) => a.connectedAt - b.connectedAt);

    /*
     * The channel's playback is an output that is on air, when one is.
     *
     * "Whichever reported last" let one idle output hide another on air: a
     * browser source opened with `?sync=off`, or added to OBS mid-show, says
     * idle, and every panel then read IDLE while vMix held the graphic. The
     * question a panel is asking is "is this on air?", so an output showing it
     * wins over one that is not; among equals, the latest report. With no
     * output reporting at all, the retained report stands — a preview's, see
     * `handle`, or the last word from outputs that have since gone.
     */
    const onAir = (p: PlaybackReport | null) => p?.state === 'holding' || p?.state === 'playing-in' || p?.state === 'playing-out';
    let chosen: SourceReport | null = null;
    for (const s of sources) {
      if (!s.playback || s.reportedAt === null) continue;
      if (
        !chosen ||
        (onAir(s.playback) && !onAir(chosen.playback)) ||
        (onAir(s.playback) === onAir(chosen.playback) && s.reportedAt > chosen.reportedAt!)
      ) chosen = s;
    }

    return {
      data: { ...channel.data },
      playback: chosen ? chosen.playback : channel.playback,
      reportedAt: chosen ? chosen.reportedAt : channel.reportedAt,
      now: Date.now(),
      sources,
      renderers,
      controllers,
      updatedAt: channel.updatedAt,
    };
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
