# Roll — Project Setup

## Initialize a Project

From your project root:

```bash
roll init
```

`roll init` diagnoses the current directory state before any mutation:

1. **Empty directory** — fresh start. Roll writes `AGENTS.md` plus an empty
   `.roll/` scaffold (`backlog.md`, `features/`, `domain/`) ready for scoped
   agent bindings in `.roll/agents.yaml`. No prompts. This is the **seed** adoption pattern — see
   [patterns/seed-pattern.md](patterns/seed-pattern.md).
2. **PRD/docs-only** — Roll finds requirements or product docs but no source or
   manifests. It treats this as a new-project path and points you to design; it
   does not route to existing-codebase onboarding.
3. **Existing codebase without Roll** — Roll detects existing source files but no
   `.roll/` directory. It does **not** silently scaffold; instead it surfaces
   `$roll-onboard`, an interactive skill that scans the codebase, asks a short
   set of cognition / scope / privacy questions, and produces
   `.roll/init-diagnosis.yaml` and `.roll/onboard-plan.yaml` for review. After
   reviewing the paired artifacts, run `roll init --apply`. It prints a checkpoint listing each planned file
   operation, including action, target path, merge/create mode, and owner-content
   handling, then waits for confirmation in an interactive terminal. In
   non-interactive automation, use `roll init --apply --auto` after that review.
   This is the **graft** pattern — see
   [legacy-onboarding.md](legacy-onboarding.md) and
   [patterns/graft-pattern.md](patterns/graft-pattern.md).
4. **Already initialized** — `.roll/`, `AGENTS.md`, backlog, and features are
   present. Roll prints `Already initialized` and `Next: roll status`.
5. **Partial Roll** — some Roll markers are present but the setup is incomplete.
   Roll prints the missing pieces and any stale pre-v2 markers. `roll init --repair`
   previews the repair and asks in an interactive terminal; non-interactive
   automation must use `roll init --repair --auto`. Repair only creates missing
   Roll-owned files or merges Roll-owned sections, and records the changes in
   `.roll/onboard-changeset.yaml` so `roll setup offboard` can reverse them later.

After any of these paths, `roll next` is the continuation command. It reads the
same Roll markers plus `.roll/brief.md`, `.roll/onboard-plan.yaml`, and
`.roll/backlog.md`, then prints one next action: design from the brief, review
and apply an onboard plan, repair partial markers, run the old-layout migration,
start the loop on the next Todo card, or inspect status when nothing is
actionable.

When a path writes Roll-owned meta files inside a git worktree, `roll init`
finishes by adding, committing, and pushing those files to `origin` when
possible. The finalize step is scoped to Roll-owned paths such as `AGENTS.md`,
`.claude/CLAUDE.md`, `.roll/**`, and Roll-managed `.gitignore` entries; product
source, PRDs, and other user files are left alone. If commit or push cannot be
completed, init prints the manual command to run.

Upgrading from a pre-2.0 layout (`BACKLOG.md` at root or `docs/features/`)?
Run `npx @seanyao/roll@2 migrate` first — see
[migration-2.0.md](migration-2.0.md). `roll init` will refuse to scaffold on top
of a half-migrated project.

## Sync After Updating Roll

When roll ships a new version of its conventions or skills, sync them into your project:

```bash
roll sync
```

`sync` only overwrites files that roll manages (skills and global conventions). Your project-specific files (`.roll/backlog.md`, project source, etc.) are never touched.

## Typical First-Use Sequence

```bash
npm install -g @bipo-ape/roll
roll setup                 # configure AI tools globally (one time per machine)
cd my-project
roll init                  # diagnose and route this project
roll next                  # continue with design/apply/repair/migrate/loop/status
roll loop go               # work the backlog in this session
```

`roll setup` syncs conventions for the AI tools installed on the machine.
Agent semantics live in `~/.roll/agents.yaml` (Machine Scope) and
`.roll/agents.yaml` (Project Scope). Run `roll agent migrate --dry-run` to
convert older `primary_agent`, local-agent, pairing, or v3 route-slot data into
the scoped model.

## What Gets Created

| File | Purpose |
|------|---------|
| `AGENTS.md` | Agent conventions: domain model, scope, coding standards (root-level — entry point for every AI client) |
| `.roll/backlog.md` | Story tracking (Epic / Feature / Story / Fix / Refactor) |
| `.roll/features/` | Per-feature deep docs (one file per Feature) |
| `.roll/domain/` | DDD models, context map, architecture records |

## Re-initializing

`roll init` is safe to repeat. Complete projects get `Next: roll status`;
partial projects get `roll init --repair` instead of another scaffold pass.

## See Also

- [installation.md](installation.md) — install and update roll
- [conventions.md](conventions.md) — AGENTS.md structure and conventions
- [patterns/](patterns/README.md) — three adoption patterns (seed / graft / replant)
- [legacy-onboarding.md](legacy-onboarding.md) — graft Roll into an existing codebase
- [migration-2.0.md](migration-2.0.md) — upgrade a pre-2.0 project to `.roll/` layout
- [loop.md](loop.md) — enable autonomous execution

## Git Hooks Auto-Setup (US-INFRA-008/009)

Roll's TCR pre-commit gate lives in `hooks/pre-commit`. Git ignores this directory
by default — `core.hooksPath` must point to it. Roll configures this automatically
in three places so you never hit a "TCR gate bypassed" window:

1. **`roll setup`** — configures `core.hooksPath=hooks` in the current repo.
2. **Autonomous loop cycle preflight** — each cycle ensures the worktree it runs in
   has the correct hooks path.
3. **Claude Code SessionStart hook** (`.claude/settings.json`) — runs
   `git config core.hooksPath hooks` every time a new Claude Code session opens in
   this project.

**Manual override:** If you've intentionally set `core.hooksPath` to something else,
Roll will not overwrite it. The auto-setup only fires when the value is unset or
equals the git default `.git/hooks`.

**Troubleshooting:** If commits are going through without running tests:

```bash
git config core.hooksPath   # should print: hooks
ls hooks/pre-commit          # should exist and be executable
roll setup                   # re-runs the configuration step
```
