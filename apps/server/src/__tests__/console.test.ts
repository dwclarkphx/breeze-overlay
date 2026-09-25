// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * `BREEZE_CONSOLE=dashboard`.
 *
 * The frame is a pure function, so layout is asserted by calling it. What
 * matters: the dashboard never runs where it would be garbage (no TTY), the
 * frame always fits the terminal exactly, the exit hint is always on screen,
 * and request noise stays out of the log pane unless a request failed.
 */

import { describe, expect, it } from 'vitest';

import { LogTail, renderFrame, resolveConsoleMode, type FrameInput } from '../console.js';
import type { StatusReport } from '../status.js';

describe('resolveConsoleMode', () => {
  it('defaults to the log', () => {
    expect(resolveConsoleMode('log', true)).toEqual({ mode: 'log' });
    expect(resolveConsoleMode('', true)).toEqual({ mode: 'log' });
  });

  it('runs the dashboard only on an interactive terminal, and says why not', () => {
    expect(resolveConsoleMode('dashboard', true)).toEqual({ mode: 'dashboard' });
    expect(resolveConsoleMode('Dashboard', true)).toEqual({ mode: 'dashboard' });
    const piped = resolveConsoleMode('dashboard', false);
    expect(piped.mode).toBe('log');
    expect(piped.warning).toMatch(/interactive terminal/);
  });

  it('falls back on a value it does not know rather than guessing', () => {
    const r = resolveConsoleMode('fancy', true);
    expect(r.mode).toBe('log');
    expect(r.warning).toMatch(/"fancy"/);
  });
});

const rec = (o: Record<string, unknown>) => `${JSON.stringify({ level: 30, time: 0, ...o })}\n`;

describe('LogTail', () => {
  it('folds a successful request away entirely', () => {
    const tail = new LogTail();
    tail.write(rec({ reqId: 'r1', msg: 'incoming request', req: { method: 'GET', url: '/api/status' } }));
    tail.write(rec({ reqId: 'r1', msg: 'request completed', res: { statusCode: 200 }, responseTime: 2 }));
    expect(tail.last(10)).toHaveLength(0);
  });

  it('shows a failed request as one line, without its query string', () => {
    const tail = new LogTail();
    tail.write(rec({ reqId: 'r2', msg: 'incoming request', req: { method: 'POST', url: '/api/control/a/b/play?key=s3cret' } }));
    tail.write(rec({ reqId: 'r2', msg: 'request completed', res: { statusCode: 401 }, responseTime: 1.4 }));
    const lines = tail.plain(10);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('POST /api/control/a/b/play → 401 (1 ms)');
    expect(lines[0]).toContain('WARN');
    expect(lines[0]).not.toContain('s3cret');
  });

  it('reassembles records split across writes, and passes other lines through', () => {
    const tail = new LogTail();
    const line = rec({ level: 40, msg: 'could not register data sources', err: { message: 'ENOENT' } });
    tail.write(line.slice(0, 10));
    tail.write(line.slice(10));
    tail.write('not json\n');
    const lines = tail.plain(10);
    expect(lines[0]).toContain('could not register data sources — ENOENT');
    expect(lines[1]).toContain('not json');
  });

  it('keeps a bounded tail', () => {
    const tail = new LogTail(5);
    for (let i = 0; i < 12; i += 1) tail.write(rec({ msg: `m${i}` }));
    expect(tail.plain(100)).toHaveLength(5);
    expect(tail.plain(1)[0]).toContain('m11');
  });
});

const STATUS: StatusReport = {
  version: '0.73.0',
  ui: { locale: 'en', direction: 'ltr' },
  uptime: 3725,
  viewers: { renderers: 0, controllers: 0, channels: [] },
  cpu: { percent: 3.14, cores: 8 },
  memory: { rss: 180 * 1024 ** 2, heapUsed: 60 * 1024 ** 2, systemTotal: 32 * 1024 ** 3 },
};

function input(over: Partial<FrameInput> = {}): FrameInput {
  return {
    version: '0.73.0',
    status: STATUS,
    sockets: [],
    api: [],
    apiWindowSeconds: 60,
    urls: [['Editor', 'http://localhost:7331/']],
    log: new LogTail(),
    describe: (a) => a,
    now: 10_000_000,
    ...over,
  };
}

const source = (i: number) => ({
  id: `s${i}`, kind: 'source' as const, channel: `demo/scene-${i}`,
  ip: `10.0.0.${i}`, agent: 'vMix', connectedAt: 10_000_000 - 65_000,
});

describe('renderFrame', () => {
  it('fills the terminal exactly and always ends on the exit hint', () => {
    for (const [w, h] of [[100, 30], [60, 14], [200, 50]] as const) {
      const lines = renderFrame(input(), w, h, false);
      expect(lines).toHaveLength(h);
      for (const l of lines) expect(l.length).toBe(w - 1);
      expect(lines[h - 1]).toContain('Press Ctrl+C to exit');
    }
  });

  it('shows stats and each table', () => {
    const lines = renderFrame(input({ sockets: [source(1)] }), 120, 30, false).join('\n');
    expect(lines).toContain('Breeze Overlay 0.73.0');
    expect(lines).toContain('up 1:02:05');
    expect(lines).toContain('CPU 3.1% of 8 cores');
    expect(lines).toContain('Browser sources (1)');
    expect(lines).toContain('demo/scene-1');
    expect(lines).toContain('1:05');
    expect(lines).toContain('Panels & editors (0)');
    expect(lines).toContain('API callers, last 60s (0)');
  });

  it("folds a panel's readouts and preview into its heading", () => {
    const peer = (id: string, kind: 'panel' | 'monitor' | 'preview') => ({
      id, kind, channel: 'demo/scene', ip: '10.0.0.2', agent: 'Chrome', connectedAt: 9_000_000,
    });
    const sockets = [peer('p', 'panel'), peer('m1', 'monitor'), peer('m2', 'monitor'), peer('v', 'preview')];
    const text = renderFrame(input({ sockets }), 120, 30, false).join('\n');
    expect(text).toContain('Panels & editors (1)  +2 element readouts, +1 preview');
  });

  it('overflows a long table into a count rather than off the screen', () => {
    const many = Array.from({ length: 40 }, (_, i) => source(i + 1));
    const lines = renderFrame(input({ sockets: many }), 100, 24, false);
    expect(lines).toHaveLength(24);
    expect(lines.join('\n')).toMatch(/… and \d+ more — see \/peers/);
    expect(lines[23]).toContain('Press Ctrl+C to exit');
  });

  it('never cuts a colour escape in half when it truncates', () => {
    const long = { ...source(1), channel: 'x'.repeat(300) };
    const lines = renderFrame(input({ sockets: [long] }), 60, 20, true);
    for (const l of lines) {
      // Every ESC starts a complete SGR sequence.
      expect(l.replace(/\x1b\[[0-9;]*m/g, '')).not.toContain('\x1b');
    }
  });
});
