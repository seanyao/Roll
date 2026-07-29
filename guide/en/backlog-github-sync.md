# roll backlog sync — pull GitHub Issues into a Workspace backlog

`roll backlog sync` pulls GitHub Issues into one resolved Workspace. It writes
planning artifacts only and never writes back to GitHub.

The command resolves its target from `--workspace <id|path>` (or `--ws`), the
standard Workspace environment, reachable Workspace/Issue context, or an exact
requirement match. Active lifecycle alone never selects a mismatched Workspace.
Ambiguous, conflicting, incomplete-discovery, legacy-repository, or
out-of-Workspace targets fail before any file is written. `--all` is read-only
and is rejected for sync.

## Authentication

The sync resolves a GitHub token in this order:

1. `$GITHUB_TOKEN` from the environment or CI secrets.
2. `gh auth token` after `gh auth login`.

If neither is available, the command stops with setup guidance.

## Quick start

```bash
# First sync for this Workspace must name the GitHub repository.
roll backlog sync --workspace ws-product --repo seanyao/roll-meta

# Preview without writing planning artifacts.
roll backlog sync --workspace ws-product --repo seanyao/roll-meta --dry-run

# Pull issues carrying any listed label.
roll backlog sync --workspace ws-product --repo seanyao/roll-meta --label P1,bug

# Later runs reuse this Workspace's saved repository.
roll backlog sync --workspace ws-product
```

When the current directory already identifies the Workspace, `--workspace` may
be omitted.

## Workspace-owned artifacts

| Artifact | Workspace path |
|---|---|
| Planning index | `backlog/index.md` |
| Imported Story contract | `backlog/backlog-lifecycle/<STORY-ID>/spec.md` |
| Sync configuration | `runtime/backlog-sync.yaml` |

These paths cannot be overridden with legacy `--backlog`, `--features`, or
`--local-yaml` flags.

## Flags

| Flag | Notes |
|---|---|
| `--workspace` | Workspace ID or absolute path. Uses the canonical resolver when omitted. |
| `--repo` | `owner/repo`. Required on the first sync for each Workspace. |
| `--dry-run` | Prints the planned add/skip result without writing Workspace artifacts. |
| `--label` | Comma-separated label filter. May repeat; matching uses OR semantics. |

## Planning identity and status

The first recognized label selects the Story type:

| GitHub label | Story type |
|---|---|
| `bug` | `FIX` |
| `enhancement`, `feature`, `US` | `US` |
| `refactor` | `REFACTOR` |
| no recognized label | `US` |

Issue #13 therefore becomes one canonical Story ID such as `FIX-GH-13`. The
same ID appears in the index link, contract directory, contract heading, and
command output, so `roll backlog show FIX-GH-13` opens the generated contract.
If labels change later, the durable planning ID is preserved.

GitHub state does not decide Roll planning completion. New open or closed Issues
enter the backlog as `📋 Todo`; an existing planning status is never overwritten
by sync. Delivery completion remains governed by Roll delivery truth.

Sync is idempotent by GitHub issue number. A later run skips an existing Story
and reports its durable full ID:

```text
skipped (already exists): FIX-GH-13
added: 0, skipped: 1, total issues: 1
```

## One GitHub source per Workspace

The first successful sync binds the Workspace to one GitHub `owner/repo` source
in `runtime/backlog-sync.yaml`. Later explicit values must identify the same
repository; a different source fails before fetching or writing. Owner and
repository name comparison is case-insensitive.

```yaml
backlog_sync:
  repo: seanyao/roll-meta
  direction: issues-to-backlog
  labels: []
  last_sync_at: 2026-07-21T10:00:00Z
```

Each Workspace owns its own source binding and sync timestamp.

## Not supported

Multiple GitHub issue sources in one Workspace, two-way write-back, Projects or
Milestones mapping, PR linking, non-GitHub providers, and custom mapping rules
are outside this command.
