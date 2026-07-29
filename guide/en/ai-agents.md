# Roll — AI Agent Support

Roll treats AI agents as a scoped pool of execution identities. The current
model is:

```text
Scope -> Role -> Binding -> Agent -> optional Model
```

The same shape repeats at every level. A machine can declare the agents it has,
a project can bind roles for its work, and a story or skill can narrow those
bindings when needed.

## Agent-Domain Files

- `~/.roll/agents.yaml` is Machine Scope. It declares the local agent pool and
  machine-level roles such as `supervise`.
- `.roll/agents.yaml` is Project Scope. It binds project/story roles such as
  `supervise`, `execute`, and `evaluate`.

`~/.roll/config.yaml` may still exist for generic preferences and legacy
migration input, but it is no longer the primary authoring surface for agent
semantics. Use:

```bash
roll agent                      # show Machine Scope, effective Project Scope, and installed pool
roll agent migrate --dry-run    # preview conversion from legacy files
roll agent migrate              # write roll-agents/v1 files
roll agent list                 # show installed agents
```

## Roles

Roll uses three core Agent-domain roles:

- `supervise` — coordinates at project level. In guided mode this may be the
  current agent session you are talking to; in autonomous mode Roll resolves the
  role and drives the loop.
- `execute` — builds or fixes a story through the selected skill workflow.
- `evaluate` — reviews, scores, or checks the delivery in a fresh session.

**Who played each role in a finished cycle?** After a cycle runs, the resolved
roles are not a mystery you have to reconstruct from logs. Run
`roll loop cycle <id> --roles` to see exactly who was Builder and who was Evaluator,
which peers were consulted, and which single score the gate accepted. The same
cast is written to `summary.md` / `summary.json` and embedded in the story's
Execution Cast report block. See
[Cycle Role Visibility](./loop.md#cycle-role-visibility) for the full surface.

Project defaults normally bind story roles:

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

Machine scope can declare a supervisor and the local pool:

```yaml
schema: roll-agents/v1
scope: machine
agents:
  codex:
    capabilities: [supervise, execute, evaluate]
  kimi:
    capabilities: [execute, evaluate]
roles:
  supervise:
    use: codex
```

## Fair Eligibility

Static config lists fair candidates. It should not permanently exclude a
supported agent because of an old auth, VPN, account, or network incident.
Runtime health is checked when Roll resolves or spawns the role:

- unavailable candidates are skipped for the current resolution;
- the skip is recorded as a runtime fact;
- the static pool remains fair until you intentionally narrow it.

Unknown or unregistered agent names fail loud during config parsing.

`health-aware` is the selection strategy for open role casting. It keeps the
same installed pool visible for Designer, Builder, Evaluator, and Peer Reviewer
unless an owner policy narrows the pool, then ranks candidates with recent
health signals, role capability tags, successful deliveries, recent use, and
cost band. A degraded candidate stays visible with warnings, but a healthy
candidate with the right capability wins. A cheap weaker agent can remain
eligible for focused work while ranking lower for broad or high-risk Builder
work.

Use the route trace when you need to see the cast instead of guessing:

```bash
roll supervisor route --role builder --story US-123
roll supervisor route --role evaluator --story US-123 --json
```

The trace lists every candidate, eligibility, score reasons, warnings, skipped
runtime facts, selected agent, strategy, and source binding.

## Guided vs Autonomous Mode

In guided mode, you can keep working in the current agent window. That session
acts as the supervisor front door: it can inspect `roll agent`, run migrations,
and ask Roll to continue through the CLI.

In autonomous mode, you do not open multiple agent windows manually. The loop
resolves `supervise`, `story.execute`, and `story.evaluate`, then spawns fresh
agent sessions for the roles through the configured bindings.

## Supported Agents

| Agent | CLI command | Notes |
|-------|-------------|-------|
| Claude Code | `claude` | Anthropic coding agent. |
| Kimi CLI | `kimi-code` (legacy: `kimi-cli` / `kimi`) | Moonshot coding agent. |
| Codex CLI | `codex` | OpenAI coding agent; `openai` aliases to `codex`. |
| Antigravity | `agy` | Google Antigravity agent; legacy `gemini` aliases to `agy`. |
| Pi | `pi` | The `deepseek` alias resolves to `pi`. |
| Reasonix | `reasonix` | DeepSeek-native coding agent; requires `DEEPSEEK_API_KEY`. |
| Cursor | `cursor-agent` | Cursor headless agent; day-one usage is recorded as `?` until parseable token/cost output is available. |

Agent-specific behavior belongs in one profile, not in downstream runner gates:

1. Add the public registry entry in `packages/core/src/agent/specs.ts`.
2. Add or update the runner profile in `packages/cli/src/runner/agent-spawn.ts`.
3. Keep executor, attest, pairing, and scoring code agent-agnostic.
4. Add unit coverage for the profile and registry entry.

## Agent Toolchain Health (US-V4-022)

Supervisor treats agent toolchain health as part of coordination, not as an
owner-side mystery. It scans warnings, auth/network status, polluted skill
roots, stale setup sync, and worktree permission failures, then classifies them
into one of four operational categories:

- **auth_block** — "403", "please run /login", "Unauthorized" → `pause_for_owner`
- **network_block** — `ECONNREFUSED`, `ETIMEDOUT`, DNS failure → `continue`
  (transient; loop retries or breathes)
- **setup_skill_root_pollution** — Reasonix auxiliary-dir warnings, skills with no
  description → `create_fix` → routed to the delivery team as a FIX
- **worktree_permission_failure** — `EACCES` / "permission denied" on a worktree
  path → `pause_for_owner`

When the signal is setup/skill-root pollution, Supervisor must **not** label it
as auth-blocked. It routes the repair to the backlog/delivery team as a FIX,
instead of asking the owner to debug ad hoc. Supervisor coordinates and
diagnoses these issues but does not become the Builder or Evaluator, and it does
not auto-delete global files.

```bash
roll supervisor health             # human-readable health board
roll supervisor health --json      # machine-readable classifications
roll supervisor next               # next card + agent health summary
```

## Migration from Older Agent Config

Older projects may contain `.roll/local.yaml agent`, `.roll/pairing.yaml`, or v3
route slots in `.roll/agents.yaml`. These are not runtime inputs. Run
`roll agent migrate --dry-run` to preview their one-time conversion, then
`roll agent migrate` to write scoped bindings. A loop that encounters v3 route
slots fails loudly instead of silently using a second configuration model.

## Delta Team & Full Delta Team

Roll separates two named delivery topologies. Do not conflate them, and do not
confuse either with the health-remediation **delivery team** (the FIX-routing
target above).

- **Delta Team** (ordinary, host-guided) is the *current host main session*
  acting as the **implicit Supervisor**, plus **host-native sub-agent sessions**
  for the Designer, Builder, and Evaluator roles. The host (Pi, Cursor, …)
  requests and attests those sub-agents through its own facility; Roll never
  spawns, resumes, or configures any session, including yours. Roll only manages
  the protocol — evidence frames, schema validation, events, projections, and
  fail-closed gates — through `roll delta`.
- **Full Delta Team** is an *independently orchestrated* multi-agent / multi-host
  topology. It shares the same protocol but launches distinct role sessions
  through Roll's generic agent adapters. Independent agents/hosts are never
  described as an ordinary Delta Team.

Roles hand off through named, checksummed artifacts and the event stream — never
raw chat. The Builder is the sole worktree writer; Designer, Evaluator, and Peer
are read-only except for their own artifact directory. Peer is optional advisory
input to the Evaluator, never a substitute for it.

**Honest boundaries — these are stated by the protocol and must not be
overclaimed:**

- **Terminal binding is Option C, handoff-only.** A structurally valid Evaluator
  report reaches only `delta:terminal(handoff_ready)`. That is **not** Done, a
  merge, an attest verdict, or a DeliveryRecord. After `handoff_ready`, the owner
  **manually** runs the existing delivery/PR/attest procedure; Roll auto-binds
  nothing and makes no delivery/Done claim. The sole Done terminal remains the
  Story path (accepted evidence via `roll attest`; delivery reconciled from a PR
  merged into `main`).
- **Host attestation is structural validation only.** `roll delta validate`
  checks that the host-supplied tokens (`hostId`, `roleInstanceId`, `sessionId`,
  `modelId`) are non-empty, unique where required, and correspond across
  resolution/event/manifest. It **never** proves that a fresh session was
  created, that the stated role/model was honored, or that any model executed.
- **Local preset is host-local config.** Composition preferences live in
  `~/.roll/delta-team/presets.yaml` (machine-local), never in project config,
  `.roll/agents.yaml`, `.roll/policy.yaml`, or `@roll/core`.
- **Host-guided cost is unobservable.** Status renders `? (host_unobservable)`;
  Roll never estimates, prices, or emits zero for host-guided sub-agent work.

**Every delegation has a Supervisor.** A loop is a chain of cycles running inside
a host session — it has a main session and full sub-agent capability, exactly like
a delivery you drive by hand. There is a single trigger axis value and no
admission prohibition: solo, Delta Team, and Full Delta Team are all available to
a loop. See the `roll-delta-team` skill for the full procedure.

## See Also

- [configuration.md](configuration.md) — config and policy files
- [pairing.md](pairing.md) — evaluate-role review and scoring
- [loop.md](loop.md) — autonomous role resolution
