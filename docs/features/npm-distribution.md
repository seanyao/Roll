# Feature: npm-distribution

> Design doc: [npm-distribution-plan.md](npm-distribution-plan.md)

<a id="us-dist-001"></a>
## US-DIST-001 Rename REPO_ROOT → ROLL_PKG_DIR in bin/roll ✅

**Created**: 2026-04-19
**Completed**: 2026-04-19

- As a roll maintainer
- I want the package source directory variable to be named `ROLL_PKG_DIR` instead of `REPO_ROOT`
- So that the dev/runtime separation is explicit and the mental model works for both git clone and npm install

**AC:**
- [x] `REPO_ROOT` renamed to `ROLL_PKG_DIR` throughout `bin/roll` (replace_all)
- [x] `REPO_CONVENTIONS` renamed to `ROLL_PKG_CONVENTIONS`
- [x] `repo_skills_real` renamed to `pkg_skills_real` (local var, same scope)
- [x] All error messages updated to reference `ROLL_PKG_DIR` instead of "repo"
- [x] `roll setup`, `roll sync`, `roll status` all behave identically after rename
- [x] Tests pass: 72/72

**Files:**
- `bin/roll` (rename REPO_ROOT × ~12 occurrences, REPO_CONVENTIONS × ~6 occurrences)

**Dependencies:**
- None — pure rename, no behavior change

---

<a id="us-dist-002"></a>
## US-DIST-002 Add `roll update` command ✅

**Created**: 2026-04-19
**Completed**: 2026-04-19

- As a user who installed roll via npm
- I want to run `roll update` to get the latest version
- So that updating is as simple as installing

**AC:**
- [x] `roll update` detects install mode: git clone (`.git` dir present in `ROLL_PKG_DIR`) vs npm package
- [x] Git clone mode: runs `git -C "$ROLL_PKG_DIR" pull`, then `roll sync`
- [x] npm mode: runs `npm update -g roll`, then `roll sync`
- [x] Prints current version before update
- [x] `roll --help` lists `update` command

**Files:**
- `bin/roll` — add `cmd_update()` + wire to command router

**Dependencies:**
- US-DIST-001 (uses `ROLL_PKG_DIR`)

---

<a id="us-dist-003"></a>
## US-DIST-003 Background version check + update nudge ✅

**Created**: 2026-04-19
**Completed**: 2026-04-19

- As a user
- I want to be notified when a newer version of roll is available
- So that I don't miss updates without having to manually check

**AC:**
- [x] After any `roll` command completes, a background curl checks GitHub releases API (async, non-blocking)
- [x] Result cached to `~/.roll/.update-check` with timestamp; re-checked at most once per 24h
- [x] If newer version found, a single-line nudge is printed at end of next command
- [x] No nudge if already on latest, or if check failed (silent failure)
- [x] Cache format: `<epoch> <latest_version>` (e.g. `1745000000 0.6.0`)

**Files:**
- `bin/roll` — add `_check_update_async()`, `_notify_update()`, wire into main command flow

**Dependencies:**
- US-DIST-002 (`roll update` must exist before nudging users to run it)

---

<a id="us-dist-004"></a>
## US-DIST-004 npm publish infrastructure ✅

**Created**: 2026-04-19
**Completed**: 2026-04-19

- As a maintainer
- I want `npm publish` to work correctly and be automated on git tag
- So that users can install and update roll via `npm install -g roll`

**AC:**
- [x] `.npmignore` created — excludes: `tests/`, `hooks/`, `docs/`, `.github/`, `.git*`, `*.bats`, `uninstall.sh`
- [x] `package.json` `files` field verified correct (50 files, no test/docs pollution)
- [x] GitHub Actions `publish.yml` created: triggers on `push` to tags matching `v*`, runs `npm publish --access public`
- [x] README primary install updated to `npm install -g roll` with `roll update` for updates
- [x] `install.sh` noted as contributor-only

**Files:**
- `.npmignore` (new)
- `.github/workflows/publish.yml` (new)
- `README.md`
- `install.sh` (add comment clarifying contributor-only use)

**Dependencies:**
- US-DIST-001, US-DIST-002, US-DIST-003 (all should be in before first publish)
