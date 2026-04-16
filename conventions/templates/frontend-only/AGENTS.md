# Project Conventions — Frontend Only

> Project-type-specific conventions — reference material for skills.
> **Note: Reference Template** — used by skills to infer project conventions. Not selected by users.

## Frontend

- Stack: React 18+ / TypeScript / Vite / Tailwind CSS / shadcn/ui / Lucide React
- Use shadcn/ui components first. Custom components only when shadcn doesn't cover it.
- `src/components/ui/` is shadcn-generated — never edit manually.
- `src/components/[feature]/` for custom feature components.
- Tailwind utility classes only. No inline styles, no CSS modules.
- Organize by domain: `src/domains/{domain}/components/`, `hooks/`, `services/`, `types.ts`
- Shared utilities in `src/shared/` (api/, types/, utils/, hooks/).

## Architecture

- **Domain Driven Design**: organize code by business domain, not technical layer.
- **Clean Architecture**: UI → Application (hooks) → Domain (services) → Infrastructure (API client).
- **Decoupling**: UI renders only, logic lives in hooks. API calls wrapped in services.
- **Data Schema First**: define types/schemas before writing business logic.
- No backend code in this project. API consumption only.

## State Management

- Prefer React built-in state (useState, useReducer, useContext) for simple cases.
- Use a state library (Zustand, Jotai) only when shared state gets complex.
- Server state via TanStack Query (React Query) for API data fetching and caching.

## Project Structure

```
src/
├── components/ui/        # shadcn/ui (generated, don't edit)
├── domains/              # DDD by business domain
│   └── {domain}/
│       ├── components/   # domain-specific UI
│       ├── hooks/        # domain logic + state
│       ├── services/     # API client calls
│       └── types.ts      # domain types
├── shared/
│   ├── api/              # HTTP client, interceptors
│   ├── types/            # shared type definitions
│   └── utils/            # utility functions
├── App.tsx
└── main.tsx

tests/
├── unit/                 # Vitest + Testing Library
└── e2e/                  # Playwright
```

## Development Discipline

- **TCR mandatory**: All code changes follow Test → Green = Commit / Red = Revert. No WIP commits.
- **Action granularity**: Each Action independently deployable, completable in 2–5 min. No placeholders (no TBD/TODO/pending).
- **Verification Gate**: Before marking done, provide fresh evidence (test output, screenshot). "I confirmed it works" is not evidence.
- **Complete delivery**: push to GitHub + CI passes + deployed online. Local-only done is not done.

## Testing Requirements

- All hooks and domain logic must have unit tests (Vitest + Testing Library, coverage >80%).
- Critical user flows must have E2E tests (Playwright).
- Run existing tests before pushing to verify no regressions.

## Workspace Structure

- `BACKLOG.md` = index table, one-line summary per story only.
- `docs/features/<feature>.md` = US details (AC, Files, Dependencies).
- `docs/features/<feature>-plan.md` = architecture design doc (optional).
- Never write project docs to `~/.kimi/` or any global config directory.
