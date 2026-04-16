#!/usr/bin/env bats

setup() {
  source "${BATS_TEST_DIRNAME}/../../bin/wukong"
  TEST_TMP="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TMP"
}

@test "ai_tool_name: ~/.claude → claude (strips leading dot)" {
  run ai_tool_name "$HOME/.claude"
  [ "$status" -eq 0 ]
  [ "$output" = "claude" ]
}

@test "ai_tool_name: ~/.gemini → gemini (strips leading dot)" {
  run ai_tool_name "$HOME/.gemini"
  [ "$status" -eq 0 ]
  [ "$output" = "gemini" ]
}

@test "ai_tool_name: ~/.openclaw/workspace → openclaw (workspace uses parent dir)" {
  run ai_tool_name "$HOME/.openclaw/workspace"
  [ "$status" -eq 0 ]
  [ "$output" = "openclaw" ]
}

@test "ai_tool_name: /home/user/.cursor → cursor (strips leading dot)" {
  run ai_tool_name "/home/user/.cursor"
  [ "$status" -eq 0 ]
  [ "$output" = "cursor" ]
}

@test "ai_tool_name: ~/.kimi → kimi (strips leading dot)" {
  run ai_tool_name "$HOME/.kimi"
  [ "$status" -eq 0 ]
  [ "$output" = "kimi" ]
}
