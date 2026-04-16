# Project Preferences — Backend Service (Gemini CLI)

> Extends global GEMINI.md + project AGENTS.md.

## Stack

- Node.js / TypeScript / Express or Hono or Fastify
- Database: Prisma or Drizzle ORM
- Testing: Vitest + Supertest

## Gemini Notes

- No frontend in this project. API-only service.
- Write integration tests that hit real endpoints, not mocked handlers.
- Run `npm run build && npm run test` before pushing.
- Follow the project AGENTS.md for architecture constraints and Roll workflow.
