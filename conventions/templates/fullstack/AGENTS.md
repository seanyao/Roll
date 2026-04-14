# Project Conventions — Fullstack Web

> Project-type-specific conventions. Merged with global conventions at init time.

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
