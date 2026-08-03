# Workspace Doctor

`roll workspace doctor <id>` diagnoses one registered Workspace without writing. It checks the registry and manifest, shared repository caches, Requirement projection and archive trust, Issue journals and worktrees, Workspace runtime locks, and machine capacity leases.

```bash
roll workspace doctor ws-payments
roll workspace doctor ws-payments --json
```

Every finding has one status:

- `healthy`: no operator action is required.
- `repairable`: Roll can restore technical state with the emitted typed action.
- `blocked`: ownership, schema, or liveness facts are insufficient; the owner must resolve them.
- `data_loss_risk`: repair could affect dirty, unpushed, conflicting, or corrupt evidence, so Roll refuses to write.

Evidence paths are Workspace- or Roll-home-relative. Remote URLs, credentials, hostnames, PIDs, owner tokens, and agent model/context values are not rendered.

## Typed repair

Copy the exact action from the latest diagnosis:

```bash
roll workspace doctor ws-payments --repair rebuild_cache:repo-0123456789ab
roll workspace doctor ws-payments --repair repair_requirement_projection:req-0123456789ab
roll workspace doctor ws-payments --repair recreate_clean_worktree:US-PAY-042
roll workspace doctor ws-payments --repair cleanup_stale_owned_lease:8e54b7d6-...
roll workspace doctor ws-payments --repair update_registry_path:ws-payments \
  --path /absolute/path/to/ws-payments
```

Repairs are deliberately narrow:

| Action | Safety boundary |
|---|---|
| `update_registry_path` | Requires an explicit absolute path whose `workspace.yaml` has the exact registered ID; Roll never searches for or adopts a similar directory. |
| `rebuild_cache` | Refuses origin conflicts and any registered or Git-admin linked worktree. |
| `repair_requirement_projection` | Rebuilds only `requirement.md`, `context/`, and pending `attest.md`, and only from a current immutable revision whose full archive audit is healthy. |
| `recreate_clean_worktree` | Resumes the Issue journal and pinned base; any dirty, unpushed, foreign, or conflicting target blocks the whole Issue repair. |
| `cleanup_stale_owned_lease` | Removes only an exact same-host lease that is past policy staleness and whose process is provably dead. |

Registry, cache, Requirement, and Issue repairs use their existing write-ahead journals. Repeating the same successful command returns `reused`; an interrupted repair keeps its journal and can be resumed with the same action. Repairs never alter immutable Requirement revisions, Issue completion evidence, remote identity, or dirty/unpushed work.
