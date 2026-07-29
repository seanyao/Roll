# Roll 工程常识清单

> **这些不是"最佳实践"——它们是基线要求。** 违反即为 Bug。

## 1. 幂等性 🔁

**定义：** 同一操作执行 N 次，结果与执行一次相同。

**必须测试：**
```typescript
it('should be idempotent', async () => {
  await operation(data)  // 第 1 次
  const result1 = await getState()

  await operation(data)  // 第 2 次
  const result2 = await getState()

  await operation(data)  // 第 3 次
  const result3 = await getState()

  expect(result1).toEqual(result2)
  expect(result2).toEqual(result3)
})
```

**常见场景：**
- [ ] 导入 / 摄取操作
- [ ] 配置更新
- [ ] 状态变更
- [ ] API 调用
- [ ] 文件写入

**本次反面案例：** 重复运行 ingest -> 文件被复制了 7 次

---

## 2. 跨模块契约一致性 🔗

**定义：** 在多个模块间共享的数据 / ID / 格式必须完全一致。

**必须检查：**
```typescript
// 检查清单
- [ ] ID 生成算法是否一致？
- [ ] 数据序列化格式是否一致？
- [ ] 路径处理是否一致？（例如 / vs -）
- [ ] 是否已抽取为共享函数 / 常量？
```

**测试模板：**
```typescript
it('should generate same ID across modules', () => {
  const scannerId = generateScannerId('articles/test.md')
  const inboxId = generateInboxId('articles/test.md')
  expect(scannerId).toEqual(inboxId)
})
```

**本次反面案例：** Scanner 用 `-` 替换 `/`，inbox 用原始路径 -> 去重失败

---

## 3. 数据流完整性 🌊

**定义：** 从生产者到消费者的完整管道必须端到端贯通。

**必须验证：**
```typescript
// 集成测试 —— 必须存在
describe('Data Flow: Producer -> Consumer', () => {
  it('should write data that consumer can read', async () => {
    await producer.write(testData)
    const result = await consumer.read()
    expect(result).toEqual(testData)
  })
})
```

**检查清单：**
- [ ] 谁写入数据？（生产者）
- [ ] 谁读取数据？（消费者）
- [ ] 中间存储是什么？（state / 文件 / 缓存）
- [ ] 是否有集成测试来验证？

**本次反面案例：** Ingest 没有写 state，status 读不到 -> 显示为 0

---

## 4. 原子性 ⚛️

**定义：** 一个操作要么完全成功，要么完全不执行（没有中间状态）。

**必须考虑：**
- [ ] 部分失败时如何回滚？
- [ ] 是否有事务机制？
- [ ] 崩溃后如何保证数据一致性？

**测试模板：**
```typescript
it('should be atomic', async () => {
  try {
    await operation([item1, item2, INVALID_ITEM, item4])
  } catch (e) {
    // 失败后，已处理的项应被回滚
    const state = await getState()
    expect(state).toEqual(initialState)
  }
})
```

---

## 5. 输入校验 🛡️

**定义：** 永远不要信任任何外部输入 —— 必须校验。

**必须检查：**
- [ ] Null / undefined 处理
- [ ] 类型检查
- [ ] 范围检查（数组长度、数值范围）
- [ ] 特殊字符 / 注入攻击防护
- [ ] 文件路径穿越防护

**测试模板：**
```typescript
it('should handle invalid inputs gracefully', async () => {
  await expect(operation(null)).rejects.toThrow()
  await expect(operation('')).rejects.toThrow()
  await expect(operation({})).rejects.toThrow()
})
```

---

## 6. 优雅降级 🪂

**定义：** 当依赖失败时，系统仍应提供有限的功能。

**必须考虑：**
- [ ] 外部 API 失败怎么办？
- [ ] 数据库连接断开怎么办？
- [ ] 是否有兜底机制？
- [ ] 用户能得到什么反馈？

**测试模板：**
```typescript
it('should degrade gracefully when dependency fails', async () => {
  mockDependency.toThrow('Network error')

  // 不应崩溃
  const result = await operation()

  // 应返回兜底值或部分结果
  expect(result).toEqual(fallbackValue)
})
```

---

## 7. 可观测性 👁️

**定义：** 系统状态必须可见、可追踪。

**必须提供：**
- [ ] 进度反馈（针对长时间运行的操作）
- [ ] 状态查询接口（例如 status 命令）
- [ ] 错误日志（失败原因）
- [ ] 关键指标（计数、耗时）

**本次改进：**
- 新增 `kkb status` 展示原始文件统计 ✅
- 新增 `kkb compile` 进度反馈 ✅

---

## 8. 并发安全 🧵

**定义：** 多线程 / 多进程对共享资源的访问必须安全。

**必须考虑：**
- [ ] 文件读写冲突
- [ ] 数据库事务隔离级别
- [ ] 内存中共享状态的加锁
- [ ] 竞态条件

**测试模板：**
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

## 强制检查流程

在每个 Story 的 **测试设计评审（Test Design Review）** 阶段，必须回答以下问题：

```markdown
### 工程常识检查清单
- [ ] **幂等性**：能否重复运行？是否有测试？
- [ ] **跨模块契约**：ID / 格式 / 算法是否一致？
- [ ] **数据流**：生产者 -> 消费者管道是否完整？
- [ ] **原子性**：部分失败时是否回滚？
- [ ] **输入校验**：所有输入是否都已校验？
- [ ] **优雅降级**：依赖失败时会发生什么？
- [ ] **可观测性**：用户能否看到进度 / 状态？
- [ ] **并发安全**：多线程访问是否安全？

**任何一项不满足，都必须在编写实现代码之前补齐测试 / 设计。**
```

---

## 9. Shell 脚本性能 🐚

**定义：** `$()` 命令替换会 fork 一个子 shell。在热路径（每个测试、每条目录项、每次消息查找都调用的函数）中，这是主要开销来源。

**经验法则：**
- 1 次子 shell fork ≈ Linux 上 2–3 ms
- 测试套件 setup 中 fork 1000 次 = 每次运行 +2–3 秒
- 1739 个测试 × 2.3 秒 = **约 67 分钟被浪费的 CI 时间**（本仓库实测）

**热路径中必须避免：**
```bash
# ❌ 子 shell fork —— 被调用上千次时很慢
upper="$(echo "$lang" | tr '[:lower:]' '[:upper:]')"
upper="$(_some_helper_function "$lang")"
safe="$(_sanitize_key "$key")"

# ✅ 内联等价写法 —— 零 fork
case "$lang" in
  en|EN) upper=EN ;;
  zh|ZH) upper=ZH ;;
  *)     upper="$(printf '%s' "$lang" | tr '[:lower:]' '[:upper:]')" ;;  # 罕见路径可接受
esac
safe="${key//[^A-Za-z0-9_]/_}"   # 参数扩展，无 fork
printf -v "$varname" '%s' "$val"  # 用 printf -v 代替子 shell 赋值
```

**兼容性陷阱 —— "修了两次"反模式：**
```
PR #211: 修 $(echo | tr) → ${lang^^}      ✅ 快，但仅限 bash 4+
PR #213: 修 bash 3.2 兼容 → $(_helper)    ❌ 重新引入了子 shell
PR #218: 两者都修 → 内联 case             ✅ 快且 bash 3.2 安全
```
为兼容性修复时，要验证修复没有重新引入原来的问题。
加一个时延断言或基准测试来守护回归。

**内联后的死代码：**
内联一个 helper 函数的逻辑时，删掉原函数并 grep 所有调用方。
留下一个零调用方的函数会误导后续贡献者通过 `$()` 调用它，从而重新引入 fork。

**必须检查：**
- [ ] 这个函数是否在循环、setup() 或逐条目录加载中被调用？
- [ ] 它是否在任何地方用了 `$()`？能否用 `case`、`${var//...}` 或 `printf -v` 替换？
- [ ] 内联之后，原 helper 是否已成为死代码？删掉它。
- [ ] 是否有时延测试或 CI 上限来捕获回归？（见 `ROLL_TEST_TIME_CAP`）

---

## 10. Shell 资源清理 🧹

**定义：** 每个设置的 `trap` 都必须显式重置。临时文件和锁文件绝不能比拥有它的进程存活更久。

**trap - EXIT 模式：**
```bash
# ❌ 悬挂的 trap —— 函数返回后 EXIT handler 仍留在调用方 shell 中
local tmp; tmp=$(mktemp)
trap "rm -f '$tmp'" EXIT
# ... 干活 ...
mv "$tmp" "$dst"
return 0   # EXIT trap 仍然 armed —— 之后任何 exit 都会对陈旧路径触发 rm

# ✅ 用完后总是重置
local tmp; tmp=$(mktemp)
trap "rm -f '$tmp'" EXIT
# ... 干活 ...
mv "$tmp" "$dst" 2>/dev/null || rm -f "$tmp"
trap - EXIT   # 返回前解除
return 0
```

**清理 helper 中的目录作用域：**
```bash
# ❌ 错误 —— 扫描的是环境变量默认值，而不是实际使用的路径
_cleanup_tmp() {
  local dir; dir=$(dirname "${MY_PATH:-$HOME/.default/path}")
  ...
}
_do_work() {
  local custom_path="$1"   # 可能与 MY_PATH 不同
  _cleanup_tmp             # 扫描了错误的目录！
}

# ✅ 显式传入实际目录
_cleanup_tmp() {
  local dir="${1:-$(dirname "${MY_PATH:-$HOME/.default/path}")}"
  ...
}
_do_work() {
  local custom_path="$1"
  _cleanup_tmp "$(dirname "$custom_path")"
}
```

**必须检查：**
- [ ] 每个 `trap "…" EXIT` 在函数返回前都有匹配的 `trap - EXIT`。
- [ ] 清理 helper 接受目标目录作为参数 —— 不依赖隐式的环境变量路径。
- [ ] trap 字符串中临时文件名被引号包住：`"rm -f '$tmp'"` 而不是 `"rm -f $tmp"`。

---

## 11. 测试可靠性 🧪

**定义：** 测试不得依赖在不同主机上可能静默失败的环境假设。

**PID 假设：**
```bash
# ❌ 假设 pid_max ≤ 99999 —— 在 pid_max 较大的容器中会静默失败
local stale_tmp="runs.jsonl.tmp.99999"

# ✅ 使用一个确定已死的进程
bash -c 'exit 0' &
local dead_pid=$!
wait "$dead_pid" 2>/dev/null || true
local stale_tmp="runs.jsonl.tmp.${dead_pid}"
```

**Heredoc 作用域：**
在 heredoc 之外定义的函数，在生成的脚本执行时无法在其内部使用。
调用它们会静默 no-op（若用 `|| true` 守护）或直接崩溃。
```bash
# ❌ _some_helper 在生成脚本的作用域中未定义
cat > script.sh <<'EOF'
_some_helper 2>/dev/null || true   # 静默 no-op —— 永远"成功"
EOF

# ✅ 要么内联逻辑，要么在 heredoc 内部定义该函数
```

**必须检查：**
- [ ] 测试是否使用了可能在主机上冲突的硬编码 PID、端口或路径？
- [ ] 测试是否调用了只在外层 shell 定义、而非 heredoc 内部定义的函数？
- [ ] "死进程"检查是否使用了真正已退出的进程，而不是猜测的 PID？

---

## 自动化防护

### CI 闸门规则
```yaml
# .github/roll-checks.yml —— 作为 CI 闸门在每个 PR 上强制执行
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

这些作为 CI 闸门在每个 PR 上运行。慢性问题 —— 死代码、文档过期、结构漂移 ——
由 `roll-.dream`（`roll dream run-once` 代码健康扫描）捕获，并把 `REFACTOR-XXX` 条目写回 backlog。

### Pre-Commit 钩子
```bash
#!/bin/bash
# .git/hooks/pre-commit
echo "🔍 Checking engineering common sense..."

# 检查幂等性测试
if git diff --cached --name-only | grep -q "ingest\|import\|sync"; then
  if ! grep -r "idempotency\|repeated run\|multiple times" tests/ 2>/dev/null; then
    echo "❌ Missing idempotency tests!"
    exit 1
  fi
fi

echo "✅ Basic checks passed"
```
