# Project Conventions — Fullstack Web

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

## Backend

- RESTful API conventions. Consistent URL structure: `/api/{resource}/{id}`.
- Structured error responses: `{ error: string, code: string, details?: object }`.
- Environment-based config via `.env`. Never hardcode secrets.
- Folder structure:
  - `src/routes/` or `api/routes/` — route handlers
  - `src/services/` or `api/services/` — business logic
  - `src/models/` or `api/models/` — data models and schemas
- Health check endpoint: `GET /api/health`
- Authentication: JWT in httpOnly cookies.

## Architecture

- **Domain Driven Design**: organize code by business domain, not technical layer.
- **Clean Architecture**: UI → Application (hooks) → Domain (services) → Infrastructure (API/DB).
- **Decoupling**: UI renders only, logic lives in hooks. API calls wrapped in services.
- **Data Schema First**: define types/schemas before writing business logic.
- **Frontend-Backend Contract**: API changes must sync `shared/types/`. Errors use unified format.

## Project Structure

```
src/
├── components/ui/        # shadcn/ui (generated, don't edit)
├── domains/              # DDD by business domain
│   └── {domain}/
│       ├── components/   # domain-specific UI
│       ├── hooks/        # domain logic
│       ├── services/     # API calls
│       └── types.ts      # domain types
├── shared/
│   ├── api/              # HTTP client, interceptors
│   ├── types/            # shared type definitions
│   └── utils/            # utility functions
├── App.tsx
└── main.tsx

api/
├── routes/               # RESTful route handlers
├── services/             # business logic
├── models/               # data models
└── types.ts              # API contract types

schema/                   # data contract definitions
tests/
├── unit/                 # Vitest
├── e2e/                  # Playwright
└── regression/           # Sentinel regression
```

## Development Discipline

- **TCR mandatory**: All code changes follow Test → Green = Commit / Red = Revert. No WIP commits.
- **Action granularity**: Each Action independently deployable, completable in 2–5 min. No placeholders (no TBD/TODO/pending).
- **Verification Gate**: Before marking done, provide fresh evidence (test output, screenshot, curl). "I confirmed it works" is not evidence.
- **Complete delivery**: push to GitHub + CI passes + deployed online. Local-only done is not done.

## Testing Requirements

- All business logic must have unit tests (coverage >80%).
- All API endpoints must have integration tests — no DB mocks, use real database.
- Critical user flows must have E2E tests (Playwright).
- New architecture introductions (State/Cache/EventBus) must have data flow integration tests.
- Sentinel will periodically regression-test completed Stories.

## Workspace Structure

- `BACKLOG.md` = index table, one-line summary per story only.
- `docs/features/<feature>.md` = US details (AC, Files, Dependencies).
- `docs/features/<feature>-plan.md` = architecture design doc (optional).
- Never write project docs to `~/.kimi/` or any global config directory.
