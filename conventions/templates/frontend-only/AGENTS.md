# Project Conventions — Frontend Only

> Reference for skills to infer frontend project conventions.

## 1. Stack
- **Core**: React 18+ / TS / Vite / Tailwind / shadcn/ui.
- **State**: React state (simple), Zustand/Jotai (complex), TanStack Query (server).
- **Structure**: `src/domains/{domain}/` for DDD.

## 2. Architecture
- **DDD**: Logic in hooks/services, not components.
- **Decoupling**: UI renders only, logic in hooks.
- **Data**: Define schemas before logic.

## 3. Structure
```
src/
├── components/ui/   # shadcn (don't edit)
├── domains/         # DDD components/hooks/services
└── shared/          # api/types/utils
```

## 4. Discipline
- **TCR**: Mandatory.
- **Testing**: Unit (hooks/logic) >80%, E2E (Playwright).
- **Workspace**: `BACKLOG.md` + `docs/features/`.
