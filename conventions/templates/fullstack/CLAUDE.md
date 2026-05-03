# Project Preferences — Fullstack Web (Claude Code)

> Extends global CLAUDE.md + project AGENTS.md.

## Stack

- Frontend: React + shadcn/ui + Tailwind CSS + Vite
- Backend: Node.js API (Express/Hono/Fastify)
- Testing: Vitest (unit) + Playwright (E2E)
- Deploy: Vercel (frontend) + Railway/Fly.io (backend)

## Claude Code Notes

- Use `$roll-design` to plan features that span frontend and backend.
- When modifying API contracts, update both `api/types.ts` and `src/shared/types/` in the same commit.
- Use worktree isolation for parallel frontend/backend Actions in `$roll-build`.
- Run `npm run build` to verify both frontend and backend compile before pushing.
