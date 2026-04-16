#!/usr/bin/env bash
# Shared helpers for integration tests.
# Load with: load helpers  (from a .bats file in tests/integration/)

# Creates an isolated temp environment and sets all ROLL_ vars.
# Call in setup() of each integration test file.
integration_setup() {
  TEST_TMP="$(mktemp -d)"
  export ROLL_HOME="${TEST_TMP}/.roll"
  export ROLL_CONFIG="${ROLL_HOME}/config.yaml"
  export ROLL_GLOBAL="${ROLL_HOME}/conventions/global"
  export ROLL_TEMPLATES="${ROLL_HOME}/conventions/templates"

  # Fake AI client dirs so sync/link operations have targets
  mkdir -p "${TEST_TMP}/.claude"
  mkdir -p "${TEST_TMP}/.gemini"

  # Convenience: absolute path to the binary under test
  ROLL_BIN="${BATS_TEST_DIRNAME}/../../bin/roll"
}

# Cleans up the temp tree after each test.
integration_teardown() {
  [[ -n "${TEST_TMP:-}" ]] && rm -rf "$TEST_TMP"
}

# Run roll with TEST_TMP as HOME so ~ expansions resolve inside sandbox.
# Usage: run_wk <cmd> [args...]
run_wk() {
  ROLL_HOME="${ROLL_HOME}" HOME="${TEST_TMP}" run bash "$ROLL_BIN" "$@"
}
