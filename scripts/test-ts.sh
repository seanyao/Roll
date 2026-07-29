#!/usr/bin/env bash
# v3 TS test entry — runs the workspace vitest suites and writes the same
# proof-of-pass record hooks/pre-commit verifies (owner ruling 2026-06-05:
# the TCR gate accepts vitest proof alongside bats; bats retires after the
# porting completes). New file on the v3 branch — frozen v2 bash untouched.
set -euo pipefail

# Hermetic gate: tests must behave identically on a TTY, headless, and in CI.
# Any git credential prompt is a bug — fail it loudly instead of blocking.
export GIT_TERMINAL_PROMPT=0

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# FIX-325 — affected scope for the TCR commit gate.
# `roll test` (the per-commit gate) passes `--affected`; `npm test` (CI /
# pre-push, no flag) stays the FULL suite. Before this, `--affected` was a no-op
# and `roll test` ran the full suite — which in a cycle's worktree hits
# env-divergent failures (attest/run-cycle/npm-pack: red locally, green in CI)
# that NO change introduced. The proof could then never be written, so every
# cycle's TCR commit was blocked → the agent's green work was discarded as
# gave_up. Affected scope runs only the dependency closure of the change
# (`vitest --changed`), so a focused delivery commits on its own green tests;
# CI keeps the full suite as the real cross-package gate. (Implements FIX-135's
# original intent, which stubbed the affected path.)
SCOPE="full"
for _arg in "$@"; do
  if [ "$_arg" = "--affected" ]; then SCOPE="affected"; fi
done

pnpm -r build
node scripts/audit-role-taxonomy.mjs
if [ "$SCOPE" = "affected" ]; then
  # `--changed` (no ref) = tests covering the working-tree / uncommitted change
  # — exactly a cycle's pre-commit scope. Packages already pass --passWithNoTests,
  # so a change that touches no covered test is honestly green (0 affected).
  #
  # Affected scope alone is NOT enough: the heavy E2E/integration suites
  # (run-cycle.integration, critical-flows.e2e, npm-pack) are transitively
  # depended on by broad code, so most changes "affect" them — and they are
  # env-divergent (red locally / in a cycle worktree, GREEN in CI). Including
  # them would re-block the commit gate. Exclude them from the LOCAL affected
  # gate; CI's full `npm test` (no --affected) runs them as the real gate.
  # Making them env-portable is FIX-316; until then they gate at CI, not commit.
  # `pnpm -r test -- <flags>` injects a `--` that makes vitest treat the flags as
  # positional file filters; drive vitest directly via `exec` so --changed/--exclude
  # parse as flags. `--filter ./packages/*` runs each workspace package's vitest.
  pnpm --filter "./packages/*" exec vitest run --passWithNoTests --changed \
    --exclude '**/*.integration.test.ts' \
    --exclude '**/*.e2e.test.ts' \
    --exclude '**/npm-pack.test.ts'
else
  pnpm -r test
fi

# FIX-1264 — vitest-based obsolete snapshot guard: any .snap file without a
# corresponding test file is a landmine that silently drifts. Fail loud.
# US-CYCLE-011 (codex review): this MUST run BEFORE the proof is written — an
# orphan-snapshot `exit 1` is a FAILED run, and a failed run must never leave a
# fresh mode:"full" proof for the delivery gate to accept.
_SNAP_DIR="$REPO_ROOT/packages/cli/test/__snapshots__"
_TEST_DIR="$REPO_ROOT/packages/cli/test"
_ORPHANS=""
if [ -d "$_SNAP_DIR" ]; then
  for _snap in "$_SNAP_DIR"/*.snap; do
    [ -f "$_snap" ] || continue
    _base="$(basename "$_snap" .snap)"
    if [ ! -f "$_TEST_DIR/$_base" ]; then
      _ORPHANS="$_ORPHANS  $(basename "$_snap")\n"
    fi
  done
fi
if [ -n "$_ORPHANS" ]; then
  printf "❌ Orphan vitest snapshot files (no corresponding test):\n%b" "$_ORPHANS"
  printf "   Run vitest --update to remove them, or restore the test file.\n"
  exit 1
fi

# Proof-of-pass is written ONLY here, AFTER every failure check above has passed
# (test run + orphan-snapshot guard). Any earlier nonzero exit (set -e on the
# suites, or the orphan `exit 1`) leaves NO fresh proof — a failed run can never
# satisfy the pre-commit freshness gate or the US-CYCLE-011 full-verify gate.
_TREE="$(git -C "$REPO_ROOT" write-tree 2>/dev/null || true)"
if [ -n "$_TREE" ]; then
  mkdir -p "$REPO_ROOT/.roll"
  # US-CYCLE-011: stamp the CANONICAL proof mode the delivery full-verify gate
  # reads — SCOPE=full → mode:"full" (whole suite ran, eligible for the pre-PR
  # full-verify), SCOPE=affected → mode:"changed" (the per-commit `vitest
  # --changed` subset, NOT a full verify). `scope` is kept for back-compat.
  if [ "$SCOPE" = "full" ]; then _MODE="full"; else _MODE="changed"; fi
  printf '{"ts":%s,"tree":"%s","mode":"%s","scope":"%s"}\n' "$(date +%s)" "$_TREE" "$_MODE" "$SCOPE" \
    > "$REPO_ROOT/.roll/last-test-pass"
fi
echo "✓ TS suites green (scope: $SCOPE) — test-pass proof written (mode: $_MODE)"
