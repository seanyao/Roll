#!/usr/bin/env bats

# Load the script (sourcing defines all functions without executing main)
setup() {
  source "${BATS_TEST_DIRNAME}/../../bin/wukong"
  # Override WK_CONFIG after sourcing — the script assigns WK_CONFIG on load,
  # so we must set it afterwards to point at our fixture.
  export WK_CONFIG="${BATS_TEST_DIRNAME}/../fixtures/configs/basic.yaml"
}

@test "config_get: returns value for existing key" {
  run config_get "editor"
  [ "$status" -eq 0 ]
  [ "$output" = "vim" ]
}

@test "config_get: returns default for missing key" {
  run config_get "nonexistent_key" "fallback_value"
  [ "$status" -eq 0 ]
  [ "$output" = "fallback_value" ]
}

@test "config_get: expands ~ to HOME" {
  run config_get "sync_claude"
  [ "$status" -eq 0 ]
  [ "$output" = "${HOME}/.claude/CLAUDE.md" ]
}

@test "config_get: returns default when config file missing" {
  export WK_CONFIG="/tmp/wukong_nonexistent_config_$$.yaml"
  run config_get "editor" "default_editor"
  [ "$status" -eq 0 ]
  [ "$output" = "default_editor" ]
}

@test "config_get: returns default when value is empty" {
  run config_get "empty_val" "default_for_empty"
  [ "$status" -eq 0 ]
  [ "$output" = "default_for_empty" ]
}
