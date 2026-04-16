# Global Agent Conventions — Sean Yao

> Master conventions file. All AI coding agents follow these principles.
> Tool-specific files (CLAUDE.md, GEMINI.md, .cursor-rules) extend this document.

## Communication

- Respond in the language I write in. Chinese message → Chinese response. English → English.
- Code, commit messages, variable names, comments: always English.
- Error messages in API responses: English.
- UI-facing text: Chinese (internal tool for Chinese-speaking team).
- Be concise. Don't summarize what you just did — I can read the diff.
- Don't ask for confirmation on routine actions. Just do it and show the result.
- If something is ambiguous, make a reasonable judgment call. Only ask when the choice has real consequences.
- Use plain language. No academic jargon or pretentious framing.

## Code Style

- TypeScript strict mode. No `any` unless absolutely unavoidable.
- Functional components with hooks. No class components.
- Prefer `const` over `let`. Never `var`.
- Early returns over nested conditionals.
- Name things clearly — no abbreviations except well-known ones (e.g., `id`, `url`, `api`).
- Keep functions short and single-purpose. If it needs a comment to explain, it's too complex.
- Don't add comments unless the logic is genuinely non-obvious.
- Don't add docstrings, JSDoc, or type annotations to code you didn't change.

## Git

- Conventional commit format: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- Write in English, concise, imperative mood.
- Never force push to main.
- Never skip hooks (`--no-verify`).
- Never commit `.env`, credentials, or secrets.

## Behavior

- Do not refactor files unrelated to the current task.
- Do not add features, refactoring, or "improvements" not requested.
- Always ask before making structural changes (directory reorganization, architecture changes).
- Don't wrap simple things in abstractions. Three similar lines > a premature helper.
- Don't add error handling for impossible scenarios. Trust the framework.
- Delete unused things completely — no `// removed` comments, no backward-compat shims.
- Don't create README.md or documentation files unless asked.

## Testing

- All business logic must have unit tests (coverage >80%).
- All API endpoints must have integration tests — no DB mocks.
- Critical user flows must have E2E tests (Playwright).
- New architecture introductions (State/Cache/EventBus) must have data flow integration tests.
- Run existing tests before pushing to verify no regressions.

## Engineering Common Sense

Non-negotiable requirements for all code changes. Violating these is a bug:

- **Idempotency**: Same operation N times = same result. Test by running 3 times.
- **Cross-module contract**: Shared IDs, formats, algorithms must be identical across modules.
- **Data flow integrity**: Producer → Storage → Consumer chain must be complete and tested.
- **Atomicity**: Operations complete fully or not at all. Partial failure → rollback.
- **Input validation**: All external input (API, user, file) must be validated.
- **Graceful degradation**: Dependency fails → limited functionality, not crash.
- **Observability**: User must see progress, state, and errors.
- **Concurrency safety**: Shared resources under multi-thread/multi-process access must be safe.

## Roll Workflow (When Project Has It)

When a project has Roll workflow configured:

### Workspace Structure

- `BACKLOG.md` = index table, one-line summary per story only.
- `docs/features/<feature>.md` = US details (AC, Files, Dependencies).
- `docs/features/<feature>-plan.md` = architecture design doc (optional).
- Never write project docs to `~/.kimi/` or any global config directory.

### Development Discipline

- **TCR mandatory**: All code changes follow Test → Green = Commit / Red = Revert. No WIP commits.
- **Action granularity**: Each Action independently deployable, completable in 2–5 min. No placeholders (no TBD/TODO/pending).
- **Verification Gate**: Before marking done, provide fresh evidence (test output, screenshot, curl). "I confirmed it works" is not evidence.
- **Complete delivery**: push to GitHub + CI passes + deployed online. Local-only done is not done.

### Skill Selection

```
Uncertain approach?        → $roll-design
Want to ship something?    → $roll-build  (handles US-XXX, FIX-XXX, or vague ideas)
Single bug fix?            → $roll-fix
High-risk logic?           → $roll-spar
Page/production issue?     → $roll-debug
Initialize new project?    → roll init  (CLI command, not a skill)
```
