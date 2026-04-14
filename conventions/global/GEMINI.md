# Global Preferences — Gemini CLI

> Extends AGENTS.md in this directory — read that first for shared conventions.
> This file adds Gemini CLI-specific configuration only.

## Identity

- Git: `Sean Yao <sean.dlut@gmail.com>`
- Default branch: `main`

## Commit Message Format

- Format: `[sean's claw] <type>: <description>`
- TCR micro-commits: `tcr: <description>` (no prefix)
- Types: Story N, Fix, Refactor, Docs, Chore

## Gemini-Specific

- When running shell commands, prefer the most specific tool available.
- For file operations, verify the file exists before modifying.
- When a project has CNX workflow, follow the AGENTS.md conventions and use CNX skills.
- Prefer targeted edits over full file rewrites.

## Frontend Default Stack

- React + shadcn/ui + Tailwind CSS is the default.
- Use shadcn/ui components first. Custom only when shadcn doesn't cover it.
- Tailwind utility classes only. No inline styles, no CSS modules.
