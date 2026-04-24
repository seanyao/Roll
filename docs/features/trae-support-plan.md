# Plan: Trae IDE Support

## Context

Trae IDE (ByteDance, v1.3.0+) is a VS Code-based AI-first IDE with a Solo agent mode.
It reads per-project AI rules from `.trae/rules/project_rules.md` (Markdown format),
and optionally per-user rules from `~/.trae/user_rules.md`.

Roll already supports Claude Code, Gemini CLI, and Cursor via the same convention file
pattern. Trae support follows the identical mechanism.

## Decision

Name the Roll convention source files `project_rules.md` — matches Trae's output filename
exactly, consistent with how `.cursor-rules` is the source AND output filename for Cursor.

No changes to the `merge_convention` function signature are needed.

## File Mapping

| Roll convention source               | Output path (project)                 |
|--------------------------------------|---------------------------------------|
| conventions/global/project_rules.md  | .trae/rules/project_rules.md          |
| conventions/templates/*/project_rules.md | .trae/rules/project_rules.md     |

| Roll convention source               | Output path (global sync)             |
|--------------------------------------|---------------------------------------|
| conventions/global/project_rules.md  | ~/.trae/user_rules.md                 |

## bin/roll Changes

1. `detect_tools()` — add check for `.trae/rules/project_rules.md` → emit `"trae"`
2. `refresh_project()` — add Trae branch: `mkdir -p .trae/rules` + `merge_convention "project_rules.md" … "$project_dir/.trae/rules"`
3. Default `config.yaml` template — add `ai_trae: ~/.trae|user_rules.md|project_rules.md`

## Stories

- US-TRAE-001: Convention files (global + 4 templates)
- US-TRAE-002: bin/roll integration
