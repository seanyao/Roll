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
$cnx-backlog --from-plan docs/plans/auth-system.md

# 直接创建 Story
$cnx-backlog --story "用户登录功能"
```

## Workspace Configuration

Plan 文档存放位置（在 AGENTS.md 中配置）:

```yaml
plans:
  base_dir: docs/plans/          # 相对于项目根目录
  auto_create: true              # 目录不存在时自动创建
```

**重要规则:**
1. Plan 文件**必须**写入项目目录的 `docs/plans/`
2. 如果目录不存在，**自动创建**
3. **禁止**写入 `~/.kimi/` 或任何全局配置目录
4. 只有在没有项目上下文时，才使用临时位置

**文件路径解析顺序:**
1. 检查 `AGENTS.md` 中的 `plans.base_dir` 配置
2. 默认使用 `{project_root}/docs/plans/`
3. 确保目录存在（自动创建）
4. 生成 Plan 文件: `docs/plans/{kebab-case-topic}.md`

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
│    - 写入 docs/plans/        │
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

**Plan 文件保存规则:**

```bash
# 1. 确定项目根目录（包含 BACKLOG.md 或 AGENTS.md 的目录）
PROJECT_ROOT=$(find_project_root)

# 2. 检查/创建 docs/plans/ 目录
PLANS_DIR="$PROJECT_ROOT/docs/plans"
mkdir -p "$PLANS_DIR"  # 自动创建，如果不存在

# 3. 生成 Plan 文件名
PLAN_FILE="$PLANS_DIR/user-system-design.md"

# 4. 写入 Plan 文档
echo "# User System Design" > "$PLAN_FILE"

# 5. 在 BACKLOG.md 中引用
# See: docs/plans/user-system-design.md
```

## Story Format

```markdown
### US-{DOMAIN}-{N} {Story Title} 📋
**Created**: {YYYY-MM-DD}

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

**Notes:**
{design notes}
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

## 🎯 Active Stories
| ID | Title | Status | Priority |
|----|-------|--------|----------|
| US-XXX | ... | 📋 Todo | P0 |

## ✅ Completed
...

## 🐛 Bug Fixes
...
```
