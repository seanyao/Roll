# Context Compatibility Matrix

This public/typed boundary matrix is executable acceptance input. `context.critical.e2e.test.ts` fails when an AC, diagnostic code, or evidence ID loses its reverse mapping.

| Matrix ID | Design invariant | Story AC | Diagnostic / outcome | Executable evidence |
|---|---|---|---|---|
| M01 | Every explicit fresh read performs a Provider fetch and one read pins all returned pages to the resolved revision. | AC2, AC9 | `completed` | `[M01]` freshness and same-revision black-box chain |
| M02 | Same-Provider reads serialize under one lease while different Providers may execute in parallel. | AC2 | `context_lock_timeout`, `completed` | `[M02]` provider concurrency matrix |
| M03 | Required fetch failure never reuses captured content. | AC3 | `fetch_failed`, `blocked` | `[M03]` required no-stale failure matrix |
| M04 | Timeout, missing branch, and cache remote mismatch fail closed without stale bodies. | AC3, AC5 | `fetch_timeout`, `branch_not_found`, `remote_identity_mismatch` | `[M04]` transport failure matrix |
| M05 | Optional Provider failure yields a gap while successful Provider bytes remain usable. | AC3 | `partial` | `[M05]` optional no-stale matrix |
| M06 | Machine, Workspace, or binding disablement causes zero Provider effects. | AC4 | `context_disabled`, `disabled` | `[M06]` disabled zero-effect matrix |
| M07 | Duplicate/contradictory bindings and malformed Workspace authority block before effects. | AC4 | `invalid_context_binding` | `[M07]` binding plan zero-effect matrix |
| M08 | Missing, duplicate, disabled, or malformed Provider configuration is diagnosed before transport. | AC4 | `provider_not_found`, `provider_disabled`, `invalid_provider_config` | `[M08]` Provider plan zero-effect matrix |
| M09 | Explicit refs must use the Context scheme and target an enabled Workspace binding. | AC4, AC5 | `invalid_context_ref`, `provider_not_bound`, `provider_not_found` | `[M09]` ref authorization zero-effect matrix |
| M10 | Production accepts only credential-free HTTPS/SSH identities and rejects unsupported transport. | AC5, AC9 | `unsupported_git_transport` | `[M10]` transport allowlist matrix |
| M11 | Missing files/revisions and invalid Wiki layout never expose partial page bytes. | AC3, AC5 | `revision_missing`, `context_file_missing`, `invalid_wiki_layout` | `[M11]` fixed-revision completeness matrix |
| M12 | Symlinks, oversized files, and Provider budgets fail before content publication. | AC5 | `context_symlink_rejected`, `context_file_too_large`, `context_budget_exceeded` | `[M12]` object safety matrix |
| M13 | Page frontmatter must be valid UTF-8 Roll metadata; nashsu editor fields cannot replace safety metadata. | AC5, AC7 | `invalid_page_frontmatter` | `[M13]` frontmatter and nashsu compatibility matrix |
| M14 | Constrained page scope requires matching request dimensions and never retains a mismatched body. | AC5 | `scope_mismatch` | `[M14]` scope fail-closed matrix |
| M15 | Restricted pages require opaque refs, explicit request intent, and operation authorization. | AC5, AC8 | `restricted_context_denied` | `[M15]` restricted/opaque reference matrix |
| M16 | Context remains length-delimited untrusted data and Wiki instructions never gain tool authority. | AC5, AC8 | `completed` | `[M16]` hostile envelope and zero-live-tool matrix |
| M17 | Snapshot digest/reference tampering or artifact escape is observable and never repaired from source. | AC6 | `invalid_context_snapshot` | `[M17]` immutable Snapshot matrix |
| M18 | Missing captured refs fail locally without a Provider read. | AC6 | `context_file_missing` | `[M18]` captured-ref matrix |
| M19 | Changed revisions require an explicit consuming-stage decision. | AC6 | `context_revision_changed` | `[M19]` revision-decision matrix |
| M20 | Concurrent publication collision preserves the first immutable artifact. | AC6 | `invalid_context_snapshot` | `[M20]` atomic publication collision matrix |
| M21 | Independently-authored purpose/schema/raw/wiki content is nashsu-compatible without importing its implementation. | AC7 | `completed` | `[M21]` compatibility/license fixture audit |
| M22 | DB, K8s, and test-account pages carry mappings/policy plus opaque credential references only. | AC8 | `completed` | `[M22]` data-surface opaque-ref fixture |
| M23 | Context operation audit failures never mask the primary read result. | AC2, AC9 | `fetch_failed`, `completed` | `[M23]` audit isolation matrix |
| M24 | Acceptance runs only against isolated HOME/ROLL_HOME, fake Git, and typed host boundaries. | AC1, AC9 | `completed` | `[M24]` isolation guard and matrix self-audit |

## Required evidence commands

- Critical: `pnpm --filter @roll/cli exec vitest run test/context.critical.e2e.test.ts`
- Focused layers: Context suites in `@roll/spec`, `@roll/core`, `@roll/infra`, and `@roll/cli`
- Skills: `node skills/scripts/audit-skills.mjs --strict`
- Build: `pnpm -r build`
