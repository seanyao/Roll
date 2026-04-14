# Project Preferences — Backend Service (Claude Code)

> Extends global CLAUDE.md + project AGENTS.md.

## Stack

- Node.js / TypeScript / Express or Hono or Fastify
- Database: Prisma or Drizzle ORM
- Testing: Vitest (unit) + Supertest (integration)
- Deploy: Railway / Fly.io / Docker

## Claude Code Notes

- No frontend in this project. API-only service.
- Use `$cnx-design` to plan API contracts and data models before implementation.
- Write integration tests that hit real endpoints (supertest), not mocked handlers.
- Verify health check endpoint responds before reporting deploy as done.
- Run `npm run build && npm run test` before pushing.
