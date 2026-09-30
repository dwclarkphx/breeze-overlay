// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The text template behind the `compose` transform.
 *
 * A data source hands a graphic columns; a sentence needs several of them at
 * once. `The NWS has issued a {event} for {areas|list}, until {ends|when}` reads
 * three columns and turns one of them into a list and one into a time — the
 * whole job, so a ticker (which reads one column per item) or a single text
 * cell can show it.
 *
 * Pure and dependency-free like the rest of the schema package: the server, the
 * output page and the editor's preview all run it and must agree.
 *
 * **Syntax.** `{column}` is a value; `{column|modifier|modifier}` shapes it,
 * modifiers running left to right. `{{` and `}}` are literal braces. An empty
 * or missing value is empty text, never the word "null".
 *
 * | Modifier        | Does                                                            |
 * |-----------------|-----------------------------------------------------------------|
 * | `list`          | `A; B; C` → `A, B and C` (splits on `;`)                        |
 * | `drop:text`     | removes every `text` — `drop:, AZ` strips a state suffix         |
 * | `upper`/`lower` | case                                                            |
 * | `default:text`  | text to use when the value is empty                             |
 * | `when`          | a time as `3:35 PM` today, `Wed 3:15 AM` within the week, else `Oct 4 3:15 AM` |
 * | `time:FORMAT`   | a time in your own layout — the clock layer's tokens            |
 *
 * `time:` reads the same tokens a clock layer does — `h:mm A`, `ddd`, `MMM D`
 * and so on (see `CLOCK_TOKENS`) — in English. A modifier's text ends at the
 * next `|` or `}`, so neither can appear inside it.
 */

import { addDays, localParts, readTime } from './time.js';

/** Modifiers that take an argument after a colon, and those that do not. */
const WITH_ARG = new Set(['drop', 'default', 'time']);
const BARE = new Set(['list', 'upper', 'lower', 'when']);

export interface TemplateField {
  column: string;
  modifiers: Array<{ name: string; arg?: string }>;
}

export type TemplatePart = string | TemplateField;

export interface ParsedTemplate {
  parts: TemplatePart[];
  /** Human-readable problems: an unclosed brace, an unknown modifier. Empty when the template is sound. */
  problems: string[];
}

/** Split a template into text and fields. Never throws — problems are listed. */
export function parseTemplate(template: string): ParsedTemplate {
  const parts: TemplatePart[] = [];
  const problems: string[] = [];
  let text = '';
  const flush = (): void => {
    if (text) parts.push(text);
    text = '';
  };
  for (let i = 0; i < template.length; i++) {
    const c = template[i]!;
    if (c === '{' && template[i + 1] === '{') {
      text += '{';
      i++;
    } else if (c === '}' && template[i + 1] === '}') {
      text += '}';
      i++;
    } else if (c === '{') {
      const end = template.indexOf('}', i + 1);
      if (end === -1) {
        problems.push('a "{" is never closed — write "{{" for a literal brace');
        text += template.slice(i);
        break;
      }
      const [column, ...mods] = template.slice(i + 1, end).split('|');
      const key = (column ?? '').trim();
      if (!key) problems.push('an empty field "{}" — name a column');
      const modifiers: TemplateField['modifiers'] = [];
      for (const raw of mods) {
        const colon = raw.indexOf(':');
        const name = (colon === -1 ? raw : raw.slice(0, colon)).trim();
        const arg = colon === -1 ? undefined : raw.slice(colon + 1);
        if (WITH_ARG.has(name)) {
          if (arg === undefined || (name !== 'default' && arg === '')) problems.push(`"${name}" needs text after a colon, like ${name}:…`);
          else modifiers.push({ name, arg });
        } else if (BARE.has(name)) {
          if (arg !== undefined) problems.push(`"${name}" takes no text after it`);
          modifiers.push({ name });
        } else {
          problems.push(`unknown modifier "${name}" — use list, drop:, upper, lower, default:, when or time:`);
        }
      }
      flush();
      parts.push({ column: key, modifiers });
      i = end;
    } else if (c === '}') {
      problems.push('a stray "}" — write "}}" for a literal brace');
      text += c;
    } else {
      text += c;
    }
  }
  flush();
  return { parts, problems };
}

/** The columns a template reads, in order of first use. */
export function templateColumns(template: string): string[] {
  const out: string[] = [];
  for (const p of parseTemplate(template).parts) {
    if (typeof p !== 'string' && p.column && !out.includes(p.column)) out.push(p.column);
  }
  return out;
}

/** Whether a template's output depends on the time of day (`when`). */
export function templateUsesClock(template: string): boolean {
  return parseTemplate(template).parts.some((p) => typeof p !== 'string' && p.modifiers.some((m) => m.name === 'when'));
}

/* ------------------------------------------------------------------ times */

const TOKEN = /YYYY|MMMM|dddd|MMM|ddd|YY|HH|hh|mm|MM|DD|H|h|m|D|M|A|a/g;

interface Parts {
  weekdayLong: string;
  weekdayShort: string;
  monthLong: string;
  monthShort: string;
  year: string;
  month: string;
  day: string;
  hour24: number;
  minute: string;
}

function partsAt(ms: number, zone: string | undefined): Parts {
  const read = (tz: string | undefined): Intl.DateTimeFormatPart[] =>
    new Intl.DateTimeFormat('en-US', {
      ...(tz ? { timeZone: tz } : {}),
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
  let list: Intl.DateTimeFormatPart[];
  try {
    list = read(zone);
  } catch {
    list = read(undefined);
  }
  const get = (t: string): string => list.find((p) => p.type === t)?.value ?? '';
  const weekdayLong = get('weekday');
  const monthLong = get('month');
  return {
    weekdayLong,
    weekdayShort: weekdayLong.slice(0, 3),
    monthLong,
    monthShort: monthLong.slice(0, 3),
    year: get('year'),
    month: String(
      ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].indexOf(monthLong) + 1,
    ),
    day: get('day'),
    hour24: Number(get('hour')) % 24,
    minute: get('minute'),
  };
}

const two = (s: string | number): string => String(s).padStart(2, '0');

/** Format an instant with the clock layer's tokens, in English, at `zone`. */
export function formatInstant(ms: number, format: string, zone: string | undefined): string {
  const p = partsAt(ms, zone);
  const h12 = p.hour24 % 12 === 0 ? 12 : p.hour24 % 12;
  return format.replace(TOKEN, (t) => {
    switch (t) {
      case 'YYYY': return p.year;
      case 'YY': return p.year.slice(-2);
      case 'MMMM': return p.monthLong;
      case 'MMM': return p.monthShort;
      case 'MM': return two(p.month);
      case 'M': return p.month;
      case 'DD': return two(p.day);
      case 'D': return p.day;
      case 'dddd': return p.weekdayLong;
      case 'ddd': return p.weekdayShort;
      case 'HH': return two(p.hour24);
      case 'H': return String(p.hour24);
      case 'hh': return two(h12);
      case 'h': return String(h12);
      case 'mm': return p.minute;
      case 'm': return String(Number(p.minute));
      case 'A': return p.hour24 < 12 ? 'AM' : 'PM';
      case 'a': return p.hour24 < 12 ? 'am' : 'pm';
      default: return t;
    }
  });
}

/** `when`: the time alone today, with the weekday inside the coming week, with the date beyond it. */
function whenText(value: string, zone: string | undefined, now: Date): string {
  const at = readTime(value, zone);
  if (at === null) return '';
  if (at.ms === undefined) {
    // A date with no time of day.
    const [y, m, d] = at.date.split('-').map(Number) as [number, number, number];
    return formatInstant(Date.UTC(y, m - 1, d, 12), 'MMM D', 'UTC');
  }
  const today = localParts(zone, now).date;
  if (at.date === today) return formatInstant(at.ms, 'h:mm A', zone);
  for (let n = 1; n <= 6; n++) if (at.date === addDays(today, n)) return formatInstant(at.ms, 'ddd h:mm A', zone);
  return formatInstant(at.ms, 'MMM D h:mm A', zone);
}

function timeText(value: string, format: string, zone: string | undefined): string {
  const at = readTime(value, zone);
  if (at === null) return '';
  if (at.ms === undefined) {
    const [y, m, d] = at.date.split('-').map(Number) as [number, number, number];
    return formatInstant(Date.UTC(y, m - 1, d, 12), format, 'UTC');
  }
  return formatInstant(at.ms, format, zone);
}

/** `A; B; C` → `A, B and C`. */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/* ---------------------------------------------------------------- render */

export interface ComposeContext {
  /** IANA zone for `when` and `time:`. Absent: the machine's own. */
  timezone?: string;
  now?: Date;
}

/** Fill a parsed template from one row. */
export function renderTemplate(parsed: ParsedTemplate, row: Record<string, unknown>, ctx: ComposeContext = {}): string {
  const now = ctx.now ?? new Date();
  let out = '';
  for (const part of parsed.parts) {
    if (typeof part === 'string') {
      out += part;
      continue;
    }
    const raw = row[part.column];
    let v = raw === null || raw === undefined ? '' : String(raw).trim();
    for (const m of part.modifiers) {
      switch (m.name) {
        case 'drop': v = m.arg ? v.split(m.arg).join('') : v; break;
        case 'list': v = joinList(v.split(';').map((s) => s.trim()).filter(Boolean)); break;
        case 'upper': v = v.toUpperCase(); break;
        case 'lower': v = v.toLowerCase(); break;
        case 'default': if (v === '') v = m.arg ?? ''; break;
        case 'when': v = v === '' ? '' : whenText(v, ctx.timezone, now); break;
        case 'time': v = v === '' ? '' : timeText(v, m.arg ?? '', ctx.timezone); break;
      }
    }
    out += v;
  }
  return out;
}
