# Breeze Overlay — Developer API

Written against Breeze Overlay **0.81.0**. Everything here was read off the server source
(`apps/server/src`), not off older notes.

This is the reference for anyone driving Breeze from outside its own pages: a script, a
control surface, a playout system, a custom panel. It covers the HTTP API, the control
WebSocket, the OGraf Server API, and the scripting hooks on the output page. For the
operator's view of the same calls — what to put on a button — see the
[user guide](USER-GUIDE.md#14a-remote-control--the-http-api).

> **Pre-1.0.** The control, state, discovery and data-action routes (sections 4–9) are what
> the Companion module is built on and are the ones to automate against. The project
> document format and the editor-facing routes in [section 14](#14-editor-facing-routes)
> can still change before 1.0.0.

## Contents

1. [Basics](#1-basics)
2. [Authentication](#2-authentication)
3. [Errors](#3-errors)
4. [Discovery — what can I address?](#4-discovery--what-can-i-address)
5. [Controlling a graphic](#5-controlling-a-graphic)
6. [Reading state](#6-reading-state)
7. [Rundowns and outputs](#7-rundowns-and-outputs)
8. [Project mode](#8-project-mode)
9. [Data sources](#9-data-sources)
10. [Projects and compositions](#10-projects-and-compositions)
11. [The control WebSocket](#11-the-control-websocket)
12. [Output pages and scripting](#12-output-pages-and-scripting)
13. [OGraf](#13-ograf)
14. [Editor-facing routes](#14-editor-facing-routes)
15. [Server status](#15-server-status)
16. [Recipes](#16-recipes)

---

## 1. Basics

| | |
|---|---|
| Base URL | `http://<host>:7331` (`BREEZE_PORT`) |
| Format | JSON in, JSON out. Send `Content-Type: application/json` with a body |
| Body limit | 64 MB |
| Health check | `GET /healthz` → `{ "ok": true, "app": "breeze-overlay", "version": "0.81.0", "formatVersion": 1 }`. `app` (0.81+) is fixed: match it exactly to tell Breeze from another server |
| Language | API messages are always English, whatever `BREEZE_LOCALE` is |

### Addresses

Three ids appear in almost every URL.

| Id | What it is | Example |
|---|---|---|
| **project** | The project's URL key | `rahb-1k3f9` |
| **channel** | A composition's URL key, or a scene element's **Channel** | `lower-third`, `bug` |
| **output** | A named multi-graphic output. Lowercase letters, digits, inner hyphens, 24 characters at most | `main` |

A channel is addressed on the hub by a **channel key**:

| Channel key | Addresses |
|---|---|
| `<project>/<channel>` | One graphic — what `/play/<project>/<channel>` shows |
| `<project>/@<output>` | An output's routing channel — what `/out/<project>/<output>` follows |
| `<project>/@<output>~<composition>` | One composition mounted on an output |
| `<project>/#rundowns` | A project's rundown channel (panels only; nothing renders on it) |

### GET or POST

Every **action** route accepts both `GET` and `POST`. A side-effecting GET is deliberate:
Stream Deck's "open URL" and most HTTP presets cannot send a body or a header. On a POST,
parameters may go in the query string or in a JSON body; where both name the same
parameter the body wins.

`key` is reserved on every action URL — it is always the API key and never a parameter or
a field.

---

## 2. Authentication

By default there is no key, and every route is open. Set `BREEZE_API_KEY` and the server
requires it on:

- every non-GET request under `/api/`;
- every **action**, GET included — the control verbs, rundown and output verbs, mode set,
  a source's `use`, `media/check`, `game` and `poll`;
- every non-GET request under `/ograf/v1`;
- every `command` sent over the control WebSocket.

**Reads stay open**: output pages, the portal, the editor shell, `…/state`, the discovery
routes, the source lists, `/api/status`, `/api/peers` and `/api/activity`.

Send the key one of these ways:

| How | Example | Where |
|---|---|---|
| Header | `x-breeze-key: <key>` | Everywhere. Preferred |
| Query parameter | `?key=<key>` | Everywhere. For devices that cannot set a header |
| Bearer token | `Authorization: Bearer <key>` | `/ograf/v1` only |
| Browser session | Sign in on the portal | Browsers on the server's own origin; 12 hours |

Things to know:

- **Five wrong keys a minute per address**, counted across every route. After that the
  address gets `429` until the minute is out. A device configured with a wrong key locks
  itself out too.
- `?key=` is removed from the server log, and from an `update` before the rest become
  field values. It is still visible in proxy logs. Use the header where you can.
- `GET /api/auth` → `{ keyRequired, signedIn, expiresAt? }` says whether a key is set.
  It needs no key.
- `POST /api/auth/login` and `/logout` are for the portal: they only answer a request
  whose `Origin` is the server itself. Scripts send the key instead.
- Behind a reverse proxy, pass the original `Host` header through, or browser sessions
  are refused.

---

## 3. Errors

| Status | Meaning |
|---|---|
| `400` | A parameter is missing or malformed |
| `401` | The API key is set and was not sent, or was wrong |
| `403` | Refused: an operator-locked source, or a path outside its folder |
| `404` | No such project, channel, composition, source, rundown or item |
| `409` | Well-formed, but the current state forbids it (a composition still mounted, a source with no backup, nothing armed) |
| `413` | A text source's body is over 256 KB |
| `422` | A composition or rundown document failed validation; `issues` lists why |
| `429` | Too many wrong keys from this address |

Every error body has an English `error` string. Refusals a person is likely to meet also
carry a stable `code` (and the `params` the message was built from) to match on:

```json
{ "error": "This server needs its API key.", "code": "error.apiKeyRequired" }
```

```json
{ "error": "validation failed", "issues": [ … ] }
```

Match on `code` when there is one, never on the wording of `error`. Not every error has a
code: plain diagnostics (`"n must be a whole number, 1 or more"`) are `error` only.

Two groups answer differently on purpose:

- `datasources-preview` and the two `datasources-inspect` routes answer **`200` with
  `{ "ok": false, "error": … }`** for a bad URL or an unreachable feed.
- `/ograf/v1` answers with RFC 7807 problems: `{ title, status, detail, instance }`.

---

## 4. Discovery — what can I address?

All open, all GET.

| Route | Returns |
|---|---|
| `/api/projects` | `{ projects: [{ id, name, updatedAt, compositions: [{ id, name }] }] }`, newest first |
| `/api/channels` | `{ projects: [{ id, name, channels: [ChannelRef] }] }` — every project in one call |
| `/api/projects/:project/channels` | `{ channels: [ChannelRef] }` |
| `/api/projects/:project/compositions/:composition/bindings` | A graphic's fields (below) |
| `/api/sports` | The sport templates: rules, score buttons and table columns |

`/channels` is the same index a trigger is resolved against. If a channel is not listed,
calling it answers `404`.

**ChannelRef**

```jsonc
{
  "channel": "lower-third",   // the name to put in a control URL
  "ref": "lower-third",       // the composition it renders
  "name": "Lower third",      // what to print on a button
  "sceneId": null,            // the scene it is mounted in; null when played directly
  "layerId": null,
  "tables": [                 // tables built to page; empty when none
    { "table": "standings", "name": "Standings", "cycle": true }
  ],
  "timers": ["game", "shot"], // 0.81+: timer ids it declares, mounts included, in layer order
  "scrolls": ["main"]         // 0.81+: roll ids, on the same terms
}
```

**Bindings**

```jsonc
{
  "bindings": [
    {
      "name": "name",            // the field name `update` takes
      "kind": "string",          // string | image | video | stringList | dataset |
                                 // number | boolean | enum | color | asset
      "label": "Name",
      "defaultValue": "Jane Doe",
      "layerIds": ["l-3"],
      "source": "standings"      // present when a data source feeds the layer
    }
  ],
  "overrides": [ … ],            // per-mount fields, addressed "<mount>.<binding>"
  "schema": { … },               // JSON Schema for the whole update payload
  "stepCount": 2                 // holds in the timeline
}
```

`schema` is the authority on what shape each field's value takes. A field fed by a fetched
data source is read-only in practice: the next poll overwrites whatever is pushed.

---

## 5. Controlling a graphic

```
GET|POST /api/control/<project>/<channel>/<verb>
```

All but `state` need the API key when one is set. An unknown project or channel answers
`404` (`state` does not check: an unknown channel reads as idle with `renderers: 0`).

| Verb | Parameters | Does |
|---|---|---|
| `play` | — | Rolls in and holds at the next STOP marker. Again, to advance |
| `stop` | — | Runs the outro. How a graphic leaves air |
| `next` | `table?` | Turns a paged table's page, otherwise advances to the next hold |
| `prev` | `table?` | Back a page, otherwise back to the previous hold |
| `page` | `n` **or** `name`, `table?` | Goes to a page: `n` counts from 1, `name` is a page key |
| `cycle` | `state=hold\|resume`, `table?` | Freezes or restarts tables that page themselves |
| `clear` | — | Hard reset. Nothing on screen, at once |
| `clear-all` | — | `clear` on a scene and every element in it. Takes a composition id |
| `update` | field values | Pushes field values. Live; no re-play needed |
| `take` | field values, optional | New values and PLAY as one step. On air, the outro runs first |
| `timer` | `action`, `id?`, `value?` | Drives an operator timer |
| `scroll` | `action`, `id?`, `value?` | Drives a roll |
| `state` | `data=0?` | Reads state. Open; see [section 6](#6-reading-state) |

Every verb but `state` answers in this shape:

```json
{ "ok": true, "verb": "play", "channel": "rahb-1k3f9/lower-third", "delivered": 1 }
```

**`delivered` is the number of output pages that received the command.** `0` means the
call worked and nothing was listening — the browser source is not open. Read it back; it
is the first thing to check on a button that looks dead. Previews are never counted.

### update and take

```bash
# GET — every value arrives as a string
curl "http://host:7331/api/control/rahb-1k3f9/lower-third/update?name=Jane%20Doe&title=Reporter"

# POST — typed values, and the only way to send a list or a table
curl -X POST http://host:7331/api/control/rahb-1k3f9/lower-third/update \
  -H 'content-type: application/json' -H 'x-breeze-key: KEY' \
  -d '{"name":"Jane Doe","title":"Reporter"}'
```

- Field names are the binding names from [`/bindings`](#4-discovery--what-can-i-address).
  A field inside a nested composition is `<mount>.<binding>`.
- Values **merge** into what the channel already holds: sending one field leaves the
  others alone.
- The server retains the values, so a browser source that reloads comes back showing them.
- `update` with no fields answers `400`. `take` with no fields is allowed: a plain take
  of what the graphic already holds.
- Names beginning with `$` (`$data`, `$timers`, `$scrolls`, `$mode`, `$mounts`,
  `$rundown`) are reserved for the server. Do not send them.

### Paging tables

A table is named by its binding; inside a nested composition, `<mount>.<binding>`; with no
binding, its layer id. The `tables` array in `/channels` lists the exact address.

```
…/next?table=standings
…/page?n=3
…/page?name=C&table=standings
…/cycle?state=hold
```

- Without `table`, the command applies to every table in the graphic.
- `page` needs exactly one of `n` and `name`; both or neither answers `400`.
- A `table` the graphic does not have is delivered and ignored. The server cannot refuse
  it: which tables page depends on the data, which only an output knows.

### Timers

```
…/timer?action=toggle&id=game
…/timer?action=set&id=game&value=8:00
…/timer?action=add&id=game&value=-10
```

| Parameter | Values |
|---|---|
| `action` | `start`, `pause`, `toggle`, `reset`, `set`, `add` |
| `id` | The timer's id. Blank is `main` if the target declares it, otherwise its first timer, and `main` when it declares none (0.81+; before that, always `main`). `timer.id` in the answer says which was used |
| `value` | For `set`, a time: `8:00`, `480`, `1:02:03`, `12.5`. For `add`, a signed one: `-10`, `+0:30`. Seconds, as an operator types them |

The answer adds `timer: { id, action, state }`. `state` is the timer as the server holds
it (times in epoch ms on the server's clock):

```jsonc
{ "running": true, "anchor": 1790626119416, "elapsed": 0, "base": 480000, "adjust": 0 }
```

### Rolls

```
…/scroll?action=pause
…/scroll?action=speed&value=1.5
…/scroll?action=seek&value=50%
```

| Parameter | Values |
|---|---|
| `action` | `play`, `pause`, `toggle`, `forward`, `backward`, `reverse`, `faster`, `slower`, `speed`, `jog`, `seek`, `restart`, `end`, `reset` |
| `id` | The scroll's id. Blank resolves as a timer's does (0.81+) |
| `value` | `speed`: a multiple of the designed speed (`1.5`, `x2`). `jog`: signed seconds (`-3`). `seek`: a time or a percentage (`1:30`, `50%`) |

The answer adds `scroll: { id, action, state, info }`. `state` is
`{ running, anchor, base, rate }`; `info` is what the outputs measured — `extent` is the
whole run in seconds at the designed speed — or `null` before any output has reported.

A fresh PLAY or a TAKE restarts a graphic's rolls from the top; CLEAR stops them.

---

## 6. Reading state

```
GET /api/control/<project>/<channel>/state          open, no side effects
GET /api/control/<project>/<channel>/state?data=0   without the retained field data
```

```jsonc
{
  "channel": "rahb-1k3f9/lower-third",
  "state": {
    "data": { "name": "Jane Doe" },
    "playback": {
      "state": "holding",        // idle | playing-in | holding | playing-out | finished
      "time": 1.2,
      "step": 1,
      "stepCount": 2,
      "tables": [
        { "table": "standings", "page": 0, "pageCount": 3, "key": "A",
          "hasCycle": true, "cycling": true, "held": false, "secondsLeft": 4.1 }
      ]
    },
    "reportedAt": 1790626119416, // server clock, ms — when `playback` was reported
    "now": 1790626121020,        // server clock, ms — now
    "sources": [                 // each connected output page, oldest first
      { "id": "c4k2…", "page": "1m0b0t1x", "label": "OBS on Windows", "ip": "192.168.1.20",
        "connectedAt": 1790625000000, "playback": { … }, "reportedAt": 1790626119416 }
    ],
    "renderers": 1,              // output pages attached. 0 = nothing is listening
    "controllers": 2,            // panels and editors open
    "updatedAt": "2026-08-08T19:02:11.400Z"
  },
  "timers":  { "clock": 1790626121020, "timers": { "game": { … } } },
  "scrolls": { "clock": 1790626121020, "items": [ { "id": "main", "state": { … }, "info": { … } } ] }
}
```

- **Use `?data=0` when polling.** On a graphic fed by data sources, `data` carries every
  source's rows. `timers` and `scrolls` are returned either way, when the graphic has any.
- `playback` is always an output's report, never a preview's while an output is
  connected. With several outputs, the one furthest along speaks for the channel
  (holding, then playing-in, then playing-out).
- `now - reportedAt` is the age of the report. Both are the server's clock, so the
  caller's clock does not matter.
- `tables[].page` counts from **0** here; the `page` verb's `n` counts from **1**.
- A page's `signal: "matte"` in `sources` marks a key-signal page (`?matte=1`).
- For anything that needs to react rather than poll, subscribe over the
  [WebSocket](#11-the-control-websocket).

---

## 7. Rundowns and outputs

A **rundown** is a prepared list of items, each a composition with its field values. An
**output** (`/out/<project>/<output>`) is a browser source with no graphic of its own: it
shows whatever is taken onto it, several graphics at once.

### The rundown document

| Route | |
|---|---|
| `GET /api/projects/:project/rundowns` | The project's rundowns. Open |
| `PUT /api/projects/:project/rundowns` | Replace them. `422` with `issues` when invalid |

```jsonc
{
  "formatVersion": 1,
  "rundowns": [
    {
      "id": "service",
      "name": "Sunday service",
      "items": [
        {
          "id": "speaker-1",
          "composition": "lower-third",
          "label": "Jane Doe",                  // optional
          "data": { "name": "Jane Doe" },       // the fields TAKE sends
          "output": "main",                     // absent: the composition's own channel
          "layer": 10                           // stacking on an output; higher is in front
        }
      ]
    }
  ]
}
```

Limits: 50 rundowns, 500 items each, labels to 120 characters. Rundown and item ids are
letters, digits, `_` and `-`, 64 at most.

### Rundown verbs

```
GET|POST /api/rundown/<project>/<rundown>/<verb>
```

| Verb | Parameters | Does | Answers |
|---|---|---|---|
| `cue` | `item?` | Arms an item. No `item` disarms | `{ ok, verb, armed }` |
| `next` / `prev` | — | Arms the next or previous item | `{ ok, verb, armed }` |
| `take` | `item?`, `advance?` | Takes the armed item (or `item`) to air, then arms the next. `advance=0` leaves the arm where it is | `{ ok, verb, item, target, channel, delivered, armed }` |
| `out` | `target?` | Takes off what the rundown put on air | `{ ok, verb, target, delivered }` |
| `state` | — | What is armed and on air. Open | below |

A **target** is `@<output>` or a composition id. `take` with nothing armed and no `item`
answers `409`.

```jsonc
// GET /api/rundown/<project>/<rundown>/state
{
  "rundown": "service",
  "armed": "speaker-2",
  "onAir": { "@main": "speaker-1" },           // target → the item last taken onto it
  "targets": [
    { "target": "@main", "item": "speaker-1", "state": "holding", "renderers": 1,
      "scrolls": [], "clock": 1790626121020 }
  ]
}
```

What is armed and on air is held by the server, so every panel and every caller sees the
same thing. It is held in memory: a server restart clears it.

### Output verbs

```
GET|POST /api/out/<project>/<output>/<verb>
```

| Verb | Parameters | Does |
|---|---|---|
| `stop` | `mount?` | Runs the outro of one mounted composition, or all of them |
| `next` / `prev` | `mount?` | Steps one, or all |
| `clear` | `mount?` | Unmounts one, or everything |
| `timer` | as in [section 5](#timers) | The output's timers, shared by everything mounted on it |
| `scroll` | as in [section 5](#rolls) | The output's rolls, shared the same way |
| `state` | — | Open |

`mount` is a composition id. Answers follow the control verbs:
`{ ok, verb, channel, delivered, mount? }`.

```jsonc
// GET /api/out/<project>/<output>/state
{
  "channel": "rahb-1k3f9/@main",
  "renderers": 1,
  "mounts": [
    { "composition": "lower-third", "item": "speaker-1", "layer": 10,
      "since": 1790626100000, "state": "holding" }
  ],
  "timers": { … },
  "scrolls": { … }
}
```

A graphic is put **on** an output by a rundown `take`, or by OGraf `load`.

---

## 8. Project mode

The mode is one value per project (`first-alert`, `election night`). Layer rules read it,
so one change restyles every graphic in the project. It survives a restart.

| Route | |
|---|---|
| `GET /api/projects/:project/mode` | `{ mode, modes }` — the mode now, and every mode the project's rules name. Open |
| `GET\|POST /api/projects/:project/mode/set?value=first-alert` | Sets it. Empty `value` clears it |

`value` takes letters, digits, spaces and `. - _`, 48 characters at most; anything else
answers `400`. The answer is `{ ok, mode, modes, delivered }`.

---

## 9. Data sources

Every source — a typed table, an HTTP feed, a weather provider, a poll — normalises to
one shape before a graphic sees it:

```jsonc
{
  "id": "standings",
  "columns": [{ "key": "team", "type": "string" }, { "key": "w", "type": "number" }],
  "rows": [{ "team": "Mesa", "w": 11 }],
  "fetchedAt": "2026-08-08T19:02:11.400Z",
  "revision": 17            // bumped only when the content changes
}
```

Column types are `string`, `number`, `boolean` and `date`.

Sources are either **a project's own** or **server-level** (shared, polled once, linked
into projects). Every route below under `/api/projects/:project/datasources…` also exists
under `/api/server/datasources…` for the server-level sources, except `game`, `poll`,
`text` and `move-to-server`.

### Reading

| Route | |
|---|---|
| `GET /api/sources` | Everything on the server: `{ server: […], projects: [{ id, name, sources }], minPollInterval }` |
| `GET …/datasources` | `{ sources: [{ def, interval, status, columns, rowCount }], minPollInterval }`. `?rows=N` adds each source's rows (2000 at most) |
| `GET …/datasources/:source` | One source with its rows. `?rows=N`, default 200 |
| `GET …/datasources/:source/media` | A camera list's last check: `{ summary, rows }` |

All open. Credentials are not returned: the values of request headers that look like
credentials (`Authorization`, anything with `key`, `token`, `secret` or `cookie` in its
name) come back masked.

`status` is the health of one source:

| Field | |
|---|---|
| `lastFetch`, `lastSuccess`, `lastChange` | ISO times |
| `lastError`, `warning` | Why the last fetch failed, or succeeded only in part |
| `failures` | Consecutive failures |
| `expired`, `stuck` | Its rows have been emptied for age, or judged frozen |
| `dropped` | Rows the guard dropped from the last fetch |
| `serving` | The id of the source whose rows are on air instead — the backup is serving |
| `use` | `primary` or `backup` while an operator's choice is in force |
| `media` | Camera check counts, on a camera list |
| `revision`, `rowCount` | |

### Actions

All need the key.

| Route | Does |
|---|---|
| `POST …/datasources/:source/refresh` | Fetches now. Answers `{ status, data }` |
| `GET\|POST …/datasources/:source/use?mode=auto\|primary\|backup` | Chooses whose rows go on air. `{ status }` |
| `GET\|POST …/datasources/:source/media/check` | Checks every camera now. `{ done, summary, rows }` |
| `POST /api/projects/:project/datasources/:source/move-to-server` | Makes a fetched source server-level, leaving a link under the same id |

- **`refresh` is rate-limited by the source's own floor** — five seconds, or the
  provider's limit for weather, air quality and alerts. Asked too soon it fetches nothing
  and still answers `200`, with the rows it has and `"throttled": { "retryIn": 4 }`
  (seconds). Refreshing a link refreshes the server-level source it points at.
- `use=backup` on a source with no backup answers `409`. The choice lasts until changed
  or the server restarts.
- `media/check` answers within about four seconds whatever happens. `done: false` means a
  slow camera is still being checked. Each row's state is `ok`, `failed` or `frozen`.

### Scores, polls and text

All need the key. All are project sources only.

**Sport game table** — `GET|POST /api/projects/:project/datasources/:source/game`

| `type` | Other parameters |
|---|---|
| `score`, `unscore` | `side=home\|away`, `action=<scoring action id>` |
| `point` | `side` |
| `adjust` | `column`, `delta` |
| `set` | `column`, `value` |
| `period` | `delta` (`1` or `-1`; default `1`) |
| `reset` | — |

Answers `{ ok, source, action, row }` with the game row after the change. The scoring
action ids and column names for each sport are in `GET /api/sports`. A source that is not
a sport's game table answers `409`.

**Poll** — `GET|POST /api/projects/:project/datasources/:source/poll`

| `type` | Other parameters |
|---|---|
| `vote` | `option`, `delta?` (default `1`; `-1` takes one off) |
| `set` | `option`, `value` |
| `open`, `close`, `reset` | — |
| `toggle` | — (0.81+). Opens a closed poll, closes an open one; decided on the server under the sources lock |

Answers `{ ok, source, action, status, rows }` — `status` (0.81+) is `open` or `closed` after the action.

`PUT …/datasources/:source/poll` with `{ "question": "…", "options": [{ "id": "yes", "label": "Yes" }] }`
re-words a poll. Votes for options that remain are kept. `403` unless the poll is marked
operator-changeable.

**Text** — `PUT /api/projects/:project/datasources/:source/text` with `{ "body": "…" }`
replaces a typed text source's words. `403` unless it is operator-changeable, `409` when
the text is fetched from a URL, `413` above 256 KB.

### Defining sources

| Route | |
|---|---|
| `PUT …/datasources/:source` | Creates or replaces a definition. Fetched sources poll at once |
| `DELETE …/datasources/:source` | `204`. A server-level source still linked from a project answers `409` with `links` |
| `POST …/datasources-preview` | `{ def, transforms? }` — fetches a candidate without saving. First 50 rows |
| `POST …/datasources-inspect` | `{ url, headers? }` — suggests where the rows are in a JSON feed |
| `POST …/datasources-inspect-xml` | `{ url, headers? }` — ranks candidate row elements in an XML feed |

Source types: `manual`, `http-json`, `http-csv`, `rss`, `xml`, `sheets`, `weather`, `ftp`,
`cap`, `air-quality`, `text`, `poll`, `link`. Each has its own fields; the quickest way to
a correct definition is to build the source in the editor and `GET` it back.
`examples/datasources.json` has working ones.

The server fetches these URLs itself, so by default it refuses addresses that resolve to
a private network. `BREEZE_DATA_ALLOW_HOSTS` lists the exceptions.

### How data reaches a graphic

A changed DataSet is pushed to every open graphic in the project as an ordinary `update`
whose payload is `{ "$data": { "<source id>": DataSet } }`. It is retained with the rest
of the channel's data, which is why `state.data` on a data-fed graphic is large, and why a
reconnecting page comes back with its rows.

---

## 10. Projects and compositions

Reads are open; writes need the key.

| Route | |
|---|---|
| `GET /api/projects` | The list |
| `POST /api/projects` | `{ name?, key? }` → `201` with the project. `key` is the front half of its id |
| `GET /api/projects/:project` | The whole project document |
| `PUT /api/projects/:project` | Replaces it. This is what the editor's save does |
| `DELETE /api/projects/:project` | `204` |
| `GET /api/projects/:project/compositions` | `{ compositions }` |
| `POST /api/projects/:project/compositions` | `{ name?, key? }` → `201` with a new, empty composition at the project's stage size |
| `GET /api/projects/:project/compositions/:composition` | One composition |
| `PUT /api/projects/:project/compositions/:composition` | Replaces it. `422` when invalid |
| `GET /api/projects/:project/compositions/:composition/referrers` | `{ referrers }` — what mounts it |
| `DELETE /api/projects/:project/compositions/:composition` | Refused with `409` and `referrers` while anything mounts it |
| `POST /api/validate/composition` | Validates a composition without saving: `{ valid, errors }` |
| `GET /api/keys/suggest?name=…` | `{ key, valid, maxLength }` — a URL key from a name, by the server's rules |

Rules:

- **Ids are minted by the server.** An id is the key you chose plus a generated suffix
  (`rahb` → `rahb-1k3f9`). A chosen key is lowercase letters, digits and inner hyphens,
  12 characters at most. A bad key answers `400` with `field: "key"`.
- **Names** are required, 64 characters at most, with no control characters. A refused
  name answers `400` with `field: "name"` and one of `error.nameEmpty`,
  `error.nameTooLong`, `error.nameControl`. Omitting `name` on a create gives the default.
- A new composition's key may not collide with any channel in the project, scene elements
  included.
- The composition document is the editor's format. Until 1.0.0 it can change between
  versions; `formatVersion` in `/healthz` says which one a server writes. `examples/` has
  complete projects to read.

---

## 11. The control WebSocket

```
ws://<host>:7331/ws/control
ws://<host>:7331/ws/control?key=<key>
```

The same hub the REST verbs use: a command sent either way reaches the same outputs and
shows on the same panels. Use it to **follow** a channel instead of polling `/state`.

Frames are JSON text. One socket follows one channel; open a socket per channel, or
re-subscribe to move.

### Subscribing

```json
{ "type": "subscribe", "channel": "rahb-1k3f9/lower-third", "role": "controller", "client": "monitor", "data": false }
```

| Field | |
|---|---|
| `channel` | A channel key ([section 1](#addresses)) |
| `role` | `controller` for anything that drives or watches. (`renderer` and `preview` are the output page's own roles) |
| `client` | What kind of controller: `panel` (the default), `editor`, `monitor`, `companion`, `ograf`. Anything but `panel` and `editor` is left out of the "panels open" count and the activity log. An integration should say `monitor` |
| `data` | `false` to receive state without the retained field data. Recommended unless you need the values |

Subscribing needs no key. The server answers:

```json
{ "type": "welcome", "channel": "rahb-1k3f9/lower-third", "role": "controller", "state": { … } }
```

and then, every time something changes on the channel:

```json
{ "type": "state", "channel": "rahb-1k3f9/lower-third", "state": { … } }
```

`state` is the same object as `state` in [section 6](#6-reading-state). A `state` frame is
sent when a command is dispatched, an output connects or leaves, or an output's report
changes in substance — state, step, page, or ticker copy. Heartbeats that only age are
not relayed, so `secondsLeft` and `time` are as of `reportedAt`.

### Sending commands

```json
{ "type": "command", "command": { "verb": "play" } }
{ "type": "command", "command": { "verb": "update", "data": { "name": "Jane Doe" } } }
{ "type": "command", "command": { "verb": "page", "page": 3, "table": "standings" } }
{ "type": "command", "command": { "verb": "timer", "timer": { "action": "set", "id": "game", "value": 480000 } } }
```

Subscribe first; a command goes to the channel the socket is subscribed to.

| `verb` | Fields |
|---|---|
| `play`, `stop`, `clear` | — |
| `next`, `prev` | `table?` |
| `page` | `page` (1-based) **or** `key` (a page key), `table?` |
| `cycle` | `cycle: "hold" \| "resume"`, `table?` |
| `update`, `take` | `data` |
| `step` | `step` (1-based hold), `cut?` |
| `seek` | `time` (seconds) |
| `timer` | `timer: { action, id?, value? }` |
| `scroll` | `scroll: { action, id?, value?, percent? }` |

On an output's routing channel (`<project>/@<output>`), add `mount` to aim at one
composition. On the rundown channel (`<project>/#rundowns`) the verbs are `cue`, `take`,
`rundownNext`, `rundownPrev` and `out`, each with `rundown`, and `item` / `target` /
`advance` as in [section 7](#rundown-verbs).

**Units differ from REST.** Over the socket nothing is parsed from operator text:

| | REST | WebSocket |
|---|---|---|
| Timer `value` | seconds or a clock string (`8:00`) | **milliseconds** |
| Scroll `jog` / `seek` `value` | seconds or a clock string; `50%` | seconds; a percentage with `percent: true` |
| Page key | `name=` | `key` |

A command the hub cannot make sense of — an unknown timer action, a bad id — is dropped
without an answer. The REST routes validate and say why; prefer them for one-off
commands.

### Authorisation and errors

With a key set, a `command` needs it: `?key=` on the socket URL, an `x-breeze-key`
header on the upgrade, or a signed-in browser session. Without it:

```json
{ "type": "error", "message": "This server needs its API key.", "code": "error.apiKeyRequired" }
```

Other errors are `{ "type": "error", "message": … }`: an unparseable frame, or a command
before a subscribe. The socket stays open after any of them.

There is no ping frame of the server's own. Reconnect on close and subscribe again; the
`welcome` carries the current state, so nothing is missed.

---

## 12. Output pages and scripting

| Page | |
|---|---|
| `/play/<project>/<channel>` | One graphic, or a scene. For a vMix Web Browser input or an OBS Browser Source |
| `/play/<project>` | Redirects to the project's first composition |
| `/out/<project>/<output>` | An output |
| `/control/<project>/<channel>` | The operator panel |
| `/rundown/<project>` | The rundown panel |
| `/assets/<project>/<path>` | A project's asset files |

All open. An output page shows nothing until told to play.

### URL parameters on `/play`

| Parameter | |
|---|---|
| `autoplay=1` | Play on load |
| `scale=contain` | Fit the stage to the window. Otherwise 1:1 pixels |
| `bg=` | A solid background for chroma: `green`, `blue`, `magenta`, `black`, `white`, or hex without `#` |
| `matte=1` | Render the key signal |
| `sync=off` | Do not pick up from an output already on air after a reload |
| `debug=1` | A readout of state, time, step and frame rate |
| anything else | A field value: `?name=Jane%20Doe`. On a scene, `?<element>.<field>=…` |

### `window.breeze`

For vMix scripting, OBS `executeJavaScript`, or a browser console. These act on **that
page only**; they do not go through the server, so other outputs and the control panel do
not follow. To move every output, use the REST verbs.

| Call | |
|---|---|
| `breeze.play()`, `breeze.stop()` | |
| `breeze.next(table?)`, `breeze.prev(table?)` | |
| `breeze.page(3)`, `breeze.page('C', 'standings')` | A number is a 1-based page; anything else a page key |
| `breeze.cycle('hold' \| 'resume', table?)` | |
| `breeze.update({ name: 'Jane' })` | An object, or the same as a JSON string |
| `breeze.take({ name: 'Jane' })` | |
| `breeze.mode()`, `breeze.mode('first-alert')` | Read, or set on this page |
| `breeze.seek(1.5)` | For debugging |
| `breeze.get('bug')` | On a scene: the same set of calls for one element |

On a single-graphic page `play`, `stop`, `next`, `prev`, `update` and `seek` are also
bound directly on `window`. On a scene they are not, since they could not say which
graphic they mean.

---

## 13. OGraf

Breeze implements the EBU's [OGraf](https://ograf.ebu.io) Server API v1 at
`http://<host>:7331/ograf/v1`, so an OGraf controller drives Breeze graphics. The routes
and bodies are the specification's; this is how its terms map.

| OGraf | Breeze |
|---|---|
| graphic | A composition. Id `<project>~<composition>` |
| renderer | A project. Id the project id |
| render target | `{ "channel": "<channel>" }` — a graphic's own channel, showing that composition only. `{ "channel": "@<output>" }` — an output, showing any composition of the project |
| graphic instance id | The channel it plays on: `<channel>`, or `@<output>~<composition>` |
| `load` | On a graphic's own channel: sends the values (`update`). On an output: mounts the composition without playing it |
| `playAction` | Goes to the hold `goto` / `delta` names; past the last, runs the outro. Answers once the outputs report it |
| `stopAction` | `stop`. With `skipAnimation`, a cut |
| `updateAction` | `update` |
| graphic custom actions | `next`, `prev`, `page`, `cycle`, `timer`, `scroll`, where the graphic has them |
| renderer custom action | `mode` — `{ "payload": { "mode": "first-alert" } }` |
| `clear` | `clear` on a channel; unmounts from an output |

Differences worth knowing:

- Reads are open. Actions need the key when one is set: `X-Breeze-Key`, `?key=`, or
  `Authorization: Bearer <key>`.
- CORS is open on `/ograf/`.
- `DELETE /graphics/<id>` answers `403`. Compositions are deleted in the editor.
- Graphics have no thumbnail; that route answers `404`.
- Action answers carry `v_delivered`, the same count as `delivered`.
- In OGraf custom actions, a timer `value` is **milliseconds**, as on the WebSocket.

**Pointer packages.** `GET /api/projects/:project/compositions/:composition/ograf`
downloads `<project>~<composition>.ograf.zip`: a manifest and a small module that frames
the live graphic from this server inside an OGraf renderer. `?server=http://10.0.0.5:7331`
sets the address the package calls back to; without it, the address the request came in
on. The same two files are served unzipped at `/ograf/package/<graphic id>/`.

---

## 14. Editor-facing routes

These serve the editor and the backup page. They work and can be scripted, but their
shapes follow the editor and are **not yet stable**.

**Assets**

| Route | |
|---|---|
| `GET /api/projects/:project/assets` | The asset index |
| `POST /api/projects/:project/assets?name=<file>` | Upload. The **raw file bytes** are the body (not multipart). `?replaces=<asset id>` replaces one |
| `POST /api/projects/:project/sequences?name=<file>&fps=` | Upload an image sequence as a zip |
| `PATCH`, `DELETE /api/projects/:project/assets/:asset` | Edit metadata; delete |
| `GET /api/projects/:project/assets/:asset/usage` | Which layers use it |
| `GET /api/projects/:project/assets/orphans` | Assets nothing uses |
| `GET`, `POST /api/projects/:project/assets/tags` | Tags; bulk tag-add |
| `GET /api/assets/limits` | `{ maxBytes, refused }` |
| `GET /api/media/capabilities` | `{ available, version, vp9Alpha, reason }` — whether ffmpeg is there to transcode with |
| `GET …/assets/:asset/probe` · `POST …/assets/:asset/transcode` | Inspect a video; queue a transcode |
| `GET /api/projects/:project/transcodes` · `DELETE …/transcodes/:job` | The queue; cancel a job |
| `GET /api/shared` · `DELETE /api/shared/:slug` | The shared asset store |
| `POST …/assets/:asset/promote` · `POST …/shared/pull` · `GET …/shared/stale` | Copy to and from it |

**Backup and restore**

| Route | |
|---|---|
| `GET /api/backup/projects` | What could be backed up, with sizes |
| `GET /api/backup?projects=a,b` | A bundle (zip). `projects=all` for everything; the parameter is required |
| `GET /api/projects/:project/backup` | One project's bundle |
| `GET /api/projects/:project/compositions/:composition/backup` | One composition, what it mounts, and only the assets those use |
| `POST /api/restore/inspect` | Reads a bundle (raw body) and reports collisions. Writes nothing |
| `POST /api/restore?mode=overwrite\|rename\|merge` | Restores a bundle (raw body). `mode` is required |

Backup downloads are GETs and so are open even with a key set. Bundles leave secrets out.

---

## 15. Server status

All open, never cached.

| Route | |
|---|---|
| `GET /healthz` | `{ ok, app, version, formatVersion }` — `app` is always `breeze-overlay` (0.81+) |
| `GET /api/status` | `{ version, ui, uptime, viewers: { renderers, controllers, channels }, cpu, memory }` |
| `GET /api/peers` | `{ sockets, api, apiWindowSeconds, now }` — every connected socket, and API callers in the last 60 seconds with their last status code |
| `GET /api/activity?limit=200` | `{ entries }` — the activity log, newest first. 1000 at most |

`cpu.percent` is this process, as a percentage of one core; it can pass 100 during a
transcode. An activity entry is `{ at, action, actor: { ip, agent }, project?, scene?, name?, detail? }`.

A caller with a red status in `/api/peers` is the quickest way to find a button wired
with the wrong key.

---

## 16. Recipes

**Check a button before the show**

```bash
curl "http://graphics-pc:7331/api/control/rahb-1k3f9/lower-third/state?data=0"
curl "http://graphics-pc:7331/api/control/rahb-1k3f9/lower-third/play"
```

`"delivered": 0` — the address is right and the browser source is not open. `404` — check
the keys against `/api/channels`. `401` — the key is set and missing from the call.

**Name a guest and put them on air in one call**

```bash
curl -X POST http://host:7331/api/control/rahb-1k3f9/lower-third/take \
  -H 'content-type: application/json' -H 'x-breeze-key: KEY' \
  -d '{"name":"Jane Doe","title":"Reporter"}'
```

**Walk a rundown from one key**

```
http://host:7331/api/rundown/rahb-1k3f9/service/take?key=KEY
```

Each press takes the armed item and arms the next.

**Follow a graphic's state**

```js
const ws = new WebSocket('ws://host:7331/ws/control');
ws.onopen = () => ws.send(JSON.stringify({
  type: 'subscribe', channel: 'rahb-1k3f9/lower-third',
  role: 'controller', client: 'monitor', data: false,
}));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'welcome' || m.type === 'state') {
    const { playback, renderers } = m.state;
    console.log(playback?.state ?? 'idle', renderers === 0 ? '(no output attached)' : '');
  }
};
```

**Build a button set**

1. `GET /api/channels` — every graphic, with the name for the button and its paged tables.
2. `GET /api/projects/<project>/datasources` — sources with a `fallback` get a BACKUP button.
3. `GET /api/projects/<project>/mode` — one toggle per entry in `modes`.
4. Subscribe to each channel with `data: false` to colour the buttons.

**Put a backup feed on air, then hand back**

```
http://host:7331/api/projects/rahb-1k3f9/datasources/wx-current/use?mode=backup&key=KEY
http://host:7331/api/projects/rahb-1k3f9/datasources/wx-current/use?mode=auto&key=KEY
```
