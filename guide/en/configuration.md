# Roll — Configuration

Roll resolves three environment variables at startup. Override any of them
before running `roll` to change where it looks for state, skills, and
shared conventions.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ROLL_HOME` | `~/.roll` | Per-user state root. Holds `config.yaml`, installed `skills/`, synced `conventions/`. |
| `ROLL_CONFIG` | `$ROLL_HOME/config.yaml` | Editor, loop/dream/brief schedule hours, and per-tool (`ai_*`) config. Agent routing is **not** here — it lives in per-project `.roll/agents.yaml` (see [ai-agents.md](ai-agents.md)). |
| `ROLL_GLOBAL` | `$ROLL_HOME/conventions/global` | Global convention files (`AGENTS.md`, `CLAUDE.md`, etc.) synced into AI tool directories. |
| `ROLL_LANG` | unset | Per-process language override for CLI/help/HTML user surfaces. Supported values are `en` and `zh`; when unset, Roll uses the saved config preference or locale detection. |
| `ROLL_HEARTBEAT_TIMEOUT` | `1800` (seconds) | How long without a heartbeat write before the loop runner treats an inner cycle as orphan and heals state. Raise it if your cycles can legitimately stay quiet longer than 30 minutes. |
| `ROLL_LOOP_FORCE` | unset | When set to any non-empty value, marks the run as interactive, so a cycle prints readable text instead of a JSON stream. Nothing sets it for you — export it yourself when you want that output. It no longer bypasses anything: the active-window check went with the resident scheduler, and PAUSE is bypassed only by `roll loop go --cards <id>`. |
| `ROLL_LOOP_NO_HEAL` | `0` | Set to `1` to disable post-build CI self-heal and restore fail-fast behaviour. Useful for debugging or when you want to cap autonomous spend per cycle. |
| `ROLL_LOOP_HEAL_MAX` | `2` | Maximum number of CI self-heal attempts per story after the build commits land. Raise it for noisy CI environments; lower it to fail faster. |
| `ROLL_PR_MERGE_TIMEOUT` | `600` (seconds) | **Deprecated (US-AUTO-044).** The main loop no longer waits for merge; the Delivery Reconciler advances eligible PRs opportunistically. |
| `ROLL_LOOP_NO_POPUP` | unset | When set to any non-empty value, the runner does **not** auto-spawn a macOS Terminal.app window running `tmux attach`. For tests and headless batch runs — the popup outlives the killed tmux session and clutters the desktop. |
| `ROLL_LOOP_GC_RETENTION_DAYS` | `30` | Override the GC retention period for `roll loop gc`. Takes precedence over `loop_gc.retention_days` in `.roll/local.yaml`. |
| `ROLL_FEED_BUDGET_BYTES` | `16384` | Byte budget for the context feed handed to the inner agent each cycle. Set it to a positive integer to dial the feed to the inner agent's capacity; non-numeric or non-positive values fall back to the default. |
| `ROLL_AGENT_NUDGE` | `1` (on) | Compatibility agent preference switch. The scoped role binding is the primary selector; set this to `0` (or `off`/`false`/`no`) to disable legacy history preference. |
| `ROLL_SKIP_CAPTURE_INSTALL` | unset | Set to `1` to skip the best-effort macOS `Roll Capture.app` install during npm postinstall and setup repair. |
| `ROLL_RUN_DIR` | unset | Canonical acceptance-evidence run directory. The loop runner sets it before agent spawn; `roll attest --run-dir` and standalone `roll attest` can also consume it. |
| `ROLL_EVIDENCE_DIR` | derived from `ROLL_RUN_DIR` | Directory for raw command/test artifacts inside the open evidence frame. Normally set by the runner or `roll test`, not by hand. |
| `ROLL_SCREENSHOTS_DIR` | derived from `ROLL_RUN_DIR` | Directory for visual proof inside the open evidence frame. Normally set by the runner or capture lane, not by hand. |

`ROLL_CONFIG` and `ROLL_GLOBAL` derive from `ROLL_HOME`, so usually you only
need to override `ROLL_HOME` to relocate everything together.

## Common Overrides

Pin roll's state to a project-local directory (useful for CI, tests, or
isolated experimentation):

```bash
export ROLL_HOME="$PWD/.roll-sandbox"
roll setup
roll loop now
```

Run roll against an alternate convention set without touching `~/.roll`:

```bash
ROLL_GLOBAL=/path/to/team-conventions roll init
```

Point `ROLL_CONFIG` at a one-off config file to test changes:

```bash
ROLL_CONFIG=/tmp/test-config.yaml roll status
```

## Language Selection

Language has two controls:

- `ROLL_LANG=en|zh` overrides the language for the current process and wins over
  saved config.
- `roll config lang en|zh` saves the preference in Roll config;
  `roll config lang --reset` clears it so locale detection applies again.

`roll help --lang en|zh <topic>` is a one-command override for help and guide
reads. `roll doctor language` audits active docs, conventions, skills, and
generated surfaces for mixed-language drift. The expected CLI language snapshots
are maintained in `packages/cli/test/cli-language-surface.test.ts` and
`packages/cli/test/__snapshots__/cli-language-surface.test.ts.snap`; the audit
surface is covered by `packages/cli/test/doctor-language.test.ts`.

User-facing surfaces still render one visible language at a time. Agent
contracts, code, git metadata, and stable schema keys remain English.
Owner-facing conversation follows the language the owner uses in the current
task.

## Project Policy

Project-local safety policy lives in `.roll/policy.yaml`. The acceptance
evidence gate defaults to `hard`: a delivered story with ACs needs a fresh,
contentful attest report before it can be marked `✅ Done`.

```yaml
loop_safety:
  attest_gate: hard
```

Use `attest_gate: soft` only for an explicit migration window. Soft mode keeps
the audit trail and alert, but it does not block the delivery cycle.

Automatic card picking also has an advisory semantic ranking layer. It is on by
default and can be disabled explicitly:

```yaml
pick:
  semantic_ranking: off
```

When enabled, Roll asks the default agent to rank the current candidate backlog
only when the backlog/candidate hash changes, caches the result in
`.roll/loop/pick-ranking.json`, and then still applies the normal picker gates.
If the agent times out or returns bad JSON, Roll records `harness_failure` and
falls back to the deterministic order.

## Verifying

`roll status` prints the resolved paths so you can confirm overrides took
effect. Invoke the `roll-doctor` skill (`$roll-doctor`) to diagnose
directory structure issues under the resolved `ROLL_HOME`.

## Agent Installation

Install the agent CLI, then declare or bind it through the scoped agent files:
`~/.roll/agents.yaml` for Machine Scope and `.roll/agents.yaml` for Project
Scope. For example:

- Codex CLI: `npm install -g @openai/codex`
- Antigravity CLI: `npm install -g @antigravity/agy`

Run `roll agent` to inspect the effective scopes, or `roll agent migrate
--dry-run` to convert legacy agent config. See [ai-agents.md](ai-agents.md) for
the full model and supported agent list.

## See Also

- [overview.md](overview.md) — three-layer model, BACKLOG priority
- [loop.md](loop.md) — `roll loop` subcommands
- [ai-agents.md](ai-agents.md) — supported AI agents
