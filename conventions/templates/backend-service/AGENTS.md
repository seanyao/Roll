# Project Conventions — Backend Service

> Project-type-specific conventions — reference material for skills.
> **Note: Reference Template** — used by skills to infer project conventions. Not selected by users.

## API Design

- RESTful API with consistent URL structure: `/api/{resource}/{id}`.
- For internal microservices, gRPC is acceptable.
- Structured error responses: `{ error: string, code: string, details?: object }`.
- Health check endpoint: `GET /api/health` returning `{ status: "ok", version: string }`.
- API versioning via URL prefix (`/api/v1/`) when breaking changes are needed.

## Configuration

- Environment config via `.env`. Never hardcode secrets.
- Use `.env.example` as the template with all required variables documented.
- Validate all env vars at startup — fail fast if missing.
- Separate configs for development, staging, production.

## Logging

- Structured JSON logging (e.g., pino, winston with JSON transport).
- Log levels: `error`, `warn`, `info`, `debug`. Default to `info` in production.
- Include correlation IDs for request tracing.
- Never log secrets, tokens, or PII.

## Error Handling

- Domain errors: typed error classes with error codes.
- HTTP errors: map domain errors to appropriate status codes.
- Unhandled errors: catch-all middleware, log full stack, return 500 with safe message.
- Validation errors: 400 with detailed field-level error messages.

## Project Structure

```
src/
├── routes/               # HTTP route handlers (thin — delegate to services)
├── services/             # business logic (pure functions where possible)
├── models/               # data models, ORM entities, schemas
├── middleware/            # auth, logging, error handling, validation
├── utils/                # shared utilities
├── types/                # TypeScript type definitions
├── config/               # environment config, constants
└── index.ts              # entry point, server bootstrap

tests/
├── unit/                 # service/model unit tests
├── integration/          # API endpoint tests (supertest)
└── regression/           # Sentinel regression
```

## Database

- Migrations managed via a migration tool (Prisma, Drizzle, Knex).
- Never modify production data manually — always through migrations.
- Index frequently queried columns. Monitor slow queries.
- Use transactions for multi-table operations.

## Security

- Input validation on all endpoints (zod, joi, or similar).
- Rate limiting on public endpoints.
- CORS configured explicitly — no wildcard in production.
- Authentication middleware applied at route level, not globally.
- Secrets rotated periodically. Never in git history.

## Architecture Constraints

- **Domain Driven**: organize code by business domain, not technical layer. `src/services/` contains domain logic, not generic utilities.
- **Clean Architecture**: routes (thin) → services (business logic) → models (data) ← infrastructure (DB/external APIs). Routes delegate; they don't contain business logic.
- **Data Schema First**: define types/schemas before writing business logic.
- **API Contract**: typed request/response schemas. API changes must bump version or be backward-compatible.

## Development Discipline

- **TCR mandatory**: All code changes follow Test → Green = Commit / Red = Revert. No WIP commits.
- **Action granularity**: Each Action independently deployable, completable in 2–5 min. No placeholders (no TBD/TODO/pending).
- **Verification Gate**: Before marking done, provide fresh evidence (test output, curl response). "I confirmed it works" is not evidence.
- **Complete delivery**: push to GitHub + CI passes + deployed online. Local-only done is not done.

## Workspace Structure

- `BACKLOG.md` = index table, one-line summary per story only.
- `docs/features/<feature>.md` = US details (AC, Files, Dependencies).
- `docs/features/<feature>-plan.md` = architecture design doc (optional).
- Never write project docs to `~/.kimi/` or any global config directory.
