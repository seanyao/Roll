# Roll — Getting Started

This path gets one Roll-managed project from install to acceptance evidence in
about five minutes. Run it in a git repository.

## 1. Install

```bash
curl -fsSL https://seanyao.github.io/roll/install | bash
# or
npm install -g @bipo-ape/roll
```

Roll needs Node.js 22 or newer and at least one supported local AI agent.

## 2. Initialize The Project

```bash
cd your-project
roll setup
roll init
```

`roll init` diagnoses the directory before it writes anything. Empty projects use
the fresh scaffold path; existing codebases route to `$roll-onboard`; PRD/docs-only
projects point to design as a new-project path; partial or old Roll layouts print
repair/migration guidance without changing files.

## 3. Go from Requirements to a Backlog

If you have requirement docs (a PRD, sketches, notes) but no source yet, `roll
init` classifies that as a PRD-only new project and points you toward design.
`roll status` and `roll doctor` still show the design nudge after a Roll scaffold
exists with an empty backlog.

To start an interactive design session right away:

```bash
roll design --from-file docs/PRD.md
```

Use the exact `roll design --from-file ...` command printed by `roll init` when
it detects a PRD. Without a file, `roll design` still launches the same
`roll-design` skill in your AI agent. You talk through the domain model, the
agent writes INVEST stories into `.roll/backlog.md`, and detailed design notes
get a self-contained `design-review.html` Design Review Page — then you run
`roll loop go` to build those stories.

You can also run `$roll-design` directly inside your agent if you prefer.

If you already have a story in mind and just want to add it fast, skip to step 4.

## 4. Add One Backlog Item

Add a small story card with one sentence:

```bash
roll idea "Add a health check endpoint"
```

`roll idea` auto-classifies, assigns an id, infers the epic, and creates the
card folder — you get both the backlog row and the story folder in one step.

Then edit `.roll/features/<epic>/<ID>/spec.md` so the ACs describe what
"done" means.

Keep the first story tiny: one visible behavior, one clear test path.

## 5. Run The Loop

Delivery advances because you start it — nothing starts a run for you. Open an agent
session in the project and run:

```bash
roll loop go
```

That agent session is the Supervisor: it picks the next `📋 Todo` card, runs the
build/fix cycle, and can delegate to a Delta Team. The run outlives your window
(it is a detached tmux worker) and ends on its own scope — cards finishing,
`--max-cycles` / `--for`, the dead-loop breaker, or `roll loop pause`. Nothing in
Roll starts on its own — if you do not open an agent session
and run `roll loop go`, nothing happens.

To try exactly one cycle first:

```bash
roll loop go --max-cycles 1
```

Scope the run when you want a specific slice: `--epic <name>` for one epic,
`--cards <id,...>` for named cards, `--for <duration>` to cap wall-clock time.

Check state at any point:

```bash
roll loop status
```

`roll loop status` is the normal snapshot view. If a cycle is running and you
want the live view, use the read-only watch command:

```bash
roll loop watch
```

Use `roll loop watch --events` for compact event debugging and
`roll loop watch --raw-events` only when you need raw audit JSON. All watch
modes are read-only; Ctrl-C stops only the view.

To hold the project against further cycles, and to release it again:

```bash
roll loop pause
roll loop resume
```

While paused, a guided single-card run — `roll loop go --cards US-DEMO-001` —
still goes through.

## 6. Render Acceptance Evidence

After the story lands and the backlog row is `✅ Done`, render the offline
acceptance report:

```bash
roll attest US-DEMO-001
```

The report is written into that story folder under `.roll/features/`. Each AC
should have a verdict and evidence link before a release.
