// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * `BREEZE_CONSOLE=dashboard` — the terminal as a status board.
 *
 * The default console is a log, and stays one: it is what Docker, CI, a service
 * manager and anyone piping to a file expect, and a redrawing screen in any of
 * those is garbage. So the dashboard is opt-in, and even when asked for it only
 * runs on an interactive terminal; anywhere else the server says why in one
 * line and logs normally.
 *
 * Terminal text is English, like every other log line. It is a diagnostic
 * surface (I18N.md §5.1), read by whoever is running the box, and it needs to
 * match what gets pasted into an issue.
 *
 * Drawn with plain ANSI escapes on the alternate screen — no dependency. The
 * alternate screen is what makes exit clean: leaving it restores whatever the
 * terminal showed before, and the tail of the log is then printed on the normal
 * screen so the last thing the server said survives it.
 */

import type { ControlHub, PeerSnapshot } from './hub.js';
import { formatDuration, type ApiClients, type ApiPeer } from './peers.js';
import type { StatusReport } from './status.js';

export type ConsoleMode = 'log' | 'dashboard';

/**
 * What `BREEZE_CONSOLE` resolves to here, and a line saying why if that is not
 * what was asked for. Pure, so the fallback rules are testable without a TTY.
 */
export function resolveConsoleMode(
  raw: string,
  isTTY: boolean,
): { mode: ConsoleMode; warning?: string } {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'log') return { mode: 'log' };
  if (value !== 'dashboard') {
    return {
      mode: 'log',
      warning: `BREEZE_CONSOLE="${raw}" is not recognised (expected "log" or "dashboard"); logging normally`,
    };
  }
  if (!isTTY) {
    return {
      mode: 'log',
      warning: 'BREEZE_CONSOLE=dashboard needs an interactive terminal; output is not one, so logging normally',
    };
  }
  return { mode: 'dashboard' };
}

/* ------------------------------------------------------------------ log tail */

export interface LogLine {
  time: number;
  /** pino level: 30 info, 40 warn, 50 error. */
  level: number;
  text: string;
}

const LEVEL_NAMES: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

/** Strip a query string — a `?key=` must not be drawn on a screen. */
function pathOnly(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * The pino destination while the dashboard owns the terminal.
 *
 * Request logging is folded: Fastify writes two lines per request, and the
 * portal alone polls every couple of seconds, so a log pane showing them would
 * show nothing else. A request appears only when it failed — which is when it
 * is worth a line — as one `GET /path → 404 (3 ms)`. Everything else passes
 * through as time, level and message.
 */
export class LogTail {
  private buffer = '';
  private readonly lines: LogLine[] = [];
  private readonly pending = new Map<string, string>();
  private listener: (() => void) | null = null;

  constructor(private readonly capacity = 500) {}

  /** pino calls this with one or more newline-terminated JSON records. */
  write(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const raw = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (raw.trim() !== '') this.ingest(raw);
      nl = this.buffer.indexOf('\n');
    }
  }

  onLine(listener: () => void): void {
    this.listener = listener;
  }

  /** The last `n` lines, newest last. */
  last(n: number): LogLine[] {
    return n <= 0 ? [] : this.lines.slice(-n);
  }

  /** The last `n` lines as plain text, for printing after the dashboard exits. */
  plain(n: number): string[] {
    return this.last(n).map(formatLogLine);
  }

  private push(line: LogLine): void {
    this.lines.push(line);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    this.listener?.();
  }

  private ingest(raw: string): void {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.push({ time: Date.now(), level: 30, text: raw });
      return;
    }
    const time = typeof rec.time === 'number' ? rec.time : Date.now();
    const level = typeof rec.level === 'number' ? rec.level : 30;
    const msg = typeof rec.msg === 'string' ? rec.msg : '';
    const reqId = rec.reqId === undefined ? null : String(rec.reqId);
    const req = rec.req as { method?: string; url?: string } | undefined;
    const res = rec.res as { statusCode?: number } | undefined;

    if (reqId !== null && msg === 'incoming request' && req) {
      this.pending.set(reqId, `${req.method ?? '?'} ${pathOnly(req.url ?? '')}`);
      // A request that never completes (a socket upgrade, a crash) must not
      // leave its entry behind forever.
      if (this.pending.size > 1000) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.pending.delete(oldest);
      }
      return;
    }
    if (reqId !== null && msg === 'request completed' && res) {
      const what = this.pending.get(reqId) ?? '';
      this.pending.delete(reqId);
      const status = res.statusCode ?? 0;
      if (status < 400) return;
      const ms = typeof rec.responseTime === 'number' ? ` (${Math.round(rec.responseTime)} ms)` : '';
      this.push({ time, level: status >= 500 ? 50 : 40, text: `${what} → ${status}${ms}` });
      return;
    }

    const err = rec.err as { message?: string } | undefined;
    const text = err?.message && !msg.includes(err.message) ? `${msg} — ${err.message}` : msg;
    this.push({ time, level, text });
  }
}

export function formatLogLine(line: LogLine): string {
  const d = new Date(line.time);
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${clock} ${(LEVEL_NAMES[line.level] ?? String(line.level)).padEnd(5)} ${line.text}`;
}

/* --------------------------------------------------------------------- frame */

type Style = 'dim' | 'bold' | 'green' | 'yellow' | 'red' | 'cyan' | '';
type Seg = [text: string, style?: Style];

const SGR: Record<Exclude<Style, ''>, string> = {
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};
const BAR = '\x1b[7m';
const RESET = '\x1b[0m';

/**
 * Segments → one line exactly `width` columns wide. Truncation is done on the
 * text, before any escape is added, so a clipped line can never cut an escape
 * sequence in half and leave the terminal in the wrong colour.
 */
function fit(segs: Seg[], width: number, color: boolean, fill = ' ', fillStyle: Style = ''): string {
  let used = 0;
  let out = '';
  for (const [text, style = ''] of segs) {
    if (used >= width) break;
    const piece = text.length > width - used ? text.slice(0, Math.max(0, width - used - 1)) + '…' : text;
    used += piece.length;
    out += color && style ? `${SGR[style]}${piece}${RESET}` : piece;
  }
  if (used < width) {
    const pad = fill.repeat(width - used);
    out += color && fillStyle ? `${SGR[fillStyle]}${pad}${RESET}` : pad;
  }
  return out;
}

function col(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const t = text.length > width ? text.slice(0, Math.max(0, width - 1)) + '…' : text;
  return align === 'right' ? t.padStart(width) : t.padEnd(width);
}

function mb(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export interface FrameInput {
  version: string;
  status: StatusReport;
  sockets: PeerSnapshot[];
  api: ApiPeer[];
  apiWindowSeconds: number;
  /** Editor URL first, then output URLs. */
  urls: Array<[label: string, url: string]>;
  log: LogTail;
  describe: (agent: string) => string;
  now: number;
}

const KIND_LABEL: Record<string, string> = {
  panel: 'panel',
  editor: 'editor',
};

/**
 * One full screen, as `height` lines of exactly `width` columns.
 *
 * Pure — the renderer only writes what this returns — so layout is tested by
 * calling it, not by scraping a terminal.
 */
export function renderFrame(input: FrameInput, width: number, height: number, color: boolean): string[] {
  // One column spare: writing the last column of a row leaves some consoles
  // (older Windows conhost) wrapping early, which scrolls the whole frame.
  const w = Math.max(20, width - 1);
  const { status, now } = input;

  const head: string[] = [];
  // Plain text inside one inverse span: per-segment styles would each end in a
  // reset and cut the bar off after the first of them.
  const bar = fit(
    [
      [` Breeze Overlay ${input.version}`],
      [`   up ${formatDuration(status.uptime * 1000)}`],
      [`   CPU ${status.cpu.percent.toFixed(1)}% of ${status.cpu.cores} cores`],
      [`   RSS ${mb(status.memory.rss)}   heap ${mb(status.memory.heapUsed)}   RAM ${mb(status.memory.systemTotal)}`],
    ],
    w,
    false,
  );
  head.push(color ? `${BAR}${bar}${RESET}` : bar);
  for (const [label, url] of input.urls) {
    head.push(fit([[` ${label.padEnd(8)}`, 'dim'], [url, 'cyan']], w, color));
  }

  const rule = (title: string, extra = ''): string =>
    fit([['── ', 'dim'], [title, 'bold'], [extra ? `  ${extra}` : '', 'dim'], [' ', 'dim']], w, color, '─', 'dim');

  const from = (ip: string, agent: string): string => `${col(ip, 16)}${col(input.describe(agent), 20)}`;

  const sources = input.sockets.filter((p) => p.kind === 'source');
  // Same split as the /peers page and the portal's "Panels open": a panel's
  // readouts and embedded preview are part of it, not panels of their own.
  const panels = input.sockets.filter((p) => p.kind === 'panel' || p.kind === 'editor');
  const monitors = input.sockets.filter((p) => p.kind === 'monitor').length;
  const previews = input.sockets.filter((p) => p.kind === 'preview').length;
  const extras = [
    monitors > 0 ? `+${monitors} element readout${monitors === 1 ? '' : 's'}` : '',
    previews > 0 ? `+${previews} preview${previews === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(', ');

  const sceneW = Math.max(10, w - 2 - 36 - 10);
  const sourceRows: string[] = sources.map((p) =>
    fit([[`  ${from(p.ip, p.agent)}`], [col(p.channel, sceneW), 'cyan'], [col(formatDuration(now - p.connectedAt), 10, 'right'), 'dim']], w, color),
  );
  const panelSceneW = Math.max(10, sceneW - 9);
  const panelRows: string[] = panels.map((p) =>
    fit(
      [
        [`  ${col(KIND_LABEL[p.kind] ?? p.kind, 9)}`, p.kind === 'editor' ? 'yellow' : ''],
        [from(p.ip, p.agent)],
        [col(p.channel, panelSceneW), 'cyan'],
        [col(formatDuration(now - p.connectedAt), 10, 'right'), 'dim'],
      ],
      w,
      color,
    ),
  );
  const apiRows: string[] = input.api.map((a) =>
    fit(
      [
        [`  ${from(a.ip, a.agent)}`],
        [col(`${a.requests} req`, 9, 'right'), 'dim'],
        [col(String(a.lastStatus), 5, 'right'), a.lastStatus >= 400 ? 'red' : 'green'],
        [col(`${Math.max(0, Math.round((now - a.lastSeen) / 1000))}s ago`, 9, 'right'), 'dim'],
        [`  ${a.last}`],
      ],
      w,
      color,
    ),
  );

  const none = (text: string): string => fit([[`  ${text}`, 'dim']], w, color);
  const sections: Array<{ rule: string; rows: string[]; empty: string }> = [
    { rule: rule(`Browser sources (${sources.length})`), rows: sourceRows, empty: none('none connected') },
    {
      rule: rule(
        `Panels & editors (${panels.length})`,
        extras,
      ),
      rows: panelRows,
      empty: none('none open'),
    },
    {
      rule: rule(`API callers, last ${input.apiWindowSeconds}s (${input.api.length})`),
      rows: apiRows,
      empty: none('none'),
    },
  ];

  const footer = fit(
    [
      [' Press Ctrl+C to exit', 'bold'],
      ['   ·   BREEZE_CONSOLE=dashboard   ·   /peers in a browser shows the same list', 'dim'],
    ],
    w,
    color,
  );

  /* Height budget. Header, footer and the four rules are fixed; the log gets at
     least a few lines so a warning is never pushed off-screen by a busy LAN;
     the peer tables share the rest, each getting at least one row. */
  const fixed = head.length + 1 + sections.length + 1;
  const body = Math.max(0, height - fixed);
  const logMin = Math.min(6, body);
  let budget = body - logMin;
  const want = sections.map((s) => Math.max(1, s.rows.length));
  const give = sections.map(() => 0);
  for (let i = 0; i < give.length && budget > 0; i += 1) {
    give[i] = 1;
    budget -= 1;
  }
  let progress = true;
  while (budget > 0 && progress) {
    progress = false;
    for (let i = 0; i < give.length && budget > 0; i += 1) {
      if (give[i]! < want[i]!) {
        give[i]! += 1;
        budget -= 1;
        progress = true;
      }
    }
  }

  const lines = [...head];
  sections.forEach((s, i) => {
    lines.push(s.rule);
    const n = give[i]!;
    if (n === 0) return;
    if (s.rows.length === 0) {
      lines.push(s.empty);
      return;
    }
    if (s.rows.length <= n) {
      lines.push(...s.rows);
      return;
    }
    lines.push(...s.rows.slice(0, n - 1));
    lines.push(none(`… and ${s.rows.length - (n - 1)} more — see /peers`));
  });

  lines.push(rule('Log'));
  const logRows = Math.max(0, height - lines.length - 1);
  const levelStyle = (level: number): Style => (level >= 50 ? 'red' : level >= 40 ? 'yellow' : '');
  const tail = input.log.last(logRows).map((l) => fit([[` ${formatLogLine(l)}`, levelStyle(l.level)]], w, color));
  lines.push(...tail);
  while (lines.length < height - 1) lines.push(' '.repeat(w));
  lines.push(footer);

  return lines.slice(0, Math.max(0, height));
}

/* ------------------------------------------------------------------ renderer */

export interface DashboardOptions {
  out: NodeJS.WriteStream;
  hub: ControlHub;
  api: ApiClients;
  status: () => StatusReport;
  version: string;
  urls: Array<[string, string]>;
  log: LogTail;
  describe: (agent: string) => string;
}

export class Dashboard {
  private timer: NodeJS.Timeout | null = null;
  private pendingDraw: NodeJS.Timeout | null = null;
  private running = false;
  private readonly color: boolean;
  private readonly onResize = (): void => this.draw();

  constructor(private readonly opts: DashboardOptions) {
    // https://no-color.org — present and non-empty means no colour.
    this.color = !process.env.NO_COLOR;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Alternate screen, cursor hidden.
    this.opts.out.write('\x1b[?1049h\x1b[?25l');
    this.opts.out.on('resize', this.onResize);
    // A log line redraws soon, not immediately: a burst of forty lines is one
    // frame, not forty.
    this.opts.log.onLine(() => {
      if (this.pendingDraw || !this.running) return;
      this.pendingDraw = setTimeout(() => {
        this.pendingDraw = null;
        this.draw();
      }, 100);
    });
    this.draw();
    this.timer = setInterval(() => this.draw(), 1000);
  }

  /** Idempotent, synchronous — safe from `process.on('exit')`. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.pendingDraw) clearTimeout(this.pendingDraw);
    this.timer = null;
    this.pendingDraw = null;
    this.opts.out.off('resize', this.onResize);
    this.opts.log.onLine(() => {});
    this.opts.out.write('\x1b[?25h\x1b[?1049l');
  }

  private draw(): void {
    if (!this.running) return;
    const { out } = this.opts;
    const width = out.columns || 100;
    const height = out.rows || 30;
    const lines = renderFrame(
      {
        version: this.opts.version,
        status: this.opts.status(),
        sockets: this.opts.hub.peers(),
        api: this.opts.api.list(),
        apiWindowSeconds: this.opts.api.windowSeconds,
        urls: this.opts.urls,
        log: this.opts.log,
        describe: this.opts.describe,
        now: Date.now(),
      },
      width,
      height,
      this.color,
    );
    // Home, then every line overwritten in place — no full clear, so no flicker.
    out.write(`\x1b[H${lines.join('\r\n')}\x1b[J`);
  }
}
