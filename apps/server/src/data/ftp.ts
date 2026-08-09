// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * FTP / FTPS / SFTP adapter — the league-office results drop.
 *
 * The workflow this exists for: a scorer's laptop writes `results-2026-08-03.csv`
 * into a directory every few minutes, and the graphic should show whatever the
 * newest one says. So the adapter's whole job is *newest file matching a
 * pattern* → a string, and the parsing is then handed to the same functions the
 * HTTP adapters use. That is deliberate: the same results CSV delivered over
 * SFTP and over HTTPS must produce byte-identical DataSets, or a station that
 * changes delivery method rebuilds every graphic for nothing.
 *
 * The SSRF argument from `fetch.ts` applies here with one twist. An FTP drop is
 * *often legitimately* on the venue LAN — that is the normal case, not the
 * attack — so the private-address guard is still enforced but the allowlist is
 * the expected configuration rather than an emergency escape hatch. Refusing by
 * default still matters: the editor accepts a hostname from anyone who can open
 * it, and "point it at 169.254.169.254" must not be one request away.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { Writable } from 'node:stream';

import {
  type DataSet,
  type FtpDataSource,
} from '@breeze/schema';

import { config } from '../config.js';
import { FetchBlockedError, isPrivateAddress } from './fetch.js';
import { csvToDataSet, jsonToDataSet } from './parse.js';
import { feedToDataSet, xmlToDataSet } from './parse-xml.js';

/** Refuse a file large enough to be a mistake rather than a data drop. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;

const DEFAULT_PORTS: Record<FtpDataSource['protocol'], number> = {
  ftp: 21,
  ftps: 21,
  sftp: 22,
};

/* ------------------------------------------------------------ host guard */

function allowlisted(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return config.dataAllowHosts.some((entry) => {
    const e = entry.toLowerCase();
    if (e === host) return true;
    return e.startsWith('.') && host.endsWith(e);
  });
}

/**
 * Vet a host before connecting.
 *
 * Mirrors `assertFetchable`, minus the URL parsing and the redirect handling
 * neither FTP nor SFTP has. Kept as a separate function rather than shared with
 * the HTTP one because the two differ in what they are handed (a host, not a
 * URL) and sharing them would mean a parameter that means "skip half of this".
 */
export async function assertConnectable(host: string): Promise<void> {
  if (!host) throw new FetchBlockedError('no host given');
  if (allowlisted(host)) return;

  const literal = host.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) {
    if (isPrivateAddress(literal)) {
      throw new FetchBlockedError(
        `refusing to connect to a private address (${literal}). A drop box on the venue LAN is normal — add the host to BREEZE_DATA_ALLOW_HOSTS to permit it.`,
      );
    }
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new FetchBlockedError(`cannot resolve host "${host}"`);
  }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new FetchBlockedError(
        `"${host}" resolves to a private address (${address}). Add it to BREEZE_DATA_ALLOW_HOSTS to permit it.`,
      );
    }
  }
}

/* --------------------------------------------------------------- globbing */

/**
 * `results-*.csv` → a RegExp. Supports `*` and `?` only.
 *
 * Hand-written for the same reason as the CSV and XML readers: a glob library
 * is a dependency and a supply-chain surface for eleven lines of escaping, and
 * the full syntax (globstar, braces, extglob, negation) has no meaning against
 * a flat directory listing anyway. Everything outside `*` and `?` is escaped,
 * so a pattern containing a regex metacharacter matches it literally rather
 * than being quietly reinterpreted.
 */
export function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('')
    .map((ch) => {
      if (ch === '*') return '.*';
      if (ch === '?') return '.';
      return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  // Anchored, and case-insensitive: FTP servers on Windows are case-preserving
  // but not case-sensitive, so `RESULTS-1.CSV` is the same file as the pattern
  // an operator typed in lower case.
  return new RegExp(`^${source}$`, 'i');
}

export interface RemoteFile {
  name: string;
  size: number;
  /** Epoch ms. 0 when the server did not report one. */
  modifiedAt: number;
}

/**
 * Newest file matching the pattern, or null.
 *
 * Ties break on name, descending. A drop that writes `results-1.csv` and
 * `results-2.csv` in the same second — which happens, because FTP listings are
 * minute-resolution on plenty of servers — must not pick at random and flip the
 * graphic back and forth between two files on alternate polls.
 */
export function pickNewest(files: RemoteFile[], pattern: string): RemoteFile | null {
  const re = globToRegExp(pattern);
  const matches = files.filter((f) => re.test(f.name));
  if (!matches.length) return null;

  matches.sort((a, b) => {
    if (b.modifiedAt !== a.modifiedAt) return b.modifiedAt - a.modifiedAt;
    return b.name.localeCompare(a.name);
  });
  return matches[0] ?? null;
}

/* ------------------------------------------------------------ credentials */

interface Credential {
  username: string;
  password?: string;
  privateKey?: string;
}

/**
 * A PEM key and a password arrive through the same `secretId`.
 *
 * One secret slot rather than two because the alternative is an `authMode`
 * field that can disagree with the credential actually configured — and the
 * disagreement surfaces as an auth failure at the drop box, in the middle of a
 * show, rather than at configuration time. A PEM header is unambiguous.
 */
export function resolveFtpCredential(def: FtpDataSource): Credential {
  const username = def.username || 'anonymous';
  if (!def.secretId) {
    // Anonymous FTP is a real and common configuration for public drops; the
    // convention is an email address as the password.
    return { username, password: def.username ? '' : 'breeze@overlay.local' };
  }

  const secret = config.dataSecrets[def.secretId];
  if (!secret) {
    throw new Error(
      `secret "${def.secretId}" is not configured on this server (set BREEZE_DATA_SECRETS or BREEZE_DATA_SECRETS_FILE)`,
    );
  }

  if (/^-----BEGIN [\w ]*PRIVATE KEY-----/.test(secret.trim())) {
    if (def.protocol !== 'sftp') {
      throw new Error(
        `secret "${def.secretId}" is a private key, which only sftp can use — this source is ${def.protocol}`,
      );
    }
    return { username, privateKey: secret };
  }

  return { username, password: secret };
}

/* --------------------------------------------------------------- transfer */

/**
 * Remote directory + pattern → file contents.
 *
 * Split from the parsing below so the editor's "test this source" preview can
 * report *which file* it chose, which is most of the diagnosis when a drop box
 * has the right data under the wrong name.
 */
export async function fetchRemoteFile(
  def: FtpDataSource,
): Promise<{ name: string; body: string }> {
  await assertConnectable(def.host);
  const port = def.port ?? DEFAULT_PORTS[def.protocol];
  const dir = def.path || '.';
  const credential = resolveFtpCredential(def);

  return def.protocol === 'sftp'
    ? sftpFetch(def, dir, port, credential)
    : ftpFetch(def, dir, port, credential);
}

async function ftpFetch(
  def: FtpDataSource,
  dir: string,
  port: number,
  credential: Credential,
): Promise<{ name: string; body: string }> {
  const { Client } = await import('basic-ftp');
  const client = new Client(CONNECT_TIMEOUT_MS);

  try {
    await client.access({
      host: def.host,
      port,
      user: credential.username,
      password: credential.password ?? '',
      // `ftps` here means explicit AUTH TLS on the control channel, which is
      // what virtually every modern server speaks. Implicit FTPS (port 990) is
      // deprecated and not offered.
      secure: def.protocol === 'ftps',
    });

    const listing = await client.list(dir);
    const files: RemoteFile[] = listing
      .filter((entry) => entry.isFile)
      .map((entry) => ({
        name: entry.name,
        size: entry.size,
        modifiedAt: entry.modifiedAt ? entry.modifiedAt.getTime() : 0,
      }));

    const chosen = pickNewest(files, def.pattern);
    if (!chosen) {
      throw new Error(`no file in "${dir}" matches "${def.pattern}" (${files.length} file(s) listed)`);
    }
    if (chosen.size > MAX_FILE_BYTES) {
      throw new Error(`"${chosen.name}" is ${chosen.size} bytes, over the ${MAX_FILE_BYTES} limit`);
    }

    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        chunks.push(chunk);
        done();
      },
    });
    await client.downloadTo(sink, joinRemote(dir, chosen.name));

    return { name: chosen.name, body: Buffer.concat(chunks).toString('utf8') };
  } finally {
    client.close();
  }
}

async function sftpFetch(
  def: FtpDataSource,
  dir: string,
  port: number,
  credential: Credential,
): Promise<{ name: string; body: string }> {
  const { default: SftpClient } = await import('ssh2-sftp-client');
  const client = new SftpClient();

  try {
    await client.connect({
      host: def.host,
      port,
      username: credential.username,
      ...(credential.password ? { password: credential.password } : {}),
      ...(credential.privateKey ? { privateKey: credential.privateKey } : {}),
      readyTimeout: CONNECT_TIMEOUT_MS,
    });

    const listing = await client.list(dir);
    const files: RemoteFile[] = listing
      .filter((entry) => entry.type === '-')
      .map((entry) => ({
        name: entry.name,
        size: entry.size,
        // ssh2-sftp-client reports mtime in ms already, unlike the seconds the
        // SFTP protocol carries — normalising here so `pickNewest` compares
        // like with like against the FTP path above.
        modifiedAt: entry.modifyTime,
      }));

    const chosen = pickNewest(files, def.pattern);
    if (!chosen) {
      throw new Error(`no file in "${dir}" matches "${def.pattern}" (${files.length} file(s) listed)`);
    }
    if (chosen.size > MAX_FILE_BYTES) {
      throw new Error(`"${chosen.name}" is ${chosen.size} bytes, over the ${MAX_FILE_BYTES} limit`);
    }

    const buffer = (await client.get(joinRemote(dir, chosen.name))) as Buffer;
    return { name: chosen.name, body: buffer.toString('utf8') };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Remote paths are POSIX regardless of what this server runs on.
 *
 * `path.join` on Windows produces `drop\results.csv`, which an FTP server reads
 * as a filename containing a backslash rather than a path — and this server is
 * routinely on Windows, next to vMix.
 */
function joinRemote(dir: string, name: string): string {
  if (!dir || dir === '.') return name;
  return path.posix.join(dir.replace(/\\/g, '/'), name);
}

/* ---------------------------------------------------------------- parsing */

/** Body → DataSet, using the same parsers the HTTP adapters use. */
export function parseFtpBody(def: FtpDataSource, body: string): DataSet {
  switch (def.format) {
    case 'csv':
      return csvToDataSet(def.id, body, {
        ...(def.delimiter ? { delimiter: def.delimiter } : {}),
        ...(def.header !== undefined ? { header: def.header } : {}),
        ...(def.columns ? { columns: def.columns } : {}),
      });
    case 'json':
      return jsonToDataSet(def.id, JSON.parse(body), {
        ...(def.rowPath !== undefined ? { rowPath: def.rowPath } : {}),
        ...(def.columns ? { columns: def.columns } : {}),
      });
    case 'rss':
      return feedToDataSet(def.id, body, {
        ...(def.columns ? { columns: def.columns } : {}),
      });
    case 'xml':
      return xmlToDataSet(def.id, body, {
        ...(def.rowPath !== undefined ? { rowPath: def.rowPath } : {}),
        ...(def.columns ? { columns: def.columns } : {}),
      });
    default: {
      const exhaustive: never = def.format;
      throw new Error(`unknown ftp format ${JSON.stringify(exhaustive)}`);
    }
  }
}

export async function ftpToDataSet(def: FtpDataSource): Promise<DataSet> {
  const { body } = await fetchRemoteFile(def);
  return parseFtpBody(def, body);
}
