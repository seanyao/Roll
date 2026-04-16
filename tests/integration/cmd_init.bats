#!/usr/bin/env bats
# Integration tests for: roll init
# Covers three paths:
#   1. Fresh project  — empty dir + type arg → create AGENTS.md + scaffold
#   2. Refresh        — existing AGENTS.md   → re-merge, no scaffold re-run
#   3. Legacy project — has code, no AGENTS.md (light smoke test)
#
# US-REF-006 regression: scaffold must NOT create docs/plans/
#   The test "scaffold does not create docs/plans/" is intentionally RED
#   until the bug is fixed in US-REF-006.

load helpers

setup() {
  integration_setup
  # WK_HOME must be ready before init can run
  run_wk setup
  # Isolated project directory (empty = fresh project)
  PROJECT_DIR="${TEST_TMP}/myproject"
  mkdir -p "$PROJECT_DIR"
}

teardown() {
  integration_teardown
}

# ─── Helper: run roll init inside PROJECT_DIR with piped stdin ───────────────
# The pipe must wrap the entire inner bash -c so stdin flows into wukong.
# Usage: wk_init <stdin> <type_arg>
#   stdin    — string piped to wukong (handles interactive prompts)
#   type_arg — e.g. "fullstack" (empty string = no type)
wk_init() {
  local stdin_str="$1"
  local type_arg="${2:-}"
  # printf feeds stdin into the inner bash which cd's then runs wukong.
  # We must NOT use `run` here — callers do that around wk_init.
  printf '%s' "$stdin_str" | \
    bash -c "cd '${PROJECT_DIR}' && HOME='${TEST_TMP}' ROLL_HOME='${ROLL_HOME}' '${ROLL_BIN}' init ${type_arg}"
}

# ─── Scenario 1: Fresh project (empty dir + type arg) ─────────────────────────

@test "init fullstack: creates AGENTS.md in empty project" {
  # Prompts: tool choice ("c" = Claude only), scaffold confirmation (empty = Y)
  run wk_init $'c\n\n' "fullstack"
  [ "$status" -eq 0 ]
  [ -f "${PROJECT_DIR}/AGENTS.md" ]
}

@test "init fullstack: scaffold creates docs/features/" {
  run wk_init $'c\n\n' "fullstack"
  [ "$status" -eq 0 ]
  [ -d "${PROJECT_DIR}/docs/features" ]
}

# US-REF-006 regression — this test is intentionally RED until the bug is fixed.
# scaffold_new_project currently calls _mkscaffold "$dir/docs/plans" (line ~819 in bin/roll)
# which must be removed as part of US-REF-006.
@test "init fullstack scaffold: does NOT create docs/plans/ (US-REF-006)" {
  run wk_init $'c\n\n' "fullstack"
  [ "$status" -eq 0 ]
  # EXPECTED TO FAIL until US-REF-006 is fixed:
  [ ! -d "${PROJECT_DIR}/docs/plans" ]
}

@test "init fullstack: scaffold creates BACKLOG.md" {
  run wk_init $'c\n\n' "fullstack"
  [ "$status" -eq 0 ]
  [ -f "${PROJECT_DIR}/BACKLOG.md" ]
}

@test "init fullstack: scaffold creates src/ directory" {
  run wk_init $'c\n\n' "fullstack"
  [ "$status" -eq 0 ]
  [ -d "${PROJECT_DIR}/src" ]
}

@test "init fullstack: scaffold creates api/ directory" {
  run wk_init $'c\n\n' "fullstack"
  [ "$status" -eq 0 ]
  [ -d "${PROJECT_DIR}/api" ]
}

@test "init cli: scaffold creates cmd/ directory, not src/" {
  run wk_init $'c\n\n' "cli"
  [ "$status" -eq 0 ]
  [ -d "${PROJECT_DIR}/cmd" ]
  [ ! -d "${PROJECT_DIR}/src" ]
}

# ─── Scenario 2: Refresh (AGENTS.md already exists + same type) ───────────────

@test "init refresh: exits 0 when AGENTS.md already present" {
  # First init to create AGENTS.md
  run wk_init $'c\n\n' "fullstack"
  [ "$status" -eq 0 ]
  [ -f "${PROJECT_DIR}/AGENTS.md" ]

  # Second init without type arg — auto-detect type from AGENTS.md,
  # press Enter to accept detected type (re-merge path, no scaffold prompt).
  run wk_init $'\n' ""
  [ "$status" -eq 0 ]
}

@test "init refresh: AGENTS.md still exists after second init" {
  run wk_init $'c\n\n' "fullstack"
  run wk_init $'\n' ""
  [ -f "${PROJECT_DIR}/AGENTS.md" ]
}

@test "init refresh: AGENTS.md content unchanged after idempotent re-merge" {
  run wk_init $'c\n\n' "fullstack"
  local content_before
  content_before="$(cat "${PROJECT_DIR}/AGENTS.md")"

  # Re-run init — detect+keep same type → refresh (merge with no changes)
  run wk_init $'\n' ""

  local content_after
  content_after="$(cat "${PROJECT_DIR}/AGENTS.md")"
  [ "$content_before" = "$content_after" ]
}

# ─── Scenario 3: Legacy project (has code, no AGENTS.md) ──────────────────────

@test "init legacy: creates AGENTS.md when package.json present" {
  # Simulate legacy project with existing source code
  echo '{"name":"legacy-app"}' > "${PROJECT_DIR}/package.json"

  # Type given → tool selection → scaffold_legacy_project runs (not fresh).
  # Decline all legacy scaffold prompts to keep the test minimal.
  run wk_init $'c\nn\nn\nn\nn\nn\nn\n' "fullstack"
  [ "$status" -eq 0 ]
  [ -f "${PROJECT_DIR}/AGENTS.md" ]
}

@test "init legacy: docs/plans/ absent when user declines all scaffold prompts" {
  echo '{"name":"legacy-app"}' > "${PROJECT_DIR}/package.json"

  run wk_init $'c\nn\nn\nn\nn\nn\nn\n' "fullstack"
  [ "$status" -eq 0 ]
  [ ! -d "${PROJECT_DIR}/docs/plans" ]
}

# ─── Scenario 4: Error handling ───────────────────────────────────────────────

@test "init: exits non-zero when WK_TEMPLATES not found (setup not run)" {
  local empty_wk="${TEST_TMP}/empty_wk"
  mkdir -p "$empty_wk"
  run bash -c "cd '${PROJECT_DIR}' && HOME='${TEST_TMP}' ROLL_HOME='${empty_wk}' '${ROLL_BIN}' init fullstack"
  [ "$status" -ne 0 ]
}
