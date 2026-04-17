# Global Preferences — Gemini CLI

> Extends AGENTS.md in this directory — read that first for shared conventions.
> This file adds Gemini CLI-specific configuration only.

## Identity

- Git: `Sean Yao <sean.dlut@gmail.com>`
- Default branch: `main`

## Commit Message Format

- Format: `<type>: <description>` (遵循 Git Hook 自动生成的前缀)
- TCR micro-commits: `tcr: <description>` (No prefix)
- Types: Story N, Fix, Refactor, Docs, Chore

## Gemini-Specific

- When running shell commands, prefer the most specific tool available.
- For file operations, verify the file exists before modifying.
- When a project has Roll workflow, follow the AGENTS.md conventions and use Roll skills.
- Prefer targeted edits over full file rewrites.

## Frontend Default Stack

- React + shadcn/ui + Tailwind CSS is the default.
- Use shadcn/ui components first. Custom only when shadcn doesn't cover it.
- Tailwind utility classes only. No inline styles, no CSS modules.

---

# Project Preferences — CLI Tool (Gemini CLI)

> Extends global GEMINI.md + project AGENTS.md.

## Stack

- Node.js / TypeScript
- CLI framework: commander or citty
- Testing: Vitest

## Gemini Notes

- No server, no frontend. CLI tool only.
- Test commands by running them, not just unit tests.
- Run `npm run build && node dist/index.js --help` before pushing.
- Follow the project AGENTS.md for architecture constraints and Roll workflow.
