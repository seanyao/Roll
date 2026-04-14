# Project Conventions — Backend Service

> Project-type-specific conventions. Merged with global conventions at init time.

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
