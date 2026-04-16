#!/usr/bin/env bats

setup() {
  source "${BATS_TEST_DIRNAME}/../../bin/wukong"
  TEST_TMP="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TMP"
}

@test "detect: no AGENTS.md returns unknown" {
  run detect_project_type "$TEST_TMP"
  [ "$status" -eq 0 ]
  [ "$output" = "unknown" ]
}

@test "detect: AGENTS.md with 'Fullstack Web' returns fullstack" {
  echo "# Fullstack Web project" > "$TEST_TMP/AGENTS.md"
  run detect_project_type "$TEST_TMP"
  [ "$status" -eq 0 ]
  [ "$output" = "fullstack" ]
}

@test "detect: AGENTS.md with 'Backend Service' returns backend-service" {
  echo "# Backend Service project" > "$TEST_TMP/AGENTS.md"
  run detect_project_type "$TEST_TMP"
  [ "$status" -eq 0 ]
  [ "$output" = "backend-service" ]
}

@test "detect: AGENTS.md with 'Frontend Only' returns frontend-only" {
  echo "# Frontend Only project" > "$TEST_TMP/AGENTS.md"
  run detect_project_type "$TEST_TMP"
  [ "$status" -eq 0 ]
  [ "$output" = "frontend-only" ]
}

@test "detect: AGENTS.md with 'CLI Tool' returns cli" {
  echo "# CLI Tool project" > "$TEST_TMP/AGENTS.md"
  run detect_project_type "$TEST_TMP"
  [ "$status" -eq 0 ]
  [ "$output" = "cli" ]
}

@test "detect: AGENTS.md with no type marker + empty dir falls back to unknown" {
  echo "# Some project without a type marker" > "$TEST_TMP/AGENTS.md"
  run detect_project_type "$TEST_TMP"
  [ "$status" -eq 0 ]
  [ "$output" = "unknown" ]
}

@test "detect: AGENTS.md with no type marker + src/ dir falls back to frontend-only" {
  echo "# Some project without a type marker" > "$TEST_TMP/AGENTS.md"
  mkdir "$TEST_TMP/src"
  run detect_project_type "$TEST_TMP"
  [ "$status" -eq 0 ]
  [ "$output" = "frontend-only" ]
}

@test "detect: type marker matching is case-insensitive (lowercase 'fullstack web')" {
  echo "# fullstack web project" > "$TEST_TMP/AGENTS.md"
  run detect_project_type "$TEST_TMP"
  [ "$status" -eq 0 ]
  [ "$output" = "fullstack" ]
}
