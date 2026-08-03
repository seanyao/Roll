# Migrating APE Context to Roll

APE's `ape-context` and `ape-shared-execution-context` stores map to one Roll Context model: ordinary LLM Wiki pages plus explicit `scope`. There is no special shared runtime type. A page is shared only because its scope permits several Workspaces, repositories, environments, Stories, or stages.

## Content mapping

| Existing APE content | Roll LLM Wiki target |
|---|---|
| `index.md` | `wiki/index.md` |
| `log.md` | `wiki/log.md` |
| `contexts/global/**` | `wiki/policies/**` or `wiki/concepts/**` |
| `contexts/systems/**` | `wiki/systems/**` |
| `contexts/repos/**` | `wiki/repositories/**` |
| `contexts/workflows/**` | `wiki/workflows/**` |
| `contexts/data-surfaces/**` | `wiki/data-surfaces/**` |
| `schema/*.md` | `schema.md` and, when needed, `wiki/schemas/**` |
| `sources/**` | `raw/sources/**` |
| scoped shared execution notes | an ordinary Wiki page with repository, environment, Story, and stage scope |
| `credentials/**` | do not migrate credential values; replace them with an opaque `credential_ref` |

Legacy refs change from:

```text
ape-context:contexts/systems/platform.md
shared-execution-context:release-batch/index.md
```

to:

```text
context://enterprise-wiki/wiki/systems/platform.md
context://enterprise-wiki/wiki/scopes/release-batch.md
```

The second target is an ordinary page. Its narrower `scope` expresses why it applies to one execution batch.

## Migration checklist

1. Create `purpose.md`, `schema.md`, `wiki/index.md`, and `wiki/log.md`.
2. Move source provenance under `raw/sources/`; do not make raw files default Context output.
3. Convert each content page to `schema: roll.context-page/v1` frontmatter.
4. Normalize repository IDs with the same schemeful Workspace identity; do not collapse SSH and HTTPS identities.
5. Translate shared applicability into explicit scope dimensions. Missing request dimensions fail closed.
6. Replace DB, Kubernetes, and test-account values with mapping, policy, and opaque credential references.
7. Do not migrate a credential value, token, password, cookie, private key, DSN, or connection string.
8. Register the Git Provider in `~/.roll/context-providers.yaml`, bind it in `workspace.yaml`, then verify with `roll context status` and a fresh `roll context read`.

See [Context Engineering](context.md) for the complete Provider, read, Snapshot, authority, and diagnostic contract.
