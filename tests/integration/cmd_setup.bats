#!/usr/bin/env bats
# Integration tests for: roll setup
# Tests WK_HOME directory creation, convention/skill installation, symlink linking,
# and config.yaml generation.

load helpers

setup() {
  integration_setup
}

teardown() {
  integration_teardown
}

# ─── Scenario 1: setup creates WK_HOME directory structure ───────────────────

@test "setup: creates ~/.roll/ when it does not exist" {
  [ ! -d "$ROLL_HOME" ]
  run_wk setup
  [ "$status" -eq 0 ]
  [ -d "$ROLL_HOME" ]
}

@test "setup: creates ~/.roll/conventions/global/ with files" {
  run_wk setup
  [ "$status" -eq 0 ]
  [ -d "${ROLL_HOME}/conventions/global" ]
  # At least one file should be present (AGENTS.md, CLAUDE.md, or GEMINI.md)
  local count
  count=$(find "${ROLL_HOME}/conventions/global" -maxdepth 1 -type f | wc -l | tr -d ' ')
  [ "$count" -gt 0 ]
}

@test "setup: creates ~/.roll/skills/ directory" {
  run_wk setup
  [ "$status" -eq 0 ]
  [ -d "${ROLL_HOME}/skills" ]
}

@test "setup: creates ~/.roll/config.yaml" {
  run_wk setup
  [ "$status" -eq 0 ]
  [ -f "${ROLL_HOME}/config.yaml" ]
}

@test "setup: installs skills into ~/.roll/skills/" {
  run_wk setup
  [ "$status" -eq 0 ]
  # At least one skill sub-directory should be present
  local count
  count=$(find "${ROLL_HOME}/skills" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ')
  [ "$count" -gt 0 ]
}

# ─── Scenario 2: setup is idempotent ─────────────────────────────────────────

@test "setup: running twice does not error" {
  run_wk setup
  [ "$status" -eq 0 ]
  run_wk setup
  [ "$status" -eq 0 ]
}

@test "setup: WK_HOME structure is intact after running twice" {
  run_wk setup
  run_wk setup
  [ -d "${ROLL_HOME}/conventions/global" ]
  [ -d "${ROLL_HOME}/skills" ]
  [ -f "${ROLL_HOME}/config.yaml" ]
}

# ─── Scenario 3: setup creates skill symlinks when AI tool dirs exist ─────────

@test "setup: creates ~/.claude/skills/ directory after setup" {
  run_wk setup
  [ "$status" -eq 0 ]
  [ -d "${TEST_TMP}/.claude/skills" ]
}

@test "setup: ~/.claude/skills/ contains wk-* symlinks" {
  run_wk setup
  [ "$status" -eq 0 ]
  local count
  count=$(find "${TEST_TMP}/.claude/skills" -maxdepth 1 -mindepth 1 -type l -name "wk-*" | wc -l | tr -d ' ')
  [ "$count" -gt 0 ]
}

@test "setup: wk-* symlinks in ~/.claude/skills/ point to ~/.roll/skills/" {
  run_wk setup
  [ "$status" -eq 0 ]
  local broken=0
  for link in "${TEST_TMP}/.claude/skills"/wk-*; do
    [ -L "$link" ] || continue
    local target
    target="$(readlink "$link")"
    # Each symlink must point into WK_HOME/skills/
    [[ "$target" == "${ROLL_HOME}/skills/"* ]] || broken=$((broken + 1))
  done
  [ "$broken" -eq 0 ]
}

@test "setup: creates ~/.gemini/skills/ symlinks when ~/.gemini/ exists" {
  run_wk setup
  [ "$status" -eq 0 ]
  [ -d "${TEST_TMP}/.gemini/skills" ]
  local count
  count=$(find "${TEST_TMP}/.gemini/skills" -maxdepth 1 -mindepth 1 -type l -name "wk-*" | wc -l | tr -d ' ')
  [ "$count" -gt 0 ]
}

# ─── Scenario 4: config.yaml is not overwritten if it already exists ──────────

@test "setup: does not overwrite existing config.yaml" {
  mkdir -p "$ROLL_HOME"
  echo "custom: value" > "${ROLL_HOME}/config.yaml"

  run_wk setup
  [ "$status" -eq 0 ]

  # The custom content must still be present
  grep -q "custom: value" "${ROLL_HOME}/config.yaml"
}

@test "setup: preserves entire content of pre-existing config.yaml" {
  mkdir -p "$ROLL_HOME"
  local original_content="# My custom config
custom_key: custom_value
another_key: 42"
  echo "$original_content" > "${ROLL_HOME}/config.yaml"

  run_wk setup
  [ "$status" -eq 0 ]

  local current_content
  current_content="$(cat "${ROLL_HOME}/config.yaml")"
  [ "$current_content" = "$original_content" ]
}
