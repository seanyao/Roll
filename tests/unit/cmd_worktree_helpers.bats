#!/usr/bin/env bats
# Unit tests for worktree helper functions in bin/roll

setup() {
  # Source bin/roll to load helper functions without executing main
  # shellcheck disable=SC1090
  source "${BATS_TEST_DIRNAME}/../../bin/roll"
  TEST_TMP="$(mktemp -d)"
}

teardown() {
  [[ -n "${TEST_TMP:-}" ]] && rm -rf "$TEST_TMP"
}

# ─── _wt_dir ──────────────────────────────────────────────────────────────────

@test "_wt_dir: lowercases story ID" {
  result="$(_wt_dir "US-FEAT-001")"
  [ "$result" = ".worktrees/us-feat-001" ]
}

@test "_wt_dir: handles multi-segment ID" {
  result="$(_wt_dir "US-CLI-002")"
  [ "$result" = ".worktrees/us-cli-002" ]
}

# ─── _wt_branch ───────────────────────────────────────────────────────────────

@test "_wt_branch: adds wt/ prefix and lowercases" {
  result="$(_wt_branch "US-FEAT-001")"
  [ "$result" = "wt/us-feat-001" ]
}

@test "_wt_branch: does not double-prefix" {
  result="$(_wt_branch "US-CLI-003")"
  [ "$result" = "wt/us-cli-003" ]
}

# ─── _validate_story_id ───────────────────────────────────────────────────────

@test "_validate_story_id: accepts US-FEAT-001" {
  run _validate_story_id "US-FEAT-001"
  [ "$status" -eq 0 ]
}

@test "_validate_story_id: accepts US-CLI-123" {
  run _validate_story_id "US-CLI-123"
  [ "$status" -eq 0 ]
}

@test "_validate_story_id: rejects lowercase id" {
  run _validate_story_id "us-feat-001"
  [ "$status" -ne 0 ]
}

@test "_validate_story_id: rejects missing number segment" {
  run _validate_story_id "US-FEAT"
  [ "$status" -ne 0 ]
}

@test "_validate_story_id: rejects single-segment id" {
  run _validate_story_id "US-001"
  [ "$status" -ne 0 ]
}

# ─── _backlog_set_status ──────────────────────────────────────────────────────

@test "_backlog_set_status: rewrites status column for matching row" {
  cat > "${TEST_TMP}/BACKLOG.md" <<'EOF'
| [US-FEAT-001](docs/features/x.md#us-feat-001) | My Feature | 📋 Todo |
EOF
  cd "$TEST_TMP"
  run _backlog_set_status "US-FEAT-001" "🔄 Active"
  [ "$status" -eq 0 ]
  grep -q "🔄 Active" BACKLOG.md
}

@test "_backlog_set_status: does not alter other rows" {
  cat > "${TEST_TMP}/BACKLOG.md" <<'EOF'
| [US-FEAT-001](docs/features/x.md#us-feat-001) | Feature 1 | 📋 Todo |
| [US-FEAT-002](docs/features/x.md#us-feat-002) | Feature 2 | 📋 Todo |
EOF
  cd "$TEST_TMP"
  _backlog_set_status "US-FEAT-001" "🔄 Active"
  grep -q "US-FEAT-002.*📋 Todo" BACKLOG.md
}

@test "_backlog_set_status: returns non-zero when story not in file" {
  echo "# empty backlog" > "${TEST_TMP}/BACKLOG.md"
  cd "$TEST_TMP"
  run _backlog_set_status "US-MISSING-001" "🔄 Active"
  [ "$status" -ne 0 ]
}

@test "_backlog_set_status: can revert Active back to Todo" {
  cat > "${TEST_TMP}/BACKLOG.md" <<'EOF'
| [US-FEAT-001](docs/features/x.md#us-feat-001) | My Feature | 🔄 Active |
EOF
  cd "$TEST_TMP"
  run _backlog_set_status "US-FEAT-001" "📋 Todo"
  [ "$status" -eq 0 ]
  grep -q "📋 Todo" BACKLOG.md
}
