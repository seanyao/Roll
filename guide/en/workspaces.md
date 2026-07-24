# Workspace-first delivery

A Workspace is Roll's local requirement, planning, execution and unified
delivery boundary. A repository is a code resource bound to that Workspace; it
is not the project identity and it is not a second Roll control plane.

One machine can keep multiple active Workspaces. Every mutating command resolves
exactly one target, while explicitly documented `--all` views remain read-only.

## Mental model

```text
Machine
├── Agent capabilities and capacity
├── Workspace registry
├── Shared repository caches
└── Workspaces
    ├── requirements + backlog
    ├── Story / Issue records
    └── runtime projections
```

The stable `workspaceId` is identity. The registry maps that ID to a canonical
path, so moving a Workspace changes location, not identity. There is no global
current Workspace and no singleton active slot.

Repository caches live at `~/.roll/repos/<repoId>.git`. They are disposable,
machine-shared bare caches. Deleting or rebuilding one must not change backlog,
Issue completion, merge evidence or integration acceptance.

## Create and activate a Workspace

Write one versioned `roll.workspace-create/v1` config outside the target root,
then preview the deterministic plan:

```bash
roll workspace create ws-payments --config /absolute/path/workspace-create.yaml --check --json
```

`--check` is read-only. It validates identity, root, requirement bindings,
repository remotes, aliases, integration branches, cache decisions and existing
content. Apply only the reviewed config:

```bash
roll workspace create ws-payments --config /absolute/path/workspace-create.yaml --json
roll workspace activate ws-payments
```

Creation writes the Workspace authorities and repository bindings. It
does not create a persistent product checkout. It also does not imply that the
Workspace is the command target: activation controls scheduler eligibility,
while each command still resolves its own target.

Inspect lifecycle state without mutation:

```bash
roll workspace list --all --json
roll workspace show ws-payments --json
```

## Command and selector aliases

`roll workspace` is the canonical command family. `roll ws` is one fixed alias
for the complete subtree, so `roll ws create`, `roll ws edit`, `roll ws issue
init` and every other public Workspace leaf execute the same operation. Likewise,
every public `--workspace <id|path>` selector accepts `--ws <id|path>`; for
example, `roll backlog --ws ws-payments` is identical to the canonical form.

Aliases are CLI spelling only. They never create a second command tree, change
`workspaceId`, alter configuration keys or establish a global current Workspace.
Help and machine-readable next actions continue to use `roll workspace` and
`--workspace` as the canonical spelling. Workspace creation has one lifecycle
entry: `roll workspace create`; the retired `init` subcommand is rejected with a create migration hint.

## Preview and apply metadata edits

Use a versioned edit config to add, remove or change Workspace metadata. Preview
first, then apply the same reviewed intent:

```bash
roll workspace edit ws-payments --config /absolute/path/workspace-edit.yaml --check --json
roll workspace edit ws-payments --config /absolute/path/workspace-edit.yaml --json
```

The preview includes manifest, result and reference digests. Apply acquires the
Workspace authority lock, reloads those facts and rebuilds the plan. A changed
manifest returns `manifest_changed`; a new durable reference that makes the edit
unsafe returns `metadata_referenced`; a changed result returns
`edit_plan_changed`. The transaction journals its before/after state and retries
idempotently. Recovery proceeds only when Roll can prove a safe before or after
state; otherwise it stops with a doctor action instead of guessing.

An edit atomically replaces `workspace.yaml` only. Existing Issue manifests,
worktrees, requirement revisions and delivery facts remain byte-stable: metadata
changes affect future Issues and never rewrite an Issue already created.

## Target resolution and fail-loud behavior

Workspace-aware commands accept `--workspace <id|path>` (or `--ws`). Resolution
first honors explicit, environment, reachable Workspace and Issue facts. When
those do not select a target, bounded discovery compares the current requirement
with registered canonical Workspace manifests and Issue facts. A single active
Workspace is only a lifecycle fact: it is never sufficient by itself when its
requirement does not match the current work.

Examples:

```bash
roll backlog --workspace ws-payments
roll loop status --workspace ws-payments
roll agent --workspace ws-payments
roll delivery list --workspace ws-payments
```

If two Workspaces are active and no stronger selector resolves the command,
Roll reports the candidates and exits non-zero. Conflicting explicit,
environment and cwd selectors also fail loud. Mutations such as `pause`,
`archive`, scheduler control and delivery reconciliation reject `--all`.

Exact Issue identity or a unique exact requirement source may select a target.
Repository/path containment and semantic similarity are ranking evidence only;
they cannot authorize mutation. A mismatch between a chosen Workspace and the
current requirement rejects mutation. Damaged discovery facts also fail closed
instead of falling back to the only active Workspace.

When an agent cannot determine the target, it hands the structured candidates to
`roll-.clarify workspace_target`. The skill summarizes the requirement, shows
lifecycle/evidence/diagnostics, asks whether to select an existing Workspace,
prepare a new one or repair discovery, and then stops. Selecting an existing
Workspace only causes the host to rerun resolution with an explicit selector.
Choosing create only authorizes collection of ID/config and a
`roll workspace create ... --check` preview; it does not authorize apply.
Choosing repair only displays canonical doctor/repair commands. Direct CLI TTY
interaction renders the same closed decision without pretending to load a skill.

Interaction and output format are separate. `--no-input` is always
non-interactive; `--interactive` requires a usable controlling TTY or an agent
host that can ask questions; otherwise Roll returns `interaction_unavailable`.
`--json` does not enable or disable prompting: prompts go to stderr/TTY, while
stdout remains one JSON result. Success exits `0`; selection, conflict,
activation/create requirements and other structured failures exit `1` with a
stable `error.code` and, in non-interactive JSON mode, the clarification payload.

Planning and delivery commands use the selected Workspace as their only
project-data authority. They can run from an arbitrary directory without
creating `<cwd>/.roll`:

```bash
roll story new US-PAY-102 --title "Retry refund" --epic payments --workspace ws-payments
roll idea "improve refund diagnostics" --workspace ws-payments
roll design "split refund recovery" --workspace ws-payments
roll attest US-PAY-102 --workspace ws-payments
roll capture status --workspace ws-payments --json
roll truth query US-PAY-102 --workspace ws-payments --json
```

These commands and their internal view refresh read or write `backlog/index.md`,
`features/`, `policy.yaml`, `evidence/`, `runtime/` and the derived `index.json`
under the canonical Workspace. A mutation fails closed when its required
authority is missing or has the wrong type; it never falls back to creating a
new `.roll` tree. Symlinked authorities or internal mutation paths are rejected
before Roll reads or writes through them. A legacy `.roll` project is migration input only; Roll never
writes both layouts.

`roll idea` writes the Story card and a canonical linked backlog row, so the
result is immediately readable with `roll backlog show <ID> --workspace ...`.
Imported backlog links that still start with `.roll/features/` are resolved
read-only against canonical `features/`; the backlog is not silently rewritten.

## Requirement and Issue layout

A requirement revision is captured before execution and remains attributable to
its provider reference and digest. A Story contract in `backlog/` becomes one
Issue when execution starts:

```text
<workspace>/
├── requirements/<provider>/<requirement>/
├── backlog/.../<storyId>/spec.md
└── issues/<storyId>/
    ├── manifest.json
    ├── events.ndjson
    ├── <repoAlias>/
    ├── artifacts/
    └── evidence/
```

Create or repair repository worktrees only through the Issue command:

```bash
roll workspace issue init US-PAY-101 --workspace ws-payments --check --json
roll workspace issue init US-PAY-101 --workspace ws-payments --json
```

Writable code exists only in `issues/<storyId>/<repoAlias>/` worktrees. A
read-only repository target can provide context without becoming a required
delivery leg. A partial setup failure rolls back clean new state and does not
spawn a Builder.

For a multi-repository Issue, repository operations must name or inherit one
repository binding from the frozen Issue context. They never pick the first
repository. Bash may default only when exactly one writable worktree exists;
filesystem writes stay inside writable bindings, and Git still requires an
explicit cwd that matches a declared Issue worktree. Missing or ambiguous
repository context returns `missing_execution_context` rather than using the
process cwd.

## One Story, independent repository facts

Story and Issue are the unified delivery unit. Roll does not introduce a
Delivery Set, a Workspace-level codebase, or a superproject to make unrelated
repositories appear physically atomic.

Each required repository independently records:

- its governed branch and TCR commits;
- provider PR state and required CI checks;
- the authoritative merge commit.

The Issue is delivered only when every required repository is merged and the
integration command passes against the exact merged SHAs. A single merged PR,
a local branch, a worktree, a green unit test or a backlog `Done` claim is not
enough.

Use the shared Issue fold:

```bash
roll delivery show US-PAY-101 --workspace ws-payments
roll delivery reconcile US-PAY-101 --workspace ws-payments --dry-run --json
roll delivery reconcile US-PAY-101 --workspace ws-payments
```

`roll delivery reconcile` folds Issue events and provider/main facts, refreshes
the Requirement attest projection, and then updates backlog as a projection. It
never treats backlog Markdown as completion truth. `roll loop reconcile` is an
alias over the same fold, not a second parser.

## Local-only campaign gate

For a campaign that must finish local acceptance before any external mutation,
configure the dedicated integration branch with `publish_mode: local`. This
mode runs the same local evidence gate and lands commits on the configured local
integration branch; it does not push branches or open a PR. Keep the gate in
place until all dependent Stories and the requirement-level critical flow pass
on one exact integration-branch SHA. Switching back to `remote` is a separate
owner-approved publication decision.

## Mandatory historical migration

A repository-local `.roll/` is historical input, not a second supported runtime
mode. Do not initialize a competing Workspace over it. First stop active
runtime, make product Git clean and remotely reachable, then collect a read-only
plan:

```bash
roll workspace migrate --from . --check
roll workspace migrate --from . --workspace ws-payments --check --json > workspace-migration-plan.json
```

Migration fails loud for dirty or unpushed product Git, an in-flight Git
operation, unsafe linked worktrees or recursive submodules, active runtime,
symlinks under `.roll`, unverifiable remote truth, or cache/registry conflicts.

If `.roll` is tracked by the product repository, remove exactly the planned
paths through the normal reviewed TCR/PR/push cutover. Apply then proves the
dedicated cutover commit is remotely reachable and that every saved digest still
matches. Ordinary tracked metadata leaves `.roll/RELOCATED.json` so the old
path cannot silently continue as a repository-local runtime.

Apply the exact owner-saved plan:

```bash
roll workspace migrate --from . --workspace ws-payments --plan workspace-migration-plan.json
```

The transaction writes its journal before side effects, maps requirements,
design, backlog and evidence directly into the Workspace, creates or reuses only
the machine bare cache, verifies digests, and registers/activates last. It never
creates a Workspace-level product checkout. Before registration, `--rollback`
can restore atomically moved source files.

If `.roll` is an independent Git repository, Roll copies the mapped content but
does not link, commit or push that repository. The command prints a
manual roll-meta handoff for the owner-approved metadata workflow.

## Diagnose and recover

```bash
roll workspace doctor ws-payments --json
```

Doctor reads registry/manifest consistency, cache identity, Requirement
projections and archive trust, Issue journals/worktrees, runtime locks and
machine capacity. Diagnosis is read-only. Only one named typed repair is allowed
per invocation; provider facts, immutable Requirement archives and Issue
completion evidence are never invented or deleted.

## Context policy and compatibility matrix

Every registered CLI, skill and tool operation declares its Workspace scope,
selector support, authority access and context consumer. `machine_only`
operations receive no fabricated Workspace context. `legacy_migration_only`
operations may inspect an explicitly selected historical project layout but may
not dual-write it with canonical Workspace authority. All other required scopes
must receive the selected, validated execution context before running.

The generated [Workspace context compatibility matrix](../../docs/generated/workspace-context-compatibility-matrix.json)
is the stable operation-level inventory. For each CLI leaf, skill family and tool
adapter it records the scope, selector behavior, legacy boundary, authority and
context consumer, with executable validation-case links. Release consistency
fails when the registry, generated matrix, validation cases or source audit drift.

See [configuration](configuration.md), [Workspace doctor](workspace-doctor.md),
[the loop](loop.md), and [historical migration](legacy-onboarding.md) for the
detailed supporting contracts.
