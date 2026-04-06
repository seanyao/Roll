# Cybernetix Engineering Common Sense Checklist

> **这些不是最佳实践，是底线要求。** 违反即 Bug。

## 1. 幂等性 (Idempotency) 🔁

**定义:** 同一操作执行 N 次，结果与执行 1 次相同。

**必须测试:**
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

**常见场景:**
- [ ] 导入/ingest 操作
- [ ] 配置更新
- [ ] 状态变更
- [ ] API 调用
- [ ] 文件写入

**反例 (本次):** ingest 重复运行 → 文件重复 7 次

---

## 2. 跨模块契约一致性 (Cross-Module Contract) 🔗

**定义:** 多个模块共享的数据/ID/格式必须完全一致。

**必须检查:**
```typescript
// 检查清单
- [ ] ID 生成算法是否一致？
- [ ] 数据序列化格式是否一致？
- [ ] 路径处理方式是否一致？（如 / vs -）
- [ ] 是否提取为共享函数/常量？
```

**测试模板:**
```typescript
it('should generate same ID across modules', () => {
  const scannerId = generateScannerId('articles/test.md')
  const inboxId = generateInboxId('articles/test.md')
  expect(scannerId).toEqual(inboxId)
})
```

**反例 (本次):** scanner 用 `-` 替换 `/`，inbox 用原始 path → 去重失败

---

## 3. 数据流完整性 (Data Flow Integrity) 🌊

**定义:** 数据从生产者到消费者的完整链路必须通畅。

**必须验证:**
```typescript
// 集成测试 - 必须存在
describe('Data Flow: Producer -> Consumer', () => {
  it('should write data that consumer can read', async () => {
    await producer.write(testData)
    const result = await consumer.read()
    expect(result).toEqual(testData)
  })
})
```

**检查清单:**
- [ ] 谁写入数据？（生产者）
- [ ] 谁读取数据？（消费者）
- [ ] 中间存储是什么？（state/file/cache）
- [ ] 有集成测试验证吗？

**反例 (本次):** ingest 不写 state，status 读不到 → 显示 0

---

## 4. 原子性 (Atomicity) ⚛️

**定义:** 操作要么完全成功，要么完全不执行（无中间状态）。

**必须考虑:**
- [ ] 部分失败时如何回滚？
- [ ] 有事务机制吗？
- [ ] 崩溃后数据一致性如何保障？

**测试模板:**
```typescript
it('should be atomic', async () => {
  try {
    await operation([item1, item2, INVALID_ITEM, item4])
  } catch (e) {
    // 失败后，已处理的项目应该回滚
    const state = await getState()
    expect(state).toEqual(initialState)
  }
})
```

---

## 5. 输入验证 (Input Validation) 🛡️

**定义:** 不信任任何外部输入，必须验证。

**必须检查:**
- [ ] 空值/undefined 处理
- [ ] 类型检查
- [ ] 范围检查（数组长度、数值范围）
- [ ] 特殊字符/注入攻击防护
- [ ] 文件路径遍历防护

**测试模板:**
```typescript
it('should handle invalid inputs gracefully', async () => {
  await expect(operation(null)).rejects.toThrow()
  await expect(operation('')).rejects.toThrow()
  await expect(operation({})).rejects.toThrow()
})
```

---

## 6. 优雅降级 (Graceful Degradation) 🪂

**定义:** 依赖失败时，系统仍能提供有限功能。

**必须考虑:**
- [ ] 外部 API 失败怎么办？
- [ ] 数据库连接断开怎么办？
- [ ] 有 fallback 机制吗？
- [ ] 用户会得到什么反馈？

**测试模板:**
```typescript
it('should degrade gracefully when dependency fails', async () => {
  mockDependency.toThrow('Network error')
  
  // 不应该崩溃
  const result = await operation()
  
  // 应该返回 fallback 值或部分结果
  expect(result).toEqual(fallbackValue)
})
```

---

## 7. 可观测性 (Observability) 👁️

**定义:** 系统状态必须可见、可追踪。

**必须提供:**
- [ ] 进度反馈（长时间操作）
- [ ] 状态查询接口（如 status 命令）
- [ ] 错误日志（失败原因）
- [ ] 关键指标（数量、时长）

**本次改进:**
- 添加 `kkb status` 显示 raw files 统计 ✅
- 添加 `kkb compile` 进度反馈 ✅

---

## 8. 并发安全 (Concurrency Safety) 🧵

**定义:** 多线程/多进程访问共享资源时必须安全。

**必须考虑:**
- [ ] 文件读写冲突
- [ ] 数据库事务隔离级别
- [ ] 内存共享状态加锁
- [ ] 竞态条件 (race condition)

**测试模板:**
```typescript
it('should handle concurrent writes', async () => {
  await Promise.all([
    operation(data1),
    operation(data2),
    operation(data3)
  ])
  
  // 验证最终状态一致性
  const state = await getState()
  expect(state).toBeValid()
})
```

---

## 强制性检查流程

在每个 Story 的 **Test Design Review** 阶段，必须回答：

```markdown
### Engineering Common Sense Checklist
- [ ] **幂等性**: 可重复运行吗？有测试吗？
- [ ] **跨模块契约**: ID/格式/算法一致吗？
- [ ] **数据流**: 生产者→消费者链路完整吗？
- [ ] **原子性**: 部分失败会回滚吗？
- [ ] **输入验证**: 所有输入都验证了吗？
- [ ] **优雅降级**: 依赖失败时怎么办？
- [ ] **可观测性**: 用户能看到进度/状态吗？
- [ ] **并发安全**: 多线程访问安全吗？

**如果有任何一项不满足，必须先补充测试/设计，再写实现代码。**
```

---

## 自动化防护

### Sentinel 巡检规则
```yaml
# .github/cnx-sentinel-config.yml
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
echo "🔍 检查工程常识..."

# 检查幂等性测试
if git diff --cached --name-only | grep -q "ingest\|import\|sync"; then
  if ! grep -r "idempotency\|重复运行\|多次" tests/ 2>/dev/null; then
    echo "❌ 缺少幂等性测试！"
    exit 1
  fi
fi

echo "✅ 基础检查通过"
```
