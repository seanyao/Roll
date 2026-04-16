#!/usr/bin/env bats
# Sanity check: framework is working

@test "bats framework is operational" {
  run echo "hello"
  [ "$status" -eq 0 ]
  [ "$output" = "hello" ]
}

@test "bin/roll can be sourced without executing main" {
  run bash -c "source \"${BATS_TEST_DIRNAME}/../../bin/roll\" && type config_get | head -1"
  [ "$status" -eq 0 ]
  [[ "$output" == *"config_get is a function"* ]]
}
