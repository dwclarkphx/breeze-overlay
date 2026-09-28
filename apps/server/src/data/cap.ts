// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * Common Alerting Protocol reader (Phase 8.6 Wave 3 — CYCLE.md).
 *
 * CAP is one standard that arrives in three wrappers, and a station needs all
 * three:
 *
 *  - a bare CAP 1.2 `<alert>` document, with its fields inside `<info>`;
 *  - an Atom (or RSS) feed whose entries carry `cap:` fields — NWS publishes
 *    this with the fields on the entry, AirNow with most of them inside a
 *    `cap:info`, and this reader looks in both places rather than knowing
 *    which publisher it is talking to;
 *  - the NWS alerts API's GeoJSON, where the same fields are the properties of
 *    each feature.
 *
 * All three normalise onto CAP_COLUMNS. The rules that make it safe on air
 * come before any filter the operator chose: only `Actual` messages, no
 * cancellations, nothing past its expiry. A warning strip that shows a test
 * message, or a warning that ended an hour ago, is worse than no strip.
 *
 * Text is passed through as published. Whitespace is collapsed — NWS hard-wraps
 * its descriptions at 70 columns, which is layout, not content — and HTML is
 * stripped, but the words are the agency's and are not edited: AirNow's terms
 * forbid altering advisory statements, and an NWS warning is not ours to
 * paraphrase either.
 */

import {
  CAP_COLUMNS,
  CAP_SEVERITIES,
  conform,
  type CapDataSource,
  type CapSeverity,
  type DataRow,
  type DataSet,
} from '@breeze/schema';

import { stripHtml } from './parse-xml.js';
import { localParts, msToLocalMidnight, parseInZone } from './places.js';
import { childNamed, childrenNamed, childText, parseXml, type XmlNode } from './xml.js';

/** One alert, before filtering, in the shape every wrapper reduces to. */
export interface CapAlert {
  id: string;
  status: string;
  msgType: string;
  event: string;
  headline: string;
  description: string;
  instruction: string;
  severity: string;
  urgency: string;
  certainty: string;
  category: string;
  areaDesc: string;
  codes: string[];
  sender: string;
  senderName: string;
  effective: string;
  onset: string;
  expires: string;
  ends: string;
  web: string;
}

const clean = (text: string | null | undefined): string => stripHtml(text ?? '');

/* ------------------------------------------------------------------ XML */

/**
 * A field from an entry, or from its `info` block.
 *
 * Entry first: NWS's Atom puts everything on the entry, and AirNow puts
 * `status` and `msgType` there while the rest sit in `cap:info` — which is
 * also where a bare CAP document keeps them.
 */
function field(entry: XmlNode, info: XmlNode | undefined, ...names: string[]): string {
  return childText(entry, ...names) || (info ? childText(info, ...names) : '');
}

/** Every geocode value under a node, split — NWS packs several into one `<value>`. */
function geocodes(node: XmlNode): string[] {
  const out: string[] = [];
  const visit = (n: XmlNode): void => {
    for (const child of n.children) {
      if (child.local.toLowerCase() === 'geocode') {
        for (const value of childrenNamed(child, 'value')) out.push(...value.text.split(/\s+/).filter(Boolean));
      } else {
        visit(child);
      }
    }
  };
  visit(node);
  return out;
}

function areaDescOf(entry: XmlNode, info: XmlNode | undefined): string {
  const direct = field(entry, info, 'areaDesc');
  if (direct) return direct;
  const areas = [...childrenNamed(entry, 'area'), ...(info ? childrenNamed(info, 'area') : [])];
  return areas.map((a) => childText(a, 'areaDesc')).filter(Boolean).join('; ');
}

/**
 * The English `info` block, or the first one.
 *
 * CAP allows an `<info>` per language. A station's graphic is in one language
 * and CAP's default is `en-US`, so the English block wins when there is a
 * choice; a feed that only has Spanish still yields its alert rather than none.
 */
function infoOf(node: XmlNode): XmlNode | undefined {
  const infos = childrenNamed(node, 'info');
  return infos.find((i) => childText(i, 'language').toLowerCase().startsWith('en')) ?? infos[0];
}

function alertFromXml(entry: XmlNode): CapAlert {
  const info = infoOf(entry);
  // Atom carries the link in `href`; RSS as the element's text.
  const link = childrenNamed(entry, 'link').find((l) => l.attrs['href'])?.attrs['href'] ?? childText(entry, 'link');
  return {
    id: field(entry, info, 'identifier', 'id', 'guid'),
    status: field(entry, info, 'status'),
    msgType: field(entry, info, 'msgType'),
    event: clean(field(entry, info, 'event')),
    headline: clean(field(entry, info, 'headline') || childText(entry, 'title')),
    description: clean(field(entry, info, 'description')),
    instruction: clean(field(entry, info, 'instruction')),
    severity: field(entry, info, 'severity'),
    urgency: field(entry, info, 'urgency'),
    certainty: field(entry, info, 'certainty'),
    category: field(entry, info, 'category'),
    areaDesc: clean(areaDescOf(entry, info)),
    codes: geocodes(entry),
    sender: field(entry, info, 'sender'),
    senderName: clean(field(entry, info, 'senderName')),
    effective: field(entry, info, 'effective', 'sent', 'updated'),
    onset: field(entry, info, 'onset'),
    expires: field(entry, info, 'expires'),
    ends: field(entry, info, 'ends'),
    web: field(entry, info, 'web') || link,
  };
}

/** Alerts from any of the XML wrappers. */
export function parseCapXml(text: string): CapAlert[] {
  const root = parseXml(text);
  if (!root) throw new Error('no XML in the response — is this a CAP document or feed?');

  // `parseXml` returns the root element itself, or a synthetic `#document`
  // when there were several top-level elements; then the first that is a
  // known wrapper wins.
  const known = new Set(['alert', 'feed', 'rss', 'channel']);
  const top = root.name === '#document'
    ? root.children.find((c) => known.has(c.local.toLowerCase())) ?? root
    : root;
  const name = top.local.toLowerCase();

  if (name === 'alert') return [alertFromXml(top)];
  if (name === 'feed') return childrenNamed(top, 'entry').map(alertFromXml);
  if (name === 'rss') {
    const channel = childNamed(top, 'channel');
    return channel ? childrenNamed(channel, 'item').map(alertFromXml) : [];
  }
  if (name === 'channel') return childrenNamed(top, 'item').map(alertFromXml);
  throw new Error(`expected a CAP alert, an Atom feed or an RSS feed — got <${top.name}>`);
}

/* -------------------------------------------------------------- GeoJSON */

interface NwsAlertProperties {
  id?: string;
  areaDesc?: string;
  geocode?: Record<string, string[] | undefined>;
  effective?: string;
  onset?: string | null;
  expires?: string;
  ends?: string | null;
  status?: string;
  messageType?: string;
  category?: string;
  severity?: string;
  certainty?: string;
  urgency?: string;
  event?: string;
  sender?: string;
  senderName?: string;
  headline?: string | null;
  description?: string | null;
  instruction?: string | null;
  web?: string;
  '@id'?: string;
}

/** Alerts from the NWS API's GeoJSON (`/alerts/active?area=AZ` and friends). */
export function parseCapGeoJson(payload: unknown): CapAlert[] {
  const features = (payload as { features?: Array<{ id?: string; properties?: NwsAlertProperties }> }).features;
  if (!Array.isArray(features)) throw new Error('JSON without a "features" list — expected the NWS alerts GeoJSON');
  return features.map((feature) => {
    const p = feature.properties ?? {};
    const codes = Object.values(p.geocode ?? {}).flatMap((list) => list ?? []);
    return {
      id: p.id ?? feature.id ?? '',
      status: p.status ?? '',
      msgType: p.messageType ?? '',
      event: clean(p.event),
      headline: clean(p.headline),
      description: clean(p.description),
      instruction: clean(p.instruction),
      severity: p.severity ?? '',
      urgency: p.urgency ?? '',
      certainty: p.certainty ?? '',
      category: p.category ?? '',
      areaDesc: clean(p.areaDesc),
      codes,
      sender: p.sender ?? '',
      senderName: clean(p.senderName),
      effective: p.effective ?? '',
      onset: p.onset ?? '',
      expires: p.expires ?? '',
      ends: p.ends ?? '',
      web: p.web ?? p['@id'] ?? feature.id ?? '',
    };
  });
}

/* ---------------------------------------------------------------- rules */

export function severityRank(severity: string): number {
  const i = CAP_SEVERITIES.findIndex((s) => s.toLowerCase() === severity.trim().toLowerCase());
  return i === -1 ? 0 : i;
}

const list = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** Local calendar date of an ISO time, read off its first ten characters. */
const dateOf = (iso: string): string | null => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

/** The day before a `YYYY-MM-DD` date. */
function dayBefore(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Whether an alert has ended, and whether it has started.
 *
 * `exact` believes the times. `local-day` reads only the dates and compares
 * them with today's date in the configured zone — see CAP_TIME_MODES for why
 * AirNow needs it. An `expires` of exactly midnight means "through the day
 * before": AirNow writes a one-day action day as midnight to midnight, and
 * counting the second midnight as a day of its own would run the alert into
 * tomorrow.
 */
export function alertWindow(
  alert: CapAlert,
  def: Pick<CapDataSource, 'times' | 'timezone'>,
  now: Date,
): { ended: boolean; active: boolean } {
  const start = alert.onset || alert.effective;
  const end = alert.expires || alert.ends;

  if ((def.times ?? 'exact') === 'local-day') {
    const today = localParts(def.timezone, now).date;
    const from = dateOf(start);
    let to = dateOf(end);
    if (to && /T00:00(:00)?/.test(end)) to = dayBefore(to);
    return {
      ended: to !== null && today > to,
      active: from === null || today >= from,
    };
  }

  // CAP requires offsets; a publisher that leaves them off is read in the
  // configured zone rather than in whatever zone the server happens to run.
  const endMs = parseInZone(end, def.timezone);
  const startMs = parseInZone(start, def.timezone);
  return {
    ended: Number.isFinite(endMs) && endMs <= now.getTime(),
    active: !Number.isFinite(startMs) || startMs <= now.getTime(),
  };
}

/**
 * Alerts → rows: the safety rules, then the operator's filters, then order.
 *
 * Duplicates by id are dropped (an alert can appear in two zones' feeds). The
 * order is most severe first, then soonest — the one a viewer most needs to
 * see leads the strip.
 */
export function capToRows(alerts: CapAlert[], def: CapDataSource, now: Date): DataRow[] {
  const areas = list(def.area);
  const codes = list(def.codes);
  const events = list(def.events);
  const floor = def.minSeverity ? severityRank(def.minSeverity) : 0;
  const seen = new Set<string>();

  const kept = alerts.filter((alert) => {
    /*
     * `Actual` is required, not merely "not Test". CAP makes `status`
     * mandatory, so an entry without one is not an alert at all — the "there
     * are no active warnings" placeholder some feeds publish, or an ordinary
     * RSS item — and it has no expiry either, so letting it through would put
     * it on the strip for good.
     */
    if (alert.status.toLowerCase() !== 'actual') return false;
    if (alert.msgType.toLowerCase() === 'cancel') return false;
    if (alertWindow(alert, def, now).ended) return false;
    if (areas.length && !areas.some((a) => alert.areaDesc.toLowerCase().includes(a))) return false;
    if (codes.length && !alert.codes.some((c) => codes.includes(c.toLowerCase()))) return false;
    if (events.length && !events.some((e) => alert.event.toLowerCase().includes(e))) return false;
    if (severityRank(alert.severity) < floor) return false;
    const key = alert.id || `${alert.event}|${alert.areaDesc}|${alert.effective}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  kept.sort((a, b) => {
    const bySeverity = severityRank(b.severity) - severityRank(a.severity);
    if (bySeverity !== 0) return bySeverity;
    return (a.onset || a.effective).localeCompare(b.onset || b.effective);
  });

  return kept.map((alert) => ({
    id: alert.id || null,
    event: alert.event || null,
    headline: alert.headline || null,
    description: alert.description || null,
    instruction: alert.instruction || null,
    severity: alert.severity || null,
    severityRank: severityRank(alert.severity),
    urgency: alert.urgency || null,
    certainty: alert.certainty || null,
    category: alert.category || null,
    msgType: alert.msgType || null,
    areaDesc: alert.areaDesc || null,
    codes: alert.codes.length ? alert.codes.join(', ') : null,
    sender: alert.sender || null,
    senderName: alert.senderName || null,
    effective: alert.effective || null,
    onset: alert.onset || null,
    expires: alert.expires || null,
    ends: alert.ends || null,
    active: alertWindow(alert, def, now).active,
    web: alert.web || null,
  }));
}

/** A fetched body → a DataSet. JSON is the NWS GeoJSON; anything else is XML. */
/**
 * Milliseconds until these rows could next change without the feed changing:
 * the soonest alert end, or — reading local days — the coming local midnight.
 * The registry wakes then, so an alert leaves the screen at its end rather
 * than at the next poll. Undefined when nothing is pending.
 */
export function capDueIn(def: CapDataSource, rows: DataRow[], now: Date): number | undefined {
  if ((def.times ?? 'exact') === 'local-day') {
    return rows.length ? msToLocalMidnight(def.timezone, now) + 1000 : undefined;
  }
  let soonest: number | undefined;
  for (const row of rows) {
    for (const key of ['expires', 'ends', 'onset', 'effective'] as const) {
      const at = typeof row[key] === 'string' ? parseInZone(row[key] as string, def.timezone) : NaN;
      if (Number.isFinite(at) && at > now.getTime()) soonest = Math.min(soonest ?? at, at);
    }
  }
  return soonest === undefined ? undefined : soonest - now.getTime() + 1000;
}

export function capToDataSet(def: CapDataSource, body: string, now: Date = new Date()): DataSet {
  const trimmed = body.trimStart();
  const alerts = trimmed.startsWith('{') ? parseCapGeoJson(JSON.parse(trimmed)) : parseCapXml(body);
  return { id: def.id, columns: CAP_COLUMNS, rows: conform(capToRows(alerts, def, now), CAP_COLUMNS) };
}

export type { CapSeverity };
