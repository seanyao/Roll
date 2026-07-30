# roll loop — Session-Driven BACKLOG Executor

> **Nothing runs on a timer.** Delivery only happens because someone ran
> `roll loop go`; Roll installs no scheduler and starts nothing on its own.
>
> A run you start does outlive the terminal: by default `go` puts the worker in a
> detached tmux window, so closing your window (or Ctrl-C while following the feed)
> stops you *watching*, not the run. What ends a run is its own scope — the cards
> finishing, `--max-cycles` / `--for` being reached, the dead-loop breaker tripping,
> `roll loop pause`, or killing the tmux session. Use `--no-tmux` to keep it in the
> foreground of the terminal you started it in.
>
> So: no work between runs, and no run you did not start.

`roll loop` executes BACKLOG stories: it picks the top pending story and delivers
it — committing changes in TCR micro-steps — for as long as the session driving it
keeps going.

You drive it: `roll loop go` in an agent session runs cycles until the scoped
backlog is done, paused, or capped. `roll loop pause` stops cards from being
picked and `roll loop resume` clears it; the owner asks `roll supervisor
next/why` to decide what to drive.

## How It Works

1. Reads `BACKLOG.md`, picks the highest-priority `📋 Todo` item.
2. Marks it `🔨 In Progress` and commits.
3. Invokes `$roll-build <story-id>` or `$roll-fix <bug-id>`.
4. On success: marks `✅ Done`, commits, appends to `runs.jsonl`.
5. On failure: reverts to `📋 Todo`, writes an `ALERT.md` entry.

Loop runs inside a **tmux session** named `roll-loop-<project-slug>`.
When not muted, a terminal window pops up automatically so you can watch in real time.

## North Star Readings

`roll status` starts with a one-line North Star summary so the owner can see the
system trend before reading the rest of the health panel. The row is the compact
form of `roll north`: autonomy, delivery rate, fix tax, and attribution errors.
Each value is followed by a status dot; run `roll north` when you need the
target, trend, and reason text.

`roll north [--json]` reads the last 14 days of runs, events, backlog, card
metadata, and delivery truth. The four targets are:

| Metric | Target | Anti-gaming rule | `null` means |
|--------|--------|------------------|--------------|
| Autonomy | >=72h autonomous runtime | `current` is the sum of eligible daily hours across the declared 14-day window, not the latest uninterrupted segment. An effective autonomous day needs at least 6 non-idle attempts; backlog-empty days pause the clock and do not count as missed time. | There is not enough qualifying run history yet, or the backlog was empty for the window. |
| Delivery rate | >=60% | Delivery is counted from merge truth, not self-reported cycle exits. | No eligible delivery denominator exists yet. |
| Fix tax | <1x | The denominator is US cards only; FIX work is not allowed to improve its own ratio. | There is no US-card denominator in the window. |
| Attribution errors | =0 | `unknown` is not guessed into env, harness, or card; missing envelopes stay visible. | No attribution sample exists yet. |

Machine consumers should use `roll north --json`, which emits
`roll.north.v1` with the same current values, targets, reasons, and daily
series used by the terminal panel.

## Failure Attribution and Pauses

Every failed cycle is assigned one of four classes:

| Class | Meaning | Owner action |
|-------|---------|--------------|
| `env` | Machine, checkout, auth, network, sandbox, or worktree condition. | Repair the named environment problem, then resume dispatch. |
| `harness` | A Roll component failed, such as score parsing, attest render, publish, or rescue. | Inspect the component and open a focused FIX when needed. |
| `card` | The Builder reached the story and failed during actual card work. | Investigate the story, split it, or change routing after reading evidence. |
| `unknown` | There is not enough envelope evidence to charge a card honestly. | Add a deterministic failure envelope before blaming the card. |

Root-cause counting is by `root_cause_key`, not by card. Repeated `env`,
`harness`, or `unknown` causes pause dispatch and write a diagnostic snapshot
under `.roll/loop/diagnostics/`. When the terminal says dispatch is paused,
open that snapshot first: it includes the class, root cause, recent events, and
playbook. Fix the named machine or Roll component, then run `roll loop resume`.

If earlier env/harness failures pushed a card into the skip list, rebuild that
state from the durable evidence:

```bash
roll loop pardon-skip-list --dry-run
roll loop pardon-skip-list
roll loop pardon-skip-list --include-unknown  # also pardons unknown/no-evidence rows
```

Use `--include-unknown` only after reading the rows; older zero-usage `gave_up`
entries may be real card failures.

## Builder Isolation and Rescue

During Builder execution the main checkout is physically write-protected. The
Builder works in its cycle worktree; the shared checkout is treated as a sensor,
not a scratchpad. Roll releases the write protection when the cycle exits.

If dirty or ahead changes appear in the main checkout anyway, Roll quarantines
them before continuing:

- dirty files become a `rescue/leaked-*` ref that can be restored with the
  manifest's `git stash apply <ref>` command;
- ahead commits that appear WHILE a cycle is running are bookmarked on a
  `rescue/leaked-*` branch and reported — but the shared `main` ref is NEVER
  moved. Recovery (`git reset --hard origin/main`) is an explicit human
  decision, never something the loop does for you. Pre-existing local ahead
  commits (owner WIP, a concurrent dispatch) are left byte-identically alone:
  the cycle worktree branches off `origin/main`, so they cannot leak into the
  cycle;
- the manifest is written under `.roll/loop/quarantine/` and records the cycle,
  story, phase, files, ref, and exact restore command.

Claim rescued dirty work from the manifest. Bookmarked ahead commits stay on
`main` (and on their `rescue/leaked-*` ref) — inspect them and reset main
yourself only if you want them gone.

## How work is driven

Nothing runs on a timer. A `roll loop go` chain exists because you started it, and
the session that started it is the Supervisor. Closing your window does not stop the
run — see the note at the top of this guide for what does. The contract is: no work
between runs, and no run you did not start.

```bash
roll loop go                      # drive the whole Todo backlog
roll loop go --epic <name>        # scope to one epic
roll loop go --cards US-X-1       # one explicit card (runs even while paused)
roll loop go --max-cycles 1       # a single cycle, to try the flow
```

`roll loop pause` stops cards from being picked; `roll loop resume` clears it. The
correction circuit breaker also pauses automatically after repeated failures, so
`resume` is the supported way back. An explicit `--cards` one-shot still runs while
paused (FIX-1472).

## Subcommands

```bash
roll loop go          # Drive the backlog from this session
roll loop go --epic <name>        # Scope to one epic
roll loop go --cards US-1,FIX-2   # Scope to explicit cards (runs while paused)
roll loop go --max-cycles 1       # A single cycle, to try the flow

roll loop status      # Show run state (ACTIVE / PAUSED), queue, alerts, recent cycles
roll loop watch       # Default owner view: phase, quiet time, TCR count, last signal, plus live activity
roll loop watch -n 50 # Look back 50 lines before following (default 200; 'all' = whole log)
roll loop watch --events      # Compact developer event stream from .roll/loop/events.ndjson
roll loop watch --raw-events  # Raw JSON event stream for audit/debug only
roll loop watch --verbose  # Also show the raw agent transcript (default folds it away)
roll loop watch --attach   # Read-only attach to the loop's tmux observe window (tmux attach -r)
roll loop go          # Work all backlog until done, paused, or a guardrail stops it
roll loop go --epic <name>              # Limit the goal to one epic
roll loop go --cards US-1,FIX-2         # Limit the goal to selected cards
roll loop go --for 5h                   # Stop after the current cycle once the timebox is reached
roll loop go --max-cycles 3             # Stop after this many cycles
roll loop go --review <auto|hetero|self|off>  # Set the final review policy
roll loop go --no-tmux                  # Stay in this terminal instead of a detached tmux window
roll loop go --attach                   # Follow the live feed after starting
roll loop goal        # Show persisted goal status, scope, review mode, usage, limits, and safety gate

roll loop runs        # Show last 10 run summaries (story IDs, TCR count, duration, slowest phase)
roll loop runs 20     # Show last 20 runs
roll loop runs --all  # Show all projects' run history
roll loop runs --detail <cycle_id>  # Phase Breakdown panel for a single cycle

roll loop story <ID>  # Per-story rollup: cycles, span, duration, tokens, cost, PRs
roll loop story <ID> --json  # Machine-readable form for scripting

roll loop eval       # Objective result-eval trend over the last 14 scored cycles
roll loop eval 30    # Widen the window to the last 30 scored cycles
roll loop signals    # Surface repeated low-score patterns as improvement signals
roll loop signals --streak 4  # Require 4 consecutive low cycles before firing

roll loop watch       # Recommended daily live view
tmux attach -t roll-loop-<project-slug>  # Read-only tmux observe window; use when you want the pane
roll loop mute        # Suppress auto-attach popup (loop still runs in tmux)
roll loop unmute      # Re-enable auto-attach popup

roll loop pause       # Pause scheduling (keep plist, skip execution)
roll loop resume      # Resume scheduling after pause

roll loop reset       # Clear loop state (start fresh on next fire)

roll loop gc                  # GC orphan slugs, tmp debris, expired backups (default: keep 30 days)
roll loop gc --dry-run        # Preview what would be removed without deleting
roll loop gc --keep-days 14   # Override retention (also: loop_gc.retention_days in .roll/local.yaml)
                              # See guide/en/loop-data-layout.md for the full gc manual

# loop-related branches: `git ls-remote --heads origin 'loop/*'` (the `branches` subcommand is retired)

roll loop events      # Show last 20 cycle events
roll loop events 50   # Show last 50 events

roll agent                           # Show scopes, effective project capability, and agent pool
roll agent list                      # Show agents installed on this machine
```

When semantic pick ranking is enabled, `roll loop watch --events` includes a
`pick:ranked` line such as `picked US-123 (rank 1/5: unblocks the release lane)`.
`roll supervisor next` and `roll supervisor next --json` show the latest top
three ranking suggestions and reasons. The ranking is advisory only; Hold, Cut,
unsatisfied dependencies, skip-list, open PR, merged-delivery, and pending-publish
gates still decide eligibility.

### One Card, One Lease

By default a card has exactly one delivery lease. Before picking, the picker
consults the delivery leases derived from the event stream: a card already
`in_flight`, `awaiting_merge`, `ci_red`, or `delivered` is skipped with a
`card held: <state> (<cycle>)` reason (event `pick:skipped`, idle reason
`all_leased`). Same-card parallel builds are off — quality redundancy comes
from the adversarial pair inside one cycle, not from duplicate builds that only
one merge can land. A cycle that ended without delivering releases its lease,
so a legal fix-forward retry of the same card stays pickable.

`roll loop run-once --race` is the explicit opt-in for same-card parallel
racing (carried to child cycles as `ROLL_LOOP_RACE=1`). On the FIRST merge,
`roll loop reconcile` atomically supersedes the remaining sibling cycles
(`delivery:reconciled{superseded}`), so racing costs at most one merge plus
discarded sibling work — never duplicate deliveries.

### The go lock

While `roll loop go` runs it holds `.roll/loop/go.lock`, so a second `go` in
another terminal yields instead of starting a competing `roll loop run-once`.
`roll loop go --cards <ids>` uses the same card allow-list for its one-shot
runner, so a manual tick cannot silently pick a different backlog card.

`go` starts its own session and depends on nothing else being installed. For a
paused project, run `roll loop resume` first — the `PAUSE-<slug>` marker is still
respected at cycle boundaries — or name the card explicitly with `--cards`, which
runs even while paused (FIX-1472).

### Goal Mode Safety Gates

Run limits are explicit per `roll loop go`. `--max-cycles` and `--for` apply to
THIS invocation only; omitting one means no limit for this run — Roll never
silently inherits a cap from a prior session's persisted goal, so a flagless
`roll loop go` can neither be capped nor bricked by a limit you set days ago. Scope (`--epic`/`--cards`) and `--review`
persist only while the goal is unfinished. When a goal is `complete`, the next
`roll loop go` archives it under `.roll/loop/goal-archive/`, records
`goal:archived`, and starts a distinct goal from that invocation's flags. With
no scope flag, the new goal covers all eligible backlog cards; it never reuses
the completed goal's scope.

Before each builder cycle, `roll loop go` classifies the **complete**
`git status` set of the main checkout (never a truncated slice) against the
runner's per-cycle **pending-delivery evidence manifests**. Each manifest
records the exact evidence paths and their SHA-256 hashes for a still-open
delivery PR, written atomically under `.roll/loop/evidence-manifests/`.

- **Verified** — a `.roll/**` file whose current content hashes to a value
  recorded in a manifest. These are runner-owned artifacts (the dossier,
  report, and screenshots of an open PR); they emit `bootstrap_artifacts_verified`
  and never pause an unrelated eligible card.
- **Unconfirmed** — any other `.roll/**` file (an unknown path, a hash
  mismatch, a malformed/stale manifest, a symlink escape, or a directory).
- **External** — any non-`.roll/**` (product-file) dirt.

If the only dirt is verified evidence, the preflight proceeds. If unconfirmed
`.roll` pollution is the only remaining dirt, the goal pauses with
`bootstrap_artifacts_unconfirmed`, naming the exact files (verified evidence is
never named) so you can confirm ownership: commit them to the product repo or
`.roll/roll-meta`, ignore them by policy, or clean them and re-run. Product-file
dirt is surfaced (not hidden) and left to the cycle. This preflight does not
start a cycle and does not count as no-progress.

Acceptance is manifest-and-hash only: there is **no** `--ignore-dirty` or
"trust all evidence" bypass. A generic `.roll/**` path or a large status list
can never make the gate permissive; anything the runner did not record and
still hash-match fails closed.

For the Roll repository itself, `roll loop go`, `roll loop resume`, and
`roll loop go` prints the runner binary and version before starting autonomous
work. They fail loud with `runner_stale_for_repo` if the repo-local
`@bipo-ape/roll` package version is newer than the running runner; install or
publish the local build before resuming autonomous work.

`roll loop go` enforces safety only at cycle boundaries. The global backstop is
the **dead-loop breaker**: after a run of consecutive whole-goal no-progress
cycles — none of which delivered a card — the goal is STOPPED with a loud ALERT,
so an unmergeable card can never spin indefinitely and the loop provably halts
within K cycles. `--for <duration>` is a wall-clock box: the in-flight cycle
finishes, then the goal pauses with reason `timebox`. `--max-cycles <n>` stops
after n cycles.

Each safety trip records `goal:gate_tripped`, and `roll loop goal` shows the
last safety gate reading.

### `roll loop goal` Fields

`roll loop goal` is the read face for `.roll/loop/goal.yaml` plus the latest
goal events. The key fields are:

| Field | Meaning |
|-------|---------|
| `Status` | `active`, `paused`, or `complete` (a historical goal's `budget_limited` reads as `paused`). |
| `Scope` | All backlog, one epic, or an explicit card list. |
| `Review` | Completion review policy: `auto`, `hetero`, `self`, or `off`. |
| `Usage` | Goal cycle count, effective cost, and unknown-cost-row count. |
| `Limits` | Explicit `--max-cycles` and `--for` settings. |
| `Safety gate` | The latest timebox or dead-loop-breaker trip and its reading. |
| `Last decision` | Why the goal continued, paused, or completed. |

When `auto` final review degrades to same-provider review, the status view
shows the recorded degradation reason from `goal:review_degraded`. When a goal
cannot complete, `Last decision` carries the unmet truth or review reason.

### Goal Mode Final Review

`roll loop go` persists its goal state in `.roll/loop/goal.yaml` and runs a
final review gate before a goal can become `complete`. The default policy is
`--review auto`: Roll tries heterogeneous reviewers in ranked order, and records
`goal:review_degraded` when it must fall back to self review because every
heterogeneous candidate failed or because only one provider is installed.

Final review uses the same structured adapter as `-peer` skill. The
`goal:final_review` event records reviewer agent, provider, command family,
verdict, findings, timeout/error state, duration, and transcript/evidence
paths when available. A transient review crash rotates to the next ranked
candidate; if every candidate fails Roll records the real error reason on the
`ERROR` verdict and raises an ALERT, instead of collapsing into a reasonless
generic error.

Use `--review hetero` when completion must fail closed unless a heterogeneous
reviewer is installed. Use `--review self` to allow same-provider review. Use
`--review off` only as an explicit operator waiver; Roll skips the gate but
still records a `goal:final_review` event with `verdict: SKIPPED`.

## Autonomous Role Resolution

Loop resolves agents through the scoped Agent model:

```text
Scope -> Role -> Binding -> Agent -> optional Model
```

Machine Scope lives in `~/.roll/agents.yaml`; Project Scope lives in
`.roll/agents.yaml`. A loop cycle resolves `story.execute` for the Builder and
`story.evaluate` for review/score, using inherited machine declarations when the
project says `inherits: machine`.

```yaml
schema: roll-agents/v1
scope: project
inherits: machine
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [kimi, codex, pi]
        require: [execute]
        strategy: first-available
      evaluate:
        kind: select
        from: [claude, codex, kimi, pi, agy, reasonix]
        require: [evaluate]
        strategy: health-aware
```

`roll agent` shows the Machine Scope and the effective Project Scope, including
inherited agents and configured route models. It does not predict the next role
assignment: dispatch resolves runtime health and least-recent state at spawn.
Use `roll supervisor route --role builder|evaluator` for a diagnostic runtime
snapshot. Use `roll agent migrate --dry-run` to preview a one-time conversion
from old agent files; old agent config is not read during normal execution.

Runtime health is not static policy. Quota, auth, network, VPN, account, stall,
or missing binary failures suspend only the runtime rig and are recorded as
runtime facts; Roll does not rewrite `agents.yaml`. Suspended rigs are probed on
the recovery interval and return to the pool automatically when reachable. If no
candidate remains, the cycle records `loop:pending` and only runs recovery probes
instead of starting a Builder, charging the card's failure budget, or silently
rewriting the pool.

For open casting, `health-aware` ranks the same visible pool across Builder,
Designer, Evaluator, and Peer Reviewer roles. `roll supervisor route --role
builder --story <id> [--json]` exposes the trace: candidates, ranked scores,
warnings, skipped runtime facts, selected agent, source binding, recent-use
input, and capability/health ranking.

### Agent toolchain health check (US-V4-022)

Before scheduling, Supervisor also classifies agent toolchain health signals
from the durable event stream. It distinguishes auth blocks, network blocks,
setup/skill-root pollution, and worktree permission failures. Pollution signals
are routed to the delivery team as a FIX rather than misclassified as auth failures.
Use `roll supervisor health` for the dedicated board, or read the summary from
`roll supervisor next` / `roll supervisor why`.

### Agent self-downgrade (too_big verdict)

The picked agent runs a **pre-flight self-check** (in `roll-build` / `roll-fix`
SKILL.md). When it decides the story is over capacity it emits:

```yaml
verdict: too_big
reason: est_min=20 > pi.max=8
```

并触发 self-downgrade 流程：调 `roll-design --from-story <id>` 把故事拆成
chain_depth + 1 的子故事写回 BACKLOG，原故事翻 🚫 Hold，cycle 干净退出。
下一轮 loop 接力第一个更小的子故事。

The chain is capped at **2 auto re-splits**. The third would be refused and a
`StorySplitCapHit` ALERT is written, forcing human triage instead of letting
the chain grow indefinitely.

## Execution profiles (standard / verified / designed)

Role resolution above chooses the concrete Agent and optional Model for the
`execute` and `evaluate` roles. Separately, Roll chooses an **execution profile** per
Story — the cheapest *sufficient* role pipeline for that Story's risk and ROI.
You do not declare it; it is selected once at cycle start from the story's risk
signals and recorded in an `execution:profile` event. These are **not
user-facing "team shapes"** — they are risk/ROI tiers:

- **`standard` = execute only** — low-risk, local scope, clear acceptance, low
  evidence risk (a copy fix, a small parser bug, an internal rename).
- **`verified` = execute → evaluate** — user-visible behavior, screenshot/visual
  evidence required, or a history of weak/missing evidence. An independent
  `evaluate` role (fresh session) judges the delivery; blocking review, score, and
  attest stay three separate dimensions.
- **`designed` = Designer -> Builder -> Evaluator** — the risk is doing the *wrong*
  work: unclear requirements, cross-module change, or truth/release/routing/state
  semantics. A design artifact is written before `execute`; `evaluate` maps
  design-contract-vs-delivered. evaluate → execute repair rounds are strictly bounded
  (max rounds, repeated-finding signature, budget, timeout) and escalate on a
  bound trip.

Roles hand off through artifacts only (design contract, builder evidence,
eval-report) — never a shared raw session. Project-level coordination across
Stories (ordering, conflicts, budget, release readiness) belongs to the
**Supervisor** (`roll supervisor`), not to any single Story's execution.

When the owner asks to clear the backlog, Supervisor uses a backlog-clearing
standard rather than a fix-only queue. The default scope is every live non-Hold
`FIX-*`, `US-*`, and `REFACTOR-*` row. Before starting another card it reconciles
backlog truth, open PRs, CI/evaluator gates, recent cycle endings, manual-merge
PRs, and `.roll` meta state. Each card gets a fresh Builder and, when its
execution profile requires it, an independent Evaluator/Scorer from the current
Agent roster. Repeated failure, zero TCR, missing evidence, parser failure,
auth/permission blocks, or `[roll:manual-merge]` PRs stop scheduling until the
owner action shown by `roll supervisor status/next/why` is resolved.

## Cycle Role Visibility

A v4 cycle is a multi-agent collaboration: a Builder writes the code, one or
more Peer Reviewers re-check the risky diff, an Evaluator/Scorer judges the
delivery, and the Attest Gate decides whether the result is admissible. The
underlying truth lives in `events.ndjson` and the peer/evidence artifacts, but
you should never have to grep those by hand to answer the first-run question:
**who was Builder and who was Evaluator?**

Three surfaces answer that question.

### `roll loop cycle <id> --roles`

```bash
roll loop cycle <id> --roles          # human-readable execution cast for one cycle
roll loop cycle <id> --roles --json   # the same facts as cycle-role-summary.v1 JSON
```

The roles view renders the full role chain — Builder, Peer Review,
Evaluator / Score, and Gates — for a single cycle:

```text
# Cycle Role Summary — 20260629-112437-39253

Story: US-TASK-001
Execution profile: standard

## Builder
- pi / deepseek-v4-pro
  - log: .roll/loop/cycle-logs/20260629-112437-39253.agent.log

## Peer Review
- reasonix: accepted verdict=refine findings=0
- kimi: returned reviewed, no structured verdict accepted
- codex: returned reviewed, no structured verdict accepted

## Evaluator / Score
- reasonix: accepted score=10 verdict=good
- agy: failed unparseable (control characters before SCORE)
- kimi: selected, no accepted score

## Gates
- peer: consulted
- attest: produced
```

The command reads the cached summary artifact first and rebuilds from
`events.ndjson` when it is missing or corrupt, so it works for both fresh and
archived cycles.

### The `summary.md` / `summary.json` artifacts

Every cycle writes the same role cast to disk so a delivery report or a teammate
can read it without re-running the CLI:

```text
.roll/loop/cycle-logs/<cycle-id>/summary.md     # the markdown shown above
.roll/loop/cycle-logs/<cycle-id>/summary.json   # cycle-role-summary.v1, machine-readable
```

`summary.json` carries one `CycleRoleAttempt` per agent participation, each with
its role, agent, model, session id, stage, state, and (when relevant) verdict,
score, findings, parse-failure cause, and artifact path.

### The Execution Cast report block

The story attest report embeds an **Execution Cast** block (🎭) that projects
the same summary into the delivery view, so the role chain travels with the
evidence. When no role summary exists the block degrades gracefully to "Role
summary unavailable". Accepted artifacts are linked directly — e.g. the
`accepted evaluator artifact` link points at the scorer output the gate actually
used.

### Selected vs returned vs accepted

The per-agent `state` is the key to reading the cast correctly. The states form
a ladder, and **being selected or returning output is not the same as being
accepted by the gate**:

| State | Meaning |
|-------|---------|
| `selected` | The agent was chosen for the stage but produced no accepted result. |
| `started` | The agent began the stage. |
| `returned` | The reviewer returned output, but no structured verdict was accepted. |
| `parsed` | Structured output was parsed. |
| `accepted` | The gate accepted this attempt — the verdict/score that counts. |
| `rejected` / `failed` | Rejected, errored, or produced unparseable output. |
| `not_required` / `not_available` | The role was not needed (e.g. `standard` profile) or had no candidate. |

**Only one evaluator/scorer is gate-accepted, even when several agents were
consulted.** A cycle may select reasonix, kimi, and codex for review and ask
reasonix and agy to score, but exactly one score is `accepted` and stamped into
the Attest Gate. The others show as `returned`, `selected`, or `failed` — they
are recorded for transparency, not because they all gate the delivery. When you
need the verdict that actually decided the cycle, read the `accepted` row (and
the `accepted evaluator` artifact link), not whichever agent happens to be
listed first.

When a reviewer or scorer produced unparseable output, its row is `failed` with
a `cause` (e.g. `unparseable`) and a `raw artifact:` pointer to the captured
attempt under `.roll/loop/peer/` — see
[Troubleshooting unparseable score/review](../../docs/live-console.md#故障排查).

## Collaboration View

US-OBS-032 writes the role cast (`summary.md` / `summary.json`), US-OBS-033
exposes that cast with `roll loop cycle <id> --roles`, and the collaboration view is
the upper layer over CycleRoleSummary. It turns the same facts into a protocol
relay: who designed, who built, who reviewed, who evaluated, and where the
baton ended.

Use these entry points:

```bash
roll loop cycle <id> --collab          # one cycle as a protocol relay
roll loop cycle <id> --collab --json   # collab-view.v1 JSON
roll supervisor live --collab     # live multi-cycle collaboration stream
roll supervisor live --collab --once
roll loop cycle --legend               # Layer A protocol legend
```

Read the protocol as:

```text
Supervisor/Designer -> Builder -> independent Peer Reviewer/Evaluator -> Gate
```

The Supervisor can intervene at three levels. `observe/advise` means the
Supervisor is watching, asking for evidence, or routing owner attention without
changing the Builder's work. `design/split` means the Supervisor turns unclear
scope into a design artifact or smaller follow-up actions. `Builder override`
is explicit and exceptional: the Supervisor chooses or replaces the Builder
binding, and that decision must remain visible in the cast.

Role independence is session-based, not brand-based: separate fresh sessions
and artifact handoff are the rule. The same agent brand can serve more than
one role only when each role runs in its own session and hands off through
artifacts: a design contract, diff, review, score, AC map, or report.
A shared transcript is not an independent review. Agent diversity is useful
evidence and a ranking signal, especially when capability or shortcoming
profiles are visible in role summaries, but it is not a default hard exclusion
rule; capability, availability, and the required role contract still decide.

`handoff`, `escalation`, and `terminus` are separate reading keys. A handoff is
the normal baton pass between roles, such as Builder -> Peer Reviewer with a diff and evidence.
Escalation is a visible break in the normal path: the Supervisor, Gate, or owner
needs attention because the ordinary relay could not finish cleanly. The
`terminus` says where the baton ended, not whether the Story passed or failed:
`walked_full`, `escalated`, `split`, and `supervisor_fix` describe the relay's
ending point. Use the Gate and attest result for pass/fail.

## Status Dashboard

`roll loop status` prints a compact dashboard with per-cycle rows and daily rollup totals.

When every currently eligible card needs a physical terminal capture and macOS
is locked, the status line says `waiting for screen unlock`. This is a wait
state, not an idle failure: the next unlocked tick clears the message and
dispatches normally, without consuming the no-progress breaker.

### Token column

Each cycle row shows token usage in a 4-component format:

```
·  19:18    13m    164/498.2K↑ 12.7M↓/63.3K   opus-4-7   $11.07   US-VIEW-012
             ↑      in   cw↑     cr↓    out
```

| Segment | Meaning |
|---------|---------|
| `164` (before first `/`) | Base input tokens |
| `498.2K↑` | Cache write tokens (billed at write rate) |
| `12.7M↓` | Cache read tokens (billed at read rate, much cheaper) |
| `63.3K` (after last `/`) | Output tokens |

When a cycle has no cache data (older cycles or non-Opus models), the column
falls back to the two-part `in/out` format.

**Per-agent coverage.** Token/cost capture depends on a per-agent usage plugin.

| Agent | Token/cost in dashboard |
|-------|-------------------------|
| Claude | ✅ supported |
| pi (DeepSeek) | ✅ supported |
| OpenAI (codex) | ✅ supported |
| Gemini | ✅ supported |
| Kimi | ✅ supported |

Agents without a plugin fall back to a `—/—` placeholder. Adding a new agent is
a small per-agent plugin (`lib/agent_usage/<agent>.py`) — it does not happen
automatically. See `lib/agent_usage/README.md` for the five-step howto.

### Rollup rows

Below the cycle list, daily totals break out all four components:

```
input tokens       164
cache writes    498.2K
cache reads      12.7M
output tokens    63.3K
```

This lets you verify that the displayed per-cycle cost (e.g. `$11.07`) matches
your Anthropic invoice — 86 % of the cost in that example comes from cache.

## Per-Story Rollup

`roll loop status` shows the rolling window (default 3 days). When you want the
**full lifetime** of a single story — every cycle that ever ran on it, including
cycles that have aged out of the dashboard window — use `roll loop story`.

```bash
roll loop story US-LOOP-004           # Compact panel for one story
roll loop story us-loop-004           # Case-insensitive
roll loop story US-LOOP-004 --days 90 # Widen the event-stream lookback
roll loop story US-LOOP-004 --json    # Emit JSON for scripting / dashboards
```

The panel reports the totals you'd otherwise have to hand-add across multiple
`status` runs:

```
── US-LOOP-004 · 把每轮 cycle 成本/token/耗时写进事件流 ──
  cycles    3  (✓ 2  ✗ 1  ⏵ 0)
  span      2026-05-18 14:22  →  2026-05-19 09:11
  duration  1h 47m   tokens  in 412k  out 18.3k  cache w 1.2M  r 7.8M
  cost      $4.92    model  claude-opus-4-7
  PRs       #128 ✓   #131 ✓   #134 ✗
  recent    20260518-142233-91  ✓  $2.10
            20260518-203045-12  ✗  $1.71
            20260519-091112-44  ✓  $1.11
```

**How history is preserved:** the loop runner rotates `events-<slug>.ndjson` at 10 MB,
keeping `.1` … `.4` archives. `roll loop status` and `roll loop story` both read
the head plus all rotated files, so cycles never disappear once they're on disk.

**Exit codes:** `0` when at least one cycle is found, `2` when no cycles match
the story id in the lookback window. The `--json` form follows the same exit
code contract so scripts can detect missing data.

## Cycle Result Eval

Every cycle is scored *objectively* at finish against a fixed multi-dimensional
rubric, with **zero extra tokens** — the score is computed from facts the loop
already has (merge state, CI verdict, TCR count, duration, alerts, orphans). The
result is written into that cycle's `runs.jsonl` record under a `result_eval`
block:

```json
{ "version": 1, "score": 8, "dims": { "outcome": 1.0, "correctness": 1.0,
  "scope_fidelity": 1.0, "quality": 1.0, "efficiency": 0.6, "cleanliness": 1.0 } }
```

> **Result-eval is NOT skill self-scoring.** Skill self-scoring (the agent's
> *subjective* review of one skill run, written into `.roll/notes/*.md`) and
> result-eval (this *objective* per-cycle result score, computed from facts) are
> two different signals. They are reported on separate dashboard lines and never
> merged.

### The rubric (six dimensions)

Each dimension is scored on `0.0`–`1.0`, or `unknown` when its facts are absent.
Unknown dimensions are excluded from the roll-up and the remaining weights are
renormalised, so a missing fact never silently scores `0`.

| Dimension | Weight | Meaning | 1.0 when… |
|-----------|--------|---------|-----------|
| `outcome` | 3 | Did the cycle merge into `main`? | merged · `0.0` not merged |
| `correctness` | 2 | Is the produced PR's CI green? | green · `0.0` red |
| `scope_fidelity` | 2 | Did it complete the story it was routed to? | completed · `0.0` idle / off-scope |
| `quality` | 1 | Tests added, no immediate rework? | TCR ≥ 1, no rework FIX · `0.5` rework landed · `0.0` no tests |
| `efficiency` | 1 | Duration vs the story's `est_min` budget | within budget · grades down past it |
| `cleanliness` | 1 | No orphan worktrees/branches and no ALERTs | clean · `0.0` orphans / alerts |

The dimensions roll up into a single **1–10 cycle score**:

```
weighted    = Σ(score_i × weight_i for known dims) / Σ(weight_i for known dims)
cycle_score = round(1 + weighted × 9)        # 0.0 → 1, 1.0 → 10
```

Weights are a centralised constant in `lib/loop_result_eval.py` — tunable there,
but deliberately not a high-frequency user knob.

### Reading the trend — `roll loop eval [N]`

`roll loop eval` aggregates the `result_eval` of the last `N` scored cycles
(default 14) and prints mean / minimum cycle score, each dimension's hit-rate,
and a trend arrow. Older records without a `result_eval` block are skipped; with
fewer than 3 scored cycles it prints an `(n/a) need 3` notice.

```
$ roll loop eval
Loop result-eval — last 14 cycles
循环结果评分 — 最近 14 轮

  mean   6.8 / 10   ↓
  min    4 / 10
  n      4

  dimension hit-rate / 各维度命中率
    outcome          75%
    correctness      67%
    scope_fidelity   75%
    quality          75%
    efficiency       50%
    cleanliness      100%
```

The `roll loop status` dashboard also carries a one-line result-eval summary,
shown **separately** from the Review Score line so the two are never
confused:

```
result-eval: mean 6.8↓ / min 4 / out 75% ci 67% scope 75% qual 75% eff 50% clean 100% (last 14)
```

### Self-evolution signals — `roll loop signals`

When a dimension stays low (`0.0`) for `N` cycles in a row (default 3,
`--streak` to change), the loop surfaces it as an **improvement signal**: it
appends a *candidate* backlog draft — an `IDEA` or `FIX`, marked `📋 待人确认`
— to `.roll/signals/candidates.md`, and `roll loop signals` (and the
`roll loop status` dashboard) reports it. Signals are deduped per pattern, so a
standing issue is raised once, not every cycle.

A signal is advisory only. It never edits the real backlog, never activates a
story, and never changes code — it only exposes what keeps going wrong so a
human can decide. The cycle-finish hook runs the detector once per cycle;
`roll loop signals` runs it on demand.

| Dimension stuck low | Surfaced as | Reading |
|---------------------|-------------|---------|
| `outcome` | FIX | cycles keep failing to merge into main |
| `correctness` | FIX | produced PRs keep failing CI |
| `scope_fidelity` | IDEA | cycles keep going idle or off-scope |
| `quality` | FIX | cycles keep landing without test activity |
| `efficiency` | IDEA | cycles keep blowing past their `est_min` budget |
| `cleanliness` | FIX | cycles keep leaving orphans / raising ALERTs |

## TerminalOutcome vocabulary

User-facing cycle projections use TerminalOutcome values, not legacy summary
text. The stable vocabulary is:

`delivered`, `published_pending_merge`, `failed`, `blocked`,
`aborted_no_delivery`, `aborted_with_delivery`, `orphan_timeout`,
`idle_no_work`, `unknown`.

Older `runs.jsonl` records may contain free-form result strings. Readers
convert them through the truth adapter before rendering dashboards, archives,
or summaries.

## Visibility (tmux + popup)

Every loop run lives in a detached tmux session.
When you're not muted, a terminal window opens automatically.

Use `roll loop watch` first for daily observation. It combines the live agent
feed with the structured event stream into a concise status layer. Use
`roll loop watch --events` when debugging event ordering or phase/TCR facts.
Use `roll loop watch --raw-events` only when you need the unchanged audit JSON.
All watch modes are read-only; Ctrl-C stops only the view.

```bash
roll loop watch                          # default status layer
roll loop watch --events                 # compact events
roll loop watch --raw-events             # raw audit stream
tmux attach -t roll-loop-<project-slug>  # join the running observe pane at any time
# Ctrl-B D            # detach (loop continues)

roll loop mute        # 🔇 stop popup (mute file: ~/.shared/roll/mute)
roll loop unmute      # 🔔 re-enable popup
```

The `mute` file is shared across all projects and all autonomous activity
(loop + peer review). One switch controls everything.

### Environment drift & session lifecycle

The tmux session is long-lived, but a cycle's **network environment always
follows the invoker**, not the session: the proxy family
(`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` + lowercase) is re-injected
from the caller every time a cycle window opens. Agent secret env names declared
by runner profiles, such as Reasonix's `DEEPSEEK_API_KEY`, are also forwarded by
name; file-backed profile credentials such as `~/.reasonix/.env` are loaded by
the spawn layer. So turning a local proxy on or off between cycles just works —
a session created under a proxy that has since died can no longer starve every
agent into `Connection error` (FIX-230), and env-only agent credentials do not
depend on the stale tmux session. Each cycle also logs its effective proxy env as
an `env:` line in `.roll/loop/cron.log`, so an environment-shaped failure is
readable straight from the log. Other variables still come from the session
created when the tmux session was started; if you rotate something exotic, kill
that session and let the next `roll loop go` rebuild it fresh.

### Edit fold

When the live tmux stream shows the agent editing the same file several times
in a row, Roll no longer repeats the identical long path on N separate lines
(which used to look like a hang). Instead it folds consecutive same-file edits
into a single line and refreshes it in place:

```text
✏ <basename> | <hint> ×N
```

- **Trigger** — two or more *adjacent* `Edit` / `Write` calls targeting the
  same `file_path`. The path is shown as `os.path.basename(file_path)`, never
  the full path. A single edit shows no `×N` counter.
- **`<hint>`** — a ≤20-char feature derived from the edit input so you can tell
  *what* is changing, not just count:
  - `replace_all=true` → the literal `replace-all`.
  - otherwise the first non-blank token of `new_string`'s first line, with
    leading whitespace and comment markers (`#`, `//`, `/*`, `*`, `--`, `;`)
    stripped.
  - tokens longer than 20 characters are truncated to `token[:20] + "…"`
    (counted by unicode char, so 中文 / emoji are not byte-split).
  - an empty / all-whitespace `new_string` yields no hint, and the ` | <hint>`
    segment is omitted entirely.
- **Cross-file flush** — switching to a different file (or any other event:
  `Bash`, `Skill`, an error, or cycle end) first flushes the previous file's
  final streak line so it stays in the scrollback, then starts a fresh line for
  the new file. Edits never fold across a non-edit line.

Three examples (ANSI-stripped):

```text
# single edit
✏ auth.ts | export

# folded ×N (7 edits of the same file)
✏ auth.ts | export ×7

# cross-file switch — two lines, the first flushed before the second starts
✏ auth.ts | export ×3
✏ router.ts | replace-all
```

## Cycle exit summary

When a cycle ends and the tmux session detaches, the macOS `.command` window
no longer leaves you staring at a bare `press enter to close` line. Just before
that prompt, the window renders a compact recap block so you can see what the
cycle did without scrolling back through tmux scrollback or opening the cron
log:

```text
─── Cycle 20260530-2301-94839 Summary ───
  outcome: delivered · story: US-LOOP-040 · tcr commits: 4
  ci: green
  todo remaining: 7
  phases (top 5 by time):
    build                   612s
    ci                       94s
    pr                       31s
  press enter to close.
```

The summary covers five signals:

1. **Result** — the cycle outcome from `runs.jsonl`, rendered as
   TerminalOutcome in the summary:
   `delivered`, `published_pending_merge`, `failed`, `blocked`,
   `aborted_no_delivery`, `aborted_with_delivery`, `orphan_timeout`,
   `idle_no_work`, or `unknown`.
2. **CI / build status** — the latest `ci` event outcome: `green`, `red`,
   `heal-attempting`, or `ci: n/a` when the cycle never ran CI.
3. **Todo remaining** — count of `📋 Todo` lines still in `.roll/backlog.md`.
4. **Phase breakdown** — the top 5 cycle phases by elapsed time.
5. **Failure / alert highlights** — failed/aborted runs, red CI, active alerts,
   and suspected zero-diff cycles are flagged with a `✗` (failure) or `⚠`
   (warning) prefix and, on a colour terminal, red / yellow highlighting. A
   fully green cycle prints in the default colour with no prefix.

The `press enter to close` prompt is preserved — the summary is printed *above*
it, nothing about the close interaction changes.

### Turning off colour

ANSI colour is only emitted when the output is a real terminal. Pipes,
redirects and captured output stay plain text. To force colour off on a TTY,
set `NO_COLOR=1` (per [no-color.org](https://no-color.org)):

```bash
NO_COLOR=1 roll loop go --max-cycles 1
```

### Troubleshooting: no summary appears

If the cycle exited early (aborted/idle) or `runs.jsonl` had not yet flushed,
the window prints a single placeholder line instead, and the `press enter`
prompt still works:

```text
(summary unavailable — see log: ~/.shared/roll/loop/cron-<slug>.log)
```

Summary rendering is always a silent best-effort step: if `python3` is missing
or the data is corrupt, the cycle skips the recap and falls straight through to
`press enter to close` — it never changes the `.command` exit code or blocks
the window from closing.

## Concurrency Safety

Loop has two layers:

- **LOCK file** (`<project>/.roll/loop/.LOCK-<slug>`): only one loop per project runs at a time.
  If loop is already running, a new fire exits immediately.
- **🔨 In Progress status**: stories being worked by humans or other agents are skipped.

You can always run `$roll-build US-XXX` to take over a story manually.
Loop sees the `🔨 In Progress` marker and skips it.

## Failure Handling

| Condition | What happens |
|-----------|-------------|
| API error | Retry up to 3×, 30s backoff |
| Role candidate unavailable | Skip for current resolution, record runtime health |
| No role candidate available | Pause loop, write ALERT.md |
| TCR: 0 commits | Revert story to 📋 Todo, write ALERT.md |
| HEAD CI red | Hot-fix attempt (see below), or ALERT if exhausted |

ALERT entries surface in `roll loop status`, `roll loop alert`, and cycle/story evidence views.

## CI Self-Healing (US-LOOP-046..050)

When loop detects that HEAD CI is red before picking a story, it no longer
immediately writes an ALERT and stops. Instead it tries to fix CI autonomously.

**How it works:**

1. `roll loop precheck-ci` runs before each BACKLOG scan.
2. If CI is green → cycle proceeds normally.
3. If CI is red AND heal is allowed:
   - Loop captures the failing CI log + commit diff via `roll loop hotfix-head-context`.
   - Invokes `roll-fix` with that context as a brief.
   - Waits for CI to go green.
   - If still red after `ROLL_LOOP_HEAL_MAX` attempts (default 2): writes ALERT and stops.
4. If CI is red AND heal is exhausted or `ROLL_LOOP_NO_HEAL=1`: writes ALERT (existing behavior).

**Loop-owned PRs (`loop/*`) that turn red after a cycle exits** remain
`awaiting_merge`. The Delivery Reconciler reports a long-red PR as
`degraded(ci_stuck)` after the dwell threshold; it never invents delivery and
never runs a separate background healer. Fix the branch, then run
`roll loop reconcile` (or let the next cycle/read path tick retry).

**Environment variables:**

| Variable | Default | Effect |
|----------|---------|--------|
| `ROLL_LOOP_NO_HEAL=1` | unset | Disables all CI hot-fix attempts; reverts to fail-fast |
| `ROLL_LOOP_HEAL_MAX` | `2` | Maximum consecutive hot-fix attempts before ALERT |

## PR Inbox & Review

Each loop cycle processes open PRs before picking new stories.

**Review skill:**

PR review is dispatched through the `roll-review-pr` skill. It fetches the PR
title, body, and diff via `gh`, renders a review prompt, and routes it to the
project's configured agent (Claude, Kimi, DeepSeek, etc.). The agent outputs a
structured verdict:

| Verdict | Action |
|---------|--------|
| `APPROVE` | `gh pr review --approve` |
| `REQUEST_CHANGES` | `gh pr review --request-changes` with reason |
| `UNCERTAIN` | Writes an ALERT — human decides |

**Escape hatch:** Add `[skip-ai-review]` anywhere in the PR body to
auto-approve without invoking the agent.

**How the loop uses it:** `roll loop pr-inbox` classifies each open PR and routes
`eligible` PRs to the `roll-review-pr` skill. Loop's own PRs (`loop/*` branches)
are skipped to avoid same-source bias.

**Stale PR rebase:** PRs classified as `stale` (CI failed or branch behind/conflicting)
are automatically rebased onto `origin/main` by the runner's stale-PR rebase. A circuit
breaker limits rebase attempts to 3 within 24 hours — after that, an ALERT is raised.
Fork PRs are skipped (no write access) with an ALERT.

**Bot review detection:** If a GitHub Actions bot has already reviewed the PR
(e.g. via the optional GHA workflow), `roll loop pr-inbox` defers:
- Bot `APPROVED` → skip, let auto-merge proceed
- Bot `CHANGES_REQUESTED` → write ALERT (loop PR rejected by GHA reviewer)

**Active merge:** when a PR is eligible, CI-green, and mergeable, the Delivery
Reconciler runs `gh pr merge --squash` rather than depending on repo-level
auto-merge. Merge failure is non-fatal: the PR stays `awaiting_merge` and is
retried on a later reconcile tick.

### Optional: Event-driven PR review (GHA)

Without extra setup, `roll loop pr-inbox` reviews eligible PRs each loop cycle
(up to ~1 hour delay). For seconds-fast feedback on GitHub-hosted repos,
install the event-driven workflow:

```bash
cp templates/workflows/pr-review-event.yml .github/workflows/
```

This triggers the `roll-review-pr` skill on every PR open/update. Fork PRs and PRs
with `[skip-ai-review]` in the body are automatically skipped. The template
requires only one API key secret — the one matching your configured agent.

The two modes coexist: the GHA workflow provides instant feedback, and
`roll loop pr-inbox` acts as a safety net if the workflow is not installed.

## Session Cleanup

At the end of every cycle, loop automatically prunes stale local worktrees:

- Any directory under `.claude/worktrees/` whose branch has been fully merged
  into `main` is removed (`git worktree remove --force` + `git branch -D`).
- `git worktree prune` runs afterward to clear stale metadata.

This keeps `git worktree list` clean and prevents `.claude/worktrees/` from
accumulating old entries over time. Active worktrees (branches ahead of `main`)
are left untouched.

## Main Checkout Guard

During the Builder process, Roll makes the shared main checkout read-only at the
filesystem boundary while leaving the cycle worktree writable. If a previous
cycle left product files dirty, Roll stashes that pollution to a
`rescue/leaked-*` ref plus a `.roll/loop/quarantine/*.json` manifest and
continues the cycle. Local commits ahead of `origin/main` are treated
differently: the shared `main` ref is NEVER reset. Pre-existing ahead commits
(owner WIP, a concurrent dispatch) are preserved byte-identically — the cycle
worktree branches off `origin/main`, so they cannot leak into the cycle. Only a
head that moves WHILE a cycle is running is a leak: it is bookmarked on a
`rescue/leaked-*` branch, recorded in the manifest, and surfaced as an alert;
resetting main is an explicit human decision.

The event stream records `sandbox:write_protected` and `sandbox:quarantined`.
`roll loop watch --events`, `roll loop cycle <id> --activity`, and supervisor output
surface those facts. Each quarantine manifest includes the ref, file list, and a
one-line restore command for owner/supervisor recovery.

## Post-cycle Environment Cleanup

Before the cycle worktree is removed, loop runs a declarative environment
cleanup step. It targets only transient toolchain/scratch artifacts produced
inside the worktree — e.g. `.scratch`, `tmp`, `node_modules/.cache`, `.vite`,
`__pycache__`, `.build` — and leaves source files and uncommitted work alone.

Each rule emits a `cycle:cleanup` event to `events.ndjson`, so the cleanup is
observable and auditable. Cleanup failures are downgraded to warning events,
also summarized in `ALERT.md` under the independent `harness:env_cleanup` root
cause, and never block the next cycle.

You can override or extend the default rules by creating
`.roll/loop/cleanup-manifest.yaml`:

```yaml
rules:
  - name: my-scratch
    kind: rm
    paths:
      - .my-tmp
      - "**/roll-cleanup.log"
  - name: my-cache
    kind: isolate
    paths:
      - .my-cache
```

`kind: rm` deletes the path; `kind: isolate` moves it into a cycle-local
`.roll-cleanup/<cycle-id>/<rule>/` directory inside the worktree (so it is
removed along with the worktree).

Supported path forms are deliberately small: literal relative paths such as
`.my-tmp` and recursive suffix matches of the form `prefix/**/literal-suffix`,
including `**/roll-cleanup.log` or `src/**/__pycache__`. Shell globs are not
expanded; a `*` inside the recursive suffix, such as `**/*.log`, makes that rule
invalid, emits a warning, and skips the rule. Use `rules: []` or
`enabled: false` to disable cleanup explicitly. The default manifest is used
only when no override file is present.

## Cycle phases

Every cycle is sliced into seven named phases. Each phase emits a `phase_start`
event when entered and a `phase_end` event with duration + outcome when it
exits. Long-silent phases (claude, PR-merge wait) emit a `phase_tick` heartbeat
so the tmux viewer never looks frozen.

| # | Phase | When it runs | Typical duration |
|---|-------|--------------|------------------|
| 1 | `startup` | env / lock / heartbeat setup | < 1 s |
| 2 | `preflight` | meta sync + stale-branch GC + orphan-worktree recovery | 0 s — 30 s |
| 3 | `worktree_setup` | fetch origin + worktree create + meta sync | 2 – 10 s |
| 4 | `agent_invoke` | Agent executes with up to 3 retries | 5 – 45 min |
| 5 | `publish_push` | push branch + open PR (or doc-only merge) | 5 – 30 s |
| 6 | `cleanup` | env cleanup + emit PR final state + worktree teardown | < 1 s |

> A cycle ends when the PR is open — it does **not** wait for merge. The event-backed Delivery Reconciler advances delivery at cycle boundaries, on read paths, or via `roll loop reconcile`; there is no merge daemon. A story with an open PR is skipped by the eligibility gate, so it is neither re-opened nor falsely marked Done.

Idle / failed / aborted cycles only emit the phases they actually entered.
At cycle exit, the inner runner prints a phase breakdown panel sorted by
duration descending, e.g.:

```
─── Cycle 20260523-114502-12345 Phase Breakdown ───
  agent_invoke           723s  ( 96.2%)  ████████████████████
  publish_wait_merge       19s  (  2.5%)  █
  worktree_setup            4s  (  0.5%)
  publish_push              2s  (  0.3%)
  preflight                 2s  (  0.3%)
  cleanup                   1s  (  0.1%)
  startup                   1s  (  0.1%)
  ──────────────────────────────────────
  Total                   752s
```

Each phase duration is also persisted to `runs.jsonl` in a new top-level
`phases` object (see [State Files](#state-files) below). `roll loop runs`
appends `slowest=<phase> <pct>%` to each built row so you can see which step
dominated without opening the cycle. For the full breakdown, use:

```bash
roll loop runs --detail 20260523-114502-12345
```

## Cycle Log Archive

Every cycle's full agent output is archived to `.roll/cycle-logs/<cycle-id>.log`
as an ANSI-stripped plain-text file — readable with `less`, `cat`, or any editor.

- **Per-cycle archive**: one `.log` file per cycle, saved to `.roll/cycle-logs/`
- **ANSI-stripped**: color codes and control characters removed, clean plain text
- **Retention**: keeps the 50 most recent cycles, older ones are auto-rotated
- **Works muted or not**: logs are saved even when `roll loop mute` is on

```bash
roll loop log                # View the most recent cycle's full log
roll loop log <cycle-id>     # View a specific cycle (e.g. 20260525-231803-39799)
roll loop log <prefix>       # Prefix match (e.g. 20260525 matches all May 25 cycles)
```

Cycle logs are stored inside `.roll/` (the project's meta directory) and are
gitignored — they won't pollute your repo.

## Cross-Machine Sync

When you run loop on multiple machines for the same project, Roll can sync cycle
records to a shared git repo. Every machine writes its own events file, and the
dashboard reads all of them — you get a unified view of every cycle across every
machine.

### Setup

Add a `roll_records_remote` field to `~/.roll/config.yaml`:

```yaml
roll_records_remote: "git@github.com:you/roll-loop-records.git"
```

**Private repo strongly recommended.** Cycle records contain prompt text, file
paths, and other potentially sensitive information. Treat the records repo the
same way you treat application logs — private, access-controlled, never public.

If `roll_records_remote` is not configured, cross-machine sync is entirely
skipped — no records leave your machine.

### How it works

- Each machine generates a unique machine-id (UUID v4) on first run, cached at
  `~/.shared/roll/machine-id`.
- Every cycle completion pushes an append-only `.ndjson` file to
  `<slug>/events/<machine-id>.ndjson` in the records repo. Each machine only
  writes to its own file — no merge conflicts.
- Before rendering the dashboard, Roll runs `git pull --ff-only` on a local
  clone at `~/.shared/roll/sync/`, reads every `*.ndjson` file, and merges
  them sorted by timestamp with `run_id` deduplication.
- Push and pull are best-effort background operations — if the remote is
  unreachable, the cycle continues normally and the dashboard shows only
  local data.

### Dashboard sync indicator

The dashboard footer shows one of three states:

| Indicator | Meaning |
|-----------|---------|
| `sync: ok (2m ago)` | Remote reachable, records merged successfully |
| `sync: offline` | Remote unreachable (network issue, auth expired) — showing local data only |
| `sync: not configured` | `roll_records_remote` not set — sync is off, this is expected |

### Fork caveat

Roll derives the project slug from `git remote get-url origin`. If you change
`origin` to point to a fork, the slug changes — records from the original repo
and the fork will land in different directories in the records repo. This is
intentional (different repos, different identities), but if you're temporarily
working from a fork, be aware that the dashboard won't show the upstream's
cycle history.

## Loop Meta Sync

At the start of every cycle, roll automatically pulls the latest project metadata
(`.roll/` directory — backlog, conventions, skills) from its git remote before
scanning for stories.

**How it works**

1. Detects whether `.roll/` has a configured `origin` remote.
   If not, the step is silently skipped (no side-effects for standard roll installs).
2. Runs `git fetch && git reset --hard origin/main` with a 15-second timeout.
3. On success: emits a `meta_sync ok` event; cycle proceeds with fresh backlog.
4. On failure: emits a `meta_sync stale` event; cycle continues with the existing
   `.roll/` contents (stale is better than no-op).

**After 3 consecutive failures** the loop writes an ALERT prompting you to check
your SSH key or network connectivity.

**Manual sync**

```bash
git -C .roll fetch && git -C .roll reset --hard origin/main
```

**FAQ: the loop runs but the dashboard shows an empty backlog**

This usually means `.roll/` is out of date:
- On a new machine: clone roll-meta manually into `.roll/` and configure the origin remote.
- After reinstalling the OS: same as above — SSH key may also need re-authorization.
- To confirm: `git -C .roll remote get-url origin` — if empty, no sync is attempted.

## Remote Monitoring

When you're away from your machine you can still watch the loop — backlog
progress, Dream health, CI state — from a phone or any browser, without a local
`roll` command. It works in two layers: a **data layer** (your machine pushes a
status snapshot to the roll-meta repo) and a **prompt layer** (you paste a watch
prompt into Claude Code, which reads roll-meta + the GitHub API).

### Configure `roll_meta_dir`

Tell roll where your roll-meta checkout lives, in `~/.roll/config.yaml`:

```yaml
# ~/.roll/config.yaml
roll_meta_dir: ~/projects/roll-meta
```

`~` is expanded. The key is optional — if it's unset, nothing changes and no
snapshot is pushed. If the path doesn't exist, roll prints one WARNING to the
cron log and skips the push (the cycle is never affected).

### How the automatic push works

Once `roll_meta_dir` is configured, the loop pushes a fresh snapshot after
**every** cycle — including idle cycles where no story ran, so the snapshot
doubles as a heartbeat. The cycle runner calls
`${roll_meta_dir}/ops/push-loop-status.sh` in the background right after the
`cycle_end` event. The script writes `status/loop.md` and commits + pushes it to
roll-meta. Output goes to `~/.shared/roll/push-status.log` (rotated at 1MB, 2
copies kept).

`status/loop.md` is refreshed by each cycle, so it is as fresh as the last cycle of
the last run — not a fixed window. Between runs it does not change, which is itself
the honest signal: a stale timestamp means nobody has driven the loop since. The push is best-effort: a
network error, git conflict, or a >60s timeout is logged to push-status.log, the
process is killed if it hangs, and the cycle continues. No ALERT, no retry.

### Manual push

You can push a snapshot by hand at any time:

```bash
bash .roll/ops/push-loop-status.sh .roll
```

(`.roll` is your project's roll-meta checkout.) This is also how you confirm the
push pipeline works before relying on the automatic hook.

### Watching from a phone or browser

Open `.roll/prompts/remote-watch.md`, copy its contents, and paste them into
Claude Code (web, mobile, or a remote IDE). The prompt does a full health check
on first run, then polls every 15 minutes and raises an ALERT immediately on
conditions like CI failing twice in a row or `status/loop.md` going >60min
stale. It only reads — it never modifies `seanyao/roll`.

### Troubleshooting: `status/loop.md` is stale

If the snapshot's timestamp is far older than your last run:

1. Check `~/.shared/roll/push-status.log` — it records every push attempt and
   any timeout or git error.
2. Confirm `roll_meta_dir` is set and the path exists
   (`roll config get roll_meta_dir`).
3. Confirm `${roll_meta_dir}/ops/push-loop-status.sh` exists and is executable.
4. Run the manual push above and watch for errors.

---

远程不在本机时，依然可以从手机或任意浏览器查看 loop —— backlog 进度、Dream 健康、
CI 状态 —— 无需本地 `roll` 命令。它分两层：**数据层**（本机把状态快照 push 到
roll-meta 仓库）和 **prompt 层**（把巡检 prompt 粘贴进 Claude Code，读 roll-meta +
GitHub API）。

### 配置 `roll_meta_dir`

在 `~/.roll/config.yaml` 里告诉 roll 你的 roll-meta 检出在哪：

```yaml
# ~/.roll/config.yaml
roll_meta_dir: ~/projects/roll-meta
```

`~` 会被展开。这个键是可选的——不配就什么都不变，也不会推快照。路径不存在时，roll 向
cron 日志打一条 WARNING 并跳过推送（绝不影响 cycle）。

### 自动 push 的工作原理

配好 `roll_meta_dir` 后，loop 在**每一次** cycle 结束后推一份新快照——包括没跑故事
的 idle cycle，所以快照同时充当心跳。cycle runner 在 `cycle_end` 事件之后，于后台调
用 `${roll_meta_dir}/ops/push-loop-status.sh`。脚本写出 `status/loop.md` 并提交 +
push 到 roll-meta。输出写到 `~/.shared/roll/push-status.log`（1MB 轮转，保留 2 份）。

`status/loop.md` 由每个 cycle 刷新,新鲜度就是上一次运行的最后一个 cycle——不是固定窗口。两次运行之间它不变,这本身就是诚实的信号。巡检 prompt 总
能看到近期数据。推送是 best-effort：网络错误、git 冲突或 >60s 超时都记进
push-status.log，进程卡住会被 kill，cycle 继续。不设 ALERT，不重试。

### 手动 push

随时可以手动推一份快照：

```bash
bash .roll/ops/push-loop-status.sh .roll
```

（`.roll` 是你项目的 roll-meta 检出。）这也是在依赖自动 hook 前确认推送链路是否正常
的方法。

### 在手机或浏览器上巡检

打开 `.roll/prompts/remote-watch.md`，复制全文，粘贴进 Claude Code（网页、手机或远端
IDE）。该 prompt 首次执行做一次全量体检，之后每 15min 轮询一次，遇到「CI 连续两次失
败」或「`status/loop.md` 超过 60min 未更新」等条件立即告警。它只读——绝不修改
`seanyao/roll`。

### 排障：`status/loop.md` 不更新

若快照时间戳远早于你最近一次运行：

1. 看 `~/.shared/roll/push-status.log`——它记录每次推送尝试以及任何超时或 git 错误。
2. 确认 `roll_meta_dir` 已配置且路径存在（`roll config get roll_meta_dir`）。
3. 确认 `${roll_meta_dir}/ops/push-loop-status.sh` 存在且可执行。
4. 跑一次上面的手动 push，观察是否报错。

## State Files

Since Phase 2.0, a project's loop state lives **inside the project** at
`<project>/.roll/loop/`. Only machine-level files — the attach script and the
global mute switch — stay in `~/.shared/roll/`. See
[Loop Data Layout](loop-data-layout.md) for the full layout and `roll loop gc`.

自 Phase 2.0 起，项目的 loop 状态搬进了**项目目录** `<project>/.roll/loop/`。只有机
器级文件——attach 脚本和全局静音开关——留在 `~/.shared/roll/`。完整布局与
`roll loop gc` 见 [Loop 数据布局](loop-data-layout.md)。

| File | Content |
|------|---------|
| `<project>/.roll/loop/state-<slug>.yaml` | Current/last run: status, story, agent, run_id |
| `<project>/.roll/loop/runs.jsonl` | Append-only run history (one JSON line per cycle); each record carries a `result_eval` block (see [Cycle Result Eval](#cycle-result-eval)) |
| `<project>/.roll/loop/events.ndjson` | Per-cycle event stream (phase_start/phase_end, …) |
| `.roll/signals/candidates.md` | Candidate backlog drafts from self-evolution signals (`📋 待人确认`, never auto-activated) |
| `<project>/.roll/loop/ALERT-<slug>.md` | Accumulated alerts (failures, TCR violations) |
| `<project>/.roll/loop/PAUSE-<slug>` | Pause marker (created by `roll loop pause`) |
| `~/.shared/roll/mute` | Global auto-attach mute marker (shared across projects) |

## Degraded modes & observation

- **Offline**: when a cycle fails while the network is unreachable, the loop
  degrades to **local-only delivery** — TCR commits and green tests stay on the
  branch, a locale-selected notice is printed, the consecutive-failure counter
  is NOT ticked (offline never accumulates into an auto-PAUSE), and the
  scheduler keeps breathing. The next online cycle's push/PR catches up
  naturally.
- **Live window for every agent**: non-claude agents (pi, kimi, codex, …) run
  under a pseudo-terminal on macOS so their output streams line-by-line into
  the observation window instead of buffering until exit; claude streams over
  its own protocol unchanged.

## Leftover launchd lanes

Roll installs no launchd job and owns none. A machine that ran an older version may
still carry `com.roll.*` plists. A loaded one can still fire and invoke
`roll loop run-once` — that path stays honest about it, but it is unattended work you
did not ask for, so clear it. `roll status` / `roll loop status` keep naming leftover
lanes until you do.

Roll deliberately does NOT remove them for you: they live in your `~/Library/
LaunchAgents/`, and silently unloading jobs on your machine is not Roll's call.

Roll 不安装、也不持有任何 launchd 任务。跑过旧版本的机器上可能还留着 `com.roll.*`
plist。仍然加载着的那种还会触发并调用 `roll loop run-once`——那条路径会如实说明，
但这属于你没要求过的无人驱动的活，该清掉。清掉之前，`roll status` / `roll loop status`
会一直提示残留 lane。

Roll 有意**不**替你删:它们在你的 `~/Library/LaunchAgents/` 下,悄悄卸载你机器上的任务
不是 Roll 该做的决定。

**See what is there / 先看有什么:**

```bash
roll doctor                          # lists every com.roll.* lane, its target dir, load state
ls ~/Library/LaunchAgents/com.roll.* # or look directly
```

**Disarm one lane / 卸载一条:**

```bash
launchctl bootout gui/$(id -u)/com.roll.loop.<slug>; rm -f ~/Library/LaunchAgents/com.roll.loop.<slug>.plist
```

`;` rather than `&&` on purpose: a lane that is not loaded makes `bootout` exit
non-zero, and `&&` would then leave the plist on disk — the exact debris you are
removing.

这里用 `;` 而不是 `&&` 是有意的:未加载的 lane 会让 `bootout` 以非零退出,用 `&&` 就会
把 plist 留在盘上 —— 正是你要清的那个垃圾。

**Disarm every roll lane on this machine / 清掉本机所有 roll lane:**

```bash
for p in ~/Library/LaunchAgents/com.roll.*.plist; do
  [ -e "$p" ] || continue
  label=$(basename "$p" .plist)
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
  rm -f "$p"
done
```

Then confirm with `roll doctor` — the leftover-lane section disappears when the
last plist is gone.

之后用 `roll doctor` 确认 —— 最后一个 plist 清掉后,残留 lane 那一节就不再出现。
