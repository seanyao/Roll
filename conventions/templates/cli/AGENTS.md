# Project Conventions — CLI Tool

> Reference for skills to infer CLI project conventions.

## 1. Principles
- **Lightweight**: No server/frontend.
- **Commands**: `tool <cmd> [opts]`. One file per cmd in `src/commands/`.
- **Exit Codes**: 0 success, 1 user error, 2 system error.

## 2. Architecture
- **Entry**: `src/index.ts` bootstrap.
- **Config**: Flags > Env > File > Defaults.
- **Output**: Human-friendly default, `--json` support. Errors to stderr.

## 3. Structure
```
src/
├── index.ts      # bootstrap
├── commands/     # handlers
└── config.ts     # logic
tests/
├── unit/         # logic
└── integration/  # execa
```

## 4. Discipline
- **TCR**: Mandatory.
- **Distribution**: `bin` in `package.json`, test `npm i -g`.
- **Workspace**: `BACKLOG.md` + `docs/features/`.
