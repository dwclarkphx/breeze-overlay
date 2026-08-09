// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * URL keys — the shared rules for every identifier that ends up in an address.
 *
 * Three key spaces land in the same URL and therefore need the same rules:
 * project id, composition id, and `CompositionLayer.channel`. Three copies of
 * these rules would drift, and the drift would present as a 404 in a truck.
 *
 * Two rules exist on purpose, and the split matters (SCENES.md §6):
 *
 *  - `KEY_PATTERN` below is the *creation* rule — strict, lowercase, capped.
 *    Applied by the factories and the REST routes when something new is made.
 *  - `LEGACY_KEY_PATTERN` is what the JSON Schema validates against. It has to
 *    keep accepting every id already written to disk, and `assertValidProject`
 *    runs on *every* read, so tightening it would make existing projects
 *    unreadable rather than merely un-creatable.
 */

/** Longest chosen prefix we accept. Beyond this the URL is no shorter than the name. */
export const KEY_MAX_LENGTH = 12;

/**
 * Creation rule: lowercase alphanumerics and inner hyphens, 1..KEY_MAX_LENGTH.
 *
 * Must start and end alphanumeric. The trailing-hyphen ban is not cosmetic —
 * `makeId` appends `-<suffix>`, so a prefix ending in a hyphen produces `bug--1a2b`.
 */
export const KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,10}[a-z0-9])?$/;

/**
 * What files on disk are allowed to contain. Identical to the server's
 * `SAFE_ID`: anchored, no `..`, safe as a path segment and as a directory name.
 * Every id generated before this module existed satisfies it.
 */
export const LEGACY_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export class InvalidKeyError extends Error {
  constructor(
    readonly key: string,
    readonly reason: string,
  ) {
    super(`invalid key "${key}": ${reason}`);
    this.name = 'InvalidKeyError';
  }
}

/**
 * Coerce user input into a legal key, or return '' if nothing usable survives.
 *
 * Lowercasing is mandatory rather than cosmetic. A project id is the directory
 * name on disk, and `RAH-B` is the same folder as `rah-b` on Windows and macOS
 * but a different one on Linux — so a project authored on the host and served
 * from the container would be two projects. Normalizing at the single point of
 * creation is the only place that can be fixed once.
 */
export function normalizeKey(raw: string): string {
  const collapsed = raw
    .trim()
    .toLowerCase()
    // Anything that is not a legal character becomes a separator rather than
    // vanishing: "Random A Highschool" should not normalize to one long word.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // Trim to length first, then strip any hyphen the cut exposed at the end.
  return collapsed.slice(0, KEY_MAX_LENGTH).replace(/-+$/, '');
}

/** Throw unless `key` is legal to create. Message names the rule it broke. */
export function assertKey(key: string): void {
  if (key.length === 0) throw new InvalidKeyError(key, 'must not be empty');
  if (key.length > KEY_MAX_LENGTH) {
    throw new InvalidKeyError(key, `must be at most ${KEY_MAX_LENGTH} characters`);
  }
  if (key !== key.toLowerCase()) throw new InvalidKeyError(key, 'must be lowercase');
  if (!KEY_PATTERN.test(key)) {
    throw new InvalidKeyError(
      key,
      'may contain only letters, digits and inner hyphens, and must start and end with a letter or digit',
    );
  }
}

export function isValidKey(key: string): boolean {
  try {
    assertKey(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Suggest a key from a human name — initials of each word.
 *
 * "Random A Highschool - Basketball" → "rahb", not "randomahighsch". Initials
 * are what makes six projects in a folder tellable apart at a glance, which is
 * the entire point of letting anyone choose this; a truncated slug of the full
 * name buys nothing over the generated default.
 *
 * Falls back to a normalized slug for single-word names, where initials would
 * give one useless character.
 */
export function suggestKey(name: string): string {
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  if (words.length === 0) return '';
  if (words.length === 1) return normalizeKey(words[0]!);

  const initials = words.map((w) => w[0]!).join('');
  return normalizeKey(initials);
}
