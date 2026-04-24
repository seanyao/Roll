# Agent Conventions

> Global conventions for AI agents. Focus on outcomes.

## 1. Communication
- Respond in user's language. Code/Git/Comments: English. UI: Chinese.
- Concise. No summaries/code-walking. Implementation invisible.
- Strategy (Why) OK; Tactics (How) NO. Outcomes only.

## 2. Standards
- **TS**: Strict, no `any`. Functional hooks.
- **Rules**: [engineering-common-sense.md](file:///Users/seanclaw/Workspace/roll/docs/practices/engineering-common-sense.md).
- **Test**: Unit >80%, E2E for flows. Test before push.

## 3. Workflow
- **TCR**: Test -> Green = Commit / Red = Revert. No WIP.
- **Backlog**: Work stems from `BACKLOG.md`.
- **Docs**: [skill-selection-guide.md](file:///Users/seanclaw/Workspace/roll/docs/skill-selection-guide.md), [methodology.md](file:///Users/seanclaw/Workspace/roll/docs/methodology.md).
