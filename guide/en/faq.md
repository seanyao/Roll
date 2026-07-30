# Roll FAQ

Honest answers to the questions people actually ask, organized by where you are
in your journey with Roll:

- **[A. Getting Started](#a-getting-started)** — before/while you try Roll
- **[B. How Roll Compares](#b-how-roll-compares)** — Roll vs. related projects
- **[C. Operating Roll](#c-operating-roll)** — what to do when something gets stuck

---

## A. Getting Started

> **Roll has two surfaces.** Keep them straight as you read this FAQ:
>
> - **CLI commands** — run in your terminal: `roll init`, `roll loop go`,
>   `roll status`, `roll loop cycle`, etc. These manage state, execution, and
>   observability. They do not write code themselves.
> - **Skills** — invoked inside your AI agent (Claude Code, Cursor, Codex,
>   Pi, etc.): `$roll-build`, `$roll-design`, `$roll-fix`, `$roll-onboard`,
>   etc. In Claude Code you type them as `/roll-build`; the `$` form is the
>   tool-agnostic way we write them in docs. These are where the agent
>   actually does work.
>
> When you see `roll loop go` in this FAQ, that's a shell command. When you
> see `$roll-build US-001`, that's a skill you invoke from your agent's
> prompt.
>
> **Nothing in Roll starts on its own.** Delivery moves forward because you ran
> `roll loop go`. That run outlives your window (it is a detached tmux worker) and
> ends on its own scope; between runs nothing happens.

### A1. Will Roll modify my code or break my main branch?

**Short answer:** Roll has real guardrails, but the safety story differs
between the two modes — be precise about which you're running.

**The universal guarantee — TCR.** Every commit runs your tests. If tests
fail, the commit is reverted automatically. No broken-test commit can land,
in either mode. This is the foundation everything else builds on.

**Manual mode (`$roll-build`, `$roll-fix`, etc., trunk-based):**

- TCR micro-commits as the agent works
- **Phase 6** runs your full CI locally before any push
- **Phase 7** runs an agent-driven code review of the diff before push
- **Phase 8** pushes to `main` directly — you're sitting in front of the
  agent watching this happen and can stop it at any point
- Your remote CI is the last net: if it goes red after push, you see it
  immediately and fix or revert

**Loop mode (`roll loop go`, from an agent session you open):**

- Builds on a branch (`loop/cycle-${CYCLE_ID}`) in a worktree
- Opens a PR with `gh pr create --base main`
- Calls `gh pr merge --auto --squash --delete-branch` — the PR auto-merges
  **only when your required CI checks pass**. CI is the gate, not human
  review (by default)
- To require human review before merge, configure required reviewers on
  `main` in GitHub branch protection — `--auto` will then wait on you too

**Either way:** everything is in git history. `git revert` and `git reset`
work normally if you need to undo something.

**Try it manually first:** Open your AI agent (Claude Code, Cursor, Pi,
etc.) in your project and invoke the build skill on a single story:

```text
$roll-build US-001         # in Claude Code: /roll-build US-001
```

Watch design → TCR → local CI → review → push happen in front of you. See
exactly what Roll touches before you hand it a whole epic with `roll loop go`.

---

### A2. I have an existing project — will Roll work, or will it pollute my code?

**Short answer:** Yes, Roll has a dedicated onboarding flow for legacy code,
and it only writes to its own directory.

**Details:** `roll init` in an existing repo detects existing code and routes
you to `$roll-onboard`. That skill reads your project, asks 9 questions across
cognition / scope / privacy, and writes `.roll/onboard-plan.yaml` as a contract
for `roll init --apply` to execute after review. `roll init --apply` prints the
planned operation checkpoint and waits for confirmation before writing.
Non-interactive automation must use `roll init --apply --auto`.

What Roll adds to your repo:

- `.roll/` — backlog, feature specs, config (commit this)
- `.claude/skills/` or equivalent — symlinks to Roll skills (commit this)
- A few entries in `.gitignore`

What Roll does **not** touch: your source code, unless an agent is executing a
story you wrote.

---

### A3. I don't want long runs. Can I drive Roll manually, one story at a time?

**Short answer:** Yes. That's the default — the loop only runs when you ask
for it.

**Details:** Until you run `roll loop go`, Roll is a CLI + skill library. You
write a story in `.roll/backlog.md`, then invoke a skill from inside your AI
agent:

```text
$roll-build US-001         # execute a single user story end-to-end
$roll-fix   FIX-002        # execute a single bugfix story
```

(In Claude Code these are typed as `/roll-build US-001` and `/roll-fix FIX-002`.)

Each invocation runs design → TCR → local CI gate → agent self-review → push
to `main` in your foreground; you see every step and can stop at any point.
When the workflow earns your trust, run `roll loop go --max-cycles 1` from an
agent session to let it pick a story itself, then widen the run from there
(loop mode goes through a PR instead of pushing to `main` directly — see A1).

---

### A4. What does Roll change on my system, and how do I uninstall cleanly?

**Short answer:** Two places, and `./uninstall.sh` reverses both.

**Details:**

- **Global:** `~/.roll/` (your config), `~/.shared/roll/` (shared loop
  state, `runs.jsonl`). Per-project agent routing lives in `.roll/agents.yaml`.
  The npm binary lives where your global npm packages do.
- **Per project:** `.roll/`, plus symlinks under `.claude/skills/` (or
  equivalent for other agents).

Everything Roll does happens inside a command you start. A `roll loop go` run puts
its worker in a detached tmux window, so it keeps going after you close your
terminal and ends on its own scope — use `--no-tmux` to keep it in the foreground.
What Roll never does is install something that starts work you did not ask for.

To remove everything:

```bash
npm uninstall -g @bipo-ape/roll
~/.roll/uninstall.sh --dry-run    # preview removals
~/.roll/uninstall.sh              # actually remove
```

---

### A4b. I don't have npm or Node.js. Can I still install Roll?

**Short answer:** Yes. The curl install is self-contained and requires only
bash, curl, and tar — all preinstalled on macOS and Linux.

**Details:**

```bash
curl -fsSL https://seanyao.github.io/roll/install | bash
```

No Node.js, no npm, no package manager needed. The script downloads a tarball,
extracts it to `~/.local/share/roll/`, and symlinks `~/.local/bin/roll` into
your PATH. Updates and uninstalls work the same way — `roll update` re-downloads
the latest tarball; `rm -rf ~/.local/share/roll ~/.local/bin/roll` removes
everything.

To pin a specific version (recommended for production):

```bash
curl -fsSL https://seanyao.github.io/roll/install | ROLL_VERSION=v3.610.1 bash
```

---

### A5. How much does a Roll run cost? Can I see token usage?

**Short answer:** Yes — the dashboard shows model + cost per cycle at public
pricing.

**Details:** Since `v2026.521.1`, `roll loop status` shows the model used and
a cost number computed at public per-token pricing.
This is a comparable number, not your bill — your real cost depends on your
subscription tier (Claude Pro, etc.).

Typical ranges per story on Claude Opus 4.x: **$0.5 – $3**, depending on story
complexity and how many TCR iterations the agent burned. Switching to Kimi /
DeepSeek drops this 5–10× at the cost of slower convergence.

**Non-Claude agents:** token/cost capture is per-agent. As of the current
release, cycles run on **Claude, pi (DeepSeek), OpenAI (codex), Gemini, Kimi**
show real token counts and cost. Agents without a usage plugin yet —
notably **OpenCode** — still show `—/—` in the token/cost columns. Support for a
new agent does not appear automatically; it ships as a small per-agent plugin
(see `lib/agent_usage/README.md`).

**Try it:**

```bash
roll loop status                 # loop snapshot with cost column
roll loop status --days 7        # last 7 days of cycles with cost
```

---

### A6. Do I need to understand DDD / TCR / prompt engineering?

**Short answer:** No, but knowing how to write a good user story helps.

**Details:** Roll's methodology lives inside the skills, not in your head.
`$roll-design` walks you through DDD-style decomposition; `$roll-build` runs
TCR for you; the prompt engineering is encapsulated in the skill files (read
or tweak them if you're curious).

The one thing that matters in *your* head: **how clearly you describe what you
want**. INVEST-shape stories (Independent, Negotiable, Valuable, Estimable,
Small, Testable) work much better than "build me a feature." `$roll-design`
helps you get there from a fuzzy idea.

---

### A7. How detailed should my user stories be? Will Roll cope with a bad one?

**Short answer:** Detailed enough that *you* could code it. Fuzzy stories get
caught and refined before `$roll-build` touches code.

**Details:** A workable story has a value statement (`As X, I want Y, so that
Z`), 2–5 acceptance criteria, and any non-obvious constraints. Don't dictate
implementation — Roll figures that out.

- **Too vague** → `$roll-build`'s `$roll-.clarify` phase surfaces the gaps and
  stops, asking for input.
- **Too complex** → the design phase suggests splitting into smaller stories.
- **Vague-but-runnable** → the agent makes best-effort choices. Often fine for
  prototypes, riskier for production.

**Try it:** Run `$roll-design "add user logout"` and watch it expand a one-line
idea into an INVEST-shaped story with ACs.

---

### A8. What kind of projects is Roll a good fit for? What isn't?

**Good fit:**

- Has a real test suite (TCR depends on it)
- Uses git and a PR-based workflow
- Has CI (GitHub Actions or equivalent)
- Has work you can describe as 1–3 sentence stories
- TypeScript / Python / Go / Bash codebases (best-supported today)

**Bad fit:**

- One-off scripts or throwaway prototypes — overhead > value
- Highly specialized domains (low-level OS, embedded, formal verification)
  where AI agents underperform

**Edge case — existing codebase with no tests:** This is a bootstrap problem,
not a disqualifier. TCR needs *something* to gate on, so the loop can't run
on a zero-test repo on day one — but recovering this kind of codebase is
exactly what Roll is built to drive. Workflow: run `$roll-onboard` to
reverse-engineer the existing code into a backlog, write
**characterization-test stories first** (pin current behavior with tests
before changing anything), then refactor under TCR once you have a net.
The first few stories are the bootstrap; everything after that runs like
any other Roll project.

---

### A9. Can I use Roll without CI or without GitHub Actions?

**Short answer:** Yes, but you lose the CI gate. TCR and PR still work locally.

**Details:** `roll status ci --wait` looks for GitHub Actions on the current commit.
If no CI is configured, Roll degrades gracefully: TCR remains the inner gate
(tests must pass for a commit to stick), PRs are still created, but the loop
won't wait on remote CI before marking a story done.

For pure-local use (no GitHub), Roll still works as a methodology + skill
layer — you just lose the "wait for green before next story" behavior.

---

### A10. Solo or team? How does multi-developer collaboration work?

**Short answer:** Built for solo and pair work first; team usage is possible
but pattern-by-pattern.

**Details:**

- **Solo:** the default. `.roll/backlog.md` is your personal queue.
- **Pair:** commit `.roll/`; your teammate's Roll reads the same backlog. Locks
  are per-machine, so two people running loop in parallel won't collide on
  state but may race on the same story.
- **Team:** treat `.roll/backlog.md` like any source file — coordinate via
  PRs. `-peer` skill exists for cross-agent review (one agent reviews another's
  PR). Multi-developer loop coordination (who picks what next) is still a
  rough edge.

Realistic recommendation: in a team, run loop on your own branch/fork, merge
PRs upstream like any human contributor.

---

### A11. After a price update, do historical cycle costs change?

**Short answer:** No. Each cycle's cost is frozen at completion time.

**Details:** When a loop cycle finishes, Roll writes `cost_list_usd` (the
cost at that moment's prices) and `prices_version` (which snapshot was used)
into the usage event. The dashboard reads the frozen value first. Vendor price
changes, `roll config prices refresh`, and Roll upgrades never rewrite historical
costs.

Cycles from before this feature shipped (no `cost_list_usd` field) fall back
to computing with the *current* snapshot and show a dim `[legacy]` marker —
so you know those numbers might drift when prices change.

**Try it:**

```bash
roll config prices show            # see current snapshot
roll config prices refresh         # fetch latest pricing, diff, snapshot if changed
roll loop status --days 7   # historical cycles use frozen costs
```

---

### A12. How do I watch a run from my phone while it's in progress?

**Short answer:** Configure `roll_meta_dir`, then paste
`.roll/prompts/remote-watch.md` into Claude Code on your phone or browser.

**Details:** Once `roll_meta_dir` is set in `~/.roll/config.yaml`, your machine
pushes a `status/loop.md` snapshot to the roll-meta repo after every cycle. The
remote-watch prompt reads that snapshot plus the GitHub API and reports loop
health, backlog progress, and CI state — read-only, no local `roll` needed. The
snapshot is only as fresh as the last cycle of the run you started; once that
run ends, nothing new is pushed. See
[Remote Monitoring](loop.md#remote-monitoring) for setup and troubleshooting.

### A13. How do I see where a cycle spent its time?

**Short answer:** `roll loop runs --detail <cycle_id>` prints the per-phase
breakdown for one cycle.

**Details:** Each cycle records how long every named phase took. The detail
view prints a `─── Cycle <id> Phase Breakdown ───` block sorted descending
with seconds, percentage, and a bar chart, so you can see at a glance whether
the time went into the agent, the worktree setup, or the push. Set
`NO_COLOR=1` to disable colour. See C6 below for how to read the result.

---

## B. How Roll Compares

### B1. vs. Claude Code's built-in `/loop`, skills, and tasks

**What Claude Code already has:** Skills (custom commands), tasks (in-session
todos), plan mode (review-before-execute), `/loop` (timer that fires a prompt
on an interval).

**Where Roll differs:**

- **Persistent backlog in git.** Roll's `.roll/backlog.md` survives sessions,
  restarts, and model swaps. Claude Code tasks live for one session.
- **Delivery pipeline, not a timer.** `/loop` re-fires a prompt every N
  minutes. `roll loop go` selects the next ready story, runs DDD → TCR → PR →
  CI, waits for green, then moves on to the next one — as many cycles as the
  session lasts.
- **TCR as a hard gate.** Claude Code's skills are advisory; Roll enforces
  `test && commit || revert` at commit time.
- **Cross-agent.** The same backlog and skills run on Codex, Kimi, DeepSeek,
  Pi, OpenCode. `/loop` only knows Claude.

**Who picks what:**

- Quick interactive sessions, ad-hoc work → Claude Code alone is plenty.
- Long-running projects, many stories per sitting, hard CI gates → add Roll.

Roll's `roll-*` skills *are* Claude Code skills. Roll layers on top of Claude
Code; it doesn't replace it.

---

### B2. vs. [superpowers](https://github.com/obra/superpowers) (obra)

**What superpowers does well:** A mature 7-stage methodology (brainstorm →
worktree → plan → execute → test → review → finish), broad agent support
(Claude Code, Cursor, Codex, Antigravity, Copilot, Factory, OpenCode), strong
RED-GREEN-REFACTOR enforcement, subagent-driven development. Roll's README
already acknowledges it — several Roll workflow patterns were inspired by it.

**Where Roll differs:**

- **Persistent backlog + multi-story runs.** Superpowers is session-driven —
  you initiate each cycle. Roll is session-driven too, but one `roll loop go`
  keeps picking the next ready story cycle after cycle until the run ends.
- **CI as a terminal gate.** Roll waits for GitHub Actions green before
  marking a story Done; superpowers leaves CI integration to you.
- **PR-centric output.** Every Roll story ends in a PR linked to your CI.
  Superpowers is more flexible about output shape.

**Who picks what:**

- You want to drive each cycle yourself with a strong methodology behind
  you → **superpowers**.
- You want to start one run and have it chew through a backlog with hard CI
  gates → **Roll**.

You can also run Roll alongside superpowers — they overlap but don't conflict.

---

### B3. vs. [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) (Yeachan Heo)

**What oh-my-codex does well:** A sophisticated harness for Codex CLI — tmux
HUD, hooks, agent teams (`$ralplan`, `$ralph`, `$ultragoal`), persistent state
under `.omx/`, durable multi-goal execution via ledger checkpoints. 29k stars,
very active.

**Where Roll differs:**

- **Not Codex-only.** Roll works with Claude / Codex / Kimi / DeepSeek / Pi /
  OpenCode. oh-my-codex is intentionally Codex CLI focused.
- **TCR as a hard gate.** oh-my-codex recommends clarification → planning →
  execution but doesn't enforce TDD/TCR at the commit level.
- **PR + CI as terminal output.** Roll's loop ends each story at "PR merged
  when CI green." oh-my-codex ends at "agent says goal done."
- **Methodology shape.** oh-my-codex emphasizes durable multi-goal execution
  and parallel teams. Roll emphasizes single-story atomicity (one INVEST
  story → one PR → green CI → next).

**Who picks what:**

- Heavy Codex CLI user; want hooks / tmux HUD / multi-agent teams →
  **oh-my-codex**.
- Want cross-agent portability and PR/CI as the success contract → **Roll**.

---

## C. Operating Roll

### C1. Loop is stuck — a story stays "In Progress" and Done is never written

**Symptoms:** `roll loop status` shows `running`, a story sits at
`🔨 In Progress` in BACKLOG for longer than one cycle, or the agent ran
successfully (TCR commits exist) but the story isn't marked `✅ Done`.

**Why this happens:** Loop marks a story `🔨 In Progress` before invoking the
build skill, and only writes `✅ Done` after two hard gates pass: (1) TCR
commit count > 0, (2) CI green via `roll status ci --wait`. If the agent crashes mid-
cycle, the LOCK file goes stale, or CI fails, the story stays as-is — by
design, to avoid false-positive completions.

**Under the hood:** Each cycle acquires a per-project LOCK
(`~/.shared/roll/loop/.LOCK-<slug>`). A dead PID is auto-cleaned next cycle.
A live but hung process (e.g. stuck tmux) keeps the LOCK and blocks new
cycles.

**Fix:**

```bash
roll loop status              # check LOCK + PID
roll loop watch               # read-only live view; Ctrl-C stops only the view
roll loop runs                # last cycle outcomes and alerts
roll loop alert               # any CI or TCR alerts?
roll loop reset               # clear state + LOCK if truly stuck
roll loop go --max-cycles 1   # run one fresh cycle
# If code is done and tests pass but Phase 11 didn't complete:
$roll-build US-XXX            # finish the story manually
```

---

### C2. PR has merge conflicts or rebase fails

**Symptoms:** `gh pr checks` shows "This branch has conflicts" or
`roll loop runs` reports a rebase-failure alert.

**Why this happens:** While the loop built in a worktree, another commit
landed on `main` that touches the same lines as the PR.

**Under the hood:** `roll loop reconcile` probes awaiting-merge cycles against
`main` and reports the PR as stuck with a `conflict` reason rather than
retrying blindly. Structural conflicts are yours to resolve — the loop will
not rewrite your branch to guess at a merge.

**Fix:**

```bash
gh pr view <number>               # see which files conflict
git fetch origin main
git checkout <pr-branch>
git rebase origin/main            # resolve manually
git push --force-with-lease
# CI re-runs; PR auto-merges when green (if enabled)
```

---

### C3. How do I see what loop did and how much it cost?

**Symptoms:** A run just finished and you want a quick read of what happened
and what it cost.

**Why this matters:** Roll writes structured records every cycle, but there
are multiple surfaces depending on what you need.

**Under the hood:** Each cycle appends a JSONL record to
`<project>/.roll/loop/runs.jsonl` with story ID, model, TCR commit count,
duration, outcome, and cost (public pricing). `roll status`, `roll loop cycle`, and
story-scoped attest reports read this — and the rest of the truth ledger — into
human-readable surfaces. The live watch view is read-only and combines
live activity with structured event facts; the tmux observe pane uses the same
watch entrypoint.

**The observability stack:**

| What you want | Command |
|---|---|
| Last N cycle summaries + cost | `roll loop status --days 7` |
| Total spent on one story across all cycles | `roll loop story <ID>` |
| Per-cycle JSONL records | `roll loop runs` |
| Phase breakdown for one cycle | `roll loop runs --detail <cycle_id>` |
| Snapshot dashboard with cost column | `roll loop status --days 7` |
| Watch the agent in real time | `roll loop watch` |
| Debug compact event facts | `roll loop watch --events` |
| Raw audit event JSON | `roll loop watch --raw-events` |
| Shipped / in-progress / queue / release readiness at a glance | `roll status` |
| Alerts that need attention | `roll loop alert` |
| Full cycle agent output (plain text) | `roll loop log` |
| Full agent transcript | `roll loop watch --verbose` or `roll loop log` |

`status` rolls the dashboard forward (default 3-day window). When a story took
several cycles spread over a week and you want the total — duration, tokens,
cost, every PR that came out of it — `roll loop story <ID>` reads the full
event stream (including rotated archives `.1` … `.4`) and prints a single panel.

---

### C6. A cycle says phase X took forever — how do I find what slowed it down?

**Symptoms:** `roll loop runs` shows `slowest=claude 96%` on a 45-minute cycle,
or `slowest=worktree_setup 40%` on one that seemed to finish quickly. You want
to know which step ate the time before deciding whether to tune anything.

**Why this matters:** Every cycle is sliced into six named phases
(`startup` / `preflight` / `worktree_setup` / `agent_invoke` / `publish_push` /
`cleanup`). The main loop does not wait for merge: it records `awaiting_merge`,
then the Delivery Reconciler advances the PR on cycle boundaries, read paths,
or an explicit `roll loop reconcile`. The top-line duration is therefore
dominated by `agent_invoke` in almost every cycle.

**What to do:**

1. Grab the cycle id from the `roll loop runs` row (or from `runs.jsonl`).
2. Print the full breakdown with `roll loop runs --detail <cycle_id>` — phases
   are sorted descending with seconds, percentage, and a bar chart.
3. Common patterns:
   - `agent_invoke` dominating → expected for a multi-file story; nothing
     to tune unless you can split the story.
   - PR sitting open / not merging → run `roll loop reconcile --json`, then
     inspect its CI, draft/review, conflict, or permission reason. This is not
     a main-loop phase.
   - `worktree_setup` > 30 s → likely a slow `git fetch origin`; transient
     network issue.
   - `preflight` > 30 s → previous cycles left orphan worktrees; loop is
     recovering them. Self-heals on next cycle.

The phase tracing data also lives in `runs.jsonl` under the `phases` key
(per-phase seconds), so you can post-process across many cycles.

---

### C4. Multiple projects running loop — are they interfering?

**Symptoms:** You have `roll loop go` running for two projects at once and you
suspect they're stepping on each other.

**Why this happens:** They shouldn't. Each project gets its own LOCK file
(`~/.shared/roll/loop/.LOCK-<project-slug>`) and its own `state.yaml` entries.
The slug is `basename + md5(abs-path)`, so even two projects with the same
directory name on different paths get different locks.

**Fix:**

```bash
# Run in each project directory to see its run state + LOCK
roll loop status

# See all active locks across projects
ls ~/.shared/roll/loop/.LOCK-*

# If a stale lock from another project is blocking yours
roll loop reset
```

---

### C5. When does loop auto-recover vs. need a human?

**Loop optimizes for forward progress on clear work. It pauses and tells you
when the work is ambiguous or the environment is broken — never guesses.**

"Auto-recovers" below means *within the run you started* — the next cycle of
that same `roll loop go` cleans it up. Nothing recovers after the run ends.

**Auto-recovers (no intervention needed):**

- Network timeout → retries with backoff (2s, 4s, 8s, 16s)
- Role candidate unavailable (no PATH / auth / network / account) or token
  exhausted → skipped for the current resolution and recorded as runtime health.
- Stale LOCK from a crashed process → next cycle cleans it up
- Orphan `🔨 In Progress` from a crashed cycle → next cycle reverts to
  `📋 Todo`

**Needs you:**

- No candidate remains for the required role → an ALERT is written and the loop
  stops. Fix env or narrow/update the role binding, then `roll loop resume`.
- CI persistently red → fix the failing test/build, then start a fresh
  `roll loop go`
- Merge conflict on PR → resolve manually, push
- `gh` auth expired → `gh auth login`
- Story keeps reverting (TCR commit count = 0 every attempt) → the story
  spec is likely unclear; rewrite ACs or run `$roll-build US-XXX` manually
  to see where it stalls

For deeper operational topics (pause/resume, agent switching, gh scopes), see
[loop.md](loop.md) and [configuration.md](configuration.md).

### C9. What does "sync: offline" mean on the dashboard?

**Symptoms:** The dashboard footer shows `sync: offline` or you're wondering
why `sync: not configured` appears when you haven't set up cross-machine sync.

**Why this matters:** The dashboard sync indicator tells you whether cycle
records from other machines are being merged into your local view.

**Under the hood:** When `roll_records_remote` is configured in
`~/.roll/config.yaml`, every cycle pushes its record to a shared git repo, and
the dashboard pulls from it before rendering. The indicator has three states:

- `sync: ok (2m ago)` — remote reachable, all machines' records merged
- `sync: offline` — remote unreachable (network issue, auth expired); showing
  local data only, other machines' cycles are invisible until connectivity
  returns
- `sync: not configured` — `roll_records_remote` is not set; sync is off by
  design, this is the normal state for single-machine use

**Fix for `sync: offline`:**

```bash
# Check connectivity to the records repo
ssh -T git@github.com           # or your git host

# Verify the remote is still accessible
git ls-remote $(roll config get roll_records_remote)

# If auth expired, re-authenticate
github.com → gh auth login
gitlab.com / self-hosted → check your SSH key

# The dashboard falls back to local-only data while offline —
# no data is lost, it just can't see other machines' cycles
# until connectivity is restored.
```

### C10. I ran roll-doc-audit — how do I know whether it did Phase 3a or Phase 3b?

**Symptoms:** You run `$roll-doc-audit` and want to know whether it stopped at the
directory-level fill (Phase 3a) or went on to the deep cross-directory read
(Phase 3b).

**Why this happens:** Phase 3a (the "Fill" phase) reads each gap directory in
isolation — up to 20 files per gap directory — and emits module READMEs.
Phase 3b ("Deep Read") only fires when the project has cross-directory
structure worth documenting: an import chain spanning ≥ 3 directories, a shared
`*State` / `*Status` enum, external endpoint calls, or a CI config file. A pure
docs-only project with no source gaps and no such characteristics skips
Phase 3b entirely.

**Read the Phase 4 report.** The end-of-run summary always prints both
sections:

```
Phase 3 — Fill
  2 drafts generated: [src/commands/README.md, docs/CONVENTIONS.md]
Phase 3b — Deep Read
  Symbol table: exports(42) imports(156) enums(7) external_urls(4) configs(3)
  2 topic documents generated:
    - docs/data-flows.md     (data-flow)   source entries: 6
    - docs/integrations.md   (external-integration) source entries: 4
```

If Phase 3b found nothing it prints exactly one line —
`Phase 3b: no subject-level drafts generated` — so the absence of any
`docs/data-flows.md` / `docs/state-machines.md` / `docs/integrations.md` /
`docs/deployment.md` output is the tell that only Phase 3a ran. Under
`--dry-run`, the same Phase 3b lines appear tagged `(plan)` and nothing is
written. Full breakdown: [roll-doc-audit.md](roll-doc-audit.md).


---

## Loop runs a cycle but the backlog appears empty

The loop picks stories from `.roll/backlog.md`. If the backlog looks empty
or shows no `📋 Todo` items, the most common causes:

**1. `.roll/` is out of date (new machine or OS reinstall)**

`.roll/` is a separate private git repo (`roll-meta`). After a fresh setup,
clone it manually and point the remote:

```bash
# Replace with your actual roll-meta repo URL
git clone git@github.com:your-org/roll-meta.git .roll
```

**2. SSH key not authorized**

```bash
ssh -T git@github.com   # should say "Hi <username>!"
```

If it fails, re-add your SSH key to GitHub.

**3. Check sync status**

```bash
git -C .roll remote get-url origin  # empty = sync disabled
git -C .roll log --oneline -3        # shows last synced commits
```

**4. Force a manual sync**

```bash
git -C .roll fetch && git -C .roll reset --hard origin/main
```

### C5. Why is this cycle running on `<agent>`?

**Symptoms:** you expected one agent, but the loop selected another.

**Why this happens:** Roll resolves a scoped role binding, not a hidden default.
The Builder comes from `story.execute`; review and scoring come from
`story.evaluate`. The binding can be inherited from Machine Scope
(`~/.roll/agents.yaml`) or declared in Project Scope (`.roll/agents.yaml`).

**Inspect:**

```bash
roll agent          # Machine Scope, Project Scope, resolved roles, pool health
roll agent list     # which agents this machine has installed
roll loop runs 20   # see recent cycle agents
```

If the selected candidate is unavailable because of auth, network, VPN, account,
or a missing binary, Roll skips that candidate for the current resolution and
records the runtime fact. It does not silently rewrite the static pool.

### C6. Why was my story flipped to 🚫 Hold instead of Done?

**Symptoms:** Backlog row shows `🚫 Hold → split to US-FOO-XXXa,US-FOO-XXXb`,
and there's an ALERT line about `self-downgrade` or `StorySplitCapHit`.

**Why this happens:** The agent's pre-flight self-check (in
`roll-build` / `roll-fix` SKILL) returned `verdict: too_big` — the story's
`est_min` exceeded the agent's capability range, OR `risk_zone` didn't match,
OR the agent's historical hit rate on that story type is below
`prefer_threshold` and there's downgrade budget left. The cycle then runs
`roll-design --from-story <id>` to write smaller sub-stories with
`chain_depth + 1`, flips the parent to 🚫 Hold, and exits cleanly.

The cap kicks in at `chain_depth ≥ 2` — the third consecutive auto-split is
refused (`StorySplitCapHit`) and ALERT is raised for you to triage manually.

**Fix:** Look at the sub-stories the agent created; they should be smaller and
should pass pre-flight on the next cycle. If you disagree with the split,
edit the sub-stories or flip the original back to 📋 Todo with a tighter
`est_min` / `risk_zone` profile.

### C7. How do I send feedback (bug / idea / UX) without leaving the terminal?

Use the smallest target for the feedback: `roll idea` for the local Roll
backlog, or `gh issue create` when it should become a GitHub issue.

```bash
roll idea "Safari login fails after redirect"
gh issue create --title "Login fails on Safari" --body "Repro: ..."
```

`roll idea` writes to the Roll backlog. `gh issue create` writes to GitHub
and can include the Environment section (roll version / OS / agent / language /
project). See [feedback.md](feedback.md) for the split path.

### C10. Where did my loop state / ALERT go after upgrading? (Phase 2.0)

**Short answer:** Into your project. Since Phase 2.0, a project's loop runtime
data lives at `<project>/.roll/loop/` instead of `~/.shared/roll/loop/`. Your
ALERT is now `<project>/.roll/loop/ALERT-<slug>.md`, state is
`state-<slug>.yaml`, run history is `runs.jsonl`.

**Do I need to migrate manually?** Only if you are upgrading from before this
move. Roll reads the project-local paths and nothing else — a cycle never
rewrites paths on the way in. To bring an old project across, copy
`state-<slug>.yaml`, `ALERT-<slug>.md`, `PAUSE-<slug>`, `mute-<slug>` and that
project's `runs.jsonl` rows into `<project>/.roll/loop/` by hand.

**Cleaning up debris:** `roll loop gc` retires orphan slugs (project deleted) and
sweeps expired `.migrated-*` markers, `runs.jsonl.tmp.*`, and old backups. Use
`roll loop gc --dry-run` to preview. Full details:
[Loop Data Layout](loop-data-layout.md).

### C11. How does Roll choose language for CLI, docs, and agents?

`ROLL_LANG=en|zh` pins the current process. `roll config lang en|zh` saves a
preference, and `roll config lang --reset` returns to locale detection.
`roll help --lang en|zh <topic>` is a one-off override for help and guide reads.

These controls apply to user-facing surfaces only. Agent contracts, code, git
metadata, and schemas remain English. Owner conversation follows the language
used by the owner in the current task. Run `roll doctor language` to audit docs,
conventions, skills, and generated surfaces before release.

### C12. What are the limits of `roll browser interactive`?

**Short answer:** It is a foreground, owner-run, single-operation tool against a
local Chrome debug endpoint — not a background automation or remote browser.

**Details:** `roll browser interactive` requires:

- An attached TTY and explicit owner approval for every operation.
- A Chrome you started yourself with a loopback debug port such as
  `--remote-debugging-port=9222` on `127.0.0.1`.

It will **never**:

- Run from a background scheduler or CI job.
- Connect to a remote or non-loopback endpoint.
- Export cookies, storage, or network bodies.
- Start Chrome automatically.
- Make CI pass on its own — the result is for **owner-run manual-attest** only.

The lease lasts at most 15 minutes and is released immediately after the
operation. For unattended diagnostics, use the managed lane (`roll browser run`)
instead.

### C13. A story is marked evidence-degraded — do I need to rebuild it?

**Short answer:** No. `degraded-infrastructure` means the code delivery passed
but the capture machine was broken (host / provider / tooling). Rebuilding the
story would fix nothing. Repair the evidence only:

```bash
roll capture repair <story-id>
```

**Details:** `roll capture repair` re-runs **only** the capture lanes and
re-resolves evidence health. It never reopens the build or the TCR cycle, and the
delivery verdict is carried through unchanged. It refuses (still without
rebuilding) for a failed delivery or any non-degraded state.

Check why capture is unavailable first:

```bash
roll doctor                 # "Capture policy readiness" section
roll capture status         # gateway + renderer readiness and effective policy
roll loop status --capture
```

If the v2 gateway reads `provider_v2_unavailable`, install/update Roll Capture.app
so it advertises `roll.capture.v2`. If the renderer is unavailable, run
`npx playwright install chromium`. A visual AC is satisfied by either a
**Roll Capture · physical** image or a target-bound **Playwright · rendered**
receipt — it does not require a physical image when a rendered receipt is bound
to the surface.

### C14. `roll capture migrate` says "retained" — why didn't it enable best_effort?

The migration is capability-aware and never guesses. It enables `best_effort`
only when **both** the v2 gateway and the renderer are ready. Otherwise it
retains your existing policy with an explicit reason: `provider_v2_unavailable`
(the capture host does not advertise v2) or `renderer_unavailable` (Playwright
Chromium is not installed). Fix the reported capability, then re-run — the
migration is idempotent, and `roll capture migrate --revert` reverses it.
