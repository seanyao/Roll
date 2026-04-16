# Project Preferences — Fullstack Web (Gemini CLI)

> Extends global GEMINI.md + project AGENTS.md.

## Stack

- Frontend: React + shadcn/ui + Tailwind CSS + Vite
- Backend: Node.js API (Express/Hono/Fastify)
- Testing: Vitest (unit) + Playwright (E2E)

## Gemini Notes

- When modifying API contracts, update both `api/types.ts` and `src/shared/types/` in the same commit.
- Run `npm run build` to verify both frontend and backend compile before pushing.
- Follow the project AGENTS.md for architecture constraints and Roll workflow.
