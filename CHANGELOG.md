# Changelog

All notable changes to Breeze Overlay are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow the project rule: a feature bumps the minor version, a fix bumps the patch. Releases before 0.45.0 used two-part numbers (0.01–0.44). 1.0.0 will be the first public release.

## [0.75.0] - 2026-09-28

> The preview shows what the output shows, and says so.

### Added

- A **sync check** under the control panel's preview says whether it shows what the output shows — the hold, each paging table's page and time left, each ticker's copy and scroll position — marks what differs, and offers **Resync**.
- A page joining a graphic already on air now also scrolls each ticker in step with the output it joined, on the same copy at the same point in its scroll, instead of starting the ticker over.
- Outputs on air report where they are every five seconds, including each ticker's copy and position; panels are only sent a report when something other than time has changed.

### Fixed

- PLAY on the control panel no longer sends a table the operator has not edited. A table fed by a source with no rows of its own — a city rotation reading a Cities table — went blank on PLAY while NEXT worked, and a table with authored rows had its live data put back to them. The panel's grid for a table fed by a source now starts from the rows it actually shows.

### Changed

- A ticker starts each pass when the previous one was due to end rather than when its completion frame ran, so outputs rolled in together no longer drift apart by a frame a pass over a long show.

## [0.74.1] - 2026-09-28

### Fixed

- An output page opened while its graphic is already on air — a browser source reloaded mid-show, or the control panel's preview switched on mid-hold — now picks up from an output still on air: the same hold, each paged table on the same page with the same time left, without playing the intro again. It used to stay blank until the next PLAY. `?sync=off` keeps the old behaviour for one page.
- A preview's report no longer overwrites the channel's playback while an output is connected, so a panel no longer reads IDLE mid-show because somebody opened a preview.

### Added

- The control panel's preview has a **Sync to** menu: the newest output, any connected output by name and address, or off.
- `/state` and the control socket's state list each connected output with its own report (`sources`), and carry `reportedAt` and `now` on the server's clock.

## [0.74.0] - 2026-09-28

> Cycle, control surfaces and live data (Phase 8.6, Waves 1–8), plus browser sign-in.

### Added

- Tables can page themselves while a graphic holds, using seconds per page or a per-row duration column, and can loop, hold or continue at the end.
- Page turns animate by reversing the row reveal, and tables that share a cycle group turn together.
- New channel verbs `prev`, `page` (by number, or by key with `name=`) and `cycle` (`hold` or `resume`), plus an optional `table=` on `next`, over REST, WebSocket and `window.breeze`.
- `/state` reports each paged table's page, page count, page key and seconds left, and `?data=0` leaves field data out.
- The control panel gains ◀ PREV and, for each paged table, a page readout with a hold toggle and a countdown bar.
- The editor's table properties gain a Cycle section.
- Hub clients can identify as `client: 'companion'` and subscribe with `data: false` to receive playback state without field data, which Companion module 1.1.0 uses to go live instead of polling.
- A table can follow another table, showing only the rows that match the leader's current page key, including chains of followers.
- A new `unpivot` transform folds columns into key/value rows, such as one row per forecast day.
- Weather and air-quality sources take one place, a typed list of places, or a table of places read from another source.
- NWS and Bright Sky gain an observed-conditions mode, and NWS daily forecasts can pair day and night into one row per day and start from tomorrow after a set local hour.
- Weather rows gain `place`, `period`, `dewPoint`, `visibility`, `station` and `ageMinutes` columns.
- A CAP alerts source reads CAP XML, Atom/RSS carrying CAP fields and NWS GeoJSON, filtered by area, event and minimum severity, and drops expired and cancelled alerts.
- An air-quality source reads AirNow feeds or Open-Meteo (CAMS), with current, pollutant and forecast modes on the US or EU AQI scale.
- Every fetched source can blank its rows after a set age (`expireAfter`), with AirNow defaulting to three hours.
- Per-source data guards refuse a fetch with too few rows, a sudden drop, missing required values or out-of-range numbers, and mark a feed that stops changing as frozen.
- A source can name a backup source that goes to air when it expires, freezes or fails.
- Operators can force a source onto its own rows or its backup from the control panel's new Data block, or through `GET|POST /api/projects/:id/datasources/:sourceId/use`.
- With an API key set, a browser signs in once from the portal and gets a 12-hour session, so the editor can save and control-panel URLs no longer need the key.
- The activity log records sign-ins and data-source overrides, with filters for each.
- Pages now carry a Breeze tab icon.
- Portal copy buttons: a project's copies its key, a graphic's copies its full output URL, each with a tooltip saying what it is for.
- Layer rules show, hide, recolour or re-source a layer from a field, a source's rows, a table cell's own row, or the project mode.
- A project mode (`GET|POST /api/projects/:id/mode/set`, the control panel's Mode block, `breeze.mode()`) that every graphic's rules follow at once.
- A `date` transform keeps rows for a window of days, or those still to come or already past, in a named time zone, and moves on with the clock.
- `lookup` brings columns across from another source by a matching value, and `union` adds another source's rows.
- A Media layer plays webcam snapshots (refreshed without flicker), MJPEG streams, video files, YouTube and HLS (hls.js staged under `public/vendor/hls/`), with a timeout and hide, hold or skip on failure.
- A media cell in a cycling table makes a camera rotation: the next page's snapshot is fetched ahead of the turn, and a camera that fails can skip to the next page.
- Media checks on a source check every row's camera on a schedule, detect frozen pictures, and add `mediaState`, `mediaOk`, `mediaSrc` and `mediaKind` columns.
- A camera proxy (`/media/…`) plays snapshots and MJPEG streams through the server, one camera connection shared by every output.
- `GET|POST /api/projects/:id/datasources/:sourceId/media/check` checks every camera now; the control panel gains Check cameras, and Companion a camera-list action, feedback, variables and presets.

### Changed

- A multi-place source where only some places fail reports a warning and keeps last-good rows for those places instead of failing outright.
- Control-panel and editor data panels show a source's health as live, failing, expired, frozen or on backup.
- The table `filter` transform no longer passes an empty value for `gt`, `gte`, `lt` or `lte`.
- The World Cup demos reveal one stage of the tournament at a time: each round has its own stop, so NEXT brings in the next round and PREV steps back to the one before. Existing installs keep their copy; delete the demo project (or start from a fresh data folder) to get the new one.

### Fixed

- Keyframed cells on a newly shown table page no longer stack at the row origin.
- Mode changes that arrive together are applied in the order they arrived, rather than the order their project reads finished.

### Security

- Spelling `/api` with a percent-escape (for example `/%61pi/…`) reached every API route without the key; the gate now decides on the resolved route instead of the raw URL.
- Commands sent over the control WebSocket, previously accepted from any client on the network, now need the key or a signed-in session, re-checked on every command.
- The API-key gate covers every channel verb except `state`, including the new `prev`, `page` and `cycle`.
- Wrong keys are limited to five a minute per address on every route and at the socket upgrade, and keys are compared in constant time.
- `?key=` values are redacted from the request log.
- The hub accepts state reports only from renderer and preview clients.

## [0.73.0] - 2026-09-24

### Added

- Settings live in a `.env` the server creates on first start, with `env.breeze` kept as a reference of every default.
- A Connections page showing who is on the server, and an opt-in console dashboard (`BREEZE_CONSOLE=dashboard`).

### Changed

- The Companion module moved out of `integrations/` into its own Bitfocus repo.
- World Cup demo ids adopted the prefix-plus-suffix key convention.

## 0.72.2 - 2026-09-23

### Changed

- Breeze Demo project and composition ids renamed to the prefix-plus-suffix convention (e.g. `demo-1iixd`), leaving layer and source ids untouched.

## 0.72.1 - 2026-09-06

### Fixed

- `?scale=contain` output pages now refit when the window resizes instead of needing a reload.
- The control-panel preview box holds 16:9 at any window height.

## 0.72.0 - 2026-09-06

### Added

- An overridden field is addressable live as `mount.binding` (e.g. `badge.badgeText`), so one mount can be driven without touching its twin.
- A toggleable preview of the real output page on the control panel, counted as a preview rather than a connected output.

## 0.71.3 - 2026-09-06

### Changed

- Reverted 0.71.2, and a flattened nested comp now warns when its STOP markers do not line up with the parent's instead of the runtime choosing.

## 0.71.2 - 2026-09-06

### Changed

- A nested crawl froze with its parent's hold (reverted the same day in 0.71.3).

## 0.71.1 - 2026-09-06

### Fixed

- A nested ticker's override was queued for the next loop seam, and seeded against a detached tree, instead of showing from the start.

## 0.71.0 - 2026-09-06

### Added

- An overrides panel for nested compositions, so one badge comp can mount as HOME and AWAY, with expander warnings shown on the layer.
- Path shapes and path masks from a `d` string with an editable point list.

### Fixed

- The standings re-sort e2e flake, caused by sorting rows on rounded pixel tops that tied mid-animation.

## 0.70.0 - 2026-08-31

### Added

- A mask section on every layer type, with a wipe preset, an animatable offset and validator rules.
- Panel controls for all eight CSS filter effects, five of them keyframable.

### Fixed

- Masks on sized layers were clipped square by a wrong region fallback.

## 0.69.0 - 2026-08-31

### Changed

- Thumbnails tick clocks once and render videos as a captured poster frame, closing Phase 7.6.

## 0.68.4 - 2026-08-31

### Added

- Composition and scene thumbnails in the layers panel, posed at the rest frame via a new `posterTime`.

## 0.68.3 - 2026-08-31

> Version bump only; no source changes.

## 0.68.2 - 2026-08-30

### Added

- The Lower Third + Bug demo scene with its e2e suite, and a World Cup bracket example.

### Changed

- Zoom-to-selection leaves breathing room, and the demo files were consolidated into `breeze-demo.json`.

## 0.68.1 - 2026-08-30

### Changed

- Independent scene layers have keyframes and lifetime bars switched off, and a save carrying them is refused.

## 0.68.0 - 2026-08-24

### Added

- Interface localisation (Phase 7.7) with an error-code contract, clock language and right-to-left support.

## [0.67.0] - 2026-08-10

### Added

- Composition-scoped backup bundles, merge-on-restore into an existing project, and a shared asset store that copies rather than links, closing Phase 7.5.

## 0.66.0 - 2026-08-10

### Added

- PSD import that keeps text as live text layers, closing Phase 7.
- Server-side project backup and restore with an allowlisting restore and secrets stripped from bundles.

## [0.65.0] - 2026-08-10

### Added

- A sprite-sheet layer type whose frame is solved from the clock.
- Image sequences uploaded as one zip and transcoded to WebM with alpha.

## [0.64.3] - 2026-08-10

### Added

- A generated `THIRD-PARTY-NOTICES.md`, checked in CI.

### Changed

- Validated: a transcoded alpha stinger plays with clean edges in an OBS Browser Source, meeting Phase 7's accept criterion.

## [0.64.2] - 2026-08-10

### Changed

- GSAP moved out of the bundles into a replaceable vendor file, with an in-page version guard that reports through the page title.

## [0.64.1] - 2026-08-10

### Changed

- Docs: added the `integrations/` README.

## [0.64.0] - 2026-08-09

### Added

- A first Bitfocus Companion module under `integrations/`, an all-projects discovery endpoint, and a user-guide section on the HTTP remote-control API.

## [0.63.0] - 2026-08-08

### Added

- An activity log (`/activity`) recording project and scene changes and control-panel connections.

## 0.62.1 - 2026-08-08

### Fixed

- The editor now holds a hub presence socket, so the portal's panels-open count includes it.

## 0.62.0 - 2026-08-08

### Added

- A New Scene dialog; a new scene inherits its project's stage size.

## 0.61.0 - 2026-08-08

### Changed

- Tidied the portal's status-strip readouts and reshot the portal screenshot.

## 0.60.0 - 2026-08-08

### Added

- Asset Replace, which repoints every reference and retires the old file.
- A rebuilt portal with project tiles and a status strip, a New Project dialog with editable URL key, and the user guide served at `/docs`.

### Changed

- Relicensed from PolyForm Shield to MPL-2.0, with per-file headers enforced in CI.

## 0.59.3 - 2026-08-08

### Changed

- CasparCG and OGraf exports dropped from the plan, so served pages are the only output.
- Safe-area guides default off for element-sized stages, and scene pages expose `window.breeze.elements`.

## 0.59.2 - 2026-08-07

### Changed

- Tests: a test that writes now owns its fixture, after a stray layer broke `lower-third.spec`.

## 0.59.1 - 2026-08-07

### Changed

- Tests: fixed the asset-library e2e, which failed on the folded bin and the lack of autosave.

## 0.59.0 - 2026-08-07

### Changed

- Tests: added the asset-library e2e block.

## 0.58.0 - 2026-08-06

### Added

- A runtime still mode that builds one paused frame cheaply, for thumbnails.

## 0.57.0 - 2026-08-06

### Added

- An asset Library modal with folders, tags, search, facets, bulk edit and a delete confirmation naming affected compositions.

## 0.56.0 - 2026-08-06

### Changed

- The asset index moved to `assets.json`, with usage and orphan endpoints, ingest metadata and a per-project write lock.

## 0.55.0 - 2026-08-05

### Added

- An asset bin with raw-body, content-addressed uploads.
- ProRes 4444 to VP9/WebM-alpha transcoding through a detected ffmpeg, with live progress.
- Table cells selectable in the layers panel and timeline.

## 0.54.0 - 2026-08-05

### Added

- An `advance` data transform that resolves tournament brackets; the unused `layout: 'bracket'` mode was removed.

## 0.53.0 - 2026-08-04

### Added

- Per-cell keyframes in tables, staggered across rows at no extra cost per row.

## 0.52.0 - 2026-08-04

### Added

- MET Norway and Bright Sky/DWD weather providers, the first free commercial options outside the US.

## 0.51.0 - 2026-08-04

### Added

- Scenes, so several independently triggered graphics share one browser source (Phase 6.5).
- Readable URL keys with a chosen prefix and generated suffix (e.g. `rahb-1k3f9`).

## 0.50.0 - 2026-08-04

### Added

- Clocks as a property of text layers, with time zones resolved through `Intl`.

### Fixed

- PLAY on the control panel pushed authored placeholders over live feed data, so feed-driven fields are now read-only.

## 0.49.0 - 2026-08-03

### Added

- A Screen Bug demo (logo, time and temperature) driven by an NWS Phoenix weather source.

## 0.48.0 - 2026-08-03

### Added

- FTP/SFTP file-drop sources and a weather source type (NWS, Open-Meteo hosted and self-hosted) with licence-aware poll floors and an attribution column.
- Dockerfile and Compose setup.

## 0.47.4 - 2026-08-03

### Added

- The Data sources panel folds away to a thin bar.

## 0.47.3 - 2026-08-03

### Fixed

- Restored the timeline Fit button's tooltip, which six e2e locators depend on, and added no-scrollbar tests.

## 0.47.2 - 2026-08-02

### Changed

- Timeline Fit now shows the full duration and every row without scrolling, growing the panel if needed.

## 0.47.1 - 2026-08-02

### Changed

- Safe-area guides hide themselves when the stage panel is narrower than 480px.

## 0.47.0 - 2026-08-02

### Added

- The editor preview renders real source rows.

### Changed

- The crawl separator became a preset picker with a Custom option.

## 0.46.0 - 2026-08-02

### Added

- RSS/Atom, generic XML and Google Sheets API v4 adapters.
- Crawls fed from a data-source column.

## 0.45.0 - 2026-08-02

### Added

- The DataSet model and transform pipeline, manual/JSON/CSV sources with a change-detecting poller, the table layer, layer thumbnails and a Data panel.

## 0.44 - 2026-07-31

### Added

- Resizable editor panels that persist across reloads.

### Fixed

- A layer could only be dragged once, because Moveable's drag area collapsed after each rebuild.

## 0.43 - 2026-07-31

### Removed

- NDI output from the plan.

### Fixed

- Overshoot easing control points are reachable again.

## 0.42 - 2026-07-31

### Fixed

- A keyframe drag moved once and then stopped, found by an audit of every editor draggable.

## 0.41 - 2026-07-31

### Fixed

- A lifetime bar dragged away and back now returns within the same drag.

## 0.40 - 2026-07-31

### Changed

- Closed the dependency audit's deferred items, leaving nothing more than a patch behind, and moved Node to 24.

## 0.39 - 2026-07-29

### Fixed

- A fitted strap overran by four pixels once its text was split for a reveal.

## 0.38 - 2026-07-29

### Fixed

- Fit Width ignored text not yet on screen.
- The ticker was destroyed when webfonts finished loading.

## 0.37 - 2026-07-29

### Added

- Six text reveal presets (chars, words or lines × rise or fade) via SplitText, completing Phase 5.
- Crawl controls in the editor and a Fit Width overflow warning.

## 0.36 - 2026-07-29

### Changed

- Docs: a low ticker cut off in a desktop browser is not a bug, and the output page now explains its 1:1 rendering.

## 0.35 - 2026-07-29

### Fixed

- Transform handles stayed where the layer used to be when the playhead moved.

## 0.34 - 2026-07-29

### Fixed

- The stage and timeline were never measured, because their ResizeObserver attached before the project loaded.

## 0.33 - 2026-07-29

> Superseded, do not ship.

### Fixed

- A dragged lifetime bar stretched the layer instead of moving it, and the playhead's head scrolled away. Its tablet stage-fitting never ran.

## 0.32 - 2026-07-28

### Fixed

- New ticker copy scrolls in instead of repainting text already on screen.

## 0.31 - 2026-07-28

### Fixed

- The editor's Holds toggle could wedge the preview transport after a pause mid-roll.

## 0.30 - 2026-07-28

### Security

- @fastify/static to 10.1.2 and esbuild to 0.25 from the Jul 28 dependency audit, with no functional change.

## 0.29 - 2026-07-28

### Added

- A preview transport in the editor.

### Changed

- PLAY walks a graphic forward again, undoing 0.27's restart.

## 0.28 - 2026-07-28

### Changed

- Output pages no longer put a graphic to air just by being opened; autoplay is opt-in.

## 0.27 - 2026-07-28

### Fixed

- PLAY no longer runs the outro on a graphic that is already holding.

## 0.26 - 2026-07-28

### Fixed

- Updating a ticker no longer jumps its scroll.

## 0.25 - 2026-07-28

### Added

- Control-panel links on the landing-page portal.

### Fixed

- Pressing STOP twice wedged the graphic.

## 0.24 - 2026-07-26

### Fixed

- A selected layer could not be dragged where another layer overlapped it.

## 0.23 - 2026-07-26

### Changed

- Tests: two helpers were aiming at the wrong pixels.

### Fixed

- A resize was never a single undo step, and the layer itself was not the drag surface.

## 0.22 - 2026-07-26

### Changed

- Tests: parallel test files no longer share one server, and four editor drag failures were instrumented.

### Fixed

- The hub overwrote query-string data.

## 0.21 - 2026-07-26

### Added

- The v1 milestone — a WebSocket hub, `/control` operator panel (PLAY, STOP, NEXT, live field edits) and REST triggers.

## 0.20 - 2026-07-26

### Added

- Layer lifetime bars can be dragged and trimmed at either edge.

## 0.19 - 2026-07-26

### Changed

- Tests: drag tests report where they fail, and the undo buttons expose history depth ("Undo Move layer").

## 0.18 - 2026-07-26

### Fixed

- Stage dragging, by treating Moveable's `beforeTranslate` as an absolute position rather than a screen delta.

## 0.17 - 2026-07-26

### Changed

- Tests: failing drag tests marked as tracked, with a diagnostics spec that measures the fault instead of guessing.

## 0.16 - 2026-07-26

### Changed

- Preview rebuilds are suppressed during a drag, resize or rotate.

## 0.15 - 2026-07-26

### Removed

- Reverted 0.14's live drag preview, which fed its own transform back into Moveable and ran away exponentially.

## 0.14 - 2026-07-26

### Added

- An "add keyframe at playhead" button.

### Fixed

- Dragging an animated layer now writes a keyframe at the playhead.

## 0.13 - 2026-07-26

### Changed

- Tests: the row-alignment and clipping tests counted the wrong elements.

## 0.12 - 2026-07-26

### Fixed

- Timeline rows below the fold lost their bars and keyframes, and the ruler now stays pinned while scrolling.

## 0.11 - 2026-07-26

### Changed

- Tests: rewrote the keyframe-overlap assertion that had been wrong three revisions running.

## 0.10 - 2026-07-26

### Fixed

- 0.09's clipping made keyframes at t=0 unclickable, solved with a 10px track gutter.

## 0.09 - 2026-07-26

### Fixed

- Timeline zoom could not be reversed at the left edge and could scroll past the end.

## 0.08 - 2026-07-26

### Fixed

- Selection now uses a `data-selected` attribute, because the inline outline cleared unreliably.

## 0.07 - 2026-07-26

### Changed

- Removed Ajv from both browser bundles, cutting the player from 226 kB to 94 kB.

## 0.06 - 2026-07-26

### Added

- A zoom-compensated selection outline, because small layers looked unselected.

## 0.05 - 2026-07-26

### Fixed

- Transform handles never appeared after adding a layer.
- Playback restarted every crawl and video on every frame.

## 0.04 - 2026-07-26

### Added

- The React editor (stage, layers and properties panels, undo/redo) and the keyframe timeline, Phases 2 and 3.

## 0.03 - 2026-07-26

### Changed

- Validated: renders cleanly and holds at STOP in OBS 32.2.

### Fixed

- The step count no longer counts the outro as a step.

## 0.02 - 2026-07-26

### Changed

- Phase 1 hardening — unified nested-composition expansion, SVG masks with real feather, video slaved to the playhead and steadier Fit Width.

## 0.01 - 2026-07-26

### Added

- Composition schema v1, the single GSAP runtime with STOP-marker lifecycle, and a Fastify server serving transparent `/play` pages.

[0.75.0]: https://github.com/dwclarkphx/breeze-overlay/releases/tag/v0.75.0
[0.74.1]: https://github.com/dwclarkphx/breeze-overlay/releases/tag/v0.74.1
[0.74.0]: https://github.com/dwclarkphx/breeze-overlay/releases/tag/v0.74.0
[0.73.0]: https://github.com/dwclarkphx/breeze-overlay/releases/tag/v0.73.0
[0.67.0]: https://github.com/dwclarkphx/breeze-overlay/releases/tag/v0.67.0
[0.65.0]: https://github.com/dwclarkphx/breeze-overlay/releases/tag/v0.65.0
[0.64.3]: https://github.com/dwclarkphx/breeze-overlay/releases/tag/v0.64.3
[0.64.2]: https://github.com/dwclarkphx/breeze-overlay/releases/tag/v0.64.2
[0.64.1]: https://github.com/dwclarkphx/breeze-overlay/releases/tag/v0.64.1
[0.64.0]: https://github.com/dwclarkphx/breeze-overlay/releases/tag/v0.64.0
[0.63.0]: https://github.com/dwclarkphx/breeze-overlay/releases/tag/v0.63.0
