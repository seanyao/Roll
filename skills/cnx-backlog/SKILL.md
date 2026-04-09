---
hidden: true
name: cnx-backlog
description: Unified entry for planning and backlog management. Analyzes requirements, designs solutions, splits into INVEST-compliant user stories, and writes to BACKLOG.md. Use when user wants to plan, create stories, or manage project backlog.
---

# Backlog

规划新需求，并把结果写回 `BACKLOG.md`。

## When to Use

- 需求还没进入 backlog
- 需要先设计方案，再拆成 Stories
- 需要从已有 plan 写入 `BACKLOG.md`

## Use This Skill For

- 新需求规划
- 方案设计
- 拆分 Stories
- 创建 US / FIX 条目

## Quick Start

```bash
# 规划新需求 → 设计方案 → 拆分 Stories → 写入 BACKLOG
$cnx-backlog "用户系统设计方案"

# 从已有 Plan 拆分 Stories
$cnx-backlog --from-plan docs/features/auth-plan.md

# 直接创建 Story
$cnx-backlog --story "用户登录功能"
```

## Workspace Configuration

文档结构（两层分离）:

```
BACKLOG.md                        # US 索引页（状态 + 一句话 + 链接）
docs/features/
  <feature>.md                    # US 详情（AC / Files / Dependencies）
  <feature>-plan.md               # 设计文档（why / how）
```

**重要规则:**
1. Plan 文件写入 `docs/features/<feature>-plan.md`（**不再使用** `docs/plans/`）
2. US 详情写入对应的 `docs/features/<feature>.md`
3. BACKLOG.md 只写索引行（一行一个 US），**不写** AC / Files / Notes
4. **禁止**写入 `~/.kimi/` 或任何全局配置目录

**文件路径解析顺序:**
1. 确定 Feature 归属（由需求领域决定：compiler / ingest / qa / ...）
2. Feature 文件: `docs/features/<feature>.md`（不存在则新建）
3. Plan 文件: `docs/features/<feature>-plan.md`（不存在则新建）
4. BACKLOG.md 索引行放入对应 Epic > Feature 分组下

## Workflow

```
User: "帮我设计用户系统"
    │
    ▼
┌─────────────────────────────┐
│ 1. Understand & Analyze     │
│    - 需求理解                │
│    - 可行性分析              │
│    - 技术方案设计            │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ 2. Solution Design          │
│    - 架构设计                │
│    - 模块划分                │
│    - 依赖梳理                │
│    - 写入 docs/features/     │
│      <feature>-plan.md       │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ 3. Split into Stories       │
│    - INVEST 原则             │
│    - DDD 领域拆分            │
│    - 优先级排序              │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ 4. Write to BACKLOG.md      │
│    - 创建 US-XXX             │
│    - 定义 AC                 │
│    - 链接方案文档            │
└─────────────┬───────────────┘
              │
              ▼
    "确认后执行?"
    │
    ├── 是 ──→ $cnx-story-build US-XXX
    │
    └── 否 ──→ 等待用户确认
```

**创建新 Story 的操作顺序:**

```bash
# 1. 确定 Feature 归属（如 compiler / ingest / qa）
FEATURE="compiler"

# 2. 写入 Plan 文档（如有方案设计）
PLAN_FILE="docs/features/${FEATURE}-plan.md"

# 3. 在 docs/features/<feature>.md 中追加 US 段落（含完整 AC）
FEATURE_FILE="docs/features/${FEATURE}.md"

# 4. 在 BACKLOG.md 对应 Epic > Feature 分组下追加索引行
# | [US-XXX](docs/features/compiler.md#us-xxx) | 一句话描述 | 📋 Todo |
```

## Story Format

**BACKLOG.md 索引行（只写这一行）:**

```markdown
| [US-{DOMAIN}-{N}](docs/features/<feature>.md#us-{domain}-{n}) | {一句话描述} | 📋 Todo |
```

**docs/features/\<feature\>.md 中的 US 段落（完整详情）:**

```markdown
<a id="us-{domain}-{n}"></a>
## US-{DOMAIN}-{N} {Story Title} 📋

**Created**: {YYYY-MM-DD}
**Plan**: [{feature}-plan.md]({feature}-plan.md)  ← 如有方案文档

- As a {role}
- I want {action}
- So that {benefit}

**AC:**
- [ ] {measurable criteria 1}
- [ ] {measurable criteria 2}
- [ ] {measurable criteria 3}

**Files:**
- `{file1}`
- `{file2}`

**Dependencies:**
- 依赖: {前置 US-XXX}
- 被依赖: {后续 US-XXX}

**Data Flow (if applicable):**
- 生产者: {哪个模块写入数据}
- 消费者: {哪个模块读取数据}
- 集成测试: `tests/integration/{flow}.test.ts`
```

## Integration

### With story-build

```
$cnx-backlog "登录功能" → 创建 US-AUTH-001
User: "执行 US-AUTH-001"
    ↓
$cnx-story-build US-AUTH-001 → TCR → CI/CD → Deploy
```

### With fix-build

```
$cnx-bb-debug 发现问题 → 建议创建 FIX
$cnx-backlog --fix "修复登录 API 404" → 创建 FIX-AUTH-001
$cnx-fix-build FIX-AUTH-001 → 快速修复
```

## INVEST Principles

Each story must be:
- **Independent**: 可独立实现
- **Negotiable**: 范围可协商
- **Valuable**: 对用户有价值
- **Estimable**: 可估算工作量
- **Small**: 足够小，快速交付
- **Testable**: 可测试验证

## Engineering Common Sense Checklist

**这些不是可选的，是强制要求！**

```markdown
### 幂等性检查 (Idempotency) - 必须！
任何可以重复运行的操作必须验证：
- [ ] 重复执行是否产生副作用？
- [ ] 是否有去重机制？
- [ ] 测试：连续运行3次，结果是否一致？

**常见幂等场景：**
- ingest/导入类操作
- 配置更新
- 状态变更
- API 调用

**反例（本次教训）：**
ingest 重复运行 → 同一文件被添加7次
```

### 前置依赖检查
- [ ] 我依赖哪些已有功能提供数据？
- [ ] 那些功能确实会产生我需要的数据吗？
- [ ] 有集成测试验证这个数据流吗？
- [ ] 如果依赖未完成，我需要先创建那个 Story

### 数据流完整性 (Data Flow Integrity)
当功能涉及跨模块数据流时，必须定义：

```typescript
// 集成测试模板 - 必须存在
describe('Data Flow: {Producer} -> {Consumer}', () => {
  it('should produce data that consumer can read', async () => {
    // 1. 生产者写入
    await producer.write(data)
    
    // 2. 消费者读取
    const result = await consumer.read()
    
    // 3. 验证一致性
    expect(result).toEqual(expected)
  })
})
```

### 架构演进时的 Follow-up Stories
当引入新架构（如 State、Cache、EventBus）时，必须创建：

```markdown
## 📋 Architecture Evolution Tasks
- [ ] US-XXX: 更新 {ModuleA} 写入新架构
- [ ] US-XXX: 更新 {ModuleB} 读取新架构  
- [ ] TEST-XXX: 添加数据流集成测试
```
```

## Backlog Structure

```markdown
# Project Backlog

## Epic Name
### Feature Name
| Story | Description | Status |
|-------|-------------|--------|
| [US-XXX](docs/features/<feature>.md#us-xxx) | 一句话描述 | 📋 Todo |
| [US-YYY](docs/features/<feature>.md#us-yyy) | 一句话描述 | ✅ Done |
```

**注意**: BACKLOG.md 只写索引行，完整 AC / Files / Dependencies 在 `docs/features/<feature>.md` 中。
