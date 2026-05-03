# Global Preferences — Claude Code

> Extends [AGENTS.md](./AGENTS.md) — read that first for shared conventions.
> This file adds Claude Code-specific configuration only.

## Identity

- Git: `Sean Yao <sean.dlut@gmail.com>`
- Default branch: `main`

## Commit Message Format

- Format: `<type>: <description>` (遵循 Git Hook 自动生成的前缀)
- TCR micro-commits: `tcr: <description>` (No prefix)
- Types: Story N, Fix, Refactor, Docs, Chore
- Example: `Story 7: Review assignment by org structure`

## Claude Code-Specific

- When a project has Roll skills, use them (`$roll-design`, `$roll-build`, `$roll-fix`, etc.).
- Use plan mode for complex multi-step tasks before executing.
- Prefer Edit tool over Bash for file modifications.
- Use Agent tool with worktree isolation for parallel independent subtasks.
- When I say "帮我看下" or "处理下", go ahead and do it, not just analyze it.

## Frontend Default Stack

- React + shadcn/ui + Tailwind CSS is the default.
- Use shadcn/ui components first. Custom components only when shadcn doesn't cover it.
- `components/ui/` is shadcn-generated — never edit manually.
- Tailwind utility classes only. No inline styles, no CSS modules.
- Icons: Lucide React.

---

# Project Preferences — CLI Tool (Claude Code)

> Extends global CLAUDE.md + project AGENTS.md.

## Stack

- Node.js / TypeScript
- CLI framework: commander or citty
- Testing: Vitest + execa (CLI integration tests)
- Distribution: npm package with bin entry

## Scope Discipline

- **Approach confirmation required** for UX, output format, or automation-level decisions: output a 2–3 bullet plan and wait for confirmation before editing files.
- **Automation scope**: never assume manual vs automatic — state the assumption and confirm.

## Bilingual Output Convention

- EN + ZH CLI output or docs: English and Chinese on **separate lines**, never inline on the same line.

## Claude Code Notes

- No server, no frontend. CLI tool only.
- Test commands by running them in Bash, not just unit tests.
- Use `$roll-design` to plan command structure and options before implementation.
- Verify `--help` output is clear and complete for each command.
- Run `npm run build && node dist/index.js --help` before pushing.
