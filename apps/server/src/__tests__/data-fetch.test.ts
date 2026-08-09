// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The SSRF guard.
 *
 * This server accepts a URL from anyone who can open the editor and runs on the
 * same LAN as the switcher, the router and whatever else the venue has on a
 * private address. Every case below is a way to reach one of those through a URL
 * that does not look private.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { config } from '../config.js';
import {
  FALLBACK_USER_AGENT,
  PRODUCT_TOKEN,
  assertFetchable,
  isPrivateAddress,
  userAgent,
} from '../data/fetch.js';
import { APP_VERSION } from '../version.js';

describe('userAgent', () => {
  const original = config.contact;
  afterEach(() => {
    config.contact = original;
  });

  /*
   * Asserted against APP_VERSION, not a literal. A literal is what put
   * `BreezeOverlay/1.0` on the wire for the whole of the 0.4x and 0.5x lines:
   * the string was pinned in the test as firmly as in the source, so the two
   * agreed with each other and with nothing else.
   */
  it('names the running version, not a hardcoded one', () => {
    expect(PRODUCT_TOKEN).toBe(`BreezeOverlay/${APP_VERSION}`);
    expect(FALLBACK_USER_AGENT.startsWith(`${PRODUCT_TOKEN} (`)).toBe(true);
  });

  it('falls back to the shared string when nobody has said who this is', () => {
    config.contact = '';
    expect(userAgent()).toBe(FALLBACK_USER_AGENT);
    expect(userAgent('   ')).toBe(FALLBACK_USER_AGENT);
  });

  it('names the operator alongside the product', () => {
    config.contact = '';
    expect(userAgent('mystation.com, ops@mystation.com')).toBe(
      `${PRODUCT_TOKEN} (mystation.com, ops@mystation.com)`,
    );
  });

  it('does not nest brackets when the contact is copied from NWS docs verbatim', () => {
    /*
     * api.weather.gov documents the value as `(myweatherapp.com, contact@…)`,
     * brackets included. An operator pasting that example is doing the
     * reasonable thing and must not end up sending `((…))`.
     */
    config.contact = '';
    expect(userAgent('(myweatherapp.com, contact@myweatherapp.com)')).toBe(
      `${PRODUCT_TOKEN} (myweatherapp.com, contact@myweatherapp.com)`,
    );
  });

  it('prefers the per-source contact over the server-wide one', () => {
    config.contact = 'server.example, ops@server.example';
    expect(userAgent('source.example, a@source.example')).toContain('source.example');
    expect(userAgent()).toContain('server.example');
  });

  it('falls back to the server contact when the source does not set one', () => {
    // The normal deployment: BREEZE_CONTACT once, every source inherits it.
    config.contact = 'server.example, ops@server.example';
    expect(userAgent(undefined)).toBe(`${PRODUCT_TOKEN} (server.example, ops@server.example)`);
    expect(userAgent('')).toBe(`${PRODUCT_TOKEN} (server.example, ops@server.example)`);
  });

  it('does not emit an empty bracket pair for a contact that is only brackets', () => {
    config.contact = '';
    expect(userAgent('()')).toBe(FALLBACK_USER_AGENT);
  });
});

describe('isPrivateAddress', () => {
  it('refuses loopback and the RFC 1918 blocks', () => {
    for (const addr of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1']) {
      expect(isPrivateAddress(addr), addr).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const addr of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34']) {
      expect(isPrivateAddress(addr), addr).toBe(false);
    }
  });

  it('refuses link-local, which is where cloud instance metadata lives', () => {
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
  });

  it('refuses carrier-grade NAT and multicast', () => {
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('224.0.0.1')).toBe(true);
  });

  it('refuses IPv6 loopback and unique/link-local', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });

  it('sees through IPv4-mapped IPv6', () => {
    // `::ffff:10.0.0.1` reaches a private host through an address that does not
    // look private — the easiest of these to miss.
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('does not trust an address it cannot parse', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('assertFetchable', () => {
  it('rejects non-HTTP schemes', async () => {
    // `file:///etc/passwd` is the other classic, and it never reaches DNS.
    await expect(assertFetchable('file:///etc/passwd')).rejects.toThrow(/unsupported protocol/);
    await expect(assertFetchable('gopher://x/1')).rejects.toThrow(/unsupported protocol/);
  });

  it('rejects a literal private address without a lookup', async () => {
    await expect(assertFetchable('http://192.168.0.1/admin')).rejects.toThrow(/private address/);
    await expect(assertFetchable('http://[::1]:7331/')).rejects.toThrow(/private address/);
  });

  it('rejects a malformed URL', async () => {
    await expect(assertFetchable('not a url')).rejects.toThrow(/valid URL/);
  });

  it('accepts a public literal address', async () => {
    const url = await assertFetchable('https://8.8.8.8/data.json');
    expect(url.hostname).toBe('8.8.8.8');
  });
});
