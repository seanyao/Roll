# Existing Codebase Onboarding

> Adopt Roll on an existing codebase without breaking your team's current workflow.

This page keeps the `legacy-onboarding.md` path for link stability. The visible
workflow name is **Existing Codebase Onboarding**.

If you have a real project that's been alive for a while — code, tests, history, conventions, the works — and you want to start using Roll on it, this is your path.

## Three modes of adoption

| Mode | Use when | Trade-off |
|------|----------|-----------|
| **Seed** | You're starting a brand-new project | Lowest friction; specs/backlog from day 1 |
| **Graft** (this page) | You have a live existing codebase that keeps evolving | Zero intrusion on existing code; Roll layered on top |
| **Replant** | You want a clean rewrite, debt cleared | Higher effort; you reverse-engineer specs first |

This page covers **graft**. For seed vs. replant, see [adoption patterns](https://github.com/seanyao/roll-meta) (maintainer-only repo, public summary in the README).

## Already have a repository-local `.roll/`?

That is a historical Roll migration, not a graft. Do not run onboarding over
the existing metadata. First stop any active loop/cycle, make sure product work
is committed and pushed, then run:

```bash
roll workspace migrate --from . --check
```

For a complete portable plan document that you can review and save:

```bash
roll workspace migrate --from . --workspace ws-team --check --json > workspace-migration-plan.json
```

The `>` redirection is your explicit shell write; `migrate --check` itself does
not create a plan, cache, registry entry, Workspace destination, or source
change. It reads Git with optional locks disabled, may use `ls-remote` for
authoritative remote truth, and never fetches, prunes, or updates tracking refs.

Interpret the result before any apply step:

| Result | Meaning |
|--------|---------|
| `ready` (exit `0`) | The facts produce a closed migration plan. |
| `repository_cutover_required` (exit `0`) | `.roll` is tracked by the product repository; save this plan, then remove exactly those paths from the product index through the normal reviewed TCR/PR/push flow. |
| `manual_metadata_handoff` (exit `0`) | `.roll` is an independent Git repository; Roll reports its status/HEAD/branch/upstream/remote but will not link, commit, or push it. |
| `migration_blocked` (exit `2`) | Dirty/unpushed/in-flight Git, unsafe worktrees/submodules, active runtime, symlinks, unverifiable remote truth, or cache/registry conflicts must be resolved first. |

Omit `--workspace` to get the deterministic `ws-<repo hash>` proposal, or pass
`--workspace <id>` to freeze an explicit target ID in the plan.

After reviewing the saved plan, apply that exact document:

```bash
roll workspace migrate --from . --workspace ws-team --plan workspace-migration-plan.json
```

Apply re-collects facts before any write. For ordinary or independent metadata,
the current facts must reproduce the saved plan byte-for-byte. For a
product-tracked plan, the original source HEAD must remain an ancestor and the
remote-reachable history must contain exactly one dedicated commit whose parent
diff removes only the planned `.roll` paths; their working-tree bytes must still
match the saved digests. Roll never creates or pushes that cutover commit.

The transaction writes its durable journal and staging manifest first, then
creates or reuses only `~/.roll/repos/<repoId>.git`, maps and verifies content,
and registers/activates the Workspace last. There is no persistent product
checkout in the Workspace; future code appears only in Issue worktrees.

If apply stops, rerun the same command. It resumes from the journal without
duplicating mappings, events, or cache entries. Before registration only, you
may instead restore moved source files and remove staging:

```bash
roll workspace migrate --from . --workspace ws-team --plan workspace-migration-plan.json --rollback
```

Ordinary and product-tracked sources finish with `.roll/RELOCATED.json` and no
repository-local Roll operation. Old runtime, locks, heartbeats, caches, and
generated projections are imported only as inactive/archive material. If
`.roll` is an independent roll-meta Git repository, Roll copies the mapped
surface, leaves that repository byte-for-byte untouched, and prints the manual
link/commit/push handoff.

## What graft does

- **Reads** your project to understand type, domains, and key modules
- **Asks** you a short set of scoping questions in ≤ 3 minutes
- **Generates** a `.roll/` directory alongside your existing code (no source files touched)
- **Syncs** Roll conventions to whichever AI tools you use
- Leaves you with a project that has BOTH its original workflow AND Roll's project-management capabilities

Roll never runs behind your back: after the graft, work happens only in agent sessions you open.

The graft is **fully reversible**: run `roll setup offboard` and Roll undoes exactly what it added (see [How to exit](#how-to-exit) below).

## Step by step

### 1. Install Roll

```bash
curl -fsSL https://seanyao.github.io/roll/install | bash
```

Or via npm:

```bash
npm install -g @seanyao/roll@latest
```

Then:

```bash
roll setup
```

### 2. Run `roll init` in your project

```bash
cd your-project
roll init
```

Roll detects this as an existing codebase without Roll (source/manifests exist, but no current Roll markers). It will print something like:

```
Detected: existing codebase without Roll
Recommended path: agentic-onboard
Facts:
  - manifests: package.json
  - source dirs: src
  - test dirs: tests
  - source files: 47
  - Roll markers: none
  - facts hash: sha256:...
Next: $roll-onboard
Agent status: available: claude, codex
Run `$roll-onboard` with an available agent, review the artifacts, then run `roll init --apply`.
No files changed.
```

### 3. Run `$roll-onboard` in your AI agent

Open the agent of your choice (Claude Code, Codex CLI, Cursor, etc.) and run:

```
$roll-onboard
```

The skill will:
1. Walk your repository and tell you what it sees
2. Confirm the inferred project type, domains, key modules
3. Ask which `.roll/` artifacts to generate and which existing docs to include
4. Ask whether to add `.roll/` to `.gitignore`, and which AI tools to sync Roll conventions to
5. Write exactly two structured artifacts: `.roll/init-diagnosis.yaml` and `.roll/onboard-plan.yaml`

Total time: under 3 minutes.

### 4. Apply the plan

Back in your terminal, review `.roll/init-diagnosis.yaml` and `.roll/onboard-plan.yaml`, then run:

```bash
roll init --apply
```

This validates the paired diagnosis/plan artifacts before writing anything. It rejects unsupported schema versions, stale facts hashes, non-idempotent file operations, path traversal, and shell-command keys.

After validation, Roll prints an apply review checkpoint. The table lists every
planned operation with action, target path, merge/create mode, and whether owner
content is preserved. In an interactive terminal, Roll waits for confirmation
before writing any reviewed mutation.

For non-interactive automation, use the explicit review acknowledgement after you have reviewed the artifacts:

```bash
roll init --apply --auto
```

After validation passes, Roll:
- Creates `.roll/` subdirectories per your scope choices
- Generates a starter `.roll/backlog.md` if you said yes
- Includes (not regenerates) the existing docs you flagged
- Adds `.roll/` to `.gitignore` if you asked for that
- Syncs Roll conventions to the AI tools you picked

Done. Run `roll next` to continue with the next action.

### 5. Run your first cycle

Delivery advances because you start it. Open an agent session in the project and run:

```bash
roll loop go --max-cycles 1
```

That agent session is the Supervisor: it picks a `📋 Todo` item from the backlog, runs `$roll-build` / `$roll-fix` on it, and can delegate to a Delta Team. Drop `--max-cycles 1` to keep going through the backlog, or scope the run with `--epic <name>`, `--cards <id,...>`, or `--for <duration>`.

The run keeps going after you close your window (it is a detached tmux worker); what ends it is the scope finishing, `--max-cycles` / `--for`, the dead-loop breaker, or `roll loop pause`. Between runs nothing happens, and no run starts that you did not start. Use `roll loop pause` to hold the project against further cycles and `roll loop resume` to release it.

## The graft boundary

Roll only touches **its own** files inside your project:

| Touched by Roll | Not touched by Roll |
|-----------------|---------------------|
| `.roll/` (all contents) | `src/`, `lib/`, `tests/`, etc. — your code |
| `AGENTS.md` (created if missing; section-merged if exists) | `README.md` |
| `.gitignore` (only if you asked for it during onboarding) | `package.json`, `pyproject.toml`, etc. |

If you've already got a `CONTRIBUTING.md` or a `.github/` workflow, Roll won't reach into them. If you want Roll's workflow integrated with yours, that's a manual step you do later.

`$roll-onboard` itself has a stricter boundary than `roll init --apply`: the agent may only write `.roll/init-diagnosis.yaml` and `.roll/onboard-plan.yaml`. The apply command owns `AGENTS.md`, `.gitignore`, backlog, features, docs, and offboard changesets.

## How to exit

`roll init --apply` records every Roll-owned file, directory, merged marker block, and `.gitignore` line it adds into `.roll/onboard-changeset.yaml`. Re-running the same plan keeps that metadata and deduplicates entries instead of losing the original offboard record. If apply fails midway, inspect the changeset and run `roll setup offboard --confirm` after review to reverse Roll-owned artifacts.

Existing `AGENTS.md` files are preserved. Roll appends its managed sections between stable `<!-- roll:onboard:start -->` / `<!-- roll:onboard:end -->` markers so offboard can strip only those sections later.

**Preview what will be undone (default):**

```bash
cd your-project
roll setup offboard
```

This is a dry-run — no files are removed. The output lists every artefact the changeset recorded and the `.gitignore` lines that will be reverted.

**Apply the rollback:**

```bash
roll setup offboard --confirm
```

Files and directories that Roll did not create are left untouched. Marker-wrapped Roll sections are removed from existing owner files without deleting the file. Lines you added to `.gitignore` yourself are preserved. The changeset file itself is removed at the end of a successful apply.

Safety:

- If `.roll/onboard-changeset.yaml` is missing (e.g. you ran an earlier Roll version that didn't track it, or the project was never onboarded with `roll init --apply`), `roll setup offboard` refuses and prints the manual `rm` commands instead. It will never guess.
- If the changeset names paths that resolve outside the current project (cross-project contamination), `roll setup offboard` refuses and tells you to run it in the right directory.

**Full uninstall (machine-wide):**

```bash
roll setup offboard --confirm
npm uninstall -g @seanyao/roll
```

Your project is now exactly as it was before adoption.

## FAQ

**Q: What if I don't have an AI agent installed?**
You need at least one. Install Claude Code, Codex CLI, or Cursor — they're free to install (the AI calls cost tokens via your account).

**Q: What if I already have a `BACKLOG.md` from another tool?**
Roll detects this as a pre-2.0 Roll project (not an existing-codebase onboard target) and tells you to run `npx @seanyao/roll@2 migrate`. If the file came from a totally different tool, rename it first (`mv BACKLOG.md old-backlog.md`) then run `roll init`.

**Q: Roll-onboard infers my project type wrong — what do I do?**
Tell the skill in chat. The confirm-understanding questions exist specifically so you can correct misidentification. The skill writes the corrected understanding into the plan; apply trusts the plan.

**Q: Can I edit `.roll/onboard-plan.yaml` manually?**
Yes, but keep it paired with `.roll/init-diagnosis.yaml`. `roll init --apply` requires matching `factsHash` values, recomputes the current facts hash, allows no shell-command keys, and only accepts the two idempotent `file_operations` entries rooted inside the project. Plans older than 24 hours, stale against the current project, or generated by older `$roll-onboard` contracts should be regenerated.

Manual edits still pass through the same review checkpoint; without interactive
confirmation or explicit `--auto`, no files are changed.

**Q: My team uses GitHub Issues / Jira / Linear — does Roll replace them?**
No. Roll's `BACKLOG.md` is the work queue that `roll loop go` draws from in an agent session. Your team's external tracker stays where it is. Some teams use Roll only for new stories an agent can execute and keep human-only work in their existing tracker.
