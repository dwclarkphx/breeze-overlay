// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MPL-2.0

/**
 * OGraf interop (Phase 9 Wave D) against the real app and hub: the Server API
 * facade (D1), with fake sockets standing in for output pages that answer as
 * a runtime would, and the pointer package (D2).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { transformSync } from 'esbuild';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-ograf-'));
process.env['BREEZE_DATA_DIR'] = tmpDir;
process.env['BREEZE_LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../app.js');
const { unzipSync } = await import('fflate');
const { pointerModule, serverOrigin } = await import('../ograf-package.js');
type Hub = import('../hub.js').ControlHub;
type ServerMessage = import('../hub.js').ServerMessage;
type ControlCommand = import('../hub.js').ControlCommand;

const P = 'demo-1iixd';
const LT = 'l3rd-name-2a94g';
const BUG = 'badge-3j8xr';
const LT_ID = `${P}~${LT}`;
const BASE = '/ograf/v1';

let app: FastifyInstance;
let hub: Hub;

beforeAll(async () => {
  app = await buildApp();
  hub = (app as unknown as { hub: Hub }).hub;
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

let nextId = 0;
const sockets: Array<() => void> = [];
beforeEach(() => {
  for (const close of sockets.splice(0)) close();
});

/**
 * A fake output page. It answers commands the way a runtime with one hold
 * would, reporting back to the hub — what the facade waits for.
 */
function output(channel: string, opts: { answer?: boolean } = {}) {
  const id = `ograf-test-${nextId++}`;
  const received: ServerMessage[] = [];
  let step = 0;
  const report = (state: string) => hub.handle(id, { type: 'state', playback: { state, time: 0, step, stepCount: 1 } });
  hub.addClient(id, (m) => {
    received.push(m);
    if (opts.answer === false || m.type !== 'command') return;
    const c = m.command;
    // Answered on the next tick, as a page would after its socket round trip.
    setTimeout(() => {
      if (c.verb === 'step') {
        step = c.step ?? 0;
        report(c.cut ? 'holding' : 'playing-in');
        if (!c.cut) setTimeout(() => report('holding'), 30);
      } else if (c.verb === 'stop') {
        if (c.cut) {
          step = 0;
          report('idle');
        } else {
          report('playing-out');
          setTimeout(() => report('finished'), 30);
        }
      } else if (c.verb === 'clear') {
        step = 0;
        report('idle');
      }
    }, 5);
  });
  hub.handle(id, { type: 'subscribe', channel, role: 'renderer' });
  // A page reports as soon as it is welcomed.
  if (opts.answer !== false) report('idle');
  const close = () => hub.removeClient(id);
  sockets.push(close);
  return {
    commands: (): ControlCommand[] =>
      received
        .filter((m) => m.type === 'command')
        .map((m) => (m as { command: ControlCommand }).command)
        .filter((c) => c.source !== 'datasource'),
    close,
  };
}

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url: `${BASE}${url}`, payload: payload as object });
const ltTarget = { channel: LT };

describe('the server', () => {
  it('says what it is, in a way the OGraf DevTool recognises', async () => {
    const res = await app.inject({ method: 'GET', url: BASE });
    expect(res.statusCode).toBe(200);
    expect(res.json().name.toLowerCase()).toContain('ograf');
    expect((await app.inject({ method: 'GET', url: `${BASE}/` })).statusCode).toBe(200);
  });

  it('is open to a browser-based controller on another origin', async () => {
    const res = await app.inject({ method: 'GET', url: `${BASE}/graphics`, headers: { origin: 'http://spx.local' } });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const pre = await app.inject({ method: 'OPTIONS', url: `${BASE}/renderers/${P}/target/graphicInstance/load` });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-methods']).toContain('POST');
    expect(pre.headers['access-control-allow-headers']).toContain('Authorization');
  });
});

describe('graphics', () => {
  it('lists every composition as <project>~<composition>', async () => {
    const { graphics } = (await app.inject({ method: 'GET', url: `${BASE}/graphics` })).json() as {
      graphics: Array<{ id: string; name: string }>;
    };
    expect(graphics).toContainEqual(expect.objectContaining({ id: LT_ID, name: 'Lower Third — Name' }));
  });

  it('serves a graphic’s manifest, pointing at the address it was asked on, and where its files are', async () => {
    const res = await app.inject({ method: 'GET', url: `${BASE}/graphics/${encodeURIComponent(LT_ID)}`, headers: { host: '10.0.0.5:7331' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.graphic).toMatchObject({ id: LT_ID, main: 'graphic.mjs', stepCount: 1, v_breeze: { server: 'http://10.0.0.5:7331' } });
    expect(body.metadata.content).toEqual({
      url: `/ograf/package/${encodeURIComponent(LT_ID)}/`,
      files: [{ path: `${LT}.ograf.json` }, { path: 'graphic.mjs' }],
    });
  });

  it('answers an unknown graphic with a problem, and refuses to delete one', async () => {
    const missing = await app.inject({ method: 'GET', url: `${BASE}/graphics/${P}~nope` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ status: 404, title: 'Not Found', detail: expect.stringContaining('nope') });
    expect((await app.inject({ method: 'GET', url: `${BASE}/graphics/not-ours` })).statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `${BASE}/graphics/${LT_ID}` });
    expect(del.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `${BASE}/graphics/${LT_ID}/thumbnail?file=x.png` })).statusCode).toBe(404);
  });
});

describe('renderers', () => {
  it('lists each project as a renderer', async () => {
    const { renderers } = (await app.inject({ method: 'GET', url: `${BASE}/renderers` })).json() as { renderers: Array<{ id: string }> };
    expect(renderers.map((r) => r.id)).toContain(P);
  });

  it('describes its targets — every channel, as a GDD select — and warns with no output connected', async () => {
    const { renderer } = (await app.inject({ method: 'GET', url: `${BASE}/renderers/${P}` })).json();
    const channel = renderer.renderTargetSchema.properties.channel;
    expect(channel).toMatchObject({ type: 'string', gddType: 'select' });
    expect(channel.enum).toContain(LT);
    expect(channel.gddOptions.labels[LT]).toBe('Lower Third — Name');
    expect(renderer.status.status).toBe('WARNING');
    const lt = renderer.renderTargets.find((t: { renderTarget: { channel: string } }) => t.renderTarget.channel === LT);
    expect(lt.graphicInstances).toEqual([{ graphicInstanceId: LT, graphic: { id: LT_ID, name: 'Lower Third — Name' } }]);
    expect(renderer.customActions.map((a: { id: string }) => a.id)).toEqual(['mode']);
  });

  it('says OK once an output page is connected', async () => {
    output(`${P}/${LT}`);
    const { renderer } = (await app.inject({ method: 'GET', url: `${BASE}/renderers/${P}` })).json();
    expect(renderer.status.status).toBe('OK');
  });

  it('reads one target from a JSON-stringified query, and 404s an unknown one', async () => {
    const res = await app.inject({ method: 'GET', url: `${BASE}/renderers/${P}/target?renderTarget=${encodeURIComponent(JSON.stringify(ltTarget))}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ renderTarget: ltTarget, name: 'Lower Third — Name' });
    const bad = await app.inject({ method: 'GET', url: `${BASE}/renderers/${P}/target?renderTarget=${encodeURIComponent('{"channel":"nope"}')}` });
    expect(bad.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `${BASE}/renderers/nobody` })).statusCode).toBe(404);
  });
});

describe('a graphic on its own channel', () => {
  it('loads by sending its values as an update, and names the instance after the channel', async () => {
    const out = output(`${P}/${LT}`);
    const res = await post(`/renderers/${P}/target/graphicInstance/load`, {
      renderTarget: ltTarget,
      graphicId: LT_ID,
      params: { data: { name: 'Jane Doe' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ graphicInstanceId: LT, statusCode: 200 });
    expect(out.commands()).toEqual([expect.objectContaining({ verb: 'update', data: { name: 'Jane Doe' }, source: 'ograf' })]);
    // Retained, so an output joining later shows it too.
    expect(hub.state(`${P}/${LT}`).data).toMatchObject({ name: 'Jane Doe' });
  });

  it('refuses another composition on a channel, and a graphic from another renderer', async () => {
    const wrong = await post(`/renderers/${P}/target/graphicInstance/load`, { renderTarget: ltTarget, graphicId: `${P}~${BUG}`, params: { data: {} } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().detail).toContain('@main');
    const elsewhere = await post(`/renderers/${P}/target/graphicInstance/load`, { renderTarget: ltTarget, graphicId: 'other~thing', params: { data: {} } });
    expect(elsewhere.statusCode).toBe(404);
  });

  it('plays to the hold, answering when the output reports it, with the step on air', async () => {
    const out = output(`${P}/${LT}`);
    const res = await post(`/renderers/${P}/target/graphicInstance/playAction`, { renderTarget: ltTarget, graphicInstanceId: LT, params: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ graphicInstanceId: LT, statusCode: 200, currentStep: 0, v_delivered: 1 });
    expect(out.commands()).toEqual([expect.objectContaining({ verb: 'step', step: 1 })]);
    expect(out.commands()[0]!.cut).toBeUndefined();
  });

  it('goes to the end past the last step, and cuts on skipAnimation', async () => {
    const out = output(`${P}/${LT}`);
    await post(`/renderers/${P}/target/graphicInstance/playAction`, { renderTarget: ltTarget, graphicInstanceId: LT, params: { skipAnimation: true } });
    const end = await post(`/renderers/${P}/target/graphicInstance/playAction`, { renderTarget: ltTarget, graphicInstanceId: LT, params: { delta: 1 } });
    expect(end.json().currentStep).toBeUndefined();
    expect(out.commands().map((c) => [c.verb, c.step, c.cut])).toEqual([
      ['step', 1, true],
      ['stop', undefined, undefined],
    ]);
  });

  it('stops — with the outro, or cut as a clear', async () => {
    const out = output(`${P}/${LT}`);
    const stop = await post(`/renderers/${P}/target/graphicInstance/stopAction`, { renderTarget: ltTarget, graphicInstanceId: LT, params: {} });
    expect(stop.json()).toMatchObject({ statusCode: 200, v_delivered: 1 });
    await post(`/renderers/${P}/target/graphicInstance/stopAction`, { renderTarget: ltTarget, graphicInstanceId: LT, params: { skipAnimation: true } });
    expect(out.commands().map((c) => c.verb)).toEqual(['stop', 'clear']);
  });

  it('answers at once with what it sent when no output is there to report', async () => {
    const started = Date.now();
    const res = await post(`/renderers/${P}/target/graphicInstance/playAction`, { renderTarget: ltTarget, graphicInstanceId: LT, params: { goto: 0 } });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(res.json()).toMatchObject({ currentStep: 0, v_delivered: 0 });
  });

  it('updates, and refuses an update with no data', async () => {
    const out = output(`${P}/${LT}`);
    const ok = await post(`/renderers/${P}/target/graphicInstance/updateAction`, { renderTarget: ltTarget, graphicInstanceId: LT, params: { data: { title: 'Elder' } } });
    expect(ok.statusCode).toBe(200);
    expect(out.commands()).toEqual([expect.objectContaining({ verb: 'update', data: { title: 'Elder' } })]);
    const bad = await post(`/renderers/${P}/target/graphicInstance/updateAction`, { renderTarget: ltTarget, graphicInstanceId: LT, params: {} });
    expect(bad.statusCode).toBe(400);
  });

  it('runs the channel’s timers, and refuses what is not a custom action', async () => {
    const res = await post(`/renderers/${P}/target/graphicInstance/customActions/timer`, {
      renderTarget: ltTarget,
      graphicInstanceId: LT,
      params: { payload: { action: 'set', id: 'game', value: 480_000 } },
    });
    expect(res.statusCode).toBe(200);
    expect(hub.timerState(`${P}/${LT}`, 'game')).toBeTruthy();
    const nope = await post(`/renderers/${P}/target/graphicInstance/customActions/shake`, { renderTarget: ltTarget, graphicInstanceId: LT, params: { payload: {} } });
    expect(nope.statusCode).toBe(404);
    const page = await post(`/renderers/${P}/target/graphicInstance/customActions/page`, { renderTarget: ltTarget, graphicInstanceId: LT, params: { payload: {} } });
    expect(page.statusCode).toBe(400);
  });

  it('404s an instance that is not on the target', async () => {
    const res = await post(`/renderers/${P}/target/graphicInstance/playAction`, { renderTarget: ltTarget, graphicInstanceId: BUG, params: {} });
    expect(res.statusCode).toBe(404);
  });
});

describe('a graphic on an output', () => {
  const main = { channel: '@main' };
  const instance = `@main~${LT}`;

  it('mounts on load without playing, and plays through the output so a fresh mount is there first', async () => {
    const page = output(`${P}/@main`, { answer: false });
    const load = await post(`/renderers/${P}/target/graphicInstance/load`, {
      renderTarget: main,
      graphicId: LT_ID,
      params: { data: { name: 'Ann Poe' } },
    });
    expect(load.json()).toMatchObject({ graphicInstanceId: instance, statusCode: 200 });
    // The output page is told what to mount — and nothing to play.
    expect(page.commands()).toEqual([expect.objectContaining({ verb: 'update', data: { $mounts: [expect.objectContaining({ composition: LT })] } })]);
    // The values wait on the mount's own channel for it to subscribe.
    expect(hub.state(`${P}/${instance}`).data).toMatchObject({ name: 'Ann Poe' });

    const { renderer } = (await app.inject({ method: 'GET', url: `${BASE}/renderers/${P}` })).json();
    const target = renderer.renderTargets.find((t: { renderTarget: { channel: string } }) => t.renderTarget.channel === '@main');
    expect(target.graphicInstances).toEqual([{ graphicInstanceId: instance, graphic: { id: LT_ID, name: 'Lower Third — Name' } }]);

    await post(`/renderers/${P}/target/graphicInstance/playAction`, { renderTarget: main, graphicInstanceId: instance, params: { skipAnimation: true } });
    expect(page.commands().at(-1)).toMatchObject({ verb: 'step', step: 1, cut: true, mount: LT });
  });

  it('stops a mount without unmounting it; clear unmounts it', async () => {
    const page = output(`${P}/@main`, { answer: false });
    await post(`/renderers/${P}/target/graphicInstance/load`, { renderTarget: main, graphicId: LT_ID, params: { data: {} } });
    await post(`/renderers/${P}/target/graphicInstance/stopAction`, { renderTarget: main, graphicInstanceId: instance, params: { skipAnimation: true } });
    expect(page.commands().at(-1)).toMatchObject({ verb: 'stop', cut: true, mount: LT });

    const cleared = await app.inject({
      method: 'PUT',
      url: `${BASE}/renderers/${P}/target/graphicInstance/clear`,
      payload: { filters: [{ renderTarget: main }] },
    });
    expect(cleared.json()).toEqual({ graphicInstances: [{ renderTarget: main, graphicInstanceId: instance }] });
    expect(page.commands().some((c) => c.verb === 'clear' && c.mount === LT)).toBe(true);
    const gone = await post(`/renderers/${P}/target/graphicInstance/playAction`, { renderTarget: main, graphicInstanceId: instance, params: {} });
    expect(gone.statusCode).toBe(404);
  });

  it('refuses an output name that cannot be one', async () => {
    const res = await post(`/renderers/${P}/target/graphicInstance/load`, { renderTarget: { channel: '@Not Valid' }, graphicId: LT_ID, params: { data: {} } });
    expect(res.statusCode).toBe(400);
  });
});

describe('clear', () => {
  it('clears by graphic id across targets', async () => {
    const out = output(`${P}/${LT}`);
    const res = await app.inject({
      method: 'PUT',
      url: `${BASE}/renderers/${P}/target/graphicInstance/clear`,
      payload: { filters: [{ graphicId: LT_ID }] },
    });
    expect(res.json().graphicInstances).toContainEqual({ renderTarget: ltTarget, graphicInstanceId: LT });
    expect(out.commands().map((c) => c.verb)).toEqual(['clear']);
  });
});

describe('the renderer’s mode action', () => {
  it('sets the project mode', async () => {
    const res = await post(`/renderers/${P}/customActions/mode`, { payload: { mode: 'rehearsal' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.mode).toBe('rehearsal');
    const back = await post(`/renderers/${P}/customActions/mode`, { payload: { mode: '' } });
    expect(back.json().result.mode).toBe('');
    expect((await post(`/renderers/${P}/customActions/explode`, { payload: {} })).statusCode).toBe(404);
  });
});

describe('the pointer package', () => {
  it('zips a manifest and graphic.mjs in a folder named for the graphic', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${P}/compositions/${LT}/ograf`, headers: { host: 'breeze.local:7331' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain(`${LT_ID}.ograf.zip`);
    const entries = Object.entries(unzipSync(res.rawPayload)).map(([name, bytes]) => ({ name, bytes }));
    expect(entries.map((e) => e.name).sort()).toEqual([`${LT_ID}/graphic.mjs`, `${LT_ID}/${LT}.ograf.json`]);
    const manifest = JSON.parse(new TextDecoder().decode(entries.find((e) => e.name.endsWith('.json'))!.bytes));
    expect(manifest).toMatchObject({ id: LT_ID, main: 'graphic.mjs', v_breeze: { server: 'http://breeze.local:7331' } });
    const module = new TextDecoder().decode(entries.find((e) => e.name.endsWith('.mjs'))!.bytes);
    expect(module).toContain('const SERVER = "http://breeze.local:7331";');
    // It carries no runtime.
    expect(module).not.toMatch(/gsap|BreezeRuntime/i);
  });

  it('points at another address on request, and refuses one that is not an address', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${P}/compositions/${LT}/ograf?server=${encodeURIComponent('http://10.1.2.3:7331/some/path')}` });
    const entries = Object.entries(unzipSync(res.rawPayload)).map(([name, bytes]) => ({ name, bytes }));
    expect(new TextDecoder().decode(entries.find((e) => e.name.endsWith('.mjs'))!.bytes)).toContain('"http://10.1.2.3:7331"');
    expect((await app.inject({ method: 'GET', url: `/api/projects/${P}/compositions/${LT}/ograf?server=ftp://x` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${P}/compositions/nope/ograf` })).statusCode).toBe(404);
  });

  it('serves the same files unzipped, for loading straight from the server', async () => {
    const mjs = await app.inject({ method: 'GET', url: `/ograf/package/${encodeURIComponent(LT_ID)}/graphic.mjs` });
    expect(mjs.statusCode).toBe(200);
    expect(mjs.headers['content-type']).toContain('text/javascript');
    expect(mjs.headers['access-control-allow-origin']).toBe('*');
    const json = await app.inject({ method: 'GET', url: `/ograf/package/${encodeURIComponent(LT_ID)}/${LT}.ograf.json` });
    expect(json.json().id).toBe(LT_ID);
    expect((await app.inject({ method: 'GET', url: `/ograf/package/${encodeURIComponent(LT_ID)}/secrets.txt` })).statusCode).toBe(404);
  });
});

describe('graphic.mjs', () => {
  it('is a valid ES module exporting the graphic class, whatever the names contain', () => {
    const code = pointerModule({ server: 'http://a:1', projectId: 'p', compositionId: 'c', name: 'It’s "quoted" </script> `tick` ${x}' });
    expect(() => transformSync(code, { loader: 'js', format: 'esm' })).not.toThrow();
    expect(code).toContain('export default class BreezePointerGraphic extends HTMLElement');
    for (const method of ['load', 'dispose', 'playAction', 'stopAction', 'updateAction', 'customAction']) {
      expect(code).toMatch(new RegExp(`\\n  (async )?${method}\\(`));
    }
  });

  it('takes only an http(s) origin as the server', () => {
    expect(serverOrigin('http://10.0.0.5:7331/x?y')).toBe('http://10.0.0.5:7331');
    expect(serverOrigin('https://breeze.example')).toBe('https://breeze.example');
    for (const bad of ['', 'ftp://x', 'javascript:alert(1)', 'not a url', 7]) expect(serverOrigin(bad)).toBeNull();
  });
});
