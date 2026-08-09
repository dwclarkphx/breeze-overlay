// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * FTP / SFTP adapter — the parts that do not need a server.
 *
 * The transfer itself is not unit-tested: mocking `basic-ftp` and
 * `ssh2-sftp-client` would test the mock, and the failures that actually happen
 * (a listing format the parser mis-reads, a passive-mode timeout, a server that
 * reports minute-resolution mtimes) are precisely the ones a mock cannot
 * reproduce. What is tested here is everything that decides *which file* and
 * *which credential* — the logic that turns a directory into a DataSet, and the
 * guard that decides whether to connect at all.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FtpDataSource } from '@breeze/schema';

import { config } from '../config.js';
import { FetchBlockedError } from '../data/fetch.js';
import {
  assertConnectable,
  globToRegExp,
  parseFtpBody,
  pickNewest,
  resolveFtpCredential,
  type RemoteFile,
} from '../data/ftp.js';

const def: FtpDataSource = {
  id: 'drop',
  name: 'Results drop',
  type: 'ftp',
  protocol: 'sftp',
  host: 'drop.example.com',
  path: '/results',
  pattern: 'results-*.csv',
  format: 'csv',
};

const file = (name: string, modifiedAt: number, size = 100): RemoteFile => ({
  name,
  size,
  modifiedAt,
});

describe('glob matching', () => {
  it('matches a wildcard against the usual drop names', () => {
    const re = globToRegExp('results-*.csv');
    expect(re.test('results-2026-08-03.csv')).toBe(true);
    expect(re.test('results-.csv')).toBe(true);
    expect(re.test('results-2026-08-03.xml')).toBe(false);
    expect(re.test('old-results-1.csv')).toBe(false);
  });

  it('anchors, so a pattern is not a substring search', () => {
    expect(globToRegExp('*.csv').test('a.csv.bak')).toBe(false);
  });

  it('treats regex metacharacters in a pattern as literals', () => {
    // `results.csv` must not match `resultsXcsv` — the dot is a filename dot,
    // not "any character", and a glob that quietly became a regex would pick up
    // the wrong file without ever erroring.
    const re = globToRegExp('results.csv');
    expect(re.test('results.csv')).toBe(true);
    expect(re.test('resultsXcsv')).toBe(false);
    expect(globToRegExp('game(1).csv').test('game(1).csv')).toBe(true);
  });

  it('supports ? as a single character', () => {
    const re = globToRegExp('week-??.csv');
    expect(re.test('week-01.csv')).toBe(true);
    expect(re.test('week-1.csv')).toBe(false);
  });

  it('ignores case, because half of these servers run on Windows', () => {
    expect(globToRegExp('results-*.csv').test('RESULTS-01.CSV')).toBe(true);
  });
});

describe('choosing a file', () => {
  it('takes the newest match and ignores non-matches entirely', () => {
    const chosen = pickNewest(
      [
        file('results-01.csv', 1000),
        file('standings.csv', 9999),
        file('results-02.csv', 2000),
      ],
      'results-*.csv',
    );
    expect(chosen?.name).toBe('results-02.csv');
  });

  it('breaks an mtime tie on name, descending', () => {
    /*
     * Plenty of FTP servers report minute-resolution timestamps, so two files
     * written seconds apart tie. Without a deterministic tiebreak the poller
     * picks whichever the server happened to list first, and the graphic flips
     * between two files on alternate polls.
     */
    const files = [file('results-01.csv', 1000), file('results-02.csv', 1000)];
    expect(pickNewest(files, 'results-*.csv')?.name).toBe('results-02.csv');
    expect(pickNewest([...files].reverse(), 'results-*.csv')?.name).toBe('results-02.csv');
  });

  it('returns null rather than throwing when nothing matches', () => {
    expect(pickNewest([file('standings.csv', 1)], 'results-*.csv')).toBeNull();
    expect(pickNewest([], '*.csv')).toBeNull();
  });

  it('does not treat a missing mtime as newest', () => {
    // A server that reports no date gives 0, which must lose to a real one.
    const chosen = pickNewest([file('results-a.csv', 0), file('results-b.csv', 500)], 'results-*.csv');
    expect(chosen?.name).toBe('results-b.csv');
  });
});

describe('credentials', () => {
  const original = { ...config.dataSecrets };
  beforeEach(() => {
    for (const key of Object.keys(config.dataSecrets)) delete config.dataSecrets[key];
  });
  afterEach(() => {
    for (const key of Object.keys(config.dataSecrets)) delete config.dataSecrets[key];
    Object.assign(config.dataSecrets, original);
  });

  it('defaults to anonymous with an email-shaped password', () => {
    const credential = resolveFtpCredential({ ...def, protocol: 'ftp' });
    expect(credential.username).toBe('anonymous');
    expect(credential.password).toContain('@');
  });

  it('refuses a named secret that is not configured, rather than trying anonymously', () => {
    expect(() => resolveFtpCredential({ ...def, secretId: 'missing' })).toThrow(/not configured/);
  });

  it('reads a PEM secret as a key and anything else as a password', () => {
    config.dataSecrets['pw'] = 'hunter2';
    config.dataSecrets['key'] = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';

    expect(resolveFtpCredential({ ...def, secretId: 'pw' }).password).toBe('hunter2');
    const keyed = resolveFtpCredential({ ...def, secretId: 'key' });
    expect(keyed.privateKey).toBeTruthy();
    expect(keyed.password).toBeUndefined();
  });

  it('refuses a private key on a protocol that cannot use one', () => {
    // Left to itself, ssh2's key would be handed to basic-ftp as a password and
    // fail as a login error at the drop box, mid-show.
    config.dataSecrets['key'] = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
    expect(() => resolveFtpCredential({ ...def, protocol: 'ftp', secretId: 'key' })).toThrow(
      /only sftp/,
    );
  });
});

describe('host guard', () => {
  const original = [...config.dataAllowHosts];
  afterEach(() => {
    config.dataAllowHosts.length = 0;
    config.dataAllowHosts.push(...original);
  });

  it('refuses a private literal by default', async () => {
    config.dataAllowHosts.length = 0;
    await expect(assertConnectable('192.168.1.50')).rejects.toBeInstanceOf(FetchBlockedError);
    await expect(assertConnectable('127.0.0.1')).rejects.toThrow(/private address/);
    // The one that actually gets exploited.
    await expect(assertConnectable('169.254.169.254')).rejects.toThrow(/private address/);
  });

  it('permits a private host once allowlisted — the normal venue-LAN case', async () => {
    config.dataAllowHosts.length = 0;
    config.dataAllowHosts.push('192.168.1.50');
    await expect(assertConnectable('192.168.1.50')).resolves.toBeUndefined();
  });

  it('says how to allow it, because a LAN drop box is the expected setup', async () => {
    config.dataAllowHosts.length = 0;
    await expect(assertConnectable('10.0.0.5')).rejects.toThrow(/BREEZE_DATA_ALLOW_HOSTS/);
  });

  it('refuses an empty host rather than resolving one', async () => {
    await expect(assertConnectable('')).rejects.toBeInstanceOf(FetchBlockedError);
  });
});

describe('parsing', () => {
  it('gives the same DataSet a HTTP CSV source would', () => {
    // This is the whole reason the adapter owns no parser of its own: a station
    // that moves a feed from HTTPS to SFTP must not rebuild its graphics.
    const data = parseFtpBody(def, 'team,w,l\nSuns,42,18\nHeat,40,20\n');
    expect(data.columns.map((c) => c.key)).toEqual(['team', 'w', 'l']);
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0]).toMatchObject({ team: 'Suns', w: 42 });
  });

  it('honours the row path for JSON', () => {
    const data = parseFtpBody(
      { ...def, format: 'json', rowPath: 'payload.teams' },
      JSON.stringify({ payload: { teams: [{ team: 'Suns' }] } }),
    );
    expect(data.rows).toHaveLength(1);
  });

  it('reads XML through the same reader the HTTP adapter uses', () => {
    const data = parseFtpBody(
      { ...def, format: 'xml', rowPath: 'results/game' },
      '<results><game><home>Suns</home></game><game><home>Heat</home></game></results>',
    );
    expect(data.rows).toHaveLength(2);
  });
});
