# Integrations

Things that talk to Breeze from outside, kept in the repo so they version alongside the
API they depend on.

## companion-module-breeze-overlay

A [Bitfocus Companion](https://bitfocus.io/companion) connection module. Actions for
every control verb, feedbacks that colour a button from live playback state, and
variables for the connection's default channel.

Built against **`@companion-module/base` v2.x**, which is Companion **v4.3 and later**.
That matters: v2 removed `runEntrypoint` and changed `InstanceBase` to be generic over a
manifest schema, so a v1-era module will not load in v5 and vice versa. The compatibility
table lives in the module-base README.

### Building

```bash
cd companion-module-breeze-overlay
yarn install
yarn build      # tsc -> dist/
yarn package    # -> breeze-overlay-<version>.tgz
```

`yarn package` rewrites `runtime.apiVersion` in the manifest to whatever version of
`@companion-module/base` is installed, and points `entrypoint` at the bundled output —
so the values committed in `companion/manifest.json` are placeholders, not the truth.

`yarn package` writes `dist/breeze-overlay-<version>.tgz`. That is what Companion
installs, under **Modules → Import module package**.

`dist/` is gitignored, so the built package is **not** in the repository — attach it to
the GitHub Release for the matching version instead, and users can install it without a
toolchain. Companion holds several versions side by side and you pick one per
connection, so publishing each release's `.tgz` lets a connection be rolled back.

### Developing against a running Companion

Companion also loads modules from a *developer modules path* — a folder you set in the
launcher's settings, whose subfolders are each a module. Saving a file there restarts any
connection using it. Note that a Companion running in Docker sees that path inside its
own container, not on your host.

### Presets

Built at connect time from `GET /api/channels`, which lists every scene and scene
element on the server in one request. Each channel gets PLAY / NEXT / STOP / CLEAR, plus
CLEAR ALL on scenes only — on a plain scene it would duplicate CLEAR, and two buttons
that do the same thing invites the wrong one being pressed.

Only the connection's own project gets presets. Offering buttons that silently address a
different project is how a graphic reaches the wrong show.

They are rebuilt on connect and on save, not on every poll: presets are a catalogue to
drag from rather than live state. Add a scene in Breeze and hit Save on the connection to
pick it up.
