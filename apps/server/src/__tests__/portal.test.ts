// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * The portal, the status report and the guide page.
 *
 * The portal is a string builder, so it is tested as one — no DOM, no browser.
 * What is worth asserting is the part that is easy to break silently: that
 * every scene gets all three of its links, that the ids in them are escaped and
 * encoded, and that the tile markup the status script hooks into is present
 * under the attribute names the script looks for. A renamed `data-channel`
 * breaks the viewer badges without breaking a single link, which is exactly the
 * kind of failure nobody notices until a show.
 */

import { describe, expect, it } from 'vitest';

import { ControlHub } from '../hub.js';
import { docsPage, portalPage } from '../pages.js';
import { StatusSampler } from '../status.js';

const DEMO = [
  {
    id: 'hawks-1k3f9',
    name: 'Riverside Hawks',
    compositions: [
      { id: 'lower-third', name: 'Lower third' },
      { id: 'ticker', name: 'News ticker' },
    ],
  },
];

describe('portalPage', () => {
  it('gives every scene a control, output and debug link', () => {
    const html = portalPage(DEMO, '0.61.0');

    for (const comp of ['lower-third', 'ticker']) {
      expect(html).toContain(`/control/hawks-1k3f9/${comp}"`);
      expect(html).toContain(`/play/hawks-1k3f9/${comp}"`);
      expect(html).toContain(`/play/hawks-1k3f9/${comp}?scale=contain&amp;debug=1"`);
    }
  });

  it('opens the editor and the guide in new tabs, as pills', () => {
    const html = portalPage(DEMO);
    expect(html).toMatch(/<a class="pill primary" href="\/editor\/" target="_blank"/);
    expect(html).toMatch(/<a class="pill" href="\/docs" target="_blank"/);
  });

  it('links the activity log in the same tab', () => {
    // Not `target="_blank"`: unlike the editor and the guide, this is somewhere
    // you go to look something up and then come back from.
    expect(portalPage(DEMO)).toContain('<a class="pill" href="/activity">Activity</a>');
  });

  it('renders one tile per project, carrying the id the status poll keys on', () => {
    const html = portalPage(DEMO);
    expect(html).toContain('<details class="tile" data-project="hawks-1k3f9">');
    expect(html).toContain('data-channel="hawks-1k3f9/lower-third"');
    expect(html).toContain('data-channel="hawks-1k3f9/ticker"');
    // The badge slots the script fills. Hidden until a poll says otherwise —
    // an empty badge would read as "zero viewers" rather than "not yet known".
    expect(html).toContain('data-role="viewers" hidden');
    expect(html).toContain('data-role="project-viewers" hidden');
  });

  it('keeps the full project name available when the tile truncates it', () => {
    // Tiles are a fixed height so the grid stays even, which means a long name
    // is ellipsised. The `title` is the only way back to the whole thing.
    const html = portalPage([
      { ...DEMO[0]!, name: 'World Cup 2026 Tournament Scene' },
    ]);
    expect(html).toContain('title="World Cup 2026 Tournament Scene"');
  });

  it('counts scenes, and says so in the singular when there is one', () => {
    expect(portalPage(DEMO)).toContain('2 scenes');
    expect(portalPage([{ ...DEMO[0]!, compositions: [{ id: 'a', name: 'A' }] }])).toContain(
      '1 scene<',
    );
  });

  it('points an empty install at the editor rather than at curl', () => {
    const html = portalPage([]);
    expect(html).toContain('No projects yet');
    // The old copy told operators to POST to the API. There is a button now.
    expect(html).not.toContain('POST /api/projects');
  });

  it('escapes names and encodes ids into URLs', () => {
    const html = portalPage([
      {
        id: 'a b',
        name: '<script>alert(1)</script>',
        compositions: [{ id: 'c/d', name: 'Ampersand & co' }],
      },
    ]);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Ampersand &amp; co');
    expect(html).toContain('/control/a%20b/c%2Fd');
  });

  it('loads the status script', () => {
    expect(portalPage(DEMO)).toContain('<script src="/public/portal.js"></script>');
  });
});

describe('docsPage', () => {
  it('wraps rendered markdown and links back to the portal', () => {
    const html = docsPage('<h1>Guide</h1><p>Body.</p>');
    expect(html).toContain('<h1>Guide</h1>');
    expect(html).toContain('href="/"');
    expect(html).toContain('User guide — Breeze Overlay');
  });
});

describe('StatusSampler', () => {
  it('reports nothing connected on an idle hub', () => {
    const report = new StatusSampler().report(new ControlHub(), '0.61.0');

    expect(report.version).toBe('0.61.0');
    expect(report.viewers.renderers).toBe(0);
    expect(report.viewers.controllers).toBe(0);
    expect(report.viewers.channels).toEqual([]);
    expect(report.cpu.cores).toBeGreaterThan(0);
    expect(report.memory.rss).toBeGreaterThan(0);
  });

  it('counts renderers and controllers per channel, and splits the channel key', () => {
    const hub = new ControlHub();
    hub.addClient('r1', () => {});
    hub.addClient('r2', () => {});
    hub.addClient('c1', () => {});
    hub.handle('r1', { type: 'subscribe', channel: 'proj/lower-third', role: 'renderer' });
    hub.handle('r2', { type: 'subscribe', channel: 'proj/lower-third', role: 'renderer' });
    hub.handle('c1', { type: 'subscribe', channel: 'proj/lower-third', role: 'controller' });

    const report = new StatusSampler().report(hub, '0.61.0');

    expect(report.viewers.renderers).toBe(2);
    expect(report.viewers.controllers).toBe(1);
    expect(report.viewers.channels).toEqual([
      {
        channel: 'proj/lower-third',
        projectId: 'proj',
        compositionId: 'lower-third',
        renderers: 2,
        controllers: 1,
      },
    ]);
  });

  it('drops channels everyone has left', () => {
    const hub = new ControlHub();
    hub.addClient('r1', () => {});
    hub.handle('r1', { type: 'subscribe', channel: 'proj/ticker', role: 'renderer' });
    hub.removeClient('r1');

    const report = new StatusSampler().report(hub, '0.61.0');

    // The channel still exists in the hub — it retains state for a reconnect —
    // but a browser source that was closed is not a viewer, and the strip must
    // not keep claiming it is.
    expect(hub.activeChannels).toContain('proj/ticker');
    expect(report.viewers.channels).toEqual([]);
    expect(report.viewers.renderers).toBe(0);
  });

  it('reports CPU as a percentage of one core, not of the machine', () => {
    const sampler = new StatusSampler();
    sampler.report(new ControlHub(), '0.61.0');

    // Burn a measurable slice so the second sample has something to divide.
    const until = Date.now() + 30;
    while (Date.now() < until) { /* spin */ }

    const report = sampler.report(new ControlHub(), '0.61.0');
    expect(report.cpu.percent).toBeGreaterThan(0);
    // A busy loop on one thread cannot exceed one core by much; a figure in the
    // thousands would mean the interval, not the usage, is being measured wrong.
    expect(report.cpu.percent).toBeLessThan(200);
  });
});
