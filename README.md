# Roll

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@seanyao/roll.svg)](https://www.npmjs.com/package/@seanyao/roll)
[![CI](https://github.com/seanyao/roll/actions/workflows/ci.yml/badge.svg)](https://github.com/seanyao/roll/actions/workflows/ci.yml)

Roll is a Supervisor-led CLI for story-scoped AI delivery. It turns a backlog into planning, implementation, review, CI, and acceptance evidence, routes the work through the agents available on your machine, and keeps a human in control of releases and architectural decisions.

## Install

```bash
npm install -g @seanyao/roll
```

Requirements: Node.js >= 22.

On macOS, npm installation also tries to install `Roll Capture.app` from the latest `seanyao/roll-capture` release for physical screenshots. Set `ROLL_SKIP_CAPTURE_INSTALL=1` to skip that step.

## Quick Start

### New project

```bash
mkdir my-product && cd my-product
roll init
roll next
roll loop go
```

`roll init` diagnoses the directory. `roll next` prints one best next command. `roll loop go` starts a session-driven run that picks cards from the backlog and delivers them one at a time.

### Existing codebase

```bash
cd existing-codebase
roll init
roll next
roll init --apply    # review the onboarding plan before writing
roll loop go
```

The loop needs a reachable Git remote so it can push branches and open PRs. Pause autonomous card pickup with `roll loop pause`; resume with `roll loop resume`. An explicit one-shot still works with `roll loop go --cards <id>`.

## Core Mechanism

Roll separates project coordination from Story delivery:

- **Human**: owns the backlog, reviews PRs, and approves releases.
- **Supervisor**: coordinates at project level. It reads backlog, CI, PR, evidence, and failure state, then advises the next action. It does not implement a Story or override evidence gates.
- **Delta Unit**: delivers one Story through the stable roles `Designer`, `Builder`, and `Evaluator`, using the `standard`, `verified`, or `designed` execution profile.
- **Skills**: roles invoke `$roll-design`, `$roll-build`, `$roll-fix`, `$roll-peer`, and related skills instead of reimplementing those workflows.
- **Evidence**: each Story is accepted through its own attest evidence, AC map, tests, and captured artifacts.

The role model is `Scope -> Role -> Binding -> Agent -> optional Model`. Machine scope lives in `~/.roll/agents.yaml`; project scope lives in `.roll/agents.yaml`.

### Session-driven execution

Work only starts when you run `roll loop go` in a session. There is no timer or resident scheduler. `roll loop pause` gates automatic card pickup; `roll loop resume` reopens it. A run may continue in its detached tmux worker after your window closes, but no run starts that you did not start.

### Fail-loud routing

If a requested agent or rig is unavailable, Roll records that unavailability and pauses or asks for owner action. It does not silently pretend another agent was used.

## Observability

Current truth is CLI-first:

```text
roll status
roll north
roll loop watch
roll loop runs
roll loop cycle <id>
roll loop alert
roll supervisor live --collab
```

Cycle and collaboration visibility is available with `roll loop cycle <id> --roles`, `roll loop cycle <id> --collab`, `roll loop cycle --legend`, and the Execution Cast report block.

For a feature or card delivery conclusion, use `roll supervisor delivery <feature-id|card-id> [--json]`. It is a read-only view: one card has one final delivery conclusion, missing history stays unknown instead of becoming a zero or a success, and it cannot route an agent, retry work, change backlog, merge a PR, or attest a card.

The unified delivery view is the primary surface. `roll delta metrics` remains a retained Delta-only detail dictionary.

### Evidence lifecycle

See [Evidence lifecycle](guide/en/acceptance-evidence.md#lifecycle-in-three-stages). Evidence is collected during execution, verified against acceptance criteria, and attached to the Story before merge. Merge gates check `attest render`, `ac-map.json`, `claimed` ACs, visual evidence, and `evidence_debt`. Run `roll attest audit [--json]` to inspect evidence health. PR bodies carry a `Roll-Evidence` trailer.

Builder cycles keep the main checkout read-only. Leaked dirty or ahead work is quarantined on `rescue/leaked-*` refs with a manifest under `.roll/loop/quarantine/`.

Failure attribution is `env/harness/card/unknown`. Repeated non-card failures pause dispatch and write a diagnostic snapshot with a playbook. Rebuild polluted skip accounting with `roll loop pardon-skip-list`.

## Safety Boundaries

- Done means a PR merged into `main` with accepted evidence. Release approval stays human.
- Missing facts render as `?`; a visible `0` is a known zero, not unknown.
- `roll north` targets are 72h autonomous runtime, >=60% delivery rate, fix tax <1x, and zero attribution errors. Effective autonomous days need non-idle attempts; backlog-empty days do not count against the clock. `unknown` is not guessed.
- Hard doc-drift enforcement is **not enabled**. `doc_drift: soft` is advisory.

### Delta rig readiness

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

### Feature delivery view

To see how a feature or a single card actually delivered, run
`roll supervisor delivery <feature-id|card-id> [--from <ISO>] [--to <ISO>] [--json]`.
It is one read-only view: one card has one final delivery conclusion, every
attempt stays visible under that card, timing/TCR/rework numbers show their
sample size, and missing history stays incomplete (`?` / `n/a`) rather than a
zero or a success. It cannot route an agent, retry work, change the backlog,
merge a PR, or attest a card. See the
[delivery metrics dictionary](guide/en/delivery-metrics.md) for the worked
example and the exact source facts.

Honest boundaries

### Delta Builder preflight

The Builder runs a read-only preflight after the Builder's final green TCR commit, before its one formal Builder validate. A red preflight is repaired in the same frame, then the Builder runs a green preflight before formal `roll delta validate --stage builder --preflight-receipt <path>`. Preflight does not prove that a model executed and does not replace the independent Evaluator or the formal fail-closed validation.

## Rules and Doc Drift

`policy/rules.yaml` is the machine-readable authority for registered redlines, doc-drift mode, and source-to-documentation mappings. `policy/rules-inventory.yaml` is the audited coverage predicate: coverage is that predicate plus its exclusions, never a keyword-search completeness claim.

The current `doc_drift: soft` mode emits diagnostics and exits 0; it is advisory for manual GitHub UI merges. Hard enforcement is not enabled. Flipping to hard is tracked as `US-RULE-006` and is on **Hold**: activation requires trusted owner authorization and calibration design first. A peer session, interactive TTY, or `actor` field is not trusted owner authentication.

## Language

Each user surface renders one visible language. Use `ROLL_LANG=en|zh` for a process, `roll config lang en|zh` for a persistent preference, and `roll doctor language` to audit drift.

Agent contracts, code comments, git metadata, and TypeScript identifiers stay in English. User docs live under `guide/en/` and `guide/zh/`. Snapshot coverage for the current language controls lives in `packages/cli/test/cli-language-surface.test.ts`, `packages/cli/test/__snapshots__/cli-language-surface.test.ts.snap`, and `packages/cli/test/doctor-language.test.ts`.

## Commands

| Command | Description |
|---------|-------------|
| `roll agent [migrate\|list\|cast]` | Agent scope, installed-agent inventory, and role casting |
| `roll backlog [sync\|block\|defer\|lint\|…]` | View, manage, lint, and sync pending tasks |
| `roll config [lang\|prices\|tune\|…]` | Read/write configuration, model prices, and suggest-only tuning |
| `roll design [--from-file <path>] [--agent <name>] [--verbose\|--raw]` | Launch `$roll-design` with bounded live progress and handoff |
| `roll doctor [skills\|tools\|language\|repair-protection]` | Diagnose install health, skills, tools, permissions, language drift, and stale main-checkout protection |
| `roll help [--lang en\|zh] [name]` | View built-in Charter and guide docs |
| `roll idea "<one-sentence description>"` | Capture and classify a backlog card |
| `roll init` | Diagnose this directory and route setup/onboarding |
| `roll loop <go\|watch\|runs\|cycles\|cycle\|alert\|…>` | Run, observe, stop, and maintain session-driven execution |
| `roll next` | Continue init/onboard with one best next command |
| `roll north [--json] [--no-color]` | North-star terminal panel for autonomy, delivery rate, fix tax, and attribution errors |
| `roll release [--dry-run\|--showcase]` | Release planning and consistency flow |
| `roll setup [-f\|--force] [--reselect] [--no-capture-install]` | Install/sync conventions and repair readiness |
| `roll status [ci\|pulse] [--json]` | Project health, CI state, and delivery pulse |
| `roll test [--where] [--reset]` | Run tests through the isolation adapter |
| `roll update` | Upgrade the global Roll install and re-sync conventions |
| `roll --version` / `roll -v` | Print installed roll version |

## Repository Layout

```text
packages/      TypeScript engine (spec · core · infra · cli · web)
lib/           Runtime companions (prices, i18n catalog)
skills/        Git submodule -> seanyao/roll-skills
conventions/   Conventions synced by roll setup
template/      Project scaffolding installed by roll init
```

Build and test with `pnpm install && pnpm -r test`.

## Documentation

- [Getting started](guide/en/getting-started.md)
- [Overview](guide/en/overview.md)
- [AI agents and role routing](guide/en/ai-agents.md)
- [The loop](guide/en/loop.md)
- [Acceptance evidence](guide/en/acceptance-evidence.md)
- [Delivery metrics](guide/en/delivery-metrics.md)
- [Architecture](docs/architecture.md)

Full guide index: [guide/en/](guide/en/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately.

## License

[MIT](LICENSE)
