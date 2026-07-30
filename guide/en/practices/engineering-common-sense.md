# Roll Engineering Common Sense Checklist

> **These are not best practices — they are baseline requirements.** Violations are Bugs.

## 1. Idempotency 🔁

**Definition:** Executing the same operation N times produces the same result as executing it once.

**Must test:**
```typescript
it('should be idempotent', async () => {
  await operation(data)  // 1st
  const result1 = await getState()
  
  await operation(data)  // 2nd
  const result2 = await getState()
  
  await operation(data)  // 3rd
  const result3 = await getState()
  
  expect(result1).toEqual(result2)
  expect(result2).toEqual(result3)
})
```

**Common scenarios:**
- [ ] Import/ingest operations
- [ ] Configuration updates
- [ ] State changes
- [ ] API calls
- [ ] File writes

**Anti-pattern (this time):** Running ingest repeatedly -> files duplicated 7 times

---

## 2. Cross-Module Contract Consistency 🔗

**Definition:** Data/IDs/formats shared across multiple modules must be exactly consistent.

**Must check:**
```typescript
// Checklist
- [ ] Is the ID generation algorithm consistent?
- [ ] Is the data serialization format consistent?
- [ ] Is path handling consistent? (e.g., / vs -)
- [ ] Has it been extracted into a shared function/constant?
```

**Test template:**
```typescript
it('should generate same ID across modules', () => {
  const scannerId = generateScannerId('articles/test.md')
  const inboxId = generateInboxId('articles/test.md')
  expect(scannerId).toEqual(inboxId)
})
```

**Anti-pattern (this time):** Scanner used `-` to replace `/`, inbox used raw path -> deduplication failed

---

## 3. Data Flow Integrity 🌊

**Definition:** The complete pipeline from producer to consumer must be connected end-to-end.

**Must verify:**
```typescript
// Integration test - must exist
describe('Data Flow: Producer -> Consumer', () => {
  it('should write data that consumer can read', async () => {
    await producer.write(testData)
    const result = await consumer.read()
    expect(result).toEqual(testData)
  })
})
```

**Checklist:**
- [ ] Who writes the data? (Producer)
- [ ] Who reads the data? (Consumer)
- [ ] What is the intermediate storage? (state/file/cache)
- [ ] Is there an integration test to verify?

**Anti-pattern (this time):** Ingest didn't write state, status couldn't read it -> showed 0

---

## 4. Atomicity ⚛️

**Definition:** An operation either fully succeeds or does not execute at all (no intermediate state).

**Must consider:**
- [ ] How to roll back on partial failure?
- [ ] Is there a transaction mechanism?
- [ ] How is data consistency guaranteed after a crash?

**Test template:**
```typescript
it('should be atomic', async () => {
  try {
    await operation([item1, item2, INVALID_ITEM, item4])
  } catch (e) {
    // After failure, processed items should be rolled back
    const state = await getState()
    expect(state).toEqual(initialState)
  }
})
```

---

## 5. Input Validation 🛡️

**Definition:** Never trust any external input — it must be validated.

**Must check:**
- [ ] Null/undefined handling
- [ ] Type checking
- [ ] Range checking (array length, numeric range)
- [ ] Special character/injection attack protection
- [ ] File path traversal protection

**Test template:**
```typescript
it('should handle invalid inputs gracefully', async () => {
  await expect(operation(null)).rejects.toThrow()
  await expect(operation('')).rejects.toThrow()
  await expect(operation({})).rejects.toThrow()
})
```

---

## 6. Graceful Degradation 🪂

**Definition:** When a dependency fails, the system should still provide limited functionality.

**Must consider:**
- [ ] What if an external API fails?
- [ ] What if the database connection drops?
- [ ] Is there a fallback mechanism?
- [ ] What feedback does the user get?

**Test template:**
```typescript
it('should degrade gracefully when dependency fails', async () => {
  mockDependency.toThrow('Network error')
  
  // Should not crash
  const result = await operation()
  
  // Should return fallback value or partial result
  expect(result).toEqual(fallbackValue)
})
```

---

## 7. Observability 👁️

**Definition:** System state must be visible and traceable.

**Must provide:**
- [ ] Progress feedback (for long-running operations)
- [ ] Status query interface (e.g., status command)
- [ ] Error logs (failure reasons)
- [ ] Key metrics (counts, durations)

**Improvements this time:**
- Added `kkb status` showing raw files statistics ✅
- Added `kkb compile` progress feedback ✅

---

## 8. Concurrency Safety 🧵

**Definition:** Shared resource access across multiple threads/processes must be safe.

**Must consider:**
- [ ] File read/write conflicts
- [ ] Database transaction isolation levels
- [ ] Locking for shared in-memory state
- [ ] Race conditions

**Test template:**
```typescript
it('should handle concurrent writes', async () => {
  await Promise.all([
    operation(data1),
    operation(data2),
    operation(data3)
  ])
  
  // Verify final state consistency
  const state = await getState()
  expect(state).toBeValid()
})
```

---

## Mandatory Check Process

At the **Test Design Review** phase of each Story, the following must be answered:

```markdown
### Engineering Common Sense Checklist
- [ ] **Idempotency**: Can it be run repeatedly? Are there tests?
- [ ] **Cross-Module Contract**: Are IDs/formats/algorithms consistent?
- [ ] **Data Flow**: Is the producer -> consumer pipeline complete?
- [ ] **Atomicity**: Will partial failures roll back?
- [ ] **Input Validation**: Are all inputs validated?
- [ ] **Graceful Degradation**: What happens when a dependency fails?
- [ ] **Observability**: Can the user see progress/status?
- [ ] **Concurrency Safety**: Is multi-threaded access safe?

**If any item is not met, tests/design must be added before writing implementation code.**
```

---

## 9. Shell Script Performance 🐚

**Definition:** `$()` command substitution forks a subshell. In hot paths (functions called per-test, per-catalog-entry, or per-message-lookup) this is the dominant cost.

**Rule of thumb:**
- 1 subshell fork ≈ 2–3 ms on Linux
- 1000 forks in a test suite setup = +2–3 s per test run
- 1739 tests × 2.3 s = **~67 minutes of wasted CI time** (observed in this repo)

**Must avoid in hot paths:**
```bash
# ❌ Subshell fork — slow when called thousands of times
upper="$(echo "$lang" | tr '[:lower:]' '[:upper:]')"
upper="$(_some_helper_function "$lang")"
safe="$(_sanitize_key "$key")"

# ✅ Inline equivalents — zero fork
case "$lang" in
  en|EN) upper=EN ;;
  zh|ZH) upper=ZH ;;
  *)     upper="$(printf '%s' "$lang" | tr '[:lower:]' '[:upper:]')" ;;  # rare path OK
esac
safe="${key//[^A-Za-z0-9_]/_}"   # parameter expansion, no fork
printf -v "$varname" '%s' "$val"  # printf -v instead of subshell assignment
```

**Compatibility trap — the "fixed twice" anti-pattern:**
```
PR #211: fixed $(echo | tr) → ${lang^^}      ✅ fast, but bash 4+ only
PR #213: fixed bash 3.2 compat → $(_helper)  ❌ reintroduced the subshell
PR #218: fixed both → inline case             ✅ fast + bash 3.2 safe
```
When fixing for compatibility, verify the fix does not reintroduce the original problem.
Add a timing assertion or benchmark test to guard the regression.

**Dead code from inlining:**
When inlining a helper function's logic, remove the original function and grep for all callers.
A leftover function with zero callers misleads future contributors into calling it via `$()`
and reintroducing the fork.

**Must check:**
- [ ] Is this function called inside a loop, setup(), or per-entry catalog loading?
- [ ] Does it use `$()` anywhere? Can it be replaced with `case`, `${var//...}`, or `printf -v`?
- [ ] After inlining, is the original helper now dead code? Remove it.
- [ ] Is there a timing test or CI cap to catch regressions? (see `ROLL_TEST_TIME_CAP`)

---

## 10. Shell Resource Cleanup 🧹

**Definition:** Every `trap` set must be explicitly reset. Temporary files and lock files must never outlive their owning process.

**trap - EXIT pattern:**
```bash
# ❌ Dangling trap — EXIT handler persists in the calling shell after return
local tmp; tmp=$(mktemp)
trap "rm -f '$tmp'" EXIT
# ... do work ...
mv "$tmp" "$dst"
return 0   # EXIT trap still armed — any later exit fires rm on a stale path

# ✅ Always reset after use
local tmp; tmp=$(mktemp)
trap "rm -f '$tmp'" EXIT
# ... do work ...
mv "$tmp" "$dst" 2>/dev/null || rm -f "$tmp"
trap - EXIT   # disarm before return
return 0
```

**Directory scope in cleanup helpers:**
```bash
# ❌ Wrong — scans the env-var default, not the actual path in use
_cleanup_tmp() {
  local dir; dir=$(dirname "${MY_PATH:-$HOME/.default/path}")
  ...
}
_do_work() {
  local custom_path="$1"   # may differ from MY_PATH
  _cleanup_tmp             # scans wrong directory!
}

# ✅ Pass the actual directory explicitly
_cleanup_tmp() {
  local dir="${1:-$(dirname "${MY_PATH:-$HOME/.default/path}")}"
  ...
}
_do_work() {
  local custom_path="$1"
  _cleanup_tmp "$(dirname "$custom_path")"
}
```

**Must check:**
- [ ] Every `trap "…" EXIT` has a matching `trap - EXIT` before the function returns.
- [ ] Cleanup helpers accept the target directory as an argument — no implicit env-var path.
- [ ] Temporary file names are quoted in trap strings: `"rm -f '$tmp'"` not `"rm -f $tmp"`.

---

## 11. Test Reliability 🧪

**Definition:** Tests must not rely on environmental assumptions that can silently fail on different hosts.

**PID assumptions:**
```bash
# ❌ Assumes pid_max ≤ 99999 — fails silently in containers with large pid_max
local stale_tmp="runs.jsonl.tmp.99999"

# ✅ Use a process that is provably dead
bash -c 'exit 0' &
local dead_pid=$!
wait "$dead_pid" 2>/dev/null || true
local stale_tmp="runs.jsonl.tmp.${dead_pid}"
```

**Heredoc scope:**
Functions defined outside a heredoc are not available inside it when the generated
script executes. Calling them silently no-ops (if guarded with `|| true`) or crashes.
```bash
# ❌ _some_helper is not defined in the generated script's scope
cat > script.sh <<'EOF'
_some_helper 2>/dev/null || true   # silent no-op — always "succeeds"
EOF

# ✅ Either inline the logic, or define the function inside the heredoc
```

**Must check:**
- [ ] Does the test use a hardcoded PID, port, or path that may conflict on the host?
- [ ] Does the test call a function that is only defined in the outer shell, not inside a heredoc?
- [ ] Is the "dead process" check using an actual exited process, not a guessed PID?

---

## Automated Safeguards

### CI Gate Rules
```yaml
# .github/roll-checks.yml — enforced as a CI gate on every PR
checks:
  idempotency:
    - pattern: "ingest|import|sync"
      require_test: "idempotency"

  cross_module_contract:
    - files: ["src/*/index.ts"]
      check: "shared_id_generation"

  data_flow:
    - require_integration_test: true
```

These run as CI gates on every PR. Slower-burn issues — dead code, doc staleness,
structural drift — are caught by `roll-.dream`, the `roll dream run-once`
code-health scan that files `REFACTOR-XXX` entries back into the backlog.

### Pre-Commit Hook
```bash
#!/bin/bash
# .git/hooks/pre-commit
echo "🔍 Checking engineering common sense..."

# Check idempotency tests
if git diff --cached --name-only | grep -q "ingest\|import\|sync"; then
  if ! grep -r "idempotency\|repeated run\|multiple times" tests/ 2>/dev/null; then
    echo "❌ Missing idempotency tests!"
    exit 1
  fi
fi

echo "✅ Basic checks passed"
```
