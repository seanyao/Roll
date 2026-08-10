# roll backlog sync — pull GitHub Issues into your backlog

`roll backlog sync` pulls issues from a GitHub repository and writes them
into your local `.roll/backlog.md`. It is single-direction
(issues → backlog) in v1: nothing is written back to GitHub.

`roll backlog sync` 把 GitHub Issues 拉进本地 `.roll/backlog.md`。

## Authentication

The sync resolves a GitHub token in this order:

1. `$GITHUB_TOKEN` — set it in your environment or CI secrets.
2. `gh auth token` — falls back to the GitHub CLI if you have run
   `gh auth login`.

If neither is available the command stops and tells you how to set one.

```bash
export GITHUB_TOKEN=ghp_xxx
# or, if you use the GitHub CLI:
gh auth login
```

## Quick start

```bash
# First sync must name the repo explicitly:
roll backlog sync --repo seanyao/roll-meta

# Preview without writing anything:
roll backlog sync --repo seanyao/roll-meta --dry-run

# Only pull issues carrying specific labels (OR semantics):
roll backlog sync --repo seanyao/roll-meta --label P1,bug

# After the first run the repo is remembered, so you can omit --repo:
roll backlog sync
```

## Flags

| Flag         | Notes |
|--------------|-------|
| `--repo`     | `owner/repo`. Required on the first sync; afterwards read from config. |
| `--dry-run`  | Compute the diff and print it, but leave `.roll/backlog.md` unchanged. |
| `--label`    | Comma-separated label filter. May repeat. Matches any (OR). |

## label → type mapping

The issue's labels decide the backlog type prefix. The first matching
label wins; with no match the default is `US`.

| GitHub label                | Backlog type |
|-----------------------------|--------------|
| `bug`                       | `FIX`        |
| `enhancement` / `feature` / `US` | `US`    |
| `refactor`                  | `REFACTOR`   |
| (no matching label)         | `US`         |

Issue state maps to the status column: `open` → `📋 Todo`,
`closed` → `✅ Done`. The issue title becomes the row description.

## IDs and idempotency

Each issue gets a stable backlog id `GH-<number>` (e.g. issue #13 →
`GH-13`), combined with the type prefix (`US-GH-13`, `FIX-GH-13`).

Sync is idempotent: a second run skips any issue whose id already exists
in `.roll/backlog.md` — it never overwrites the status or description of
an existing row, and prints `skipped (already exists): GH-13`. Each run
ends with a summary:

```
added: 2, skipped: 5, total issues: 7
```

`--dry-run` prints the same diff with `+` (would add) and `=` (would
skip) markers and never touches the file.

## Configuration: `.roll/local.yaml`

After a successful real sync the resolved repo, labels and timestamp are
persisted so later runs can omit `--repo`:

```yaml
backlog_sync:
  repo: seanyao/roll-meta
  direction: issues-to-backlog
  labels: []
  last_sync_at: 2026-05-28T10:00:00Z
```

| Field           | Meaning |
|-----------------|---------|
| `repo`          | Default `owner/repo` for flagless syncs. |
| `direction`     | Always `issues-to-backlog` in v1. |
| `labels`        | Default label filter; an explicit `--label` flag overrides it. |
| `last_sync_at`  | Timestamp of the last successful sync. |

An explicit flag always overrides the persisted config. If
`.roll/local.yaml` has no `backlog_sync:` block, the first sync must pass
`--repo`.

## Not in v1

Two-way write-back, Projects/Milestones mapping, PR linking, non-GitHub
platforms, and custom mapping rules are out of scope for v1.
