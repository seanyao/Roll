# Wukong Engineering Common Sense Checklist

> **These are not best practices — they are baseline requirements.** Violations are bugs.

## 1. Idempotency 🔁

**Definition:** Performing the same operation N times produces the same result as performing it once.

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
- [ ] State transitions
- [ ] API calls
- [ ] File writes

**Counter-example (this time):** Running ingest repeatedly → files duplicated 7 times

---

## 2. Cross-Module Contract Consistency 🔗

**Definition:** Data/IDs/formats shared across multiple modules must be fully consistent.

**Must check:**
```typescript
// Checklist
- [ ] Is the ID generation algorithm consistent?
- [ ] Is the data serialization format consistent?
- [ ] Is path handling consistent? (e.g., / vs -)
- [ ] Is it extracted into a shared function/constant?
```

**Test template:**
```typescript
it('should generate same ID across modules', () => {
  const scannerId = generateScannerId('articles/test.md')
  const inboxId = generateInboxId('articles/test.md')
  expect(scannerId).toEqual(inboxId)
})
```

**Counter-example (this time):** Scanner replaces `/` with `-`, inbox uses raw path → deduplication fails

---

## 3. Data Flow Integrity 🌊

**Definition:** The complete data pipeline from producer to consumer must be unobstructed.

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

**Counter-example (this time):** Ingest doesn't write state, status can't read it → displays 0

---

## 4. Atomicity ⚛️

**Definition:** An operation either fully succeeds or doesn't execute at all (no intermediate states).

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
    // After failure, already-processed items should be rolled back
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
- [ ] What happens when an external API fails?
- [ ] What happens when the database connection drops?
- [ ] Is there a fallback mechanism?
- [ ] What feedback does the user receive?

**Test template:**
```typescript
it('should degrade gracefully when dependency fails', async () => {
  mockDependency.toThrow('Network error')
  
  // Should not crash
  const result = await operation()
  
  // Should return a fallback value or partial result
  expect(result).toEqual(fallbackValue)
})
```

---

## 7. Observability 👁️

**Definition:** System state must be visible and traceable.

**Must provide:**
- [ ] Progress feedback (for long-running operations)
- [ ] State query interface (e.g., status command)
- [ ] Error logs (failure reasons)
- [ ] Key metrics (counts, durations)

**Improvements made this time:**
- Added `kkb status` to show raw files statistics ✅
- Added `kkb compile` progress feedback ✅

---

## 8. Concurrency Safety 🧵

**Definition:** Access to shared resources across multiple threads/processes must be safe.

**Must consider:**
- [ ] File read/write conflicts
- [ ] Database transaction isolation level
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

During the **Test Design Review** phase of each Story, the following must be answered:

```markdown
### Engineering Common Sense Checklist
- [ ] **Idempotency**: Can it be run repeatedly? Are there tests?
- [ ] **Cross-module contract**: Are IDs/formats/algorithms consistent?
- [ ] **Data flow**: Is the producer → consumer pipeline complete?
- [ ] **Atomicity**: Does partial failure trigger a rollback?
- [ ] **Input validation**: Are all inputs validated?
- [ ] **Graceful degradation**: What happens when a dependency fails?
- [ ] **Observability**: Can the user see progress/status?
- [ ] **Concurrency safety**: Is multi-threaded access safe?

**If any item is not satisfied, tests/design must be added before writing implementation code.**
```

---

## Automated Protection

### Sentinel Patrol Rules
```yaml
# .github/roll-sentinel-config.yml
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

### Pre-Commit Hook
```bash
#!/bin/bash
# .git/hooks/pre-commit
echo "🔍 Checking engineering common sense..."

# Check for idempotency tests
if git diff --cached --name-only | grep -q "ingest\|import\|sync"; then
  if ! grep -r "idempotency\|repeated run\|multiple times" tests/ 2>/dev/null; then
    echo "❌ Missing idempotency tests!"
    exit 1
  fi
fi

echo "✅ Basic checks passed"
```
