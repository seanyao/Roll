# Agent Conventions

> Baseline for AI-agent-friendly projects. Extend with project-specific rules.

## 1. Communication
- User's language. Code/Git/Comments: English. UI: Chinese.
- Concise. No summaries/code-walking. Implementation invisible.
- Strategy (Why) OK; Tactics (How) NO. Outcomes only.

## 2. Code
- **TS**: Strict, no `any`. Functional hooks. Early returns.
- **Git**: No force-push main. No `--no-verify`. No secrets in git.
- **Behavior**: No unrelated refactoring. No speculative abstractions.

## 3. Engineering
- **Idempotency**: Same op N times = same result.
- **Atomicity**: Complete fully or rollback. No partial state.
- **Validation**: All external input validated. Fail fast on startup.
- **Testing**: Unit >80%. E2E for flows. No DB mocks.

## 4. Workflow
- **TCR**: Test -> Green = Commit / Red = Revert. No WIP commits.
- **Workspace**: `BACKLOG.md` index. `docs/features/` for details.
- **Done**: Push + CI passes + deployed. Local-only is not done.
