// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Editor presence on the control hub.
 *
 * The portal's status strip counts controllers per channel, and the editor was
 * never one: it had no socket to the hub at all, so an open editor showed as
 * zero panels and the readout quietly lied. This subscribes as a `controller`
 * on the scene being edited, which is what the editor already is in the hub's
 * terms — a client that could send commands — and makes "someone has this scene
 * open" true rather than aspirational.
 *
 * Deliberately send-only. Nothing inbound is read: the editor renders from its
 * own store, and acting on hub state here would make a second, racing source of
 * truth for what is on the stage. The subscription exists to be counted.
 */

import { useEffect, useRef } from 'react';

/** Longest gap between reconnect attempts. */
const MAX_BACKOFF_MS = 15_000;

/**
 * Hold a controller subscription for `channel` (`projectId/compositionId`) for
 * as long as this component is mounted. Pass null before a project has loaded.
 */
export function useHubPresence(channel: string | null): void {
  const socketRef = useRef<WebSocket | null>(null);
  /*
   * The live channel, readable from inside the socket's own handlers.
   *
   * The connection outlives any one scene — switching scenes must not tear down
   * and rebuild a socket — so the `open` handler cannot close over the channel
   * it was created with. By the time a reconnect succeeds, the user may be on a
   * different scene entirely, and re-subscribing to the old one would count the
   * editor against a scene nobody is looking at.
   */
  const channelRef = useRef(channel);
  channelRef.current = channel;

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let attempt = 0;

    const subscribe = (socket: WebSocket): void => {
      const current = channelRef.current;
      if (!current || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({
          type: 'subscribe',
          channel: current,
          role: 'controller',
          // Counted on the status strip, but kept out of the activity log:
          // design-time comings and goings would bury the operator entries.
          client: 'editor',
        }));
    };

    const schedule = (): void => {
      if (disposed) return;
      attempt += 1;
      // Backoff, because the common reason this fails is the server being
      // restarted mid-build — and a tight retry loop against a server that is
      // also feeding graphics to air is the wrong thing to do about it.
      timer = window.setTimeout(connect, Math.min(2 ** (attempt - 1) * 1000, MAX_BACKOFF_MS));
    };

    function connect(): void {
      if (disposed) return;

      let socket: WebSocket;
      try {
        const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
        socket = new WebSocket(`${scheme}://${window.location.host}/ws/control`);
      } catch {
        // Constructing a WebSocket can throw outright on a bad URL. Presence is
        // a nicety; the editor must not fail to work because of it.
        schedule();
        return;
      }

      socketRef.current = socket;

      socket.addEventListener('open', () => {
        attempt = 0;
        subscribe(socket);
      });
      socket.addEventListener('close', () => {
        if (socketRef.current === socket) socketRef.current = null;
        schedule();
      });
      // `error` is always followed by `close`, which is where the retry lives.
      socket.addEventListener('error', () => socket.close());
    }

    connect();

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  /*
   * Switching scenes re-subscribes on the existing socket rather than opening a
   * new one. The hub reassigns the client's channel and broadcasts state for
   * both, so the count moves from the old scene to the new one in one step.
   */
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !channel || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({ type: 'subscribe', channel, role: 'controller', client: 'editor' }),
    );
  }, [channel]);
}
