# Maintainer's Guide

The workflow for taking an issue from report to released fix. This is a solo-maintained project: issues are welcome, code changes come from the maintainer (see CONTRIBUTING.md).

## 1. Issue intake and sorting

New issues arrive with the `needs-triage` label (set by the templates). Triage pass — ideally within a few days:

1. **Duplicate?** Close with a link to the original.
2. **Actually a usage question?** Convert to a Discussion or answer and close.
3. **Bug with repro steps?** Try the repro (step 2 below). If it reproduces, replace `needs-triage` with `confirmed` and add a priority label. If it doesn't, add `needs-repro` and ask the reporter for more detail (template JSON, console errors, environment).
4. **Feature request?** Replace `needs-triage` with `enhancement`; add to `dev/docs/ROADMAP.md` if accepted, close with a short explanation if not.

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
- Testing gotchas that have bitten before (details in the private `dev/docs/TESTING.md` notes):
  - `display:none` layers measure `offsetWidth` 0 — hidden-layer code paths need explicit tests.
  - Computed opacity can't distinguish "animation not started" from "finished" — read the inline style in tests.

## 4. Confirming resolution

All three must pass locally before merging:

```bash
pnpm build        # required first — dev/test won't rebuild deps
pnpm test         # unit tests incl. the new regression test
pnpm test:e2e     # playwright — config is tests/playwright.config.ts
```

To run one spec rather than the suite, use `pnpm test:e2e:only <name>` (for example `pnpm test:e2e:only diagnostics`). A bare `pnpm exec playwright test <name>` will report no tests found: Playwright only auto-discovers a config at the repo root, and this one lives under `tests/` with the suite it configures.

If `test:e2e` dies before a single test runs with `listen EACCES ... 127.0.0.1:7399`, the port has been reserved out from under you rather than taken by another process — on Windows, Hyper-V/WSL2 grabs blocks of ports for NAT and those blocks shift when the service restarts. Confirm with `netsh interface ipv4 show excludedportrange protocol=tcp`; if 7399 sits inside a listed range, run with `BREEZE_E2E_PORT` set to a port outside every range.

CI runs the same sequence on every push and PR (`.github/workflows/ci.yml`). Merge to `main` only when CI is green. Reference the issue in the commit message (`fixes #NNN`) so GitHub auto-closes it.

## 5. Releasing

The git repo that gets pushed to GitHub lives in `github_push/`, a clean staging copy — the working folder itself is never pushed. `dev/make-release.mjs` builds both release copies in one run: the private `releases/breeze_overlay-<version>/` snapshot and a refreshed `github_push/` (`dev/` stripped, `.git/` history preserved).

Everything private lives under `dev/` — maintainer scripts, planning and test notes (`dev/docs/`), and the `dev/build_test/` scratch area. The public copy drops that one directory, so nothing private needs its own exclusion rule.

`scripts/` stays public on purpose: CI runs `scripts/sync-version.mjs` as its first step (`pnpm version:check`) and `apps/server/src/__tests__/version.test.ts` is pinned to it. Moving it into `dev/` would red-X every commit on GitHub.

### Version numbers

`MAJOR.MINOR.PATCH`, always three parts. Two rules:

- **Feature** — bump the minor, **reset the patch to 0**: 0.45.0 → 0.46.0
- **Fix** — bump the patch, **leave the minor alone**: 0.45.0 → 0.45.1

The patch resets; the minor never goes backwards. `scripts/sync-version.mjs` rejects anything that isn't three dot-separated numbers — including `0.45`, `v0.45.0` and pre-release suffixes like `1.0.0-rc.1` — and it runs first in CI and again at the top of every `pnpm release:copy`, so a malformed version can't reach a snapshot.

**1.0.0 is the first public GitHub release**, cut once the project schema is settled. Until then the leading `0` is doing real work: it is the standard signal that the format may still change. While on 0.x, a minor bump is allowed to break saved project files — that is what 0.x *means*, and it is why the schema needs to be final before 1.0.0 rather than after. From 1.0.0 on, anything that stops an existing `.json` project loading is a major bump.

Releases 0.37–0.44 predate this: they were versioned by snapshot folder name only, and every one of those manifests still reads `0.1.0` inside. 0.45.0 is the first release where the number is real.

#### First push only

The canonical repo is **<https://github.com/dwclarkphx/breeze-overlay>**. `github_push/` needs its git repo created once and pointed at it; every release after that reuses the same `origin`. Create the GitHub repo **empty** — no README, no `.gitignore`, no license — because the staging copy already carries all three, and an initial commit on GitHub's side makes the first push a non-fast-forward.

```bash
cd github_push
git init -b main
git remote add origin https://github.com/dwclarkphx/breeze-overlay.git
```

Then run the numbered steps below as normal.

1. Confirm build + tests green locally (section 4).
2. Bump `version` in the **root** `package.json` (see the rules just above), then propagate it:
   ```bash
   pnpm version:sync     # writes it into the four workspace package.json files
   ```
   The root manifest is the single source of truth; nothing else states a version by hand. `pnpm release:copy` runs this for you, and `pnpm version:check` fails if anything has drifted — so a half-landed bump cannot be frozen into a snapshot. `apps/server/src/__tests__/version.test.ts` asserts the same thing in CI.
3. Update a `CHANGELOG.md` entry (or the release notes draft) listing fixed issues by number.
4. Build both copies:
   ```bash
   pnpm release:copy
   ```
   Flags: `--github-only`, `--snapshot-only`, `--force` (overwrite an existing snapshot).
5. Commit, tag, and push from the staging copy:
   ```bash
   cd github_push
   git add -A
   git commit -m "v0.X.Y — <summary> (fixes #NNN)"
   git tag v0.X.Y
   git push origin main --tags
   ```
6. Confirm CI is green on GitHub, then create a GitHub Release from the tag with the notes. Ask reporters on the closed issues to confirm the fix in the release.

The `releases/breeze_overlay-<version>` snapshots stay private (gitignored, never in `github_push/`). Public version history is git tags + GitHub Releases.

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

## What gets published vs. what stays local

The release script enforces this split — `github_push/` only ever contains the published set.

**Published** (copied into `github_push/`):

- All source: `apps/`, `packages/`, `tests/`, `examples/`, `scripts/` — the e2e suite and its `playwright.config.ts` both live under `tests/`, and both are published: contributors and CI need the suite, and tests are part of the product
- `pnpm-lock.yaml` — contains only package names/versions/hashes, no secrets; required for reproducible installs (`--frozen-lockfile` in CI)
- `.npmrc` — contains only resolution settings, no tokens
- `README.md`, `LICENSE`, `CONTRIBUTING.md`, this file, `docs/` (the user guide and its images), `.github/`, `.gitignore`

**Never published** (excluded by the script and gitignored):

- `dev/` — the whole private directory: `make-release.mjs`, `docs/` (ROADMAP.md, AUDIT-*.md, NDI_PLAN.md, TESTING.md, DATA-SOURCES.md), and `build_test/`

`ROADMAP.md` is private as of 2026-08-02 pending a slimmed public version. Source comments across `packages/` and `tests/` still cite `ROADMAP §N` by section number — those references stay valid as long as the public rewrite keeps the existing section numbering.
- `releases/` — private version snapshots
- `github_push/` itself (from the working folder's perspective)
- `data/projects/`, `data/assets/`, `data/tmp/` — user runtime data (`.gitkeep` placeholder kept)
- `node_modules/`, `dist/`, build caches
- `.env*` — any credentials live here, never in tracked files
- Test output: `coverage/`, `test-results/`, `playwright-report/`

Adding something private? Put it in `dev/`. That is the entire step — both the release script and `.gitignore` exclude the directory wholesale, so there are no lists to keep in step any more.

Before the first push, run a final scan inside `github_push/`: `git grep -iE "password|secret|token|api[_-]?key"` on the staged tree.
