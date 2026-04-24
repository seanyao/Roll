# Agent Conventions

> Project template. Customize section 5 with project-specific rules.

## 1. Communication
- User's language. Code/Git/Comments: English. UI: Chinese.
- Concise. No summaries/code-walking. Outcomes only.

## 2. Standards
- **TS**: Strict, no `any`. Functional hooks.
- **Test**: Unit >80%, E2E for flows. No WIP commits.
- **Done**: Push + CI passes + deployed. Local-only is not done.

## 3. Roll Workflow
- **Design**: `$roll-design` -> Stories -> `BACKLOG.md`
- **Build**: `$roll-build` / `$roll-fix` -> TCR (Green=Commit, Red=Revert)
- **Patrol**: `$roll-sentinel` periodic + `$roll-debug` on failure
- **Workspace**: `BACKLOG.md` index. `docs/features/<feat>.md` for details.

## 4. Architecture
- **Schema First**: Define types before logic.
- **Domain Driven**: Organize by business domain, not tech layer.
- **Decoupling**: UI renders only. Logic in hooks/services.

## 5. Project Specifics
<!-- Add project-specific stack, structure, and constraints. -->
