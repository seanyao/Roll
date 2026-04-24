# Project Conventions — Fullstack Web

> Reference for skills to infer fullstack project conventions.

## 1. Stack
- **Frontend**: React 18+ / TS / Vite / Tailwind / shadcn/ui.
- **Backend**: Node.js REST API.
- **Structure**: `src/domains/{domain}/` for DDD. `api/` for backend.

## 2. Architecture
- **DDD**: Logic in hooks/services, not components.
- **Contract**: API changes must sync `shared/types/`.
- **Data**: Define schemas before logic.

## 3. Structure
```
src/
├── components/ui/   # shadcn (don't edit)
├── domains/         # DDD components/hooks/services
└── shared/          # api/types/utils
api/
├── routes/          # thin handlers
└── services/        # business logic
```

## 4. Discipline
- **TCR**: Mandatory.
- **Testing**: Unit >80%, E2E for critical flows.
- **Workspace**: `BACKLOG.md` + `docs/features/`.
