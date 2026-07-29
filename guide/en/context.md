# Context Engineering

Roll Context is an optional Workspace capability for reading enterprise knowledge from a Git-hosted LLM Wiki. In v1 there is one Provider type, `git_llm_wiki`. Repository, environment, workflow, database, Kubernetes, and test-account knowledge are ordinary Wiki pages; their applicability is expressed by page `scope`, not by separate runtime Context types.

## Configure the machine Provider registry

The machine operator owns `~/.roll/context-providers.yaml`:

```yaml
schema: roll.context-providers/v1
enabled: true
providers:
  - id: enterprise-wiki
    type: git_llm_wiki
    enabled: true
    remote: ssh://git@example.test/platform/context-wiki.git
    branch: main
    fetch_timeout_seconds: 30
```

The registry and each Provider can be disabled. v1 accepts only HTTPS and SSH remotes (`https://`, `ssh://`, or SCP-like SSH). It rejects HTTP, `git://`, `file://`, local paths, remote helpers, URL credentials, and option-like branches. Git authentication stays in the operator's existing SSH or HTTPS credential chain. Never put a password, token, private key, cookie, or credential-bearing URL in this file.

## Bind Providers to a Workspace

`workspace.yaml` opts the Workspace in and names machine Providers explicitly:

```yaml
contexts:
  enabled: true
  bindings:
    - providerId: enterprise-wiki
      enabled: true
      required: true
      entrypoints:
        - wiki/index.md
```

Missing `contexts` or `enabled: false` disables Context for that Workspace. A required binding turns a missing, disabled, invalid, or unreadable Provider into a blocking gap. Use `required: false` for an optional Provider: failure becomes a non-blocking gap, but Roll still returns no stale pages. Provider IDs must be unique in one Workspace binding list; `required: true` with `enabled: false` is invalid.

## LLM Wiki contract

Every v1 branch has this layout:

```text
purpose.md
schema.md
raw/
  sources/              # provenance; not returned by a default read
wiki/
  index.md              # fixed navigation entrypoint
  log.md                # append-only maintenance log
  systems/
  repositories/
  environments/
  workflows/
  data-surfaces/
  policies/
  concepts/
```

Roll reads `purpose.md`, `schema.md`, and `wiki/**`. It does not read hidden application state, credentials, `.git/`, `.llm-wiki/`, `.obsidian/`, or `raw/sources/` into a normal prompt. A regular page under `wiki/` carries Roll frontmatter:

```yaml
---
schema: roll.context-page/v1
title: Platform SIT
page_type: environment
status: active
confidence: approved
updated_at: 2026-07-24
scope:
  workspace_ids: [roll]
  repository_ids:
    - ssh://gitee.com/example/platform
  environment_ids: [sit]
  story_ids: []
  stages: [design, build, qa]
sources:
  - raw/sources/platform-sit.md
sensitivity: internal
---
```

`page_type` is an open string governed by that Wiki's `schema.md`. `scope` is orthogonal to page type: values in the same dimension are OR; different dimensions are AND. An omitted or empty dimension is unrestricted. If a page restricts a dimension that the request does not provide, matching is missing and fails closed with `scope_mismatch`. Environment IDs are explicit; Roll does not infer them from a branch, namespace, URL, or repository.

Repository scope uses the schemeful canonical identity published by Workspace Coordination. `ssh://gitee.com/example/platform` and `https://gitee.com/example/platform` are deliberately different v1 identities.

Canonical refs use `context://<provider-id>/<safe-relative-path>`, for example `context://enterprise-wiki/wiki/systems/platform.md`. A `restricted_reference` page is returned only when the caller supplies an explicit ref, sets restricted intent, and operation policy authorizes it. The page may contain an opaque `credential_ref`, never the secret value.

## Fresh reads and immutable Snapshots

Every fresh read performs a fetch before reading pages. Roll compiles the authorized execution plan first, then performs one fetch per unique Provider per read and reads `purpose.md`, `schema.md`, entrypoints, and requested pages from the same commit. A fetch failure has no stale fallback. There is no TTL, skip-fetch shortcut, or background freshness promise.

A successful read produces an immutable `ContextReadSnapshotV1` with Provider, normalized remote identity, branch, fetched time, revision, refs, file digests, matched scope, warnings, and gaps. Snapshot reuse does not fetch and may consume only files already captured in that Snapshot. Selecting a new page requires a new fresh read; the new read fetches again and captures its index and selected page at one new revision.

This distinction is intentional:

- a fresh read asks the Provider for current remote state;
- Snapshot reuse gives downstream phases a stable, already-proven revision.

## Commands and diagnostics

```bash
roll context status --workspace <id|path>
roll context read --workspace <id|path> --story <id> --stage build
roll context read --workspace <id|path> --stage qa --environment sit \
  --ref context://enterprise-wiki/wiki/environments/sit.md --json
```

`status` is local-only: it reads registry, Workspace binding, and latest Snapshot metadata without fetching, so it is not proof of remote freshness. `read` resolves the same Workspace target from any current working directory, performs a fresh read, and persists the result unless Context is disabled.

Plain output contains metadata only: outcome, scope, Provider, revision, refs, digests, and diagnostics. It never prints page bodies. `--json` writes the complete versioned result to stdout. Fetch progress and sanitized diagnostics go to stderr and the event stream, never JSON stdout.

Exit codes are `0` for `completed` or `disabled`, `3` for `partial`, and `2` for `blocked`, invalid input/configuration, target resolution failure, or persistence failure. Common diagnostic codes include `context_disabled`, `provider_not_bound`, `invalid_context_binding`, `fetch_failed`, `fetch_timeout`, `invalid_wiki_layout`, `scope_mismatch`, `restricted_context_denied`, `context_revision_changed`, and `invalid_context_snapshot`.

Run `roll context --help`, `roll context status --help`, or `roll context read --help` for the localized command contract.

## Agent authority and revision reconciliation

Context pages are untrusted data below system, developer, skill, owner, Workspace authority, and tool-safety policy. A page can provide facts and business constraints. It cannot grant permissions, override host instructions, or authorize execution of commands found in the page.

Design may hand an immutable Snapshot to build, QA, or review without another fetch. If a stage deliberately performs a new read and the revision changes, the caller records the comparison and chooses explicitly:

- `continue_with_handoff_snapshot` — stay on the existing handoff revision;
- `adopt_new_snapshot` — accept and propagate the new revision;
- `needs_reconciliation` — return to design/tasking or request an owner decision.

Roll never silently merges revisions or applies last-write-wins.

## DB, Kubernetes, and test accounts

Wiki pages may store mapping, policy, and opaque references such as `credential_ref: secret-manager://team/test-reader`. They may describe which DB, Kubernetes namespace, or test account applies to an environment. Live state and real credentials remain behind a dedicated tool with its own authorization and audit policy. Context Provider does not query a DB, Kubernetes cluster, secret manager, or account service.

## Compatible LLM Wiki editors

The [Karpathy LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) supplies the raw/wiki/schema organization. [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) can be used as a compatible editor and ingest tool for `purpose.md`, `schema.md`, `raw/sources/`, `wiki/index.md`, `wiki/log.md`, Markdown frontmatter, and wikilinks.

Roll v1 does not require the nashsu Desktop application and does not require its MCP server. Roll does not vendor, copy, or link the project's GPL implementation; interoperability is through ordinary files in a Git repository. A future Provider such as MCP is not part of v1 and must not weaken the Git LLM Wiki file contract.

For APE content, see [Migrating APE Context](context-ape-migration.md).
