#!/usr/bin/env bats
# Integration tests for: roll init (simplified — US-CLI-001)
# New behavior: no type prompt, no tool prompt, no scaffold — 3-step init only.
#   1. Fresh project  → creates AGENTS.md + BACKLOG.md + docs/features/
#   2. Existing AGENTS.md → re-merges global conventions (idempotent)

load helpers

setup() {
  integration_setup
  run_wk setup
  PROJECT_DIR="${TEST_TMP}/myproject"
  mkdir -p "$PROJECT_DIR"
}

teardown() {
  integration_teardown
}

# Helper: run roll init inside PROJECT_DIR — no stdin needed (no prompts)
wk_init() {
  bash -c "cd '${PROJECT_DIR}' && HOME='${TEST_TMP}' ROLL_HOME='${ROLL_HOME}' '${ROLL_BIN}' init"
}

# ─── Happy path: fresh project ─────────────────────────────────────────────────

@test "init: creates AGENTS.md in new project" {
  run wk_init
  [ "$status" -eq 0 ]
  [ -f "${PROJECT_DIR}/AGENTS.md" ]
}

@test "init: creates BACKLOG.md in new project" {
  run wk_init
  [ "$status" -eq 0 ]
  [ -f "${PROJECT_DIR}/BACKLOG.md" ]
}

@test "init: creates docs/features/ in new project" {
  run wk_init
  [ "$status" -eq 0 ]
  [ -d "${PROJECT_DIR}/docs/features" ]
}

# ─── Happy path: re-merge (existing AGENTS.md) ────────────────────────────────

@test "init: re-merge exits 0 when AGENTS.md already exists" {
  run wk_init
  [ "$status" -eq 0 ]
  [ -f "${PROJECT_DIR}/AGENTS.md" ]

  # Second init — no prompts, should succeed and preserve AGENTS.md
  run wk_init
  [ "$status" -eq 0 ]
  [ -f "${PROJECT_DIR}/AGENTS.md" ]
}

# ─── UX: clean completion message ────────────────────────────────────────────

@test "init: output includes 'Initialized' on success" {
  run wk_init
  [ "$status" -eq 0 ]
  [[ "$output" == *"Initialized"* ]]
}

# ─── Error path ────────────────────────────────────────────────────────────────

@test "init: exits non-zero when templates not found (setup not run)" {
  local empty_wk="${TEST_TMP}/empty_wk"
  mkdir -p "$empty_wk"
  run bash -c "cd '${PROJECT_DIR}' && HOME='${TEST_TMP}' ROLL_HOME='${empty_wk}' '${ROLL_BIN}' init"
  [ "$status" -ne 0 ]
}
