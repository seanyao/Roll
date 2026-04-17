#!/usr/bin/env bats
# Integration tests for: roll worktree add|list|remove|finish

load helpers

setup() {
  integration_setup
  run_wk setup

  # Create a real git repo for worktree operations
  PROJECT_DIR="${TEST_TMP}/myproject"
  mkdir -p "$PROJECT_DIR"
  git -C "$PROJECT_DIR" init -b main >/dev/null 2>&1 || \
    git -C "$PROJECT_DIR" init >/dev/null 2>&1
  git -C "$PROJECT_DIR" config user.email "test@test.com"
  git -C "$PROJECT_DIR" config user.name "Test"

  # Seed BACKLOG.md with a story row
  cat > "$PROJECT_DIR/BACKLOG.md" <<'EOF'
# Backlog

## Epic: Test

| Story | Description | Status |
|-------|-------------|--------|
| [US-TEST-001](docs/features/test.md#us-test-001) | Test story one | 📋 Todo |
| [US-TEST-002](docs/features/test.md#us-test-002) | Test story two | 📋 Todo |
EOF

  git -C "$PROJECT_DIR" add .
  git -C "$PROJECT_DIR" commit -m "init" >/dev/null 2>&1

  # Ensure .worktrees is gitignored
  echo ".worktrees/" > "$PROJECT_DIR/.gitignore"
  git -C "$PROJECT_DIR" add .gitignore
  git -C "$PROJECT_DIR" commit -m "chore: add gitignore" >/dev/null 2>&1
}

teardown() {
  # Clean up any worktrees before removing temp dir
  if [[ -d "${PROJECT_DIR:-}" ]]; then
    git -C "$PROJECT_DIR" worktree list --porcelain 2>/dev/null | \
      grep "^worktree " | grep "/.worktrees/" | \
      awk '{print $2}' | \
      while read -r wt; do
        git -C "$PROJECT_DIR" worktree remove "$wt" --force 2>/dev/null || true
      done
  fi
  integration_teardown
}

# Helper: run roll worktree inside PROJECT_DIR
wk_wt() {
  bash -c "cd '${PROJECT_DIR}' && HOME='${TEST_TMP}' ROLL_HOME='${ROLL_HOME}' '${ROLL_BIN}' worktree $*"
}

# ─── worktree add ─────────────────────────────────────────────────────────────

@test "worktree add: creates .worktrees/us-test-001 directory" {
  run wk_wt "add US-TEST-001"
  [ "$status" -eq 0 ]
  [ -d "${PROJECT_DIR}/.worktrees/us-test-001" ]
}

@test "worktree add: creates wt/us-test-001 branch" {
  run wk_wt "add US-TEST-001"
  [ "$status" -eq 0 ]
  run git -C "$PROJECT_DIR" show-ref --verify "refs/heads/wt/us-test-001"
  [ "$status" -eq 0 ]
}

@test "worktree add: updates BACKLOG.md status to 🔄 Active" {
  run wk_wt "add US-TEST-001"
  [ "$status" -eq 0 ]
  grep -q "🔄 Active" "${PROJECT_DIR}/BACKLOG.md"
}

@test "worktree add: does not affect other story rows" {
  run wk_wt "add US-TEST-001"
  [ "$status" -eq 0 ]
  grep -q "US-TEST-002.*📋 Todo" "${PROJECT_DIR}/BACKLOG.md"
}

@test "worktree add: fails if worktree already exists" {
  wk_wt "add US-TEST-001" >/dev/null 2>&1
  run wk_wt "add US-TEST-001"
  [ "$status" -ne 0 ]
  [[ "$output" == *"already exists"* ]]
}

@test "worktree add: rejects invalid story ID format" {
  run wk_wt "add feat-001"
  [ "$status" -ne 0 ]
}

@test "worktree add: rejects story ID missing number" {
  run wk_wt "add US-FEAT"
  [ "$status" -ne 0 ]
}

# ─── worktree list ────────────────────────────────────────────────────────────

@test "worktree list: reports no active worktrees when none exist" {
  run wk_wt "list"
  [ "$status" -eq 0 ]
  [[ "$output" == *"No active worktrees"* ]]
}

@test "worktree list: shows story after add" {
  wk_wt "add US-TEST-001" >/dev/null 2>&1
  run wk_wt "list"
  [ "$status" -eq 0 ]
  [[ "$output" == *"US-TEST-001"* ]]
}

@test "worktree list: shows both stories when two worktrees active" {
  wk_wt "add US-TEST-001" >/dev/null 2>&1
  wk_wt "add US-TEST-002" >/dev/null 2>&1
  run wk_wt "list"
  [ "$status" -eq 0 ]
  [[ "$output" == *"US-TEST-001"* ]]
  [[ "$output" == *"US-TEST-002"* ]]
}

# ─── worktree remove ──────────────────────────────────────────────────────────

@test "worktree remove: removes worktree directory when confirmed" {
  wk_wt "add US-TEST-001" >/dev/null 2>&1
  run bash -c "echo y | bash -c \"cd '${PROJECT_DIR}' && HOME='${TEST_TMP}' ROLL_HOME='${ROLL_HOME}' '${ROLL_BIN}' worktree remove US-TEST-001\""
  [ "$status" -eq 0 ]
  [ ! -d "${PROJECT_DIR}/.worktrees/us-test-001" ]
}

@test "worktree remove: reverts BACKLOG status to 📋 Todo" {
  wk_wt "add US-TEST-001" >/dev/null 2>&1
  bash -c "echo y | bash -c \"cd '${PROJECT_DIR}' && HOME='${TEST_TMP}' ROLL_HOME='${ROLL_HOME}' '${ROLL_BIN}' worktree remove US-TEST-001\"" >/dev/null 2>&1
  grep -q "US-TEST-001.*📋 Todo" "${PROJECT_DIR}/BACKLOG.md"
}

@test "worktree remove: aborts when user answers n" {
  wk_wt "add US-TEST-001" >/dev/null 2>&1
  run bash -c "echo n | bash -c \"cd '${PROJECT_DIR}' && HOME='${TEST_TMP}' ROLL_HOME='${ROLL_HOME}' '${ROLL_BIN}' worktree remove US-TEST-001\""
  [ -d "${PROJECT_DIR}/.worktrees/us-test-001" ]
}

@test "worktree remove: fails when worktree does not exist" {
  run bash -c "echo y | bash -c \"cd '${PROJECT_DIR}' && HOME='${TEST_TMP}' ROLL_HOME='${ROLL_HOME}' '${ROLL_BIN}' worktree remove US-TEST-001\""
  [ "$status" -ne 0 ]
}

# ─── worktree finish ──────────────────────────────────────────────────────────

@test "worktree finish: merges branch and removes worktree directory" {
  wk_wt "add US-TEST-001" >/dev/null 2>&1
  # Make a commit in the worktree to have something to merge
  echo "change" >> "${PROJECT_DIR}/.worktrees/us-test-001/BACKLOG.md"
  git -C "${PROJECT_DIR}/.worktrees/us-test-001" add . >/dev/null 2>&1
  git -C "${PROJECT_DIR}/.worktrees/us-test-001" commit -m "feat: test change" >/dev/null 2>&1

  run wk_wt "finish US-TEST-001"
  [ "$status" -eq 0 ]
  [ ! -d "${PROJECT_DIR}/.worktrees/us-test-001" ]
}

@test "worktree finish: deletes wt branch after merge" {
  wk_wt "add US-TEST-001" >/dev/null 2>&1
  echo "change" >> "${PROJECT_DIR}/.worktrees/us-test-001/BACKLOG.md"
  git -C "${PROJECT_DIR}/.worktrees/us-test-001" add . >/dev/null 2>&1
  git -C "${PROJECT_DIR}/.worktrees/us-test-001" commit -m "feat: test change" >/dev/null 2>&1

  wk_wt "finish US-TEST-001" >/dev/null 2>&1

  run git -C "$PROJECT_DIR" show-ref --verify "refs/heads/wt/us-test-001"
  [ "$status" -ne 0 ]
}

@test "worktree finish: fails when worktree has uncommitted changes" {
  wk_wt "add US-TEST-001" >/dev/null 2>&1
  echo "uncommitted" >> "${PROJECT_DIR}/.worktrees/us-test-001/BACKLOG.md"

  run wk_wt "finish US-TEST-001"
  [ "$status" -ne 0 ]
  [[ "$output" == *"uncommitted"* ]]
}

# ─── help ─────────────────────────────────────────────────────────────────────

@test "worktree help: shows subcommand list" {
  run wk_wt "help"
  [ "$status" -eq 0 ]
  [[ "$output" == *"add"* ]]
  [[ "$output" == *"list"* ]]
  [[ "$output" == *"remove"* ]]
  [[ "$output" == *"finish"* ]]
}
