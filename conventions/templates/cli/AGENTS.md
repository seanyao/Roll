# Project Conventions — CLI Tool

> Project-type-specific conventions — reference material for skills.
> **Note: Reference Template** — used by skills to infer project conventions. Not selected by users.

## Design Principles

- Lightweight. No server, no frontend, no heavy frameworks.
- Clear command structure: `tool <command> [options] [args]`.
- Helpful error messages with actionable suggestions.
- Consistent exit codes: 0 = success, 1 = user error, 2 = system error.
- Support `--help` and `--version` on every command.
- Respect `NO_COLOR` env var for output formatting.

## Architecture

- Single entry point dispatching to command handlers.
- Each command in its own file — easy to find, easy to test.
- Config loading: CLI flags > environment variables > config file > defaults.
- Use a CLI framework (commander, yargs, or citty) for argument parsing.

## Output

- Default to human-readable output. Support `--json` for machine-readable.
- Progress indicators for long operations (ora, cli-progress).
- Errors to stderr, results to stdout.
- Quiet mode (`--quiet` or `-q`) suppresses non-essential output.

## Project Structure

```
src/
├── index.ts              # entry point, CLI bootstrap
├── commands/             # one file per command
│   ├── init.ts
│   ├── build.ts
│   └── ...
├── utils/                # shared utilities
├── types/                # type definitions
└── config.ts             # config loading logic

tests/
├── unit/                 # command logic tests
└── integration/          # full CLI invocation tests (execa)
```

## Distribution

- Compile to single executable or publish to npm.
- Include `bin` field in `package.json`.
- Test installation flow: `npm install -g` should work cleanly.
- Include a man page or `--help` output that covers all commands.

## Development Discipline

- **TCR mandatory**: All code changes follow Test → Green = Commit / Red = Revert. No WIP commits.
- **Action granularity**: Each Action independently deployable, completable in 2–5 min. No placeholders (no TBD/TODO/pending).
- **Verification Gate**: Before marking done, run the actual command and paste the output. "I confirmed it works" is not evidence.
- **Complete delivery**: push to GitHub + CI passes + published/deployed. Local-only done is not done.

## Workspace Structure

- `BACKLOG.md` = index table, one-line summary per story only.
- `docs/features/<feature>.md` = US details (AC, Files, Dependencies).
- `docs/features/<feature>-plan.md` = architecture design doc (optional).
- Never write project docs to `~/.kimi/` or any global config directory.
