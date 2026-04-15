# Wukong Engineering Common Sense Checklist

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

## Automated Safeguards

### Sentinel Patrol Rules
```yaml
# .github/wk-sentinel-config.yml
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

# Check idempotency tests
if git diff --cached --name-only | grep -q "ingest\|import\|sync"; then
  if ! grep -r "idempotency\|repeated run\|multiple times" tests/ 2>/dev/null; then
    echo "❌ Missing idempotency tests!"
    exit 1
  fi
fi

echo "✅ Basic checks passed"
```
