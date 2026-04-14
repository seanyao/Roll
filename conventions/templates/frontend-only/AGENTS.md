# Project Conventions — Frontend Only

> Project-type-specific conventions. Merged with global conventions at init time.

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
