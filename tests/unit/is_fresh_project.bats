#!/usr/bin/env bats

setup() {
  source "${BATS_TEST_DIRNAME}/../../bin/wukong"
  TEST_TMP="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TMP"
}

@test "is_fresh_project: empty directory → fresh (returns 0)" {
  run is_fresh_project "$TEST_TMP"
  [ "$status" -eq 0 ]
}

@test "is_fresh_project: has package.json → not fresh (returns 1)" {
  touch "$TEST_TMP/package.json"
  run is_fresh_project "$TEST_TMP"
  [ "$status" -eq 1 ]
}

@test "is_fresh_project: has go.mod → not fresh (returns 1)" {
  touch "$TEST_TMP/go.mod"
  run is_fresh_project "$TEST_TMP"
  [ "$status" -eq 1 ]
}

@test "is_fresh_project: has src/ directory → not fresh (returns 1)" {
  mkdir "$TEST_TMP/src"
  run is_fresh_project "$TEST_TMP"
  [ "$status" -eq 1 ]
}

@test "is_fresh_project: has Cargo.toml → not fresh (returns 1)" {
  touch "$TEST_TMP/Cargo.toml"
  run is_fresh_project "$TEST_TMP"
  [ "$status" -eq 1 ]
}
