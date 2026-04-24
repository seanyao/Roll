# Project Conventions — Backend Service

> Reference for skills to infer backend project conventions.

## 1. Design
- **API**: RESTful `/api/{res}/{id}`. Structured JSON errors.
- **Config**: `.env` (validate at start). Flags > Env > File.
- **Logging**: Structured JSON (pino/winston). No secrets/PII.

## 2. Architecture
- **DDD**: Organize by business domain, not tech layer.
- **Clean**: Routes (thin) -> Services (logic) -> Models (data).
- **Database**: Migrations mandatory. Transactions for multi-table.

## 3. Structure
```
src/
├── routes/       # thin handlers
├── services/     # business logic
├── models/       # schemas/entities
└── middleware/   # auth/log/error
```

## 4. Discipline
- **TCR**: Mandatory.
- **Security**: Input validation (zod), Rate limiting, Secrets rotation.
- **Workspace**: `BACKLOG.md` + `docs/features/`.
