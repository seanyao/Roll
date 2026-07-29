# Roll — Overview

Roll is a Supervisor-led delivery harness. Write a goal, let Roll turn it into Stories, and route each Story through scoped `supervise`, `execute`, and `evaluate` roles.

## Quick Start

```bash
curl -fsSL https://seanyao.github.io/roll/install | bash

cd my-project
roll setup && roll init

roll next           # continue with design/apply/repair/migrate/loop/status
roll loop go        # AI works the BACKLOG in this session, cycle after cycle
roll loop status    # check run state and recent cycles
roll loop watch     # optional: CLI-first live view of the current cycle
```

## How It Works

Roll runs as a V4 Supervisor execution system:

- **Supervisor** — project-level observe/advise role. It reads backlog, merge truth, open PRs, scoped role bindings, repeated failures, release readiness, and owner questions. It coordinates across Stories; it never implements a Story or overrides evidence gates.
- **Delta Unit** — one Story delivered through `design` when needed, then `execute`, and, when configured, `evaluate`.
- **Roles and bindings** — `supervise`, `design`, `execute`, and `evaluate` are stable roles. The concrete agent and optional model are resolved from `Scope -> Role -> Binding -> Agent -> Model`. If a requested binding is unavailable, Roll records that and fails loud instead of pretending another agent was used.
- **Loop** — while a session drives it, picks the top story from BACKLOG and executes it in an isolated worktree, then moves to the next. CI must pass before anything lands on `main`. Nothing advances between sessions.
- **Dream** — `roll dream run-once` scans the codebase for dead code, doc gaps, and architectural drift, queueing `REFACTOR-NNN` entries for the loop to pick up.
- **Skills** — remain the capability layer. Roles invoke `$roll-design`, `$roll-build`, `$roll-fix`, `$roll-peer`, `$roll-.qa`, and other skills.

You set goals, review PRs, and run releases. Everything in between is Roll.

## How Delivery Is Driven

One way: you open an agent session and run `roll loop go`. That session is the
Supervisor, and it keeps taking the next eligible card — within the same backlog,
route profile, evidence, Evaluator, and release gates — until the scope is done, the
budget runs out, or the session ends. **Nothing advances while no session is driving.**

Scope it as tightly as you like: `roll loop go --epic <name>`, `--cards <id,...>`,
`--max-cycles N`, `--for <duration>`. Ask `roll supervisor status/next/why` first if
you want the reasoning before committing to a scope.

`roll loop pause` stops autonomous card selection; `roll loop resume` releases it. A
tripped correction breaker pauses too. An explicitly-scoped one-shot
(`roll loop go --cards <id>`) still runs while paused — that is your decision on the
spot, not autonomous progress.

### Onboarding Samples

**New project from zero**

```bash
mkdir my-product && cd my-product
roll init
roll next
roll design --from-file .roll/brief.md
roll loop go
```

Start with a short requirement, PRD, or notes. Roll explains the next design step instead of silently creating fake work; Designer creates the backlog, Supervisor picks `standard`, `verified`, or `designed` execution per Story, and the owner reviews story-scoped attest evidence.

**Existing project**

```bash
cd existing-codebase
roll init
roll next
roll init --apply
roll loop go
```

Roll diagnoses current code without destructive migration, creates or updates Roll metadata after review, and then reasons over the existing backlog/docs/context. Inspect state through CLI-first observability: `roll status`, `roll loop watch`, `roll loop runs`, `roll loop cycle <id>`, alerts, and story reports.

**Scoped role routing**

```yaml
schema: roll-agents/v1
defaults:
  story:
    roles:
      execute:
        candidates: [kimi, codex]
      evaluate:
        candidates: [pi, reasonix]
```

Runtime availability is explicit. Unavailable agents are recorded as unavailable; role resolution is fail-loud, not silent substitution.

## Features

### Session-Driven Execution

- `roll loop go` — AI picks stories from BACKLOG and executes them in an isolated worktree, cycle after cycle, for as long as this session drives it `[core]`
- `roll loop status` — run state, recent cycles, queue, alerts, and cost `[core]`
- `roll loop watch` — default read-only live status; use `--events` for compact events and `--raw-events` only for audit/debug `[highlight]`
- `roll loop pause / resume` — hand-code yourself; let AI resume when you're done

### Quality Gates

- Peer Review — a second AI agent challenges the plan or diff before any risky build `[core]` `[highlight]`
- Self-Review — post-commit self-check on each micro-commit
- Acceptance Check — ACs verified against story definition after every build
- CI Gate — loop waits for green CI; red CI halts the loop and writes an alert `[core]`
- TCR Discipline — no commit without passing tests; zero-diff commits revert automatically `[core]`

### Dream Code Health Scan

- Code Health Scan — `roll dream run-once` detects dead code, architectural drift, over-engineering candidates `[highlight]`
- Doc Coverage — flags missing guides, stale docs, undocumented ENV vars
- REFACTOR Queue — writes REFACTOR-NNN entries to BACKLOG for loop to pick up

### Story Lifecycle

- `$roll-idea` — one-liner capture: instant FIX or IDEA backlog entry `[core]`
- `roll design` / `$roll-design` — DDD-backed planning: clarify → design → split into INVEST stories. `roll design` launches the skill in your AI agent from the command line and renders detailed designs as a self-contained Design Review Page. `[core]`
- `$roll-build` — Builder role execution: TCR story execution → worktree → PR → evidence `[core]`
- `$roll-fix` — fast-path bug fix, same CI gate, lighter ceremony
- Evaluator role — independent review, visual evidence checks, score/attest contracts where the execution profile requires it

### Observability

- `roll status` — verdict-first truth summary (LOOP · CYCLE · RELEASE · STORY with attest coverage), then convention/AI-client sync health `[core]`
- `roll loop watch` — CLI-first live activity stream for the current cycle
- `roll loop cycle <id>` — one cycle's trace and evidence pointers
- `roll loop runs` — per-cycle TerminalOutcome history with TCR count and duration
- `roll loop alert` — view, acknowledge, and clear loop alerts
- Acceptance Review Page — the Story's own `latest/<id>-review.html` is the human acceptance entry `[highlight]`

### Current Observability

The current product is CLI-first. `roll status`, `roll loop watch`, `roll loop runs`, `roll loop cycle <id>`, `roll status pulse`, alerts, and story-scoped attest reports are the active truth surfaces. the archive rebuild is an on-demand static archive/repair renderer, useful for CI artifacts and migration reconciliation; it is not the current truth surface.

The three-state delivery ladder still matters: **claimed -> merged -> attested**. A backlog row that says done is only `claimed`; it becomes `merged` when the PR lands on `main`, and `attested` when story-scoped evidence is on file. Use `roll supervisor live` for a one-frame CLI-first multi-role board, or `roll supervisor live --watch` to keep that board refreshing in-place; browser/TUI Supervisor Live Console remains future work.

### On-Demand Skills

- `$roll-debug` — mount a diagnostic probe, trace root cause, auto-fix if source-traceable
- `$roll-doc-audit` — check docs/site/help against implementation; index gaps and draft missing docs
- `$roll-doctor` — diagnose the dev toolchain: node, npm, git, AI tools
- `$roll-notes` — capture a development moment in narrative form

### Multi-Agent

- Fail-loud Routing — requested agent/model/rig unavailable → record the limit and pause or route only through an explicit fallback policy `[highlight]`
- `$roll-peer` — multi-round negotiation; the structured adapter records one-shot reviewer facts `[core]`
- PR Inbox — external PRs get AI review before merge; stale PRs auto-rebase `[new]`
- `roll review-pr` — on-demand AI review for any PR, any agent `[new]`

## Project Structure

Roll 2.0 keeps the project root clean. All Roll-managed artifacts live under
`.roll/`:

```
my-project/
├── AGENTS.md            # engineering constraints (root-level — agents read this first)
├── README.md            # product front door
├── src/  tests/         # your code
└── .roll/               # everything Roll touches
    ├── backlog.md       # Story / Fix / Refactor index
    ├── features/        # per-Story AC + plan docs
    ├── domain/          # DDD models, context map
    ├── briefs/  dream/  # autonomous-layer output
    └── decisions/       # ADRs
```

Upgrading a pre-2.0 project? See [migration-2.0.md](migration-2.0.md) —
`npx @seanyao/roll@2 migrate` moves `BACKLOG.md`, `docs/features/`, and
`docs/domain/` into the new layout in one pass.

## Choosing an Adoption Mode

Roll supports three adoption patterns. Pick the one that fits your starting
point — see [patterns/](patterns/README.md) for the decision tree:

- **Seed** — empty directory + a product vision. Roll is native from day one.
- **Graft** — existing project, zero-invasion. `$roll-onboard` reverse-engineers
  `.roll/` from what's already there. See [legacy-onboarding.md](legacy-onboarding.md).
- **Replant** — heavy legacy debt. Reverse-engineer the spec, then rebuild on
  the new spec.

## Guide Index

| Topic | Document |
|-------|----------|
| First working project | [getting-started.md](getting-started.md) |
| Scheduling, subcommands, tmux visibility | [loop.md](loop.md) |
| Governed tool registry and policy | [tools.md](tools.md) |
| Code health scan and REFACTOR generation | [dream.md](dream.md) |
| Cross-agent review protocol | [peer.md](peer.md) |
| Complete skill catalog | [skills.md](skills.md) |
| Adoption patterns (seed / graft / replant) | [patterns/](patterns/README.md) |
| Onboarding an existing codebase | [legacy-onboarding.md](legacy-onboarding.md) |
| Upgrading from pre-2.0 layout | [migration-2.0.md](migration-2.0.md) |
| Common scenarios and troubleshooting | [faq.md](faq.md) |
| Environment variable configuration | [configuration.md](configuration.md) |
