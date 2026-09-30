# Breeze Overlay — User Guide

A guide to building broadcast graphics in the Breeze editor and putting them on air.

No coding required. If you have used After Effects, Photoshop or any NLE, the model here will feel familiar: a stage, a stack of layers, a timeline with keyframes.

**Contents**

1. [How the pieces fit together](#1-how-the-pieces-fit-together)
2. [Starting up](#2-starting-up)
3. [The editor at a glance](#3-the-editor-at-a-glance)
4. [The app bar — projects, saving, undo](#4-the-app-bar--projects-saving-undo)
5. [The stage](#5-the-stage)
6. [The layers panel](#6-the-layers-panel)
7. [The properties panel](#7-the-properties-panel)
8. [The timeline](#8-the-timeline)
9. [Animating something — a worked example](#9-animating-something--a-worked-example)
10. [Easing](#10-easing)
11. [Text that changes on air](#11-text-that-changes-on-air)
12. [Data sources and tables](#12-data-sources-and-tables)
13. [Scenes — several graphics, one browser source](#13-scenes--several-graphics-one-browser-source)
13a. [Assets and video](#13a-assets-and-video)
14. [Getting it on air](#14-getting-it-on-air)
14a. [Remote control — the HTTP API](#14a-remote-control--the-http-api)
15. [Keyboard shortcuts](#15-keyboard-shortcuts)
16. [When something looks wrong](#16-when-something-looks-wrong)
17. [Upgrading the animation engine](#17-upgrading-the-animation-engine)

---

## 1. How the pieces fit together

Breeze has three faces, all served by one small server on your machine.

| | What it is | Who uses it |
|---|---|---|
| **Editor** | Where you design and animate the graphic | You, before the show |
| **Browser source** | The `/play/…` URL you paste into OBS or vMix | The switcher |
| **Control panel** | PLAY / STOP and live text edits | The operator, during the show |

The important thing to know is that all three run the *same* renderer. What you see moving on the editor stage is exactly what goes to air — there is no separate "export" step and no second engine to surprise you.

A graphic has a shape to it that matches how live television works:

```
idle  →  playing-in  →  holding  →  playing-out  →  finished
```

PLAY rolls the graphic in and parks it at a **STOP marker**. It sits there — *holding* — for as long as the operator wants. STOP runs the outro. You will set those STOP markers yourself in the timeline.

![The portal](images/project-index.png)

*The portal at `http://<host>:7331/` — the front door. Every project is a tile; opening one lists its scenes with links to the control panel, the browser-source URL and the debug view.*

---

## 2. Starting up

On the machine that will host the graphics, from a terminal:

```powershell
cd C:\projects\breeze_overlay
pnpm --filter @breeze/server start
```

Then open **`http://<host>:7331/`** — the portal. Everything the server hosts is reachable from there:

- **Open the editor** and **User guide** as buttons at the top. Both open in a new tab, so the portal stays where it is. The guide is this document, served from your own installation — no internet connection required.
- A **status strip** below them: how many browser sources and control panels are connected right now, what the server is doing for CPU and memory, and how long it has been up. It refreshes every couple of seconds while you are looking at it.
- A **tile per project**. Click one to open it and see its scenes.

You can also go straight to the editor at **`http://<host>:7331/editor/`** if you would rather skip the portal.

On first run the server installs three demo projects, so there is something to take apart before you build your own:

- **Breeze Demo** — a lower third, a badge, a news ticker and a standings table.
- **World Cup 2026 Bracket Demo** — a full tournament bracket driven from a data source.
- **World Cup 2026 Tournament Scene** — the same tournament as a scene: several graphics on one browser source, each triggering independently.

These are ordinary projects. They live in your data folder exactly as anything you create does, and you can rename, edit or **delete** any of them from the editor's project menu — see [Making and removing projects](#making-and-removing-projects). A deleted demo stays deleted, and will not come back the next time the server starts.

### Activity — a record of what changed

The **Activity** button on the portal opens a log of the things worth being able to look up afterwards:

| Recorded | Not recorded |
|---|---|
| Projects created and deleted | Browser sources connecting |
| Scenes created and deleted | Editor windows opening |
| Control panels connecting and disconnecting | PLAY / STOP and field edits |

The exclusions are deliberate. A browser source that flaps reconnects every few seconds and would bury the handful of entries a month you actually go looking for, and the status strip already answers "is it connected right now?". A refused scene delete is not recorded either — nothing changed.

**On "who".** Breeze has no accounts. An action is attributed to the address it came from and the browser it came from — `192.168.1.40 · Chrome on Windows` — not to a person. On a gallery LAN where machines are assigned that is usually enough to work out who; behind a proxy or a VPN it is not, and the page says so rather than implying otherwise. Hover the browser name to see the full User-Agent.

The log is written to `data/audit-<year>-<month>.jsonl` — one JSON object per line, one file per month, in the data folder next to your projects. It is plain text and greppable, nothing rotates or deletes it for you, and it is worth including in whatever backs up that folder.

### Connections — who is on the server right now

The **Connections** button on the portal, next to **Activity**, lists what is connected at this moment — the detail behind the status strip's two numbers:

| Table | What is in it |
|---|---|
| **Browser sources** | Every output page — vMix and OBS inputs, and any `/play` tab — with the scene it is showing, the address and browser it came from, and how long it has been connected. |
| **Panels & editors** | Control panels and editor windows, with the scene each is on. Its count is the same number as **Panels open** on the status strip. A panel also opens connections of its own: one small readout per element of a scene, and the output preview if it is showing. Those are counted in a line underneath rather than listed, so one open panel does not become five rows. |
| **API callers** | Companion, Stream Deck URLs, `curl`, scripts — anything calling `/api/…` directly — with its request count, last call and status. |

The first two tables are exact: those clients hold a live connection, and one that closes drops off straight away. API callers are different. They send a request and hang up, so there is nothing "connected" to show; instead each is listed for 60 seconds after its last request, and the heading says so. A Companion instance that is polling stays on the list; one that stops falls off within a minute. A red status (401, 404…) on that row is the quickest way to spot a button wired with the wrong key or the wrong scene.

Calls made by Breeze's own pages — the editor, the portal, the control panel — are left out of the API table. They are already listed as panels and editors, and their polling would bury everything else.

The page refreshes itself every five seconds. Like Activity it shows addresses and browsers, not people, and like Activity it needs no key to read. The API table never shows a query string, so a key sent as `?key=` does not appear on it. The same data is available as JSON at `/api/peers`.

### The console dashboard

By default the server's terminal is a plain log. Set `BREEZE_CONSOLE=dashboard` and it becomes a status board instead:

```
 Breeze Overlay 0.74.0   up 2:14:05   CPU 3.1% of 8 cores   RSS 182 MB   heap 60 MB   RAM 32 GB
 Editor  http://localhost:7331/
 Output  http://192.168.1.40:7331/play/<project>/<composition>
── Browser sources (2) ──────────────────────────────────────────────────────
  192.168.1.51    vMix                demo/lower-third                 1:02:11
── Panels & editors (1)  +3 element readouts ────────────────────────────────
  panel    192.168.1.20    Chrome on Windows   demo/scorebug              3:40
── API callers, last 60s (1) ────────────────────────────────────────────────
  192.168.1.20    node                  41 req  200     2s ago  POST /api/control/…
── Log ──────────────────────────────────────────────────────────────────────
 18:52:10 INFO  Breeze Overlay 0.74.0
 Press Ctrl+C to exit   ·   BREEZE_CONSOLE=dashboard   ·   /peers in a browser shows the same list
```

The tables are the same ones as the portal's **Connections** page. The log pane shows everything the plain log would, except successful HTTP requests: the portal alone polls every couple of seconds, so those would fill the pane. A request that fails still appears, as one line. Nothing is dropped from the log itself. `BREEZE_LOG_LEVEL` still applies.

The dashboard needs an interactive terminal. Where there is not one — output piped to a file, a Windows service, a container started without `-t` — the server prints one line saying so and logs normally, so leaving the variable set somewhere it cannot work does no harm.

**Ctrl+C** stops the server in either mode. Both show the reminder: the plain log as its last startup line, the dashboard on its bottom row. Under the dashboard, the terminal is handed back as it was, and the last twenty log lines are printed so you can still see what the server said last. Press Ctrl+C a second time to exit immediately rather than waiting for connections to close.

### What the status strip is telling you

The two numbers worth knowing before a show:

**Browser sources** counts output pages that are actually connected — an OBS Browser Source, a vMix Web Browser input, a debug tab you left open. If this reads `0`, nothing is listening, and pressing PLAY on a control panel will do nothing visible. It turns green the moment something connects. Open a project tile and each scene shows its own count, so you can see *which* graphic the source is attached to.

**Panels open** counts control panels and editor windows — one per window, however many elements the scene has or whether its preview is showing. An editor registers itself against the scene it currently has open, so on a project tile you can see that someone is already working on a graphic before you open it yourself.

**Server CPU** is the Breeze process, expressed as a percentage of **one** core — not of the whole machine. On a multi-core box it can legitimately go above 100% while a video is transcoding. It is there to answer "is the server itself struggling?", which is a different question from "is this computer busy?"

### About addresses

`<host>` throughout this guide means **the machine running the Breeze server**.

- **Working on that same machine?** `<host>` is `localhost`, so the editor is at <http://localhost:7331/editor/>.
- **Working from anywhere else** — a laptop in the gallery, a switcher PC, a tablet — use that machine's name or IP address instead: `http://graphics-pc:7331/editor/`, `http://192.168.1.40:7331/editor/`.

The server listens on every network interface by default, so it is reachable from the rest of the LAN without any extra setup. **It prints the exact address to use when it starts** — take it from there rather than guessing.

This matters most for the browser-source URLs in [section 14](#14-getting-it-on-air). If OBS or vMix is on a different computer from the server, a `localhost` URL will point that machine at *itself*, find nothing, and show a blank source.

Two settings worth knowing, both environment variables:

| | |
|---|---|
| `BREEZE_PORT` | Defaults to `7331`. Change it if something else already has that port |
| `BREEZE_HOST` | Defaults to `0.0.0.0` (reachable from the LAN). Set it to `127.0.0.1` to keep the server private to its own machine |
| `BREEZE_LOCALE` | Defaults to `en`. The language of the editor and the control panels |

`BREEZE_LOCALE` is a property of the *server*, not of your browser: everyone
looking at this Breeze sees the same words, so two people on the same control
panel are always talking about the same button. It does not touch your own
content — layer text, column names and data-source names stay exactly as you
typed them — and it does not touch what goes to air. English is the only
language shipped today.

---

## 3. The editor at a glance

![The editor, with each region numbered](images/editor-overview-annotated.png)

| | Region | What it is for |
|---|---|---|
| **1** | App bar | Pick the project and composition, save, undo, grab the output URL |
| **2** | Layers | The stack. Top of the list paints on top |
| **3** | Data sources | Live data feeding tables and tickers |
| **4** | Stage | The picture. Select, move, scale and rotate here |
| **5** | Properties | Everything about whatever is selected |
| **6** | Timeline | When things happen |

The three dividers between panels are draggable. **Double-click a divider** to reset that panel to its default width. Your layout is remembered between sessions.

---

## 4. The app bar — projects, saving, undo

![The app bar](images/app-bar.png)

Left to right: the version number, the **project** picker, the **scene** picker, then **Save**, **Undo**, **Redo** and the **Output URL** link.

**Saving.** The button reads `Saved` when there is nothing to save and `Save` when there is. `Ctrl+S` does the same thing. A small red dot appears at the right-hand end of the bar whenever you have unsaved changes, and closing the tab with unsaved work prompts you first.

**Undo.** `Ctrl+Z` steps back, `Ctrl+Shift+Z` (or `Ctrl+Y`) steps forward. A whole drag counts as one step, not forty — dragging a layer across the stage and changing your mind is a single `Ctrl+Z`.

**Output URL** opens the browser-source page in a new tab. That is the URL you give to OBS or vMix.

If a change would produce an invalid composition, a red banner appears listing the problems and the save is refused. Fix the listed fields and save again.

### Making and removing projects

Both pickers carry a short list of actions below the things they list.

**+ New project…** at the bottom of the project picker. It asks for two things: a **name**, which is for you and can be anything, and a **URL key**, which is the part that ends up in web addresses. The key is suggested from the name as you type — "Riverside Hawks Basketball" offers `riverside-hawks` — and you can replace it with something shorter. Read [URL keys](#url-keys) below before you settle on one: it is set once and cannot be changed afterwards.

The new project opens straight away, empty, with one untitled scene ready to build.

**+ New scene…** at the bottom of the scene picker adds a scene to the project you are in. It asks the same two things, and the key follows the same rules — with one addition: it must not clash with anything the project already answers to, including the channel names of any [scene elements](#13-scenes--several-graphics-one-browser-source). The server appends its suffix, so a clash is avoided for you rather than reported.

![The New scene dialog](images/new-scene-dialog.png)

*The key is suggested from the name as you type, and stops following it the moment you edit it yourself.*

A new scene inherits the **stage size of the project it is added to**, not a fixed 1920×1080. Add a scene to a 1280×720 project and you get another 1280×720 scene.

**Delete scene…** at the bottom of the scene picker removes the scene you are looking at. There is one thing it will refuse to do: if another scene mounts this one as a layer — which is how [scenes](#13-scenes--several-graphics-one-browser-source) are assembled — the delete is blocked and the dialog lists every scene and layer still using it. Unlink those layers first, then delete.

![A delete refused because another scene mounts this one](images/delete-scene-blocked.png)

*Blocked, with the layer to go and remove named. There is no Delete button on this dialog at all — only Close.*

This is deliberate. Deleting a scene out from under something that mounts it does not break that parent loudly; it leaves it playing with one graphic silently missing, which is the kind of thing you find out about on air.

**Delete project…** at the bottom of the project picker. This one deletes the whole project directory — every scene, every uploaded asset, every data source — and there is no undo and no recycle bin. You have to type the project's name to confirm it. Anything already pointing at that project, a browser source in OBS or a button on a Stream Deck, stops working the moment it goes.

> Neither delete asks twice by accident. Choosing one from a picker only opens a dialog — nothing is removed until you confirm, so arrowing past `Delete project…` with the keyboard is harmless.

### URL keys

Every project and every composition has a short **URL key** as well as a name. The name is for you — "Random A Highschool — Basketball" is a perfectly good project name and it never appears in a web address. The key is the part that shows up in URLs:

```
http://<host>:7331/play/rahb-1k3f9/lt-4b2c
                        ↑           ↑
                        project     composition
```

When you create a project or a scene you can set the first part of that key. Type `rahb` and you get `rahb-1k3f9`; leave it alone and you get the default, `proj-1k3f9`. The characters after the hyphen are generated for you and cannot be edited — that is what guarantees no two projects ever collide, so you never have to hunt for a key that is still free.

The point of choosing it is telling things apart. Six games in a folder called `proj-1k3f9`, `proj-2m4x`, `proj-3p8k` are indistinguishable at a glance. `rahb-1k3f9` and `wchs-2m4x` are not.

Rules: up to 12 characters, letters, numbers and hyphens, and it is lowercased for you. Keys are **set once, at creation** — they cannot be renamed afterwards, because the key is baked into every browser source you have already pasted into OBS and every button on a Stream Deck. Pick it when you make the project; there is a copy button next to it thereafter.

---

## 5. The stage

![The stage with a layer selected](images/stage-selected.png)

The checkerboard is transparency — the graphic goes over live video, so there is no background. A flat gray backdrop would make white text invisible, hence the checks.

**Toolbar:** zoom out `−`, the current zoom, zoom in `+`, **Fit**, and a **Guides** checkbox. On the right, the stage size and frame rate.

**Guides** draw the action-safe and title-safe boxes plus center crosshairs. Keep anything that must not be cropped inside the inner (title-safe) box.

They hide themselves automatically when the stage panel is narrower than 480px — at that size the dashed boxes cover more of the artwork than they frame. The checkbox grays out while that applies; widen the panel and the guides come back as you left them.

**Selecting and moving.** Click a layer to select it. Handles appear: drag inside the box to move, drag a corner or edge to scale, drag the stalk above the box to rotate. Locked layers show no handles.

**Getting around:**

- **Pan** — hold `Alt` and drag, or drag with the middle mouse button
- **Zoom** — `Ctrl` + mouse wheel, or pinch on a trackpad
- **Fit** — snaps the stage back to fill the viewport, and keeps tracking as you resize the window

If you select a layer and nothing appears on stage, look at the toolbar: it will tell you the layer *is not shown at this time* (the playhead is outside its lifetime) or *is off-stage at this time* (it has animated out of frame). Both are normal mid-animation — scrub the playhead to where the layer is on screen.

---

## 6. The layers panel

![The layers panel](images/layers-panel.png)

Layers are listed **top of stack first**, matching what you see: the layer at the top of the list paints over everything below it.

Each row has a visibility dot, a lock, a thumbnail of the layer's actual content, the name, and reorder arrows.

![Hidden and locked layers, and the selected row](images/layers-panel-states.png)

*Here "Live badge" is hidden (hollow dot), "Accent" is locked (padlock), and "Bar" is selected.*

| Action | How |
|---|---|
| Select | Click the row |
| Select several | `Shift`-click or `Ctrl`-click |
| Rename | Double-click the name, type, press `Enter` |
| Hide / show | Click the dot — `◉` visible, `○` hidden |
| Lock / unlock | Click the padlock. A locked layer cannot be dragged on stage |
| Move up / down the stack | The `▲` and `▼` arrows |
| Delete | The bin button, or press `Delete` with the layer selected |

**Adding a layer.** The `+ Add…` menu offers **Text**, **Shape**, **Image**, **Video**, **Sprite**, **Crawl**, **Table**, **Group** and **Composition** (for nesting another composition — see [section 13](#13-scenes--several-graphics-one-browser-source) for using this to build a scene).

> **Worth knowing:** a new layer starts at the playhead, as it would in After Effects. Add one with the playhead parked at 2 seconds and the layer does not exist before 2 seconds. If that is not what you wanted, drag its bar left in the timeline, or set **In** to `0` in the properties panel.

Hiding a layer only affects the editor's own preview; it does not remove the layer from the graphic. To keep something off air, give it a lifetime that never overlaps the on-air portion, or delete it.

---

## 7. The properties panel

Everything about the current selection. With **nothing** selected you get the composition itself — **Name**, **Width**, **Height**, **FPS** and **Duration**. That is where you change 1920×1080 to something else, or make the graphic longer.

Select a layer and the panel fills out. The sections you see depend on the layer type.

![Properties for a text layer](images/properties-text.png)

**Transform** — X, Y, Scale X/Y, Rotation, Opacity, Skew X/Y. These are the animatable properties; see [the timeline](#8-the-timeline) for the stopwatch buttons beside them.

**Size** — the layer's box in stage pixels.

**Timing** — **In** and **Out**, in seconds. **Out** left blank means "to the end of the composition". These are the same numbers as the layer's bar in the timeline; edit them here when you want an exact value.

**Effects** — Blur, Brightness and blend mode, on every layer type.

### By layer type

**Shape** — **Kind** (rectangle or ellipse), **Fill** and corner **Radius**.

![Properties for a shape layer](images/properties-shape.png)

**Text** — **Content** is the text itself. **Binding** is covered in [section 11](#11-text-that-changes-on-air). **Fit width** condenses long text so it fits the box (see below). **Type** covers Font, Size, Weight, Color, Tracking, Align and Case. **Reveal** animates the text on piece by piece. Six presets: **Characters rise**, **Characters fade**, **Words rise**, **Words fade**, **Lines rise**, **Lines fade**. Each brings sensible **Stagger**, **Duration** and **Ease** defaults, scaled to the unit — the defaults show as grayed placeholder values, and typing over one overrides just that field.

**Crawl** (tickers) — **Speed** in pixels per second, **Direction**, a **Separator** printed between items, and the **Items** list, one per line.

**Image / Video** — Pick from **Asset** (the files uploaded to this project — see [section 13a](#13a-assets-and-video)) or type a **Path** directly, plus an optional binding. Video adds **Start at**, **Loop**, and **At end** — `Hold last frame` or `Clear`. Video is locked to the composition playhead, so it scrubs correctly in the editor and stays in sync on air.

A stinger usually wants **Clear**: a transition that has finished should leave nothing behind, and a held final frame stays parked over your program feed.

**Media** — live pictures from a URL: a webcam snapshot, an MJPEG camera, a video file, a YouTube stream, an HLS stream. See [Cameras and live media](#cameras-and-live-media).

**Table** — see [section 12](#12-data-sources-and-tables).

### Fit width

Long names are the classic strap problem. Set **Fit width** to `Fit width`, give it a **Max width**, and text that would overflow is condensed horizontally to fit — but never squashed below **Min scale** (0.5 by default), because a name compressed to a third of its width is worse than one that runs long.

If a piece of text does hit that floor, the properties panel says so — *"Still wider than the box at min scale"* — which is how you find out that a strap is too short for its content *before* it is on air rather than after.

---

## 8. The timeline

![The timeline](images/timeline.png)

Reading the panel: names down the left, a time ruler across the top, a **Markers** lane, then for each layer a **lifetime bar** and — underneath it — one lane per animated property, with a diamond for each keyframe. The red vertical line is the playhead.

![The timeline toolbar](images/timeline-toolbar.png)

| Control | What it does |
|---|---|
| `▶` / `⏸` | Play or pause the preview |
| `⏮` | Jump to the start |
| **Holds** | When on, the preview pauses at STOP markers exactly as it will on air. Off (the default), it runs end to end — which is what you want while you are still designing the motion |
| Timecode | The playhead position |
| **+ STOP** | Add a STOP marker at the playhead |
| `−` `+` **Fit** | Zoom out, zoom in, fit the whole composition |

**Fit** shows everything at once: the full duration across the width, and every row down the page — it grows the timeline panel if it needs to, so you should not be left scrolling in either direction. On a composition with more rows than the panel is allowed to grow to, it gets as close as it can and keeps a vertical scrollbar; drag the divider above the timeline if you want more room than that.

**Moving the playhead** — drag anywhere on the ruler. `Space` plays and pauses, `Home` jumps to the start.

**Navigating** — `Ctrl` + wheel zooms around the pointer; `Shift` + wheel scrolls sideways.

**Lifetime bars** — the blue bar is when the layer exists. Drag the middle to slide it in time; drag either end to trim the in or out point. If a bar is too narrow to grab its edges, zoom in and the trim handles reappear.

**Keyframes** — the amber diamonds. Drag one to retime it. `Shift`-click to add to the selection. `Delete` removes selected keyframes; with no keyframes selected, `Delete` removes the selected layer instead. `Ctrl+C` and `Ctrl+V` copy and paste keyframes at the playhead.

**STOP markers** — the small red ticks in the Markers lane. Drag to move, **double-click to delete**. A STOP marker is where the graphic parks on air. Everything after the *last* one is the outro.

**Snapping.** Dragged keyframes and markers snap to other keyframes, to markers, to the playhead and to the start and end of the composition. Failing all of those they snap to whole frames.

---

## 9. Animating something — a worked example

Say you want a strap to slide in from the left.

1. **Park the playhead at 0.** Press `Home`.
2. **Select the layer** you want to animate.
3. **Position it where it should start** — off the left edge, so a negative X.
4. **Click the stopwatch `⏱`** next to X in the properties panel. It turns amber and drops a keyframe at the playhead holding the current value.

   ![The Transform section — stopwatch on X and Y, and the add-keyframe diamond](images/properties-transform.png)

5. **Move the playhead** to where the move should finish — say 0.6s.
6. **Set X to its final value**, by typing it or by dragging the layer on stage. A second keyframe appears automatically.
7. **Press `Space`** to watch it.

That is the whole loop: turn on the stopwatch, move the playhead, change the value.

**Adding a keyframe without changing anything.** Once a property is animated, a small `◆` appears at the end of its row. Click it to drop a keyframe at the playhead holding whatever the value is right now — useful for making a value *hold* before it moves again. The diamond is filled in when there is already a keyframe at the playhead.

**Turning animation off.** Click the lit stopwatch again. That removes *every* keyframe on that property, so the value becomes static.

**Then set your hold.** Move the playhead to where the graphic should be fully built and press **+ STOP**. Animate the exit after it. Turn the **Holds** toggle on and press `▶` to rehearse it the way the operator will drive it.

---

## 10. Easing

Easing is what makes motion look designed rather than mechanical. **Double-click any keyframe** to open the easing editor.

![The easing editor with a custom curve](images/easing-editor.png)

- **GSAP preset** — the named eases (`power3.out`, `back.inOut`, and so on). These are the workhorses.
- **The six preset buttons** — Ease, Ease in, Ease out, Ease in-out, Anticipate, Broadcast in. Each drops a custom curve you can then adjust.
- **The graph** — drag the two amber handles to shape the curve. The dashed line is linear, for reference. The `cubic-bezier(…)` readout below updates as you drag.
- **Snap, no tween** — no interpolation at all. The value jumps at the keyframe. Use it for hard cuts and blinking elements.

One thing to know about the preview: named GSAP eases draw as a straight line in this graph, because GSAP evaluates them at playback. Custom curves preview exactly. If you want to *see* the shape, use a custom curve; if you want a standard broadcast feel, the named presets are quicker.

![The easing editor showing a named GSAP preset](images/easing-editor-preset.png)

---

## 11. Text that changes on air

Any text layer with a **Binding** becomes a field the operator can edit live from the control panel — without touching the editor and without re-playing the graphic.

Give the layer a binding name in the Text section — `name`, `title`, `score`, whatever is meaningful — and it appears in the control panel under **Dynamic fields**, labeled with that name.

Bindings can also be filled straight from the URL, which is handy for testing and for automation:

```
http://<host>:7331/play/demo-1iixd/l3rd-name-2a94g?name=Jane%20Doe&title=Reporter
```

Crawl layers and table layers can carry bindings too, so an operator can replace a whole headline list or a whole table live.

---

### A clock that updates itself

A clock is not a layer type — it is a switch on a **text layer**. Turn on **Live clock** in the properties panel and the layer stops showing its own text and starts showing the time, updating on air without anyone touching it.

- **Preset** — the common formats, each option labelled with the time *right now* in that format. Pick the one that reads the way you want.
- **Format** — the tokens behind the preset, if none of them is quite right. `h:mm A` → `6:42 PM`, `HH:mm:ss` → `18:42:07`, `dddd, MMMM D` → `Monday, August 3`. The field's tooltip lists them all. Watch the case: `mm` is minutes, `MM` is the month.
- **Time zone** — blank uses the clock of the machine rendering the graphic, which is usually right, because that machine is in the market whose time is on screen. Set an IANA zone (`America/Phoenix`, `Europe/London`) when it is not.
- **Language** — which language the month and weekday names appear in. This belongs to the *graphic*, not to the editor: a station whose crew work in English can still put German day names on screen. Leave it alone and you get English.

The two controls do different halves of the job, and it is worth being clear about which is which. **Format** decides the *order and the punctuation*; **Language** decides the *words*. So `dddd, MMMM D` in German gives `Montag, August 3` — German names in American order, which is probably not what you meant. Write the order out the way the language wants it: `dddd, D. MMMM` gives `Montag, 3. August`.

**Now:** underneath shows exactly what will render, updating every second, in the language and zone you picked — so you never have to guess.

The layer's own **Content** becomes a placeholder once the clock is on: the canvas and a still export use it, a renderer never does. And a clock always beats a binding, so if the layer has both, the operator's field will appear to do nothing — clear one or the other.

---

## 12. Data sources and tables

Data sources sit under the layers panel, in the same column — the project's inputs directly above the layers that consume them.

Click the **▾ Data sources** heading to fold the panel away. Collapsed, it becomes a thin bar on the bottom edge and hands the whole column to the layer list; click again to bring it back at the size it was.

![The data sources panel](images/data-panel.png)

`+ Add…` offers ten kinds:

- **Manual table** — you type the rows. Good for standings, credits, anything you maintain by hand.
- **HTTP CSV / Google Sheet** — a URL that returns CSV. A published Google Sheet works directly: use its **Publish to web → CSV** link. No API key.
- **HTTP JSON** — a URL that returns JSON, with an optional path to the array inside it (for example `data.standings[0].teams`).
- **RSS / Atom feed** — a news or results feed URL. You get the same columns whichever flavour of feed it is: `title`, `link`, `date`, `description`, `author`, `category`, `image`, `guid`. Point a ticker at `title` and you have a headline crawl.
- **XML** — any other XML. Give it the **row element** — the tag that repeats, written as a path like `results/game`. Press **find it** and the panel fetches the URL and offers the repeating elements it found, with how many of each; click one rather than typing it. Child tags become columns, and so do attributes: `<score home="4" away="2"/>` gives you `score_home` and `score_away`.
- **Google Sheet — private (API v4)** — for a sheet you cannot publish. Paste the sheet's URL (or just its id) and a range like `Standings!A1:F30`. This one needs a credential set up on the server; see below.
- **Weather** — pick a provider and a place, or many places. See [Weather](#weather) — read it before you put weather on air commercially.
- **Air quality — AirNow or CAMS** — the AQI for one place or many, now or forecast. See [Air quality](#air-quality) — AirNow data comes with terms of use.
- **Alerts (CAP)** — weather warnings, air-quality action days, anything published in the Common Alerting Protocol. See [Alerts](#alerts-cap).
- **FTP / SFTP file drop** — watch a folder on another machine and use the newest file in it. See [File drops](#file-drops-ftp--sftp).

Each source shows how many rows it holds, how often it refreshes, when it last fetched and when the data last *changed*. Sources that are failing are highlighted with the error. A source that is *partly* working — say two of ten cities timed out — shows an amber note naming them; it is still updating the rest.

A source that stops answering keeps its last good rows. A feed going down does not blank a graphic that is on air — it shows an error here instead, which is the point of this panel.

The one exception is data that must not be shown stale. Air-quality sources have a **Blank the rows after** setting (three hours for AirNow): once a source has gone that long without a successful fetch, its rows are emptied — the columns stay, so the layout holds — and they come back with the next good fetch. Alerts work the same way on their own: a warning leaves the screen when its expiry passes, even if the feed is down.

### When the data is bad

A feed that goes down is the easy case. The hard one is a feed that answers perfectly and is wrong: a sheet someone is halfway through editing, an API that returns an empty list during a deploy, a sensor reporting 212°. Every fetched source has a folded **When the data is bad** section for that. Most sources never need it; set it up on the day a feed first misbehaves.

**Checks a fetch has to pass.** A fetch that fails one is treated exactly like one that failed to connect: the last good rows stay on air, and the source shows *refused by guard* with the reason.

| Setting | What it refuses |
|---|---|
| **Fewest rows** | A fetch with fewer rows than this — the empty list during a deploy |
| **Largest drop (%)** | A fetch that loses more than this share of the rows at once — 50 refuses forty cities falling to nineteen. If the same smaller list comes back three fetches in a row it is believed, because some lists really do shrink |
| **Columns that must be filled** | A row with nothing in one of these columns — a city with no name |
| **Sensible values** | A value outside a range you give, or one that is not a number — `temp` between −40 and 130 |
| **A row that fails** | Whether one bad row refuses the whole fetch (the default), or is left out while the rest go on air |
| **Frozen after** | Content that has not changed for this many minutes. For feeds that should keep changing — observations, a sheet a script updates — a feed that answers with the same rows for ever is dead, and is treated as expired |

**How long old data may stay up.** **Blank the rows after** (in hours) is here for every source — the same setting air quality has. Leave it empty to keep last good data for ever, which is right for scores and schedules.

**A backup.** Pick another source as the **Backup source**, and when this one has nothing fit to show, the backup's rows go on air *under this source's name* — every table and ticker bound to it carries on without a change. Give the backup the same columns. **Backup takes over** decides when:

- **When this has nothing to show** (the default) — its data expired, froze, or it never loaded at all. Until then, stale last-good data stays up.
- **As soon as a fetch fails** — for a primary whose stale data is worse than a backup's fresh data. It switches back on the next good fetch.

A backup that has nothing fit to show either is not used: stale rows from the primary beat blank rows from the backup. Backups can have backups. A **manual table** makes a good last one — a single row reading *Temporarily unavailable* is better on air than a blank.

**The operator's switch.** Some wrong data passes every check — a feed that is up, plausible and wrong. A source with a backup shows a menu in its row: **Automatic**, **Own rows**, or **Backup**. **Own rows** keeps the source's own data on air even when it is stale or judged frozen — for a table that is simply quiet — but not once it has expired, since that limit may be a publisher's. The same switch is on the control panel's **Data** block, in Companion, and over the API (`…/datasources/<source>/use`, [section 14a](#14a-remote-control--the-http-api)). It lasts until it is changed or the server restarts; a restarted server is back to automatic. Every change is written to the activity log.

While a backup is on air the source's row says *On air: the backup*, and the control panel's Data block says **On backup** in amber.

### Weather

A weather source asks for a **provider** and a **place** rather than a web address. Type a latitude and longitude, choose °F or °C, and pick what you want back:

- **Current conditions** — one row. This is what a weather bug wants.
- **Hourly forecast** / **Daily forecast** — several rows, for a forecast strip or a table.

There are five providers, and the difference between them is mostly legal rather than technical:

| Provider | Where it covers | Can you use it commercially? |
|---|---|---|
| **NWS — api.weather.gov** | United States and territories only | Yes, freely. US government data |
| **MET Norway — Locationforecast** | Worldwide; sharpest in the Nordics and Arctic | Yes, with a credit on screen |
| **Bright Sky — DWD** | Germany and immediate surroundings only | Yes, with a credit on screen |
| **Open-Meteo — hosted** | Worldwide | **No.** Non-commercial use only |
| **Open-Meteo — self-hosted** | Worldwide | Yes |

> **Read this before going to air commercially.** Open-Meteo's hosted service is free for non-commercial use *only*. If your channel or site carries advertising or subscriptions, that counts as commercial use and you may not use it. The editor shows a warning on that provider for exactly this reason. Outside the United States you have three commercial options: **MET Norway** anywhere, **Bright Sky** in Germany, or your own Open-Meteo instance (choose **Open-Meteo — self-hosted** and give it the address, for example `http://localhost:8282`).

**Most providers require a credit on screen** — MET Norway, Bright Sky and both Open-Meteo options all do. You do not have to remember the wording: every weather source has an **`attribution`** column holding the right line for its provider, so bind a small text layer to it and the credit travels with the graphic wherever it goes.

**MET Norway wants to know who you are.** Like NWS, it blocks traffic it cannot identify, and it will try to contact you before blocking — but only if there is a contact to reach. Fill in **Contact for User-Agent**, or better, have whoever runs the server set `BREEZE_CONTACT` once for everything.

Whichever provider you pick, **you get the same columns** — `temp`, `tempMin`, `tempMax`, `feelsLike`, `condition`, `icon`, `precipProb`, `precipAmount`, `windSpeed`, `windGust`, `windDir`, `humidity`, `pressure`, `uvIndex`, `isDay`, `time`, `attribution`. That is deliberate: if you switch provider later, the graphic keeps working. Anything a provider does not report comes back blank rather than breaking.

`icon` is not a picture. It is a plain keyword — `clear`, `partly-cloudy`, `rain`, `thunderstorm`, `snow`, `fog` and so on — so you can map it onto your own artwork once and reuse that mapping everywhere.

Weather refreshes more slowly than other sources, and the minimum depends on the provider: 15 minutes for hosted Open-Meteo, MET Norway and Bright Sky, 5 minutes for NWS, 1 minute for your own instance. If you type something faster it is quietly raised to the minimum. This costs you nothing — none of these forecasts recalculate more than once an hour.

Two things vary by provider and are worth knowing before you build against one:

- **Not every provider fills every column.** MET Norway has no chance-of-rain or gust outside the Nordics, and Bright Sky's hourly forecast has no humidity. Those cells come back blank rather than breaking the graphic — but if a number matters to your design, check it is actually arriving before the show rather than during it.
- **Bright Sky's current conditions are a real observation** from the nearest weather station, not a forecast for right now. That is the more accurate answer and occasionally the more surprising one: it is what the station measured, which can differ from what a model says it should be.

#### Many places in one source

Under **Where**, choose:

- **One place** — a name, latitude and longitude, as before.
- **A list of places** — one per line: `name, latitude, longitude`, then optionally a short key and (for NWS observations) a station. `Phoenix, AZ, 33.4484, -112.0740, PHX, KPHX`. Commas inside the name are fine; the name is everything before the first number.
- **Places from a table** — pick another source that lists the places: a manual table, a sheet, a CSV. Columns called `name`, `key`, `latitude`/`lat`, `longitude`/`lon` (and `station`, `area`) are found by themselves; if yours are called something else, name them in the fields below. Add a city to that table and the weather source fetches again straight away.

Every row then says which place it is about, in **`place`** and **`placeKey`**. That is what makes a rotating city graphic simple: give the table a [Cycle](#cycle--tables-that-page-themselves) with `place` (or `placeKey`) as its key column and set its rows per page to the rows per place, and it pages through the cities by itself. Go to page by key — `PHX` — works too.

If one city's request fails, that city keeps showing its last good rows and the source shows an amber note naming it; the others carry on updating. Each place is its own request, so keep the list to the cities you actually show — the limit is fifty.

#### Observed conditions

**Observed — latest station reading** (NWS and Bright Sky) is a measurement, not a forecast: what the nearest weather station last reported. It adds `station`, `ageMinutes` (how old the reading was when it arrived), `dewPoint` and `visibility`. On NWS, if the nearest station has no temperature right now the next nearest is used, up to three; to always use one station, type it in **Station** (`KPHX`). NWS **Current conditions** is the first period of the forecast, which is why the two can differ.

#### Daily forecasts

NWS publishes its forecast in half days — "Tonight", "Monday", "Monday Night". Tick **One row per day** and each day is paired with the night after it: `tempMax` from the day, `tempMin` from the night, the day's name and conditions, and the wetter of the two rain chances. That is how every other provider's daily forecast already reads. New NWS sources start with it ticked; existing ones keep what they were built on until you tick it.

**Start at tomorrow after** drops today's row once it is past that hour where the place is — an evening five-day strip then starts at tomorrow and still has five days.

#### Your own Open-Meteo instance

If your own Open-Meteo instance is on `localhost` or elsewhere on your own network, the server refuses to reach it until someone allows that address; ask whoever set up the server to add `BREEZE_DATA_ALLOW_HOSTS=localhost` to its settings.

**Model** and **Time zone** are the two fields you can usually leave alone on the hosted service, and usually should not on your own instance.

- **Model** — blank means "let Open-Meteo choose". That is right against their hosted service, and often wrong against your own: your instance only holds the forecast models you have actually downloaded, and "let it choose" may ask for one you do not have. If you know which model your instance has, name it here — `ncep_gfs_seamless`, for example.

  To find a model's id, use [Open-Meteo's own API docs](https://open-meteo.com/en/docs): pick a model there and read the id off the `&models=` part of the URL it generates. That is the same value this field takes. **Copy only the model and the time zone** — everything else in that URL (the location, the units, the variables) is built for you here, and pasting a whole URL in will not work. The panel links to the same page next to the field.
- **Time zone** — blank means `auto`, which uses the time zone of the place you are forecasting. That is normally what you want: the times on screen are the times where the weather is. Set it explicitly (`MST`, `America/Phoenix`, `Europe/London`) if the graphic should read in your own clock instead.

If your instance has some of the data but not all of it, the source quietly asks again for a smaller set rather than showing nothing — you may see UV index come back blank while everything else works. That is the fallback doing its job, not a fault.

**Contact** identifies you to the weather service. Fill it in as `mystation.com, ops@mystation.com` — a website, an email, or both.

This matters most on **NWS**, which requires it. Their documentation is explicit about why: a more distinctive string is less likely to be caught up in someone else's security event, and if they can contact you they will do that before blocking you. Left blank, Breeze sends a generic string that *every* Breeze installation shares — so your traffic gets judged alongside everyone else's, and if somebody else's server misbehaves, yours can be blocked with no warning and no way for anyone to reach you.

Normally you set this **once for the whole server** rather than per source — whoever runs the Breeze server adds `BREEZE_CONTACT` to its settings and every source inherits it. The field here is for the unusual case of one server working on behalf of several stations. Anything you type here wins over the server setting.

### Air quality

An air-quality source reports the AQI for one place or many, from one of three providers:

| Provider | Where it covers | Commercial use |
|---|---|---|
| **AirNow — EnviroFlash feeds** | United States, per AirNow reporting area | Yes, under AirNow's terms (below) |
| **CAMS via Open-Meteo — hosted** | Worldwide (a model, not monitors) | **No.** Non-commercial only |
| **CAMS via Open-Meteo — self-hosted** | Worldwide | Yes, with a credit |

AirNow places are **reporting areas**, identified by a number: it is the number in the area's EnviroFlash feed address — `https://feeds.enviroflash.info/rss/realtime/111.xml` is Phoenix, so Phoenix is `111`. No key is needed.

Pick what you want back:

- **Current AQI** — one row per place: the highest pollutant's reading, which is how the overall AQI is defined.
- **Current, one row per pollutant** — every pollutant the monitors report.
- **Forecast by day** — the agency's own forecast, one row per day, with its day name (`Today`, `Tomorrow`, `Tuesday`) in `period`.

The columns are the same for every provider: `place`, `placeKey`, `time`, `period`, `aqi`, `category`, `categoryIndex`, `color` (the official colour for the category, as a hex value — bind a shape's fill to it), `pollutant`, `scale`, `preliminary`, `ageMinutes`, `agency`, `attribution`.

> **AirNow's terms of use.** EnviroFlash publishes no terms of its own for these feeds; they carry AirNow data, and AirNow's [Data Exchange Guidelines](https://docs.airnowapi.org/docs/DataUseGuidelines.pdf) apply to it. They ask five things of whoever shows the data:
>
> 1. **Credit the reporting agency first, then AirNow.** The `attribution` column holds the right line — for Phoenix, *Arizona Department of Environmental Quality and the EPA AirNow program*. Bind a text layer to it.
> 2. **Say that observations are preliminary.** The `preliminary` column is true on observed rows (not on forecasts); show a "preliminary" label where it is.
> 3. **Do not alter the data.** Breeze passes the feed's numbers, category names and pollutant names through exactly as published.
> 4. **Show only current data.** **Blank the rows after** is set to three hours for AirNow; a reading that stops updating blanks rather than lingering. Leave it on.
> 5. **Tell the agencies you are using it.** Breeze cannot do this one for you: contact the AirNow Data Management Center (dmc@airnowtech.org) and your state agency — for Arizona, ADEQ.
>
> The data is not for regulatory use or trend analysis; that does not affect putting it on air.

AirNow's feeds print their times inconsistently. Breeze reads the time from the sentence with its named zone (`09/27/26 7:00 AM MST`), which is the one that is right, and treats a reading dated in the future as having no time at all.

CAMS is a forecast model, so its rows are never marked preliminary; its category names and colours come from the published EPA and European index tables. Choose **US AQI** or **European AQI** under **Index**.

### Alerts (CAP)

An alerts source reads the Common Alerting Protocol — the format NWS warnings, AirNow action days and many other agencies publish in. Give it the address of any of:

- a CAP feed, like AirNow's `https://feeds.enviroflash.info/cap/aggregate.xml` (action days and forecasts of "Unhealthy for Sensitive Groups" or worse, nationwide);
- the NWS alerts API, like `https://api.weather.gov/alerts/active?area=AZ` for Arizona;
- a single CAP alert document.

Then narrow it down: **Area contains** (`Maricopa, Phoenix`), **SAME or UGC codes** (`004013, AZZ537`), **Event contains** (`Heat, Dust`), and a **Minimum severity**. You get one row per alert, most severe first, with `event`, `headline`, `description`, `instruction`, `severity`, `urgency`, `certainty`, `areaDesc`, `onset`, `expires` and more — including `areas` (`areaDesc` without the state, so `Pima; Pinal` rather than `Pima, AZ; Pinal, AZ`) and `areaKind` (`counties` when every area is a county, `areas` for forecast zones, which is how NWS issues heat and wind products); `active` is false for an alert that has not started yet (a watch for tomorrow).

Test messages, cancellations and alerts past their expiry are always dropped — there is no setting for that. An alert that expires while the feed is unreachable still leaves the screen on time.

**Alert times: Whole local days** is for AirNow: its action days are meant as calendar days, but the offsets it prints are wrong for half the year (a Texas action day arrives stamped `-06:00` in September). Choose it, give the time zone (`America/Chicago`), and an action day runs for exactly that local day. For NWS, leave it on **As written**.

### File drops (FTP / SFTP)

For the very common arrangement where somebody else's machine writes a file into a folder every few minutes — a scorer's laptop dropping `results-2026-08-03.csv`, a league office publishing standings overnight.

Fill in:

- **Protocol** — **SFTP** if you have a choice; it is encrypted and it is what most servers offer. **FTPS** is encrypted FTP. Plain **FTP** sends your password and your file readable by anyone on the network — fine for a public anonymous drop, not for anything with a login.
- **Host**, and **Port** if it is not the standard one.
- **Directory** — the folder to watch, for example `/results`.
- **Filename pattern** — which files count. `results-*.csv` means "anything starting `results-` and ending `.csv`". `*` stands for any run of characters, `?` for exactly one. If several files match, the **newest one wins**.
- **Format** — how to read the file once it arrives: CSV, JSON, XML or RSS. Set this yourself rather than trusting the file extension; a file named `.txt` that actually holds CSV is common.
- **Username** — leave blank for anonymous access.

If the drop needs a password or an SSH key, whoever runs the server stores it and gives you a name for it; you type that name into **Credential id**. As with Google Sheets, the password itself never goes into your project file.

A file dropped this way is read by exactly the same code that reads the equivalent web address, so moving a feed from a website to a drop folder — or the other way — does not mean rebuilding your graphic.

Drop boxes usually live on your own network, and the server will refuse to connect to one until its address is allowed. If you get an error mentioning `BREEZE_DATA_ALLOW_HOSTS`, that is what it means — pass the host name to whoever runs the server.

### Which Google Sheets option?

Use **HTTP CSV** if you can. Publishing a sheet to the web needs no credential, no Google Cloud project, and nothing to rotate later. Use **Google Sheet — private** only when the sheet genuinely cannot be public.

If you do need it, someone with access to the server sets up the credential — either an API key (for a sheet shared as "anyone with the link") or a service-account JSON key (for a fully private sheet, which must then be shared with the service account's `client_email`, exactly as you would share it with a person). You put the *name* they gave it into **Credential id**. The credential itself never enters your project file, which is what makes a project safe to copy between machines or hand to someone else.

### Poll intervals

The minimum is 5 seconds for most sources, and higher for weather (see above). Match it to how fast the data actually changes: a live scoreboard feed wants 5–10 seconds, a standings sheet 30, a news feed several minutes, weather every 15. Polling faster than the data changes costs nothing on screen — a graphic only re-renders when the content actually differs — but it is traffic to somebody else's server, and some of them will start refusing you.

![Editing a manual data source](images/data-source-editor.png)

*The manual editor is a small spreadsheet. You can paste a block straight out of Excel or Sheets into the first cell — headers included — and it replaces the whole table.*

### Table layers

Add a **Table** layer, then point its **Source** at a data source.

![Properties for a table layer](images/properties-table.png)

**Transforms** reshape the data on its way to screen, in order, top to bottom:

| Transform | Use |
|---|---|
| **Sort** | Order by a column, ascending or descending |
| **Filter** | Keep only rows matching a condition |
| **Rank** | Write a position number into a column |
| **Limit** | Keep the first N rows |
| **Offset** | Skip the first N rows |
| **Advance bracket** | Fill a knockout bracket's later rounds from its earlier ones |
| **Unpivot** | Turn columns into rows — a sheet with a column a day becomes a row a day |
| **Date** | Keep the rows for today, tomorrow, the next seven days, or everything still to come — in a time zone you name |
| **Lookup** | Bring columns across from another data source by a matching value — a city's display name and region onto each forecast row |
| **Union** | Add another data source's rows underneath — a feed's alerts and your own typed announcements in one crawl |
| **Compose** | Build a sentence from several columns with a template — one line per alert, ready for a crawl or a text cell |

**Unpivot** is for the sheet somebody built for people rather than for graphics: one row a city, then `Mon`, `Tue`, `Wed` across the top. A table repeats rows, not columns, so it folds those columns into rows:

```
place    Mon  Tue              place    key  value
Phoenix  104  106      →       Phoenix  Mon  104
Tucson    99  101              Phoenix  Tue  106
                               Tucson   Mon   99
                               Tucson   Tue  101
```

- **Fold** lists the columns to turn into rows; **Keep** lists the ones copied onto every new row. Fill in either — blank Fold means every column you are not keeping. Both take column keys separated by commas.
- **Name column** (default `key`) holds which column a row came from — its label if it has one, so `Mon` rather than `mon`. **Value column** (default `value`) holds the value. Point your row cells at those.
- Rows come out a city at a time: all of Phoenix's days, then all of Tucson's. With rows-per-page set to the number of days, each page is one city.
- If the folded columns hold different kinds of value — numbers in most, `n/a` in one — the value column is text.

**Date** keeps rows by the day in one of their columns — the forecast for today, this week's games, the events still to come:

| Setting | What it does |
|---|---|
| **Column** | The column holding the date or time |
| **Keep** | **Days** keeps a window of calendar days. **Still to come** keeps a time until it passes, and a date for the whole of its day. **Already past** keeps the rest |
| **From day** / **How many days** | For **Days**: `0` is today, `1` tomorrow, `-1` yesterday; *how many* counts from there. Today alone is from `0`, `1` day; the next week is from `0`, `7` |
| **Time zone** | Whose "today" — `America/Phoenix`, say. Blank uses the zone of the machine showing the graphic. The line underneath shows what today is there |

Things worth knowing:

- **Name the zone.** A graphics machine set to UTC thinks tomorrow has started at 5 pm in Phoenix. With the zone set, "today" is the station's today wherever the graphic plays.
- **It moves on by itself.** A graphic on air all night drops yesterday's rows and picks up today's within half a minute of midnight, and a game drops out of *Still to come* when it starts — with nothing pushed. Tables following it, and its cycle, move with it.
- It reads `2026-09-27` and `20260927`, ISO times (`2026-09-27T19:00`, with or without an offset), month-first dates as Google Sheets writes them (`9/27/2026`, `9/27/2026 7:00 PM`), and Unix times in seconds or milliseconds. A time with no offset is read in the zone you named. Anything else — day-first dates (`27/9/2026`), spelled-out months (`Sep 27, 2026`), impossible dates — is not guessed at: the row is left out. If a Google Sheet shows dates some other way, set the column's format to *Date* or *Date time* in Sheets.

**Lookup** brings columns across from another data source, matching a column in these rows to one in that source — the feed says `PHX`, a small manual table says `PHX` is *Phoenix*, *Valley*, `phoenix.jpg`:

| Setting | What it does |
|---|---|
| **From** | The other data source |
| **Match** | The column in these rows |
| **With** | The column in the other source to match it with. Blank means the same name |
| **Bring** | The columns to bring, separated by commas. Blank brings every column but the one it matched on |

Matching ignores case and spaces at the ends; if the other source has the same value twice, the first row wins. A matched row takes the other source's values, blanks included. A row with no match gets empty values — except in a column it already had, which it keeps — so make sure the source has every value the feed sends, or add a **Filter** after the lookup to drop the rows it could not name. When the other source changes, the table changes with it.

**Union** adds another source's rows underneath this one's. The columns are both sources' columns together; a column one side does not have is empty on its rows. Add a **Sort** after it to interleave them.

**Compose** writes a new text column from a template that reads the row's other columns. A crawl reads one column per item and a text cell shows one, so a sentence made of several fields has to be built first:

```
The NWS has issued a {event} for the following {areaKind}: {areas|list}; from {onset|when} until {ends|when}
→ The NWS has issued a Flood Watch for the following counties: Pima and Pinal; from 3:16 PM until Wed 3:15 AM
```

| Setting | What it does |
|---|---|
| **New column** | The column written — point a text cell, or a crawl's column, at it. A column of that name is replaced |
| **Template** | Text with `{column}` fields. `'{{'` and `'}}'` write literal braces |
| **Time zone** | For `when` and `time:` fields — `America/Phoenix`. Blank uses the machine showing the graphic |

After a column name, `|` shapes the value, left to right: `list` (`A; B; C` → `A, B and C`), `drop:text` (removes it — `{areaDesc|drop:, AZ}`), `upper`, `lower`, `default:text` (when empty), `when` (a time as `3:35 PM` today, `Wed 3:15 AM` within the coming week, `Oct 6 3:15 AM` after that) and `time:h:mm A` (your own layout; the same tokens as a clock layer, in English). An empty value is empty text, never "null". Problems — an unclosed brace, an unknown modifier — are listed under the box as you type.

`when` depends on the time of day, so a table or crawl using it re-runs as the day turns. On a crawl, put **Compose** in the crawl's transforms and set its column to the new one.

A lookup or union reads the other source as it arrives, not after that source's own tables' transforms. The pickers under a Lookup, and the row cells below, already offer the columns it brings.

**Rows** controls **Row height**, the **Gap** between rows, and **Rows per page**. Leave rows-per-page at `0` and the table shows every row that fits the layer box. Set it to, say, 5 and the graphic pages through the data — the operator's **NEXT** button steps to the next page while the graphic holds on air, and **PREV** steps back.

**Row reveal** animates rows on individually, with the same Preset / Stagger / Duration controls as text reveals. **Re-sort** is how long rows take to slide into a new order when the underlying data changes — set it to `0` for a hard snap. A page turn uses the reveal too: the old page plays it in reverse, then the new page reveals. With the reveal set to *None* a page turn is a straight cut.

#### Cycle — tables that page themselves

**Cycle** turns pages on a timer while the graphic holds, so a standings table can work through every group, or a weather table through every city, with nobody pressing anything.

| Setting | What it does |
|---|---|
| **Seconds per page** | How long each page stays up. `0` switches cycling off and keeps the other settings |
| **Duration column** | Optional. A column holding a time per row; a page stays up for its longest row. Seconds, or milliseconds if you choose **ms** — feeds often carry milliseconds |
| **At the end** | **Loop** starts again from the first page. **Hold** stays on the last page. **Continue** carries the graphic on to its next STOP marker, or its outro — a round-up that pages through once and leaves by itself |
| **Group** | Tables with the same group turn together and hold together — two halves of one readout never show different pages |
| **Key column** | The column whose value on a page's first row names the page — `C` for Group C. It is what the control panel and Companion show, and what you ask for with `page?name=C`. Blank uses the first text column |

Things worth knowing:

- **Cycling only runs while the graphic holds on air.** Page one is always the first page the audience sees. Pressing PLAY on a graphic that went off air starts again from page one; a page chosen *before* rolling in — `page?name=C` while it is off air — is the page it opens on.
- **Pressing NEXT or PREV restarts that page's time**, so the page you just chose is not snatched away a second later. **HOLD** freezes a cycle on the page it shows until **RESUME**; a hold survives the graphic going off air and coming back.
- **New data does not throw a cycle back to page one.** A score arriving keeps the page on screen, and keeps its time. Only a page that no longer exists — the feed shrank — wraps to the first.
- The page is worked out from the clock rather than counted, so every output that was rolled in together turns on the same frame.

#### Follow — tables that change with another table

**Follow** makes a table show only the rows for whatever page another table is on. The weather-channel case: a rotation shows one city a page, and beside it a row of forecast tiles should always be that city's forecast. Give the tiles table a **Follow** section:

| Setting | What it does |
|---|---|
| **Leader table** | The table to follow — its binding, a `mount.binding` address, or its layer id. Blank switches Follow off |
| **Match column** | The column in *this* table that must hold the leader's page name — usually `place` |
| **Leader column** | Optional. The leader's column that names its page. Blank uses the leader's cycle **Key column**, then a column with the same name as the match column |

Every time the leader turns — on its cycle, on NEXT/PREV, on `page?name=`, on new data — the follower keeps just the rows whose match column equals the leader's page name, and goes back to its own first page. Matching ignores case and spaces at the ends, the same as `page?name=`.

Things worth knowing:

- **Operate the leader.** The follower has nothing of its own to aim at; its pages move because the leader's did. The control panel shows *follows cities* beside a follower so a page nobody asked for is explained.
- **No match shows no rows.** If the forecast has no Tucson, the tiles are empty for Tucson. That is on purpose: blank tiles are honest, Phoenix's forecast under a Tucson heading is wrong on air.
- **Filtering comes first.** When the data already has the match column, following happens *before* your transforms, so a Limit of 5 means five days of this city and a Rank ranks within it. When only a transform makes the column — an Unpivot whose name column is the city — following happens after it.
- **The leader can be in another composition.** Build the tiles as their own composition, mount it in the rotation graphic, and name the rotation's table. If a graphic mounts the same tile composition several times, each copy follows the leader nearest to it; where two are equally near, the output's console says so and you can name one as `mount.binding`. The editor only warns when it cannot find the leader, because it may be in the graphic the table is mounted into.
- **Not across independent elements.** An element of a [scene](#13-scenes--several-graphics-one-browser-source) set to play independently is its own graphic, so a table inside it cannot follow a table outside it. Mount the tiles inline instead.
- **Chains work.** A table can follow a follower. Two tables following each other cannot; the loop is broken, with a warning in the output's console, and one of them stops following.
- A follower can page and cycle on its own too — five of a city's fourteen days at a time, say. Its time starts again whenever the leader moves it to a new city, and if it is in a cycle **Group**, the rest of the group goes back to its first page with it so the group never shows different pages.

![A table on the stage](images/stage-table.png)

**Animating inside a row.** A row is built from a template — the cells you design once and the table repeats per row — and those cells can carry their own keyframes. A rank number that counts up, a form arrow that flicks in, a background chip that wipes across behind the name: all of that animates per cell, and every row plays it.

Cell animation runs on its **row's** clock, not the table's. If your rows reveal with a stagger, each row's cells move as that row arrives rather than all at once — otherwise the last row's animation would play while that row is still waiting off-screen. A table with no row reveal has nothing to stagger against, so every row moves together.

> **This is not editable in the editor yet.** Cells are not selectable in the layers panel, so cell keyframes have to be written into the project file by hand for now. The graphics play them correctly; there is just no UI to author them with. If you want this, say so — it is the next piece of table work.

### Rules — layers that react to data

Any layer can carry **rules**, in the **Rules** section of its properties. A rule says *when* something is true, *then* do something to this layer:

| When… | reads |
|---|---|
| **The mode** | The project's mode — `first-alert`, `election night` — set from the control panel, Companion or the API (below) |
| **A field** | A dynamic field, as the control panel or `update` sets it |
| **Rows in a source** | How many rows a data source has. *Is empty* means none — including before it has loaded |
| **A value in a source** | A column of a source's first row, or of a chosen row: `place=Phoenix` reads Phoenix's row |
| **This row's column** | In a table's row template only: the row this cell is on |

| Then… | does |
|---|---|
| **show / hide** | A layer with a *show* rule is hidden until one holds — "show when". A layer with only *hide* rules is shown until one holds — "hide when" |
| **recolour** | A text layer's colour, or a shape's fill |
| **image** | An image layer's picture. `{column}` is filled in from the row the rule reads, so `icons/{icon}.png` picks the icon for each forecast |

A rule can have several conditions — all must hold (**+ and**). Rules apply in order and a later one wins, property by property: a reading can go orange over 100 and red over 110 with two rules. When no rule holds any more, the layer goes back to exactly how it was authored.

Some things you can build with them:

- **A First Alert banner** — a red shape and text with *show when the mode is `first-alert`*. Nothing else in the graphic changes; the banner appears on every graphic that has one, on every output, the moment the mode is set.
- **Colour by value** — a temperature cell *recolour when this row's `hi` ≥ 100*.
- **An icon per row** — an image cell with *image `icons/{icon}.png` when this row's `icon` is not empty*.
- **Only when there is something to show** — an alerts crawl with *hide when the `alerts` source is empty*.

In a table, rules on a cell read their own row, so each row can look different. Rules on layers inside a nested composition read that mount's own field values.

The stage previews rules against the project's live data as you edit. For the mode, pick one in **Preview in mode** at the top of the Rules section — it changes only the editor's preview, never the mode on air.

**The mode** is the project's, not one graphic's: setting it changes every graphic in the project that has a rule for it, on every output, at once. It is kept through a server restart. Set it from the control panel's **Mode** block (a button for every mode your rules name, plus **NORMAL** to clear it), from Companion's **Mode** action, or from the API (section 14a). Every change is in the activity log under **Modes**.

### Brackets

A knockout bracket is a table like any other — one row per match, two team lines per row — drawn as one table layer per round column, with the row pitch doubling each round so a match sits centered between the two it came from.

Three examples ship, and they are meant to be read together:

| File | What it is |
|---|---|
| `examples/world-cup-bracket.json` | The whole 32-team tournament as one tree. **This is the limit case, not the recommendation** — read the next section before copying it. |
| `examples/world-cup-scene.json` | The same tournament done properly: a round-of-32 card wall and a round-of-16-onward tree, as two elements of one scene. |
| `examples/world-cup-2026-bracket.csv` | The data behind all of them. |

#### How many teams fit on one screen

Fewer than you would like, and this is the single most useful thing to know before you design a bracket.

Do the arithmetic before you draw anything. A 32-team tree needs nine columns across the frame — sixteen first-round matches split into two halves of eight, then four tiers of winners and the final. On a 1920-wide stage with sensible margins that is about **200px per column**, and a column has to hold a team, a score and some breathing room. What comes out the other end is **17px type**.

Seventeen pixels on a 1080-line frame is **1.6% of picture height**. For comparison, [general video legibility guidance](https://legibility.info/rules-for-text-in-videos) puts the floor for body text at 1080 somewhere around **40–60px**, and [TV interface guidelines](https://medium.com/you-i-tv/designing-for-10ft-ceeb202c1315) rarely go below 24pt. The 32-team tree is roughly a third of the recommended minimum. It also forces three-letter codes rather than names, because 200px does not hold "SWITZERLAND".

It gets worse downstream, in ways that are easy to forget:

- **Downscaling.** A 1080 graphic in a 720 stream loses a third — 17px becomes 11px.
- **Compression.** Small light text on a dark background is exactly what a bitrate-starved encoder smears first.
- **The second screen.** More people will see your bracket on a phone in a bar than on a calibrated monitor.

So the 32-team tree is not broken and it is not useless — it is a **video wall graphic**, or something a viewer pauses and studies. It is the wrong thing to cut to for six seconds during a half-time show.

**What to do instead: split the tournament.** `examples/world-cup-scene.json` shows the pattern.

| Graphic | Shows | Type size | % of picture height |
|---|---|---|---|
| Full 32-team tree | 31 matches, 9 columns | 17px, 3-letter codes | 1.6% |
| Round-of-32 cards | 16 matches, 4×4 grid | 40px, full names | 3.7% |
| Round-of-16 tree | 15 matches, 7 columns | 30–34px, codes | 2.8–3.1% |

Halving the tree is what pays for the tree. Drop the round of 32 and you go from nine columns to seven *and* from 31 matches to 15, so every remaining column gets wider and taller at once. The round of 32 then gets a layout that suits it — sixteen cards, four across, four down — where each tie has a whole card instead of a 200px sliver and the team names are readable at a glance.

Two useful side effects. Cards have room to say what actually happened: the tree squeezes a shoot-out into the score as `1 (3)`, while a card writes `PENALTIES · MAR WIN 3-2` across the top. And the split is free operationally, because both graphics live in one [scene](#13-scenes--several-graphics-one-browser-source) on one browser source — two buttons on the control panel, not two sources to wire up in OBS.

The general rule, whatever the sport: **decide your minimum readable type size first, work out how many columns that allows, and then decide how much of the tournament fits.** Not the other way round. A bracket that technically fits is not the same as a bracket anyone can read.

#### Building one

`examples/world-cup-bracket.json` is a complete 32-team bracket; open it and take it apart.

What makes a bracket different from standings is that most of it is *derived*. The **Advance bracket** transform fills it in: you type the first round's teams once and a winner per match as the tournament goes, and every round after that fills itself.

Your data needs a row per match with at least:

| Column | What it holds |
|---|---|
| `slot` | A unique id for the match — `QF1`, `R32L-4`, anything |
| `round` | Which round it belongs to. Rounds run in the order they first appear |
| `homeTeam` / `awayTeam` | The two teams. Fill these in the first round only |
| `winner` | `home`, `away`, or the winning team's name |

With those column names, **Advance bracket** needs no configuration at all: it sends the winner of position 1 and position 2 of a round into position 1 of the next, and so on down the tree.

Two things you can add:

- **Routes.** A `feeds` column holding `"QF1:home"` overrides where a winner goes, for anything the plain tree cannot describe — a bracket split into left and right halves, a reseeding rule, a play-off. Leave a row blank to use the tree; `feedsLoser` does the same for the beaten side, which is how a third-place play-off gets filled.
- **Scores.** Tick *Decide from scores* and the transform works out the winner from your score columns when the `winner` column is empty, with optional shoot-out columns to break a draw.

**Carry** lists what moves with a team. The default is just the name; set it to `Team, Code` and a team's three-letter code travels with it, so your round-of-16 graphic does not need a second lookup.

Two rules worth knowing:

- **Put it first.** Advance reads every round, so anything above it that drops rows — a Filter, a Limit — leaves it nothing to work from. The editor warns you if it ends up in the wrong place. In the bracket example each of the ten tables runs Advance first and filters to its own round afterwards.
- **An undecided match advances nobody.** A drawn score with no shoot-out, a blank winner, a winner naming a team that is in neither line — all of them leave the next slot empty rather than guessing. That is deliberate: an empty slot on air is recoverable, the wrong nation in a semi-final is not.

On a manual table, tick **Resolve bracket** above the grid and the rounds after the first fill in as you type. Those cells go read-only while it is on — they belong to the transform, and letting you type into them would only look like it worked.

### Tickers fed from a source

A crawl layer can take its headlines from a data source instead of a typed list — which is what an RSS feed is for. Under **Crawl data**, pick a **Source** and then the **Column** to read. For a feed that is almost always `title`.

The typed **Items** above stay where they are, and they still matter: they are what shows before the first fetch lands, and what stays up if the feed later comes back empty. Write something neutral there rather than leaving demo text in it.

The stage shows the real rows while you author — the same data the graphic will use on air — so you can confirm a ticker is actually bound to its feed without putting it up. It refreshes on the source's poll interval while the data panel is open.

New headlines join the rotation at the loop seam — they scroll in the way a ticker is supposed to update, never appearing in place. That means a change can take up to one full rotation to show, which is correct, not a delay to work around.

The **Transforms** on a crawl work exactly as they do on a table. A newest-first ticker limited to five stories is a **Sort** on `date` descending followed by a **Limit** of 5.

### Cameras and live media

A **Media** layer (**+ Add… → Live media** in the layers panel, or **Media cell** in a table) plays live pictures from a URL. Unlike a **Video** layer it is not on the timeline: it plays whatever is live when it is shown, and scrubbing the playhead does not move it.

On an output it plays **only while the graphic is on air** — from PLAY until the outro ends or CLEAR — so a graphic waiting in OBS holds no camera connections and makes no sound before it is taken. The editor's stage plays it all the time, so you can see the picture while you build.

| Setting | What it does |
|---|---|
| **URL** | The camera, stream or file. The line below it says what it will play as |
| **Kind** | **From the URL** (below), or say it: **Snapshot**, **MJPEG stream**, **Video file**, **YouTube**, **HLS stream** |
| **Refresh every** | For a snapshot: fetch a new picture every so many seconds. The next picture loads out of sight and swaps in once it has arrived, so a refresh never flashes |
| **Fit** | **Contain**, **Cover** or **Stretch** |
| **When it fails** | **Hide** (the space goes empty), **Hold the last picture**, or — in a cycling table — **Skip to the next page** |
| **Give up after** | Seconds a source gets to show its first picture before it counts as failed. Default 10 |
| **Play sound** | Off by default — a graphic is not a sound source |
| **Binding** | A field on the control panel, so the operator can type a URL to play |

**From the URL** means: `youtube.com` and `youtu.be` addresses are YouTube; `.m3u8` is HLS; `.mp4`, `.webm` and `.mov` are video files; the usual camera stream addresses — `/mjpg/video.cgi`, `.mjpg`, `videostream.cgi`, `action=stream` — are MJPEG; anything else is a snapshot. When a camera's address says nothing, set **Kind**.

YouTube plays muted, with no controls, looping. HLS plays natively where the browser can, and through a copy of hls.js served by Breeze everywhere else — including OBS and vMix.

#### A camera rotation

The media layer's real job is a rotating wall of cameras, and it is built from pieces you already have:

1. A **manual** data source listing the cameras — a `name` column and a `url` column, one row per camera (a Google Sheet works as well).
2. Under **Media checks** on that source, tick **Check each row's media** and pick the URL column. Breeze now checks every camera every minute, and adds four columns to every row: `mediaState` (`ok`, `failed`, `frozen`, or `unchecked` before the first check), `mediaOk`, `mediaSrc` and `mediaKind`.
3. A **table** reading that source, with **Rows per page** `1` and a **Cycle** — say 10 seconds a page.
4. In the table's row: a **Media cell** on the column `mediaSrc`, and a text cell on `name` for the caption.
5. A **Filter** transform: `mediaOk` equals `true`.

A camera that is down, or **frozen** — still answering but showing the same picture for five minutes, which a browser cannot tell apart from a working one — drops out of the rotation on every output at once, and comes back when it recovers. Set **When it fails** on the media cell to **Skip** as well: then a camera that dies between checks is passed over the moment it fails to load, instead of sitting empty for the rest of its page.

Things worth knowing:

- **`mediaSrc` plays through Breeze.** Snapshots and MJPEG streams go through the server (`/media/…`) unless you untick **Play snapshots and streams through this server**: one connection to each camera however many outputs show it, no mixed-content or camera-login trouble in the browser, and the last good frame on screen at once while a stream connects. YouTube, HLS and video files play from where they are.
- **A camera login in the URL** — `http://user:pass@camera/…`, the way camera makers document it — works through the proxy, which sends it as the camera expects, and it is taken out of the rows the outputs receive. It is still part of the source's definition, which anyone who can open the editor can read, so use a view-only camera account. Digest-only cameras need basic authentication switched on, or a URL that carries a token.
- **A stream that drops is reopened.** When a camera's MJPEG stream stops or stalls, the server reconnects to it — backing off up to half a minute — while the graphic keeps its last frame; after five failed tries the layer sees the failure and does what **When it fails** says.
- **Cameras on your own network** are refused like any other private address until they are allowed: add them to `BREEZE_DATA_ALLOW_HOSTS`.
- **Frozen after** (seconds, default 300) is how long the same picture may stay before a camera counts as frozen. Set it to `0` for a camera that can legitimately not change — a car park at night.
- **Check every** (seconds, default 60, at least 15) is how often every camera is checked. **Check now** in the data panel, the control panel's **Check cameras**, and the API below check them all straight away — after fixing one, or before going on air.
- **One camera a page.** **Skip** turns the whole page, so it is meant for a rotation with **Rows per page** `1`; on a grid of several cameras a page, one failure would take the others with it (the editor warns).
- **The next camera is fetched ahead.** A few seconds before a page turns, its snapshot is loaded into the cache, so it arrives already showing — and one that fails to load is already known about, so **Skip** passes it before anyone sees the gap.
- **A kind column.** A camera list can name each row's kind in a column (**Kind column** under Media checks). The media cell then follows it without being told.
- **Thumbnails stream nothing.** The editor's thumbnails show a snapshot, a proxied stream's last frame, or a YouTube video's own thumbnail — never a live stream per thumbnail.

### The separator

**Separator** is what prints between items, and again between the last and the first as the loop comes round. Pick one from the list — bullet, diamond, em dash, pipe, arrow and the rest — or choose **Custom…** to type your own.

The spacing either side of the glyph is part of the value, which is why the presets include it. If you go custom, pad it yourself: `•` with no spaces renders as `storyone•storytwo`.

---

## 13. Scenes — several graphics, one browser source

A lower third and a screen bug usually belong to the same show. They share a look, they were designed together, and they are often on air at the same time — but they roll at different moments, so neither one can be part of the other's timeline.

A **scene** is how you put both on one browser source while keeping them independently triggered.

### What a scene is

Nothing new to learn. A scene is an ordinary composition that contains other compositions as layers, each one marked **Independent** in the properties panel.

```
Game Scene            ← the scene, one browser source
├── Screen Bug        ← independent — rolls on its own
├── Lower Third       ← independent — rolls on its own
└── Background band   ← ordinary layer, part of the scene's own timeline
```

An ordinary composition layer is *absorbed* into the timeline it sits in — that is what you want for a reusable badge inside a lower third, where the badge should animate as part of the strap. Ticking **Independent** does the opposite: that element keeps its own timeline, its own PLAY, its own STOP, and its own place in the control panel. The scene simply hosts it.

### Building one

1. Build the lower third and the bug as normal compositions, and get them working on their own.
2. Make a new composition for the scene.
3. For each one, use **+ Add… → Composition** in the layers panel, then set its **Reference** to the composition you built in step 1 and tick **Independent** in the properties panel. Leave **Channel** blank for now — see [Triggering them](#triggering-them) below.
4. Order them in the layers panel. Top of the list paints on top, exactly as with any other layer — that is what decides whether the bug sits over or under the strap when both are up.

Because an independent element brings its own timeline, the scene has nothing to say about *when* it moves. Keyframes and the In/Out lifetime bar are therefore switched off on an independent layer, and the save is refused if a file somehow has them.

**Position, scale and opacity on this layer are not applied to what airs — by design, not as a bug.** An independent element is a link and a trigger channel, nothing more: it always renders the referenced composition exactly as that composition is built, at its own size. If the bug or the lower third needs to sit somewhere other than where it was designed, or at a different size or opacity, build that into the referenced composition itself. The payoff is that the same composition then renders identically wherever it is mounted — standalone, or inside any number of scenes — instead of depending on where it happens to be dropped this time.

Anything in the scene that is **not** independent — a shared background band, a common shadow — belongs to the scene's own timeline and plays with the scene itself.

> **Worth knowing:** an already-open browser source or preview tab keeps running whatever it loaded when it was opened. Turning a composition into a scene, or adding a new independent element to one, does not change a page that is already sitting open — reload it (and the control panel, if that is open too) so it re-reads the composition and mounts the new element on its own channel. Until then, the page still behaves exactly as it did before the change: the old, already-loaded version responds to its own trigger, and the new element's channel reaches nobody at all. See [section 16](#16-when-something-looks-wrong) if this catches you out.

### Triggering them

Each independent element gets its own address, and it is the element's own name, not the scene's:

```
http://<host>:7331/api/control/<project>/bug/play           the bug
http://<host>:7331/api/control/<project>/lower-third/play    the lower third
http://<host>:7331/api/control/<project>/game-scene/play     the scene's own layers
```

That name is the element's **Channel** — set it in the properties panel to whatever the operator should type. Leave it blank and the address falls back to the composition's URL key, which works but is longer (`bug-1a2b` rather than `bug`). Setting a channel is worth the ten seconds: it is what ends up written on a Stream Deck button and taped to a desk.

Nothing else about the way you already trigger graphics changes. One button per element, the same URL shape, the same names. The only difference is that the two elements now share a render surface instead of costing two.

The control panel shows the same thing: open the scene's control page and you get a block per element, each with its own PLAY / STOP / NEXT / CLEAR and its own state readout. Each block links through to that element's own panel for its text fields — every element is a composition, so it already has a full panel of its own.

Two elements can both have a field called `name` without interfering. They are separate graphics that happen to be neighbors.

There is also a **CLEAR ALL** on a scene panel, which takes every element down in one press. Reloading the browser source does the same thing, but far more bluntly and with a visible flash; use CLEAR ALL.

### Setting fields from the URL

On a single graphic you can seed text straight from the play URL — `?name=Jane`. On a scene there is more than one graphic, so say which one, with a dot:

```
/play/<project>/game-scene?bug.temp=72&lower-third.name=Jane
```

The part before the dot is the element's name. A parameter with no dot goes to the scene's own layers. If you misspell the element name the value is ignored and the browser console lists the names that would have worked.

One consequence: **field names cannot contain a dot** on a graphic used inside a scene, since the dot is what splits the two halves.

### Using the same graphic twice

A scene can hold two copies of the same composition — a HOME badge and an AWAY badge from one design. Give each one a **Channel** in the properties panel (`badge-home`, `badge-away`) and they trigger separately at those addresses. Without it they share a name, and every trigger fires both.

### When to use one, and when not to

A scene is right when the elements belong to the same show and roll from the same operator position. It saves a render surface in vMix and halves the source list.

It is the wrong tool when the elements need to be shown and hidden independently *in the switcher*, or transitioned separately by OBS or vMix. Once they share a browser source, the switcher sees one thing. If an element needs its own fade in the switcher, give it its own source.

---

## 13a. Assets and video

### The asset bin

**Assets** is the third panel down the left column, folded by default. Open it, then drag files onto it or use **Upload**. Images, videos and fonts uploaded here belong to the project, so every composition in it can use them, and they travel with the project folder when you move it to another machine.

Uploaded files get a new name — `logo-3f9a2c11.png` rather than `logo.png`. That is deliberate: the suffix is a fingerprint of the file's contents. Upload a corrected version and it gets a *different* name, so browser sources pick it up immediately instead of showing the old one until someone clears a cache inside vMix. Upload the identical file twice and you get one entry, not two.

Each row has a **⧉** button that copies the asset's path, for pasting into a field or a binding default. **🗑** deletes, with a confirmation — a file marked *in use* is referenced by the composition currently open, but a file with no such mark may still be used by another composition in the project, so read the name before confirming.

### Uploading a corrected file

Upload something whose name is already in the bin — a re-exported `logo.png`, say — and the editor asks what you meant before it sends anything:

- **Replace.** Every layer using the old file switches to the new one, in *every* composition in the project, including ones you do not have open. When it finishes, the bin tells you how many layers changed and names the compositions, so you can go and look. The old file is **retired**, not deleted: it stays on disk and stays in the bin under the `retired` state, so if you replaced the wrong thing you can still get it back. Filing carries over — the new file keeps the old one's title, folder, tags, source, license and expiry.
- **Upload as new.** Both files stay in the bin and nothing on air changes. Existing layers keep pointing at the file they already have.

Drop a whole folder of corrected files and you get **one** dialog for the batch, not one per file. Pick Replace or Upload as new for all of them, and override the odd one that differs on its own row.

Each row shows the old size and the new one — if they match, it says **same size**, which usually means you have re-dropped the file that was already there. Breeze cannot tell for certain without uploading it first, so it asks anyway; either answer is safe in that case, because identical files are recognized as identical once they arrive and nothing is changed or retired.

### Video and transparency

**A `.mov` or `.mp4` cannot carry transparency in a browser source.** This catches people out badly, because the graphic looks correct in the editor — over the editor's own dark background — and goes to air as a black rectangle over your program feed.

The format that works is **WebM with an alpha channel**. If your designer delivers a ProRes 4444 `.mov` stinger, upload it and press **⇄** on its row in the asset bin. The server converts it, showing progress as it goes, and adds the `.webm` to the bin when it finishes. Then point your video layer at the new file.

A large stinger takes minutes. You can keep working while it runs; **✕** cancels.

### If the ⇄ button is grayed out

Transcoding needs **ffmpeg**, which Breeze does not ship. Hover the button and it will tell you exactly what is missing.

Install it, make sure `ffmpeg` and `ffprobe` are on your `PATH`, and **restart Breeze** — the check runs at startup. On Windows the simplest route is `winget install ffmpeg`; on Debian or Ubuntu, `apt install ffmpeg`.

If ffmpeg lives somewhere unusual, set `BREEZE_FFMPEG_PATH` and `BREEZE_FFPROBE_PATH` to the full paths.

One ffmpeg build in circulation lacks the `libvpx-vp9` encoder. Breeze refuses to use it rather than producing a file with the transparency quietly flattened — the button stays disabled and says so. Install a full build.

Only one transcode runs at a time. That is intentional: this server may also be feeding graphics to your switcher, and a video encode will take every core you give it. If the machine is not on air, `BREEZE_TRANSCODE_CONCURRENCY` raises the limit.

---

## 14. Getting it on air

### Adding the browser source

The URL you need looks like this:

```
http://<host>:7331/play/<project>/<composition>
```

Click **Output URL ↗** in the app bar and copy the address, or open the project's tile on the portal and take it from the **Output URL** button there.

**OBS** — Sources → **+** → Browser. Paste the URL, set width `1920`, height `1080`. No custom CSS needed; the page is transparent already.

**vMix** — Add Input → Web Browser. Same URL, size 1920×1080.

> **Check the host part before you paste.** The Output URL link inherits whatever address you opened the editor with. Open the editor at `localhost` and you will copy a `localhost` URL — which works only if OBS or vMix is running on the same machine as the server. On any other machine that URL points the switcher at itself and the source comes up blank. Swap in the server's name or IP address, the one it printed at startup. See [About addresses](#about-addresses).

> **A graphic never appears just because you added the source.** The output page shows nothing until something tells it to play. Adding a browser source in OBS, or opening the URL to check it, will not put a graphic to air. That is deliberate — it is the control panel's job. If you *want* the source appearing in the switcher to be the cue, add `?autoplay=1` to the URL.

> **A source that reloads mid-show comes back on air.** If OBS or vMix reloads a browser source while its graphic is holding — a crash, a scene collection reloaded, someone pressing refresh — the page picks up from another output that is still on air: the same hold, the same page of any table that pages, with the same time left before its next turn, so it turns with the others, and every ticker on the same copy at the same point in its scroll. It does not play the intro again. With no other output on air there is nothing to pick up from, and it waits for the next PLAY as before. To have a page always wait instead, add `?sync=off` to its URL.

### The control panel

![The control panel](images/control-panel.png)

One page per composition, designed to be usable at speed on a laptop or a tablet in the gallery.

- **PLAY** — rolls the graphic in and holds it at the next STOP marker. Press it again and it advances to the next hold, then eventually runs the outro. Repeated PLAY steps the graphic all the way through, which is the one-button workflow. **PLAY can never take a graphic off air.**
- **NEXT** — turns the page of any paged table; with nothing to page, advances to the next hold. Shown when the graphic has more than one hold or a table that pages.
- **PREV** — the mirror of NEXT: back a page, or back to the previous hold. It cuts straight to the earlier hold rather than playing anything backwards, and it never takes a graphic off air.
- **STOP** — runs the outro. This is how a graphic leaves air.
- **CLEAR** — hard reset. Nothing on screen, immediately. The panic button.
- **Step 1/1 · holding** — which hold the graphic is on and what it is doing right now.
- **Pages** — appears when the output reports a table with more than one page: which page it is on (`C · 3/8`), a countdown to the next turn if it cycles, and **◀ PREV / NEXT ▶** for that table alone, plus **HOLD / RESUME** for a cycling one. A table that [follows](#follow--tables-that-change-with-another-table) another says so.
- **Mode** — appears when the project's rules name a mode: a button for each, plus **NORMAL**. The lit one is the mode on air, for the whole project ([rules](#rules--layers-that-react-to-data)).
- **Data** — every fetched source the graphic reads, including those of graphics mounted in it, and what each is doing: *Live*, *Failing* (last good data still on air), *Expired* or *Frozen* (blank on air), or *On backup*. A source with a [backup](#when-the-data-is-bad) has **AUTO / OWN / BACKUP** buttons.
- **Dynamic fields** — edit the text and press **UPDATE ON AIR**. Changes apply live; the graphic does not need re-playing.
- **Show preview** — the real output page, embedded and scaled to fit. It follows what you trigger here and is never counted as a connected output. Switched on with the graphic already on air, it picks up where an output is, as a reloaded browser source does. **Sync to** chooses which one: **Newest output** (the one that reported most recently), any connected output by name and address, or **Off**, which waits for the next command. Changing it reloads the preview. An output shown as *off air* is connected but not showing anything, so a preview following it shows nothing either.
- **Sync check** — under the preview, whether it is showing what the output shows: **In step with Output 1**, or **Out of step** with the rows that differ marked. It compares the hold, every table that pages (its page and the seconds to its next turn) and every ticker (its copy, and how far apart the two are scrolling), against the output the preview follows — or the newest one on air when Sync to is Off. The output's report is a few seconds old at most and the check allows for that. **Resync** puts the preview back where the output is. It reads the graphic's own channel; on a scene, check an independently triggered element from its own panel.

The indicator at the top right says whether an output page is actually connected. If it says *no output connected*, the browser source is not open — pressing PLAY will do nothing visible.

### Checking a graphic without going to air

Open the **Debug URL** — the third button on each scene in the portal's project tile, or add `?scale=contain&debug=1` to the play URL yourself. That scales the stage to the window and adds a readout of the state, time, step and frame rate.

![The debug page with its overlay](images/output-preview.png)

In a debug tab: `Space` play, `→` next, `←` prev, `Esc` stop, `Backspace` clear.

The three buttons on every scene do different jobs, and it is worth being clear which is which:

| Button | What it opens | Use it for |
|---|---|---|
| **Control panel** | The operator page | Driving the graphic — PLAY, STOP, live text edits |
| **Output URL** | The transparent 1:1 page | Pasting into OBS or vMix. Nothing else |
| **Debug URL** | The same page, scaled to fit, with a readout | Checking a graphic in an ordinary browser tab |

Opening an **Output URL** in a desktop browser will look wrong, and is not. See [When something looks wrong](#16-when-something-looks-wrong).

---

## 14a. Remote control — the HTTP API

Everything the control panel does, a URL can do. This is how a Stream Deck, a Bitfocus Companion button, a hardware panel or a script drives Breeze.

### The shape of it

```
http://<host>:7331/api/control/<project>/<channel>/<verb>
```

`<project>` is the project's URL key. `<channel>` is a scene's URL key, or — in a scene — an element's **Channel** ([section 13](#13-scenes--several-graphics-one-browser-source)). `<verb>` is one of:

| Verb | What it does |
|---|---|
| `play` | Rolls in, and holds at the next STOP marker. Press again to advance |
| `next` | Turn a page of any paged table, otherwise advance to the next hold |
| `prev` | Back a page, otherwise back to the previous hold |
| `page` | Go to a page of a table (below) |
| `cycle` | Hold or resume tables that page themselves (below) |
| `stop` | Runs the outro. This is how a graphic leaves air |
| `clear` | Hard reset. Nothing on screen, immediately |
| `clear-all` | Every element of a scene down at once |
| `update` | Push new field values (below) |
| `state` | Read back what the graphic is doing — no side effects |

**Both `GET` and `POST` work for all of them.** A side-effecting GET is poor REST and entirely deliberate: an operator wiring a button in a hurry reaches for a URL, and a great many control surfaces can only issue a plain GET. Use whichever your device makes easy.

Every call answers with JSON:

```json
{ "ok": true, "verb": "play", "channel": "rahb-1k3f9/lower-third", "delivered": 1 }
```

`delivered` is the number of browser sources that received it. **`delivered: 0` means the call worked and nothing was listening** — the graphic is not open in OBS or vMix, so nothing happened on screen. That is the single most useful field for debugging a button that appears dead, and it is worth reading it back rather than assuming.

An unknown project or channel answers `404`, rather than quietly succeeding into a channel nothing renders.

### Changing text

`update` takes fields as query parameters on a GET, or as a JSON body on a POST:

```
http://<host>:7331/api/control/rahb-1k3f9/lower-third/update?name=Jane%20Doe&title=Reporter
```

The names are the **binding names** from the properties panel — the same ones the control panel shows. Changes apply live; the graphic does not need re-playing. Fields fed by a data source are read-only and cannot be pushed this way, deliberately ([section 12](#12-data-sources-and-tables)).

You can also preset fields on the browser-source URL itself, which is applied when the page loads:

```
http://<host>:7331/play/rahb-1k3f9/lower-third?name=Jane%20Doe&autoplay=1
```

### Paging tables

A table is named by its **binding** — the name in its properties panel. Inside a nested composition it is `<mount>.<binding>`, the same address an override field uses. A table with no binding answers to its layer id. Every one of these takes an optional `table=`; without it, the command applies to every table in the graphic.

```
…/next?table=standings              ← one table forward (and any table grouped with it)
…/prev?table=standings              ← one table back
…/page?n=3                          ← page 3 (counting from 1)
…/page?name=C&table=standings       ← the page whose key is C — "Group C"
…/cycle?state=hold                  ← freeze self-paging tables where they are
…/cycle?state=resume                ← set them going again, from the page on screen
```

A page is named with `name=`, not `key=`: `key` on a control URL is always the API key. `page` needs exactly one of `n` and `name`, and `cycle` needs `state`; anything else answers `400`. A `table` the graphic does not have is delivered like any other command and does nothing on the page — the server cannot know a graphic's tables until a browser source has built it.

`next` and `prev` aimed with `table=` only ever turn pages. Without it they keep their old meaning: turn the pages of paged tables if there are any, otherwise move between holds.

`state` reports each paged table under `playback.tables` — its page (counting from 0), page count, key, whether it is cycling or held, and the seconds to its next turn. Add `?data=0` to leave out the retained field data, which on a graphic fed by data sources carries every source's rows and is rarely what a button needs.

From vMix or OBS scripting on the output page itself: `breeze.prev()`, `breeze.page(3)`, `breeze.page('C', 'standings')`, `breeze.cycle('hold')`.

### Setting the mode

```
http://<host>:7331/api/projects/<project>/mode/set?value=first-alert
```

`value` is the mode; empty clears it. Letters, digits, spaces and `. - _`, up to 48 characters. GET and POST both work, and both need the API key when one is set. `GET /api/projects/<project>/mode` reads it back, with every mode the project's rules name. From scripting on an output page, `breeze.mode()` reads the mode and `breeze.mode('first-alert')` sets it on that page alone.

### Choosing a source's backup

```
http://<host>:7331/api/projects/<project>/datasources/<source>/use?mode=backup
```

`mode` is `backup`, `primary` (the source's own rows, even stale or blank) or `auto`. GET and POST both work, and both need the API key when one is set — it changes what is on air. A source with no backup answers `409` to `backup`. The answer carries the source's status: `serving` names the source whose rows are on air when it is not this one, and `use` is set while an operator's choice is in force. The same list the editor reads, `GET /api/projects/<project>/datasources`, reports every source's status and is open to read.

### Checking cameras

```
http://<host>:7331/api/projects/<project>/datasources/<source>/media/check
```

Checks every camera in a camera list now, and answers with each one's state — `ok`, `failed` (with why) or `frozen`. It answers within about four seconds whatever happens; `"done": false` means a slow camera is still being checked, and the list shows the result once it is. GET and POST both work, and both need the API key when one is set: it makes a request to every camera. `GET /api/projects/<project>/datasources/<source>/media` reads the same list without checking, and a source's status in the list of sources carries the counts as `media`.

### The API key

By default there is none, which suits a closed LAN. Set one with the `BREEZE_API_KEY` environment variable and every mutating call — including the GET verb triggers, because a GET that puts a graphic to air is a write in every sense that matters — needs it.

Two ways to send it, because plenty of control surfaces cannot set a header:

```
x-breeze-key: your-key                                    ← header
…/api/control/rahb-1k3f9/lower-third/play?key=your-key    ← query parameter
```

`key` is stripped from an `update` before the rest becomes field values, so it will never turn up as a field on your graphic.

Reads stay open either way: the portal, the browser-source pages and the editor open without credentials, and a browser source never needs one.

**Signing a browser in.** People use the key through the portal, not in addresses. With a key set, the portal's header shows **API key: set — sign in**; click it, type the key once, and that browser is signed in for twelve hours. Then:

- the **editor** can save, upload and create — without signing in it opens and shows everything, but every save is refused;
- **control panels** work without `?key=` in their address;
- the data panel's backup switch works.

The browser never keeps the key. The server answers a correct key with a random session in a cookie that no script on the page can read and no other site can make the browser send. A server restart signs everyone out, and so does changing the key (which takes a restart). **Sign out** from the same chip on a shared machine. Five wrong keys from one address in a minute and it has to wait out the minute. Sign-ins, sign-outs and wrong keys go in the activity log under **Sign-ins**. With no key set, the chip reads **API key: not set**.

Commands sent over a control panel's live connection need the key too — a signed-in browser, or a panel opened with `?key=`. A panel with neither shows *This server needs its API key* when a button is pressed. Reading state stays open.

Wrong keys are counted wherever they are tried — the portal, a `?key=` or an `x-breeze-key` header — so the five-a-minute limit applies to every route; a device configured with a wrong key will find itself waiting too. Keys are taken out of addresses before the server logs them.

Behind a reverse proxy, pass the original `Host` header through (`proxy_set_header Host $host` in nginx): a session is only accepted from a page whose address matches the one the server sees. The proxy is also the only address the wrong-key limit can see, so one person's typos make everyone behind it wait.

Browsers send a cookie to every port of the machine it came from, so any other web service on the Breeze machine — Companion's own web interface, say — receives the session cookie too. Signing out, or a server restart, ends it. Over plain HTTP the session cookie, like the key, can be read by anyone capturing traffic on the network; HTTPS in front of Breeze is the only fix for that, and the cookie is marked `Secure` automatically when it is served over HTTPS.

> A key in a query string is visible in the activity log, in any proxy log, and to anyone reading over your shoulder at the desk. It exists so header-less hardware can work at all, not because it is the better of the two. Use the header where the device allows it.

### Bitfocus Companion

Companion is the recommended way to drive Breeze from a Stream Deck: it speaks to the hardware natively, and it can read state back to colour the buttons.

#### The Breeze module

There is a Breeze connection module for Companion, maintained at
[bitfocus/companion-module-breeze-overlay](https://github.com/bitfocus/companion-module-breeze-overlay).
It gives you the verbs as proper actions, button colouring from live playback state, and
variables — rather than a URL per button.

Once it is published in the Bitfocus module directory, install it from Companion's
**Modules** page by searching for **Breeze Overlay**. Then **Connections → Add connection →
Breeze Overlay**, and fill in:

| | |
|---|---|
| **Server address** | The machine running Breeze. If Companion is in Docker, this must be an address that container can reach — its own `localhost` is not your Breeze machine |
| **Port** | `7331` |
| **Project URL key** | The project this connection drives |
| **API key** | Only if `BREEZE_API_KEY` is set |

Every action and feedback takes a **channel** — a scene's key, or a scene element's
Channel — and blank means the connection's default. `project/channel` also works, so one
connection can reach a second project.

The feedback worth putting on every button is **No browser source attached**: it warns
you, before you press anything, that nothing is listening on that channel. The module
also logs a warning whenever a verb reaches zero browser sources.

**Presets.** The module generates a ready-made button set for every scene and every scene
element in its project — PLAY / NEXT / STOP / CLEAR, plus CLEAR ALL on scenes. Drag them
in from Companion's preset list rather than building buttons by hand. The PLAY preset
comes with the on-air and missing-source feedbacks already attached.

Presets are built when the connection starts, so a scene added in Breeze appears after
you press **Save** on the connection.

**Data sources.** The **Data source** action puts a source's [backup](#when-the-data-is-bad)
on air, keeps its own rows, or hands back to automatic; it takes the source's id, shown
beside its name in the data panel. **Data source is…** lights a button while a source is
on its backup, failing, or expired, and `$(breeze:sources_failing)` and
`$(breeze:sources_on_backup)` count them across the project. Every source with a backup
gets a **BACKUP** preset.

**Mode.** The **Mode** action sets, toggles or clears the project's mode; **Project mode
is…** lights a button while it is on, and `$(breeze:mode)` reads it. Every mode your rules
name gets a toggle preset in the *Modes* section.

Name each connection after its project when you drive more than one — the module's
Help page covers this, along with how to wire buttons for nested compositions.

#### Or the generic HTTP module

If you would rather not install anything, Companion's built-in
**Generic: HTTP Requests** module drives Breeze perfectly well:

1. **Connections → Add connection → Generic: HTTP Requests.** No base URL is required; put the whole address in each action.
2. On a button, add the action **GET request** (or POST).
3. URL: `http://<host>:7331/api/control/rahb-1k3f9/lower-third/play`
4. Add a second action on the same button's **release** — or a second button — for `stop`.

A workable four-button layout per graphic is PLAY / NEXT / STOP / CLEAR, which is exactly what the control panel shows. Label the buttons with the channel name, not the scene name, when you are driving a scene's elements.

For a text field, Companion's variables go straight into the URL:

```
http://<host>:7331/api/control/rahb-1k3f9/lower-third/update?name=$(internal:custom_name)
```

Remember to URL-encode anything that might contain a space or an ampersand — Companion has a `urlencode` expression function for this.

### Reading state back

`state` is a plain GET with no side effects, so it is safe to poll:

```
http://<host>:7331/api/control/rahb-1k3f9/lower-third/state
```

```json
{
  "channel": "rahb-1k3f9/lower-third",
  "state": {
    "data": { "name": "Jane Doe" },
    "playback": { "state": "holding", "time": 1.2, "step": 1, "stepCount": 2 },
    "reportedAt": 1790626119416,
    "now": 1790626121020,
    "sources": [
      {
        "id": "c4k2…",
        "page": "1m0b0t1x",
        "label": "OBS on Windows",
        "ip": "192.168.1.20",
        "connectedAt": 1790625000000,
        "playback": { "state": "holding", "time": 1.2, "step": 1, "stepCount": 2 },
        "reportedAt": 1790626119416
      }
    ],
    "renderers": 1,
    "controllers": 2,
    "updatedAt": "2026-08-08T19:02:11.400Z"
  }
}
```

`renderers` is how many browser sources are attached — `0` is the "nothing is listening" case above. `playback.state` is what the graphic is doing, which is what you would drive a button colour from. It is always an output's report: an operator's preview never changes it while an output is connected.

`sources` lists each connected output and what it last reported, and `reportedAt` and `now` are the server's clock in milliseconds, so `now - reportedAt` is how old a report is. These are what a page joining late picks up from.

### Finding the addresses

You do not have to read them off the editor one at a time:

| | |
|---|---|
| `GET /api/projects` | Every project, with its scenes |
| `GET /api/projects/<project>/channels` | Every address that project answers to, including scene elements |
| `GET /api/status` | Server-wide: what is connected right now |

`/channels` is the authoritative list — it is the same index the server resolves a trigger against, so if an address is not in there, it will 404.

### Checking a button before the show

`curl` from the machine that will be sending, which tests the address and the network path in one go:

```bash
curl "http://graphics-pc:7331/api/control/rahb-1k3f9/lower-third/state"
curl "http://graphics-pc:7331/api/control/rahb-1k3f9/lower-third/play"
```

If the second returns `"delivered": 0`, the URL is right and the browser source is not open. If it returns `404`, check the project and channel keys against `/channels`. If it returns `401`, the API key is set and missing from your call.

---

## 15. Keyboard shortcuts

**Everywhere in the editor**

| | |
|---|---|
| `Ctrl+S` | Save |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |

**When not typing in a field**

| | |
|---|---|
| `Space` | Play / pause the preview |
| `Home` | Playhead to the start |
| `Delete` / `Backspace` | Delete selected keyframes — or the selected layer, if no keyframes are selected |
| `Ctrl+C` / `Ctrl+V` | Copy keyframes / paste them at the playhead |

**Stage**

| | |
|---|---|
| `Alt`-drag or middle-drag | Pan |
| `Ctrl`+wheel | Zoom about the pointer |

**Timeline**

| | |
|---|---|
| `Ctrl`+wheel | Zoom about the pointer |
| `Shift`+wheel | Scroll sideways |
| Double-click a keyframe | Edit its easing |
| Double-click a marker | Delete it |

**Layers**

| | |
|---|---|
| `Shift`-click / `Ctrl`-click | Add to the selection |
| Double-click a name | Rename |

**Debug / output tab**

| | |
|---|---|
| `Space` | Play |
| `→` | Next |
| `Esc` | Stop |
| `Backspace` | Clear |

---

## 16. When something looks wrong

**The graphic does not appear in OBS.** The output page waits to be told to play. Open the control panel and press PLAY, or add `?autoplay=1` to the URL. If pressing PLAY does nothing at all, check **Browser sources** on the portal's status strip — a reading of `0` means no output page is connected for anything to play *on*, which is usually a wrong host in the URL rather than a problem with the graphic.

**A scene will not delete — it says something else is using it.** Another scene mounts it as a layer. The dialog lists which ones and which layer in each; open those and remove the layer, then delete. Breeze refuses this on purpose: the parent would go on loading and playing with one graphic silently missing, and you would find out during a show rather than now.

**I deleted a project by mistake.** There is no undo and no recycle bin — the project directory, its assets and its data sources are removed from disk. That is why the confirmation makes you type the name. If you have a release snapshot or a backup of your data folder, restoring the project's directory into `data/projects/` and restarting the server brings it back.

**A layer has vanished from the stage.** Check the stage toolbar — it will say whether the layer is outside its lifetime at this playhead, or has animated off-stage. Also check the visibility dot in the layers panel.

**A layer cannot be dragged.** It is locked. Click the padlock.

**A newly added layer is stuck at the end of the timeline.** It was created at the playhead. Drag its lifetime bar left, or set **In** to `0`.

**Save is refused with a red banner.** The composition is invalid. The banner lists each problem with the field it belongs to; fix those and save again. Nothing is lost in the meantime — your work is still in the editor.

**The motion looks stuttery in OBS but fine in the editor.** A Browser Source ticks at the OBS output frame rate unless *Use custom frame rate* is enabled in its properties. If the debug overlay reports 30 fps, check OBS → Settings → Video → FPS. The page cannot paint faster than OBS ticks it.

**A name is running past the end of its strap.** Turn on **Fit width** for that text layer and set a **Max width**. If it is already on, the text has hit the **Min scale** floor — the strap genuinely is too short for that name.

**The graphic looks cropped when I open the play URL in a browser.** It is not. The output page is 1:1 at full stage size — a 1920×1080 graphic in a smaller desktop window will clip. Use the **Debug URL** on the portal instead, or add `?scale=contain` to see it fitted to the window. A graphic low in the frame, like a ticker at y=1000, is the confusing case: it plays correctly and is simply below the bottom of the window, so PLAY looks as though it did nothing.

**In a scene, triggering one element rolls both of them.** They are sharing a name. This happens when the same composition is used twice in one scene — two copies of a badge, say. Give each one its own **Channel** in the properties panel and trigger those names instead. See [section 13](#13-scenes--several-graphics-one-browser-source).

**Triggering an individual element does nothing, but the scene's own PLAY brings everything up.** The output page (or control panel) was already open before you added or changed an independent element. What to mount, and which channels to listen on, is written into the page once, when it loads — it does not update itself when the composition changes underneath it. Reload the browser source and the control panel so each re-reads the current composition. After that, the scene's own address should do nothing at all once every layer in it is independent, and each element's own address should work on its own. See [Building one](#building-one) in section 13.

**A scene element will not take keyframes.** That is deliberate. An independent element brings its own timeline, so the scene has no say in when it moves — animate it in its own composition instead. Position on the stage still works.

**A field set from a scene's URL is being ignored.** Check the part before the dot matches the element's name exactly — `?bug.temp=72`, not `?screenbug.temp=72`. The browser console lists the names that would have worked. A parameter with no dot at all goes to the scene's own layers, not to any element.

**One element of a scene is missing and the rest are fine.** That element failed to build; the page deliberately keeps the others running rather than going black. The browser console names the element and the reason. Open that composition on its own play URL to see the error in isolation.

**I need to rename a project or composition's URL key.** You cannot, by design — the key is already inside every browser source pasted into OBS and every trigger button on the Stream Deck, and changing it would break all of them silently. The *name* can be changed freely at any time; only the key is fixed. If the key is genuinely wrong, create a new project or composition with the right one and copy the work across.

**A table or ticker is showing old data.** Check the source's row in the data panel. "Fetched" is when it last tried; "changed" is when the content last actually differed. If fetched is recent and changed is not, the origin genuinely is not changing. If fetched is stale, look for the error under the source — a failing source is highlighted, and keeps its last good rows deliberately so the graphic does not blank.

**A source will not fetch and says it refuses a private address.** The server will not fetch URLs on your own network by default, because it sits on the same LAN as the switcher and would otherwise be a way to reach it. If the feed really is on the LAN — a scoring PC, an internal results server — someone with access to the server adds that host to `BREEZE_DATA_ALLOW_HOSTS`.

**A table's numbers are sorting in the wrong order — 10 before 9.** That column is being read as text. Check its type in the source: CSV, XML and Sheets all arrive as text and the type is guessed from a sample, so a column with a stray note in one cell ("9 *") gets read as text for every row. Fix the cell, or declare the column's type on the source.

**A ticker bound to a source is still showing its typed items.** Three things to check, in order: a **Column** is picked (a source with no column does nothing); the column name matches one the source actually has; and the column is not empty for every row. In all three cases the ticker deliberately falls back to the typed items rather than going blank.

**A ticker's headlines look stale on the stage.** The preview refreshes on the source's poll interval, but only while the data panel is open — it stops polling when you collapse it. Expand the panel, or press **Refresh** on the source.

**A private Google Sheet returns a permission error.** A service account is not you. The sheet has to be shared with the account's `client_email` address, the same way you would share it with a colleague.

**NWS started returning errors or 403s after working fine.** Almost certainly the User-Agent. Fill in **Contact** on the source, or better, have `BREEZE_CONTACT` set on the server. Without it you are sharing a generic string with every other Breeze installation, and NWS blocks by that string.

**A weather source says NWS has no forecast for that point.** `api.weather.gov` covers the United States and its territories only. For anywhere else, use MET Norway (worldwide, commercial use fine with a credit), Bright Sky if you are in Germany, or Open-Meteo — and check the commercial-use note above before choosing that last one.

**MET Norway returns "forbidden".** Two likely causes, neither of them a password. Most often it is the coordinates: MET rejects anything with more than four decimal places, and a latitude pasted out of Google Maps has six — Breeze trims them for you, so this points at a hand-edited source file. Otherwise it is identification: fill in **Contact for User-Agent**, or have `BREEZE_CONTACT` set on the server.

**Bright Sky says it has no station near that point.** It carries DWD data, which is Germany and a little way over the borders — nothing further afield. Use MET Norway for anywhere else.

**A weather source will not save, saying it needs a base URL.** You picked **Open-Meteo — self-hosted** but did not say where your instance is. Fill in the instance address, or switch to the hosted provider. It refuses rather than quietly using the hosted service, because that service is non-commercial and falling back to it silently could put you in breach without anyone knowing.

**I typed a 30-second weather poll and it says 900.** Weather providers set their own limits and the field raises anything below them. Nothing is wrong, and you lose nothing: forecasts do not recalculate more than hourly.

**My own Open-Meteo instance works in a browser but the source says the request was rejected.** Almost always the **Model** field. A URL you tested by hand probably had `&models=…` on it; leaving the field blank asks for "best match" instead, which may want a model your instance has not downloaded. Put the same model id into **Model**.

**My weather temperatures are wrong by about 30 degrees.** Check the **Units** setting — °F and °C, not the provider. If they are right and the numbers are still wrong, check the latitude and longitude have not been swapped; Phoenix is `33.4484, -112.074`, and the longitude is the negative one in the Americas.

**A file drop says no file matches the pattern.** The pattern is matched against the file *name* only, not the path, and it has to match the whole name. `results-*.csv` will not match `2026-results.csv`. Capitalisation does not matter. If you are unsure what is actually in the folder, the error tells you how many files it saw.

**A file drop is showing yesterday's results.** It takes the newest file that matches. If today's file was written with a different name — a typo, or a different date format — it will not match the pattern and yesterday's will still be the newest match. Widen the pattern, or fix the name.

**A file drop asks for a credential I do not have.** Leave **Credential id** blank for an anonymous drop. If the server needs a login, whoever runs the Breeze server stores the password or SSH key and gives you the *name* to type in — you never enter the password itself.

**Nothing animates at all — every graphic sits still, or the page is blank.** Look at the browser source's name in OBS or vMix: if it reads *GSAP problem — Breeze*, the animation engine did not load. See [section 17](#17-upgrading-the-animation-engine); the browser console names the exact problem. This is the one failure that affects every graphic at once, so a single one misbehaving is not this.

**I replaced `gsap.min.js` and nothing changed.** Restart the Breeze server. Pages ask for the file with the version number the server read at startup, so until it restarts, browsers are still being pointed at the old one and serving it from cache. Section 17 has the full sequence.

---

## 17. Upgrading the animation engine

Every movement in Breeze — every keyframe, every ease, every text reveal — is played by **GSAP**, an animation library made by GreenSock. It is not part of Breeze and is not compiled into it: it sits in the installation as two ordinary files, which is what makes this section possible at all.

You almost certainly do not need to do this. Breeze ships with a version that has been tested against it, and there is no benefit to being on the newest one. The reason to upgrade is a specific one — a bug in GSAP that a new release fixes, or a security note about the version you have.

**Where the files live**

```
apps/server/public/vendor/gsap/
    gsap.min.js          the engine
    SplitText.min.js     the part that splits text into characters and words
    VERSION              which release is staged
```

**To upgrade**

1. Download the release you want from [gsap.com](https://gsap.com) and take `gsap.min.js` and `SplitText.min.js` from its `dist` folder. Take both, from the same release — they are a matched pair, and mixing versions is its own class of problem.
2. Stop the Breeze server.
3. Replace the two files. Keep the names exactly as they are.
4. Put the new version number into `VERSION`, on its own line — for example `3.15.1`. This is what tells browsers the file has changed; skip it and they will keep using the copy they already have.
5. Start the server and reload one browser source.

**To check it worked**, open a graphic's play URL in a browser, open the developer console (F12) and type `gsap.version`. It will report what is actually loaded. Then play a graphic with a text reveal in it — that exercises both files, not just one.

**If something is wrong**, the page says so rather than going quietly black. The browser source's name changes to *GSAP problem — Breeze*, which is visible in the OBS and vMix source lists without opening anything, and the console explains: the version is outside the range this build of Breeze supports (3.13 or newer, below 4.0), or a file did not load, or SplitText is missing. Put the old files back and restart — nothing else on the installation has changed, so that is a complete undo.

**Two things this does not survive.** Rebuilding Breeze restages the version it was built against, overwriting your files; that is deliberate, so a rebuilt installation is always in a known state. And upgrading Breeze itself brings its own tested GSAP. If you need a particular GSAP release permanently, tell whoever maintains your installation — it is a one-line change in the project's configuration, and better recorded there than reapplied by hand after every build.

GSAP is licensed separately from Breeze, under GreenSock's [Standard License](https://gsap.com/standard-license). Breeze's own licence does not cover it, and replacing these files does not change that.
