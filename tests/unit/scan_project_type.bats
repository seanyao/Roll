#!/usr/bin/env bats

setup() {
  source "${BATS_TEST_DIRNAME}/../../bin/wukong"
  TEST_TMP="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TMP"
}

@test "scan: empty dir → unknown" {
  run scan_project_type_from_files "$TEST_TMP"
  [ "$status" -eq 0 ]
  [ "$output" = "unknown" ]
}

@test "scan: has src/ directory → frontend-only" {
  mkdir "$TEST_TMP/src"
  run scan_project_type_from_files "$TEST_TMP"
  [ "$status" -eq 0 ]
  [ "$output" = "frontend-only" ]
}

@test "scan: has src/ + api/ directories → fullstack" {
  mkdir "$TEST_TMP/src"
  mkdir "$TEST_TMP/api"
  run scan_project_type_from_files "$TEST_TMP"
  [ "$status" -eq 0 ]
  [ "$output" = "fullstack" ]
}

@test "scan: has go.mod (no frontend) → backend-service" {
  touch "$TEST_TMP/go.mod"
  run scan_project_type_from_files "$TEST_TMP"
  [ "$status" -eq 0 ]
  [ "$output" = "backend-service" ]
}

@test "scan: has bin/ directory (no frontend) → cli" {
  mkdir "$TEST_TMP/bin"
  run scan_project_type_from_files "$TEST_TMP"
  [ "$status" -eq 0 ]
  [ "$output" = "cli" ]
}

@test "scan: package.json with react + api/ directory → fullstack" {
  echo '{"dependencies": {"react": "^18.0.0"}}' > "$TEST_TMP/package.json"
  mkdir "$TEST_TMP/api"
  run scan_project_type_from_files "$TEST_TMP"
  [ "$status" -eq 0 ]
  [ "$output" = "fullstack" ]
}

@test "scan: has main.py (no frontend) → backend-service" {
  touch "$TEST_TMP/main.py"
  run scan_project_type_from_files "$TEST_TMP"
  [ "$status" -eq 0 ]
  [ "$output" = "backend-service" ]
}

@test "scan: prisma/schema.prisma present (no frontend) → backend-service" {
  mkdir -p "$TEST_TMP/prisma"
  touch "$TEST_TMP/prisma/schema.prisma"
  run scan_project_type_from_files "$TEST_TMP"
  [ "$status" -eq 0 ]
  [ "$output" = "backend-service" ]
}
