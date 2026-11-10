// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * The Data sources page (0.80.0) in a real browser.
 *
 * The server tests drive every route with `app.inject` and never load the
 * page. This is the half they cannot see: that the portal's button reaches a
 * page that renders, that **+ Add** walks from the list of kinds into the
 * editor's own form and saves, that a link made in a project shows up against
 * the source, and that the editor's data panel offers the source back.
 *
 * The feed's address does not resolve, on purpose. The suite runs with no
 * network to count on, and a source that fails is still a source the page has
 * to list, name the failure of, and hold the Refresh of.
 */

const DEMO = 'demo-1iixd';
const FEED = 'https://feed.invalid/scores.json';
const SOURCE_NAME = 'E2E league scores';

/** The server-level source the test made, by the name it gave it. */
async function sourceId(request: APIRequestContext): Promise<string | undefined> {
  const all = (await (await request.get('/api/sources')).json()) as {
    server: Array<{ def: { id: string; name: string } }>;
  };
  return all.server.find((s) => s.def.name === SOURCE_NAME)?.def.id;
}

// Whatever a failed run left: a link in the demo, then the source. A leaked
// source would be listed on the page for every later run of this file.
test.afterAll(async ({ request }) => {
  const id = await sourceId(request);
  if (!id) return;
  await request.delete(`/api/projects/${DEMO}/datasources/e2e-link`);
  await request.delete(`/api/server/datasources/${id}`);
});

test('a source is added from the portal, linked into a project, and offered in the editor', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // The portal's button, beside Connections.
  await page.goto('/');
  await page.getByRole('link', { name: 'Data sources' }).click();
  await expect(page).toHaveURL(/\/editor\/\?view=sources$/);
  await expect(page.getByRole('heading', { name: 'Data sources', level: 1 })).toBeVisible();

  // Add: the kinds first, then the form, in one window.
  await page.getByRole('button', { name: '+ Add data source' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: /^Weather/ })).toBeVisible();
  // Only fetched kinds are offered here.
  await expect(dialog.getByRole('button', { name: /^Manual table/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: /^HTTP JSON/ }).click();

  await dialog.getByLabel('Name').fill(SOURCE_NAME);
  await dialog.getByLabel('URL').fill(FEED);
  await dialog.getByRole('button', { name: 'Save source' }).click();
  await expect(dialog).toHaveCount(0);

  // Listed, with what went wrong and nothing linked to it yet.
  const row = page.locator('tr', { hasText: SOURCE_NAME });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Not linked yet');
  await expect(row).toContainText('Failing');
  await expect(row).toContainText('Never synced');
  // Saved a moment ago, so a Refresh is held to the source's floor.
  await expect(row.getByRole('button', { name: /^Refresh in / })).toBeDisabled();
  await expect(row.getByRole('button', { name: 'Delete' })).toBeEnabled();

  // A project links it; the page says which, and will not delete it.
  const id = await sourceId(page.request);
  expect(id).toBeTruthy();
  const linked = await page.request.put(`/api/projects/${DEMO}/datasources/e2e-link`, {
    data: { id: 'e2e-link', name: 'Linked scores', type: 'link', source: id },
  });
  expect(linked.ok()).toBe(true);
  await expect(row).toContainText('Breeze Demo', { timeout: 10_000 });
  await expect(row.getByRole('button', { name: 'Delete' })).toBeDisabled();

  // The floor passes and Refresh comes back.
  await expect(row.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled({ timeout: 15_000 });

  // The editor shows the link as what it links to, and offers the source in its picker.
  await page.goto('/editor/');
  const panelRow = page.locator('.source-row', { hasText: 'Linked scores' });
  await expect(panelRow).toContainText('Linked · HTTP JSON');
  await expect(panelRow.getByRole('button', { name: 'Unlink' })).toBeVisible();

  await page
    .locator('select', { has: page.locator('option', { hasText: 'Link a server source' }) })
    .selectOption({ label: 'Link a server source…' });
  const picker = page.getByRole('dialog');
  await expect(picker.locator('.source-row', { hasText: SOURCE_NAME })).toContainText('Already linked in this project');
  await picker.getByRole('button', { name: 'Cancel' }).click();

  // Unlinked, it can be deleted again.
  page.once('dialog', (d) => void d.accept());
  await panelRow.getByRole('button', { name: 'Unlink' }).click();
  await expect(panelRow).toHaveCount(0);
  const gone = await page.request.delete(`/api/server/datasources/${id}`);
  expect(gone.status()).toBe(204);

  expect(errors).toEqual([]);
});
