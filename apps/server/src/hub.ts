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

export type ClientRole = 'renderer' | 'controller';

export type ControlVerb = 'play' | 'stop' | 'next' | 'clear' | 'seek' | 'update';

export interface ControlCommand {
  verb: ControlVerb;
  /** For `update`: dynamic field values. */
  data?: Record<string, unknown>;
  /** For `seek`: composition time in seconds. */
  time?: number;
  /** Who issued it, for the activity log. */
  source?: string;
}

export interface PlaybackReport {
  state: string;
  time: number;
  step: number;
  stepCount: number;
}

export interface ChannelState {
  /** Last dynamic-field values pushed to this channel. */
  data: Record<string, unknown>;
  playback: PlaybackReport | null;
  renderers: number;
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
 */
export type ControllerKind = 'panel' | 'editor' | 'monitor';

export type ClientMessage =
  | { type: 'subscribe'; channel: string; role: ClientRole; client?: ControllerKind }
  | { type: 'command'; command: ControlCommand }
  | { type: 'state'; playback: PlaybackReport };

export type ServerMessage =
  | { type: 'welcome'; channel: string; role: ClientRole; state: ChannelState }
  | { type: 'command'; command: ControlCommand }
  | { type: 'state'; channel: string; state: ChannelState }
  | { type: 'error'; message: string };

export interface HubClient {
  id: string;
  role: ClientRole;
  channel: string | null;
  send: (message: ServerMessage) => void;
}

export function channelKey(projectId: string, compositionId: string): string {
  return `${projectId}/${compositionId}`;
}

interface Channel {
  data: Record<string, unknown>;
  playback: PlaybackReport | null;
  updatedAt: string;
}

export class ControlHub {
  private clients = new Map<string, HubClient>();
  private channels = new Map<string, Channel>();

  addClient(id: string, send: (message: ServerMessage) => void): HubClient {
    const client: HubClient = { id, role: 'controller', channel: null, send };
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
        const state = this.state(message.channel);
        client.send({ type: 'welcome', channel: message.channel, role: message.role, state });
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
        if (!client.channel) return;
        const channel = this.channel(client.channel);
        channel.playback = message.playback;
        channel.updatedAt = new Date().toISOString();
        this.broadcastState(client.channel, { excludeRenderers: true });
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
    }
    channel.updatedAt = new Date().toISOString();

    let delivered = 0;
    for (const client of this.clients.values()) {
      if (client.channel !== channelName || client.role !== 'renderer') continue;
      client.send({ type: 'command', command });
      delivered += 1;
    }

    this.broadcastState(channelName);
    return delivered;
  }

  state(channelName: string): ChannelState {
    const channel = this.channel(channelName);
    let renderers = 0;
    let controllers = 0;
    for (const client of this.clients.values()) {
      if (client.channel !== channelName) continue;
      if (client.role === 'renderer') renderers += 1;
      else controllers += 1;
    }
    return {
      data: { ...channel.data },
      playback: channel.playback,
      renderers,
      controllers,
      updatedAt: channel.updatedAt,
    };
  }

  /** Channels that have ever been used, for a status page. */
  get activeChannels(): string[] {
    return [...this.channels.keys()];
  }

  private channel(name: string): Channel {
    let channel = this.channels.get(name);
    if (!channel) {
      channel = { data: {}, playback: null, updatedAt: new Date().toISOString() };
      this.channels.set(name, channel);
    }
    return channel;
  }

  private broadcastState(channelName: string, opts: { excludeRenderers?: boolean } = {}): void {
    const state = this.state(channelName);
    for (const client of this.clients.values()) {
      if (client.channel !== channelName) continue;
      if (opts.excludeRenderers && client.role === 'renderer') continue;
      client.send({ type: 'state', channel: channelName, state });
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
