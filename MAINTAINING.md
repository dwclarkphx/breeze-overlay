# Maintainer's Guide

The workflow for taking an issue from report to released fix. This is a solo-maintained project: issues are welcome, code changes come from the maintainer (see CONTRIBUTING.md).

## 1. Issue intake and sorting

New issues arrive with the `needs-triage` label (set by the templates). Triage pass — ideally within a few days:

1. **Duplicate?** Close with a link to the original.
2. **Actually a usage question?** Convert to a Discussion or answer and close.
3. **Bug with repro steps?** Try the repro (step 2 below). If it reproduces, replace `needs-triage` with `confirmed` and add a priority label. If it doesn't, add `needs-repro` and ask the reporter for more detail (template JSON, console errors, environment).
4. **Feature request?** Replace `needs-triage` with `enhancement` if accepted, close with a short explanation if not.

Labels:

| Label | Meaning |
|---|---|
| `needs-triage` | New, unsorted |
| `needs-repro` | Can't reproduce yet; waiting on reporter |
| `confirmed` | Reproduced locally |
| `p1` | Breaks live output (OBS/vMix rendering, /play) — fix before anything else |
| `p2` | Editor broken or badly degraded, workaround exists |
| `p3` | Cosmetic, minor, or edge case |
| `enhancement` | Accepted feature request |
| `wontfix` | Deliberate decision not to change |

Issues with `needs-repro` and no reporter response for 30 days can be closed as not-reproducible (they can always be reopened).

## 2. Reproducing

- Reproduce on a clean checkout, not your working tree: `git stash` or a fresh clone.
- **Build first.** `pnpm start`/`dev` do not rebuild workspace deps — always `pnpm build` before testing, or you're testing the old bundle.
- Use the reporter's template JSON if provided (drop into `data/projects/`).
- Check the affected surface matters: `/play` output clips in a desktop window and low-graphics modes can *look* broken without being broken — verify in an actual OBS browser source or vMix web input before confirming output bugs.
- Once reproduced, write the failing test **before** the fix (unit in the affected package, or e2e in `tests/e2e`). This is the test that later proves the fix.

## 3. Fixing

- Branch from `main`: `fix/issue-NNN-short-description`.
- Keep the fix minimal; unrelated cleanup goes in its own commit or branch.
- Testing gotchas that have bitten before:
  - `display:none` layers measure `offsetWidth` 0 — hidden-layer code paths need explicit tests.
  - Computed opacity can't distinguish "animation not started" from "finished" — read the inline style in tests.
  - GSAP is loaded from `apps/server/public/vendor/gsap/`, not bundled. A test that fails with every animation dead usually means the build never ran and the vendor files were never staged — `pnpm build` stages them.

## 4. Confirming resolution

All three must pass locally before merging:

```bash
pnpm build        # required first — dev/test won't rebuild deps
pnpm test         # unit tests incl. the new regression test
pnpm test:e2e     # playwright — config is tests/playwright.config.ts
```

To run one spec rather than the suite, use `pnpm test:e2e:only <name>` (for example `pnpm test:e2e:only diagnostics`). A bare `pnpm exec playwright test <name>` will report no tests found: Playwright only auto-discovers a config at the repo root, and this one lives under `tests/` with the suite it configures.

If `test:e2e` dies before a single test runs with `listen EACCES ... 127.0.0.1:7399`, the port has been reserved out from under you rather than taken by another process — on Windows, Hyper-V/WSL2 grabs blocks of ports for NAT and those blocks shift when the service restarts. Confirm with `netsh interface ipv4 show excludedportrange protocol=tcp`; if 7399 sits inside a listed range, run with `BREEZE_E2E_PORT` set to a port outside every range.

CI runs the same sequence on every push and PR (`.github/workflows/ci.yml`), plus two checks that need only the install: `pnpm version:check` and `pnpm notices:check`. Merge to `main` only when CI is green. Reference the issue in the commit message (`fixes #NNN`) so GitHub auto-closes it.

## 5. Version numbers

`MAJOR.MINOR.PATCH`, always three parts. Two rules:

- **Feature** — bump the minor, **reset the patch to 0**: 0.45.0 → 0.46.0
- **Fix** — bump the patch, **leave the minor alone**: 0.45.0 → 0.45.1

The patch resets; the minor never goes backwards. `scripts/sync-version.mjs` rejects anything that isn't three dot-separated numbers — including `0.45`, `v0.45.0` and pre-release suffixes like `1.0.0-rc.1` — and it runs first in CI, so a malformed version can't reach a release.

Bump the **root** `package.json` and propagate with `pnpm version:sync`, which writes it into the four workspace manifests. The root manifest is the single source of truth; nothing else states a version by hand, and `pnpm version:check` fails if anything has drifted.

**1.0.0 is the first public release**, cut once the project schema is settled. Until then the leading `0` is doing real work: it is the standard signal that the format may still change. While on 0.x, a minor bump is allowed to break saved project files — that is what 0.x *means*, and it is why the schema needs to be final before 1.0.0 rather than after. From 1.0.0 on, anything that stops an existing `.json` project loading is a major bump.

Releases 0.37–0.44 predate this: they were versioned by folder name only, and every one of those manifests still reads `0.1.0` inside. 0.45.0 is the first release where the number is real.

### Where the version shows up

Everything below is derived from the root `package.json` — none of it is written by hand:

| Surface | Source |
|---|---|
| `pnpm` script banner (`@breeze/server@0.47.4`) | the workspace manifests, via `version:sync` |
| Server startup log, first line | `apps/server/src/version.ts`, reading its own manifest at runtime |
| `GET /healthz` → `{ ok, version, formatVersion }` | same |
| Portal page, beside the title | same |
| Editor app bar, beside the brand | `__APP_VERSION__`, injected by Vite from `apps/editor/package.json` |

`version` is the product; `formatVersion` is the composition document, which has been at 1 since Phase 0 and moves on its own clock. `/healthz` used to report only the latter, under the name `version` — so a health check answered "1" for every build ever shipped.

## 6. Dependencies

`THIRD-PARTY-NOTICES.md` is generated from the installed production tree by `pnpm notices` and verified in CI by `pnpm notices:check`. Adding or removing a production dependency means regenerating it in the same commit, or CI fails.

GSAP is the one dependency that is *not* in that generated table, because it is not bundled and is therefore not a dependency of anything at build time. It is staged into `apps/server/public/vendor/gsap/` by `pnpm vendor` (run automatically by the server's build) and loaded by a script tag. Two consequences worth knowing:

- **Upgrading it is a manifest change.** Bump the `~3.15.0` pin in *both* `packages/runtime/package.json` and `apps/editor/package.json` — they must match — then rebuild. `pnpm vendor:check` in CI fails if the staged files and the pin disagree.
- **The supported range is wider than the pin.** The output page checks the loaded GSAP against `>=3.13 <4` and reports a mismatch through the browser source's title. That range lives in `apps/server/src/pages.ts`; widen it deliberately, not by accident.
