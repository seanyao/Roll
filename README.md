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
[![npm version](https://img.shields.io/npm/v/@bipo-ape/roll.svg)](https://www.npmjs.com/package/@bipo-ape/roll)
[![CI](https://github.com/BIPOSVC/ape-roll/actions/workflows/ci.yml/badge.svg)](https://github.com/BIPOSVC/ape-roll/actions/workflows/ci.yml)

Roll — a Supervisor-led CLI harness that routes AI agents through story-scoped planning, building, evaluation, git, CI, and acceptance evidence. Works with Claude, Cursor, Codex, Kimi, Pi, Reasonix, and other local rigs when they are available.

## Install

```bash
npm install -g @bipo-ape/roll
```

Roll is published under two equivalent names: `@bipo-ape/roll` (use this) and
`@seanyao/roll` (the original scope, kept working for existing installs). Both
ship the identical artifact at the same version — installing or updating from
either gets you the same `roll`.

Requirements: Node.js ≥ 22. Roll is a self-contained TypeScript CLI — no runtime engine beyond node.
On macOS, npm installation also tries to install `Roll Capture.app` from the
latest `seanyao/roll-capture` GitHub Release into `~/Applications` so physical
screenshots can run. If the release is private, the installer first tries
anonymous GitHub access, then retries with `GITHUB_TOKEN`/`GH_TOKEN` or
`gh auth token` when available; credentials are used only in request headers.
GitHub requests respect `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` when Node exposes
the matching fetch dispatcher. CI, headless sessions, non-macOS hosts,
sudo/root shells, offline downloads, or `ROLL_SKIP_CAPTURE_INSTALL=1` skip this
step without failing install; when skipped under sudo/root, re-run `roll setup`
as a regular user so the app installs into that user's `~/Applications`.
`roll setup` and `roll doctor tools` report the same readiness and repair path.
To update an already installed Capture.app, run `roll setup --update-capture`.
It shows the installed version, available release, and destination first, then
replaces the app only when you enter `y`; use `--yes` only for intentional
non-interactive automation. A refusal, failed download, or failed replacement
keeps the existing app intact.

## Use

```bash
cd your-project
roll init           # set up Roll here (interactive confirmation)
roll next           # continue with design, apply, repair, migrate, loop, or status
roll loop go        # let AI work through the backlog in this session
```

`roll init` first diagnoses the current directory. Complete Roll projects get
`Already initialized` and `Next: roll status`; partial Roll projects get
`roll init --repair`, while pre-2.0 layouts get migration guidance without writing files. Existing codebases route to
`$roll-onboard`. PRD/docs-only workspaces are treated as new projects: Roll writes
`.roll/brief.md` from the detected document and points to
`roll design --from-file <detected-doc>`.
Empty directories ask what you are building in an interactive terminal; in scripts
and CI, plain `roll init` is read-only and `roll init --auto` writes a placeholder
brief before pointing to `roll design`.
For existing-codebase grafts, `roll init --apply` validates the generated
artifacts, prints a review checkpoint with every planned file operation, and
waits for owner confirmation before writing. Automation must use
`roll init --apply --auto` after that review.
After any init path, `roll next` is the continuation button: it reads the same
brief, onboard plan, backlog, and Roll markers, then prints one best next
command instead of a menu.
When `roll init` writes Roll-owned meta files inside a git worktree, it also
adds, commits, and pushes those files to `origin` when possible, then prints the
commit/push result. Product files you created yourself are not included in that
finalization commit.
First time through? Start with [Getting started](guide/en/getting-started.md).

## Language Surfaces

Roll renders one visible language per user surface. `ROLL_LANG=en|zh` pins the
current process, `roll config lang en|zh` persists a preference, and
`roll config lang --reset` returns to locale detection. `roll help --lang en|zh`
is available for one-off guide/help reads, and `roll doctor language` audits
docs, conventions, skills, and generated surfaces for mixed-language drift.

Agent contracts, code comments, git metadata, and TypeScript identifiers stay in
English as the harness contract layer. Owner conversation follows the owner's
language. User docs live in separate locale files under `guide/en/` and
`guide/zh/`; contributors should update the matching locale file or i18n catalog
instead of placing translation pairs in the same rendered surface. Snapshot
coverage for the current language controls lives in
`packages/cli/test/cli-language-surface.test.ts`,
`packages/cli/test/__snapshots__/cli-language-surface.test.ts.snap`, and
`packages/cli/test/doctor-language.test.ts`.

## V4 Supervisor Execution

Roll V4 separates project coordination from story delivery:

- **Supervisor** coordinates at project level: backlog order, cross-Story context, route advice, repeated failures, release readiness, budget, and owner escalation. It observes and advises; it does not implement a Story or override evidence gates.
- **Delta Unit** delivers one Story through scoped roles: `design` produces the Designer contract when the profile needs it, `execute` performs the Builder work, `evaluate` reviews/scores evidence, and `supervise` coordinates above the Story boundary.
- **supervise / design / execute / evaluate roles** are stable contracts. The concrete `agent` and optional `model` are resolved through the Agent Scope model: `Scope -> Role -> Binding -> Agent -> Model`.
- **Skills remain** the capability layer. Roles invoke `$roll-design`, `$roll-build`, `$roll-fix`, `$roll-peer`, `$roll-.qa`, and related skills instead of rewriting those contracts into TypeScript.
- **Fallback is fail-loud**. If a requested agent or rig is unavailable, Roll records that unavailability and pauses or asks for owner action; it does not silently pretend another agent was used.

### Delta Team & Full Delta Team

Two named delivery topologies, distinct from each other and from the
health-remediation **delivery team** (the FIX-routing target):

- **Delta Team** (ordinary, host-guided) is the *current host main session*
  acting as the **implicit Supervisor**, plus **host-native sub-agent sessions**
  for the Designer, Builder, and Evaluator roles, driven through `roll delta`.
  The host requests and attests those sub-agents itself; **Roll never spawns,
  resumes, or configures any session**, including yours.
- **Full Delta Team** is an *independently orchestrated* multi-agent / multi-host
  topology that shares the same protocol but launches distinct role sessions
  through Roll's generic adapters.

**Builder preflight comes after the Builder's final green TCR commit and before
its one formal Builder validate.** It is a read-only, repairable self-check: it
writes no lifecycle success and does not prove that a model executed. A red
preflight is repaired in the same frame, then the Builder runs a green preflight
before formal `roll delta validate --stage builder --preflight-receipt <path>`.
The formal validation remains fail-closed and is not replaced by preflight; the
independent Evaluator still reviews the formally validated handoff.

If an old delivery was explicitly put on hold but its still-live reservation
was historically renamed to a successor, the owner may use the deliberately
narrow `roll delta recover-held` command. It requires repeating the old
delegation id as confirmation, records that recovery without rewriting history,
and still requires that exact named successor to run the ordinary continuation
pickup. It is not a general release or takeover command.

#### Local exact-model rig readiness

Before asking a host to resolve a Delta role, inspect its machine-local
diagnostic with `roll delta rigs`. This ordinary read only renders the most
recent complete local observation: it does not start a model, write a snapshot,
or change a workspace, lease, dispatch, resolution, or event. Use
`roll delta rigs --refresh` only when you want bounded probes of every exact
configured `{adapter, cliModelId}` and publication of one complete new local
snapshot.

For example, a configured Codex candidate is probed with its exact local model
mapping (equivalent to `codex exec --model <cliModelId> ...`), not Codex's
default model. A missing executable is shown as **blocked** with an installation
action; an adapter without a verified safe exact-model noninteractive selector
is also **blocked** and is not executed. **Unknown** includes stale or
incompatible cache, timeout, unverified token output, and unclassified failure;
refresh after fixing the actionable condition.

Output follows one language per process: `ROLL_LANG` is the one-process
override, then `roll config lang` is the persisted preference, then `LC_ALL`,
`LANG`, and English. A `ready` observation means only that this exact model
returned the fixed minimal token at that observation time. It never proves a
future long task, delivery, host-session freshness, or final role assignment;
pins, exclusions, tags, cost caps, and role diversity still make the real
allocation decision.

Honest boundaries the protocol states and never overclaims:

- **Terminal binding is Option C, handoff-only.** A valid Evaluator report reaches
  only `delta:terminal(handoff_ready)` — not Done, a merge, an attest verdict, or
  a DeliveryRecord. The owner then **manually** runs the existing
  delivery/PR/attest procedure; Roll auto-binds nothing. Done still comes only
  from a PR merged into `main`.
- **Host attestation is structural validation only** — non-empty/unique opaque
  tokens that correspond across resolution/event/manifest. It never proves a
  fresh session, honored role/model, or actual model execution.
- **Local preset** (`~/.roll/delta-team/presets.yaml`) is host-local config, never
  project config.
- **Host-guided cost is `? (host_unobservable)`** — never estimated, priced, or
  zeroed.
- **`roll delta metrics` is read-only.** It derives counts, timing, TCR facts,
  redelegation, and rig diversity from immutable event and delivery records.
  Its window and percentile samples are shown explicitly; missing or
  contradictory facts stay marked incomplete rather than becoming a zero or a
  success. It never selects a model, changes backlog order, or merges a PR.
  See the [delivery metrics dictionary](guide/en/delivery-metrics.md) for every
  Delta and Supervisor source fact, denominator, time boundary, and unknown
  behavior.

Every delegation has a Supervisor: a loop is a chain of cycles running inside a
host session, so it has a main session and full sub-agent capability like any
other delivery. There is one trigger axis value and no admission prohibition —
any topology (solo / Delta Team / Full Delta Team) is available to a loop. See
the `roll-delta-team` skill and
[guide/en/ai-agents.md](guide/en/ai-agents.md) for the full procedure.

### Supervisor backlog-clearing standard

When the owner asks Roll to clear a backlog, Supervisor treats the scope as every
live non-Hold `FIX-*`, `US-*`, and `REFACTOR-*` row unless the owner narrows it.
Before scheduling another card it reconciles backlog status, open PRs, recent
cycle endings, CI/evaluator gates, manual-merge PRs, and `.roll` meta state.
Each card gets its own Builder and, when required by the execution profile, an
independent Evaluator/Scorer selected from the current Agent roster. Repeated
failure, zero TCR, missing PR/CI/evaluator evidence, parser failures, auth
blocks, permission blocks, and `[roll:manual-merge]` PRs stop new scheduling and
surface an owner action through `roll supervisor status/next/why`.

### How work is driven

Roll has one way to drive delivery, over the same backlog, truth, route profile,
execution profiles, evidence, Evaluator, and release gates:

- **The session drives.** The owner reads `roll supervisor status/next/why` and
  starts work in that session with `roll loop go` (optionally `--epic <name>` or
  `--cards <id>`). The agent session running it is the Supervisor. Nothing
  advances on its own — no timer, no resident process.
- **Pause stops autonomous progress.** `roll loop pause` stops cards from being
  picked; `roll loop resume` clears it. The correction circuit breaker also pauses
  automatically after repeated failures, so `resume` is the supported way back.
  An explicit one-shot (`roll loop go --cards <id>`) still runs while paused.

- **Attest and evidence are story-scoped**. A Story is accepted through its own Acceptance Review Page (`latest/<id>-review.html`), AC map, and screenshots/test artifacts. `latest/<id>-report.html` remains a legacy alias for one release cycle.

Agent bindings are declared in two files: `~/.roll/agents.yaml` for Machine Scope
and `.roll/agents.yaml` for Project Scope. A Project can inherit the machine pool
and bind Story roles:

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

Runtime availability is explicit: if a candidate is not callable on the current
machine because of auth, network, VPN, or account state, the current resolution
records that limitation instead of rewriting the static pool.
For open role casting, `strategy: health-aware` keeps the installed pool visible
and ranks candidates by capability, recent health, successful deliveries, recent
use, and cost band. Inspect a cast with
`roll supervisor route --role builder --story <id> [--json]`; the trace lists
every candidate, warnings, skipped facts, reasons, and the selected agent.

## Onboarding Samples

**Zero-start project**

```bash
mkdir my-product && cd my-product
roll init
# In an interactive terminal, describe the requirement, point to a PRD,
# or let Roll write .roll/brief.md from detected notes.
roll next
roll design --from-file .roll/brief.md
roll loop go
```

Roll explains the next design step instead of inventing fake work. The Designer turns the requirement into Stories, the Supervisor chooses `standard`, `verified`, or `designed` execution, and the owner reviews story-scoped attest evidence.

**Existing project**

```bash
cd existing-codebase
roll init
roll next
roll init --apply        # after reviewing the generated onboard plan
roll loop go
```

Roll diagnoses the repository without destructive migration, writes or updates Roll metadata only after review, and then lets the Supervisor reason over existing backlog, docs, context, open PRs, and scoped role bindings. Current state is visible through CLI-first observability: `roll status`, `roll loop watch`, `roll loop runs`, `roll loop cycle <id>`, `roll loop alert`, and story reports.

## Quick start for new projects

A new project needs a remote before the loop can push branches and open PRs:

```bash
cd your-project
roll init
# 1. Create a GitHub repository for the project and add it as `origin`
# 2. Push the current branch so the loop has somewhere to land work
git push -u origin main
# 3. Drive the backlog from this session
roll loop go
```

`roll loop go` will fail fast with an alert if the repository is missing or
unreachable, so it never burns agent tokens against a broken push target.  If
you need to stop the loop, `roll loop pause` persists a pause marker; resume
with `roll loop resume` when ready.

## Commands

| Command | Description |
|---------|-------------|
| `roll agent [migrate\|list\|cast]` | Agent Scope, installed-agent inventory, and role casting |
| `roll backlog [sync\|block\|defer\|lint\|…]` | View, manage, lint, and sync pending tasks |
| `roll config [lang\|prices\|tune\|…]` | Read/write configuration, model prices, and suggest-only tuning |
| `roll design [--from-file <path>] [--agent <name>] [--verbose\|--raw]` | Launch `$roll-design` with bounded live progress, handoff, and an optional `roll loop go --review auto` continuation when new Todo cards are created |
| `roll doctor [skills\|tools\|language\|repair-protection]` | Diagnose install health, skills, tools, permissions, language drift, and stale main-checkout write protection |
| `roll help [--lang en\|zh] [name]` | View built-in Charter / guide docs; `roll --help` prints CLI usage |
| `roll idea [--type us\|fix\|idea] "<one-sentence description>"` | Capture a backlog card; use `--type us` when a new user story mentions a failure it will prevent |
| `roll init` | Diagnose this directory and route setup/onboarding |
| `roll loop <on\|off [--all]\|go\|watch\|runs\|cycles\|cycle\|alert\|…>` | Run, observe, stop, and maintain the autonomous executor |
| `roll next` | Continue init/onboard with one best next command |
| `roll north [--json] [--no-color]` | North-star terminal panel for autonomy, delivery rate, fix tax, and attribution errors |
| `roll release [--dry-run\|--showcase]` | Release planning/flow plus golden-path showcase support |
| `roll setup [-f\|--force] [--reselect] [--no-capture-install]` / `roll setup --update-capture [--yes]` / `roll setup skills\|offboard` | Install/sync conventions, safely update Roll Capture.app after explicit confirmation, repair readiness, or remove Roll-owned project artifacts |
| `roll status [ci\|pulse] [--json]` | Project health, CI state, and delivery pulse |
| `roll test [--where] [--reset]` | Run tests through the isolation adapter |
| `roll update` | Upgrade the global Roll install and re-sync conventions |
| `roll --version` / `roll -v` | Print installed roll version |

Retained support surfaces live under their owners: `roll config prices`, `roll config tune`,
`roll agent cast`, `roll doctor tools`, `roll status ci`, `roll status pulse`,
`roll loop cycles`, `roll loop cycle`, `roll release showcase`, and `roll setup offboard`.
Historical top-level aliases for those capabilities now return the standard
unknown-command response.

## Observability Now

Roll's current observability is CLI-first. Persistent facts flow through one
read path: anchors -> selectors -> adapter -> projections. `roll status`,
`roll loop watch`, `roll loop runs`, `roll loop cycle <id>`, `roll status pulse`, and
story-scoped attest reports are the current user-facing truth surfaces.
Role and collaboration visibility are part of that same surface: `roll loop cycle <id> --roles`,
`roll loop cycle <id> --collab`, `roll loop cycle --legend`, `roll supervisor live --collab`,
and the Execution Cast report block expose selected/returned/accepted role outcomes.
The archive rebuild is an on-demand archive and repair renderer for static HTML pages;
it is not the active delivery truth surface.

- `roll status` starts with a compact North Star line. Read it as the same four
  `roll north` metrics in one row: autonomous runtime, delivery rate, fix tax,
  and attribution errors. A dot shows each metric's current state.
- `roll north` expands those readings into a 14-day panel. Targets are
  autonomous runtime >=72h, delivery rate >=60%, fix tax <1x, and attribution
  errors =0. The anti-gaming rules are part of the metric: an effective
  autonomous day needs at least 6 non-idle attempts, backlog-empty days pause
  the autonomy clock instead of counting against it, fix tax divides FIX work
  by US delivery only, and `unknown` attribution is not guessed. `null` means no
  usable data yet; the panel prints the reason.
- A backlog row is a claim; merge evidence on `main` and recorded acceptance
  evidence are truth. A premature `✅ Done` claim is shown as drift.
- Failures are attributed as `env`, `harness`, `card`, or `unknown`. Repeated
  non-card root causes pause dispatch by root cause and write a diagnostic
  snapshot with a playbook. When you see dispatch paused, read the snapshot,
  repair the environment or Roll component named there, then resume. If a card
  was parked because old env/harness failures polluted skip accounting, use
  `roll loop pardon-skip-list [--dry-run] [--include-unknown]` to rebuild the
  skip list from runs and events.
- Builder cycles keep the main checkout physically read-only while the Builder
  runs. Dirty or ahead changes that leak into the main checkout are quarantined
  onto `rescue/leaked-*` refs with a manifest under `.roll/loop/quarantine/`.
  The manifest names the files and includes the restore command to claim the
  rescued work.
- Cycle history is read through the TerminalOutcome vocabulary, not legacy
  free-form summary text.
- Missing facts render as `?`. A visible `0` means a known zero, not unknown.

Evidence gates are strict for merge. `attest render` failure, dangling
`ac-map.json` paths, `claimed` AC statuses, and a non-exempt visual card with no
captured screenshot can block merge. PR bodies carry a `Roll-Evidence` trailer
so reviewers can jump to the story evidence. Run `roll attest audit [--json]`
to find dangling evidence references and `evidence_debt` rows. See
[Acceptance evidence](guide/en/acceptance-evidence.md) and
[Loop failure handling](guide/en/loop.md#failure-attribution-and-pauses).

Visual evidence is **best-effort**: a visual AC is satisfied by either a
**Roll Capture · physical** image or a target-bound **Playwright · rendered**
receipt — a physical image is not the only thing that can satisfy it. Evidence
health is one of four states: `verified`, `degraded-infrastructure` (capture
machine broken — published, marked degraded, **never rebuilt**), `invalid-target`
(blocks), or `absent-contract` (blocks). Receipts never include credentials,
cookies, DOM, or network bodies, capture is window-scoped, and `ROLL_NO_SCREENCAP`
bans only the runner's native path. Enable best-effort with the capability-gated,
reversible `roll capture migrate`; repair a degraded record without reopening the
build via `roll capture repair <story-id>`; and check readiness with `roll doctor`
or `roll capture status`.

Behavior Roll cannot prove locally — a real `npm i -g github:...`, a published
CLI's first run, a live OAuth callback — must declare an `external-smoke` or
`owner-attested` verification path. The attest report shows an **Outward
verification** banner: only a real smoke pass (or valid owner attestation) is
green; `verified-in-simulation` (e.g. `npm pack`) and `UNVERIFIED — external
smoke not run` are never green, so acceptance cannot overstate outward behavior.
No real publish or account action ever runs without a declared authority. See
[Outward behavior verification](guide/en/acceptance-evidence.md#outward-behavior-verification).

`roll supervisor live` is the shipped CLI-first multi-role board. Alongside the
role panes it renders one shared DeliveryRun projection for ordinary cycles,
host Delta, Full Delta, and Skill dispatch: workspace reservation/lifecycle,
Delta handoff state, merge truth, evidence truth, and an explicit recovery
reason remain separate. Missing or legacy facts render as unknown; a
`handoff_ready` row is never presented as delivered. The board supplies its
clock and concrete read-only worktree-audit member checks to the shared adapter:
only a registered, inactive, expected-HEAD, clean member set with confirmed
merge and accepted evidence can render `delivered_safe_to_release` — before
release, never after it. It prints a one-frame
snapshot for scripts and quick inspection; `roll supervisor live --watch` keeps
the same board open and redraws it in-place from the same event-backed view
model. A browser/TUI Supervisor Live Console remains future work and must reuse
that view model.

`roll supervisor metrics [--json]` is the companion read-only flow projection.
It derives per-card and aggregate queue, dependency, first-action, merge, PR/CI,
and reconciliation lag from the event ledger. Its terminal output names the
observation window, sample sizes, `nearest-rank` percentiles, and every missing
upstream fact; JSON preserves the same uncertainty. Dependency wait keeps
blocked-by-not-Done separate from satisfied-but-not-dispatched. A
`handoff_ready` fact remains a handoff only — it is never a Delivered claim.
The [delivery metrics dictionary](guide/en/delivery-metrics.md) and its
[Chinese counterpart](guide/zh/delivery-metrics.md) also document the causal
limits of attempt outcomes and why a missing artifact is not evidence about a
model invocation.

All Roll-owned delivery workspaces live under `.roll/loop/worktrees/` as one
managed WorkspaceSet per DeliveryRun; submodule worktrees are explicit members.
`handoff_ready` preserves its Story reservation and workspace and is never
Delivered/Done. Only a confirmed merge, accepted attest, and fresh clean,
registered, inactive all-member inspection make a run eligible for release.
Start recovery with `roll worktree audit` and `roll supervisor live`; cleanup is
dry-run-first and refuses stale, unknown, dirty, external, or unregistered
members. Legacy `.worktrees/*` and `../wt-*` checkouts are external/manual:
Roll shows them but never adopts or deletes them automatically.

## Rules registry and doc-drift

[`policy/rules.yaml`](policy/rules.yaml) is the single machine-readable authority
for registered redlines, the doc-drift mode, and source-to-documentation mappings.
The README, guides, verification notes, and generated
[responsibility maps](docs/maps/) explain that registry; they do not declare a
second policy. `node scripts/audit-rules.mjs` reports that the **registered N**
rules are live. It is not a claim that every possible repository rule has already
been registered.

The current `doc_drift: soft` mode is registry-driven and observable: a declared
source surface changed without its declared documentation emits a diagnostic, but
the soft hit exits 0. There is no exemption path. The named CI check is likewise
advisory for manual GitHub UI merges in this repository shape; CI records its
result but does not create Roll events or authenticate a merge decision.

Hard doc-drift enforcement is **not enabled**. Enabling it needs a trusted owner
authorization and calibration design first. A peer session, an interactive TTY,
or an `actor` field is not owner authentication and must not be presented as one.

## Repository layout

Dev side — a pnpm monorepo. Publish side — one npm package.

```
packages/      TypeScript engine (pnpm workspaces): spec · core · infra · cli · web
lib/           Runtime companions (prices snapshots, i18n catalog)
skills/        Git submodule → seanyao/roll-skills (the agent skill contracts)
conventions/   Conventions synced into AI clients by `roll setup`
template/      Project scaffolding installed by `roll init`
```

Build & test: `pnpm install && pnpm -r test`.

Published as a single npm package `@bipo-ape/roll`: `dist/` (the CLI bundled to one self-contained ESM by esbuild) + `lib/` + `skills/` + `conventions/` + `template/`.

## Documentation

| | |
|---|---|
| **Start here** | [Getting started](guide/en/getting-started.md) · [Overview & architecture](guide/en/overview.md) · [Engineering methodology](guide/en/methodology.md) |
| **Daily driving** | [The loop (autonomous executor)](guide/en/loop.md) · [Tools & policy](guide/en/tools.md) · [Browser operations (managed + interactive lanes; optional diagnostics are opt-in only)](guide/en/browser-operations.md) · [External page acquisition (`roll-browse`)](guide/en/skills.md#roll-browse--external-page-acquisition) · [Configuration](guide/en/configuration.md) · [Pricing & cost](guide/en/pricing.md) · [FAQ](guide/en/faq.md) |
| **Quality machinery** | [Acceptance evidence (`roll attest`)](guide/en/acceptance-evidence.md) · [Evidence lifecycle](guide/en/acceptance-evidence.md#lifecycle-in-three-stages) · [Consistency & release gate](guide/en/consistency.md) · [Cross-agent pairing](guide/en/pairing.md) · [Peer review](guide/en/peer.md) · [Test isolation](guide/en/test-isolation.md) |
| **Under the hood** | [Architecture: layers · domain · invariants](docs/architecture.md) · [Verification system](docs/verification.md) · [Manifesto](docs/manifesto.md) |

Full guide index: [guide/en/](guide/en/) — agents, peer review, feedback, backlog sync, adoption patterns, and more.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, test setup, and PR conventions.

## Security

See [SECURITY.md](SECURITY.md). Please report vulnerabilities privately, not through public issues.

## License

[MIT](LICENSE)
