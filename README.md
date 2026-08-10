# Breeze Overlay

Self-hosted broadcast overlay/graphics builder. Motion graphics served as live HTML5 pages to vMix Web Browser inputs and OBS Browser Sources.

Built for the one-person production — school events, church services, community broadcasts — run on your own machine, on your own network.

**Status: Phases 0–7.5 complete.** Schema, runtime, server, the React editor (stage, layers, properties, timeline, keyframes, easing) and the operator control panel + external-trigger API are in place and tested. The lower-third demo has been confirmed working in real OBS — transparent background and live control-panel updates both behave correctly (2026-07-28). vMix and sustained load/reconnect behavior still need a real-world pass (see [Known gaps](#known-gaps)). Phase 5 adds [text reveals](#text-reveals). Phase 6 adds [data sources and tables](#data-sources-and-tables) — live feeds normalized to one canonical shape, weather from four providers, a `table` layer that re-sorts on air, and tickers fed from those feeds — plus scenes: several independently triggered graphics on one browser source. Phase 7/7.5 add media and asset management: upload bin, ProRes 4444 → VP9/WebM-alpha transcode with a job queue, asset library with search/tags/folders, Replace, and backup bundles. Masks, effects and in-place nesting are next, as Phase 8.

---

## Quick start

### Prerequisites

| | Minimum | Why that floor | Vendor |
|---|---|---|---|
| **Node.js** | **24.0.0** | Enforced by the root `engines` field. 24 is the active LTS line, supported to April 2028 | [nodejs.org](https://nodejs.org) · [releases](https://nodejs.org/en/about/previous-releases) |
| **pnpm** | **10** | Workspace protocol + the lockfile format this repo ships. The `packageManager` field pins **10.34.5**, so Corepack fetches that exact version whatever else is installed | [pnpm.io](https://pnpm.io) · [install](https://pnpm.io/installation) |
| **Corepack** | bundled with Node | Ships with Node 24; the pin above only works through it | [Corepack docs](https://nodejs.org/api/corepack.html) |
| **Git** | any current | Cloning and the release workflow | [git-scm.com](https://git-scm.com) |
| Docker Engine | 24+ | Optional — only for the [container](#docker). 24 is where BuildKit became the default builder, which the Dockerfile's cache mounts need | [docker.com](https://www.docker.com) · [install](https://docs.docker.com/engine/install/) |
| Docker Compose | v2+ | Optional — the `docker compose` subcommand, not the retired `docker-compose` script | [Compose docs](https://docs.docker.com/compose/) |

Downstream, for output: [OBS Studio](https://obsproject.com) 28+ (browser source with
transparency) or [vMix](https://www.vmix.com) 25+ (Web Browser input). Neither is
needed to run or author — any Chromium-based browser will show a graphic.

Verified against Node 24.18.1 and pnpm 10.34.5 as of August 2026. Newer point
releases on the same major are fine; **pnpm 11 is out and this repo does not use
it yet** — Corepack handles that for you, so let it.

The build steps below are identical on every platform once Node is installed;
only the Node install command differs. If you would rather not install Node at
all, skip to [Docker](#docker).

Get the source first:

```bash
git clone https://github.com/dwclarkphx/breeze-overlay.git
```

That leaves you in a `breeze-overlay` directory. Substitute your own checkout
path for the placeholder in each block below.

**Windows 11**

```powershell
cd <drive>:\path\to\breeze-overlay
corepack enable          # or: npm i -g pnpm@10
pnpm install
pnpm -r build
pnpm --filter @breeze/server start
```

Install Node with `winget install OpenJS.NodeJS` or from <https://nodejs.org>.
Under WSL2, follow the Linux steps inside the distro rather than these —
crossing the `/mnt/<drive>` boundary makes `pnpm install` several times slower
and breaks file watching in `pnpm dev`. Keep the checkout on the Linux
filesystem, not on a mounted Windows drive, if you work in WSL2.

**macOS** (Apple silicon and Intel)

```bash
brew install node@24         # or: nvm install 24 && nvm use 24
cd /path/to/breeze-overlay
corepack enable
pnpm install
pnpm -r build
pnpm --filter @breeze/server start
```

`brew install node@24` is keg-only, so Homebrew will print a `PATH` line to add
to your shell profile; without it `node -v` still reports whatever version was
there before. If macOS firewall prompts on first start, allow incoming
connections — otherwise the server binds fine but no other machine on the LAN
can reach the browser-source URL.

**Linux**

```bash
# Debian/Ubuntu — the distro's `nodejs` package is usually far too old.
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
# Fedora/RHEL:  sudo dnf module install nodejs:24
# Arch:         sudo pacman -S nodejs npm
# Any distro:   nvm install 24 && nvm use 24   (no root needed)

cd /path/to/breeze-overlay
corepack enable              # sudo corepack enable if node came from a package manager
pnpm install
pnpm -r build
pnpm --filter @breeze/server start
```

Ports below 1024 need root; 7331 does not, so run the server as an ordinary
user. For an unattended install, run it under systemd rather than a login
shell — or use the container, which handles restart-on-boot already.

**All platforms.** On pnpm 9 under Node 22+, `pnpm install` emits a `DEP0169
url.parse()` deprecation warning from pnpm's own bundled `npm-package-arg` and
`normalize-package-data` — harmless, but noisy, and gone in pnpm 10. The
`packageManager` field pins the version, so `corepack enable` gets the right one
automatically.

Then open `http://<host>:7331/`. On first run the server seeds a demo project from `examples/lower-third.json`.

`<host>` is whatever reaches the machine running the server — `localhost` if
that is the machine you are sitting at, otherwise its LAN address or hostname.
The server binds `0.0.0.0` by default, and logs the addresses it can be reached
on at startup, so use one of those. The browser-source URL in particular is
almost never `localhost`: it gets pasted into vMix or OBS on a *different*
machine, and `localhost` there means the switcher itself. The User Guide covers
this at [About addresses](docs/USER-GUIDE.md#about-addresses).

| URL | Purpose |
|---|---|
| `http://<host>:7331/editor/` | **The editor** — stage, layers, properties, timeline |
| `http://<host>:7331/control/demo/l3rd-name` | **Operator panel** — play/stop/next and live field edits |
| `http://<host>:7331/` | Project index |
| `http://<host>:7331/play/demo/l3rd-name` | **Browser-source URL** — transparent, 1:1, waits to be triggered |
| `…/play/demo/l3rd-name?scale=contain&debug=1` | Preview in a normal browser window, with an FPS/state overlay |
| `…/play/demo/l3rd-name?name=Jane&title=Reporter` | Seed dynamic fields straight from the query string |
| `…/play/demo/l3rd-name?autoplay=1` | Roll the graphic as soon as the page loads |

An output page shows **nothing** until it is told to play. Adding a Browser Source in OBS, or opening the URL to check it, must not put a graphic to air — that is the control panel's job, or a REST trigger's. `?autoplay=1` opts back in for the simple workflow where the source appearing in the switcher *is* the cue.

Dev mode with rebuild-on-save: `pnpm dev` for the server. For editor hot reload run `pnpm dev:editor` in a second terminal and open <http://localhost:7332/> — it proxies the API to the real server, so dev and production cannot drift.

This one really is `localhost` and not `<host>`. Vite's dev server binds
loopback unless told otherwise, and its proxy targets `127.0.0.1:7331`, so the
dev editor has to run on the same machine as the server and is not reachable
from another one. That is a development convenience, not a deployment: point
switchers at the built editor on port 7331. To reach it from elsewhere anyway —
a tablet on the bench, say — run `pnpm dev:editor -- --host` and expect the
proxy to still look for the API on its own loopback.

### Editor

For a walkthrough with screenshots, see the **[User Guide](docs/USER-GUIDE.md)**. The table below is the short reference.

| | |
|---|---|
| Select / move / scale / rotate | Click a layer, drag the handles on stage |
| Pan / zoom stage | Alt-drag or middle-drag to pan, Ctrl+wheel to zoom |
| Animate a property | Click its ⏱ stopwatch, then change the value at a new playhead position |
| Edit easing | Double-click a keyframe |
| Move when a layer exists | Drag its bar in the timeline; drag the bar's edges to trim in/out |
| Add a hold point | **+ STOP** in the timeline toolbar |
| Undo / redo | Ctrl+Z / Ctrl+Shift+Z |
| Save | Ctrl+S |
| Play / pause | Space |
| Copy / paste keyframes | Ctrl+C / Ctrl+V (pastes at the playhead) |
| Delete | Removes selected keyframes, or the selected layer if none |

A new layer starts at the playhead, as in After Effects — so adding one with the playhead parked late gives it a late in-point. Drag its lifetime bar back, or set **In** to 0 in the properties panel.

Timeline: Ctrl+wheel zooms about the cursor, Shift+wheel scrolls. Dragged keyframes and markers snap to other keyframes, markers, the playhead and the composition bounds; failing all of those they snap to whole frames at the composition's fps.

### Pointing vMix or OBS at it

1. Note the LAN address the server logs on startup (it binds `0.0.0.0` by default).
2. **vMix** → Add Input → Web Browser → URL `http://<host>:7331/play/demo/l3rd-name`, size 1920×1080.
3. **OBS** → Sources → Browser → same URL, width 1920, height 1080. No custom CSS needed — the page is transparent by default.

In a preview tab: `space` play · `→` next · `esc` stop · `backspace` clear.

### Environment

| Variable | Default | Notes |
|---|---|---|
| `BREEZE_PORT` | `7331` | |
| `BREEZE_HOST` | `0.0.0.0` | Set to `127.0.0.1` to keep it off the LAN |
| `BREEZE_DATA_DIR` | `<repo>/data` | Projects and uploaded assets |
| `BREEZE_API_KEY` | *(empty)* | When set, mutating `/api/*` calls need `x-breeze-key` |
| `BREEZE_LOG_LEVEL` | `info` | |
| `BREEZE_EDITOR_DIR` | `<repo>/apps/editor/dist` | Where the built editor is served from — only needed if serving a differently-located editor build |
| `BREEZE_DATA_POLLING` | `1` | `0` disables all data-source polling. Off in tests, so no suite touches the network |
| `BREEZE_DATA_ALLOW_HOSTS` | *(empty)* | Comma-separated hosts the data fetcher may reach despite resolving to a private address. A leading dot matches subdomains (`.scores.lan`). See [SSRF](#data-sources-and-tables) |
| `BREEZE_CONTACT` | *(empty)* | Who this server is, for the outgoing `User-Agent` — `mystation.com, ops@mystation.com`. **Set this.** See [User-Agent](#user-agent) |
| `BREEZE_DATA_SECRETS` | *(empty)* | `id=value` pairs for data-source credentials — `sheets=AIza…,league=abc123` |
| `BREEZE_DATA_SECRETS_FILE` | *(empty)* | Path to a JSON object of `id → credential`. Use this for anything with newlines in it, notably a Google service-account key; the comma-separated form above cannot represent one. Merged over `BREEZE_DATA_SECRETS` |

---

## Docker

```bash
cp env.breeze .env        # set BREEZE_PORT and BREEZE_CONTACT
docker compose up -d --build
docker compose logs -f
```

Needs Docker Engine 24+ with the Compose v2 plugin. Nothing else — Node, pnpm
and the toolchain live in the build stage and never touch the host.

`env.breeze` is the tracked template and holds placeholders only; `.env` is
gitignored and is what Compose loads automatically. If you would rather edit
`env.breeze` in place, pass it explicitly — and add it to `.gitignore` first,
or your API key ships to GitHub with the next push:

```bash
docker compose --env-file env.breeze up -d --build
```

It has to be the `--env-file` flag rather than an `env_file:` key in the compose
file. `env_file:` passes variables into the container, but Compose interpolates
`${BREEZE_PORT}` in the `ports:` mapping before the container exists — so
`env_file:` alone would publish 7331 whatever the file said.

### Changing the listen port

Edit one line in `.env` (or `env.breeze`, if you took the second route above):

```ini
BREEZE_PORT=8080
```

Then `docker compose up -d`. Compose recreates the container with the new
published port and the new `BREEZE_PORT` in its environment.

Host and container port are deliberately kept identical. The server logs the
LAN browser-source URLs from its own listen port, and those URLs get pasted
straight into vMix or OBS — publishing `8080:7331` would print
`http://192.168.1.20:7331/play/...`, which does not answer from the switcher
machine. If you genuinely need them to differ, change the `ports:` line by hand
and remember the logged URLs are then wrong.

### What is in the image

Two stages. The builder installs the full workspace and compiles
`packages/schema`, `packages/runtime`, the server and the React editor. The
runtime stage carries compiled output plus production dependencies only — no
TypeScript, no Vite, no Playwright. The editor's React tree is skipped too:
Vite already bundled it into `apps/editor/dist`, so installing it again would
add about 90 MB nothing imports.

GSAP is not installed in the runtime stage at all — it is a devDependency, and
nothing bundles it. The two files the pages actually load were staged into
`apps/server/public/vendor/gsap/` by the builder and travel with the rest of
that directory, which the runtime stage already copies wholesale.

The workspace directory layout is reproduced inside the image rather than
flattened. `apps/server/src/config.ts` derives `REPO_ROOT` from where the
server's own `dist/` sits and finds `examples/` and `apps/editor/dist` relative
to it, so collapsing the tree breaks the first-run seed and the editor mount —
and does it silently, at run time, not at build.

Base image is `node:24-slim` rather than Alpine because `ssh2` (the SFTP drop
source) and `esbuild` both resolve platform-specific binaries, and glibc is the
variant those publish first. Alpine works if the ~60 MB matters to you: swap
both `FROM` lines and add `apk add --no-cache libc6-compat`.

### Data, fonts and credentials

| Concern | How |
|---|---|
| Projects and assets | Named volume `breeze-data` at `/app/data`. `docker compose down` keeps it; **`down -v` destroys every project on the server** |
| Backup | `docker run --rm -v breeze-data:/d -v "$PWD:/out" alpine tar czf /out/breeze-backup.tgz -C /d .` |
| Editing projects from the host | `docker compose cp breeze:/app/data/projects ./projects-backup`, or switch the volume to a bind mount |
| Credentials | `BREEZE_DATA_SECRETS` in `.env` for simple values; for a Google service-account key use the commented `BREEZE_DATA_SECRETS_FILE` bind mount — a multi-line key cannot go in the comma-separated form |
| Fonts | **A font a graphic names must exist inside the container.** The base image ships almost none, so an unresolved family falls back silently and the graphic goes to air in the wrong typeface. Uncomment the `/usr/share/fonts` mount, or add the font files to the image |

`/healthz` backs a container healthcheck that reads `BREEZE_PORT` at run time,
so a remapped port does not leave a healthy server reported unhealthy.

### Pointing OBS or vMix at the container

Same as a bare-metal install, with one wrinkle: the addresses the server logs
on startup are the *container's* interfaces, not the host's. Use the Docker
host's LAN address with the published port —
`http://<docker-host>:7331/play/demo/l3rd-name`.

Docker Desktop on Windows and macOS runs containers inside a VM, so a container
port is reachable from the LAN only through the published mapping above; there
is no container IP the switcher can route to. On Linux this is also why
`network_mode: host` is tempting — it works, and it makes `BREEZE_PORT` the
only port setting that matters, but it gives up the isolation and does nothing
on Docker Desktop.

### Building without Compose

```bash
docker build -t breeze-overlay:local .
docker run -d --name breeze -p 7331:7331 \
  -e BREEZE_CONTACT="mystation.com, ops@mystation.com" \
  -v breeze-data:/app/data breeze-overlay:local
```

---

## Layout

```
packages/schema    Composition format: TS types, JSON Schema, Ajv validation, bindings, factories
packages/runtime   The single renderer — composition JSON → DOM + GSAP timeline
apps/server        Fastify: project CRUD, /play output pages, asset serving, editor hosting
apps/editor        React editor — stage, layers, properties, timeline, easing
examples/          Hand-authored demo project (lower third + badge + news ticker)
tests/e2e          Playwright suites driving the output page and the editor in Chromium
```

**Validation is a subpath import.** `@breeze/schema` gives you types, factories, bindings and timing helpers; `@breeze/schema/validate` gives you Ajv-backed validation. They are separate because `validate` instantiates Ajv and compiles the schemas at module load — an untree-shakeable side effect that no browser consumer should inherit. The server and tooling import the subpath; the editor and runtime do not.

**Every document mutation is a serializable command.** `apps/editor/src/state/commands.ts` holds pure reducers from `(composition, command)` to a new composition; nothing mutates the document directly. Undo restores the pre-command snapshot rather than inverting the command — inverting would need a correct inverse for every command kind, and one wrong inverse corrupts a document silently. Rapid same-property commands coalesce, so a drag is one undo step.

**One renderer, two consumers.** The editor preview and the served `/play` page both instantiate `BreezeRuntime`. There is no second rendering path, so what the operator sees in the editor is what goes to air.

## Control surface

Four verbs, available everywhere — the vocabulary broadcast operators already know:

```js
play()                          // intro, then hold at the next STOP marker
next()                          // advance to the following STOP marker
stop()                          // run the outro, ignoring remaining markers
update({ name: 'Jane Doe' })    // replace bound fields live, on air
update('{"name":"Jane Doe"}')   // vMix and OBS scripts send a JSON string
seek(1.5)                       // debugging / thumbnails
```

On an output page these are on `window`, with the runtime itself at `window.breeze.runtime`.

Composition lifecycle: `idle → playing-in → holding → playing-out → finished`. A `stop` marker is where the graphic parks on air; everything after it is the outro.

A **step** is a state the graphic can hold in, so `stepCount` equals the number of STOP markers (minimum 1). The outro is not a step — you cannot park on it and `next()` never lands there. `runtime.currentStep` is 0 before the first hold and 1-based thereafter, so a status readout is just `currentStep/stepCount`.

The verbs are deliberately non-overlapping, and **PLAY can never take a graphic off air**:

| verb | what it does |
|---|---|
| `play()` | walks forward: rolls in, then resumes to the next STOP marker, then runs the outro. Ignored mid-intro so a double-press cannot stutter it; rewinds first from idle, finished or the very end |
| `next()` | advances to the next STOP marker |
| `stop()` | runs the outro; ignored when already off air or already leaving |
| `clear()` | hard reset to frame 0, nothing on screen |
| `playThrough()` | preview only: runs to the end ignoring STOP markers. The editor's ▶ |

Repeated PLAY therefore steps a graphic all the way through — the one-button workflow. The editor's transport is deliberately different: authoring wants to watch an animation end to end, so ▶ ignores holds unless the **Holds** toggle in the timeline toolbar is on.

### Frame rate in OBS

A Browser Source ticks at the OBS output frame rate unless **Use custom frame rate** is enabled in its properties. If the debug overlay reports 30 fps, check Settings → Video → FPS; the page cannot paint faster than CEF ticks it.

## Composition format

Every layer can carry keyframe tracks on `x, y, scaleX, scaleY, rotation, opacity, skewX, skewY, blur, brightness, maskOffset` — transform, opacity and filter only, never layout properties, so CEF keeps everything on the compositor.

```jsonc
{
  "id": "bar", "type": "shape", "shape": "rect",
  "size": { "width": 900, "height": 100 },
  "transform": { "x": 120, "y": 870, "anchorX": 0, "anchorY": 0.5 },
  "keyframes": {
    "x": [
      { "t": 0,   "v": -960, "ease": "power3.out" },
      { "t": 0.6, "v": 120,  "ease": "none" },      // intro lands
      { "t": 1.5, "v": 120,  "ease": "power3.in" }, // STOP marker sits here
      { "t": 2.1, "v": -960 }                       // outro
    ]
  }
}
```

Layer types: `shape`, `text`, `image`, `video`, `crawl`, `table`, `group`, `composition`.

Any layer with a `binding` becomes an operator-editable dynamic field. `GET /api/projects/:id/compositions/:compId/bindings` returns the descriptor list plus a JSON Schema — the same block the control panel builds its form from. Binding kinds are `string`, `image`, `video`, `stringList` (a crawl's items) and `dataset` (a table's rows, which the control panel renders as an editable grid).

A layer bound to a *data source* uses `source` instead — `table` and `crawl` both take one, and the server pushes matching DataSets under the reserved `$data` update key. The two mechanisms coexist: a source keeps the graphic fed, a binding lets the operator override it.

### Nested compositions

A `composition` layer inlines another composition, After Effects precomp style:

```jsonc
{
  "id": "badge", "type": "composition", "ref": "badge",
  "in": 0.3,                              // doubles as the precomp start time
  "overrides": { "badgeText": "LIVE" }    // pins this field for this instance
}
```

- Nested layers are inlined into the **same** timeline — one playhead, which is what lets `seek()` and editor scrubbing land on a single coherent frame.
- Nested layer ids are namespaced (`badge/chip`), so the same composition can be instantiated twice in one graphic.
- A field named in `overrides` is **pinned**: a parent `update()` will not overwrite it. That is what lets one badge comp appear twice reading `HOME` and `AWAY`.
- The nested composition's own STOP markers are ignored; only the root defines playback steps.
- Cycles, unresolvable refs and nesting past 8 levels produce a warning on `runtime.warnings` and render nothing, rather than failing the whole graphic.

### Masks

Masks are real SVG `<mask>` elements, not `clip-path` — `clip-path` can neither feather nor invert, which are the two things broadcast masks are for.

```jsonc
"mask": { "type": "rect", "x": 0, "y": 0, "width": 120, "height": 40, "feather": 6, "invert": false }
```

`feather` becomes a genuine `feGaussianBlur`; `invert` punches a hole; the `maskOffset` keyframe track slides the mask along X for wipe reveals.

### Video layers

Videos are slaved to the composition playhead rather than running on their own clock, so a stinger stays in sync with the graphic around it and scrubs correctly in the editor. `startAt` is the composition time at which media frame 0 plays; past the end a non-looping clip holds its last frame rather than going black.

**Fit Width** condenses long text horizontally to fit `fit.maxWidth`, but never below `fit.minScale` (default `0.5`) — squashing a name past that is less useful than letting it run long. When the floor is hit, the layer gets `data-fit-overflow="1"` and the id appears in `runtime.overflowingTextLayers`, so the editor can flag a strap that is too short for its content instead of discovering it on air.

Easing accepts GSAP names (`"power3.out"`), a cubic bezier (`{ "type": "cubicBezier", "points": [.4,0,.2,1] }`) or steps (`{ "type": "stepped", "steps": 4 }`). Structured eases are evaluated by our own solver, so the editor's curve preview and playback use identical math.

## API

```
GET    /healthz
GET    /api/projects
POST   /api/projects                                  { name, id? }
GET    /api/projects/:id
PUT    /api/projects/:id
DELETE /api/projects/:id
GET    /api/projects/:id/compositions
GET    /api/projects/:id/compositions/:compId
PUT    /api/projects/:id/compositions/:compId
DELETE /api/projects/:id/compositions/:compId
GET    /api/projects/:id/compositions/:compId/bindings
POST   /api/validate/composition
GET    /play/:id[/:compId]
GET    /assets/:id/*

GET    /api/projects/:id/datasources                  defs + health; ?rows=N to include rows
GET    /api/projects/:id/datasources/:sourceId        ?rows=N
PUT    /api/projects/:id/datasources/:sourceId
DELETE /api/projects/:id/datasources/:sourceId
POST   /api/projects/:id/datasources/:sourceId/refresh
POST   /api/projects/:id/datasources-preview          { def, transforms? } — try one without saving
POST   /api/projects/:id/datasources-inspect          { url } — suggest a JSON row path
POST   /api/projects/:id/datasources-inspect-xml      { url } — rank candidate XML row elements
```

Definitions and health come back together from `GET …/datasources` on purpose: the panel shows them side by side, and a source whose def says "every 10s" next to a status saying "last fetch 40 minutes ago" is exactly the picture an operator needs. Assembling that from two round trips invites showing a stale half of it.

`datasources-preview` and the two `inspect` routes answer `200` with `{ ok: false, error }` rather than a 4xx. A URL that is wrong while it is being typed is the normal case, not an exception — the panel renders the message beside the field.

## Tests

```powershell
pnpm test             # 676 unit + integration tests (Vitest)
pnpm typecheck
pnpm test:e2e         # 186 Playwright tests — needs `pnpm exec playwright install chromium` once
pnpm test:e2e:only diagnostics   # one spec, by name
```

The Playwright config lives with the suite it configures, at `tests/playwright.config.ts`. Both scripts above pass it with `-c`; a bare `pnpm exec playwright test` reports no tests found, because Playwright only auto-discovers a config at the repo root.

`typecheck` and `test:e2e` build `packages/*` first, on purpose. `start` and `dev` run whatever is already in `dist/` and `public/`, so a harness that skips the build silently tests the *previous* bundle — a green run that proves nothing.

The runtime suite drives GSAP with `gsap.updateRoot()` rather than wall clock, so lifecycle assertions are deterministic. The Playwright suite then re-checks the same behavior in Chromium against real computed transforms — the same engine family vMix and OBS embed.

## Known gaps

- **Not validated in real vMix.** OBS is confirmed working (transparency and live control-panel updates both correct, 2026-07-28) — vMix, sustained 60fps under GPU load, and browser-source reconnect behavior still need a real-world pass; headless Chromium cannot prove any of them.
- **Pen tool / bezier path shapes** are Phase 8; only rect and ellipse exist.
- **Text reveals do not animate out.** A preset covers the entrance; the exit is the layer's own keyframes, as the demos do it. A mirrored out-reveal has to negotiate with hand-authored outro keyframes on the same layer, which is a Phase 9 question.
- **Reveal pieces are unmasked.** `chars-up` and its siblings slide and fade rather than rising from behind a hard edge. Masking each piece means a wrapper element per character for Fit Width to measure through; revisit with the Phase 8 mask system.
- **A transcoded stinger has not yet been confirmed in a real OBS Browser Source.** The encode is proven correct at the file level — alpha decodes back 0→255, monotonic — but "clean edges in OBS" is a claim only OBS can settle.
- **PSD import, image sequences and sprite-sheet playback** are the remaining pieces of Phase 7; video layers otherwise play MP4 natively or transcoded WebM-alpha.
- **Layer size cannot be animated.** Only `scaleX`/`scaleY` are keyframable; there is no `width`/`height` track.
- **Rubber-band keyframe selection** is implemented and tested but not yet wired to a drag gesture in the timeline.
- **Nested composition layers** render correctly in the preview but cannot be edited in place — open the nested project directly instead.
- **A newly added layer's timeline row isn't scrolled into view**, so it's easy to lose track of if the playhead adds it off-screen.
- **A dragged layer's position updates on release, not continuously during the gesture.**
- **The control hub retains channel state indefinitely**, with no per-show reset — long-running installs accumulate state in memory.

## Operating a show

Open `/control/<project>/<composition>` on a laptop or tablet. Type into the fields, hit **PLAY**, and the graphic rolls on every output page connected to that composition. Edits apply live — the graphic does not need re-playing — and **NEXT** appears only on graphics with more than one hold.

Outputs and panels join a channel per composition over `/ws/control`. The hub retains each channel's field values, so a browser source that drops mid-show reconnects and comes back showing the name the operator typed rather than the placeholder baked into the composition.

### Triggering from Companion, Stream Deck or a switcher

```
POST or GET  /api/control/<project>/<composition>/play
                                              /stop
                                              /next
                                              /clear
POST         /api/control/<project>/<composition>/update    body: {"name":"Jane Doe"}
GET          /api/control/<project>/<composition>/update?name=Jane%20Doe
GET          /api/control/<project>/<composition>/state
```

The verbs accept GET as well as POST. That is deliberate: a side-effecting GET is poor REST, but Stream Deck's "open URL" action and most Companion HTTP presets cannot send a body or set headers, and refusing them pushes people toward turning auth off entirely.

Each response reports `delivered` — how many outputs actually received the command. `delivered: 0` means the button worked and nothing was listening, which is the failure an operator most needs to see.

With `BREEZE_API_KEY` set, control actions need the key as either an `x-breeze-key` header or a `?key=` query parameter. Reads — the output page, the panel, `/state` — stay open so a browser source never needs credentials.

## Text reveals

A text layer can carry a `textAnimPreset`, and the runtime splits it and staggers the pieces in at the layer's in-point:

```json
"textAnimPreset": { "id": "chars-up", "stagger": 0.02, "duration": 0.45, "ease": "power3.out" }
```

Six presets over two axes — `chars` / `words` / `lines` × `-up` / `-fade`. Only `id` is required; the timings default per preset and are scaled per unit, because a 0.02s stagger that reads clearly across forty characters is invisible across four lines. `demo / Lower Third — Reveal` is a name strap using `chars-up` with a `words-fade` title.

Three things about it are deliberate:

- **The reveal animates the pieces; the layer's keyframes animate the layer.** They compose rather than compete, so a strap can slide in as a whole while its characters rise inside it.
- **Fit Width measures the split boxes, because those are what go to air.** Splitting turns the text into a row of inline-blocks that measures a few pixels wider than the shaped text it replaced, since the per-character boxes lose the kerning between them. Fitting the plain text instead — which 0.37 did, on the argument that it is the authored truth — left about four pixels of a 700px strap hanging off the end of the bar. The fit therefore runs after the split, and again after every re-split.
- **A layer's text is only measurable while it is laid out.** A layer outside its visibility window is `display: none`, where `offsetWidth` is 0, so Fit Width un-hides it for the measurement rather than reading a zero as "it fits". That mattered for the ordinary workflow: a name typed in before PLAY is typed into a hidden strap.
- **`lines` presets need real line breaks.** Text layers are `white-space: pre`, so copy never wraps on its own — a single-line strap splits into one line and `lines-up` reveals it as a whole. Put `\n` in the content to get lines.
- **Live updates re-split.** The split is reverted before new text is written — reverting afterwards would restore the markup SplitText recorded and quietly discard what the operator just typed — and the reveal is rebuilt so it can play again. A name corrected during the hold stays visible.

The properties panel reports the measured piece count and the reveal's real total, and warns when that total overruns the time before the graphic's hold.

## Data sources and tables

One rule: **one canonical data shape, many adapters.** Every source — a pasted table, an HTTP feed, a news RSS URL, a private Google Sheet — normalizes into a `DataSet` before anything downstream sees it. Layers bind to columns and never learn where the rows came from. Full design in `dev/docs/DATA-SOURCES.md`.

```jsonc
{
  "id": "standings",
  "columns": [{ "key": "team", "type": "string" }, { "key": "w", "type": "number" }],
  "rows": [{ "team": "Mesa", "w": 11 }, { "team": "Chandler", "w": 9 }],
  "fetchedAt": "…", "revision": 17     // bumped only when the content hash changes
}
```

### Adapters

| Type | What it takes | Notes |
|---|---|---|
| `manual` | Rows typed or pasted into the editor | Stored in the project. Needs no connectivity, and is operator-editable on air |
| `http-csv` | A CSV/TSV URL | **Covers published Google Sheets with no API key** — use the sheet's `Publish to web → CSV` URL. The recommended path for Sheets |
| `http-json` | A JSON URL + a dot/bracket path to the row array | `data.standings[0].teams`; blank means the root array |
| `rss` | An RSS 2.0, RSS 1.0/RDF or Atom URL | Normalized to fixed columns — `title`, `link`, `date`, `description`, `author`, `category`, `image`, `guid` — so a graphic survives the feed changing software |
| `xml` | Any XML URL + a slash path to the repeating element | `results/game`. Child elements and attributes become columns; `<score home="4"/>` becomes `score_home` |
| `sheets` | A spreadsheet id/URL + A1 range | Sheets API v4, for sheets that must stay **private**. API key for link-shared, service-account JSON for private |
| `weather` | A provider + latitude/longitude | NWS, MET Norway, Bright Sky (DWD) or Open-Meteo, normalized to one column set. See [Weather](#weather) — the license differs by provider |
| `ftp` | Host + directory + filename pattern | FTP/FTPS/SFTP. Takes the newest file matching `results-*.csv` and hands it to the CSV/JSON/XML/RSS readers above |

Sources are polled per-source (5s floor, higher for weather — see below), with ETag/If-Modified-Since where the origin honours them and a SHA-256 content hash deciding whether anything actually changed — a feed polled every five seconds must not re-render a table every five seconds. Failures back off exponentially and **never touch the rows**: last-good data survives an origin outage, a DNS failure and a server restart mid-show. The editor's data panel shows last fetch, last change and last error per source, so a dead feed is diagnosed there rather than by staring at a frozen graphic.

### Weather

A weather source names a **provider and a place**, not a URL. That is what makes the license enforceable: the terms below are a property of the provider, and an editable URL field would make every one of them advisory.

| Provider | Coverage | Commercial use | Attribution | Poll floor |
|---|---|---|---|---|
| `nws` — [api.weather.gov](https://www.weather.gov/disclaimer) | US and territories | ✅ Yes — US federal work, public domain | Not required (we send one anyway) | 300s |
| `met-norway` — [Locationforecast](https://api.met.no/doc/License) | Worldwide; sharpest in the Nordics | ✅ Yes — NLOD 2.0 / CC BY 4.0 | **Required** — credit MET Norway | 900s |
| `brightsky` — [Bright Sky / DWD](https://brightsky.dev) | Germany and surroundings | ✅ Yes — DWD open data | **Required** — credit DWD/Bright Sky | 900s |
| `open-meteo` — [hosted](https://open-meteo.com/en/licence) | Worldwide | ❌ **Non-commercial only** | **Required** — CC BY 4.0 | 900s |
| `open-meteo-self` — self-hosted | Worldwide | ✅ Yes | **Required** — CC BY 4.0 | 60s |

MET Norway, like NWS, wants identifiable traffic: fill in a contact or set `BREEZE_CONTACT`, or risk being blocked with no way for them to reach you. Its one prohibition is passing your service off as Yr, NRK or MET Norway — the built-in `attribution` string credits them as a source, which is the permitted form.

**Read this before putting Open-Meteo on air.** Open-Meteo's *hosted* API is free for non-commercial use only; a channel or site carrying advertising or subscriptions is commercial use under their terms and needs either a paid plan or a self-hosted instance. The *data* is CC BY 4.0 either way, which permits commercial use — so running your own instance ([AGPLv3, Docker](https://github.com/open-meteo/open-meteo)) removes the commercial restriction but **not** the attribution obligation. Open-Meteo's license asks for a credit and a link next to any location their data is displayed:

> `Weather data by Open-Meteo.com` → https://open-meteo.com/

A broadcast graphic cannot carry a hyperlink, so the practical compliance is a visible on-screen credit. Every weather source exposes an `attribution` column carrying the right string for its provider — bind a text layer to it and the credit travels with the graphic rather than depending on someone remembering.

The free tier is also capped at 10,000 calls/day and 300,000/month. The 900s floor means one source costs ~96 calls/day, so roughly a hundred sources fit inside the daily allowance; a self-hosted instance has no such cap and drops to a 60s floor. Nothing here recomputes faster than hourly in any case.

Every provider returns the **same columns** — `time`, `temp`, `tempMin`, `tempMax`, `feelsLike`, `condition`, `icon`, `precipProb`, `precipAmount`, `windSpeed`, `windGust`, `windDir`, `humidity`, `pressure`, `uvIndex`, `isDay`, `attribution` — so switching provider does not mean rebuilding the graphic. Fields a provider does not supply come back null rather than absent. `icon` is a fixed keyword (`clear`, `partly-cloudy`, `thunderstorm`, …) rather than a provider icon URL or a WMO number, so it maps onto your own artwork once.

Pointing at a self-hosted instance on loopback needs the fetch guard opened for it:

```
BREEZE_DATA_ALLOW_HOSTS=localhost
```

**Pin the model on a self-hosted instance.** Left blank, the adapter asks for Open-Meteo's `best_match`, which selects from the models Open-Meteo *knows about* — while your instance only holds the ones you have actually synced. Put the model id in the source's **Model** field (`ncep_gfs_seamless`) and it goes out as `&models=…`, matching what you would build in Open-Meteo's own API URL generator. **Time zone** defaults to `auto`, which resolves from the coordinates; set it explicitly when the graphic should read in the station's clock rather than the forecast location's, or when a self-hosted instance has no timezone database.

Because Open-Meteo fails the *whole* request when one requested variable is unavailable — rather than omitting that series — a model-pinned instance that has temperature but not UV would otherwise return nothing. The adapter retries once without the optional variables (`uv_index`, `uv_index_max`, `apparent_temperature_max`, `is_day`) when the error names one of them, and only then; a timeout or a bad coordinate is reported as-is rather than being retried into a worse message.

### User-Agent

Set `BREEZE_CONTACT` on any server that fetches data. It becomes the outgoing `User-Agent`:

```
BREEZE_CONTACT="mystation.com, ops@mystation.com"
→ User-Agent: BreezeOverlay/0.60.0 (mystation.com, ops@mystation.com)
```

The product token carries the running version, so the string changes with each release — match on `BreezeOverlay/` rather than the whole token if you are filtering your own logs.

api.weather.gov [requires](https://www.weather.gov/documentation/services-web-api) a User-Agent and documents why the value matters: *"the more unique to your application the less likely it will be affected by a security event. If you include contact information (website or email), we can contact you if your string is associated to a security event."*

Both halves of that are the argument for setting it, and the second is sharper than it looks. Breeze's built-in fallback is **shared by every install in the world**, so a server running on the default has its traffic judged alongside every other Breeze deployment's — one careless install polling NWS in a loop can get the string throttled for all of them, and NWS has no way to warn anyone. A station that sets `BREEZE_CONTACT` is no longer downstream of a stranger's behavior and is reachable before it gets blocked rather than after.

It applies to every outgoing fetch, not just weather — RSS feeds, JSON endpoints and CSV origins all get it. A weather source can override it per-source (**Contact** in the panel) for the rare case of one server acting for several stations; the server-wide setting is the one to reach for first. Resolution order is source → server → fallback.

### File drops (FTP/SFTP)

The league-office workflow: a directory gains `results-2026-08-03.csv` every few minutes and the graphic should show the newest one. The adapter resolves *newest file matching the pattern* and hands the body to the same readers the HTTP adapters use, so the same CSV over SFTP and over HTTPS produce identical tables. Patterns take `*` and `?`; ties on modification time break on filename descending, because minute-resolution FTP timestamps are common and a graphic must not flip between two files on alternate polls.

Credentials follow the same rule as everywhere else — the def carries a `secretId` and a username, never a password. A `secretId` whose value begins with a PEM header is used as an SSH key; anything else is a password. A drop box on the venue LAN is refused until its host is added to `BREEZE_DATA_ALLOW_HOSTS`; that is the expected configuration here rather than an emergency escape hatch, but it stays opt-in because the editor accepts a hostname from anyone who can open it.

### Tables

A `table` layer is a template row the runtime clones per data row. Cells are ordinary layers carrying `cell: '<columnKey>'`, which is what keeps tables inside the existing layer system — Fit Width, text styling and masks work per cell for free.

```jsonc
"transforms": [
  { "op": "sort", "key": "w", "dir": "desc" },
  { "op": "rank" },
  { "op": "sort", "key": "team", "dir": "asc" }
]
```

Transforms are stored with the *consumer*, not the source, so two graphics can slice one feed differently. `rank` is a pipeline step rather than a table option precisely so the above works: an alphabetical table that still shows league position. A sort-order change animates rows to their new y with FLIP — the standings shuffle — and `rowsPerPage` pages through overflow on `next()` while holding, without spending a stop marker.

### Tickers from a feed

An RSS feed is a ticker, so a crawl layer can take one column of a source as its items:

```jsonc
{ "type": "crawl", "source": "headlines", "column": "title",
  "transforms": [{ "op": "sort", "key": "date", "dir": "desc" }, { "op": "limit", "n": 5 }],
  "items": ["Waiting for the headline feed…"] }
```

`items` stays as the authoring placeholder and the offline fallback — a feed that answers with nothing leaves the last good headlines up, because an empty crawl is a blank strip on air. New copy joins the rotation at the loop seam, never as a repaint, whether it came from a feed or from an operator typing into the control panel. `demo / News Ticker — Feed` is this arrangement.

`separator` is what prints between items and again as the loop wraps. `CRAWL_SEPARATOR_PRESETS` in the schema is the list the panel offers; the padding either side of the glyph is part of the value, because the separator renders inside one continuous text run and there is nowhere else for the spacing to come from.

### Data in the editor

The stage preview is built with the project's DataSets, the same way `/play` is — ROADMAP §2 rule 1 is that the editor preview *is* the playout renderer, and a preview that could not see the data was the one place that stopped being true. `GET …/datasources?rows=N` carries rows alongside the definitions for this (capped server-side); the health poll omits it and gets counts only.

### Credentials and SSRF

Two rules, both because this server sits on the same LAN as the switcher and accepts a URL from anyone who can open the editor:

- **Credentials never enter a composition.** Source definitions live in `projects/<id>/datasources.json` and reference a server-side secret *id*; the values come from `BREEZE_DATA_SECRETS` or `BREEZE_DATA_SECRETS_FILE` and never leave the server. A composition gets exported, embedded in a single-file template and handed to a playout server — nothing that travels that way may carry a credential.
- **The fetcher refuses private and link-local addresses** by default, including IPv4-mapped IPv6 and cloud instance metadata, resolving the name itself so there is no DNS-rebinding window between the check and the request. Redirects are followed one hop at a time, each vetted. Open specific hosts with `BREEZE_DATA_ALLOW_HOSTS`.

A backup bundle carries the composition's authored rows, not a live feed. Restoring one on another machine gives you the graphic and its placeholder data; polling resumes from the source definitions once that install can reach the feed.

## Next: Phase 8

Masks (shape/path with feather, invert, animatable position), per-layer effects (blur, drop-shadow and the CSS filter family, keyframable), and editing nested compositions in place.

Still open from Phase 7, deferred deliberately: PSD import via ag-psd, image sequences (PNG sequence → video-with-alpha), and sprite-sheet playback.

## License

Breeze Overlay is licensed under the [Mozilla Public License 2.0](LICENSE). Every source file carries the MPL notice; modifications to those files must stay under MPL-2.0, while new files combined with them may be licensed as you choose (MPL §3.3). Source lives at https://github.com/dwclarkphx/breeze-overlay.

Breeze **requires** [GSAP](https://gsap.com) (GreenSock Animation Platform), (C) Webflow, but does not bundle it. `gsap.min.js` and `SplitText.min.js` are copied verbatim from the npm package into `apps/server/public/vendor/gsap/` at build time and loaded by a script tag — so no GreenSock code is compiled into any Breeze bundle, and the files can be replaced with a different GSAP release without rebuilding Breeze (see [Upgrading the animation engine](docs/USER-GUIDE.md#17-upgrading-the-animation-engine)).

GSAP is licensed separately under the [GSAP Standard License](https://gsap.com/standard-license) — free for commercial use, with its own terms that are not part of the MPL.

[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) lists every third-party package distributed with Breeze, generated from the installed production dependency tree rather than maintained by hand.


