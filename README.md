# Roll

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@seanyao/roll.svg)](https://www.npmjs.com/package/@seanyao/roll)
[![CI](https://github.com/seanyao/roll/actions/workflows/ci.yml/badge.svg)](https://github.com/seanyao/roll/actions/workflows/ci.yml)

Roll is a Supervisor-led CLI for story-scoped AI delivery. Open any supported agent; that session is the Supervisor.

## Install

```bash
npm install -g @seanyao/roll
```

Node.js >= 22.

## How to Play

```bash
roll init
roll next
roll supervisor next
roll loop go
```

- `roll init` prepares the project.
- `roll next` gives one best next command.
- `roll supervisor next` lets the current agent session choose the next card.
- `roll loop go` drives a continuous backlog run from that session.
- `roll delta` delivers one Story through host-native sub-agents.

Existing codebase? Review the plan first with `roll init --apply`.

`roll loop pause` stops card pickup; `roll loop resume` reopens it. Nothing runs on a timer, and no run starts that you did not start.

## Core Mechanism

- **Human** owns the backlog, PR review, and release approval.
- **Supervisor** is the agent session you are in.
- **Delta Unit** delivers one Story through `Designer`, `Builder`, and `Evaluator` roles as host-native sub-agents, using `standard`, `verified`, or `designed` profiles.
- **Skills** provide `$roll-design`, `$roll-build`, `$roll-fix`, `$roll-peer`.
- **Evidence** is story-scoped: attest, AC map, tests, and captured artifacts.

## Commands

`roll agent`, `roll backlog`, `roll config`, `roll design`, `roll doctor [skills\|tools\|language\|repair-protection]`, `roll help`, `roll idea`, `roll init`, `roll loop`, `roll next`, `roll north`, `roll release`, `roll setup`, `roll status`, `roll test`, `roll update`.

Daily surfaces: `roll supervisor next`, `roll supervisor live`, `roll supervisor delivery <feature-id|card-id>`, `roll loop go/pause/resume/status/watch/cycles/cycle/alert`, `roll delta prepare/validate/conclude/rigs --refresh`, `roll loop cycle <id> --roles`, `roll loop cycle <id> --collab`, `roll loop cycle --legend`, `roll supervisor live --collab`, Execution Cast.

## Operational Notes

- Evidence lifecycle: `roll attest audit`, `evidence_debt`, `Roll-Evidence`, `claimed` ACs, `rescue/leaked-*`, `.roll/loop/quarantine`.
- Metrics: 72h autonomy, >=60% delivery rate, fix tax, attribution errors, non-idle, backlog-empty, `env/harness/card/unknown`, unknown is not guessed, `pardon-skip-list`, diagnostic snapshot.
- Rules: `policy/rules.yaml`, `policy/rules-inventory.yaml`, never a keyword-search completeness claim, `US-RULE-006` Hold requires trusted owner and is not enabled, `doc_drift: soft` is advisory.
- Language: `ROLL_LANG`, `roll config lang`, `roll doctor language`, one visible language, Agent contracts, `packages/cli/test/cli-language-surface.test.ts`, `packages/cli/test/__snapshots__/cli-language-surface.test.ts.snap`, `packages/cli/test/doctor-language.test.ts`.
- Delta: after the Builder's final green TCR commit, preflight is read-only and does not prove that a model executed.

#### Local exact-model rig readiness

`roll delta rigs --refresh` probes every exact configured `{adapter, cliModelId}` and publishes one complete local snapshot. It is read-only, never uses the default model, and does not change dispatch, allocation, or resolution.

Honest boundaries

## Docs

- [Getting started](guide/en/getting-started.md)
- [Overview](guide/en/overview.md)
- [AI agents](guide/en/ai-agents.md)
- [Loop](guide/en/loop.md)
- [Acceptance evidence](guide/en/acceptance-evidence.md)

## License

[MIT](LICENSE)
