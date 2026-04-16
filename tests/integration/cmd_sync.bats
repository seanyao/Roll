#!/usr/bin/env bats
# Integration tests for: roll sync [scope]
# Tests convention file syncing, skill symlink creation, idempotency,
# and conditional directory handling.

load helpers

setup() {
  integration_setup
  # Ensure WK_HOME exists before sync (setup populates conventions/skills)
  run_wk setup
}

teardown() {
  integration_teardown
}

# ─── sync conventions: wk.md written ─────────────────────────────────────────

@test "sync conventions: wk.md is written to ~/.claude/" {
  run_wk sync conventions
  [ "$status" -eq 0 ]
  [ -f "${TEST_TMP}/.claude/wk.md" ]
}

@test "sync conventions: wk.md content matches WK_HOME/conventions/global/CLAUDE.md" {
  run_wk sync conventions
  [ "$status" -eq 0 ]
  diff "${ROLL_HOME}/conventions/global/CLAUDE.md" "${TEST_TMP}/.claude/wk.md"
}

# ─── sync conventions: @wk.md appended to CLAUDE.md ─────────────────────────

@test "sync conventions: @wk.md is present in ~/.claude/CLAUDE.md" {
  run_wk sync conventions
  [ "$status" -eq 0 ]
  [ -f "${TEST_TMP}/.claude/CLAUDE.md" ]
  grep -qF "@wk.md" "${TEST_TMP}/.claude/CLAUDE.md"
}

# ─── sync conventions: idempotent (@wk.md not duplicated) ────────────────────

@test "sync conventions: @wk.md is not duplicated when synced twice" {
  run_wk sync conventions
  [ "$status" -eq 0 ]
  run_wk sync conventions
  [ "$status" -eq 0 ]
  local count
  count=$(grep -cF "@wk.md" "${TEST_TMP}/.claude/CLAUDE.md")
  [ "$count" -eq 1 ]
}

# ─── sync conventions: missing AI tool dir is not created ────────────────────

@test "sync conventions: absent ~/.gemini/ is not recreated by sync" {
  rm -rf "${TEST_TMP}/.gemini"
  run_wk sync conventions
  [ "$status" -eq 0 ]
  [ ! -d "${TEST_TMP}/.gemini" ]
}

# ─── sync skills: symlinks exist ─────────────────────────────────────────────

@test "sync skills: ~/.claude/skills/ contains wk-* symlinks" {
  run_wk sync skills
  [ "$status" -eq 0 ]
  local count
  count=$(find "${TEST_TMP}/.claude/skills" -maxdepth 1 -mindepth 1 -type l -name "wk-*" | wc -l | tr -d ' ')
  [ "$count" -gt 0 ]
}

# ─── sync all: conventions and skills both applied ────────────────────────────

@test "sync all: wk.md exists after sync all" {
  run_wk sync all
  [ "$status" -eq 0 ]
  [ -f "${TEST_TMP}/.claude/wk.md" ]
}

@test "sync all: wk-* skill symlinks exist after sync all" {
  run_wk sync all
  [ "$status" -eq 0 ]
  local count
  count=$(find "${TEST_TMP}/.claude/skills" -maxdepth 1 -mindepth 1 -type l -name "wk-*" | wc -l | tr -d ' ')
  [ "$count" -gt 0 ]
}
