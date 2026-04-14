# Project Preferences — CLI Tool (Claude Code)

> Extends global CLAUDE.md + project AGENTS.md.

## Stack

- Node.js / TypeScript
- CLI framework: commander or citty
- Testing: Vitest + execa (CLI integration tests)
- Distribution: npm package with bin entry

## Claude Code Notes

- No server, no frontend. CLI tool only.
- Test commands by running them in Bash, not just unit tests.
- Use `$cnx-design` to plan command structure and options before implementation.
- Verify `--help` output is clear and complete for each command.
- Run `npm run build && node dist/index.js --help` before pushing.
