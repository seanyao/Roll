#!/usr/bin/env bash
# Shared helpers for integration tests.
# Load with: load helpers  (from a .bats file in tests/integration/)

# Creates an isolated temp environment and sets all WK_ vars.
# Call in setup() of each integration test file.
integration_setup() {
  TEST_TMP="$(mktemp -d)"
  export WK_HOME="${TEST_TMP}/.wukong"
  export WK_CONFIG="${WK_HOME}/config.yaml"
  export WK_GLOBAL="${WK_HOME}/conventions/global"
  export WK_TEMPLATES="${WK_HOME}/conventions/templates"

  # Fake AI client dirs so sync/link operations have targets
  mkdir -p "${TEST_TMP}/.claude"
  mkdir -p "${TEST_TMP}/.gemini"

  # Convenience: absolute path to the binary under test
  WUKONG="${BATS_TEST_DIRNAME}/../../bin/wukong"
}

# Cleans up the temp tree after each test.
integration_teardown() {
  [[ -n "${TEST_TMP:-}" ]] && rm -rf "$TEST_TMP"
}

# Run wukong with TEST_TMP as HOME so ~ expansions resolve inside sandbox.
# Usage: run_wk <cmd> [args...]
run_wk() {
  WK_HOME="${WK_HOME}" HOME="${TEST_TMP}" run bash "$WUKONG" "$@"
}
