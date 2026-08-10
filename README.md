```
 ██████╗  ██████╗ ██╗     ██╗     
 ██╔══██╗██╔═══██╗██║     ██║     
 ██████╔╝██║   ██║██║     ██║     
 ██╔══██╗██║   ██║██║     ██║     
 ██║  ██║╚██████╔╝███████╗███████╗
 ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚══════╝
```

**[中文版 README](README_CN.md)**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@seanyao/roll.svg)](https://www.npmjs.com/package/@seanyao/roll)
[![CI](https://github.com/seanyao/roll/actions/workflows/ci.yml/badge.svg)](https://github.com/seanyao/roll/actions/workflows/ci.yml)

**Roll puts the AI coding tools already on your laptop to work the way a small
engineering team works — and shows you the receipts.**

You already have an AI that writes code when you sit there and prompt it. Roll is
the part around it: it turns your requirement into small tasks, hands one task at
a time to an agent, makes that agent test its own work, opens a pull request, and
keeps evidence you can check afterwards.

## What Roll actually does

Give it a requirement. For each task, Roll then:

1. **Splits the work** — one requirement becomes small numbered tasks in a to-do
   list at `.roll/backlog.md`, each with its own acceptance criteria.
2. **Picks one task and hands it to an agent** — Claude, Codex, Kimi, Pi,
   Antigravity, Reasonix, Cursor: whichever you have installed and logged in.
3. **Keeps the agent in its own sandbox** — the work happens in a separate git
   worktree, not in the directory you are sitting in.
4. **Makes it prove the work** — tests must pass, then a second agent reviews and
   scores the result.
5. **Opens a pull request** — CI has to be green. A task is only Done once its PR
   is merged into `main`. Roll never marks its own homework.
6. **Files the evidence** — every task gets its own acceptance page with test
   output and screenshots, so "it works" is something you can open and look at.

Then it takes the next task.

**One thing to be clear about up front: nothing in Roll starts by itself.** There
is no timer, no background service, no scheduled run. Work happens because you
opened a terminal and ran `roll loop go`. If you never run it, nothing happens.

## Before you start

You need four things:

- **Node.js 22 or newer.** That is the only runtime Roll needs.
- **A git repository** for your project, with a GitHub `origin` it can push to,
  so it can open pull requests.
- **At least one AI coding CLI installed and logged in** — Claude Code, Codex,
  Kimi, Pi, Antigravity, Reasonix, or Cursor. Roll drives them; it does not
  replace them and does not ship a model of its own.
- **An idea of the cost.** The agents bill your accounts, not Roll's. Real work
  costs real tokens; `roll status` shows what has been spent so far.

## Install

```bash
npm install -g @seanyao/roll
```

On macOS the install also tries to fetch `Roll Capture.app` into
`~/Applications` — that is what takes real screenshots for acceptance evidence.
If it cannot (CI, headless, not macOS, no network, or you set
`ROLL_SKIP_CAPTURE_INSTALL=1`), the install still succeeds and Roll simply
reports that screenshots are not ready yet. `roll doctor tools` tells you how to
fix it later. Details: [Installation](guide/en/installation.md).

## Your first task in five minutes

```bash
# 1. One-time on this machine: install the conventions your AI tools read.
roll setup

# 2. In your project. This only LOOKS at your directory first and tells you what
#    it plans to do — it does not rewrite an existing codebase behind your back.
cd your-project
roll init

# 3. Not sure what comes next? Roll answers with exactly one command.
roll next

# 4. Write down one small task, in one sentence.
roll idea "Add a /health endpoint that returns 200"

# 5. Do that one task, then stop, so you can watch what happens.
roll loop go --max-cycles 1

# 6. See where it got to.
roll loop status

# 7. Open the acceptance evidence for the task.
roll attest US-XXX-001
```

Keep the first task tiny — one visible behavior, one obvious way to test it. You
learn more from one small task that finishes than from a big one that stalls.

If you have a PRD or notes rather than one concrete task, point Roll at the
document and let it do the splitting: `roll design --from-file docs/PRD.md`. Full
walkthrough: [Getting started](guide/en/getting-started.md).

## What you see while it runs

`roll status` is the one screen to learn. Here it is on a real project:

```
  WARN    main reconciled vs backlog (snapshot stale)   exit 1
  North  auto 0h ● · delivery no data ● · fix no data ● · attr no data ●

  LOOP      session-driven · no open go session
  CYCLE     31 / 3d   12 failed · ¥213.60
  RELEASE   v4.704.2 staged   unknown · f:0 w:44 ?:78 · 483 merged · 606 pending
  STORY     8% attest coverage      fail 0 · unknown 573

  drift 0 · done 483 (incl. legacy 445) · unknown 573 · todo 30
```

Reading it:

- **North** — four health numbers in one row: how long it has run on its own, how
  often tasks land, how much of the work is fixing its own mistakes, and whether
  failures are being blamed correctly. `roll north` expands them into a 14-day
  panel with targets (72h autonomy, >=60% delivery rate, fix tax, attribution
  errors) and the anti-gaming rules behind each.
- **LOOP** — whether a run is open right now.
- **CYCLE** — attempts in the last three days, how many failed, money spent.
- **STORY** — how much of the finished work has acceptance evidence on file.
- **drift** — tasks marked Done that `main` does not back up. Roll tells you when
  the to-do list and reality disagree instead of trusting the list.
- A `?` means Roll does not know. A `0` means it knows the answer is zero.

While a task is being built, `roll loop watch` shows it live. Both are read-only —
Ctrl-C closes the view and nothing else.

## Questions people ask first

**Will it mess up my code?** Each task is built in its own git worktree, and your
main checkout is made physically read-only while an agent works. Nothing reaches
`main` except through a pull request with green CI. If a stray change does leak
into your checkout, Roll parks it on a `rescue/leaked-*` branch with a note in
`.roll/loop/quarantine` telling you how to get it back — it does not throw work
away.

**What if I close my terminal?** The run keeps going — it is a detached tmux
worker, so you are just no longer watching it. To make it stand down:

```bash
roll loop pause     # stop picking up new tasks
roll loop resume    # let it continue
```

Roll also pauses itself when the same kind of failure keeps repeating, rather
than burning tokens on a broken setup. `roll loop resume` is the way back.

**How do I know it isn't lying to me?** Because a to-do row saying `✅ Done` is
treated as a *claim*, not a fact. The facts are the merge on `main` and the
recorded evidence. Missing or dangling evidence blocks a merge; `roll attest
audit` lists what is missing. Where Roll genuinely cannot prove something
locally — a real publish, a live OAuth callback — the report says `UNVERIFIED`
instead of green.

**Something is broken and I don't know what.** In this order:

```bash
roll doctor      # is the install healthy? the agents? the tools?
roll next        # what should I do next in this project?
roll help        # built-in guides
```

**How much does it cost?** `roll status` shows spend; `roll config prices` holds
the model price list. See [Pricing & cost](guide/en/pricing.md).

## The commands you will actually use

| | |
|---|---|
| `roll init` → `roll next` | Set up a project, then always ask what's next |
| `roll idea "..."` | Add one task |
| `roll loop go` | Do the work (`--max-cycles 1` for one task, `--epic <name>` for one area) |
| `roll loop status` / `roll loop watch` | Snapshot / live view |
| `roll status` | Project health in one screen |
| `roll loop pause` / `roll loop resume` | Stop and restart |

## All commands

| Command | Description |
|---------|-------------|
| `roll agent [migrate\|list\|cast]` | Which AI agents are installed, and who gets which role |
| `roll backlog [sync\|block\|defer\|lint\|…]` | View, manage, lint, and sync the task list |
| `roll config [lang\|prices\|tune\|…]` | Language, model prices, and suggest-only tuning |
| `roll design [--from-file <path>] [--agent <name>]` | Talk a requirement into tasks with the `$roll-design` skill |
| `roll doctor [skills\|tools\|language\|repair-protection]` | Diagnose install, skills, tools, permissions, language drift, write protection |
| `roll help [--lang en\|zh] [name]` | Built-in guides; `roll --help` prints CLI usage |
| `roll idea "<one-sentence description>"` | Capture and classify one task |
| `roll init` | Diagnose this directory and route setup/onboarding |
| `roll loop <go\|pause\|resume\|watch\|status\|runs\|cycles\|cycle\|…>` | Run, observe, and maintain the delivery loop |
| `roll next` | One best next command, whatever state you are in |
| `roll north [--json] [--no-color]` | 14-day panel: autonomy, delivery rate, fix tax, attribution errors |
| `roll release [--dry-run\|--showcase]` | Release planning and the golden-path showcase |
| `roll setup [-f\|--force] [--reselect] [--no-capture-install]` / `roll setup skills\|offboard` | Install/sync conventions, repair screenshot readiness, or remove Roll's files |
| `roll status [ci\|pulse] [--json]` | Project health, CI state, delivery pulse |
| `roll test [--where] [--reset]` | Run tests through the isolation adapter |
| `roll update` | Upgrade the global install and re-sync conventions |
| `roll --version` / `roll -v` | Print installed version |

Support surfaces live under their owner: `roll config prices`, `roll agent cast`,
`roll doctor tools`, `roll status ci`, `roll status pulse`, `roll loop cycles`,
`roll loop cycle`, `roll release showcase`, `roll setup offboard`.

---

## Going deeper

Everything below is for when the basics work and you want to know how the machine
is built.

### Who does what

Roll separates coordinating a project from delivering one task:

- **Supervisor** works at project level: task order, cross-task context, repeated
  failures, release readiness, budget, and when to ask you. It observes and
  advises. It never implements a task and never overrides an evidence gate.
- **Delta Unit** delivers one task through four stable roles — `design` (the
  Designer contract, when the task needs one), `execute` (the build), `evaluate`
  (review and score), and `supervise` (coordination above the task).
- **Which agent fills a role** is resolved as `Scope -> Role -> Binding -> Agent
  -> Model`, declared in `~/.roll/agents.yaml` (this machine) and
  `.roll/agents.yaml` (this project):

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
          from: [claude, codex, kimi, pi, agy, reasonix, cursor]
          require: [evaluate]
          strategy: health-aware
  ```

- **If an agent is not callable** — auth, network, VPN, account state — Roll
  records that and says so. It does not quietly substitute a different agent and
  report success. `roll supervisor route --role builder --story <id>` shows every
  candidate, why each was ranked or skipped, and who was chosen.
- **Skills stay the capability layer.** Roles invoke `$roll-design`,
  `$roll-build`, `$roll-fix`, `$roll-peer` rather than reimplementing them in
  TypeScript.

The ordinary shape of this is a **Delta Team**: your current session acts as the
Supervisor and requests sub-agent sessions for Designer, Builder, and Evaluator
through `roll delta`. Roll never spawns, resumes, or configures a session itself,
including yours. A valid Evaluator report reaches `delta:terminal(handoff_ready)`
and stops there — you run the delivery/PR step yourself, and Done still comes only
from a merge into `main`. Host-guided cost is reported as `? (host_unobservable)`,
never estimated or zeroed.

Procedure: [AI agents](guide/en/ai-agents.md).

#### Local exact-model rig readiness

`roll delta rigs --refresh` probes every exactly configured
`{adapter, cliModelId}` and publishes one complete local snapshot. It is
read-only, never the default model, and does not change dispatch, allocation, or
resolution.

Honest boundaries — what a green probe does and does not mean: it says the rig
answered just now on this machine. Roll also runs a read-only preflight
after the Builder's final green TCR commit, and it checks the frame only — it
does not prove that a model executed, that the session was fresh, or that a long
task will finish.

### Looking inside a cycle

Observability is CLI-first. Persistent facts take one read path: anchors ->
selectors -> adapter -> projections.

```bash
roll loop cycle <id> --roles      # who was selected, who returned, who was accepted
roll loop cycle <id> --collab     # the handoffs between roles
roll loop cycle --legend          # what the symbols mean
roll supervisor live              # multi-role board, one frame
roll supervisor live --collab     # the same board with collaboration detail
roll supervisor live --watch      # keep it open and redraw in place
```

The same facts appear in the Execution Cast block of a task's report. Failures
are attributed on one axis, `env/harness/card/unknown` — a repeating non-`card`
cause pauses dispatch and writes a diagnostic snapshot with a playbook, and
`unknown` is not guessed. An effective autonomous day needs at least 6 non-idle
attempts; backlog-empty days pause the clock instead of counting against it. If
old environment failures polluted the skip list, `roll loop pardon-skip-list
[--dry-run]` rebuilds it from recorded runs.

### Evidence and gates

A task is accepted through its own Acceptance Review Page
(`latest/<id>-review.html`), its AC map, and its screenshots and test artifacts.

Merge gates are strict: a failed `attest render`, dangling `ac-map.json` paths, an
AC still `claimed`, or a visual task with no captured screenshot and no exemption
can all block a merge. PR bodies carry a `Roll-Evidence` trailer so a reviewer can
jump straight to the evidence, and `roll attest audit [--json]` finds dangling
references and `evidence_debt` rows.

See [Acceptance evidence](guide/en/acceptance-evidence.md) and
[Evidence lifecycle](guide/en/acceptance-evidence.md#lifecycle-in-three-stages).

### The rules layer

Roll's own engineering rules live in a versioned registry, `policy/rules.yaml`,
and are projected into the architecture and verification docs. Coverage is
decided by the audited inventory predicate in `policy/rules-inventory.yaml` —
never a keyword-search over the tree, which cannot prove completeness.

Not every rule blocks: `doc_drift: soft` is advisory, so it reports rather than
fails. The stricter `US-RULE-006` mode is a Hold card — it requires a
trusted owner, and it is not enabled.

### Language

Roll shows one visible language per surface. `ROLL_LANG=en|zh` pins the current
process, `roll config lang en|zh` saves a preference, `roll config lang --reset`
goes back to locale detection, and `roll help --lang en|zh` is a one-off read.
`roll doctor language` audits docs, conventions, skills, and generated surfaces
for mixed-language drift.

Agent contracts, code comments, git metadata, and TypeScript identifiers stay in
English — that is the harness contract layer. Conversation follows your language.
User docs live in per-locale files under `guide/en/` and `guide/zh/`; update the
matching locale file or the i18n catalog rather than putting two languages on one
rendered surface. Coverage for these controls lives in
`packages/cli/test/cli-language-surface.test.ts`,
`packages/cli/test/__snapshots__/cli-language-surface.test.ts.snap`, and
`packages/cli/test/doctor-language.test.ts`.

### Repository layout

Development is a pnpm monorepo; what ships is one npm package.

```
packages/      TypeScript engine (pnpm workspaces): spec · core · infra · cli · web
lib/           Runtime companions (price snapshots, i18n catalog)
skills/        Git submodule → the agent skill contracts
conventions/   Conventions synced into AI clients by `roll setup`
template/      Project scaffolding installed by `roll init`
policy/        The rules registry and its audited inventory
```

Build and test: `pnpm install && pnpm -r test`.

## Documentation

| | |
|---|---|
| **Start here** | [Getting started](guide/en/getting-started.md) · [Overview](guide/en/overview.md) · [Engineering methodology](guide/en/methodology.md) |
| **Daily driving** | [The loop](guide/en/loop.md) · [AI agents](guide/en/ai-agents.md) · [Configuration](guide/en/configuration.md) · [Pricing & cost](guide/en/pricing.md) · [FAQ](guide/en/faq.md) |
| **Quality machinery** | [Acceptance evidence](guide/en/acceptance-evidence.md) · [Evidence lifecycle](guide/en/acceptance-evidence.md#lifecycle-in-three-stages) · [Consistency & release gate](guide/en/consistency.md) · [Testing](guide/en/testing.md) · [Test isolation](guide/en/test-isolation.md) |
| **Under the hood** | [Architecture](docs/architecture.md) · [Verification system](docs/verification.md) |

Full index: [guide/en/](guide/en/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, test setup,
and PR conventions.

## Security

See [SECURITY.md](SECURITY.md). Please report vulnerabilities privately, not
through public issues.

## License

[MIT](LICENSE)
