// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import { ControlHub, channelKey, parseClientMessage, type ServerMessage } from '../hub.js';

const CHANNEL = channelKey('demo', 'l3rd-name');

/** A client that records what it was sent, standing in for a socket. */
function fakeClient(hub: ControlHub, id: string) {
  const received: ServerMessage[] = [];
  hub.addClient(id, (m) => received.push(m));
  return {
    id,
    received,
    commands: () => received.filter((m) => m.type === 'command'),
    states: () => received.filter((m) => m.type === 'state'),
    last: () => received[received.length - 1],
  };
}

function subscribe(hub: ControlHub, id: string, role: 'renderer' | 'controller') {
  hub.handle(id, { type: 'subscribe', channel: CHANNEL, role });
}

describe('routing', () => {
  it('delivers commands to renderers only', () => {
    const hub = new ControlHub();
    const output = fakeClient(hub, 'out');
    const panel = fakeClient(hub, 'panel');
    subscribe(hub, 'out', 'renderer');
    subscribe(hub, 'panel', 'controller');

    hub.handle('panel', { type: 'command', command: { verb: 'play' } });

    expect(output.commands()).toHaveLength(1);
    // A panel echoing its own commands back would double-fire local handlers.
    expect(panel.commands()).toHaveLength(0);
  });

  it('reports how many renderers a command reached', () => {
    const hub = new ControlHub();
    fakeClient(hub, 'a');
    fakeClient(hub, 'b');
    subscribe(hub, 'a', 'renderer');
    subscribe(hub, 'b', 'renderer');

    expect(hub.dispatch(CHANNEL, { verb: 'play' })).toBe(2);
  });

  it('does not leak commands across channels', () => {
    const hub = new ControlHub();
    const other = fakeClient(hub, 'other');
    fakeClient(hub, 'mine');
    hub.handle('other', { type: 'subscribe', channel: 'demo/ticker', role: 'renderer' });
    subscribe(hub, 'mine', 'renderer');

    hub.dispatch(CHANNEL, { verb: 'play' });

    expect(other.commands()).toHaveLength(0);
  });

  it('refuses commands from a client that has not subscribed', () => {
    const hub = new ControlHub();
    const stray = fakeClient(hub, 'stray');

    hub.handle('stray', { type: 'command', command: { verb: 'play' } });

    expect(stray.last()).toMatchObject({ type: 'error' });
  });

  it('ignores messages from unknown clients rather than throwing', () => {
    const hub = new ControlHub();
    expect(() => hub.handle('ghost', { type: 'command', command: { verb: 'play' } })).not.toThrow();
  });
});

describe('channel state', () => {
  it('retains dynamic data pushed by an operator', () => {
    const hub = new ControlHub();
    hub.dispatch(CHANNEL, { verb: 'update', data: { name: 'Jane Doe' } });
    expect(hub.state(CHANNEL).data).toEqual({ name: 'Jane Doe' });
  });

  it('merges successive updates instead of replacing them', () => {
    // An operator correcting one field must not blank the others.
    const hub = new ControlHub();
    hub.dispatch(CHANNEL, { verb: 'update', data: { name: 'Jane', title: 'Reporter' } });
    hub.dispatch(CHANNEL, { verb: 'update', data: { name: 'Alex' } });

    expect(hub.state(CHANNEL).data).toEqual({ name: 'Alex', title: 'Reporter' });
  });

  it('counts renderers and controllers separately', () => {
    const hub = new ControlHub();
    fakeClient(hub, 'out');
    fakeClient(hub, 'panel');
    subscribe(hub, 'out', 'renderer');
    subscribe(hub, 'panel', 'controller');

    expect(hub.state(CHANNEL)).toMatchObject({ renderers: 1, controllers: 1 });
  });

  it('updates the counts when a client disconnects', () => {
    const hub = new ControlHub();
    const panel = fakeClient(hub, 'panel');
    fakeClient(hub, 'out');
    subscribe(hub, 'panel', 'controller');
    subscribe(hub, 'out', 'renderer');

    hub.removeClient('out');

    expect(hub.state(CHANNEL).renderers).toBe(0);
    // The panel is told, so its "no output connected" indicator is truthful.
    expect(panel.states().length).toBeGreaterThan(0);
  });

  it('records playback state reported by a renderer', () => {
    const hub = new ControlHub();
    fakeClient(hub, 'out');
    subscribe(hub, 'out', 'renderer');

    hub.handle('out', {
      type: 'state',
      playback: { state: 'holding', time: 1.5, step: 1, stepCount: 1 },
    });

    expect(hub.state(CHANNEL).playback).toMatchObject({ state: 'holding', step: 1 });
  });

  it('does not echo renderer state reports back to renderers', () => {
    const hub = new ControlHub();
    const output = fakeClient(hub, 'out');
    subscribe(hub, 'out', 'renderer');
    const before = output.states().length;

    hub.handle('out', {
      type: 'state',
      playback: { state: 'playing-in', time: 0, step: 0, stepCount: 1 },
    });

    expect(output.states().length).toBe(before);
  });
});

describe('reconnect', () => {
  it('hands a joining renderer the channel data it missed', () => {
    /*
     * The reason the hub retains state at all. A browser source that drops
     * mid-show must come back showing the name the operator typed, not the
     * placeholder baked into the composition.
     */
    const hub = new ControlHub();
    hub.dispatch(CHANNEL, { verb: 'update', data: { name: 'Alex Rivera' } });

    const rejoining = fakeClient(hub, 'out');
    subscribe(hub, 'out', 'renderer');

    expect(rejoining.received[0]).toMatchObject({
      type: 'welcome',
      state: { data: { name: 'Alex Rivera' } },
    });
  });

  it('survives the renderer disconnecting and returning', () => {
    const hub = new ControlHub();
    fakeClient(hub, 'out1');
    subscribe(hub, 'out1', 'renderer');
    hub.dispatch(CHANNEL, { verb: 'update', data: { name: 'Jane' } });

    hub.removeClient('out1');

    const back = fakeClient(hub, 'out2');
    subscribe(hub, 'out2', 'renderer');

    expect(back.received[0]).toMatchObject({ state: { data: { name: 'Jane' } } });
  });

  it('gives a joining controller the current playback state', () => {
    const hub = new ControlHub();
    fakeClient(hub, 'out');
    subscribe(hub, 'out', 'renderer');
    hub.handle('out', {
      type: 'state',
      playback: { state: 'holding', time: 1.5, step: 1, stepCount: 2 },
    });

    const panel = fakeClient(hub, 'panel');
    subscribe(hub, 'panel', 'controller');

    expect(panel.received[0]).toMatchObject({
      type: 'welcome',
      state: { playback: { state: 'holding' } },
    });
  });

  it('forgets playback state on clear, but keeps the field values', () => {
    const hub = new ControlHub();
    hub.dispatch(CHANNEL, { verb: 'update', data: { name: 'Jane' } });
    hub.handle('x', { type: 'state', playback: { state: 'holding', time: 1, step: 1, stepCount: 1 } });
    hub.dispatch(CHANNEL, { verb: 'clear' });

    const state = hub.state(CHANNEL);
    expect(state.playback).toBeNull();
    expect(state.data).toEqual({ name: 'Jane' });
  });
});

describe('parseClientMessage', () => {
  it('accepts the three valid shapes', () => {
    expect(parseClientMessage('{"type":"subscribe","channel":"a/b","role":"renderer"}')).not.toBeNull();
    expect(parseClientMessage('{"type":"command","command":{"verb":"play"}}')).not.toBeNull();
    expect(parseClientMessage('{"type":"state","playback":{"state":"idle"}}')).not.toBeNull();
  });

  it('rejects malformed frames without throwing', () => {
    // A flaky device sending junk must not take the socket down.
    for (const bad of ['', 'not json', '[]', 'null', '{"type":"nope"}', '{"type":"subscribe"}']) {
      expect(parseClientMessage(bad)).toBeNull();
    }
  });
});
