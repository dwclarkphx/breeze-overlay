# Changelog

All notable changes to Breeze Overlay are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow the project rule: a feature bumps the minor version, a fix bumps the patch. Releases before 0.45.0 used two-part numbers (0.01–0.44). 1.0.0 will be the first public release.

## [0.79.0] - 2026-10-25

> Rundowns with cue → take, outputs that carry several graphics, operator timers, typed fields, sport templates for data sources, fill/matte and chroma outputs for hardware switchers, OGraf interop, and rolls, polls and data-driven charts.

### Added

- **Rundowns** (Phase 9 Wave A). A rundown panel at `/rundown/<project>`, linked from the portal: build a list of items before the show, each one a composition, its field values, an optional label and an optional output. Arm an item and the preview shows it exactly as it will air. **TAKE** (space bar) puts it on air and arms the next item; the arrow keys arm the previous or next item. Rundowns are saved in `projects/<id>/rundowns.json` beside `assets.json`. What is armed and what is on air is held by the server, so two panels agree and a panel refreshed mid-show comes back on the same armed item. REST: `GET`/`PUT /api/projects/:id/rundowns`, and `/api/rundown/:id/:rundownId/{cue,next,prev,take,out}` plus `/state`. WebSocket clients send the same verbs on `<project>/#rundowns`.
- **TAKE puts new values and PLAY in one command** (`take`), so an output never shows new values on an old pose. On a graphic that is already on air, the runtime runs the outro, then brings the new values up. `POST /api/control/:id/:compId/take` works on any graphic.
- **Cue → take on the control panel**, opt-in per panel; live editing stays the default. In cue mode the fields are a buffer: typing, Enter and table edits change nothing on air. The preview's **Sync to** menu gains **Show cued**, which renders the buffer through the real runtime, and TAKE sends it.
- **Outputs** (`/out/<project>/<output>`): one browser source that carries whatever the rundown takes onto it, so the lower thirds, the slate and the bug can share one vMix input. Each composition on an output has its own channel (`<project>/@<output>~<composition>`), so late join, playback reports and retained values work for it as they do for a scene element. An item's **layer** decides the stacking. `/api/out/:id/:output/{stop,next,prev,clear}` take `?mount=` to aim at one composition, and `/state` lists what is mounted.
- **Operator timers** (Phase 9 Wave B) on text layers: count down, count up or stopwatch. A countdown can instead count down to a time of day (`until`, with a time zone), which needs nobody to press start. Options are a token format (`m:ss`, `mm:ss.S`, `h:mm:ss`), tenths in the last N seconds (`59.9`), and a stop-or-overtime end. The hub holds each timer's state (running, anchor, time run), and every output works the time out locally from it against the hub's clock. Two outputs agree, and a reloaded browser source shows the right time on its first frame. Timers belong to a channel. Every composition on an output shares that output's timers, so a scorebug and a recap taken onto `@main` show one game clock. A layer rule can read a timer's seconds (`main ≤ 0 → hide`). The control panel gets a **Timers** block with start/pause, ±1, ±10, set and reset. REST: `/api/control/:id/:compId/timer?action=start|pause|toggle|reset|set|add&id=&value=` and `/api/out/:id/:output/timer`. `/state` returns `timers` even with `?data=0`.
- **Typed fields** (Phase 9 Wave B). A composition can declare what a field is under `fields`. A **number** has min/max/step, extra one-tap buttons (+1 +2 +3), pad, decimals, prefix and suffix. An **on/off** toggle shows its on/off text. **Options** are a select whose label shows on air. A **colour** recolours a text or shape layer through the new `colorBinding`. An **asset** is picked from the bin. The control panel draws each kind as its own control, the bindings JSON Schema describes it with plain keywords (`minimum`, `enum`, `format: color`, `x-breeze-asset`), and a field nothing binds to can still be read by a layer rule. The editor declares fields in a **Fields** section on the composition.
- **Sport templates for data sources** (Phase 9 Wave B). **Add → From a sport template…** creates the five tables a sports production needs: teams, players, coaches, venue and game. Each is shaped for the sport and its rules. There are 21 sports in four groups: basketball, American football, baseball, softball and volleyball; soccer, rugby union, rugby league, Australian rules, Gaelic football and hurling; ice hockey, field hockey, lacrosse, handball and water polo; cricket, tennis, badminton, table tennis and pickleball. Rulesets cover the NBA, WNBA, NCAA, high school (NFHS), FIBA, NFL, MLB, FIVB, IFAB, World Rugby, AFL, NHL, IIHF, FIH, IHF, T20/ODI/Test and more. The game table carries the score, the period and its label (`3rd`, `2OT`, `Top 7th`, `Set 3`), a line score per period, and the sport's own state: down and distance, balls/strikes/outs and runners, fouls and bonus, cards, power play, overs and wickets, sets/games/points, serve. Each ruleset brings the timers the sport runs (an NBA 12:00 countdown and 24 s shot clock, a 45:00 count-up for soccer, a 40 s play clock, an MLB pitch clock), offered as presets on a text layer's timer. The rows can be typed in here, or come from a Google Sheet (a tab per table), a published CSV or a JSON feed.
- **A format guide for every sport table**, so a Sheet or feed starts out valid. Every column is listed with its type, whether it is required, and an example or its allowed values. A starter CSV (header plus seed rows) and a sample JSON can be downloaded, and the rows a source actually returned are checked against the template: missing required columns, values that are not numbers, values outside a closed list, and extra columns.
- **The Game block on the control panel**: score buttons laid out by the sport (+1/+2/+3, TD/PAT/2PT/FG/SAF, try/conversion/penalty, goal/behind, a point to either side for the racket sports with tennis 15/30/40/AD, deuce and tiebreaks, side-out scoring for pickleball, the cricket keypad), the period, possession, and every counter and toggle the sport tracks. The game state lives in the table, not on one graphic, so the scorebug, the recap and the lower third all show the same score. `POST /api/projects/:id/datasources/:sourceId/game` takes `{ type: score | unscore | point | adjust | set | period | reset, … }` (GET with query parameters too, gated). Taps are serialised per project, so taps that land together all count. `GET /api/sports` lists the catalogue.
- **Outputs a hardware switcher can key** (Phase 9 Wave C). `?matte=1` renders the graphic as a key signal: white where it is opaque, black where it is clear, grey at its alpha in between, so a fill page and a matte page on two outputs give an ATEM luma or downstream key (pre-multiplied on) with clean soft edges. `?bg=<colour>` paints an opaque background for a chroma keyer: `green`, `blue`, `magenta`, `black`, `white`, or hex with or without `#` (three or six digits). Both work on `/play` and `/out`. The server writes them into the page, so the first frame is already right. The matte is a filter over the same runtime, so it has the fill's timing and late join, and a graphic stack on a scene or output gives one key. An unusable value is ignored and reported in the console. A matte page ignores `?bg=` and says `· matte` in its title. NDI and SDI output stay out of scope.
- **The sync check verifies fill ↔ matte pairs.** A matte page tells the hub what it is, and `/state` lists it in `sources` with `signal: "matte"` (WebSocket clients send `signal` on subscribe). For each matte on a graphic, the control panel compares it with its fill (one on the same machine first), by the same rules as the preview check, and shows **Key pair in step** or **out of step** with the rows that differ. A matte with no fill is flagged. **Sync to** marks matte outputs.
- **OGraf Server API** (Phase 9 Wave D). An OGraf controller drives Breeze at `/ograf/v1`, the renderer side of the EBU's OGraf Server API v1. Each project is a renderer, each composition a graphic (`<project>~<composition>`), and each channel a render target: a graphic's own channel, which shows that composition, or an output (`@main`), which shows any. `load` sends the values to a graphic's own channel, or mounts the composition on an output without playing it. `playAction` goes to the hold `goto` or `delta` names and answers once the outputs report it, so `currentStep` is what is on air. `skipAnimation` cuts. `stopAction`, `updateAction` and `clear` do what they say, and the custom actions are `next`, `prev`, `page`, `cycle` and `timer`, offered only where the graphic has a paged table or a timer. The renderer's `mode` action sets the project mode. Reads are open; actions need the API key when one is set, which an OGraf controller can also send as `Authorization: Bearer`. CORS is open on `/ograf/`. The control panel, Companion and the OGraf controller all see the same channel.
- **OGraf pointer packages** (Phase 9 Wave D). The **OGraf** button on each graphic in the portal downloads `<project>~<composition>.ograf.zip` (`GET /api/projects/:id/compositions/:compId/ograf`) for SPX or any OGraf renderer. It holds a manifest and a small `graphic.mjs`, and no runtime: the module frames this server's own output page for the graphic and passes each OGraf action to it, so the graphic plays only while the server can be reached. It calls back to the address it was downloaded from; `?server=` on the download, or `v_breezeServer` in `load()`, sets another. The manifest's data schema is the bindings schema in OGraf's GDD form (options as selects with labels, colours as `color-rrggbb`, fields in Breeze's order). Its step count is the number of STOP markers, and its action durations come from the markers. The instance belongs to its OGraf controller: the Breeze channel's PLAY does not move it, while data sources and the project mode follow the server. The same files are served unzipped at `/ograf/package/<graphic id>/`, and `GET /ograf/v1/graphics/<id>` points at them.
- A `step` command on the control socket goes to one hold (`step`, 1-based like a playback report's) without turning a table's page; `cut: true` skips the animation. `stop` takes `cut: true` too. An output's routing channel now takes `play`, `step`, `page` and `cycle` with `mount`, and `next`/`prev` there take `table`. The runtime gains `goToStep()`.
- **Show attribution** on weather and air-quality sources, ticked by default. Unticked, the `attribution` column comes back blank rather than disappearing, so bindings and the column picker keep working, and the existing layer rule **`attribution` is empty → hide** takes the credit strap off air. When the provider's licence obliges a credit (Open-Meteo hosted and self-hosted, MET Norway, Bright Sky/DWD, CAMS) or asks for one (AirNow), the editor shows a warning naming the licence, with a link to it, under the box. It warns and doesn't refuse. NWS is public domain and gets no warning. Stored as `showAttribution: false` on the source definition. A source saved before this release has no such key and keeps its credit.

- **Long-text sources** (Phase 9 Wave R). A `text` data source holds lyrics, credits or a statement, typed into the editor or fetched from a URL (an FTP drop can deliver one too, with `format: text`). It is split into rows by line or by verse, with markup on by default: `# Heading` is a heading row, `Role | Name` (or a tab) a two-column credit line, and a blank line a gap. Up to 256 KB and 5,000 rows. The designer's **Operator changeable** switch decides whether the control panel's **Text** block may replace the words on air (`PUT /api/projects/:id/datasources/:sourceId/text`, refused with 403 otherwise).
- **Roll layers** (Phase 9 Wave R): a text source scrolled through a window — up for end credits, down, or left/right for a long crawl — at the designer's speed in px/s. Headings, credit pairs and gaps have their own styles, the window can fade at its edges, and the text can start off screen or at the top, and at the end hold, clear, loop, or **continue** — hand the graphic on to its next STOP or outro once the last line has gone. Layers naming the same scroll id move together.
- **The scroll transport.** While a roll airs, the operator can play, pause, run it forward or backward, go faster or slower in steps that are multiples of the designer's speed (¼× to 4×), set a speed, jog, seek, restart or jump to the end. The hub holds each scroll's state as it holds a timer's, and every output works the position out from the hub's clock, so two outputs show the same line and a late page joins on it. A fresh PLAY, a TAKE and a CLEAR reset it. The control panel gets a **Rolls** block, the rundown panel a transport under each target, and REST `…/scroll?action=play|pause|toggle|forward|backward|reverse|faster|slower|speed|jog|seek|restart|end|reset` on `/api/control/:id/:compId` and `/api/out/:id/:output`. `/state` returns `scrolls` even with `?data=0`. OGraf graphics with a roll offer a `scroll` custom action.
- **Polls** (Phase 9 Wave R): a `poll` data source holds a question, up to 12 options (each with an optional colour and image) and the tally. Votes come from the operator, never the audience: the control panel's **Polls** block, `…/datasources/:sourceId/poll` (`vote`, `set`, `open`, `close`, `reset`, GET or POST, serialised per project so simultaneous taps all count) and Companion. Its rows carry `votes`, `percent` (whole numbers that always add to 100), `share`, `rank` (ties share a rank), `leader`, `color`, `image`, `question`, `total` and `status`. A `PUT` there re-words the question and options when the poll is operator changeable. A feed (JSON, CSV, Sheets) can stand in for a poll; the editor shows the columns it should carry.
- **Drives** (Phase 9 Wave R): any layer can have a property moved by a number — width, height, x, y, scale, rotation, opacity, an arc's sweep or a path's trim. The number comes from a field, a source's row or a table cell's own row; it is mapped from a domain (a number, the column's `min`, `max` or `total`, or another column or field, such as a goal) onto a range, clamped by default, and tweened when it changes. Width and height grow from the start, centre or end. A property cannot be both keyframed and driven. Bars, meters, gauges and donut slices are all built this way.
- **Arcs, trims and plotted lines** (Phase 9 Wave R). An ellipse can be an **arc** — start angle, sweep, ring thickness, butt or round ends — for gauges and donuts. A path or arc has a **trim** (0–1) to draw it on. A path can **plot** a source's rows — linear or smooth (monotone, so it never overshoots a reading), with a fixed or data-derived range and an optional filled area — and tween to new values. `trim` and `sweep` are keyframable.
- **Counting numbers** (Phase 9 Wave R): a text layer can count from its old number to its new one over a set time, with decimals, a prefix and a suffix (`$`, `%`).
- **Tables across and the `share` transform** (Phase 9 Wave R). `axis: 'x'` lays a table's rows out across — a column chart, or the labels under a line. `{ op: 'share', column }` writes each row's percentage of the column's total (rounded so it adds to 100) and, with `cumulative`, the running total before it — where a pie slice starts.
- **User guide**: a new section 12a, *Rolls, polls and charts* (text and poll sources, the roll layer and its transport, drives, arcs, plotted lines, counting numbers, rows across and the share transform), with screenshots; the control panel's Timers, Game, Scroll, Poll and Text blocks; the scroll, poll and text endpoints of the HTTP API.
- **Sport templates reference** (`docs/SPORT-TEMPLATES.md`): every sport and rule set with its clocks and scoring, each linked to the governing body's own rules, and the format of every table with an example row. Generated from the catalogue by `pnpm docs:sports`; `pnpm docs:sports:check` says when it is out of date.
- **Rolls, Polls & Charts demo** with a credits roll, lyrics a verse at a time, a poll as bars and as a donut, a giving thermometer, an hourly temperature line and a gauge.

### Changed

- `bg` and `matte` are reserved on output URLs, like `autoplay` and `scale`: they no longer set a field of that name from the query string.
- Backups carry `rundowns.json`, and restore reads it back.
- Data-source and mode pushes skip output routing channels and the rundown channel, which render nothing.
- The Connections page and the console dashboard count OGraf pointer graphics following the server, and list OGraf controllers among the API callers.
- Documentation brought up to date with the code (PHASE9.md §1.2): the README no longer says a transcoded stinger is unconfirmed in OBS (it was validated on 0.64.3). ROADMAP drops a stale note about the `ENCODER_ARGS` docstring, marks Phases 0–4, 7, 7.5 and 7.6 done in their headings, and records Fastify and JSON-on-disk as decided in the stack table.

### Fixed

- A layer rule's colour on a stroke-only path recolours the stroke, as it does on a ring arc; it used to paint the path's fill.
- The World Aquatics water polo rule set's shot clock is 28 s, as the 2025 competition regulations set it; it was 30.
- The control panel's Poll block keeps each option's set-count box on the option's line, and the Scroll block's **Go to** button no longer wraps.
- A centred or right-aligned text layer of several lines aligns each line; the lines used to sit ragged-left inside a block that was itself centred.

## [0.78.0] - 2026-10-25

> Paths are drawn on the stage, and Breeze can look the way you need it to.

### Added

- **Paths are edited on the stage.** Select a path shape, or any layer with a path mask, and its points and curve handles appear over it: drag a point to move it, drag a handle to bend the curve, double-click a point to switch it between corner and curve, double-click a straight edge to add a point there, and `Alt`-click a point to remove it. The handles follow the layer through rotation, scale and skew and stay the same size at any zoom; dragging anywhere else inside the layer still moves the whole layer. A layer with both a path shape and a path mask gets **Shape path** / **Mask path** buttons in the stage toolbar. A path using commands the stage cannot round-trip (arcs, relative or shorthand commands) is left untouched and the toolbar says so. This completes Phase 8 (MASKS.md §5.1).
- **Interface themes**, chosen from a **Theme** menu on the portal: Follow system (the default), Dark, Dark dimmed, Dark high contrast, Dark red–green safe (protanopia, deuteranopia), Dark blue–yellow safe (tritanopia), Light and Light high contrast. Every theme keeps text at 4.5:1 or better on every panel colour, and the two colour-blind themes keep danger, success and warning apart under simulation of the deficiency they are for. Follow system honours the OS light/dark setting and its "more contrast" preference. The choice is per browser and every open Breeze tab follows a change at once. Themes recolour the portal, editor, control, backup, activity, connections and guide pages — never `/play`, the stage or anything on air. Served as `/theme.js`.

### Changed

- The layer **delete** button is red and its tooltip names what it removes — *Delete the selected layer “Bar”*, or *Delete the 3 selected layers* — adds *and every layer inside it* for a group or table, and gives the shortcut and the undo. It was a 🗑 emoji reading "Delete selected", which could not be coloured.
- The project and scene pickers read **Delete selected project…** and **Delete selected scene…**, and their dialogs are titled *Delete the selected project* / *Delete the selected scene*.
- Selecting a locked layer now says so in the stage toolbar, rather than only showing no handles.

### Fixed

- The control panel's preview frame and sync-check box were drawn with no border: their colour, `--line`, was never defined. It is now the theme's border colour.

## [0.77.0] - 2026-10-17

> Every project and every graphic has a name you can read.

### Added

- **Restoring a backup asks for any name it cannot use.** When a backup carries a project or composition with an empty name, a line break in its name, or a name longer than 64 characters, the Backup page lists each one — project, composition, the name as it is, and what is wrong with it — with a box for the new name, pre-filled where it can be (a line break becomes a space, a long name is cut to 64). **Restore** stays disabled until every name is usable, and **Cancel** abandons the restore with nothing written. The server checks the whole bundle again before writing any of it, so a restore from a script is held to the same rules: `POST /api/restore` answers `400` with code `error.restoreNamesNeeded` and the list in `nameIssues`, and takes the replacements as base64 UTF-8 JSON in an `x-breeze-names` header — `{"<project id>": {"name": "…", "compositions": {"<composition id>": "…"}}}`. `POST /api/restore/inspect` returns the same list, and merges (`?mode=merge`) check composition names only, since the bundled project's own name is discarded.
- `/api/channels` and `/api/projects/<project>/channels` list each graphic's paged tables — every table with **Rows per page** set or a **Cycle** — as `tables: [{ table, name, cycle }]`, so a control surface can offer page buttons for exactly the graphics that page, before any output has reported in. `table` is the address NEXT, PREV and `page` take, and the one a live `state` report shows; both now come from one function, so they cannot drift apart. A graphic with nothing to page lists `tables: []`.

### Changed

- **Project and composition names must contain at least one visible character**, on one line, up to 64 characters. Any language or script is fine — names never reach a URL, which is built from the id. A name made only of spaces or invisible characters (a zero-width space, a bidi mark) counts as empty; those characters are still allowed inside a real name, where Persian, Indic scripts and emoji need them. Names are stored trimmed and in Unicode NFC. Creating or renaming with a name that breaks a rule answers `400` with `field: "name"` and code `error.nameEmpty`, `error.nameControl` or `error.nameTooLong` (with `params.max`); a save that renames a composition also says which in `composition`. A create that sends no name at all still gets *Untitled project* or *Untitled scene*, but an empty name is no longer quietly replaced.
- Every name field — the editor's composition name, the new project and new scene dialogs, and the restore prompt on the Backup page — says what is wrong in red directly under the field as you type. Pasting a name with line breaks or tabs in it puts spaces in their place and says so under the field, instead of the browser silently running the words together. The composition name field keeps the last good name if you clear it and click away.
- Projects saved before this release with an empty name still open and save — only a name being *changed* is held to the rules. Until they are renamed, the portal, the editor's pickers, the play and control pages, the backup page and `/api/channels` (so Companion's presets) show the id in its place, and the editor's delete confirmation asks you to type the id rather than accepting an empty field.

### Fixed

- A table paged by hand with NEXT or PREV now goes back to its first page when the graphic leaves air — when its outro finishes after STOP, or on CLEAR — as a self-paging table already did. It used to stay on its last page and roll back in on it. The page does not change while the outro is still on screen, and a page chosen after that, off air (`page?name=C`, Companion's **Go to page**), is still the page the next PLAY opens on; PLAY used to discard that choice when the graphic had finished.

## [0.76.0] - 2026-09-29

> One sentence from several columns.

### Added

- A **Compose** transform builds a text column from a template that reads the row's other columns, for a crawl or a text cell that needs a sentence rather than one field: `The NWS has issued a {event} for the following {areaKind}: {areas|list}; from {onset|when} until {ends|when}`. After a column name, `|` shapes the value — `list` (`A; B; C` → `A, B and C`), `drop:text`, `upper`, `lower`, `default:text`, `when` (a time as `3:35 PM` today, `Wed 3:15 AM` this week, `Oct 6 3:15 AM` after that) and `time:h:mm A` (the clock layer's tokens). It has a time zone of its own, is validated as it is typed (an unclosed brace, an unknown modifier), and a table or crawl using `when` re-runs as the day turns. It is in the editor's transforms list and in the schema.
- A CAP source adds two columns: `areas`, the alert's areas without their state (`Pima; Pinal` for `Pima, AZ; Pinal, AZ`), and `areaKind`, `counties` when every UGC code is a county's and `areas` otherwise — NWS issues heat and wind products by forecast zone, so a sentence can say which.

### Fixed

- Pressing Hold or Resume on a paging table no longer sends the control panel's page list back to page one with no countdown when a second output on the channel is stalled. Every command makes every output report, and the panel showed whichever reported last — including an output still `playing-in` because its tab was hidden and its animation clock had stopped. The hub now speaks for the channel with the output furthest along (holding, then playing in, then playing out), then the one reporting on time, then the oldest connection, so outputs of the same stage no longer trade places on the panel at every report.
- The control panel's page list counts a table's time left from when the report was made, not from when it arrived. The hub replays its last report to every panel on each command, and since 0.75.0 a heartbeat that only aged is not relayed, so the replay could be several seconds old — and every countdown and progress bar jumped back by that much after a Hold, a Resume, NEXT or an update, until the next page turn.

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
